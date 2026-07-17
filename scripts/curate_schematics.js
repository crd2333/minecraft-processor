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
const CURATOR_PUBLIC_DIR = path.join(PROJECT_ROOT, 'apps/frontend/curator/public')
const CURATOR_SRC_DIR = path.join(PROJECT_ROOT, 'apps/frontend/curator/src')

const CSV_COLUMNS = [
  'asset_path',
  'rating',
  'width',
  'height',
  'length',
  'max_size',
  'block_count',
  'palette_size',
  'reviewed_at'
]
const ALLOWED_RATINGS = new Set(['unrated', 'keep', 'maybe', 'functional', 'reject'])

function showUsage () {
  console.log([
    'Usage:',
    '  node scripts/curate_schematics.js <asset-directory> [options]',
    '',
    'Options:',
    '      --output <path>       Ratings CSV path (default: <asset-directory>/curation-ratings.csv)',
    '  -v, --version <version>   Minecraft/viewer version (default: ' + defaultViewerVersion + ')',
    '  -p, --port <port>         Preferred port (default: 3100)',
    '  -h, --help                Show this help'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    output: null,
    version: defaultViewerVersion,
    port: 3100,
    viewDistance: 8,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }
    if (arg === '--output') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --output')
      result.output = value
      i++
      continue
    }
    if (arg === '-v' || arg === '--version') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --version')
      result.version = value
      i++
      continue
    }
    if (arg === '-p' || arg === '--port') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --port')
      const port = Number(value)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error('Invalid --port, expected an integer from 1 to 65535')
      }
      result.port = port
      i++
      continue
    }

    result.positional.push(arg)
  }

  return result
}

function normalizePathForClient (value) {
  return value.split(path.sep).join('/')
}

function isPathInsideBase (baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath)
  return !(relative.startsWith('..') || path.isAbsolute(relative))
}

async function discoverSchemAssets (assetDir) {
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
      if (path.extname(entry.name).toLowerCase() !== '.schem') continue
      assets.push(normalizePathForClient(path.relative(assetDir, fullPath)))
    }
  }

  await walk(assetDir)
  assets.sort((a, b) => a.localeCompare(b))
  return assets
}

function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      if (field.length > 0) throw new Error('Malformed CSV: quote inside unquoted field')
      inQuotes = true
      continue
    }
    if (ch === ',') {
      row.push(field)
      field = ''
      continue
    }
    if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      continue
    }

    field += ch
  }

  if (inQuotes) throw new Error('Malformed CSV: unterminated quoted field')
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

function escapeCsvField (value) {
  const text = value === null || value === undefined ? '' : String(value)
  if (!/[",\r\n]/.test(text)) return text
  return '"' + text.replace(/"/g, '""') + '"'
}

function serializeCsvRows (rows) {
  const lines = [CSV_COLUMNS]
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => row[column] ?? ''))
  return lines.map((fields) => fields.map(escapeCsvField).join(',')).join('\n') + '\n'
}

function validateRating (rating, assetPath = null) {
  if (!ALLOWED_RATINGS.has(rating)) {
    throw new Error(`Invalid rating${assetPath ? ` for ${assetPath}` : ''}: ${rating}`)
  }
}

function parseCsvRowsToObjects (text) {
  const parsed = parseCsv(text)
  if (parsed.length === 0) return []
  const header = parsed[0]
  if (header.join(',') !== CSV_COLUMNS.join(',')) {
    throw new Error(`Invalid CSV header. Expected: ${CSV_COLUMNS.join(',')}`)
  }

  const seen = new Set()
  const rows = []
  for (let i = 1; i < parsed.length; i++) {
    const fields = parsed[i]
    if (fields.length === 1 && fields[0] === '') continue
    if (fields.length !== CSV_COLUMNS.length) {
      throw new Error(`Invalid CSV row ${i + 1}: expected ${CSV_COLUMNS.length} fields, got ${fields.length}`)
    }
    const row = {}
    for (let j = 0; j < CSV_COLUMNS.length; j++) row[CSV_COLUMNS[j]] = fields[j]
    if (!row.asset_path) throw new Error(`Invalid CSV row ${i + 1}: asset_path is required`)
    if (seen.has(row.asset_path)) throw new Error(`Duplicate CSV asset row: ${row.asset_path}`)
    seen.add(row.asset_path)
    validateRating(row.rating, row.asset_path)
    validateNumericField(row, 'width')
    validateNumericField(row, 'height')
    validateNumericField(row, 'length')
    validateNumericField(row, 'max_size')
    validateNumericField(row, 'block_count')
    validateNumericField(row, 'palette_size')
    rows.push(row)
  }
  return rows
}

function validateNumericField (row, fieldName) {
  const value = row[fieldName]
  if (value === '') return
  if (!Number.isInteger(Number(value)) || Number(value) < 0) {
    throw new Error(`Invalid ${fieldName} for ${row.asset_path}: ${value}`)
  }
}

async function readCsvRows (csvPath) {
  try {
    const text = await fs.readFile(csvPath, 'utf8')
    return parseCsvRowsToObjects(text)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

function makeEmptyRow (assetPath) {
  return {
    asset_path: assetPath,
    rating: 'unrated',
    width: '',
    height: '',
    length: '',
    max_size: '',
    block_count: '',
    palette_size: '',
    reviewed_at: ''
  }
}

function mergeAssetRows (assetPaths, existingRows) {
  const existingByPath = new Map(existingRows.map((row) => [row.asset_path, row]))
  return assetPaths.map((assetPath) => {
    const existing = existingByPath.get(assetPath)
    return existing ? { ...makeEmptyRow(assetPath), ...existing } : makeEmptyRow(assetPath)
  })
}

function summarizeRows (rows) {
  const counts = {
    unrated: 0,
    keep: 0,
    maybe: 0,
    functional: 0,
    reject: 0
  }
  for (const row of rows) counts[row.rating] = (counts[row.rating] || 0) + 1
  return {
    total: rows.length,
    reviewed: rows.length - counts.unrated,
    counts
  }
}

function selectInitialAsset (rows) {
  const unrated = rows.find((row) => row.rating === 'unrated')
  return (unrated || rows[0] || null)?.asset_path || null
}

async function writeCsvRowsAtomic (csvPath, rows) {
  await fs.mkdir(path.dirname(csvPath), { recursive: true })
  const tempPath = path.join(
    path.dirname(csvPath),
    `.${path.basename(csvPath)}.${process.pid}.${Date.now()}.tmp`
  )
  await fs.writeFile(tempPath, serializeCsvRows(rows), 'utf8')
  await fs.rename(tempPath, csvPath)
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
      throw new Error(`Missing built asset: ${path.relative(PROJECT_ROOT, filePath)}. Run "npm run build" in minecraft-processor first.`)
    }
  }
}

function rowToPublic (row) {
  return { ...row }
}

function rowsToPublic (rows) {
  return rows.map(rowToPublic)
}

function makePublicState (rows, currentAsset, csvPath) {
  return {
    csvPath,
    currentAsset,
    rows: rowsToPublic(rows),
    summary: summarizeRows(rows)
  }
}

function metricValue (value) {
  return value === '' ? null : Number(value)
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
        x: (originWorldPos ? originWorldPos.x : 0) + structureSize.x / 2,
        y: (originWorldPos ? originWorldPos.y : 60) + structureSize.y / 2,
        z: (originWorldPos ? originWorldPos.z : 0) + structureSize.z / 2
      }
    }
  }
}

async function runServer (options) {
  const viewDistance = Number.isInteger(options.viewDistance) ? options.viewDistance : 8
  const assetDir = path.resolve(process.cwd(), options.assetDir)
  const stat = await fs.stat(assetDir).catch(() => null)
  if (!stat || !stat.isDirectory()) throw new Error(`Asset directory does not exist: ${assetDir}`)

  const csvPath = path.resolve(process.cwd(), options.output || path.join(assetDir, 'curation-ratings.csv'))
  const assetPaths = await discoverSchemAssets(assetDir)
  if (assetPaths.length === 0) throw new Error(`No .schem files found under ${assetDir}`)

  await ensureBuiltAssets(options.version)

  let rows = mergeAssetRows(assetPaths, await readCsvRows(csvPath))
  const rowsByPath = new Map(rows.map((row) => [row.asset_path, row]))
  let currentAsset = selectInitialAsset(rows)

  await writeCsvRowsAtomic(csvPath, rows)

  const World = require('prismarine-world')(options.version)
  const Chunk = require('prismarine-chunk')(options.version)
  const Block = require('prismarine-block')(options.version)

  let world = new World(() => new Chunk())
  let currentFormat = null
  let currentLoadError = null
  let currentSize = new Vec3(1, 1, 1)
  let currentOriginWorldPos = new Vec3(0, 60, 0)
  let currentCenter = new Vec3(0, 60, 0)

  const writeQueue = { current: Promise.resolve() }
  const switchQueue = { current: Promise.resolve() }

  function resolveAssetPath (assetRef) {
    if (typeof assetRef !== 'string' || !assetRef.trim()) throw new Error('Missing asset path')
    if (!rowsByPath.has(assetRef)) throw new Error(`Unknown asset: ${assetRef}`)

    const resolvedPath = path.resolve(assetDir, assetRef)
    if (!isPathInsideBase(assetDir, resolvedPath)) {
      throw new Error(`Asset path must stay within ${assetDir}`)
    }
    if (path.extname(resolvedPath).toLowerCase() !== '.schem') {
      throw new Error(`Unsupported asset extension: ${path.extname(resolvedPath) || '(none)'}`)
    }
    return resolvedPath
  }

  async function persistRows () {
    await queueSerial(writeQueue, async () => {
      await writeCsvRowsAtomic(csvPath, rows)
    })
  }

  function updateMetricsForCurrentRow (unified) {
    const row = rowsByPath.get(currentAsset)
    if (!row || !Array.isArray(unified?.size)) return false

    const width = Math.max(1, Number(unified.size[0]) || 1)
    const height = Math.max(1, Number(unified.size[1]) || 1)
    const length = Math.max(1, Number(unified.size[2]) || 1)
    const next = {
      width: String(width),
      height: String(height),
      length: String(length),
      max_size: String(Math.max(width, height, length)),
      block_count: String(Array.isArray(unified.blocks) ? unified.blocks.length : 0),
      palette_size: String(Array.isArray(unified.palette) ? unified.palette.length : 0)
    }

    let changed = false
    for (const [key, value] of Object.entries(next)) {
      if (row[key] !== value) {
        row[key] = value
        changed = true
      }
    }
    return changed
  }

  async function loadAssetWorld (assetRef) {
    currentAsset = assetRef
    currentFormat = 'schem'
    currentLoadError = null
    currentSize = new Vec3(
      metricValue(rowsByPath.get(assetRef)?.width) || 1,
      metricValue(rowsByPath.get(assetRef)?.height) || 1,
      metricValue(rowsByPath.get(assetRef)?.length) || 1
    )
    currentOriginWorldPos = new Vec3(0, 60, 0)
    currentCenter = new Vec3(Math.floor(currentSize.x / 2), 60 + Math.floor(currentSize.y / 2), Math.floor(currentSize.z / 2))
    world = new World(() => new Chunk())

    try {
      const resolvedPath = resolveAssetPath(assetRef)
      const buffer = await fs.readFile(resolvedPath)
      const format = detectStructureFormat(resolvedPath)
      currentFormat = format
      const unified = await loadUnifiedStructure(buffer, format, {
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
      if (updateMetricsForCurrentRow(unified)) await persistRows()
    } catch (error) {
      currentLoadError = error.message || String(error)
      world = new World(() => new Chunk())
    }
  }

  async function sendChunks (socket) {
    if (currentLoadError) return
    const cx = Math.floor(currentCenter.x / 16)
    const cz = Math.floor(currentCenter.z / 16)
    for (let x = cx - viewDistance; x <= cx + viewDistance; x++) {
      for (let z = cz - viewDistance; z <= cz + viewDistance; z++) {
        const chunkColumn = await world.getColumn(x, z)
        socket.emit('loadChunk', { x: x * 16, z: z * 16, chunk: chunkColumn.toJson() })
      }
    }
  }

  async function emitWorldState (socket) {
    socket.emit('version', options.version)
    await sendChunks(socket)
    socket.emit('position', { pos: currentCenter, addMesh: false })
    socket.emit('pixal3dExportContext', makeStructureContext(currentAsset, currentSize, currentOriginWorldPos))
    socket.emit('curator:assetLoaded', {
      ok: !currentLoadError,
      error: currentLoadError,
      asset: currentAsset,
      row: rowToPublic(rowsByPath.get(currentAsset)),
      format: currentFormat,
      structure: makeStructureContext(currentAsset, currentSize, currentOriginWorldPos).source
    })
  }

  await loadAssetWorld(currentAsset)

  const express = require('express')
  const compression = require('compression')
  const app = express()
  const http = require('http').createServer(app)
  const io = require('socket.io')(http)

  app.get('/', (req, res) => res.sendFile(path.join(CURATOR_PUBLIC_DIR, 'curator.html')))
  app.get('/viewer-preload.js', (req, res) => {
    res.sendFile(path.join(VIEWER_RUNTIME_DIR, 'preload/viewer-preload.js'))
  })
  app.get('/curator.js', (req, res) => res.sendFile(path.join(CURATOR_SRC_DIR, 'client.js')))
  app.use(compression())
  app.use('/', express.static(STATIC_DIR))

  io.on('connection', (socket) => {
    emitWorldState(socket).catch((error) => {
      socket.emit('curator:assetLoaded', { ok: false, asset: currentAsset, error: error.message || String(error) })
    })

    socket.on('curator:getState', (payload, ack) => {
      if (typeof ack === 'function') {
        ack({ ok: true, state: makePublicState(rows, currentAsset, csvPath) })
      }
    })

    socket.on('curator:switchAsset', async (payload, ack) => {
      const respond = (response) => { if (typeof ack === 'function') ack(response) }
      try {
        const asset = payload && typeof payload.asset === 'string' ? payload.asset : ''
        await queueSerial(switchQueue, async () => {
          resolveAssetPath(asset)
          await loadAssetWorld(asset)
          await emitWorldState(socket)
        })
        respond({ ok: true, state: makePublicState(rows, currentAsset, csvPath) })
      } catch (error) {
        respond({ ok: false, error: error.message || String(error), state: makePublicState(rows, currentAsset, csvPath) })
      }
    })

    socket.on('curator:rateAsset', async (payload, ack) => {
      const respond = (response) => { if (typeof ack === 'function') ack(response) }
      try {
        const asset = payload && typeof payload.asset === 'string' ? payload.asset : ''
        const rating = payload && typeof payload.rating === 'string' ? payload.rating : ''
        resolveAssetPath(asset)
        validateRating(rating, asset)
        const row = rowsByPath.get(asset)
        row.rating = rating
        row.reviewed_at = new Date().toISOString()
        await persistRows()
        respond({ ok: true, row: rowToPublic(row), state: makePublicState(rows, currentAsset, csvPath) })
      } catch (error) {
        respond({ ok: false, error: error.message || String(error), state: makePublicState(rows, currentAsset, csvPath) })
      }
    })
  })

  let currentPort = options.port
  const maxPort = options.port + 100
  while (currentPort < maxPort) {
    try {
      await new Promise((resolve, reject) => {
        http.listen(currentPort, () => resolve()).on('error', reject)
      })
      break
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        console.warn(`Port ${currentPort} in use, trying ${currentPort + 1}...`)
        currentPort++
      } else {
        throw error
      }
    }
  }
  if (currentPort === maxPort) throw new Error(`No available ports found between ${options.port} and ${maxPort - 1}`)

  console.log(`Schematic curator running on *:${currentPort}`)
  console.log(`Asset directory: ${assetDir}`)
  console.log(`Ratings CSV: ${csvPath}`)
  console.log(`Assets: ${rows.length}`)
  console.log(`Open http://127.0.0.1:${currentPort}`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    showUsage()
    return
  }
  const assetDir = args.positional[0]
  if (!assetDir) {
    showUsage()
    throw new Error('Missing asset directory')
  }
  await runServer({ assetDir, output: args.output, version: args.version, port: args.port, viewDistance: args.viewDistance })
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error)
    process.exit(1)
  })
}

module.exports = {
  ALLOWED_RATINGS,
  CSV_COLUMNS,
  discoverSchemAssets,
  mergeAssetRows,
  parseCsv,
  parseCsvRowsToObjects,
  selectInitialAsset,
  serializeCsvRows,
  summarizeRows,
  validateRating,
  writeCsvRowsAtomic
}
