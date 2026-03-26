/* global Worker */
const THREE = require('three')
const Vec3 = require('vec3').Vec3
const { loadTexture, loadJSON } = require('./utils.web')
const { EventEmitter } = require('events')
const { dispose3 } = require('./dispose')

function mod (x, n) {
  return ((x % n) + n) % n
}

class WorldRenderer {
  constructor (scene, numWorkers = 4) {
    this.sectionMeshs = {}
    this.active = false
    this.version = undefined
    this.scene = scene
    this.loadedChunks = {}
    this.sectionsOutstanding = new Set()
    this.renderUpdateEmitter = new EventEmitter()
    this.blockStatesData = undefined
    this.texturesDataUrl = undefined

    // Accumulated stateId → block name mapping from all workers
    this.stateIdToName = {}

    this.material = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1 })

    // Segmentation material: encodes blockId (stateId) as RGB color per-vertex (no lighting)
    this.segmentationMaterial = new THREE.ShaderMaterial({
      vertexShader: [
        'attribute float blockId;',
        'varying vec3 vSegColor;',
        'void main() {',
        '  float id = blockId;',
        '  float r = mod(floor(id / 65536.0), 256.0) / 255.0;',
        '  float g = mod(floor(id / 256.0), 256.0) / 255.0;',
        '  float b = mod(id, 256.0) / 255.0;',
        '  vSegColor = vec3(r, g, b);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vSegColor;',
        'void main() {',
        '  gl_FragColor = vec4(vSegColor, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.DoubleSide
    })

    // Depth material: packs reciprocal depth into RG as uint16 (no lighting)
    this.depthMaterial = new THREE.ShaderMaterial({
      uniforms: {
        cameraNear: { value: 0.1 },
        cameraFar: { value: 1000.0 }
      },
      vertexShader: [
        'varying float vDepth;',
        'void main() {',
        '  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);',
        '  vDepth = -mvPos.z;',
        '  gl_Position = projectionMatrix * mvPos;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform float cameraNear;',
        'uniform float cameraFar;',
        'varying float vDepth;',
        'void main() {',
        '  float invNear = 1.0 / max(cameraNear, 1e-6);',
        '  float invFar = 1.0 / max(cameraFar, 1e-6);',
        '  float invZ = 1.0 / max(vDepth, 1e-6);',
        '  float d = (invZ - invFar) / max(invNear - invFar, 1e-6);',
        '  d = clamp(d, 0.0, 1.0);',
        '  float packed = floor(d * 65535.0 + 0.5);',
        '  float hi = floor(packed / 256.0);',
        '  float lo = mod(packed, 256.0);',
        '  gl_FragColor = vec4(hi / 255.0, lo / 255.0, 0.0, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.DoubleSide
    })

    // RGB material for gbuffer capture (texture + vertex color, no lighting)
    this.rgbMaterial = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, alphaTest: 0.1 })

    // Mask material for foreground occupancy (uses texture alpha test)
    this.maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, alphaTest: 0.1 })

    // Color-mapped segmentation material: uses per-vertex color attribute set from mc_mappings
    this.colorSegMaterial = new THREE.ShaderMaterial({
      vertexShader: [
        'attribute vec3 segColor;',
        'varying vec3 vSegColor;',
        'void main() {',
        '  vSegColor = segColor;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'varying vec3 vSegColor;',
        'void main() {',
        '  gl_FragColor = vec4(vSegColor, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.DoubleSide
    })

    this.workers = []
    for (let i = 0; i < numWorkers; i++) {
      // Node environement needs an absolute path, but browser needs the url of the file
      let src = __dirname
      if (typeof window !== 'undefined') src = 'worker.js'
      else src += '/worker.js'

      const worker = new Worker(src)
      worker.onmessage = ({ data }) => {
        if (data.type === 'geometry') {
          let mesh = this.sectionMeshs[data.key]
          if (mesh) {
            this.scene.remove(mesh)
            dispose3(mesh)
            delete this.sectionMeshs[data.key]
          }

          const chunkCoords = data.key.split(',')
          if (!this.loadedChunks[chunkCoords[0] + ',' + chunkCoords[2]]) return

          // Merge stateIdToName from worker
          if (data.geometry.stateIdToName) {
            Object.assign(this.stateIdToName, data.geometry.stateIdToName)
          }

          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(data.geometry.positions, 3))
          geometry.setAttribute('normal', new THREE.BufferAttribute(data.geometry.normals, 3))
          geometry.setAttribute('color', new THREE.BufferAttribute(data.geometry.colors, 3))
          geometry.setAttribute('uv', new THREE.BufferAttribute(data.geometry.uvs, 2))
          geometry.setAttribute('blockId', new THREE.BufferAttribute(data.geometry.blockIds, 1))
          geometry.setIndex(data.geometry.indices)

          mesh = new THREE.Mesh(geometry, this.material)
          mesh.position.set(data.geometry.sx, data.geometry.sy, data.geometry.sz)
          this.sectionMeshs[data.key] = mesh
          this.scene.add(mesh)
        } else if (data.type === 'sectionFinished') {
          this.sectionsOutstanding.delete(data.key)
          this.renderUpdateEmitter.emit('update')
        }
      }
      if (worker.on) worker.on('message', (data) => { worker.onmessage({ data }) })
      this.workers.push(worker)
    }
  }

  resetWorld () {
    this.active = false
    for (const mesh of Object.values(this.sectionMeshs)) {
      this.scene.remove(mesh)
    }
    this.sectionMeshs = {}
    this.stateIdToName = {}
    for (const worker of this.workers) {
      worker.postMessage({ type: 'reset' })
    }
  }

  setVersion (version) {
    this.version = version
    this.resetWorld()
    this.active = true
    for (const worker of this.workers) {
      worker.postMessage({ type: 'version', version })
    }

    this.updateTexturesData()
  }

  updateTexturesData () {
    loadTexture(this.texturesDataUrl || `textures/${this.version}.png`, texture => {
      texture.magFilter = THREE.NearestFilter
      texture.minFilter = THREE.NearestFilter
      texture.flipY = false
      this.material.map = texture
      this.rgbMaterial.map = texture
      this.maskMaterial.map = texture
    })

    const loadBlockStates = () => {
      return new Promise(resolve => {
        if (this.blockStatesData) return resolve(this.blockStatesData)
        return loadJSON(`blocksStates/${this.version}.json`, resolve)
      })
    }
    loadBlockStates().then((blockStates) => {
      for (const worker of this.workers) {
        worker.postMessage({ type: 'blockStates', json: blockStates })
      }
    })
  }

  addColumn (x, z, chunk) {
    this.loadedChunks[`${x},${z}`] = true
    for (const worker of this.workers) {
      worker.postMessage({ type: 'chunk', x, z, chunk })
    }
    for (let y = 0; y < 256; y += 16) {
      const loc = new Vec3(x, y, z)
      this.setSectionDirty(loc)
      this.setSectionDirty(loc.offset(-16, 0, 0))
      this.setSectionDirty(loc.offset(16, 0, 0))
      this.setSectionDirty(loc.offset(0, 0, -16))
      this.setSectionDirty(loc.offset(0, 0, 16))
    }
  }

  removeColumn (x, z) {
    delete this.loadedChunks[`${x},${z}`]
    for (const worker of this.workers) {
      worker.postMessage({ type: 'unloadChunk', x, z })
    }
    for (let y = 0; y < 256; y += 16) {
      this.setSectionDirty(new Vec3(x, y, z), false)
      const key = `${x},${y},${z}`
      const mesh = this.sectionMeshs[key]
      if (mesh) {
        this.scene.remove(mesh)
        dispose3(mesh)
      }
      delete this.sectionMeshs[key]
    }
  }

  setBlockStateId (pos, stateId) {
    for (const worker of this.workers) {
      worker.postMessage({ type: 'blockUpdate', pos, stateId })
    }
    this.setSectionDirty(pos)
    if ((pos.x & 15) === 0) this.setSectionDirty(pos.offset(-16, 0, 0))
    if ((pos.x & 15) === 15) this.setSectionDirty(pos.offset(16, 0, 0))
    if ((pos.y & 15) === 0) this.setSectionDirty(pos.offset(0, -16, 0))
    if ((pos.y & 15) === 15) this.setSectionDirty(pos.offset(0, 16, 0))
    if ((pos.z & 15) === 0) this.setSectionDirty(pos.offset(0, 0, -16))
    if ((pos.z & 15) === 15) this.setSectionDirty(pos.offset(0, 0, 16))
  }

  setSectionDirty (pos, value = true) {
    // Dispatch sections to workers based on position
    // This guarantees uniformity accross workers and that a given section
    // is always dispatched to the same worker
    const hash = mod(Math.floor(pos.x / 16) + Math.floor(pos.y / 16) + Math.floor(pos.z / 16), this.workers.length)
    this.workers[hash].postMessage({ type: 'dirty', x: pos.x, y: pos.y, z: pos.z, value })
    this.sectionsOutstanding.add(`${Math.floor(pos.x / 16) * 16},${Math.floor(pos.y / 16) * 16},${Math.floor(pos.z / 16) * 16}`)
  }

  /**
   * Swap all section meshes to a given material, render, then restore.
   * Returns an RGBA Uint8Array of the rendered pixels.
   */
  renderPass (renderer, camera, material, width, height, options = {}) {
    const clearColor = options.clearColor !== undefined ? options.clearColor : 0x000000
    const clearAlpha = options.clearAlpha !== undefined ? options.clearAlpha : 1
    const backgroundColor = Object.prototype.hasOwnProperty.call(options, 'backgroundColor') ? options.backgroundColor : clearColor

    const rt = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType
    })

    // Save originals and hide non-block objects (axes, bounding box, lights, etc.)
    const origBackground = this.scene.background
    const prevClearColor = renderer.getClearColor(new THREE.Color())
    const prevClearAlpha = renderer.getClearAlpha()
    const origMaterials = {}
    const sectionMeshSet = new Set(Object.values(this.sectionMeshs))
    const hiddenChildren = []

    for (const child of this.scene.children) {
      if (!sectionMeshSet.has(child) && child.visible) {
        child.visible = false
        hiddenChildren.push(child)
      }
    }

    for (const [key, mesh] of Object.entries(this.sectionMeshs)) {
      origMaterials[key] = mesh.material
      mesh.material = material
    }
    this.scene.background = backgroundColor === null ? null : new THREE.Color(backgroundColor)

    renderer.setClearColor(clearColor, clearAlpha)

    renderer.setRenderTarget(rt)
    renderer.clear()
    renderer.render(this.scene, camera)
    renderer.setRenderTarget(null)

    const pixels = new Uint8Array(width * height * 4)
    renderer.readRenderTargetPixels(rt, 0, 0, width, height, pixels)

    // Restore originals
    for (const [key, mesh] of Object.entries(this.sectionMeshs)) {
      if (origMaterials[key]) mesh.material = origMaterials[key]
    }
    for (const child of hiddenChildren) {
      child.visible = true
    }
    this.scene.background = origBackground
    renderer.setClearColor(prevClearColor, prevClearAlpha)

    rt.dispose()
    return pixels
  }

  /**
   * Render a depth map. Returns RGBA Uint8Array (grayscale in RGB channels).
   */
  renderDepthMap (renderer, camera, width, height) {
    this.depthMaterial.uniforms.cameraNear.value = camera.near
    this.depthMaterial.uniforms.cameraFar.value = camera.far
    return this.renderPass(renderer, camera, this.depthMaterial, width, height, {
      clearColor: 0x000000,
      clearAlpha: 0,
      backgroundColor: null
    })
  }

  renderRgbMap (renderer, camera, width, height) {
    return this.renderPass(renderer, camera, this.rgbMaterial, width, height, {
      clearColor: 0x000000,
      clearAlpha: 0,
      backgroundColor: null
    })
  }

  renderMaskMap (renderer, camera, width, height) {
    return this.renderPass(renderer, camera, this.maskMaterial, width, height, {
      clearColor: 0x000000,
      clearAlpha: 0,
      backgroundColor: null
    })
  }

  /**
   * Render a segmentation map with stateId encoded as RGB.
   * Returns { pixels: Uint8Array, stateIdToName: object }
   */
  renderSegmentationMap (renderer, camera, width, height) {
    const pixels = this.renderPass(renderer, camera, this.segmentationMaterial, width, height, {
      clearColor: 0x000000,
      clearAlpha: 0,
      backgroundColor: null
    })
    return { pixels, stateIdToName: { ...this.stateIdToName } }
  }

  /**
   * Render a color-mapped segmentation map using mc_mappings colors.
   * colorMap: { blockName: [r, g, b] } with values 0-1
   * Returns RGBA Uint8Array.
   */
  renderColorSegMap (renderer, camera, width, height, colorMap) {
    // Build a stateId → [r,g,b] lookup
    const stateIdToColor = {}
    for (const [stateId, name] of Object.entries(this.stateIdToName)) {
      stateIdToColor[stateId] = colorMap[name] || [1, 0, 1]
    }

    // For each mesh, create a per-vertex segColor attribute
    const origAttrs = {}
    for (const [key, mesh] of Object.entries(this.sectionMeshs)) {
      const geom = mesh.geometry
      const blockIdAttr = geom.getAttribute('blockId')
      if (!blockIdAttr) continue

      const count = blockIdAttr.count
      const segColorArray = new Float32Array(count * 3)
      for (let i = 0; i < count; i++) {
        const sid = blockIdAttr.getX(i)
        const c = stateIdToColor[sid] || [1, 0, 1]
        segColorArray[i * 3] = c[0]
        segColorArray[i * 3 + 1] = c[1]
        segColorArray[i * 3 + 2] = c[2]
      }
      const attr = new THREE.BufferAttribute(segColorArray, 3)
      geom.setAttribute('segColor', attr)
      origAttrs[key] = true
    }

    const pixels = this.renderPass(renderer, camera, this.colorSegMaterial, width, height, {
      clearColor: 0x000000,
      clearAlpha: 0,
      backgroundColor: null
    })

    // Clean up segColor attributes
    for (const [key, mesh] of Object.entries(this.sectionMeshs)) {
      if (origAttrs[key]) {
        mesh.geometry.deleteAttribute('segColor')
      }
    }

    return pixels
  }

  // Listen for chunk rendering updates emitted if a worker finished a render and resolve if the number
  // of sections not rendered are 0
  waitForChunksToRender () {
    return new Promise((resolve, reject) => {
      if (Array.from(this.sectionsOutstanding).length === 0) {
        resolve()
        return
      }

      const updateHandler = () => {
        if (this.sectionsOutstanding.size === 0) {
          this.renderUpdateEmitter.removeListener('update', updateHandler)
          resolve()
        }
      }
      this.renderUpdateEmitter.on('update', updateHandler)
    })
  }
}

module.exports = { WorldRenderer }
