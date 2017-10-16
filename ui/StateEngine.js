import { isArray, isFunction, forEach, map, DependencyGraph } from '../util'

const AT = '@'.charAt(0)
// Note: some values in the state deviate from simple values
// such as 'document', which also has different way to register
// observers by path.
const RESOURCES = {}

export default class StateEngine {

  constructor(state) {
    this.state = state
    this._deps = new DependencyGraph()
    this._slots = {}
    this._schedule = null
    this._registry = new Map()

    // HACK: ATM hardcoded
    RESOURCES['document'] = {
      type: 'ref',
      SlotClass: DocumentChangeSlot
    }
  }

  propagate() {
    // TODO: we should make sure that
    // state is updated only in direction of
    // flow, i.e., not invalidating a flow while
    // in a flow.
    // Earlier we have prevented that,
    // instead we could just postpone the change and
    // trigger a reflow after the current flow
    if (!this._schedule) {
      this._computeSchedule()
    }
    const state = this.state
    // TODO: for now we always visit all slots
    this._schedule.forEach((slot) => {
      if (this._shouldTrigger(slot)) {
        slot.notifyObservers(state)
      }
    })
  }

  addReducer(outputs, inputs, handler, owner) {
    // Preparing arguments:
    // 1. turn outputs and in puts into an array
    // 2. allow for specified inputs such as `{ resource: 'document', path: [...] }`
    // 3. sort inputs and output for normalization
    if (!isArray(outputs)) {
      outputs = [outputs]
    } else {
      outputs = outputs.slice()
    }
    if (!isArray(inputs)) {
      inputs = [inputs]
    } else {
      inputs = inputs.slice()
    }
    if (!isFunction(handler)) {
      throw new Error('Invalid argument: expected "handler" function')
    }
    let opts = _extractResourceOptions(inputs)
    // create an entry for registration
    let entry = new Entry(inputs, outputs, opts, owner, handler)

    const sortedInputs = inputs.slice()
    sortedInputs.sort()

    const key = this._getSlotKey(sortedInputs)
    // create or reuse slot
    let slot = this._slots[key]
    if (!slot) {
      let descr = RESOURCES[inputs[0]]
      if (inputs.length === 1 && descr) {
        slot = new descr.SlotClass(key, sortedInputs)
      } else {
        slot = new ValueSlot(key, sortedInputs)
      }
      this._slots[key] = slot
      outputs.forEach((name) => {
        this._deps.addDependency(name, inputs)
      })
      this._invalidate()
    }

    // store the registration info on the owner
    // and register entry with slot
    let entries = this._getRegistration(owner)
    entries.push(entry)
    slot.addObserver(entry)

    // freezing the entry, that it does not get corrupted inadvertently
    Object.freeze(entry)

    return entry
  }

  disconnect(owner) {
    let entries = this._getRegistration(owner)
    entries.forEach((entry) => {
      let slot = this._slots[entry.slot]
      slot.removeObserver(entry)
    })
  }

  _invalidate() {
    this._schedule = null
  }

  _computeSchedule() {
    const deps = this._deps
    let slots = map(this._slots, (slot) => {
      slot.rank = deps.getMaximumRank(slot.inputs)
      return slot
    })
    slots.sort((a, b) => {
      return a.rank - b.rank
    })
    this._schedule = slots
    console.log('SCHEDULE', slots)
  }

  _shouldTrigger(slot) {
    const state = this.state
    const inputs = slot.inputs
    let count = 0
    for (let i = 0; i < inputs.length; i++) {
      let name = inputs[i]
      // do not consider pseudo vars here as they are just
      // used for determining the order
      if (name.charAt(0) !== AT) {
        if (state.isDirty(name)) {
          return true
        }
        count++
      }
    }
    // HACK: handling of pseudo-vars is a bit hacky
    if (count === 0) {
      return true
    }

    return false
  }

  _getSlotKey(inputs) {
    return `(${inputs.join(',')})`
  }

  _getRegistration(owner) {
    let entries = this._registry.get(owner)
    if (!entries) {
      entries = []
      this._registry.set(owner, entries)
    }
    return entries
  }
}

function _extractResourceOptions(inputs) {
  let result = {}
  for (let i = 0; i < inputs.length; i++) {
    let input = inputs[i]
    if (input.resource) {
      let name = input.resource
      let opts = Object.assign({}, input)
      delete opts.resource
      result[name] = opts
      inputs[i] = name
    }
  }
  return result
}

// registers observers by path
class DocumentChangeSlot {

  constructor(key) {
    this.key = key
    this.inputs = ['document']
    this.byPath = {}
  }

  addObserver(entry) {
    let opts = entry.opts.document
    if (opts && opts.path) {
      entry.path = opts.path
    } else {
      entry.path = '__default__'
    }
    let path = entry.path
    let entries = this.byPath[path]
    if (!entries) {
      entries = this.byPath[path] = []
    }
    entries.push(entry)
  }

  removeObserver(entry) {
    let path = entry.path
    let entries = this.byPath[path]
    let idx = entries.indexOf(entry)
    if (idx !== -1) {
      entries.splice(idx, 1)
    }
  }

  notifyObservers(state) {
    const docChange = state.getChange('document')
    forEach(docChange.updated, (_, key) => {
      this._notifyObserversWithKey(state, key)
    })
    this._notifyObserversWithKey(state, '__default__')
  }

  _notifyObserversWithKey(state, key) {
    let entries = this.byPath[key]
    if (entries) {
      entries.forEach((entry) => {
        entry.exec(state)
      })
    }
  }
}

class ValueSlot {

  constructor(key, inputs) {
    this.key = key
    this.inputs = inputs
    this.observers = []
  }

  addObserver(entry) {
    this.observers.push(entry)
  }

  removeObserver(entry) {
    let idx = this.observers.indexOf(entry)
    if (idx !== -1) {
      this.observers.splice(idx, 1)
    }
  }

  notifyObservers(state) {
    this.observers.forEach((entry) => {
      entry.exec(state)
    })
  }
}

class Entry {

  constructor(inputs, outputs, opts, owner, handler) {
    this.inputs = inputs
    this.outputs = outputs
    this.opts = opts
    this.owner = owner
    this.handler = handler
  }

  exec(state) {
    let args = this.inputs.map((name) => {
      const descr = RESOURCES[name]
      if (descr && descr.type === 'ref') {
        return state.getChange(name)
      } else {
        return state.get(name)
      }
    })
    this.handler.call(this.owner, ...args)
  }
}
