import { isArray, forEach, map, DependencyGraph } from '../util'

const AT = '@'.charAt(0)

export default class StateEngine {

  constructor(state) {
    this.state = state
    this._deps = new DependencyGraph()
    this._slots = {}
    this._schedule = null
    this._registry = new Map()
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
    let opts = _extractResourceOptions(inputs)
    inputs.sort()
    outputs.sort()
    // create an entry for registration
    const key = this._getSlotKey(inputs, outputs)
    let entry = {
      slot: key,
      inputs,
      outputs,
      opts,
      owner,
      handler
    }
    // create or reuse slot
    let slot = this._slots[key]
    if (!slot) {
      if (inputs.length === 1 && inputs[0] === 'document') {
        slot = new DocumentChangeSlot(key)
      } else {
        slot = new ValueSlot(key, inputs)
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

    // HACK: we must run a reducer initially (but not observers)
    // this should not trigger any reflows or such
    entry._run = (state) => {
      let _changes = {}
      entry.inputs.forEach((name) => {
        _changes[name] = state.getDiff(name)
      })
      entry.handler.call(entry.owner, _changes)
    }

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

  _getSlotKey(inputs, outputs) {
    return `(${inputs.join(',')})->(${outputs.join(',')})`
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
    const docChange = state.getDiff('document')
    forEach(docChange.updated, (_, key) => {
      let entries = this.byPath[key]
      if (entries) {
        entries.forEach((entry) => {
          entry.handler.call(entry.owner, docChange)
        })
      }
    })
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
    let _changes = {}
    this.inputs.forEach((name) => {
      _changes[name] = state.getDiff(name)
    })
    this.observers.forEach((entry) => {
      entry.handler.call(entry.owner, _changes)
    })
  }

}
