;(function () {
  var originalGetContext = HTMLCanvasElement.prototype.getContext

  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true })
    }
    return originalGetContext.call(this, type, attrs)
  }

  var observer = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].tagName === 'CANVAS') {
          window._pw_canvas = nodes[j]
          observer.disconnect()
          return
        }
      }
    }
  })

  observer.observe(document.body, { childList: true })
})()