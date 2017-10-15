import { TreeIndex } from '../util'
import documentHelpers from './documentHelpers'
import { isFirst, isLast } from './selectionHelpers'

export default class SelectionInfo {

  constructor(state, context) {
    this.state = state
    this.context = context
    state.reduce('selectionInfo', ['document', 'selection'], this.reduce, this)
  }

  reduce() {
    let state = this.state
    let doc = state.get('document')
    let sel = state.get('selection')
    let info = new Info()
    this._deriveContainerSelectionState(doc, sel, info)
    this._deriveAnnoState(doc, sel, info)
    if (doc.getIndex('markers')) {
      this._deriveMarkerState(doc, sel, info)
    }
    this._deriveIsolatedNodes(sel, info)
    state.set('selectionInfo', info)
  }

  _deriveContainerSelectionState(doc, sel, info) {
    if (sel && sel.containerId) {
      let container = doc.get(sel.containerId)
      info.container = container
      let startId = sel.start.getNodeId()
      let endId = sel.end.getNodeId()
      let startNode = doc.get(startId).getContainerRoot()
      let startPos = container.getPosition(startNode)
      if (startPos > 0) {
        info.previousNode = container.getNodeAt(startPos-1)
      }
      info.isFirst = isFirst(doc, sel.start)
      let endNode, endPos
      if (endId === startId) {
        endNode = startNode
        endPos = startPos
      } else {
        endNode = doc.get(endId).getContainerRoot()
        endPos = container.getPosition(endNode)
      }
      if (endPos < container.getLength()-1) {
        info.nextNode = container.getNodeAt(endPos+1)
      }
      info.isLast = isLast(doc, sel.end)
    }
  }

  _deriveAnnoState(doc, sel, info) {
    // create a mapping by type for the currently selected annotations
    let annosByType = new TreeIndex.Arrays()
    const propAnnos = documentHelpers.getPropertyAnnotationsForSelection(doc, sel)
    propAnnos.forEach(function(anno) {
      annosByType.add(anno.type, anno)
    })

    if (propAnnos.length === 1 && propAnnos[0].isInline()) {
      info.isInlineNodeSelection = propAnnos[0].getSelection().equals(sel)
    }

    const containerId = sel.containerId
    if (containerId) {
      const containerAnnos = documentHelpers.getContainerAnnotationsForSelection(doc, sel, containerId)
      containerAnnos.forEach(function(anno) {
        annosByType.add(anno.type, anno)
      })
    }
    info.annosByType = annosByType
  }

  _deriveMarkerState(doc, sel, info) {
    info.markers = documentHelpers.getMarkersForSelection(doc, sel) || []
  }


  _deriveIsolatedNodes(sel, info) {
    let isolatedNodes = []
    if (sel && sel.surfaceId) {
      let surfaceManager = this.context.surfaceManager
      let surface = surfaceManager.getSurface(sel.surfaceId)
      isolatedNodes = surface.getComponentPath().filter(comp => comp._isAbstractIsolatedNodeComponent)
    }
    info.isolatedNodes = isolatedNodes
  }

}

class Info {

  constructor() {
    // all annotations under the current selection
    this.annosByType = null
    // markers under the current selection
    this.markers = null
    this.isolatedNodes = null
    // flags for inline nodes
    this.isInlineNodeSelection = false
    // container information (only for ContainerSelection)
    this.container = null
    this.previousNode = null
    this.nextNode = null
    // if the previous node is one char away
    this.isFirst = false
    // if the next node is one char away
    this.isLast = false
  }

  getAnnotationsForType(type) {
    if (this.annosByType) {
      return this.annosByType.get(type) || []
    }
    return []
  }
}
