import { Marker } from '../../model'

class ContainerAnnotationManager {

  constructor(context) {
    if (!context.editorSession) {
      throw new Error('EditorSession required.')
    }

    this.editorSession = context.editorSession
    this.editorSession.onUpdate('document', this._onDocumentChanged, this)

    this.doc = this.editorSession.getDocument()
    this.context = Object.assign({}, context, {
      // for convenienve we provide access to the doc directly
      doc: this.doc
    })

    this._state = {
      annotations: {},
      containerFragments: {}
    }

    this.initialize()
  }

  dispose() {
    this.editorSession.off(this)
  }

  initialize() {
    this._computeAnnotations()
    this._createAnnotations()
    // HACK: we make commandStates dirty in order to trigger re-evaluation
    this.editorSession._setDirty('commandStates')
    this.editorSession.startFlow()
  }

  getAnnotationFragments(annoId) {
    return this._state.containerFragments[annoId]
  }

  _onDocumentChanged(change) {
    let dirtyNodes = []
    let shouldUpdate = false

    // For now we will run recomputation after any node creation
    if(Object.keys(change.created).length > 0) shouldUpdate = true

    // We will collect ids of updated nodes to update markers there
    let updated = Object.keys(change.updated)
    updated.forEach(prop => {
      let nodeId = prop.split(',')[0]
      let node = this.doc.get(nodeId)
      if(node && node.isText()) {
        if(dirtyNodes.indexOf(nodeId) === -1) {
          dirtyNodes.push(nodeId)
          // We will run recomputation and update if node with 
          // conntainer annotation got updated
          if(this._state.annotations[nodeId]) shouldUpdate = true
        }
      }
    })

    // Compute range for created/removed annos
    if(dirtyNodes.length === 2) {
      // TODO: We should get container via API
      const container = this.doc.get('body')
      const startPos = container.getPosition(dirtyNodes[0])
      const endPos = container.getPosition(dirtyNodes[1])
      let nodeIds = container.getContent().slice(startPos+1, endPos)
      dirtyNodes = dirtyNodes.concat(nodeIds)
    }

    if(shouldUpdate) {
      this._computeAnnotations()
      dirtyNodes.forEach(nodeId => {
        this._updateAnnotations(nodeId)
      })
    }
  }

  _computeAnnotations() {
    let containerAnnotationIndex = this.doc.getIndex('container-annotations')
    let annos = {}
    let containers = Object.keys(containerAnnotationIndex.annosById)

    containers.forEach(containerId => {
      let annotations = Object.keys(containerAnnotationIndex.annosById[containerId])
      annotations.forEach(annoId => {
        const container = this.doc.get(containerId, 'strict')
        const anno = this.doc.get(annoId)
        const startPos = container.getPosition(anno.start.path[0])
        const endPos = container.getPosition(anno.end.path[0])

        let fragments = []
        // NOTE: for now we only create fragments for spanned TextNodes
        // TODO: support list items
        if(startPos > -1) {
          for (let i = startPos; i <= endPos; i++) {
            let node = container.getChildAt(i)
            if (!node.isText()) continue
            const path = node.getTextPath()
            let fragment = {
              type: 'container-annotation-fragment',
              scope: 'container',
              containerId: containerId,
              anno: anno,
              id: annoId,
              start: { path: path, offset: 0 },
              end: { path: path, offset: node.getLength() + 1 }
            }
            if (i === startPos) {
              fragment.start = anno.start
              fragment.isFirst = true
            }
            if (i === endPos) {
              fragment.end = anno.end
              fragment.isLast = true
            }
            
            let marker = new Marker(this.doc, fragment)

            fragments.push(marker)

            if(!annos[path[0]]) annos[path[0]] = []

            annos[path[0]].push(marker)
          }

          this._state.containerFragments[anno.id] = fragments
        }
      })
    })
    this._state.annotations = annos
  }

  _createAnnotations() {
    const state = this._state
    let annotations = state.annotations
    let nodes = Object.keys(annotations)
    nodes.forEach(nodeId => {
      this._updateAnnotations(nodeId)
    })
  }

  _updateAnnotations(nodeId) {
    const editorSession = this.editorSession
    const markersManager = editorSession.markersManager
    const state = this._state
    let annotations = state.annotations
    let nodeAnnotations = annotations[nodeId]

    if(nodeAnnotations) {
      markersManager.setMarkers('container-annotations:' + nodeId, nodeAnnotations)
    } else {
      markersManager.clearMarkers('container-annotations:' + nodeId)
    }

  }

}

export default ContainerAnnotationManager
