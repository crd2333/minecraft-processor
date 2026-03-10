global.THREE = require('three')
require('three/examples/js/controls/OrbitControls')

const THREE = global.THREE
const { Vec3 } = require('vec3')
const { WorldRenderer } = require('../vendor/prismarine-viewer/lib/worldrenderer')
const { getVersion } = require('../vendor/prismarine-viewer/lib/version')

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