global.THREE = require('three')
require('three/examples/js/controls/OrbitControls')

const THREE = global.THREE
const { buildPixal3DMetadata } = require('../../shared/pixal3d-metadata')

const state = {
  mesh: null,
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  model: null,
  bounds: null,
  squareGuide: null
}

function setStatus (message) {
  const element = document.getElementById('obj-status')
  if (element) element.textContent = message || ''
}

function setStats (message) {
  const element = document.getElementById('obj-stats')
  if (element) element.textContent = message || ''
}

function downloadBlob (blob, filename) {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  setTimeout(function () {
    URL.revokeObjectURL(url)
    if (anchor.parentNode) anchor.parentNode.removeChild(anchor)
  }, 1000)
}

function downloadJson (payload, filename) {
  downloadBlob(new Blob([JSON.stringify(payload || {}, null, 2)], { type: 'application/json' }), filename)
}

function dataUrlToBlob (dataUrl) {
  const parts = String(dataUrl || '').split(',')
  if (parts.length < 2) throw new Error('Invalid capture data URL.')
  const header = parts[0]
  const payload = parts.slice(1).join(',')
  const match = /^data:([^;,]+)?(;base64)?/i.exec(header)
  const mimeType = (match && match[1]) || 'application/octet-stream'
  const binary = match && match[2] ? atob(payload) : decodeURIComponent(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mimeType })
}

function pixelsToDataUrl (pixels, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowBytes
    const dstRow = y * rowBytes
    imageData.data.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow)
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

function clampCaptureSize (value) {
  const number = Number(value)
  const fallback = 1024
  const finite = Number.isFinite(number) ? number : fallback
  return Math.max(64, Math.min(4096, Math.round(finite)))
}

function withTemporaryCameraAspect (camera, aspect, fn) {
  const original = camera.aspect
  if (Math.abs(original - aspect) < 1e-8) return fn()
  camera.aspect = aspect
  camera.updateProjectionMatrix()
  try {
    return fn()
  } finally {
    camera.aspect = original
    camera.updateProjectionMatrix()
  }
}

function buildPixal3DExportContext () {
  const bounds = state.mesh && state.mesh.bounds
  const min = bounds && Array.isArray(bounds.min) ? bounds.min : [0, 0, 0]
  const max = bounds && Array.isArray(bounds.max) ? bounds.max : [1, 1, 1]
  const size = [
    Math.max(1, max[0] - min[0]),
    Math.max(1, max[1] - min[1]),
    Math.max(1, max[2] - min[2])
  ]
  const pivotWorld = [
    min[0] + size[0] / 2,
    min[1] + size[1] / 2,
    min[2] + size[2] / 2
  ]

  return {
    asset: state.mesh && state.mesh.source && state.mesh.source.obj
      ? state.mesh.source.obj.path
      : null,
    source: {
      coordinateSpace: 'minecraft_unified_blocks',
      blockPoint: 'center',
      originWorld: { x: min[0], y: min[1], z: min[2] },
      size: { x: size[0], y: size[1], z: size[2] },
      pivotWorld: { x: pivotWorld[0], y: pivotWorld[1], z: pivotWorld[2] }
    }
  }
}

function captureScreenshot (options) {
  const opts = options || {}
  const size = clampCaptureSize(opts.size)
  const renderer = state.renderer
  const scene = state.scene
  const camera = state.camera
  const target = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false
  })
  const pixels = new Uint8Array(size * size * 4)

  const captured = withTemporaryCameraAspect(camera, 1, function () {
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, size, size, pixels)
    renderer.setRenderTarget(null)
    return {
      dataUrl: pixelsToDataUrl(pixels, size, size),
      pixal3d: buildPixal3DMetadata(THREE, camera, buildPixal3DExportContext(), size, size, opts)
    }
  })

  target.dispose()
  return {
    dataUrl: captured.dataUrl,
    width: size,
    height: size,
    square: true,
    pixal3d: captured.pixal3d
  }
}

window.__captureScreenshot = captureScreenshot

async function fetchJson (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function fetchArrayBuffer (url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.arrayBuffer()
}

function makeMaterialKey (material) {
  return material.mapKdUrl || material.mapDUrl || '__flat__'
}

async function loadTexture (url) {
  if (!url) return null
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(url, (texture) => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestMipMapNearestFilter
      texture.generateMipmaps = true
      resolve(texture)
    }, undefined, reject)
  })
}

async function buildMaterials (mesh) {
  const textureCache = new Map()
  const materials = []

  for (const source of mesh.materials) {
    const key = makeMaterialKey(source)
    let texture = textureCache.get(key)
    if (texture === undefined) {
      texture = key === '__flat__' ? null : await loadTexture(key)
      textureCache.set(key, texture)
    }

    materials.push(new THREE.MeshLambertMaterial({
      name: source.name,
      map: texture,
      color: new THREE.Color(
        Number(source.diffuse && source.diffuse[0]) || 1,
        Number(source.diffuse && source.diffuse[1]) || 1,
        Number(source.diffuse && source.diffuse[2]) || 1
      ),
      alphaTest: texture ? 0.08 : 0,
      transparent: Number(source.opacity) < 1,
      opacity: Number.isFinite(Number(source.opacity)) ? Number(source.opacity) : 1,
      side: THREE.FrontSide
    }))
  }

  return materials
}

function buildGeometry (mesh, buffers) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buffers.positions), 3))
  geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(buffers.normals), 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buffers.uvs), 2))
  geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(buffers.indices), 1))
  geometry.clearGroups()
  for (const group of mesh.groups) {
    geometry.addGroup(group.start, group.count, group.materialIndex)
  }
  geometry.computeBoundingSphere()
  return geometry
}

function makeBounds (bounds) {
  const min = bounds && Array.isArray(bounds.min) ? bounds.min : [0, 0, 0]
  const max = bounds && Array.isArray(bounds.max) ? bounds.max : [1, 1, 1]
  return new THREE.Box3(
    new THREE.Vector3(min[0], min[1], min[2]),
    new THREE.Vector3(max[0], max[1], max[2])
  )
}

function resetCamera () {
  if (!state.bounds || !state.camera || !state.controls) return
  const center = state.bounds.getCenter(new THREE.Vector3())
  const size = state.bounds.getSize(new THREE.Vector3())
  const radius = Math.max(size.x, size.y, size.z, 1)
  const distance = radius * 1.25
  state.controls.target.copy(center)
  state.camera.near = Math.max(0.01, distance / 10000)
  state.camera.far = Math.max(1000, distance * 20)
  state.camera.position.set(
    center.x + distance,
    center.y + distance * 0.65,
    center.z + distance
  )
  state.camera.updateProjectionMatrix()
  state.controls.update()
}

function initRenderer () {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
  renderer.setPixelRatio(window.devicePixelRatio || 1)
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setClearColor(0xbfd7ff, 1)
  document.body.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0xbfd7ff)
  scene.add(new THREE.AmbientLight(0xffffff, 0.72))
  const directional = new THREE.DirectionalLight(0xffffff, 0.72)
  directional.position.set(0.8, 1, 0.4).normalize()
  scene.add(directional)

  const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 10000)
  const controls = new THREE.OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08

  state.renderer = renderer
  state.scene = scene
  state.camera = camera
  state.controls = controls
  window._pw_renderer = renderer
  window._pw_scene = scene

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / Math.max(window.innerHeight, 1)
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    updateSquareGuide()
  })
}

function animate () {
  window.requestAnimationFrame(animate)
  if (state.controls) state.controls.update()
  if (state.renderer && state.scene && state.camera) {
    state.renderer.render(state.scene, state.camera)
  }
}

async function loadMesh () {
  setStatus('Loading mesh metadata...')
  const mesh = await fetchJson('/api/mesh')
  state.mesh = mesh

  setStats([
    `${mesh.counts.vertexCount.toLocaleString()} vertices`,
    `${mesh.counts.triangleCount.toLocaleString()} triangles`,
    `${mesh.materials.length.toLocaleString()} materials`
  ].join('\n'))

  setStatus('Loading mesh buffers...')
  const buffers = {
    positions: await fetchArrayBuffer(mesh.buffers.positions),
    normals: await fetchArrayBuffer(mesh.buffers.normals),
    uvs: await fetchArrayBuffer(mesh.buffers.uvs),
    indices: await fetchArrayBuffer(mesh.buffers.indices)
  }

  setStatus('Preparing materials...')
  const materials = await buildMaterials(mesh)
  const geometry = buildGeometry(mesh, buffers)
  const model = new THREE.Mesh(geometry, materials)
  model.frustumCulled = false
  state.model = model
  state.bounds = makeBounds(mesh.bounds)
  state.scene.add(model)
  resetCamera()
  setStatus('Mesh ready.')

  const screenshotButton = document.getElementById('btn-screenshot')
  if (screenshotButton) screenshotButton.disabled = false
  const resetButton = document.getElementById('btn-reset-camera')
  if (resetButton) resetButton.disabled = false
}

function bindControls () {
  const screenshotButton = document.getElementById('btn-screenshot')
  if (screenshotButton) {
    screenshotButton.addEventListener('click', function () {
      try {
        const sizeInput = document.getElementById('capture-size')
        const shot = captureScreenshot({ size: sizeInput && sizeInput.value })
        downloadBlob(dataUrlToBlob(shot.dataUrl), 'screenshot.png')
        downloadJson(shot.pixal3d, 'screenshot.pixal3d.json')
        setStatus(`Screenshot saved (${shot.width}x${shot.height}).`)
      } catch (error) {
        setStatus(`Screenshot failed: ${error.message}`)
      }
    })
  }

  const resetButton = document.getElementById('btn-reset-camera')
  if (resetButton) {
    resetButton.addEventListener('click', function () {
      resetCamera()
      setStatus('Camera reset.')
    })
  }

  const guideToggle = document.getElementById('capture-show-guide')
  if (guideToggle) guideToggle.addEventListener('change', updateSquareGuide)
  updateSquareGuide()
}

function updateSquareGuide () {
  const toggle = document.getElementById('capture-show-guide')
  const shouldShow = !!(toggle && toggle.checked)
  if (!shouldShow) {
    if (state.squareGuide && state.squareGuide.parentNode) {
      state.squareGuide.parentNode.removeChild(state.squareGuide)
    }
    state.squareGuide = null
    return
  }

  if (!state.squareGuide) {
    const guide = document.createElement('div')
    guide.style.position = 'fixed'
    guide.style.left = '50%'
    guide.style.top = '50%'
    guide.style.transform = 'translate(-50%, -50%)'
    guide.style.border = '2px dashed rgba(255,255,255,0.8)'
    guide.style.boxShadow = '0 0 0 9999px rgba(0,0,0,0.25)'
    guide.style.pointerEvents = 'none'
    guide.style.zIndex = '999'
    document.body.appendChild(guide)
    state.squareGuide = guide
  }

  const side = Math.floor(Math.min(window.innerWidth, window.innerHeight) * 0.85)
  state.squareGuide.style.width = `${side}px`
  state.squareGuide.style.height = `${side}px`
}

initRenderer()
bindControls()
animate()
loadMesh().catch((error) => {
  setStatus(`Failed to load mesh: ${error.message}`)
  console.error(error)
})
