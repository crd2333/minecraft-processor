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
    '<button id="btn-export">\u2B07 Export</button>',
    '<select id="export-format">',
    '<option value="obj">OBJ</option>',
    '<option value="stl">STL</option>',
    '<option value="glb">GLB</option>',
    '</select>',
    '<button id="btn-screenshot">\u{1F4F7} Screenshot</button>',
    '<button id="btn-render-gbuffer">\u{1F4F7} Render GBuffer (.bin)</button>',
    '<label class="panel-checkbox"><input type="checkbox" id="gbuffer-use-color-seg"> Seg uses mapping color</label>',
    '<label class="panel-checkbox"><input type="checkbox" id="gbuffer-square" checked> Force square render</label>',
    '<label class="panel-checkbox"><input type="checkbox" id="gbuffer-show-guide"> Show square guide</label>',
    '<label class="panel-checkbox">Size <input id="gbuffer-size" type="number" min="64" step="64" value="512"></label>',
    '</div>',
    '<div class="panel-section" id="bbox-panel">',
    '<div class="panel-title">Auxiliary</div>',
    '<label class="panel-checkbox"><input type="checkbox" id="axis-visible" checked> Show Axes</label>',
    '<label class="panel-checkbox"><input type="checkbox" id="bbox-enabled" checked> Show bounding box</label>',
    '<label class="panel-checkbox"><input type="checkbox" id="bbox-hide-outside"> Hide outside blocks</label>',
    '<div class="field-grid">',
    '<label>Origin X<input id="bbox-origin-x" type="number" step="1"></label>',
    '<label>Size X<input id="bbox-size-x" type="number" min="1" step="1"></label>',
    '<label>Origin Y<input id="bbox-origin-y" type="number" step="1"></label>',
    '<label>Size Y<input id="bbox-size-y" type="number" min="1" step="1"></label>',
    '<label>Origin Z<input id="bbox-origin-z" type="number" step="1"></label>',
    '<label>Size Z<input id="bbox-size-z" type="number" min="1" step="1"></label>',
    '</div>',
    '<div class="panel-actions">',
    '<button id="bbox-reset-origin">Reset Origin</button>',
    '<button id="bbox-reset-cube">Reset 64^3</button>',
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
      if (!window.__captureScreenshot) { setStatus('Capture API not ready'); return }
      try {
        var forceSquare = document.getElementById('gbuffer-square').checked
        var renderSize = Number(document.getElementById('gbuffer-size').value) || 512
        renderSize = Math.max(64, Math.min(4096, Math.round(renderSize)))
        var shot = window.__captureScreenshot({ square: forceSquare, size: renderSize })

        var dataUrl = shot.dataUrl
        var anchor = document.createElement('a')
        anchor.href = dataUrl
        anchor.download = 'screenshot.png'
        document.body.appendChild(anchor)
        anchor.click()
        document.body.removeChild(anchor)
        setStatus('Screenshot saved (' + shot.width + 'x' + shot.height + ', transparent bg).')
      } catch (error) {
        setStatus('Screenshot failed: ' + error.message)
      }
    })

    document.getElementById('btn-export').addEventListener('click', function () {
      var formatSelect = document.getElementById('export-format')
      var format = formatSelect ? formatSelect.value : 'obj'
      if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
      try {
        if (format === 'obj') {
          var result = new THREE.OBJExporter().parse(window._pw_scene)
          downloadBlob(new Blob([result], { type: 'text/plain' }), 'model.obj')
          setStatus('OBJ downloaded.')
          return
        }

        if (format === 'stl') {
          var stl = new THREE.STLExporter().parse(window._pw_scene, { binary: true })
          var buffer = stl instanceof ArrayBuffer ? stl : stl.buffer || stl
          downloadBlob(new Blob([buffer], { type: 'application/octet-stream' }), 'model.stl')
          setStatus('STL downloaded.')
          return
        }

        if (format === 'glb') {
          new THREE.GLTFExporter().parse(window._pw_scene, function (glb) {
            var buffer = glb instanceof ArrayBuffer ? glb : glb.buffer || glb
            downloadBlob(new Blob([buffer], { type: 'model/gltf-binary' }), 'model.glb')
            setStatus('GLB downloaded.')
          }, { binary: true })
          return
        }
      } catch (error) {
        setStatus('Error: ' + error.message)
      }
    })

    // --- Depth / Segmentation capture buttons ---

    var cachedMcMappings = null

    function loadMcMappings () {
      if (cachedMcMappings) return Promise.resolve(cachedMcMappings)
      return fetch('/generated/mc_mappings.json')
        .then(function (res) { return res.text() })
        .then(function (text) {
          // mc_mappings.json may have comments, strip all single-line comments
          var cleaned = text.replace(/^\s*\/\/.*$/gm, '')
          cachedMcMappings = JSON.parse(cleaned)
          return cachedMcMappings
        })
    }

    /**
     * Normalize mc_mappings keys to match minecraft block names.
     * mc_mappings uses keys like "Acacia_Door" or "Furnace__Blast_Furnace"
     * Block names from prismarine are like "acacia_door" or "blast_furnace"
     * Build a blockName → color map considering both the primary key and sub-keys.
     */
    function buildColorMapFromMappings (mappings) {
      var colorMap = {}
      for (var key in mappings) {
        if (!Object.prototype.hasOwnProperty.call(mappings, key)) continue
        var entry = mappings[key]
        var color = entry.color
        if (!color) continue

        // Handle compound keys like "Furnace__Blast_Furnace"
        var parts = key.split('__')
        for (var i = 0; i < parts.length; i++) {
          var normalized = parts[i].toLowerCase()
          if (!colorMap[normalized]) {
            colorMap[normalized] = color
          }
        }
      }

      // Extra aliases from encountered block names in renderer map:
      // uppercase/lowercase and hyphen/underscore tolerance
      var aliases = {}
      for (var n in colorMap) {
        if (!Object.prototype.hasOwnProperty.call(colorMap, n)) continue
        aliases[n.replace(/-/g, '_')] = colorMap[n]
        aliases[n.replace(/_/g, '-') ] = colorMap[n]
      }
      for (var a in aliases) {
        if (!Object.prototype.hasOwnProperty.call(aliases, a)) continue
        if (!colorMap[a]) colorMap[a] = aliases[a]
      }

      return colorMap
    }

    function updateGBufferGuide () {
      var showGuide = document.getElementById('gbuffer-show-guide')
      var forceSquare = document.getElementById('gbuffer-square')
      if (!showGuide || !forceSquare) return

      var shouldShow = showGuide.checked && forceSquare.checked
      if (!shouldShow) {
        if (gbufferGuideElement && gbufferGuideElement.parentNode) {
          gbufferGuideElement.parentNode.removeChild(gbufferGuideElement)
        }
        gbufferGuideElement = null
        return
      }

      if (!gbufferGuideElement) {
        gbufferGuideElement = document.createElement('div')
        gbufferGuideElement.style.position = 'fixed'
        gbufferGuideElement.style.left = '50%'
        gbufferGuideElement.style.top = '50%'
        gbufferGuideElement.style.transform = 'translate(-50%, -50%)'
        gbufferGuideElement.style.border = '2px dashed rgba(255,255,255,0.8)'
        gbufferGuideElement.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.25)'
        gbufferGuideElement.style.pointerEvents = 'none'
        gbufferGuideElement.style.zIndex = '999'
        document.body.appendChild(gbufferGuideElement)
      }

      var side = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.85)
      gbufferGuideElement.style.width = side + 'px'
      gbufferGuideElement.style.height = side + 'px'
    }

    document.getElementById('btn-render-gbuffer').addEventListener('click', function () {
      if (!window.__captureGBuffer) { setStatus('Capture API not ready'); return }
      var useColorSeg = document.getElementById('gbuffer-use-color-seg').checked
      var segMode = useColorSeg ? 'color' : 'id'

      setStatus('Rendering gbuffer...')

      var run = function (colorMap) {
        try {
          var forceSquare = document.getElementById('gbuffer-square').checked
          var renderSize = Number(document.getElementById('gbuffer-size').value) || 512
          renderSize = Math.max(64, Math.min(4096, Math.round(renderSize)))
          var result = window.__captureGBuffer({
            segMode: segMode,
            colorMap: colorMap || {},
            square: forceSquare,
            size: renderSize
          })
          downloadBlob(result.blob, 'gbuffer.bin')
          setStatus('gbuffer.bin saved (' + segMode + ', ' + (forceSquare ? (renderSize + 'x' + renderSize) : 'canvas size') + ').')
        } catch (error) {
          setStatus('GBuffer render failed: ' + error.message)
        }
      }

      if (!useColorSeg) {
        run({})
        return
      }

      loadMcMappings().then(function (mappings) {
        run(buildColorMapFromMappings(mappings))
      }).catch(function (error) {
        setStatus('Failed to load mc_mappings: ' + error.message)
      })
    })

    ;['gbuffer-square', 'gbuffer-show-guide'].forEach(function (id) {
      var elem = document.getElementById(id)
      if (!elem) return
      elem.addEventListener('change', updateGBufferGuide)
    })
    window.addEventListener('resize', updateGBufferGuide)
    updateGBufferGuide()
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
  var gbufferGuideElement = null
  var errorBlocksMesh = null
  var BOUNDING_BOX_RENDER_PADDING = 0.03
  var socket = null
  var bboxFilterEmitTimer = null

  function disposeErrorBlocksMesh () {
    if (!errorBlocksMesh) return
    if (errorBlocksMesh.parent) errorBlocksMesh.parent.remove(errorBlocksMesh)
    if (errorBlocksMesh.geometry) errorBlocksMesh.geometry.dispose()
    if (errorBlocksMesh.material) errorBlocksMesh.material.dispose()
    errorBlocksMesh = null
  }

  function applyBoundingBoxClipping () {
    if (window._pw_renderer) window._pw_renderer.localClippingEnabled = false
    if (window._pw_worldMaterial) {
      window._pw_worldMaterial.clippingPlanes = null
      window._pw_worldMaterial.clipIntersection = false
      window._pw_worldMaterial.needsUpdate = true
    }
    if (errorBlocksMesh && errorBlocksMesh.material) {
      errorBlocksMesh.material.clippingPlanes = null
      errorBlocksMesh.material.clipIntersection = false
      errorBlocksMesh.material.needsUpdate = true
    }
  }

  function scheduleBoundingBoxFilterUpdate () {
    if (!socket || !currentBoundingBox) return
    clearTimeout(bboxFilterEmitTimer)
    bboxFilterEmitTimer = setTimeout(function () {
      socket.emit('bboxFilter', {
        enabled: currentBoundingBox.hideOutside === true,
        origin: currentBoundingBox.origin,
        size: currentBoundingBox.size
      })
    }, 80)
  }

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
      enabled: config.enabled !== false,
      hideOutside: config.hideOutside === true
    }
  }

  function isPositionInsideBoundingBox (position, boundingBox) {
    if (!position || !boundingBox || !boundingBox.origin || !boundingBox.size) return true
    return (
      position.x >= boundingBox.origin.x && position.x < boundingBox.origin.x + boundingBox.size.x &&
      position.y >= boundingBox.origin.y && position.y < boundingBox.origin.y + boundingBox.size.y &&
      position.z >= boundingBox.origin.z && position.z < boundingBox.origin.z + boundingBox.size.z
    )
  }

  function filterErrorPositionsByBoundingBox (positions, boundingBox) {
    if (!Array.isArray(positions)) return []
    if (!boundingBox || boundingBox.hideOutside !== true) return positions
    return positions.filter(function (position) {
      return isPositionInsideBoundingBox(position, boundingBox)
    })
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

  function syncBoundingBoxControls () {
    if (!currentBoundingBox) return
    var enabled = document.getElementById('bbox-enabled')
    if (enabled) enabled.checked = currentBoundingBox.enabled !== false
    var hideOutside = document.getElementById('bbox-hide-outside')
    if (hideOutside) hideOutside.checked = currentBoundingBox.hideOutside === true

    setInputValue('bbox-origin-x', currentBoundingBox.relativeOrigin.x)
    setInputValue('bbox-origin-y', currentBoundingBox.relativeOrigin.y)
    setInputValue('bbox-origin-z', currentBoundingBox.relativeOrigin.z)
    setInputValue('bbox-size-x', currentBoundingBox.size.x)
    setInputValue('bbox-size-y', currentBoundingBox.size.y)
    setInputValue('bbox-size-z', currentBoundingBox.size.z)
  }

  function updateBoundingBoxFromControls () {
    if (!currentBoundingBox) return

    currentBoundingBox.enabled = document.getElementById('bbox-enabled').checked
    currentBoundingBox.hideOutside = document.getElementById('bbox-hide-outside').checked
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
    applyBoundingBoxClipping()
    scheduleBoundingBoxFilterUpdate()
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
      'bbox-enabled',
      'bbox-hide-outside'
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
      currentBoundingBox.hideOutside = false
      syncBoundingBoxControls()
      updateBoundingBoxFromControls()
      setStatus('Bounding box reset to 64x64x64 at 0,0,0.')
    })

    document.getElementById('bbox-reset-origin').addEventListener('click', function () {
      if (!currentBoundingBox) return
      currentBoundingBox.relativeOrigin = { x: 0, y: 0, z: 0 }
      currentBoundingBox.origin = {
        x: currentBoundingBox.structureOrigin.x + currentBoundingBox.relativeOrigin.x,
        y: currentBoundingBox.structureOrigin.y + currentBoundingBox.relativeOrigin.y,
        z: currentBoundingBox.structureOrigin.z + currentBoundingBox.relativeOrigin.z
      }
      syncBoundingBoxControls()
      updateBoundingBoxFromControls()
      setStatus('Bounding box origin reset to 0,0,0.')
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
    var checkbox = document.getElementById('axis-visible')
    if (!checkbox) return
    checkbox.checked = !!axisVisible
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

    var padding = BOUNDING_BOX_RENDER_PADDING
    var size = config.size
    var center = {
      x: config.origin.x + (size.x / 2),
      y: config.origin.y + (size.y / 2),
      z: config.origin.z + (size.z / 2)
    }
    var expandedSize = {
      x: size.x + (padding * 2),
      y: size.y + (padding * 2),
      z: size.z + (padding * 2)
    }

    var group = new THREE.Group()
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

    var geometry = new THREE.EdgesGeometry(new THREE.BoxGeometry(expandedSize.x, expandedSize.y, expandedSize.z))
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
    var checkbox = document.getElementById('axis-visible')
    if (!checkbox) return
    checkbox.addEventListener('change', function () {
      axisVisible = !!checkbox.checked
      if (axisGroup) axisGroup.visible = axisVisible
    })
    updateAxisButtonLabel()
  }

  function injectErrorBlocks (scene, positions) {
    disposeErrorBlocksMesh()

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
    errorBlocksMesh = mesh
    applyBoundingBoxClipping()
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

    socket = io()
    socket.on('errorBlocks', function (positions) {
      var nextPositions = filterErrorPositionsByBoundingBox(positions, currentBoundingBox)
      if (!nextPositions || !nextPositions.length) {
        pendingErrorBlocks = null
        disposeErrorBlocksMesh()
        return
      }

      if (window._pw_scene) {
        injectErrorBlocks(window._pw_scene, nextPositions)
        pendingErrorBlocks = null
        return
      }

      pendingErrorBlocks = nextPositions
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
      applyBoundingBoxClipping()
      scheduleBoundingBoxFilterUpdate()
      pendingBoundingBox = nextConfig
      if (window._pw_scene) renderBoundingBox(window._pw_scene, nextConfig)
    })
  }

  bindAxisToggle()
  bindExportButtons()
  bindBoundingBoxControls()
  bindErrorBlockOverlay()
})()
