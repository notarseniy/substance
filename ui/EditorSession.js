import {
  forEach, isPlainObject, isFunction,
  EventEmitter, uuid
} from '../util'
import { Selection, SelectionInfo, ChangeHistory,
  Transaction, operationHelpers } from '../model'
import State from './State'

// LEGACY: earlier we used stages for state events
const LEGACY_STAGES = ['update', 'pre-render', 'render', 'post-render', 'position', 'finalize']

export default class EditorSession extends EventEmitter {

  constructor(doc, options) {
    super()
    options = options || {}

    this.__id__ = uuid()
    this.document = doc

    const configurator = options.configurator
    if (!configurator) {
      throw new Error('No configurator provided.')
    }
    this.configurator = configurator

    this._transaction = new Transaction(doc)
    // HACK: we want `tx.setSelection()` to add surfaceId to the selection
    // automatically, so that tx is easier to use.
    _patchTxSetSelection(this._transaction, this)

    // EXPERIMENTAL: Working on AppState API
    this.state = new State({
      document: doc,
      selection: Selection.nullSelection,
      commandStates: [],
      lang:  options.lang || this.configurator.getDefaultLanguage(),
      dir: options.dir || 'ltr'
    })
    // reducers for pseudo-variables bringing stages into the correct order
    LEGACY_STAGES.forEach((stage, i) => {
      const output = `@${stage}`
      const input = `@${LEGACY_STAGES[i-1]}`
      let f = ()=>{
        this.state._setDirty(output)
      }
      if (i === 0) {
        this.state.reduce(output, [], f, this)
      } else {
        this.state.reduce(output, [input], f, this)
      }
    })

    // TODO: history should be part of the app-state, too
    this._history = new ChangeHistory()

    // used for change accumulation (in a collab environment)
    this._currentChange = null

    this._lastChange = null

    // Managers
    // --------
    const CommandManager = configurator.getCommandManagerClass()
    const DragManager = configurator.getDragManagerClass()
    const FileManager = configurator.getFileManagerClass()
    const GlobalEventHandler = configurator.getGlobalEventHandlerClass()
    const KeyboardManager = configurator.getKeyboardManagerClass()
    const MacroManager = configurator.getMacroManagerClass()
    const MarkersManager = configurator.getMarkersManagerClass()
    const SurfaceManager = configurator.getSurfaceManagerClass()


    // surface manager takes care of surfaces, keeps track of the currently focused surface
    // and makes sure the DOM selection is rendered properly at the end of a flow
    this.surfaceManager = new SurfaceManager(this)

    // this context is provided to commands, tools, etc.
    this._context = {
      editorSession: this,
      state: this.state,
      //legacy
      surfaceManager: this.surfaceManager,
    }
    // to expose custom context just provide optios.context
    if (options.context) {
      Object.assign(this._context, options.context)
    }

    this._selectionInfo = new SelectionInfo(this.state, this._context)
    // TODO: we should remove this after having fixed all deprecations
    this._selectionState = new LegacySelectionState(this.state)

    let commands = configurator.getCommands()
    let dropHandlers = configurator.getDropHandlers()
    let macros = configurator.getMacros()
    let converterRegistry = configurator.getConverterRegistry()
    let editingBehavior = configurator.getEditingBehavior()

    this.fileManager = options.fileManager || new FileManager(this, configurator.getFileAdapters(), this._context)

    // Handling of saving
    this._hasUnsavedChanges = false
    this._isSaving = false

    if (options.saveHandler) {
      this.saveHandler = options.saveHandler
    } else {
      this.saveHandler = configurator.getSaveHandler()
    }

    // Custom Managers (registered via configurator e.g. FindAndReplaceManager)
    this._managers = {}
    forEach(configurator.getManagers(), (ManagerClass, name) => {
      this._managers[name] = new ManagerClass(this._context)
    })

    // The command manager keeps the commandStates up-to-date
    // EXPERIMENTAL: trying to reuse CommandManager
    this.commandManager = options.commandManager || new CommandManager(this._context, commands)

    // The drag manager dispatches drag requests to registered drag handlers
    // TODO: after consolidating the API of this class, we probably need a less diverse context
    this.dragManager = new DragManager(dropHandlers, Object.assign({}, this._context, {
      commandManager: this.commandManager
    }))
    // The macro manager dispatches to macro detectors at the end of the flow
    this.macroManager = new MacroManager(this._context, macros)
    this.globalEventHandler = new GlobalEventHandler(this, this.surfaceManager)
    this.markersManager = new MarkersManager(this)
    this.keyboardManager = new KeyboardManager(this, configurator.getKeyboardShortcuts(), {
      context: this._context
    })

    // TODO: see how we want to expose these
    this.converterRegistry = converterRegistry
    this.editingBehavior = editingBehavior
  }

  dispose() {
    this._transaction.dispose()
    this.surfaceManager.dispose()
    this.fileManager.dispose()
    this.commandManager.dispose()
    this.dragManager.dispose()
    this.macroManager.dispose()
    this.globalEventHandler.dispose()
    this.markersManager.dispose()
  }

  hasChanged(resource) {
    console.warn('DEPRECATED: use state API instead.')
    return this.state.isDirty(resource)
  }

  hasDocumentChanged() {
    return this.hasChanged('document')
  }

  hasSelectionChanged() {
    return this.hasChanged('selection')
  }

  hasCommandStatesChanged() {
    return this.hasChanged('commandStates')
  }

  hasLanguageChanged() {
    return this.hasChanged('lang')
  }

  hasTextDirectionChanged() {
    return this.hasChanged('dir')
  }

  /*
    @deprecated
  */
  get(resourceName) {
    console.warn("DEPRECATED: use State API instead.")
    switch(resourceName) {
      case 'document':
        return this.getDocument()
      case 'selection':
        return this.getSelection()
      case 'commandStates':
        return this.getCommandStates()
      case 'change':
        return this.getChange()
      default:
        throw new Error('Unknown resource: ' + resourceName)
    }
  }

  getState() {
    return this.state
  }

  getConfigurator() {
    return this.configurator
  }

  getContext() {
    return this._context
  }

  getDocument() {
    return this.document
  }

  getManager(name) {
    return this._managers[name]
  }

  getSelection() {
    return this.state.get('selection')
  }

  getSelectionState() {
    return this._selectionState
  }

  /*
    @deprecated
  */
  getCommandStates() {
    console.warn("DEPRECATED: use state.get('commandStates') instead.")
    return this.state.get('commandStates')
  }

  /*
    @deprecated
  */
  getChange() {
    console.warn("DEPRECATED: use editorSession.getLastChange() instead")
    return this.getLastChange()
  }

  /*
    @deprecated
  */
  getChangeInfo() {
    console.warn("DEPRECATED: use editorSession.getLastChangeInfo() instead")
    return this.getLastChangeInfo()
  }

  // TODO: do we really need this?
  getLastChange() {
    if (this._lastChange) {
      return this._lastChange
    }
  }

  // TODO: do we really need this?
  getLastChangeInfo() {
    if (this._lastChange) {
      return this._lastChange.info
    }
  }

  getFocusedSurface() {
    return this.surfaceManager.getFocusedSurface()
  }

  getSurface(surfaceId) {
    return this.surfaceManager.getSurface(surfaceId)
  }

  getLanguage() {
    console.warn("DEPRECATED: use state.get('lang') instead.")
    return this.state.get('lang')
  }

  getTextDirection() {
    console.warn("DEPRECATED: use state.get('dir') instead.")
    return this.state.get('dir')
  }

  canUndo() {
    return this._history.canUndo()
  }

  canRedo() {
    return this._history.canRedo()
  }

  executeCommand(...args) {
    this.commandManager.executeCommand(...args)
  }

  /*
    Set EditorComponent associated with this editorSession
  */
  attachEditor(editor) {
    this.editor = editor
  }

  detachEditor() {
    this.editor = undefined
  }

  getEditor() {
    return this.editor
  }

  setSelection(sel, skipFlow) {
    if (skipFlow) {
      debugger // eslint-disable-line
      console.error('FIXME: lets try to get rid of this "skipFlow" HACK.')
    }
    // console.log('EditorSession.setSelection()', sel)
    if (sel && isPlainObject(sel)) {
      sel = this.getDocument().createSelection(sel)
    }
    if (sel && !sel.isNull()) {
      if (!sel.surfaceId) {
        let fs = this.getFocusedSurface()
        if (fs) {
          sel.surfaceId = fs.id
        }
      }
    }

    _addSurfaceId(sel, this)
    _addContainerId(sel, this)

    this._setSelection(sel)

    return sel
  }

  selectNode(nodeId) {
    let surface = this.getFocusedSurface()
    this.setSelection({
      type: 'node',
      nodeId: nodeId,
      containerId: surface.getContainerId(),
      surfaceId: surface.id
    })
  }

  setCommandStates(commandStates) {
    this.state.set('commandStates', commandStates)
  }

  setLanguage(lang) {
    this.state.set('lang', lang)
  }

  setTextDirection(dir) {
    this.state.set('dir', dir)
  }

  createSelection() {
    const doc = this.getDocument()
    return doc.createSelection.apply(doc, arguments)
  }

  getCollaborators() {
    return null
  }

  /*
    Set saveHandler via API

    E.g. if saveHandler not available at construction
  */
  setSaveHandler(saveHandler) {
    this.saveHandler = saveHandler
  }

  /**
    Start a transaction to manipulate the document

    @param {function} transformation a function(tx) that performs actions on the transaction document tx

    @example

    ```js
    doc.transaction(function(tx, args) {
      tx.update(...)
      ...
      tx.setSelection(newSelection)
    })
    ```
  */
  transaction(transformation, info) {
    const t = this._transaction
    info = info || {}
    t._sync()
    let change = t._recordChange(transformation, this.getSelection(), info)
    if (change) {
      this._commit(change, info)
    } else {
      // if no changes, at least update the selection
      this._setSelection(this._transaction.getSelection())
    }
    return change
  }

  undo() {
    this._undoRedo('undo')
  }

  redo() {
    this._undoRedo('redo')
  }

  /* eslint-disable no-invalid-this*/

  on(...args) {
    let stage = args[0]
    let stageIdx = LEGACY_STAGES.indexOf(stage)
    if (stageIdx >= 0) {
      console.warn('DEPRECATED: use AppState API instead')
      args = args.slice(1)
      let {inputs, handler, owner} = this._legacyArgs(...args)
      if (inputs.length === 0) {
        // with the new State API it is required to describe dependencies
        // to guaruantee calling in correct order
        console.error('No dependencies specified. This might not work as expected.')
      }
      if (stageIdx > 0) {
        inputs.push(`@${LEGACY_STAGES[stageIdx-1]}`)
      }
      this.state.observe(inputs, handler, owner, {
        stage
      })
    } else {
      EventEmitter.prototype.on.apply(this, args)
    }
  }

  off(...args) {
    if (args.length === 1) {
      let observer = args[0]
      super.off(...args)

      this.state.disconnect(observer)
    } else {
      super.off(...args)
    }
  }

  /**
    Registers a hook for the `update` phase.

    During `update` data should be derived necessary for rendering.

    This is mainly used by extensions of the EditorSession to
    derive extra state information.

    @param {string} [resource] the name of the resource
    @param {Function} handler the function handler
    @param {Object} context owner of the handler
    @param {Object} [options] options for the resource handler

  */
  onUpdate(...args) {
    console.warn('DEPRECATED: use AppState API instead')
    let {inputs, handler, owner} = this._legacyArgs(...args)
    if (inputs.length === 0) {
      // with the new State API it is required to describe dependencies
      // to guaruantee calling in correct order
      console.error('No dependencies specified. This might not work as expected.')
    }
    this.state.observe(inputs, handler, owner, {
      stage: 'update',
    })
  }

  onPreRender(...args) {
    console.warn('DEPRECATED: use AppState API instead')
    let {inputs, handler, owner} = this._legacyArgs(...args)
    if (inputs.length === 0) {
      // with the new State API it is required to describe dependencies
      // to guaruantee calling in correct order
      console.error('No dependencies specified. This might not work as expected.')
    }
    inputs.push('@update')
    this.state.observe(inputs, handler, owner, {
      stage: 'pre-render',
    })
  }

  /**
    Registers a hook for the 'render' phase.

    During `render`, components should be rerendered.

    @param {string} [resource] the name of the resource
    @param {Function} handler the function handler
    @param {Object} context owner of the handler
    @param {Object} [options] options for the resource handler

    @example

    This typically used by components that render node content.

    ```js
    class ImageComponent extends Component {
      didMount() {
        this.context.editorSession.onRender('document', this.rerender, this, {
          path: [this.props.node.id, 'src']
        })
      }
      dispose() {
        this.context.editorSession.off(this)
      }
      render($$) {
        ...
      }
    }
    ```
  */
  onRender(...args) {
    console.warn('DEPRECATED: use AppState API instead')
    let {inputs, handler, owner} = this._legacyArgs(...args)
    if (inputs.length === 0) {
      // with the new State API it is required to describe dependencies
      // to guaruantee calling in correct order
      console.error('No dependencies specified. This might not work as expected.')
    }
    inputs.push('@pre-render')
    this.state.observe(inputs, handler, owner, {
      stage: 'render',
    })
  }


  /**
    Registers a hook for the 'post-render' phase.

    ATM, this phase is used internally only, for recovering the DOM selection
    which typically gets destroyed due to rerendering

    @internal

    @param {string} [resource] the name of the resource
    @param {Function} handler the function handler
    @param {Object} context owner of the handler
    @param {Object} [options] options for the resource handler
  */
  onPostRender(...args) {
    console.warn('DEPRECATED: use AppState API instead')
    let {inputs, handler, owner} = this._legacyArgs(...args)
    if (inputs.length === 0) {
      // with the new State API it is required to describe dependencies
      // to guaruantee calling in correct order
      console.error('No dependencies specified. This might not work as expected.')
    }
    inputs.push('@render')
    this.state.observe(inputs, handler, owner, {
      stage: 'post-render',
    })
  }

  /**
    Registers a hook for the 'position' phase.

    During `position`, components such as Overlays, for instance, should be positioned.
    At this stage, it is guaranteed that all content is rendered, and the DOM selection
    is set.

    @param {string} [resource] the name of the resource
    @param {Function} handler the function handler
    @param {Object} context owner of the handler
    @param {Object} [options] options for the resource handler

  */
  onPosition(...args) {
    console.warn('DEPRECATED: use AppState API instead')
    let {inputs, handler, owner} = this._legacyArgs(...args)
    if (inputs.length === 0) {
      // with the new State API it is required to describe dependencies
      // to guaruantee calling in correct order
      console.error('No dependencies specified. This might not work as expected.')
    }
    inputs.push('@post-render')
    this.state.observe(inputs, handler, owner, {
      stage: 'position',
    })
  }

  onFinalize(...args) {
    console.warn('DEPRECATED: use AppState API instead')
    let {inputs, handler, owner} = this._legacyArgs(...args)
    if (inputs.length === 0) {
      // with the new State API it is required to describe dependencies
      // to guaruantee calling in correct order
      console.error('No dependencies specified. This might not work as expected.')
    }
    inputs.push('@position')
    this.state.observe(inputs, handler, owner, {
      stage: 'finalize',
    })
  }

  _setSelection(sel) {
    if (!sel) {
      sel = Selection.nullSelection
    } else {
      sel.attach(this.document)
    }
    this.state._set('selection', sel)
    // TODO: do we really need this return flag?
    return true
  }

  _undoRedo(which) {
    const doc = this.getDocument()
    var from, to
    if (which === 'redo') {
      from = this._history.undoneChanges
      to = this._history.doneChanges
    } else {
      from = this._history.doneChanges
      to = this._history.undoneChanges
    }
    var change = from.pop()
    if (change) {
      this._applyChange(change, {})
      this._transaction.__applyChange__(change)
      // move change to the opposite change list (undo <-> redo)
      to.push(change.invert())
      // use selection from change
      let sel = change.after.selection
      if (sel) sel.attach(doc)
      this._setSelection(sel)

      this.state.propagate()
    } else {
      console.warn('No change can be %s.', (which === 'undo'? 'undone':'redone'))
    }
  }

  _transformLocalChangeHistory(externalChange) {
    // Transform the change history
    // Note: using a clone as the transform is done inplace
    // which is ok for the changes in the undo history, but not
    // for the external change
    var clone = {
      ops: externalChange.ops.map(function(op) { return op.clone(); })
    }
    operationHelpers.transformDocumentChange(clone, this._history.doneChanges)
    operationHelpers.transformDocumentChange(clone, this._history.undoneChanges)
  }

  _transformSelection(change) {
    var oldSelection = this.getSelection()
    var newSelection = operationHelpers.transformSelection(oldSelection, change)
    // console.log('Transformed selection', change, oldSelection.toString(), newSelection.toString())
    return newSelection
  }

  _commit(change, info) {
    this._commitChange(change, info)
    // TODO: this should be done using app-state
    this._hasUnsavedChanges = true

    this.state._propagate()
  }

  _commitChange(change, info) {
    change.timestamp = Date.now()
    this._applyChange(change, info)
    if (info['history'] !== false && !info['hidden']) {
      this._history.push(change.invert())
    }
    let newSelection = change.after.selection || Selection.nullSelection
    // HACK injecting the surfaceId here...
    // TODO: we should find out where the best place is to do this
    if (!newSelection.isNull() && !newSelection.surfaceId) {
      newSelection.surfaceId = change.after.surfaceId
    }
    this._setSelection(newSelection)
  }

  _applyChange(change, info) {
    if (!change) {
      console.error('FIXME: change is null.')
      return
    }
    const doc = this.getDocument()
    doc._apply(change)
    change.info = info
    // legacy: there are still some implementations
    // relying on the internal event mechanism
    // TODO: discuss how long we want to support this
    // or if it is viable to switch to AppState API
    // in general
    doc._notifyChangeListeners(change, info)
    // EXPERIMENTAL: new app-state API
    // The document has been updated.
    // Now the app-state needs to be informed
    // and a reflow to be triggered
    this.state._setChange('document', change)
    this._lastChange = change
  }

  /*
    Are there unsaved changes?
  */
  hasUnsavedChanges() {
    return this._hasUnsavedChanges
  }

  /*
    Save session / document
  */
  save() {
    var saveHandler = this.saveHandler

    if (this._hasUnsavedChanges && !this._isSaving) {
      this._isSaving = true
      // Pass saving logic to the user defined callback if available
      if (saveHandler) {
        let saveParams = {
          editorSession: this,
          fileManager: this.fileManager
        }
        return saveHandler.saveDocument(saveParams)
        .then(() => {
          this._hasUnsavedChanges = false
          // We update the selection, just so a selection update flow is
          // triggered (which will update the save tool)
          // TODO: model this kind of update more explicitly. It could be an 'update' to the
          // document resource (hasChanges was modified)
          this.setSelection(this.getSelection())
        })
        .catch((err) => {
          console.error('Error during save', err)
        }).then(() => { // finally
          this._isSaving = false
        })
      } else {
        console.error('Document saving is not handled at the moment. Make sure saveHandler instance provided to editorSession')
        return Promise.reject()
      }
    }
  }

  startFlow() {
    console.warn('DEPRECATED: please use AppState API instead')
  }

  performFlow() {
    console.warn('DEPRECATED: please use AppState API instead')
  }

  postpone() {
    console.warn('DEPRECATED: please use AppState API instead')
  }

  _setDirty(resource) {
    console.warn('DEPRECATED: please use AppState API instead')
    this.state._setDirty(resource)
  }

  _resetFlow() {
    console.warn('DEPRECATED: please use AppState API instead')
  }

  /*
    When set to true puts the editor into a blurred state, which means that
    surface selections are not recovered until blurred state is set to false
    again.

    TODO: There are cases where a flow needs to be triggered manually after setting
    the blurred states in order to rerender the tools (see FindAndReplaceTool._onFocus)
  */

  setBlurred(blurred) {
    this.state.set('blurred', blurred)
  }

  isBlurred() {
    return this.state.get('blurred')
  }

  _legacyArgs(...args) {
    // pattern 1: ['stage', 'resource',  handler, owner, opts]
    let stage, resource, handler, owner, opts
    if (isFunction(args[2])) {
      ([stage, resource,handler,owner,opts] = args)
    }
    // pattern 2: ['resource',  handler, owner, opts]
    if (isFunction(args[1])) {
      ([resource,handler,owner,opts] = args)
    }
    // pattern 3: [handler, owner, opts]
    if (isFunction(args[0])) {
      ([handler,owner,opts] = args)
    }
    if (!isFunction(handler)) {
      throw new Error('Invalid arguments')
    }
    opts = opts || {}
    let inputs = []
    if (resource === 'document' && opts.path) {
      inputs = [{
        resource: 'document',
        path: opts.path
      }]
    } else if (resource) {
      inputs = [resource]
    }
    // wrap the handler so that we still support the old API,
    // i.e. calling the handler with the original arguments
    let _handler = handler
    if (inputs.length === 0) {
      _handler = () => {
        handler.call(owner, this)
      }
    } else if (inputs.length === 1) {
      const _state = this.state
      if (resource === 'document') {
        _handler = () => {
          let change = _state.getChange('document')
          handler.call(owner, change, change.info)
        }
      } else {
        _handler = () => {
          let val = _state.get(resource)
          handler.call(owner, val)
        }
      }
    }
    return {stage, inputs, handler: _handler, owner, opts}
  }


}

function _patchTxSetSelection(tx, editorSession) {
  tx.setSelection = function(sel) {
    sel = Transaction.prototype.setSelection.call(tx, sel)
    _addSurfaceId(sel, editorSession)
    _addContainerId(sel, editorSession)
    return sel
  }
}

/*
  Complements selection data according to the given Editor state.
  I.e., if no
*/
function _addSurfaceId(sel, editorSession) {
  if (sel && !sel.isNull() && !sel.surfaceId) {
    // TODO: We could check if the selection is valid within the given surface
    let surface = editorSession.getFocusedSurface()
    if (surface) {
      sel.surfaceId = surface.id
    } else {
      // TODO: instead of warning we could try to 'find' a suitable surface. However, this would also be a bit 'magical'
      console.warn('No focused surface. Selection will not be rendered.')
    }
  }
}

function _addContainerId(sel, editorSession) {
  if (sel && !sel.isNull() && sel.surfaceId && !sel.containerId) {
    let surface = editorSession.getSurface(sel.surfaceId)
    if (surface) {
      let containerId = surface.getContainerId()
      if (containerId) {
        sel.containerId = containerId
      }
    }
  }
}

class LegacySelectionState {
  constructor(state) {
    this.state = state
  }

  getSelection() {
    console.warn(`DEPRECATED: Use state.get("selection") instead.`)
    return this.state.get('selection') || Selection.nullSelection
  }

  isInlineNodeSelection() {
    console.warn(`DEPRECATED: Use state.get("selectionInfo").isInlineNodeSelection instead.`)
    return
  }

  getAnnotationsForType(type) {
    console.warn(`DEPRECATED: use state.get("selectionInfo").getAnnotationsForType(type) instead`)
    let selInfo = this.state.get('selectionInfo')
    return selInfo.getAnnotationsForType(type)
  }

  isFirst() {
    console.warn(`DEPRECATED: use state.get("selectionInfo").isFirst instead`)
    let selInfo = this.state.get('selectionInfo')
    return selInfo.isFirst
  }
}