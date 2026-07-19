#!/usr/bin/env node

const path = require('path')
const fs = require('fs').promises
const { Vec3 } = require('vec3')
const { detectStructureFormat } = require('../src/structure_parser')
const { loadUnifiedStructure } = require('../src/unified_parser')
const { buildWorldFromUnifiedStructure } = require('../src/world_builder')
const { defaultViewerVersion } = require('../src/viewer_versions')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const STATIC_DIR = path.join(PROJECT_ROOT, 'static')
const VENDORED_VIEWER_PUBLIC_DIR = path.join(STATIC_DIR, 'vendor', 'packages', 'prismarine-viewer', 'public')
const VIEWER_RUNTIME_DIR = path.join(PROJECT_ROOT, 'apps/frontend/viewer/src')
const RENDERER_PUBLIC_DIR = path.join(PROJECT_ROOT, 'apps/frontend/renderer/public')
const RENDERER_SRC_DIR = path.join(PROJECT_ROOT, 'apps/frontend/renderer/src')
const SUPPORTED_ASSET_EXTENSIONS = new Set(['.schem', '.schematic', '.litematic', '.nbt', '.mcstructure'])
const ALLOWED_CAPTURE_SIZES = new Set([1024, 2048])
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_PNG_BYTES = 24 * 1024 * 1024
const MAX_METADATA_BYTES = 1024 * 1024
const SOCKET_MAX_BUFFER_BYTES = 32 * 1024 * 1024

function showUsage () {
  console.log([
    'Usage:',
    '  node scripts/render_schematic_list.js <path-list> --asset-root <directory> --output <directory> [options]',
    '',
    'Options:',
    '      --asset-root <path>   Base directory for paths in the list (required)',
    '      --output <path>       Server-side capture directory (required)',
    '  -v, --version <version>   Minecraft/viewer version (default: ' + defaultViewerVersion + ')',
    '  -p, --port <port>         Preferred port (default: 3200)',
    '  -h, --help                Show this help',
    '',
    'Path list:',
    '  One asset path per line, relative to --asset-root. Blank lines and # comments are ignored.'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    assetRoot: null,
    output: null,
    version: defaultViewerVersion,
    port: 3200,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }
    if (arg === '--asset-root' || arg === '--output' || arg === '-v' || arg === '--version' || arg === '-p' || arg === '--port') {
      const value = argv[i + 1]
      if (!value) throw new Error(`Missing value for ${arg}`)
      i++
      if (arg === '--asset-root') result.assetRoot = value
      else if (arg === '--output') result.output = value
      else if (arg === '-v' || arg === '--version') result.version = value
      else {
        const port = Number(value)
        if (!Number.isInteger(port) || port <= 0 || port > 65535) {
          throw new Error('Invalid --port, expected an integer from 1 to 65535')
        }
        result.port = port
      }
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    result.positional.push(arg)
  }

  return result
}

function normalizeAssetRef (value) {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

function parsePathList (text) {
  const entries = []
  const seen = new Set()

  for (const rawLine of String(text).split(/\r?\n/)) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const assetRef = normalizeAssetRef(trimmed)
    if (path.posix.isAbsolute(assetRef) || /^[A-Za-z]:\//.test(assetRef)) {
      throw new Error(`Asset paths must be relative: ${trimmed}`)
    }
    if (assetRef.includes('\0')) throw new Error('Asset paths cannot contain NUL bytes')
    if (seen.has(assetRef)) throw new Error(`Duplicate asset path: ${assetRef}`)
    seen.add(assetRef)
    entries.push(assetRef)
  }

  if (entries.length === 0) throw new Error('Path list contains no assets')
  return entries
}

function isPathInsideBase (baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath)
  return relative === '' || !(relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
}

async function validateAssetEntries (assetRoot, assetRefs) {
  const rootPath = path.resolve(process.cwd(), assetRoot)
  const rootStat = await fs.stat(rootPath).catch(() => null)
  if (!rootStat || !rootStat.isDirectory()) throw new Error(`Asset root does not exist: ${rootPath}`)
  const realRootPath = await fs.realpath(rootPath)
  const assets = []

  for (let index = 0; index < assetRefs.length; index++) {
    const assetRef = assetRefs[index]
    const resolvedPath = path.resolve(realRootPath, assetRef)
    if (!isPathInsideBase(realRootPath, resolvedPath)) {
      throw new Error(`Asset path must stay within ${realRootPath}: ${assetRef}`)
    }

    const ext = path.extname(resolvedPath).toLowerCase()
    if (!SUPPORTED_ASSET_EXTENSIONS.has(ext)) {
      throw new Error(`Unsupported asset extension for ${assetRef}: ${ext || '(none)'}`)
    }

    const stat = await fs.stat(resolvedPath).catch(() => null)
    if (!stat || !stat.isFile()) throw new Error(`Asset file does not exist: ${assetRef}`)
    const realPath = await fs.realpath(resolvedPath)
    if (!isPathInsideBase(realRootPath, realPath)) {
      throw new Error(`Asset symlink must stay within ${realRootPath}: ${assetRef}`)
    }

    assets.push({
      index,
      caseIndex: index + 1,
      path: assetRef,
      resolvedPath: realPath,
      format: detectStructureFormat(realPath)
    })
  }

  return { assetRoot: realRootPath, assets }
}

function sanitizeStem (assetRef) {
  const source = path.posix.basename(assetRef, path.posix.extname(assetRef))
  const sanitized = source
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
  return sanitized || 'asset'
}

function caseLabel (caseIndex) {
  return String(caseIndex).padStart(4, '0')
}

function viewLabel (viewIndex) {
  return String(viewIndex).padStart(3, '0')
}

function buildCaptureBasename (asset, viewIndex, size) {
  return `${caseLabel(asset.caseIndex)}__${sanitizeStem(asset.path)}__view-${viewLabel(viewIndex)}__${size}`
}

function captureFilenameMatch (asset, filename) {
  const prefix = `${caseLabel(asset.caseIndex)}__${sanitizeStem(asset.path)}__`
  if (!filename.startsWith(prefix)) return null
  const match = filename.match(/__view-(\d+)__(1024|2048)\.png$/)
  return match ? Number(match[1]) : null
}

async function scanCaptureState (imagesDir, assets) {
  const state = new Map(assets.map((asset) => [asset.path, { count: 0, maxViewIndex: 0 }]))
  const filenames = await fs.readdir(imagesDir).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })

  for (const asset of assets) {
    const views = []
    for (const filename of filenames) {
      const viewIndex = captureFilenameMatch(asset, filename)
      if (Number.isInteger(viewIndex) && viewIndex > 0) views.push(viewIndex)
    }
    state.set(asset.path, {
      count: views.length,
      maxViewIndex: views.length ? Math.max(...views) : 0
    })
  }
  return state
}

function toPngBuffer (value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  throw new Error('Capture PNG must be sent as binary data')
}

function readPngDimensions (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) throw new Error('Capture is not a valid PNG')
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('Capture has an invalid PNG signature')
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') throw new Error('Capture PNG is missing its IHDR header')
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function validateCapturePayload (payload, currentAsset) {
  if (!payload || typeof payload !== 'object') throw new Error('Missing capture payload')
  if (!currentAsset || payload.asset !== currentAsset.path || Number(payload.caseIndex) !== currentAsset.caseIndex) {
    throw new Error('Capture asset does not match the active scene')
  }

  const size = Number(payload.size)
  if (!ALLOWED_CAPTURE_SIZES.has(size)) throw new Error('Capture size must be 1024 or 2048')
  const png = toPngBuffer(payload.png)
  if (png.length === 0 || png.length > MAX_PNG_BYTES) {
    throw new Error(`Capture PNG must be between 1 byte and ${MAX_PNG_BYTES} bytes`)
  }
  const dimensions = readPngDimensions(png)
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(`Capture dimensions must be ${size}x${size}, got ${dimensions.width}x${dimensions.height}`)
  }

  const camera = payload.camera && typeof payload.camera === 'object' && !Array.isArray(payload.camera) ? payload.camera : null
  const pixal3d = payload.pixal3d && typeof payload.pixal3d === 'object' && !Array.isArray(payload.pixal3d) ? payload.pixal3d : null
  const metadataSize = Buffer.byteLength(JSON.stringify({ camera, pixal3d }), 'utf8')
  if (metadataSize > MAX_METADATA_BYTES) throw new Error('Capture metadata is too large')

  return { size, png, camera, pixal3d }
}

function queueSerial (queueRef, task) {
  const run = queueRef.current.then(() => task())
  queueRef.current = run.catch(() => {})
  return run
}

async function ensureBuiltAssets (version) {
  const requiredPaths = [
    path.join(STATIC_DIR, 'index.js'),
    path.join(VENDORED_VIEWER_PUBLIC_DIR, 'worker.js'),
    path.join(VENDORED_VIEWER_PUBLIC_DIR, 'textures', `${version}.png`),
    path.join(VENDORED_VIEWER_PUBLIC_DIR, 'blocksStates', `${version}.json`)
  ]
  for (const filePath of requiredPaths) {
    try {
      await fs.access(filePath)
    } catch {
      throw new Error(`Missing built asset: ${path.relative(PROJECT_ROOT, filePath)}. Run "npm run build" first.`)
    }
  }
}

function makeStructureContext (assetPath, structureSize, originWorldPos) {
  return {
    asset: assetPath,
    source: {
      coordinateSpace: 'minecraft_unified_blocks',
      blockPoint: 'center',
      originWorld: originWorldPos,
      size: structureSize,
      pivotWorld: {
        x: originWorldPos.x + structureSize.x / 2,
        y: originWorldPos.y + structureSize.y / 2,
        z: originWorldPos.z + structureSize.z / 2
      }
    }
  }
}

async function persistCapture ({ outputDir, captureState, asset, payload }) {
  const imagesDir = path.join(outputDir, 'images')
  const metadataDir = path.join(outputDir, 'metadata')
  const manifestPath = path.join(outputDir, 'manifest.jsonl')
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(metadataDir, { recursive: true })
  const validated = validateCapturePayload(payload, asset)
  const current = captureState.get(asset.path) || { count: 0, maxViewIndex: 0 }
  let viewIndex = current.maxViewIndex + 1
  let basename
  let imagePath
  let metadataPath

  while (true) {
    basename = buildCaptureBasename(asset, viewIndex, validated.size)
    imagePath = path.join(imagesDir, basename + '.png')
    metadataPath = path.join(metadataDir, basename + '.json')
    const exists = await Promise.all([imagePath, metadataPath].map(async (filePath) => {
      try {
        await fs.access(filePath)
        return true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    }))
    if (!exists[0] && !exists[1]) break
    viewIndex++
  }

  const relativeImagePath = path.posix.join('images', basename + '.png')
  const relativeMetadataPath = path.posix.join('metadata', basename + '.json')
  const capturedAt = new Date().toISOString()
  const metadata = {
    asset_path: asset.path,
    case_index: asset.caseIndex,
    view_index: viewIndex,
    image_path: relativeImagePath,
    metadata_path: relativeMetadataPath,
    width: validated.size,
    height: validated.size,
    captured_at: capturedAt,
    camera: validated.camera,
    pixal3d: validated.pixal3d
  }
  const tempSuffix = `.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  const tempImagePath = imagePath + tempSuffix
  const tempMetadataPath = metadataPath + tempSuffix
  let imageCommitted = false
  let metadataCommitted = false

  try {
    await fs.writeFile(tempImagePath, validated.png, { flag: 'wx' })
    await fs.writeFile(tempMetadataPath, JSON.stringify(metadata, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    await fs.rename(tempImagePath, imagePath)
    imageCommitted = true
    await fs.rename(tempMetadataPath, metadataPath)
    metadataCommitted = true
    await fs.appendFile(manifestPath, JSON.stringify(metadata) + '\n', 'utf8')
  } catch (error) {
    await Promise.all([
      fs.rm(tempImagePath, { force: true }),
      fs.rm(tempMetadataPath, { force: true }),
      imageCommitted ? fs.rm(imagePath, { force: true }) : Promise.resolve(),
      metadataCommitted ? fs.rm(metadataPath, { force: true }) : Promise.resolve()
    ]).catch(() => {})
    throw error
  }

  captureState.set(asset.path, { count: current.count + 1, maxViewIndex: viewIndex })
  return metadata
}

async function runServer (options) {
  const listPath = path.resolve(process.cwd(), options.listPath)
  const listText = await fs.readFile(listPath, 'utf8').catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`Path list does not exist: ${listPath}`)
    throw error
  })
  const assetRefs = parsePathList(listText)
  const validatedAssets = await validateAssetEntries(options.assetRoot, assetRefs)
  const assets = validatedAssets.assets
  const outputDir = path.resolve(process.cwd(), options.output)
  const imagesDir = path.join(outputDir, 'images')
  const metadataDir = path.join(outputDir, 'metadata')
  await fs.mkdir(imagesDir, { recursive: true })
  await fs.mkdir(metadataDir, { recursive: true })
  await ensureBuiltAssets(options.version)

  const captureState = await scanCaptureState(imagesDir, assets)
  const World = require('prismarine-world')(options.version)
  const Chunk = require('prismarine-chunk')(options.version)
  const Block = require('prismarine-block')(options.version)
  let world = new World(() => new Chunk())
  let currentIndex = 0
  let currentFormat = assets[0].format
  let currentLoadError = null
  let currentSize = new Vec3(1, 1, 1)
  let currentOriginWorldPos = new Vec3(0, 60, 0)
  let currentCenter = new Vec3(0, 60, 0)
  const operationQueue = { current: Promise.resolve() }

  function currentAsset () {
    return assets[currentIndex]
  }

  function publicAsset (asset) {
    const state = captureState.get(asset.path) || { count: 0 }
    return { index: asset.index, caseIndex: asset.caseIndex, path: asset.path, captureCount: state.count }
  }

  function publicState () {
    return {
      assetRoot: validatedAssets.assetRoot,
      outputDir,
      currentIndex,
      assets: assets.map(publicAsset)
    }
  }

  async function loadAsset (index) {
    if (!Number.isInteger(index) || index < 0 || index >= assets.length) throw new Error(`Invalid scene index: ${index}`)
    currentIndex = index
    const asset = currentAsset()
    currentFormat = asset.format
    currentLoadError = null
    currentSize = new Vec3(1, 1, 1)
    currentOriginWorldPos = new Vec3(0, 60, 0)
    currentCenter = new Vec3(0, 60, 0)
    world = new World(() => new Chunk())

    try {
      const buffer = await fs.readFile(asset.resolvedPath)
      const unified = await loadUnifiedStructure(buffer, asset.format, {
        version: options.version,
        targetVersion: options.version,
        unknownPolicy: 'keep',
        logger: console
      })
      const result = await buildWorldFromUnifiedStructure({
        world,
        version: options.version,
        unified,
        Block,
        logger: console
      })
      currentSize = result.size
      currentOriginWorldPos = result.originWorldPos
      currentCenter = new Vec3(
        Math.floor(result.size.x / 2),
        result.originWorldPos.y + Math.floor(result.size.y / 2),
        Math.floor(result.size.z / 2)
      )
    } catch (error) {
      currentLoadError = error.message || String(error)
      world = new World(() => new Chunk())
    }
  }

  async function sendChunks (socket) {
    if (currentLoadError) return
    const minChunkX = Math.floor(currentOriginWorldPos.x / 16) - 1
    const maxChunkX = Math.floor((currentOriginWorldPos.x + currentSize.x - 1) / 16) + 1
    const minChunkZ = Math.floor(currentOriginWorldPos.z / 16) - 1
    const maxChunkZ = Math.floor((currentOriginWorldPos.z + currentSize.z - 1) / 16) + 1
    for (let x = minChunkX; x <= maxChunkX; x++) {
      for (let z = minChunkZ; z <= maxChunkZ; z++) {
        const chunkColumn = await world.getColumn(x, z)
        socket.emit('loadChunk', { x: x * 16, z: z * 16, chunk: chunkColumn.toJson() })
      }
    }
  }

  async function emitWorldState (socket) {
    const asset = currentAsset()
    const context = makeStructureContext(asset.path, currentSize, currentOriginWorldPos)
    socket.emit('version', options.version)
    await sendChunks(socket)
    socket.emit('position', { pos: currentCenter, addMesh: false })
    socket.emit('pixal3dExportContext', context)
    socket.emit('renderer:assetLoaded', {
      ok: !currentLoadError,
      error: currentLoadError,
      asset: publicAsset(asset),
      format: currentFormat,
      structure: context.source,
      state: publicState()
    })
  }

  await loadAsset(0)

  const express = require('express')
  const compression = require('compression')
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http, { maxHttpBufferSize: SOCKET_MAX_BUFFER_BYTES })

  app.get('/', (req, res) => res.sendFile(path.join(RENDERER_PUBLIC_DIR, 'renderer.html')))
  app.get('/viewer-preload.js', (req, res) => res.sendFile(path.join(VIEWER_RUNTIME_DIR, 'preload/viewer-preload.js')))
  app.get('/renderer.js', (req, res) => res.sendFile(path.join(RENDERER_SRC_DIR, 'client.js')))
  app.use(compression())
  app.use('/', express.static(STATIC_DIR))

  io.on('connection', (socket) => {
    emitWorldState(socket).catch((error) => {
      socket.emit('renderer:assetLoaded', { ok: false, error: error.message || String(error), state: publicState() })
    })

    socket.on('renderer:getState', (payload, ack) => {
      if (typeof ack === 'function') ack({ ok: true, state: publicState() })
    })

    socket.on('renderer:switchAsset', (payload, ack) => {
      const respond = (response) => { if (typeof ack === 'function') ack(response) }
      const index = Number(payload && payload.index)
      queueSerial(operationQueue, async () => {
        await loadAsset(index)
        await emitWorldState(socket)
        return publicState()
      }).then(
        (state) => respond({ ok: true, state }),
        (error) => respond({ ok: false, error: error.message || String(error), state: publicState() })
      )
    })

    socket.on('renderer:saveCapture', (payload, ack) => {
      const respond = (response) => { if (typeof ack === 'function') ack(response) }
      queueSerial(operationQueue, async () => {
        const metadata = await persistCapture({
          outputDir,
          captureState,
          asset: currentAsset(),
          payload
        })
        return { metadata, state: publicState() }
      }).then(
        (result) => respond({ ok: true, ...result }),
        (error) => respond({ ok: false, error: error.message || String(error), state: publicState() })
      )
    })
  })

  let currentPort = options.port
  const maxPort = Math.min(65536, options.port + 100)
  while (currentPort < maxPort) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        http.once('error', onError)
        http.listen(currentPort, () => {
          http.removeListener('error', onError)
          resolve()
        })
      })
      break
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error
      console.warn(`Port ${currentPort} in use, trying ${currentPort + 1}...`)
      currentPort++
    }
  }
  if (currentPort >= maxPort) throw new Error(`No available ports found between ${options.port} and ${maxPort - 1}`)

  console.log(`Schematic renderer running on *:${currentPort}`)
  console.log(`Path list: ${listPath}`)
  console.log(`Asset root: ${validatedAssets.assetRoot}`)
  console.log(`Output directory: ${outputDir}`)
  console.log(`Scenes: ${assets.length}`)
  console.log(`Open http://127.0.0.1:${currentPort}`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    showUsage()
    return
  }
  if (args.positional.length !== 1) {
    showUsage()
    throw new Error(args.positional.length === 0 ? 'Missing path list' : 'Expected exactly one path list')
  }
  if (!args.assetRoot) throw new Error('Missing required --asset-root')
  if (!args.output) throw new Error('Missing required --output')
  await runServer({
    listPath: args.positional[0],
    assetRoot: args.assetRoot,
    output: args.output,
    version: args.version,
    port: args.port
  })
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
  })
}

module.exports = {
  ALLOWED_CAPTURE_SIZES,
  MAX_PNG_BYTES,
  buildCaptureBasename,
  parseArgs,
  parsePathList,
  persistCapture,
  readPngDimensions,
  sanitizeStem,
  scanCaptureState,
  validateAssetEntries,
  validateCapturePayload
}
