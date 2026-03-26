const path = require('path')
const fs = require('fs').promises
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')
const { detectStructureFormat, loadStructurePayload } = require('./utils/structure')
const { buildWorldFromPayload } = require('./utils/worldBuilder')

const THREE_EXPORTERS_DIR = path.join(__dirname, 'node_modules/three/examples/js/exporters')
const PUBLIC_DIR = path.join(__dirname, 'public')
const DEFAULT_PASTE_ORIGIN = new Vec3(0, 60, 0)

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

  const base = `--base ${boundingBox.relativeOrigin.x},${boundingBox.relativeOrigin.y},${boundingBox.relativeOrigin.z}`
  const isCube = boundingBox.size.x === boundingBox.size.y && boundingBox.size.y === boundingBox.size.z

  if (isCube) {
    return `${base} --res ${boundingBox.size.x}`
  }

  return `${base} --bbox-size ${boundingBox.size.x},${boundingBox.size.y},${boundingBox.size.z} (reference only; parse_mc_ids.js currently supports cubic --res only)`
}

const parseArgs = (argv) => {
  const result = {
    positional: [],
    version: '1.21.4',
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
    path.join(PUBLIC_DIR, 'index.js'),
    path.join(PUBLIC_DIR, 'worker.js'),
    path.join(PUBLIC_DIR, 'textures', `${version}.png`),
    path.join(PUBLIC_DIR, 'blocksStates', `${version}.json`)
  ]

  for (const filePath of requiredPaths) {
    try {
      await fs.access(filePath)
    } catch {
      throw new Error(`Missing built asset: ${path.relative(__dirname, filePath)}. Run \"npm run build\" in minecraft-processor first.`)
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
  const world = new World(() => new Chunk())

  const inputPath = path.resolve(process.cwd(), inputArg)
  const buffer = await fs.readFile(inputPath)
  const format = detectStructureFormat(inputPath)

  await ensureBuiltAssets(version)

  let center
  let errorPositions = []
  let structureAxis = null
  let structureOriginWorldPos = null
  const applyPayloadToWorld = async (payload) => {
    const Block = require('prismarine-block')(version)
    const result = await buildWorldFromPayload({ world, version, payload, Block, Vec3, logger: console })
    errorPositions = result.errorPositions
    structureOriginWorldPos = result.originWorldPos
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

  if (format === 'schem' || format === 'schematic') {
    // Schematic has a native paste() that resolves stateIds correctly
    try {
      const schem = await Schematic.read(buffer, version)
      await schem.paste(world, DEFAULT_PASTE_ORIGIN)
      structureOriginWorldPos = DEFAULT_PASTE_ORIGIN.plus(schem.offset)
      const maxSize = Math.max(Number(schem.size.x || 1), Number(schem.size.y || 1), Number(schem.size.z || 1))
      structureAxis = {
        origin: {
          x: Number(schem.offset.x || 0),
          y: DEFAULT_PASTE_ORIGIN.y + Number(schem.offset.y || 0),
          z: Number(schem.offset.z || 0)
        },
        length: maxSize + Math.max(4, Math.ceil(maxSize * 0.1))
      }
      center = centerArg || new Vec3(
        Math.floor(schem.size.x / 2),
        60 + Math.floor(schem.size.y / 2),
        Math.floor(schem.size.z / 2)
      )
    } catch (nativeSchemError) {
      console.warn(`Warning: native schematic parser failed (${nativeSchemError.message || nativeSchemError}). Falling back to generic parser.`)
      const payload = await loadStructurePayload(buffer, format, { version, includeAir: false }, inputPath)
      await applyPayloadToWorld(payload)
    }
  } else {
    const payload = await loadStructurePayload(buffer, format, { version, includeAir: false }, inputPath)
    if (format === 'nbt' && payload.meta?.normalizedFormat === 'nbt-generic') {
      throw new Error('Unrecognised .nbt schema. Tried: Not a valid Java NBT structure: missing palette or blocks array | Not a valid Litematic: missing Regions tag | Not a valid Bedrock .mcstructure: missing required fields')
    }
    await applyPayloadToWorld(payload)
  }

  const boundingBox = showBoundingBox
    ? makeBoundingBoxConfig(structureOriginWorldPos, boundingBoxOrigin, boundingBoxSize)
    : null

  const express = require('express')
  const compression = require('compression')
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http)

  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'viewer.html')))

  // Three.js exporter scripts (path.basename prevents directory traversal)
  app.get('/vendor/three/:file', (req, res) => {
    res.sendFile(path.join(THREE_EXPORTERS_DIR, path.basename(req.params.file)))
  })

  app.use(compression())
  app.use('/', express.static(PUBLIC_DIR))
  app.use('/generated', express.static(path.join(__dirname, 'generated')))

  const sockets = []

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

  io.on('connection', (socket) => {
    socket.boundingBoxFilter = null
    socket.emit('version', version)
    sockets.push(socket)
    sendChunks([socket])
    socket.emit('position', { pos: center, addMesh: false })
    socket.emit('errorBlocks', errorPositions)
    socket.emit('structureAxis', structureAxis)
    socket.emit('boundingBox', boundingBox)
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
  console.log(`Structure loaded: ${inputPath} (format: ${format})`)
  console.log(`Structure size (x,y,z): ${structureAxis.length},${structureAxis.length},${structureAxis.length}`)
  if (boundingBox) {
    console.log(`Bounding box origin (relative): ${boundingBox.relativeOrigin.x},${boundingBox.relativeOrigin.y},${boundingBox.relativeOrigin.z}`)
    console.log(`Bounding box size: ${boundingBox.size.x},${boundingBox.size.y},${boundingBox.size.z}`)
    console.log(`parse_mc_ids args: ${formatBoundingBoxArgsPreview(boundingBox)}`)
  }
  console.log(`Open http://127.0.0.1:${currentPort}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
