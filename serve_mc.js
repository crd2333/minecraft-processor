const path = require('path')
const fs = require('fs').promises
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')
const nbt = require('prismarine-nbt')

const THREE_EXPORTERS_DIR = path.join(__dirname, 'node_modules/three/examples/js/exporters')

const parseArgs = (argv) => {
  const result = {
    positional: [],
    version: '1.21.4',
    port: 3000,
    viewDistance: 8,
    center: null
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--version' || arg === '-v') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --version')
      result.version = value
      i++
      continue
    }
    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --port')
      result.port = Number(value)
      i++
      continue
    }
    if (arg === '--view-distance' || arg === '-d') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --view-distance')
      result.viewDistance = Number(value)
      i++
      continue
    }
    if (arg === '--center' || arg === '-c') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --center')
      const [x, y, z] = value.split(',').map(Number)
      if ([x, y, z].some(Number.isNaN)) throw new Error('Invalid --center, expected x,y,z')
      result.center = new Vec3(x, y, z)
      i++
      continue
    }
    result.positional.push(arg)
  }

  return result
}

const PRE_SCRIPT = `
;(function () {
  var _origGetContext = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2') {
      attrs = Object.assign({}, attrs, { preserveDrawingBuffer: true })
    }
    return _origGetContext.call(this, type, attrs)
  }

  var _mo = new MutationObserver(function (mutations) {
    for (var i = 0; i < mutations.length; i++) {
      var nodes = mutations[i].addedNodes
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].tagName === 'CANVAS') {
          window._pw_canvas = nodes[j]
          _mo.disconnect()
          return
        }
      }
    }
  })
  _mo.observe(document.body, { childList: true })
})()
`

const EXPORT_SCRIPT = `
;(function () {
  'use strict'

  var _origUMW = THREE.Scene.prototype.updateMatrixWorld || THREE.Object3D.prototype.updateMatrixWorld
  THREE.Scene.prototype.updateMatrixWorld = function (force) {
    window._pw_scene = this
    return _origUMW.call(this, force)
  }

  var panel = document.createElement('div')
  panel.id = 'export-panel'
  panel.innerHTML = [
    '<button id="btn-screenshot">\u{1F4F7} Screenshot</button>',
    '<button id="btn-export-obj">\u2B07 Export OBJ</button>',
    '<button id="btn-export-stl">\u2B07 Export STL</button>',
    '<button id="btn-export-glb">\u2B07 Export GLB</button>',
    '<div id="export-status"></div>'
  ].join('')
  document.body.appendChild(panel)

  var statusTimer
  function setStatus (msg) {
    clearTimeout(statusTimer)
    document.getElementById('export-status').textContent = msg
    if (msg) statusTimer = setTimeout(function () { setStatus('') }, 4000)
  }

  function downloadBlob (blob, filename) {
    var url = URL.createObjectURL(blob)
    var a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    setTimeout(function () { URL.revokeObjectURL(url); if (a.parentNode) a.parentNode.removeChild(a) }, 1000)
  }

  document.getElementById('btn-screenshot').addEventListener('click', function () {
    var canvas = window._pw_canvas || document.querySelector('canvas')
    if (!canvas) { setStatus('Canvas not found'); return }
    try {
      var dataUrl = canvas.toDataURL('image/png')
      var a = document.createElement('a')
      a.href = dataUrl
      a.download = 'screenshot.png'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setStatus('Screenshot saved.')
    } catch (e) {
      setStatus('Screenshot failed: ' + e.message)
    }
  })

  document.getElementById('btn-export-obj').addEventListener('click', function () {
    if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
    try {
      var result = new THREE.OBJExporter().parse(window._pw_scene)
      downloadBlob(new Blob([result], { type: 'text/plain' }), 'model.obj')
      setStatus('OBJ downloaded.')
    } catch (e) { setStatus('Error: ' + e.message) }
  })

  document.getElementById('btn-export-stl').addEventListener('click', function () {
    if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
    try {
      var result = new THREE.STLExporter().parse(window._pw_scene, { binary: true })
      var buf = result instanceof ArrayBuffer ? result : result.buffer || result
      downloadBlob(new Blob([buf], { type: 'application/octet-stream' }), 'model.stl')
      setStatus('STL downloaded.')
    } catch (e) { setStatus('Error: ' + e.message) }
  })

  document.getElementById('btn-export-glb').addEventListener('click', function () {
    if (!window._pw_scene) { setStatus('Scene not ready yet'); return }
    try {
      new THREE.GLTFExporter().parse(window._pw_scene, function (glb) {
        var buf = glb instanceof ArrayBuffer ? glb : glb.buffer || glb
        downloadBlob(new Blob([buf], { type: 'model/gltf-binary' }), 'model.glb')
        setStatus('GLB downloaded.')
      }, { binary: true })
    } catch (e) { setStatus('Error: ' + e.message) }
  })
})()
`

const ERROR_BLOCK_SCRIPT = `
;(function () {
  'use strict'

  // Classic 2×2 magenta/black "missing texture" checkerboard
  function makeMissingTex () {
    var c = document.createElement('canvas')
    c.width = 2; c.height = 2
    var ctx = c.getContext('2d')
    ctx.fillStyle = '#FF00FF'; ctx.fillRect(0, 0, 1, 1); ctx.fillRect(1, 1, 1, 1)
    ctx.fillStyle = '#000000'; ctx.fillRect(1, 0, 1, 1); ctx.fillRect(0, 1, 1, 1)
    var t = new THREE.CanvasTexture(c)
    t.magFilter = THREE.NearestFilter
    t.minFilter = THREE.NearestFilter
    return t
  }

  var pending = null

  function doInject (scene, positions) {
    var geo = new THREE.BoxGeometry(1, 1, 1)
    var mat = new THREE.MeshBasicMaterial({ map: makeMissingTex() })
    var im = new THREE.InstancedMesh(geo, mat, positions.length)
    im.name = 'errorBlocks'
    var dummy = new THREE.Object3D()
    for (var i = 0; i < positions.length; i++) {
      dummy.position.set(positions[i].x + 0.5, positions[i].y + 0.5, positions[i].z + 0.5)
      dummy.updateMatrix()
      im.setMatrixAt(i, dummy.matrix)
    }
    im.instanceMatrix.needsUpdate = true
    scene.add(im)
    console.log('[error-blocks] rendered ' + positions.length + ' unrecognised block(s) as error placeholders')
  }

  var poll = setInterval(function () {
    if (!pending || !window._pw_scene) return
    doInject(window._pw_scene, pending)
    pending = null
    clearInterval(poll)
  }, 100)
  setTimeout(function () { clearInterval(poll) }, 60000)

  // Open a second socket connection to receive error block positions from the server.
  // The socket.io v4 server serves its own client at /socket.io/socket.io.js,
  // which is loaded explicitly in the HTML before this script runs.
  var sock = io()
  sock.on('errorBlocks', function (positions) {
    if (!positions || !positions.length) { clearInterval(poll); return }
    pending = positions
  })
})()
`

const buildHtml = () => `<!DOCTYPE html>
<html>
  <head>
    <title>Prismarine Structure Viewer</title>
    <style>
      html { overflow: hidden; }
      html, body { height: 100%; margin: 0; padding: 0; }
      canvas { display: block; height: 100%; width: 100%; margin: 0; padding: 0; }
      #export-panel {
        position: fixed; top: 10px; right: 10px; z-index: 1000;
        display: flex; flex-direction: column; gap: 6px;
        background: rgba(0, 0, 0, 0.72); padding: 10px 12px; border-radius: 8px;
        font-family: sans-serif;
      }
      #export-panel button {
        cursor: pointer; background: #2a7fd4; color: #fff;
        border: none; border-radius: 5px; padding: 7px 14px;
        font-size: 13px; white-space: nowrap;
      }
      #export-panel button:hover { background: #1a6bc0; }
      #export-status { color: #ccc; font-size: 11px; text-align: center; min-height: 14px; }
    </style>
  </head>
  <body>
    <script>${PRE_SCRIPT}</script>
    <script src="index.js"></script>
    <script src="/vendor/three/OBJExporter.js"></script>
    <script src="/vendor/three/STLExporter.js"></script>
    <script src="/vendor/three/GLTFExporter.js"></script>
    <script>${EXPORT_SCRIPT}</script>
    <script src="/socket.io/socket.io.js"></script>
    <script>${ERROR_BLOCK_SCRIPT}</script>
  </body>
</html>
`

// ---- format detection ----

function detectFormat (filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.schem') return 'schem'
  if (ext === '.schematic') return 'schematic'
  if (ext === '.litematic') return 'litematic'
  if (ext === '.mcstructure') return 'mcstructure'
  if (ext === '.nbt') return 'nbt'
  throw new Error(`Unsupported file extension: ${ext || '(none)'}. Supported: .schem .schematic .litematic .nbt .mcstructure`)
}

// ---- litematic packed-int decoder (same algorithm as parse_mc.js) ----

function decodeLitematicPacked (packedLongs, bitsPerBlock, blockCount) {
  const MASK64 = (1n << 64n) - 1n
  const mask = (1n << BigInt(bitsPerBlock)) - 1n
  const out = new Array(blockCount)
  for (let i = 0; i < blockCount; i++) {
    const startBit = i * bitsPerBlock
    const longIdx = Math.floor(startBit / 64)
    const bitOff = startBit % 64
    const cur = BigInt(packedLongs[longIdx]) & MASK64
    let val = (cur >> BigInt(bitOff)) & mask
    if ((64 - bitOff) < bitsPerBlock && longIdx + 1 < packedLongs.length) {
      const nxt = BigInt(packedLongs[longIdx + 1]) & MASK64
      val = ((cur >> BigInt(bitOff)) | (nxt << BigInt(64 - bitOff))) & mask
    }
    out[i] = Number(val)
  }
  return out
}

// YZX index → local {x, y, z}  storage order: index = x + sx*(z + sz*y)  (Litematic)
function idxToYZX (i, sx, sz) {
  return { x: i % sx, z: Math.floor(i / sx) % sz, y: Math.floor(i / (sx * sz)) }
}

// ZYX index → local {x, y, z}  storage order: index = z + sz*(y + sy*x)  (Bedrock .mcstructure)
function idxToZYX (i, sz, sy) {
  return { z: i % sz, y: Math.floor(i / sz) % sy, x: Math.floor(i / (sz * sy)) }
}

function isAir (name) {
  return !name || name === 'air' || name === 'minecraft:air'
}

function shortName (name) {
  if (!name) return ''
  return name.startsWith('minecraft:') ? name.slice(10) : name
}

// ---- block extraction: litematic ----

function extractLitematicBlocks (simplified) {
  const regions = simplified.Regions
  if (!regions || typeof regions !== 'object' || Array.isArray(regions)) {
    throw new Error('Not a valid Litematic: missing Regions tag')
  }
  const allBlocks = []
  for (const regionName of Object.keys(regions)) {
    const region = regions[regionName]
    if (!region || !region.Size || !region.Position) continue
    const sx = Math.abs(Number(region.Size.x)) || 0
    const sy = Math.abs(Number(region.Size.y)) || 0
    const sz = Math.abs(Number(region.Size.z)) || 0
    if (sx === 0 || sy === 0 || sz === 0) continue
    const ox = Number(region.Position.x)
    const oy = Number(region.Position.y)
    const oz = Number(region.Position.z)
    const xMin = region.Size.x >= 0 ? ox : ox + Number(region.Size.x) + 1
    const yMin = region.Size.y >= 0 ? oy : oy + Number(region.Size.y) + 1
    const zMin = region.Size.z >= 0 ? oz : oz + Number(region.Size.z) + 1
    const palette = Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : []
    const packedStates = Array.isArray(region.BlockStates) ? region.BlockStates : []
    if (palette.length === 0) continue
    const bits = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))))
    const states = decodeLitematicPacked(packedStates, bits, sx * sy * sz)
    for (let i = 0; i < states.length; i++) {
      const entry = palette[states[i]]
      if (!entry) continue
      const name = entry.Name || entry.name
      if (isAir(name)) continue
      const { x, y, z } = idxToYZX(i, sx, sz)
      allBlocks.push({ x: xMin + x, y: yMin + y, z: zMin + z, name: shortName(name), properties: entry.Properties || entry.properties || {} })
    }
  }
  return allBlocks
}

// ---- block extraction: java .nbt structure ----

function extractJavaNbtBlocks (simplified) {
  const palette = simplified.palette
  const blockList = simplified.blocks
  if (!Array.isArray(palette) || !Array.isArray(blockList)) {
    throw new Error('Not a valid Java NBT structure: missing palette or blocks array')
  }
  const result = []
  for (const entry of blockList) {
    if (!entry || !Array.isArray(entry.pos) || entry.pos.length !== 3) continue
    const pe = palette[Number(entry.state)] || {}
    const name = pe.Name || pe.name
    if (isAir(name)) continue
    result.push({ x: entry.pos[0], y: entry.pos[1], z: entry.pos[2], name: shortName(name), properties: pe.Properties || pe.properties || {} })
  }
  return result
}

// ---- block extraction: bedrock .mcstructure ----

function extractMcstructureBlocks (simplified) {
  const sizeArr = simplified.size
  const palette = simplified.structure?.palette?.default?.block_palette
  const primaryIndices = simplified.structure?.block_indices?.[0]
  if (!Array.isArray(sizeArr) || sizeArr.length !== 3 || !Array.isArray(palette) || !Array.isArray(primaryIndices)) {
    throw new Error('Not a valid Bedrock .mcstructure: missing required fields')
  }
  // Bedrock stores blocks in ZYX order: index = z + sz*(y + sy*x)
  const sz = Number(sizeArr[2])
  const sy = Number(sizeArr[1])
  const result = []
  for (let i = 0; i < primaryIndices.length; i++) {
    const entry = palette[Number(primaryIndices[i])] || {}
    const name = entry.name
    if (isAir(name)) continue
    const { x, y, z } = idxToZYX(i, sz, sy)
    result.push({ x, y, z, name: shortName(name), properties: entry.states || {} })
  }
  return result
}

// ---- NBT parse + dispatch ----

async function parseNbtAndExtract (buffer, format) {
  const hints = [undefined, 'little', 'littleVarint']
  let simplified = null
  let lastErr = null
  for (const hint of hints) {
    try {
      const { parsed } = await nbt.parse(buffer, hint)
      simplified = nbt.simplify(parsed)
      break
    } catch (err) {
      lastErr = err
    }
  }
  if (!simplified) throw lastErr || new Error('Failed to parse NBT buffer')

  if (format === 'litematic') return extractLitematicBlocks(simplified)
  if (format === 'mcstructure') return extractMcstructureBlocks(simplified)

  // .nbt — try all known schemas in order
  const errs = []
  try { return extractJavaNbtBlocks(simplified) } catch (e) { errs.push(e.message) }
  try { return extractLitematicBlocks(simplified) } catch (e) { errs.push(e.message) }
  try { return extractMcstructureBlocks(simplified) } catch (e) { errs.push(e.message) }
  throw new Error(`Unrecognised .nbt schema. Tried: ${errs.join(' | ')}`)
}

// ---- populate prismarine world from extracted block list ----

async function buildWorldFromBlocks (world, version, blocks) {
  if (blocks.length === 0) {
    console.warn('Warning: no non-air blocks found in structure')
    return { size: new Vec3(1, 1, 1) }
  }
  const Block = require('prismarine-block')(version)
  let minX = Infinity; let minY = Infinity; let minZ = Infinity
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
  for (const b of blocks) {
    if (b.x < minX) minX = b.x
    if (b.y < minY) minY = b.y
    if (b.z < minZ) minZ = b.z
    if (b.x > maxX) maxX = b.x
    if (b.y > maxY) maxY = b.y
    if (b.z > maxZ) maxZ = b.z
  }
  const Y_BASE = 60
  const errorPositions = []
  const skippedNames = {}
  for (const b of blocks) {
    const pos = new Vec3(b.x - minX, b.y - minY + Y_BASE, b.z - minZ)
    let block
    try {
      block = Block.fromProperties(b.name, b.properties, 0)
    } catch (_) {
      try { block = Block.fromProperties(b.name, {}, 0) } catch (_2) {
        errorPositions.push({ x: pos.x, y: pos.y, z: pos.z, name: b.name })
        skippedNames[b.name] = (skippedNames[b.name] || 0) + 1
        continue
      }
    }
    await world.setBlock(pos, block)
  }
  if (errorPositions.length > 0) {
    console.warn(`Warning: ${errorPositions.length} block(s) not found in version ${version} registry (will render as error blocks):`)
    for (const [name, count] of Object.entries(skippedNames)) {
      console.warn(`  - ${name}: ${count}`)
    }
  }
  return { size: new Vec3(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1), errorPositions }
}

const main = async () => {
  const { positional, version, port, viewDistance, center: centerArg } = parseArgs(process.argv.slice(2))
  const inputArg = positional[0]

  if (!inputArg) {
    console.error('Usage: node serve_mc.js <file.{schem,schematic,litematic,nbt,mcstructure}> [--version <mc-version>] [--port <port>] [--view-distance <chunks>] [--center x,y,z]')
    process.exit(1)
  }

  const World = require('prismarine-world')(version)
  const Chunk = require('prismarine-chunk')(version)
  const world = new World(() => new Chunk())

  const inputPath = path.resolve(process.cwd(), inputArg)
  const buffer = await fs.readFile(inputPath)
  const format = detectFormat(inputPath)

  let center
  let errorPositions = []
  if (format === 'schem' || format === 'schematic') {
    // Schematic has a native paste() that resolves stateIds correctly
    const schem = await Schematic.read(buffer, version)
    await schem.paste(world, new Vec3(0, 60, 0))
    center = centerArg || new Vec3(
      Math.floor(schem.size.x / 2),
      60 + Math.floor(schem.size.y / 2),
      Math.floor(schem.size.z / 2)
    )
  } else {
    // NBT-based formats: parse → extract block list → place via Block.fromProperties
    const blocks = await parseNbtAndExtract(buffer, format)
    const result = await buildWorldFromBlocks(world, version, blocks)
    errorPositions = result.errorPositions
    center = centerArg || new Vec3(
      Math.floor(result.size.x / 2),
      60 + Math.floor(result.size.y / 2),
      Math.floor(result.size.z / 2)
    )
  }

  const express = require('express')
  const compression = require('compression')
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http)

  app.get('/', (req, res) => res.send(buildHtml()))

  // Three.js exporter scripts (path.basename prevents directory traversal)
  app.get('/vendor/three/:file', (req, res) => {
    res.sendFile(path.join(THREE_EXPORTERS_DIR, path.basename(req.params.file)))
  })

  app.use(compression())
  app.use('/', express.static(path.join(__dirname, 'public')))

  const sockets = []

  async function sendChunks (targets) {
    const cx = Math.floor(center.x / 16)
    const cz = Math.floor(center.z / 16)
    for (let x = cx - viewDistance; x <= cx + viewDistance; x++) {
      for (let z = cz - viewDistance; z <= cz + viewDistance; z++) {
        const chunk = (await world.getColumn(x, z)).toJson()
        for (const socket of targets) {
          socket.emit('loadChunk', { x: x * 16, z: z * 16, chunk })
        }
      }
    }
  }

  io.on('connection', (socket) => {
    socket.emit('version', version)
    sockets.push(socket)
    sendChunks([socket])
    socket.emit('position', { pos: center, addMesh: false })
    socket.emit('errorBlocks', errorPositions)
    socket.on('disconnect', () => {
      sockets.splice(sockets.indexOf(socket), 1)
    })
  })

  http.listen(port, () => {
    console.log(`Prismarine viewer web server running on *:${port}`)
  })

  console.log(`Structure loaded: ${inputPath} (format: ${format})`)
  console.log(`Open http://127.0.0.1:${port} (or use VS Code port forwarding)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})





