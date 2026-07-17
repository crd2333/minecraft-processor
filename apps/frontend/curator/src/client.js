;(function () {
  'use strict'

  var socket = window._pw_socket
  var viewer = window._pw_viewer
  var controls = window._pw_controls
  var worldRenderer = window._pw_worldRenderer
  var currentAsset = null
  var currentRow = null
  var rows = []
  var busy = false
  var currentStructure = null
  var boundingBoxGroup = null
  var BOUNDING_BOX_RENDER_PADDING = 0.03

  var elements = {
    assetName: document.getElementById('asset-name'),
    progressLabel: document.getElementById('progress-label'),
    progressPercent: document.getElementById('progress-percent'),
    progressFill: document.getElementById('progress-fill'),
    metricSize: document.getElementById('metric-size'),
    metricMax: document.getElementById('metric-max'),
    metricBlocks: document.getElementById('metric-blocks'),
    metricPalette: document.getElementById('metric-palette'),
    metricRating: document.getElementById('metric-rating'),
    metricFormat: document.getElementById('metric-format'),
    csvPath: document.getElementById('csv-path'),
    status: document.getElementById('status'),
    loadError: document.getElementById('load-error'),
    previous: document.getElementById('previous-button'),
    next: document.getElementById('next-button')
  }

  function setStatus (message, kind) {
    elements.status.textContent = message || ''
    elements.status.dataset.kind = kind || ''
  }

  function valueOrDash (value) {
    return value === '' || value === null || value === undefined ? '--' : String(value)
  }

  function findRow (asset) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].asset_path === asset) return rows[i]
    }
    return null
  }

  function renderState (state) {
    if (!state) return
    rows = Array.isArray(state.rows) ? state.rows : rows
    currentAsset = state.currentAsset || currentAsset
    currentRow = findRow(currentAsset)
    elements.csvPath.textContent = state.csvPath || '--'

    var summary = state.summary || { total: rows.length, reviewed: 0 }
    var total = Number(summary.total) || 0
    var reviewed = Number(summary.reviewed) || 0
    var percent = total ? Math.round(reviewed / total * 100) : 0
    elements.progressLabel.textContent = reviewed + ' / ' + total + ' reviewed'
    elements.progressPercent.textContent = percent + '%'
    elements.progressFill.style.width = percent + '%'

    if (!currentRow) {
      elements.assetName.textContent = 'No asset selected'
      return
    }

    elements.assetName.textContent = currentRow.asset_path
    elements.metricSize.textContent = currentRow.width && currentRow.height && currentRow.length
      ? currentRow.width + ' × ' + currentRow.height + ' × ' + currentRow.length
      : '--'
    elements.metricMax.textContent = valueOrDash(currentRow.max_size)
    elements.metricBlocks.textContent = valueOrDash(currentRow.block_count)
    elements.metricPalette.textContent = valueOrDash(currentRow.palette_size)
    elements.metricRating.textContent = currentRow.rating || 'unrated'
    updateRatingButtons(currentRow.rating || 'unrated')
  }

  function updateRatingButtons (rating) {
    var buttons = document.querySelectorAll('[data-rating]')
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute('aria-pressed', buttons[i].dataset.rating === rating ? 'true' : 'false')
      buttons[i].disabled = busy
    }
    elements.previous.disabled = busy
    elements.next.disabled = busy
  }

  function setLoadError (message) {
    var hasError = Boolean(message)
    elements.loadError.classList.toggle('hidden', !hasError)
    elements.loadError.textContent = hasError ? 'Unable to render this asset: ' + message + '. You can mark it Reject or continue.' : ''
  }

  function getThree () {
    return window.THREE || (typeof globalThis !== 'undefined' ? globalThis.THREE : null)
  }

  function fitCamera (preset) {
    if (!viewer || !viewer.camera || !controls || !currentStructure) return
    var THREE = getThree()
    if (!THREE) return

    var size = currentStructure.size || { x: 1, y: 1, z: 1 }
    var origin = currentStructure.originWorld || { x: 0, y: 60, z: 0 }
    var pivot = new THREE.Vector3(
      Number(origin.x) + Number(size.x) / 2,
      Number(origin.y) + Number(size.y) / 2,
      Number(origin.z) + Number(size.z) / 2
    )
    var radius = Math.max(1, Math.sqrt(Number(size.x) ** 2 + Number(size.y) ** 2 + Number(size.z) ** 2) / 2)
    var fovRadians = viewer.camera.fov * Math.PI / 180
    var aspect = viewer.camera.aspect || (window.innerWidth / Math.max(window.innerHeight, 1))
    var verticalDistance = radius / Math.tan(fovRadians / 2)
    var horizontalFov = 2 * Math.atan(Math.tan(fovRadians / 2) * Math.max(aspect, 0.1))
    var horizontalDistance = radius / Math.tan(horizontalFov / 2)
    var distance = Math.max(verticalDistance, horizontalDistance) * 1.34
    var direction
    if (preset === 'rear') {
      direction = new THREE.Vector3(-1, 0.72, -1).normalize()
    } else if (preset === 'top') {
      direction = new THREE.Vector3(0.18, 1, 0.22).normalize()
    } else {
      direction = new THREE.Vector3(1, 0.72, 1).normalize()
    }

    controls.target.copy(pivot)
    viewer.camera.position.copy(pivot).addScaledVector(direction, distance)
    viewer.camera.near = Math.max(0.05, distance - radius * 2.4)
    viewer.camera.far = Math.max(1000, distance + radius * 3.4)
    viewer.camera.updateProjectionMatrix()
    controls.update()
  }

  function fitFront () {
    fitCamera('front')
  }

  function disposeBoundingBox () {
    if (!boundingBoxGroup) return
    if (boundingBoxGroup.parent) boundingBoxGroup.parent.remove(boundingBoxGroup)
    boundingBoxGroup.traverse(function (child) {
      if (child.geometry) child.geometry.dispose()
      if (child.material) child.material.dispose()
    })
    boundingBoxGroup = null
  }

  function renderStructureBoundingBox () {
    disposeBoundingBox()
    if (!viewer || !viewer.scene || !currentStructure) return
    var THREE = getThree()
    if (!THREE) return

    var size = currentStructure.size || { x: 1, y: 1, z: 1 }
    var origin = currentStructure.originWorld || { x: 0, y: 60, z: 0 }
    var padding = BOUNDING_BOX_RENDER_PADDING
    var expandedSize = {
      x: Number(size.x) + padding * 2,
      y: Number(size.y) + padding * 2,
      z: Number(size.z) + padding * 2
    }
    var center = {
      x: Number(origin.x) + Number(size.x) / 2,
      y: Number(origin.y) + Number(size.y) / 2,
      z: Number(origin.z) + Number(size.z) / 2
    }

    var group = new THREE.Group()
    group.name = 'curatorStructureBoundingBox'

    var fill = new THREE.Mesh(
      new THREE.BoxGeometry(expandedSize.x, expandedSize.y, expandedSize.z),
      new THREE.MeshBasicMaterial({
        color: 0x8a6a00,
        transparent: true,
        opacity: 0.05,
        depthTest: false,
        side: THREE.DoubleSide
      })
    )
    fill.position.set(center.x, center.y, center.z)
    fill.renderOrder = 998

    var wirebox = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(expandedSize.x, expandedSize.y, expandedSize.z)),
      new THREE.LineBasicMaterial({
        color: 0x8a6a00,
        transparent: true,
        opacity: 1,
        depthTest: false
      })
    )
    wirebox.position.set(center.x, center.y, center.z)
    wirebox.renderOrder = 999

    group.add(fill)
    group.add(wirebox)
    boundingBoxGroup = group
    viewer.scene.add(group)
  }

  function waitForMeshesThenFit () {
    var promise = worldRenderer && typeof worldRenderer.waitForChunksToRender === 'function'
      ? worldRenderer.waitForChunksToRender()
      : Promise.resolve()
    promise.then(function () {
      window.requestAnimationFrame(function () { fitFront() })
    }).catch(function () { fitFront() })
  }

  function updateRenderDiagnostics () {
    if (!worldRenderer || !worldRenderer.sectionMeshs) return
    var meshCount = Object.keys(worldRenderer.sectionMeshs).length
    if (meshCount > 0) {
      elements.status.textContent = 'Ready. ' + meshCount + ' rendered sections. Choose a rating or inspect another view.'
      elements.status.dataset.kind = 'success'
    }
  }

  function applyLoadedAsset (payload) {
    if (!payload) return
    currentAsset = payload.asset || currentAsset
    currentRow = payload.row || findRow(currentAsset)
    currentStructure = payload.ok ? (payload.structure || null) : null
    renderStructureBoundingBox()
    elements.metricFormat.textContent = payload.format || 'schem'
    setLoadError(payload.ok ? '' : (payload.error || 'unknown loading error'))
    renderState({ currentAsset: currentAsset, rows: rows })
    if (payload.ok) {
      setStatus('Ready. Choose a rating or inspect another view.', 'success')
      waitForMeshesThenFit()
      window.setTimeout(updateRenderDiagnostics, 120)
    } else {
      setStatus('Asset load failed. Continue or mark Reject.', 'error')
    }
  }

  function nextUnratedAsset () {
    if (!rows.length) return null
    var start = Math.max(0, rows.findIndex(function (row) { return row.asset_path === currentAsset }))
    for (var offset = 1; offset <= rows.length; offset++) {
      var row = rows[(start + offset) % rows.length]
      if (row.rating === 'unrated') return row.asset_path
    }
    return null
  }

  function adjacentAsset (delta) {
    if (!rows.length) return null
    var index = rows.findIndex(function (row) { return row.asset_path === currentAsset })
    if (index < 0) index = 0
    return rows[(index + delta + rows.length) % rows.length].asset_path
  }

  function switchAsset (asset) {
    if (!asset || busy || asset === currentAsset) return
    busy = true
    updateRatingButtons(currentRow ? currentRow.rating : 'unrated')
    setStatus('Loading ' + asset + '...', '')
    socket.emit('curator:switchAsset', { asset: asset }, function (response) {
      busy = false
      if (!response || response.ok !== true) {
        setStatus('Switch failed: ' + ((response && response.error) || 'unknown error'), 'error')
        renderState(response && response.state)
        return
      }
      renderState(response.state)
      setStatus('Waiting for the model to finish loading...', '')
    })
  }

  function rateAsset (rating) {
    if (busy || !currentAsset || !socket) return
    busy = true
    updateRatingButtons(rating)
    setStatus('Saving ' + rating + '...', '')
    socket.emit('curator:rateAsset', { asset: currentAsset, rating: rating }, function (response) {
      if (!response || response.ok !== true) {
        busy = false
        setStatus('Could not save rating: ' + ((response && response.error) || 'unknown error'), 'error')
        renderState(response && response.state)
        return
      }
      renderState(response.state)
      var next = nextUnratedAsset()
      busy = false
      updateRatingButtons(currentRow ? currentRow.rating : 'unrated')
      if (next) {
        switchAsset(next)
      } else {
        setStatus('All assets have a rating.', 'success')
      }
    })
  }

  function bindControls () {
    var ratingButtons = document.querySelectorAll('[data-rating]')
    for (var i = 0; i < ratingButtons.length; i++) {
      ratingButtons[i].addEventListener('click', function () { rateAsset(this.dataset.rating) })
    }
    var presetButtons = document.querySelectorAll('[data-preset]')
    for (var j = 0; j < presetButtons.length; j++) {
      presetButtons[j].addEventListener('click', function () { fitCamera(this.dataset.preset) })
    }
    elements.previous.addEventListener('click', function () { switchAsset(adjacentAsset(-1)) })
    elements.next.addEventListener('click', function () { switchAsset(nextUnratedAsset() || adjacentAsset(1)) })

    document.addEventListener('keydown', function (event) {
      var target = event.target
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      var key = event.key.toLowerCase()
      if (key === 'k' || key === 'm' || key === 'f' || key === 'x') {
        event.preventDefault()
        rateAsset({ k: 'keep', m: 'maybe', f: 'functional', x: 'reject' }[key])
      } else if (key === '1' || key === '2' || key === '3') {
        event.preventDefault()
        fitCamera({ 1: 'front', 2: 'rear', 3: 'top' }[key])
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault()
        switchAsset(adjacentAsset(-1))
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        switchAsset(nextUnratedAsset() || adjacentAsset(1))
      }
    })
  }

  if (!socket || !viewer || !controls) {
    setStatus('Viewer runtime did not initialize. Run npm run build and reload.', 'error')
    return
  }

  socket.on('curator:assetLoaded', applyLoadedAsset)
  bindControls()
  socket.emit('curator:getState', null, function (response) {
    if (!response || response.ok !== true) {
      setStatus('Could not load curator state.', 'error')
      return
    }
    renderState(response.state)
    if (!currentAsset && response.state && response.state.currentAsset) currentAsset = response.state.currentAsset
    setStatus('Loading current asset...', '')
    socket.emit('curator:switchAsset', { asset: currentAsset }, function (switchResponse) {
      if (!switchResponse || switchResponse.ok !== true) {
        setStatus('Could not load current asset: ' + ((switchResponse && switchResponse.error) || 'unknown error'), 'error')
        return
      }
      renderState(switchResponse.state)
    })
  })
})()
