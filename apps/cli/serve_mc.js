const path = require('path')
const fs = require('fs').promises
const { Vec3 } = require('vec3')
const { detectStructureFormat } = require('../../src/structure_parser')
const { loadUnifiedStructure } = require('../../src/unified_parser')
const { buildWorldFromUnifiedStructure } = require('../../src/world_builder')
const { defaultViewerVersion } = require('../../prismarine-viewer-lib/version')

const PROJECT_ROOT = path.resolve(__dirname, '../..')
const THREE_EXPORTERS_DIR = path.join(PROJECT_ROOT, 'node_modules/three/examples/js/exporters')
const STATIC_DIR = path.join(PROJECT_ROOT, 'static')
const VIEWER_PUBLIC_DIR = path.join(PROJECT_ROOT, 'apps/frontend/viewer/public')
const VIEWER_RUNTIME_DIR = path.join(PROJECT_ROOT, 'apps/frontend/viewer/src')
const SUPPORTED_ASSET_EXTENSIONS = new Set(['.schem', '.schematic', '.litematic', '.nbt', '.mcstructure'])

function normalizePathForClient (value) {
  return value.split(path.sep).join('/')
}

function isPathInsideBase (baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath)
  return !(relative.startsWith('..') || path.isAbsolute(relative))
}

async function listStructureAssets (baseDir) {
  const assets = []

  async function walk (dirPath) {
    const entries = await fs.readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }

      if (!entry.isFile()) continue
      if (!SUPPORTED_ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue

      assets.push(normalizePathForClient(path.relative(baseDir, fullPath)))
    }
  }

  await walk(baseDir)
  assets.sort((a, b) => a.localeCompare(b))
  return assets
}

function parseVec3Option (value, optionName) {
  if (!value) throw new Error(`Missing value for ${optionName}`)
  const [x, y, z] = value.split(',').map((part) => Number(part.trim()))
  if ([x, y, z].some(Number.isNaN)) {
    throw new Error(`Invalid ${optionName}, expected x,y,z`)
  }
  return new Vec3(x, y, z)
}

function parseSizeOption (value, optionName) {
  if (!value) throw new Error(`Missing value for ${optionName}`)

  const parts = value.split(',').map((part) => Number(part.trim()))
  const size = parts.length === 1
    ? new Vec3(parts[0], parts[0], parts[0])
    : parts.length === 3
      ? new Vec3(parts[0], parts[1], parts[2])
      : null

  if (!size || [size.x, size.y, size.z].some((axis) => Number.isNaN(axis) || axis <= 0)) {
    throw new Error(`Invalid ${optionName}, expected n or x,y,z with positive numbers`)
  }

  return size
}

function makeBoundingBoxConfig (structureOriginWorldPos, origin, size) {
  if (!structureOriginWorldPos || !origin || !size) return null

  return {
    origin: {
      x: structureOriginWorldPos.x + origin.x,
      y: structureOriginWorldPos.y + origin.y,
      z: structureOriginWorldPos.z + origin.z
    },
    size: {
      x: size.x,
      y: size.y,
      z: size.z
    },
    relativeOrigin: {
      x: origin.x,
      y: origin.y,
      z: origin.z
    }
  }
}

function isPointInsideBoundingBox (point, boundingBox) {
  if (!boundingBox || !boundingBox.origin || !boundingBox.size) return true

  return (
    point.x >= boundingBox.origin.x && point.x < boundingBox.origin.x + boundingBox.size.x &&
    point.y >= boundingBox.origin.y && point.y < boundingBox.origin.y + boundingBox.size.y &&
    point.z >= boundingBox.origin.z && point.z < boundingBox.origin.z + boundingBox.size.z
  )
}

function getChunkYBounds (chunk) {
  const minY = Number.isFinite(chunk.minY) ? chunk.minY : 0
  const worldHeight = Number.isFinite(chunk.worldHeight) ? chunk.worldHeight : 256
  return {
    minY,
    maxY: minY + worldHeight
  }
}

function filterChunkForBoundingBox (Chunk, chunk, chunkX, chunkZ, boundingBox) {
  if (!boundingBox) return chunk.toJson()

  const filteredChunk = Chunk.fromJson(chunk.toJson())
  const yBounds = getChunkYBounds(filteredChunk)

  for (let y = yBounds.minY; y < yBounds.maxY; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const worldPos = {
          x: chunkX * 16 + x,
          y,
          z: chunkZ * 16 + z
        }

        if (!isPointInsideBoundingBox(worldPos, boundingBox)) {
          filteredChunk.setBlockStateId({ x, y, z }, 0)
        }
      }
    }
  }

  return filteredChunk.toJson()
}

function filterErrorPositionsForBoundingBox (positions, boundingBox) {
  if (!boundingBox) return positions
  return positions.filter((position) => isPointInsideBoundingBox(position, boundingBox))
}

function formatBoundingBoxArgsPreview (boundingBox) {
  if (!boundingBox || !boundingBox.relativeOrigin || !boundingBox.size) return null

  const base = `--bbox-origin ${boundingBox.relativeOrigin.x},${boundingBox.relativeOrigin.y},${boundingBox.relativeOrigin.z}`
  const isCube = boundingBox.size.x === boundingBox.size.y && boundingBox.size.y === boundingBox.size.z

  if (isCube) {
    return `${base} --bbox-size ${boundingBox.size.x}`
  }

  return `${base} --bbox-size ${boundingBox.size.x},${boundingBox.size.y},${boundingBox.size.z}`
}

const parseArgs = (argv) => {
  const result = {
    positional: [],
    version: defaultViewerVersion,
    port: 3000,
    viewDistance: 8,
    center: null,
    boundingBoxOrigin: new Vec3(0, 0, 0),
    boundingBoxSize: new Vec3(64, 64, 64),
    showBoundingBox: true
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
      result.center = parseVec3Option(argv[i + 1], '--center')
      i++
      continue
    }
    if (arg === '--bbox-origin') {
      result.boundingBoxOrigin = parseVec3Option(argv[i + 1], '--bbox-origin')
      i++
      continue
    }
    if (arg === '--bbox-size') {
      result.boundingBoxSize = parseSizeOption(argv[i + 1], '--bbox-size')
      i++
      continue
    }
    if (arg === '--no-bbox') {
      result.showBoundingBox = false
      continue
    }
    result.positional.push(arg)
  }

  return result
}

async function ensureBuiltAssets (version) {
  const requiredPaths = [
    path.join(STATIC_DIR, 'index.js'),
    path.join(STATIC_DIR, 'worker.js'),
    path.join(STATIC_DIR, 'textures', `${version}.png`),
    path.join(STATIC_DIR, 'blocksStates', `${version}.json`)
  ]

  for (const filePath of requiredPaths) {
    try {
      await fs.access(filePath)
    } catch {
      throw new Error(`Missing built asset: ${path.relative(PROJECT_ROOT, filePath)}. Run \"npm run build\" in minecraft-processor first.`)
    }
  }
}

const main = async () => {
  const {
    positional,
    version,
    port,
    viewDistance,
    center: centerArg,
    boundingBoxOrigin,
    boundingBoxSize,
    showBoundingBox
  } = parseArgs(process.argv.slice(2))
  const inputArg = positional[0]

  if (!inputArg) {
    console.error('Usage: node serve_mc.js <file.{schem,schematic,litematic,nbt,mcstructure}> [--version <mc-version>] [--port <port>] [--view-distance <chunks>] [--center x,y,z] [--bbox-origin x,y,z] [--bbox-size n|x,y,z] [--no-bbox]')
    process.exit(1)
  }

  const World = require('prismarine-world')(version)
  const Chunk = require('prismarine-chunk')(version)
  let world = new World(() => new Chunk())

  const initialInputPath = path.resolve(process.cwd(), inputArg)
  const assetBaseDir = path.dirname(initialInputPath)

  function toClientAssetPath (absolutePath) {
    return normalizePathForClient(path.relative(assetBaseDir, absolutePath))
  }

  function resolveAssetPath (assetRef) {
    if (typeof assetRef !== 'string' || !assetRef.trim()) {
      throw new Error('Missing asset path')
    }

    const resolvedPath = path.resolve(assetBaseDir, assetRef.trim())
    if (!isPathInsideBase(assetBaseDir, resolvedPath)) {
      throw new Error(`Asset path must stay within ${assetBaseDir}`)
    }

    const ext = path.extname(resolvedPath).toLowerCase()
    if (!SUPPORTED_ASSET_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported asset extension: ${ext || '(none)'}`)
    }

    return resolvedPath
  }

  await ensureBuiltAssets(version)

  let center
  let errorPositions = []
  let structureAxis = null
  let structureOriginWorldPos = null
  let structureSize = new Vec3(1, 1, 1)
  let boundingBox = null
  let currentInputPath = null
  let currentFormat = null

  async function loadStructureAtPath (resolvedInputPath) {
    const buffer = await fs.readFile(resolvedInputPath)
    const format = detectStructureFormat(resolvedInputPath)
    world = new World(() => new Chunk())
    center = null
    errorPositions = []
    structureAxis = null
    structureOriginWorldPos = null
    structureSize = new Vec3(1, 1, 1)

    const applyUnifiedToWorld = async (unified) => {
      const Block = require('prismarine-block')(version)
      const result = await buildWorldFromUnifiedStructure({ world, version, unified, Block, logger: console })
      errorPositions = result.errorPositions
      structureOriginWorldPos = result.originWorldPos
      structureSize = result.size
      structureAxis = {
        origin: result.originWorldPos,
        length: result.axisLength
      }
      center = centerArg || new Vec3(
        Math.floor(result.size.x / 2),
        60 + Math.floor(result.size.y / 2),
        Math.floor(result.size.z / 2)
      )
    }

    const unified = await loadUnifiedStructure(buffer, format, {
      version,
      targetVersion: version,
      unknownPolicy: 'keep',
      logger: console
    })

    await applyUnifiedToWorld(unified)

    boundingBox = showBoundingBox
      ? makeBoundingBoxConfig(structureOriginWorldPos, boundingBoxOrigin, boundingBoxSize)
      : null

    currentInputPath = resolvedInputPath
    currentFormat = format
  }

  await loadStructureAtPath(initialInputPath)

  const express = require('express')
  const compression = require('compression')
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http)

  app.get('/', (req, res) => res.sendFile(path.join(VIEWER_PUBLIC_DIR, 'viewer.html')))

  app.get('/viewer-preload.js', (req, res) => {
    res.sendFile(path.join(VIEWER_RUNTIME_DIR, 'preload/viewer-preload.js'))
  })

  app.get('/viewer-hooks.js', (req, res) => {
    res.sendFile(path.join(VIEWER_RUNTIME_DIR, 'hooks/viewer-hooks.js'))
  })

  // Three.js exporter scripts (path.basename prevents directory traversal)
  app.get('/vendor/three/:file', (req, res) => {
    res.sendFile(path.join(THREE_EXPORTERS_DIR, path.basename(req.params.file)))
  })

  app.use(compression())
  app.use('/', express.static(STATIC_DIR))

  app.get('/api/assets', async (req, res) => {
    try {
      const assets = await listStructureAssets(assetBaseDir)
      res.json({
        baseDir: assetBaseDir,
        currentAsset: currentInputPath ? toClientAssetPath(currentInputPath) : null,
        format: currentFormat,
        assets
      })
    } catch (error) {
      res.status(500).json({ error: error.message || String(error) })
    }
  })

  const sockets = []
  let assetSwitchQueue = Promise.resolve()

  function queueAssetSwitch (task) {
    const run = assetSwitchQueue.then(() => task())
    assetSwitchQueue = run.catch(() => {})
    return run
  }

  async function sendChunks (targets, boundingBoxFilter = null) {
    const cx = Math.floor(center.x / 16)
    const cz = Math.floor(center.z / 16)
    for (let x = cx - viewDistance; x <= cx + viewDistance; x++) {
      for (let z = cz - viewDistance; z <= cz + viewDistance; z++) {
        const chunkColumn = await world.getColumn(x, z)
        const chunk = filterChunkForBoundingBox(Chunk, chunkColumn, x, z, boundingBoxFilter)
        for (const socket of targets) {
          socket.emit('loadChunk', { x: x * 16, z: z * 16, chunk })
        }
      }
    }
  }

  async function emitWorldStateToSocket (socket, options = {}) {
    if (!socket) return
    const withVersion = options.withVersion !== false
    const filter = socket.boundingBoxFilter || null

    if (withVersion) socket.emit('version', version)
    await sendChunks([socket], filter)
    socket.emit('position', { pos: center, addMesh: false })
    socket.emit('errorBlocks', filterErrorPositionsForBoundingBox(errorPositions, filter))
    socket.emit('structureAxis', structureAxis)
    socket.emit('boundingBox', boundingBox)
    socket.emit('assetInfo', {
      asset: currentInputPath ? toClientAssetPath(currentInputPath) : null,
      format: currentFormat
    })
  }

  async function emitWorldStateToAllSockets ({ withVersion = false } = {}) {
    if (withVersion) {
      for (const socket of sockets) {
        socket.emit('version', version)
      }
    }
    for (const socket of sockets) {
      await emitWorldStateToSocket(socket, { withVersion: false })
    }
  }

  io.on('connection', (socket) => {
    socket.boundingBoxFilter = null
    sockets.push(socket)
    emitWorldStateToSocket(socket, { withVersion: true }).catch((error) => {
      console.error('Failed to emit initial world state:', error)
    })
    socket.on('bboxFilter', async (filterState) => {
      const nextFilter = filterState && filterState.enabled ? {
        origin: filterState.origin,
        size: filterState.size
      } : null

      socket.boundingBoxFilter = nextFilter
      // Send filtered chunks to ALL sockets (viewer-hooks.js and client.js are separate connections)
      await sendChunks(sockets, nextFilter)
      socket.emit('errorBlocks', filterErrorPositionsForBoundingBox(errorPositions, nextFilter))
    })

    socket.on('switchAsset', async (payload, ack) => {
      const respond = (response) => {
        if (typeof ack === 'function') ack(response)
      }

      try {
        const requestedAsset = payload && typeof payload.asset === 'string'
          ? payload.asset
          : ''
        const resolvedAssetPath = resolveAssetPath(requestedAsset)

        await queueAssetSwitch(async () => {
          await loadStructureAtPath(resolvedAssetPath)
          await emitWorldStateToAllSockets({ withVersion: true })
        })

        respond({
          ok: true,
          asset: toClientAssetPath(currentInputPath),
          format: currentFormat
        })
      } catch (error) {
        respond({ ok: false, error: error.message || String(error) })
      }
    })

    socket.on('disconnect', () => {
      sockets.splice(sockets.indexOf(socket), 1)
    })
  })

  // try port first, if fails (e.g. in use) then keep incrementing until we find an open port
  let currentPort = port
  const maxPort = port + 100
  while (currentPort < maxPort) {
    try {
      await new Promise((resolve, reject) => {
        http.listen(currentPort, () => {
          resolve()
        }).on('error', (err) => {
          reject(err)
        })
      })
      break // if we successfully started the server, exit the loop
    } catch (err) {
      if (err.code === 'EADDRINUSE') {
        console.warn(`Port ${currentPort} in use, trying ${currentPort + 1}...`)
        currentPort++
      } else {
        throw err
      }
    }
  }
  if (currentPort === maxPort) {
    throw new Error(`No available ports found between ${port} and ${maxPort - 1}`)
  }

  console.log(`Prismarine viewer web server running on *:${currentPort}`)
  console.log(`Structure loaded: ${currentInputPath} (format: ${currentFormat})`)
  console.log(`Structure size (x,y,z): ${structureSize.x},${structureSize.y},${structureSize.z}`)
  if (boundingBox) {
    console.log(`Bounding box origin (relative): ${boundingBox.relativeOrigin.x},${boundingBox.relativeOrigin.y},${boundingBox.relativeOrigin.z}`)
    console.log(`Bounding box size: ${boundingBox.size.x},${boundingBox.size.y},${boundingBox.size.z}`)
    console.log(`Bounding box args preview: ${formatBoundingBoxArgsPreview(boundingBox)}`)
  }
  console.log(`Asset base directory: ${assetBaseDir}`)
  console.log(`Open http://127.0.0.1:${currentPort}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
