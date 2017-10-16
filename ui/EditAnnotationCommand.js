import Command from './Command'

/**
  Used for edit tools or property annotations (e.g. EditLinkTool)

  @class
*/
export default class EditAnnotationCommand extends Command {

  constructor(...args) {
    super(...args)

    if (!this.config.nodeType) {
      throw new Error("'nodeType' is required")
    }
  }

  /**
    Get command state

    @return {Object} object with `disabled` and `node` properties
  */
  getCommandState(params) {
    let sel = this._getSelection(params)
    let annos = this._getAnnotationsForSelection(params)
    let newState = {
      disabled: true,
    }
    if (annos.length === 1 && sel.isPropertySelection() && sel.isCollapsed()) {
      newState.disabled = false
      newState.showInContext = true
      newState.nodeId = annos[0].id
    }
    return newState
  }

  execute(params) { } // eslint-disable-line

  _getAnnotationsForSelection(params) {
    let state = params.editorSession.getState()
    let selectionInfo = state.get('selectionInfo')
    return selectionInfo.getAnnotationsForType(this.config.nodeType)
  }
}
