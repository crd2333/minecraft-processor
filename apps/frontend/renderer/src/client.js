;(function () {
  'use strict'

  var socket = window._pw_socket
  var viewer = window._pw_viewer
  var controls = window._pw_controls
  var worldRenderer = window._pw_worldRenderer
  var assets = []
  var currentIndex = -1
  var currentAsset = null
  var currentStructure = null
  var currentFormat = null
  var busy = false
  var captureReady = false
  var loadGeneration = 0

  var elements = {
    assetName: document.getElementById('asset-name'),
    scenePosition: document.getElementById('scene-position'),
    captureCount: document.getElementById('capture-count'),
    structureSize: document.getElementById('structure-size'),
    assetFormat: document.getElementById('asset-format'),
    outputDirectory: document.getElementById('output-directory'),
    status: document.getElementById('status'),
    previous: document.getElementById('previous-button'),
    next: document.getElementById('next-button')
  }

  function setStatus (message, kind) {
    elements.status.textContent = message || ''
    elements.status.dataset.kind = kind || ''
  }

  function renderState (state) {
    if (!state) return
    if (Array.isArray(state.assets)) assets = state.assets
    if (Number.isInteger(state.currentIndex)) currentIndex = state.currentIndex
    currentAsset = assets[currentIndex] || currentAsset
    elements.outputDirectory.textContent = state.outputDir || elements.outputDirectory.textContent || '--'
    elements.assetName.textContent = currentAsset ? currentAsset.path : 'No scene selected'
    elements.scenePosition.textContent = currentAsset ? (currentIndex + 1) + ' / ' + assets.length : '0 / ' + assets.length
    elements.captureCount.textContent = currentAsset ? String(currentAsset.captureCount || 0) : '0'
    updateControls()
  }

  function updateControls () {
    var captureButtons = document.querySelectorAll('[data-capture-size]')
    for (var i = 0; i < captureButtons.length; i++) captureButtons[i].disabled = busy || !captureReady
    var presetButtons = document.querySelectorAll('[data-preset]')
    for (var j = 0; j < presetButtons.length; j++) presetButtons[j].disabled = busy || !currentStructure
    elements.previous.disabled = busy || currentIndex <= 0
    elements.next.disabled = busy || currentIndex < 0 || currentIndex >= assets.length - 1
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
    var distance = radius / Math.tan(fovRadians / 2) * 1.34
    var direction
    if (preset === 'rear') direction = new THREE.Vector3(-1, 0.72, -1).normalize()
    else if (preset === 'top') direction = new THREE.Vector3(0.18, 1, 0.22).normalize()
    else direction = new THREE.Vector3(1, 0.72, 1).normalize()

    controls.target.copy(pivot)
    viewer.camera.position.copy(pivot).addScaledVector(direction, distance)
    viewer.camera.near = Math.max(0.05, distance - radius * 2.4)
    viewer.camera.far = Math.max(1000, distance + radius * 3.4)
    viewer.camera.updateProjectionMatrix()
    controls.update()
  }

  function waitForMeshes (generation) {
    var promise = worldRenderer && typeof worldRenderer.waitForChunksToRender === 'function'
      ? worldRenderer.waitForChunksToRender()
      : Promise.resolve()
    promise.then(function () {
      if (generation !== loadGeneration || !currentStructure) return
      window.requestAnimationFrame(function () {
        if (generation !== loadGeneration) return
        fitCamera('front')
        captureReady = true
        updateControls()
        var meshCount = worldRenderer && worldRenderer.sectionMeshs
          ? Object.keys(worldRenderer.sectionMeshs).length
          : 0
        setStatus('Ready. ' + meshCount + ' rendered sections.', 'success')
      })
    }).catch(function (error) {
      if (generation !== loadGeneration) return
      setStatus('Scene render failed: ' + (error.message || String(error)), 'error')
    })
  }

  function applyLoadedAsset (payload) {
    loadGeneration++
    captureReady = false
    renderState(payload && payload.state)
    currentAsset = payload && payload.asset ? payload.asset : (assets[currentIndex] || null)
    currentStructure = payload && payload.ok ? payload.structure : null
    currentFormat = payload && payload.format ? payload.format : null
    elements.assetName.textContent = currentAsset ? currentAsset.path : 'No scene selected'
    elements.captureCount.textContent = currentAsset ? String(currentAsset.captureCount || 0) : '0'
    elements.assetFormat.textContent = currentFormat || '--'
    elements.structureSize.textContent = currentStructure && currentStructure.size
      ? currentStructure.size.x + ' x ' + currentStructure.size.y + ' x ' + currentStructure.size.z
      : '--'
    updateControls()

    if (!payload || payload.ok !== true) {
      setStatus('Unable to render this scene: ' + ((payload && payload.error) || 'unknown error'), 'error')
      return
    }
    setStatus('Waiting for scene meshes...', '')
    waitForMeshes(loadGeneration)
  }

  function switchScene (index, force) {
    if (!socket || busy || !Number.isInteger(index) || index < 0 || index >= assets.length) return
    if (!force && index === currentIndex) return
    busy = true
    captureReady = false
    updateControls()
    setStatus('Loading scene ' + (index + 1) + '...', '')
    socket.emit('renderer:switchAsset', { index: index }, function (response) {
      busy = false
      if (!response || response.ok !== true) {
        renderState(response && response.state)
        setStatus('Scene switch failed: ' + ((response && response.error) || 'unknown error'), 'error')
        updateControls()
        return
      }
      renderState(response.state)
      updateControls()
    })
  }

  function dataUrlToArrayBuffer (dataUrl) {
    var marker = 'data:image/png;base64,'
    if (typeof dataUrl !== 'string' || dataUrl.slice(0, marker.length) !== marker) {
      throw new Error('Screenshot API returned an invalid PNG data URL')
    }
    var binary = window.atob(dataUrl.slice(marker.length))
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes.buffer
  }

  function emitCapture (payload) {
    return new Promise(function (resolve, reject) {
      var settled = false
      var timer = window.setTimeout(function () {
        if (settled) return
        settled = true
        reject(new Error('Server did not acknowledge the capture within 120 seconds'))
      }, 120000)
      socket.emit('renderer:saveCapture', payload, function (response) {
        if (settled) return
        settled = true
        window.clearTimeout(timer)
        if (!response || response.ok !== true) {
          reject(new Error((response && response.error) || 'unknown server error'))
          return
        }
        resolve(response)
      })
    })
  }

  function capture (size) {
    if (busy || !captureReady || !currentAsset || !window.__captureScreenshot) return
    busy = true
    updateControls()
    setStatus('Rendering ' + size + ' x ' + size + '...', '')

    window.setTimeout(function () {
      var shot
      try {
        shot = window.__captureScreenshot({ square: true, size: size })
      } catch (error) {
        busy = false
        updateControls()
        setStatus('Capture failed: ' + (error.message || String(error)), 'error')
        return
      }

      var payload
      try {
        payload = {
          asset: currentAsset.path,
          caseIndex: currentAsset.caseIndex,
          size: size,
          camera: shot.camera || null,
          pixal3d: shot.pixal3d || null,
          png: dataUrlToArrayBuffer(shot.dataUrl)
        }
      } catch (error) {
        busy = false
        updateControls()
        setStatus('Capture conversion failed: ' + (error.message || String(error)), 'error')
        return
      }

      setStatus('Saving capture on the server...', '')
      emitCapture(payload).then(function (response) {
        renderState(response.state)
        busy = false
        updateControls()
        var metadata = response.metadata || {}
        setStatus('Saved view ' + metadata.view_index + ': ' + (metadata.image_path || ''), 'success')
      }).catch(function (error) {
        busy = false
        updateControls()
        setStatus('Server save failed: ' + (error.message || String(error)), 'error')
      })
    }, 0)
  }

  function bindControls () {
    var captureButtons = document.querySelectorAll('[data-capture-size]')
    for (var i = 0; i < captureButtons.length; i++) {
      captureButtons[i].addEventListener('click', function () { capture(Number(this.dataset.captureSize)) })
    }
    var presetButtons = document.querySelectorAll('[data-preset]')
    for (var j = 0; j < presetButtons.length; j++) {
      presetButtons[j].addEventListener('click', function () { fitCamera(this.dataset.preset) })
    }
    elements.previous.addEventListener('click', function () { switchScene(currentIndex - 1, false) })
    elements.next.addEventListener('click', function () { switchScene(currentIndex + 1, false) })

    document.addEventListener('keydown', function (event) {
      var target = event.target
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        switchScene(currentIndex - 1, false)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        switchScene(currentIndex + 1, false)
      } else if (event.key === '1' || event.key === '2' || event.key === '3') {
        event.preventDefault()
        fitCamera({ 1: 'front', 2: 'rear', 3: 'top' }[event.key])
      }
    })
  }

  if (!socket || !viewer || !controls || !window.__captureScreenshot) {
    setStatus('Viewer runtime did not initialize. Run npm run build and reload.', 'error')
    return
  }

  socket.on('renderer:assetLoaded', applyLoadedAsset)
  bindControls()
  socket.emit('renderer:getState', null, function (response) {
    if (!response || response.ok !== true) {
      setStatus('Could not load renderer state.', 'error')
      return
    }
    renderState(response.state)
    switchScene(response.state.currentIndex, true)
  })
})()
