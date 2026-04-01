global.THREE = require('three')
require('three/examples/js/controls/OrbitControls')

const THREE = global.THREE
const { Vec3 } = require('vec3')
const { WorldRenderer } = require('../../../../prismarine-viewer-lib/worldrenderer')
const { getVersion } = require('../../../../prismarine-viewer-lib/version')

class MinimalViewer {
  constructor (renderer) {
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('lightblue')

    this.ambientLight = new THREE.AmbientLight(0xcccccc)
    this.scene.add(this.ambientLight)

    this.directionalLight = new THREE.DirectionalLight(0xffffff, 0.5)
    this.directionalLight.position.set(1, 1, 0.5).normalize()
    this.directionalLight.castShadow = true
    this.scene.add(this.directionalLight)

    const size = renderer.getSize(new THREE.Vector2())
    this.camera = new THREE.PerspectiveCamera(75, size.x / size.y, 0.1, 1000)
    this.world = new WorldRenderer(this.scene)
  }

  setVersion (version) {
    const resolved = getVersion(version)
    if (resolved === null) {
      const msg = `${version} is not supported`
      window.alert(msg)
      console.log(msg)
      return false
    }

    this.version = resolved
    this.world.setVersion(resolved)
    return true
  }

  addColumn (x, z, chunk) {
    this.world.addColumn(x, z, chunk)
  }

  removeColumn (x, z) {
    this.world.removeColumn(x, z)
  }

  setBlockStateId (pos, stateId) {
    this.world.setBlockStateId(pos, stateId)
  }
}

const renderer = new THREE.WebGLRenderer()
renderer.localClippingEnabled = true
renderer.setPixelRatio(window.devicePixelRatio || 1)
renderer.setSize(window.innerWidth, window.innerHeight)
document.body.appendChild(renderer.domElement)

const viewer = new MinimalViewer(renderer)
window._pw_renderer = renderer
window._pw_viewer = viewer
window._pw_worldMaterial = viewer.world.material
window._pw_worldRenderer = viewer.world
const controls = new THREE.OrbitControls(viewer.camera, renderer.domElement)
const socket = window.io()

let firstPositionUpdate = true

function applyCameraPosition (pos) {
  if (pos.y > 0 && firstPositionUpdate) {
    controls.target.set(pos.x, pos.y, pos.z)
    viewer.camera.position.set(pos.x, pos.y + 20, pos.z + 20)
    controls.update()
    firstPositionUpdate = false
  }
}

function animate () {
  window.requestAnimationFrame(animate)
  controls.update()
  renderer.render(viewer.scene, viewer.camera)
}

animate()

window.addEventListener('resize', () => {
  viewer.camera.aspect = window.innerWidth / window.innerHeight
  viewer.camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
})

socket.on('version', (version) => {
  if (!viewer.setVersion(version)) return
  firstPositionUpdate = true
})

socket.on('loadChunk', ({ x, z, chunk }) => {
  viewer.addColumn(x, z, chunk)
})

socket.on('unloadChunk', ({ x, z }) => {
  viewer.removeColumn(x, z)
})

socket.on('blockUpdate', ({ pos, stateId }) => {
  viewer.setBlockStateId(new Vec3(pos.x, pos.y, pos.z), stateId)
})

socket.on('position', ({ pos }) => {
  if (!pos) return
  applyCameraPosition(pos)
})

// --- Capture API for depth / segmentation maps ---

/**
 * Convert raw RGBA pixel buffer (bottom-up from WebGL) to a top-down PNG data URL.
 */
function pixelsToDataUrl (pixels, width, height) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  const imageData = ctx.createImageData(width, height)

  // Flip rows (WebGL readPixels gives bottom-up)
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4
    const dstRow = y * width * 4
    for (let x = 0; x < width * 4; x++) {
      imageData.data[dstRow + x] = pixels[srcRow + x]
    }
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

function flipRgbaTopDown (pixels, width, height) {
  const out = new Uint8Array(pixels.length)
  const rowBytes = width * 4
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * rowBytes
    const dstRow = y * rowBytes
    out.set(pixels.subarray(srcRow, srcRow + rowBytes), dstRow)
  }
  return out
}

function float32ToFloat16Bits (val) {
  const floatView = new Float32Array(1)
  const intView = new Uint32Array(floatView.buffer)
  floatView[0] = val
  const x = intView[0]

  const sign = (x >> 31) & 0x1
  let exp = (x >> 23) & 0xff
  let mant = x & 0x7fffff

  if (exp === 0xff) {
    if (mant !== 0) return (sign << 15) | 0x7e00
    return (sign << 15) | 0x7c00
  }

  exp = exp - 127 + 15
  if (exp >= 0x1f) return (sign << 15) | 0x7c00
  if (exp <= 0) {
    if (exp < -10) return sign << 15
    mant = (mant | 0x800000) >> (1 - exp)
    if (mant & 0x00001000) mant += 0x00002000
    return (sign << 15) | (mant >> 13)
  }

  if (mant & 0x00001000) {
    mant += 0x00002000
    if (mant & 0x00800000) {
      mant = 0
      exp += 1
      if (exp >= 0x1f) return (sign << 15) | 0x7c00
    }
  }

  return (sign << 15) | (exp << 10) | (mant >> 13)
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

function resolveCaptureSize (options) {
  const opts = options || {}
  const square = opts.square !== false
  const size = Number(opts.size) || 512
  const clampedSize = Math.max(64, Math.min(4096, Math.round(size)))
  const w = square ? clampedSize : (opts.width || renderer.domElement.width)
  const h = square ? clampedSize : (opts.height || renderer.domElement.height)
  return { w, h, square, size: clampedSize }
}

/**
 * Capture depth map at current camera view.
 * Returns { dataUrl, near, far }
 */
window.__captureDepthMap = function (width, height) {
  const w = width || renderer.domElement.width
  const h = height || renderer.domElement.height
  const wr = viewer.world
  const pixels = wr.renderDepthMap(renderer, viewer.camera, w, h)
  return {
    dataUrl: pixelsToDataUrl(pixels, w, h),
    near: viewer.camera.near,
    far: viewer.camera.far,
    width: w,
    height: h
  }
}

window.__captureRgbMap = function (width, height) {
  const w = width || renderer.domElement.width
  const h = height || renderer.domElement.height
  const wr = viewer.world
  const pixels = wr.renderRgbMap(renderer, viewer.camera, w, h)
  return {
    dataUrl: pixelsToDataUrl(pixels, w, h),
    width: w,
    height: h
  }
}

// Screenshot uses the same capture path/size policy as gbuffer RGB channel.
window.__captureScreenshot = function (options) {
  const resolved = resolveCaptureSize(options)
  const wr = viewer.world
  const pixels = withTemporaryCameraAspect(viewer.camera, resolved.w / resolved.h, function () {
    return wr.renderRgbMap(renderer, viewer.camera, resolved.w, resolved.h)
  })
  return {
    dataUrl: pixelsToDataUrl(pixels, resolved.w, resolved.h),
    width: resolved.w,
    height: resolved.h,
    square: resolved.square
  }
}

/**
 * Capture segmentation map (stateId encoded as RGB).
 * Returns { dataUrl, stateIdToName, width, height }
 */
window.__captureSegmentationMap = function (width, height) {
  const w = width || renderer.domElement.width
  const h = height || renderer.domElement.height
  const wr = viewer.world
  const result = wr.renderSegmentationMap(renderer, viewer.camera, w, h)
  return {
    dataUrl: pixelsToDataUrl(result.pixels, w, h),
    stateIdToName: result.stateIdToName,
    width: w,
    height: h
  }
}

/**
 * Capture color-mapped segmentation map using mc_mappings colors.
 * colorMap: { blockName: '#rrggbb' } or { blockName: [r,g,b] } with 0-1 floats
 * Returns { dataUrl, width, height }
 */
window.__captureColorSegMap = function (colorMap, width, height) {
  const w = width || renderer.domElement.width
  const h = height || renderer.domElement.height
  const wr = viewer.world

  // Normalize colorMap: convert '#rrggbb' strings to [r, g, b] 0-1 floats
  const normalized = {}
  for (const [name, value] of Object.entries(colorMap)) {
    if (typeof value === 'string' && value.startsWith('#')) {
      const hex = value.replace('#', '')
      normalized[name] = [
        parseInt(hex.substring(0, 2), 16) / 255,
        parseInt(hex.substring(2, 4), 16) / 255,
        parseInt(hex.substring(4, 6), 16) / 255
      ]
    } else if (Array.isArray(value)) {
      normalized[name] = value
    }
  }

  const pixels = wr.renderColorSegMap(renderer, viewer.camera, w, h, normalized)
  return {
    dataUrl: pixelsToDataUrl(pixels, w, h),
    width: w,
    height: h
  }
}

// Build binary gbuffer payload (RGB + depth16 + seg + metadata JSON)
window.__captureGBuffer = function (options) {
  const opts = options || {}
  const segMode = opts.segMode === 'color' ? 'color' : 'id'
  const resolved = resolveCaptureSize(opts)
  const w = resolved.w
  const h = resolved.h

  const wr = viewer.world
  const captured = withTemporaryCameraAspect(viewer.camera, w / h, function () {
    const rgbPixelsRaw = wr.renderRgbMap(renderer, viewer.camera, w, h)
    const depthPixels = wr.renderDepthMap(renderer, viewer.camera, w, h) // R=hi,G=lo for uint16 reciprocal depth
    const maskPixelsRaw = wr.renderMaskMap(renderer, viewer.camera, w, h)

    let segPixels
    if (segMode === 'color') {
      const colorMap = opts.colorMap || {}
      const normalized = {}
      for (const [name, value] of Object.entries(colorMap)) {
        if (typeof value === 'string' && value.startsWith('#')) {
          const hex = value.replace('#', '')
          normalized[name] = [
            parseInt(hex.substring(0, 2), 16) / 255,
            parseInt(hex.substring(2, 4), 16) / 255,
            parseInt(hex.substring(4, 6), 16) / 255
          ]
        } else if (Array.isArray(value)) {
          normalized[name] = value
        }
      }
      segPixels = wr.renderColorSegMap(renderer, viewer.camera, w, h, normalized)
    } else {
      segPixels = wr.renderSegmentationMap(renderer, viewer.camera, w, h).pixels
    }
    return { rgbPixelsRaw, depthPixels, maskPixelsRaw, segPixels }
  })

  // Flip all RGBA buffers to top-down for easier downstream use
  const rgbPixels = flipRgbaTopDown(captured.rgbPixelsRaw, w, h)
  const segPixelsTopDown = flipRgbaTopDown(captured.segPixels, w, h)
  const maskPixels = flipRgbaTopDown(captured.maskPixelsRaw, w, h)
  const depthTopDown = flipRgbaTopDown(captured.depthPixels, w, h)

  // Decode packed uint16 reciprocal depth d, convert to metric z, then store as float16
  const depthF16 = new Uint16Array(w * h)
  const invNear = 1 / Math.max(viewer.camera.near, 1e-6)
  const invFar = 1 / Math.max(viewer.camera.far, 1e-6)
  for (let i = 0; i < w * h; i++) {
    const hi = depthTopDown[i * 4]
    const lo = depthTopDown[i * 4 + 1]
    const d = ((hi << 8) | lo) / 65535.0
    if (maskPixels[i * 4 + 3] === 0) {
      depthF16[i] = 0x7c00 // +Inf for background
    } else {
      const invZ = invFar + d * (invNear - invFar)
      const z = 1 / Math.max(invZ, 1e-6)
      depthF16[i] = float32ToFloat16Bits(z)
    }
  }

  // Binary mask (uint8): foreground if any fragment written (alpha > 0)
  const maskU8 = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    maskU8[i] = maskPixels[i * 4 + 3] > 0 ? 1 : 0
  }

  const metadata = {
    format: 'minecraft-gbuffer-v1',
    width: w,
    height: h,
    segMode,
    channels: {
      rgb: { type: 'uint8', components: 4, offsetBytes: 0 },
      depth: { type: 'float16', components: 1, offsetBytes: rgbPixels.byteLength, encoding: 'metric-depth-f16' },
      seg: { type: 'uint8', components: 4, offsetBytes: rgbPixels.byteLength + depthF16.byteLength },
      mask: { type: 'uint8', components: 1, offsetBytes: rgbPixels.byteLength + depthF16.byteLength + segPixelsTopDown.byteLength }
    },
    camera: {
      near: viewer.camera.near,
      far: viewer.camera.far,
      depthDecode: 'depth is metric z (float16, world units). background pixels are +Inf.'
    },
    alphaSemantics: 'RGBA alpha comes from texture/material transparency (0..255).',
    maskSemantics: 'mask=1 if any non-air fragment rendered at that pixel (opaque or translucent), else 0.',
    stateIdToName: wr.stateIdToName || {}
  }

  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata))
  const magic = new TextEncoder().encode('MCGBUF01')
  const header = new ArrayBuffer(16)
  const dv = new DataView(header)
  for (let i = 0; i < 8; i++) dv.setUint8(i, magic[i])
  dv.setUint32(8, 1, true) // version
  dv.setUint32(12, metaBytes.byteLength, true)

  const totalSize = header.byteLength + metaBytes.byteLength + rgbPixels.byteLength + depthF16.byteLength + segPixelsTopDown.byteLength + maskU8.byteLength
  const out = new Uint8Array(totalSize)
  let off = 0
  out.set(new Uint8Array(header), off); off += header.byteLength
  out.set(metaBytes, off); off += metaBytes.byteLength
  out.set(rgbPixels, off); off += rgbPixels.byteLength
  out.set(new Uint8Array(depthF16.buffer), off); off += depthF16.byteLength
  out.set(segPixelsTopDown, off); off += segPixelsTopDown.byteLength
  out.set(maskU8, off)

  return {
    blob: new Blob([out], { type: 'application/octet-stream' }),
    metadata
  }
}
