import StateEngine from './StateEngine'

export default class State {

  constructor(initialState) {
    this._engine = new StateEngine(this)

    this._data = Object.assign({}, initialState)
    // this is used to record changes
    // in most cases this is just the old value
    // for 'document' it is the DocumentChange
    this._diffs = {}
    this._dirty = {}

    window.appState = this
  }

  get(key) {
    return this._data[key]
  }

  getDiff(key) {
    return this._diffs[key]
  }

  set(key, value) {
    this._set(key, value)
    this._propagate()
  }

  /*
    For variables that are aggregated by multiple
    reducers.
  */
  extend(key, hash) {
    this._extend(key, hash)
    this._propagate()
  }

  /*
    Inform about a performed update.

    Some values in the State are 'managed' somewhere else.
    For example, a document instance is managed by
    EditorSession.
    Whenever such a resource has been changed,
    State must be informed providing information about
    what has been changed.
  */
  setDiff(key, diff) {
    this._setDiff(key, diff)
    this._propagate()
  }

  isDirty(key) {
    return Boolean(this._dirty[key])
  }

  /*
    Observers are registered as Reducers for the pseudo
    variable '@render'
  */
  observe(inputs, handler, owner, opts = {}) {
    let output = '@render'
    if (opts.stage) {
      output = `@${opts.stage}`
    }
    this._engine.addReducer(output, inputs, handler, owner)
  }

  reduce(outputs, inputs, handler, owner) {
    // TODO: do we want to run the reducer initially?
    let reducer = this._engine.addReducer(outputs, inputs, handler, owner)
    reducer._run(this)
  }

  disconnect(observer) {
    this._engine.disconnect(observer)
  }

  /*
    Sets value without triggering a reflow.
  */
  _set(key, value) {
    if (!this.isDirty(key)) {
      let oldValue = this._data[key]
      this._diffs[key] = oldValue
      this._dirty[key] = true
    }
    this._data[key] = value
  }

  _extend(key, hash) {
    if (!this.isDirty(key)) {
      let oldValue = this._data[key]
      this._diffs[key] = oldValue
      this._data[key] = {}
      this._dirty[key] = true
    }
    Object.assign(this._data[key], hash)
  }

  /*
    Updates a value without triggering a reflow.
  */
  _setDiff(key, diff) {
    this._diffs[key] = diff
    this._dirty[key] = true
  }

  _setDirty(key) {
    this._dirty[key] = true
  }

  _propagate() {
    if (!this._isPropagating) {
      try {
        this._isPropagating = true
        this._engine.propagate()
        this._reset()
      } finally {
        this._isPropagating = false
      }
    }
  }

  _reset() {
    this._dirty = {}
    this._diffs = {}
  }

}