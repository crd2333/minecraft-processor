const path = require('path')
const fs = require('fs').promises
const { Vec3 } = require('vec3')
const { Schematic } = require('prismarine-schematic')
const { detectStructureFormat, loadStructurePayload } = require('./utils/structure')
const { buildWorldFromPayload } = require('./utils/worldBuilder')

const THREE_EXPORTERS_DIR = path.join(__dirname, 'node_modules/three/examples/js/exporters')
const PUBLIC_DIR = path.join(__dirname, 'public')

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
  const format = detectStructureFormat(inputPath)

  await ensureBuiltAssets(version)

  let center
  let errorPositions = []
  let structureAxis = null
  if (format === 'schem' || format === 'schematic') {
    // Schematic has a native paste() that resolves stateIds correctly
    const schem = await Schematic.read(buffer, version)
    await schem.paste(world, new Vec3(0, 60, 0))
    const maxSize = Math.max(Number(schem.size.x || 1), Number(schem.size.y || 1), Number(schem.size.z || 1))
    structureAxis = {
      origin: {
        x: Number(schem.offset.x || 0),
        y: 60 + Number(schem.offset.y || 0),
        z: Number(schem.offset.z || 0)
      },
      length: maxSize + Math.max(4, Math.ceil(maxSize * 0.1))
    }
    center = centerArg || new Vec3(
      Math.floor(schem.size.x / 2),
      60 + Math.floor(schem.size.y / 2),
      Math.floor(schem.size.z / 2)
    )
  } else {
    const payload = await loadStructurePayload(buffer, format, { version, includeAir: false }, inputPath)
    if (format === 'nbt' && payload.meta?.normalizedFormat === 'nbt-generic') {
      throw new Error('Unrecognised .nbt schema. Tried: Not a valid Java NBT structure: missing palette or blocks array | Not a valid Litematic: missing Regions tag | Not a valid Bedrock .mcstructure: missing required fields')
    }

    const Block = require('prismarine-block')(version)
    const result = await buildWorldFromPayload({ world, version, payload, Block, Vec3, logger: console })
    errorPositions = result.errorPositions
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
    socket.emit('structureAxis', structureAxis)
    socket.on('disconnect', () => {
      sockets.splice(sockets.indexOf(socket), 1)
    })
  })

  http.listen(port, () => {
    console.log(`Prismarine viewer web server running on *:${port}`)
  })

  console.log(`Structure loaded: ${inputPath} (format: ${format})`)
  console.log(`Open http://127.0.0.1:${port}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})





