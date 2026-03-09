;(function () {
  'use strict'

  var originalUpdateMatrixWorld = THREE.Scene.prototype.updateMatrixWorld || THREE.Object3D.prototype.updateMatrixWorld
  THREE.Scene.prototype.updateMatrixWorld = function (force) {
    window._pw_scene = this
    return originalUpdateMatrixWorld.call(this, force)
  }

  var panel = document.createElement('div')
  panel.id = 'export-panel'
  panel.innerHTML = [
    '<div class="panel-section">',
    '<div class="panel-title">Viewer</div>',
    '<button id="btn-toggle-axes">Hide Axes</button>',
    '<button id="btn-screenshot">\u{1F4F7} Screenshot</button>',
    '<button id="btn-export-obj">\u2B07 Export OBJ</button>',
    '<button id="btn-export-stl">\u2B07 Export STL</button>',
    '<button id="btn-export-glb">\u2B07 Export GLB</button>',
    '</div>',
    '<div class="panel-section" id="bbox-panel">',
    '<div class="panel-title">Bounding Box</div>',
    '<label class="panel-checkbox"><input type="checkbox" id="bbox-enabled" checked> Show bounding box</label>',
    '<div class="field-grid">',
    '<label>Origin X<input id="bbox-origin-x" type="number" step="1"></label>',
    '<label>Size X<input id="bbox-size-x" type="number" min="1" step="1"></label>',
    '<label>Origin Y<input id="bbox-origin-y" type="number" step="1"></label>',
    '<label>Size Y<input id="bbox-size-y" type="number" min="1" step="1"></label>',
    '<label>Origin Z<input id="bbox-origin-z" type="number" step="1"></label>',
    '<label>Size Z<input id="bbox-size-z" type="number" min="1" step="1"></label>',
    '</div>',
    '<div class="panel-actions">',
    '<button id="bbox-reset-cube">Reset 64^3</button>',
    '<button id="bbox-copy-args">Copy parse args</button>',
    '</div>',
    '<div class="command-block">',
    '<div class="command-label">parse_mc_ids args</div>',
    '<textarea id="bbox-command" rows="3" readonly></textarea>',
    '<div id="bbox-command-hint" class="command-hint"></div>',
    '</div>',
    '</div>',
    '<div id="export-status"></div>'
  ].join('')
  document.body.appendChild(panel)

  var statusTimer
  function setStatus (message) {
    clearTimeout(statusTimer)
    document.getElementById('export-status').textContent = message
    if (message) statusTimer = setTimeout(function () { setStatus('') }, 4000)
  }

  function downloadBlob (blob, filename) {
    var url = URL.createObjectURL(blob)
    var anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    setTimeout(function () {
      URL.revokeObjectURL(url)
      if (anchor.parentNode) anchor.parentNode.removeChild(anchor)
    }, 1000)
  }

  function bindExportButtons () {
    document.getElementById('btn-screenshot').addEventListener('click', function () {
      var canvas = window._pw_canvas || document.querySelector('canvas')
      if (!canvas) { setStatus('Canvas not found'); return }
      try {
        var dataUrl = canvas.toDataURL('image/png')
        var anchor = document.createElement('a')
        anchor.href = dataUrl
        anchor.download = 'screenshot.png'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        setStatus('Screenshot saved.')
      } catch (error) {
        setStatus('Screenshot failed: ' + error.message)
      }
    })

    document.getElementById('btn-export-obj').addEventListener('click', function () {
      if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
      try {
        var result = new THREE.OBJExporter().parse(window._pw_scene)
        downloadBlob(new Blob([result], { type: 'text/plain' }), 'model.obj')
        setStatus('OBJ downloaded.')
      } catch (error) {
        setStatus('Error: ' + error.message)
      }
    })

    document.getElementById('btn-export-stl').addEventListener('click', function () {
      if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
      try {
        var result = new THREE.STLExporter().parse(window._pw_scene, { binary: true })
        var buffer = result instanceof ArrayBuffer ? result : result.buffer || result
        downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), 'model.stl')
        setStatus('STL downloaded.')
      } catch (error) {
        setStatus('Error: ' + error.message)
      }
    })

    document.getElementById('btn-export-glb').addEventListener('click', function () {
      if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
      try {
        new THREE.GLTFExporter().parse(window._pw_scene, function (glb) {
          var buffer = glb instanceof ArrayBuffer ? glb : glb.buffer || glb
          downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), 'model.glb')
          setStatus('GLB downloaded.')
        }, { binary: true })
      } catch (error) {
        setStatus('Error: ' + error.message)
      }
    })
  }

  function makeMissingTexture () {
    var canvas = document.createElement('canvas')
    canvas.width = 2
    canvas.height = 2

    var context = canvas.getContext('2d')
    context.fillStyle = '#FF00FF'
    context.fillRect(0, 0, 1, 1)
    context.fillRect(1, 1, 1, 1)
    context.fillStyle = '#000000'
    context.fillRect(1, 0, 1, 1)
    context.fillRect(0, 1, 1, 1)

    var texture = new THREE.CanvasTexture(canvas)
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    return texture
  }

  var pendingErrorBlocks = null
  var pendingStructureAxis = null
  var pendingBoundingBox = null
  var currentBoundingBox = null
  var axisVisible = true
  var axisGroup = null
  var boundingBoxGroup = null

  function cloneBoundingBoxConfig (config) {
    if (!config || !config.origin || !config.size) return null
    return {
      origin: { x: Number(config.origin.x) || 0, y: Number(config.origin.y) || 0, z: Number(config.origin.z) || 0 },
      relativeOrigin: {
        x: Number(config.relativeOrigin && config.relativeOrigin.x) || 0,
        y: Number(config.relativeOrigin && config.relativeOrigin.y) || 0,
        z: Number(config.relativeOrigin && config.relativeOrigin.z) || 0
      },
      size: { x: Number(config.size.x) || 1, y: Number(config.size.y) || 1, z: Number(config.size.z) || 1 },
      enabled: config.enabled !== false
    }
  }

  function quoteArg (value) {
    return /[^A-Za-z0-9_./:-]/.test(value) ? '"' + value.replace(/"/g, '\\"') + '"' : value
  }

  function setInputValue (id, value) {
    var element = document.getElementById(id)
    if (!element) return
    element.value = String(value)
  }

  function getInputNumber (id, fallback) {
    var element = document.getElementById(id)
    if (!element) return fallback
    var value = Number(element.value)
    return Number.isFinite(value) ? value : fallback
  }

  function updateBoundingBoxCommandPreview () {
    var command = document.getElementById('bbox-command')
    var hint = document.getElementById('bbox-command-hint')
    if (!command || !hint || !currentBoundingBox) return

    var relativeOrigin = currentBoundingBox.relativeOrigin
    var size = currentBoundingBox.size
    var isCube = size.x === size.y && size.y === size.z
    var baseArg = '--base ' + relativeOrigin.x + ',' + relativeOrigin.y + ',' + relativeOrigin.z
    var sizeArg = isCube
      ? '--res ' + size.x
      : '--bbox-size ' + size.x + ',' + size.y + ',' + size.z

    command.value = [baseArg, sizeArg].join(' ')
    if (isCube) {
      hint.textContent = 'Current box maps directly to parse_mc_ids.js.'
    } else {
      hint.textContent = 'parse_mc_ids.js currently accepts only cubic --res values; this preview keeps the full box size for reference.'
    }
  }

  function syncBoundingBoxControls () {
    if (!currentBoundingBox) return
    var enabled = document.getElementById('bbox-enabled')
    if (enabled) enabled.checked = currentBoundingBox.enabled !== false

    setInputValue('bbox-origin-x', currentBoundingBox.relativeOrigin.x)
    setInputValue('bbox-origin-y', currentBoundingBox.relativeOrigin.y)
    setInputValue('bbox-origin-z', currentBoundingBox.relativeOrigin.z)
    setInputValue('bbox-size-x', currentBoundingBox.size.x)
    setInputValue('bbox-size-y', currentBoundingBox.size.y)
    setInputValue('bbox-size-z', currentBoundingBox.size.z)
    updateBoundingBoxCommandPreview()
  }

  function updateBoundingBoxFromControls () {
    if (!currentBoundingBox) return

    currentBoundingBox.enabled = document.getElementById('bbox-enabled').checked
    currentBoundingBox.relativeOrigin = {
      x: Math.round(getInputNumber('bbox-origin-x', currentBoundingBox.relativeOrigin.x)),
      y: Math.round(getInputNumber('bbox-origin-y', currentBoundingBox.relativeOrigin.y)),
      z: Math.round(getInputNumber('bbox-origin-z', currentBoundingBox.relativeOrigin.z))
    }
    currentBoundingBox.size = {
      x: Math.max(1, Math.round(getInputNumber('bbox-size-x', currentBoundingBox.size.x))),
      y: Math.max(1, Math.round(getInputNumber('bbox-size-y', currentBoundingBox.size.y))),
      z: Math.max(1, Math.round(getInputNumber('bbox-size-z', currentBoundingBox.size.z)))
    }
    currentBoundingBox.origin = {
      x: currentBoundingBox.structureOrigin.x + currentBoundingBox.relativeOrigin.x,
      y: currentBoundingBox.structureOrigin.y + currentBoundingBox.relativeOrigin.y,
      z: currentBoundingBox.structureOrigin.z + currentBoundingBox.relativeOrigin.z
    }

    syncBoundingBoxControls()
    if (window._pw_scene) renderBoundingBox(window._pw_scene, currentBoundingBox)
  }

  function bindBoundingBoxControls () {
    var fieldIds = [
      'bbox-origin-x',
      'bbox-origin-y',
      'bbox-origin-z',
      'bbox-size-x',
      'bbox-size-y',
      'bbox-size-z',
      'bbox-enabled'
    ]

    fieldIds.forEach(function (id) {
      var element = document.getElementById(id)
      if (!element) return
      element.addEventListener('input', updateBoundingBoxFromControls)
      element.addEventListener('change', updateBoundingBoxFromControls)
    })

    document.getElementById('bbox-reset-cube').addEventListener('click', function () {
      if (!currentBoundingBox) return
      currentBoundingBox.relativeOrigin = { x: 0, y: 0, z: 0 }
      currentBoundingBox.size = { x: 64, y: 64, z: 64 }
      currentBoundingBox.enabled = true
      syncBoundingBoxControls()
      updateBoundingBoxFromControls()
      setStatus('Bounding box reset to 64x64x64 at 0,0,0.')
    })

    document.getElementById('bbox-copy-args').addEventListener('click', function () {
      var command = document.getElementById('bbox-command')
      if (!command || !command.value) return
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command.value).then(function () {
          setStatus('parse_mc_ids args copied.')
        }).catch(function () {
          command.select()
          setStatus('Clipboard unavailable; selected args instead.')
        })
      } else {
        command.select()
        setStatus('Clipboard unavailable; selected args instead.')
      }
    })
  }

  function disposeAxisGroup () {
    if (!axisGroup) return
    if (axisGroup.parent) axisGroup.parent.remove(axisGroup)
    axisGroup.traverse(function (child) {
      if (child.geometry) child.geometry.dispose()
      if (child.material) child.material.dispose()
    })
    axisGroup = null
  }

  function updateAxisButtonLabel () {
    var button = document.getElementById('btn-toggle-axes')
    if (!button) return
    button.textContent = axisVisible ? 'Hide Axes' : 'Show Axes'
  }

  function disposeBoundingBoxGroup () {
    if (!boundingBoxGroup) return
    if (boundingBoxGroup.parent) boundingBoxGroup.parent.remove(boundingBoxGroup)
    boundingBoxGroup.traverse(function (child) {
      if (child.geometry) child.geometry.dispose()
      if (child.material) child.material.dispose()
    })
    boundingBoxGroup = null
  }

  function makeAxisArrow (origin, direction, length, color) {
    var arrow = new THREE.Group()
    var directionVector = new THREE.Vector3(direction.x, direction.y, direction.z).normalize()
    var shaftRadius = Math.max(0.05, length * 0.008)
    var headRadius = shaftRadius * 2.4
    var headLength = Math.max(0.45, length * 0.12)
    var shaftLength = Math.max(0.001, length - headLength)
    var material = new THREE.MeshLambertMaterial({ color: color })

    var shaft = new THREE.Mesh(
      new THREE.CylinderGeometry(shaftRadius, shaftRadius, shaftLength, 12),
      material
    )
    shaft.position.y = shaftLength / 2
    arrow.add(shaft)

    var head = new THREE.Mesh(
      new THREE.ConeGeometry(headRadius, headLength, 16),
      material
    )
    head.position.y = shaftLength + (headLength / 2)
    arrow.add(head)

    arrow.position.set(origin.x, origin.y, origin.z)
    arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), directionVector)
    return arrow
  }

  function renderStructureAxis (scene, config) {
    disposeAxisGroup()
    if (!config || !config.origin || !config.length) return

    var origin = config.origin
    var length = config.length
    var group = new THREE.Group()
    group.name = 'structureAxis'
    group.visible = axisVisible
    group.add(makeAxisArrow(origin, { x: 1, y: 0, z: 0 }, length, 0xff0000))
    group.add(makeAxisArrow(origin, { x: 0, y: 1, z: 0 }, length, 0x00ff00))
    group.add(makeAxisArrow(origin, { x: 0, y: 0, z: 1 }, length, 0x0000ff))

    axisGroup = group
    scene.add(group)
  }

  function renderBoundingBox (scene, config) {
    disposeBoundingBoxGroup()
    if (!config || !config.origin || !config.size || config.enabled === false) return

    var size = config.size
    var center = {
      x: config.origin.x + (size.x / 2),
      y: config.origin.y + (size.y / 2),
      z: config.origin.z + (size.z / 2)
    }

    var group = new THREE.Group()
    var fill = new THREE.Mesh(
      new THREE.BoxGeometry(size.x, size.y, size.z),
      new THREE.MeshBasicMaterial({
        color: 0x8a6a00,
        transparent: true,
        opacity: 0.08,
        depthTest: false,
        side: THREE.DoubleSide
      })
    )
    fill.position.set(center.x, center.y, center.z)
    fill.renderOrder = 998

    var geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(size.x, size.y, size.z))
    var material = new THREE.LineBasicMaterial({
      color: 0x8a6a00,
      transparent: true,
      opacity: 1,
      depthTest: false
    })
    var wirebox = new THREE.LineSegments(geometry, material)
    wirebox.position.set(center.x, center.y, center.z)
    wirebox.renderOrder = 999

    group.name = 'selectionBoundingBox'
    group.add(fill)
    group.add(wirebox)
    boundingBoxGroup = group
    scene.add(group)
  }

  function bindAxisToggle () {
    document.getElementById('btn-toggle-axes').addEventListener('click', function () {
      axisVisible = !axisVisible
      if (axisGroup) axisGroup.visible = axisVisible
      updateAxisButtonLabel()
    })
    updateAxisButtonLabel()
  }

  function injectErrorBlocks (scene, positions) {
    var geometry = new THREE.BoxGeometry(1, 1, 1)
    var material = new THREE.MeshBasicMaterial({ map: makeMissingTexture() })
    var mesh = new THREE.InstancedMesh(geometry, material, positions.length)
    mesh.name = 'errorBlocks'

    var dummy = new THREE.Object3D()
    for (var i = 0; i < positions.length; i++) {
      dummy.position.set(positions[i].x + 0.5, positions[i].y + 0.5, positions[i].z + 0.5)
      dummy.updateMatrix()
      mesh.setMatrixAt(i, dummy.matrix)
    }

    mesh.instanceMatrix.needsUpdate = true
    scene.add(mesh)
    console.log('[error-blocks] rendered ' + positions.length + ' unrecognised block(s) as error placeholders')
  }

  function bindErrorBlockOverlay () {
    var poll = setInterval(function () {
      if (!window._pw_scene) return
      if (pendingErrorBlocks) {
        injectErrorBlocks(window._pw_scene, pendingErrorBlocks)
        pendingErrorBlocks = null
      }
      if (pendingStructureAxis) {
        renderStructureAxis(window._pw_scene, pendingStructureAxis)
        pendingStructureAxis = null
      }
      if (pendingBoundingBox) {
        renderBoundingBox(window._pw_scene, pendingBoundingBox)
        pendingBoundingBox = null
      }
    }, 100)

    setTimeout(function () { clearInterval(poll) }, 60000)

    var socket = io()
    socket.on('errorBlocks', function (positions) {
      if (!positions || !positions.length) return
      pendingErrorBlocks = positions
    })

    socket.on('structureAxis', function (config) {
      if (!config || !config.origin || !config.length) return
      pendingStructureAxis = config
      if (window._pw_scene) renderStructureAxis(window._pw_scene, config)
    })

    socket.on('boundingBox', function (config) {
      if (!config || !config.origin || !config.size) return
      var nextConfig = cloneBoundingBoxConfig(config)
      nextConfig.structureOrigin = {
        x: nextConfig.origin.x - nextConfig.relativeOrigin.x,
        y: nextConfig.origin.y - nextConfig.relativeOrigin.y,
        z: nextConfig.origin.z - nextConfig.relativeOrigin.z
      }
      currentBoundingBox = nextConfig
      syncBoundingBoxControls()
      pendingBoundingBox = nextConfig
      if (window._pw_scene) renderBoundingBox(window._pw_scene, nextConfig)
    })
  }

  bindAxisToggle()
  bindExportButtons()
  bindBoundingBoxControls()
  bindErrorBlockOverlay()
})()