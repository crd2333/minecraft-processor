const path = require('path')
const fs = require('fs').promises
const { prepareMinewaysObjCache } = require('../../src/obj-mesh/build_mesh_cache')

const PROJECT_ROOT = path.resolve(__dirname, '../..')
const STATIC_DIR = path.join(PROJECT_ROOT, 'static')
const OBJ_VIEWER_PUBLIC_DIR = path.join(PROJECT_ROOT, 'apps/frontend/obj-viewer/public')
const SUPPORTED_OBJ_EXTENSIONS = new Set(['.obj'])
const MESH_BUFFER_FILES = new Set(['positions.f32', 'normals.f32', 'uvs.f32', 'indices.u32'])

function parseArgs (argv) {
  const result = {
    positional: [],
    port: 3000,
    cacheDir: path.join(PROJECT_ROOT, '.cache', 'mineways-obj')
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --port')
      result.port = Number(value)
      i++
      continue
    }
    if (arg === '--cache-dir') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --cache-dir')
      result.cacheDir = path.resolve(process.cwd(), value)
      i++
      continue
    }
    result.positional.push(arg)
  }

  if (!Number.isInteger(result.port) || result.port <= 0) {
    throw new Error('Invalid --port, expected a positive integer')
  }

  return result
}

function isPathInsideBase (baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath)
  return !(relative.startsWith('..') || path.isAbsolute(relative))
}

async function ensureBuiltAssets () {
  const requiredPaths = [
    path.join(STATIC_DIR, 'obj-viewer.js')
  ]

  for (const filePath of requiredPaths) {
    try {
      await fs.access(filePath)
    } catch {
      throw new Error(`Missing built asset: ${path.relative(PROJECT_ROOT, filePath)}. Run "npm run build" in minecraft-processor first.`)
    }
  }
}

function makeTextureRegistry (mesh, sourceDir) {
  const registry = new Map()

  function addTexture (relativePath) {
    if (!relativePath) return null
    const absolutePath = path.resolve(sourceDir, relativePath)
    if (!isPathInsideBase(sourceDir, absolutePath)) return null
    const key = path.basename(absolutePath)
    registry.set(key, absolutePath)
    return `/api/mesh/texture/${encodeURIComponent(key)}`
  }

  const materials = mesh.materials.map((material) => {
    const mapKdUrl = addTexture(material.mapKdPath)
    const mapDUrl = addTexture(material.mapDPath)
    return {
      ...material,
      mapKdUrl,
      mapDUrl
    }
  })

  return { materials, registry }
}

function makeClientMeshPayload (mesh, sourceDir) {
  const { materials, registry } = makeTextureRegistry(mesh, sourceDir)
  return {
    clientMesh: {
      schemaVersion: mesh.schemaVersion,
      parserVersion: mesh.parserVersion,
      source: mesh.source,
      counts: mesh.counts,
      bounds: mesh.bounds,
      mineways: mesh.mineways,
      buffers: {
        positions: '/api/mesh/buffer/positions.f32',
        normals: '/api/mesh/buffer/normals.f32',
        uvs: '/api/mesh/buffer/uvs.f32',
        indices: '/api/mesh/buffer/indices.u32'
      },
      groups: mesh.groups,
      materials,
      textureKeys: Array.from(registry.keys())
    },
    textureRegistry: registry
  }
}

async function listenWithPortRetry (http, port) {
  let currentPort = port
  const maxPort = port + 100

  while (currentPort < maxPort) {
    try {
      await new Promise((resolve, reject) => {
        http.listen(currentPort, () => resolve()).on('error', reject)
      })
      return currentPort
    } catch (error) {
      if (error.code === 'EADDRINUSE') {
        console.warn(`Port ${currentPort} in use, trying ${currentPort + 1}...`)
        currentPort++
        continue
      }
      throw error
    }
  }

  throw new Error(`No available ports found between ${port} and ${maxPort - 1}`)
}

async function main () {
  const { positional, port, cacheDir } = parseArgs(process.argv.slice(2))
  const inputArg = positional[0]

  if (!inputArg) {
    console.error('Usage: node serve_mc_obj.js <file.obj> [--port <port>] [--cache-dir <dir>]')
    process.exit(1)
  }

  const inputPath = path.resolve(process.cwd(), inputArg)
  const ext = path.extname(inputPath).toLowerCase()
  if (!SUPPORTED_OBJ_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported OBJ viewer input extension: ${ext || '(none)'}`)
  }

  await ensureBuiltAssets()

  console.log(`Preparing Mineways OBJ mesh cache for ${inputPath}`)
  const cache = await prepareMinewaysObjCache(inputPath, { cacheDir })
  const { clientMesh, textureRegistry } = makeClientMeshPayload(cache.mesh, cache.sourceDir)

  const express = require('express')
  const compression = require('compression')
  const app = express()
  const http = require('http').createServer(app)

  app.use(compression())
  app.get('/', (req, res) => res.sendFile(path.join(OBJ_VIEWER_PUBLIC_DIR, 'obj-viewer.html')))
  app.get('/obj-viewer.js', (req, res) => res.sendFile(path.join(STATIC_DIR, 'obj-viewer.js')))
  app.get('/api/mesh', (req, res) => res.json(clientMesh))

  app.get('/api/mesh/buffer/:file', (req, res) => {
    const fileName = path.basename(req.params.file)
    if (!MESH_BUFFER_FILES.has(fileName)) {
      res.status(404).json({ error: 'Unknown mesh buffer' })
      return
    }
    res.sendFile(path.join(cache.cacheDir, fileName))
  })

  app.get('/api/mesh/texture/:key', (req, res) => {
    const key = path.basename(req.params.key)
    const texturePath = textureRegistry.get(key)
    if (!texturePath) {
      res.status(404).json({ error: 'Unknown mesh texture' })
      return
    }
    res.sendFile(texturePath)
  })

  const currentPort = await listenWithPortRetry(http, port)

  console.log(`Mineways OBJ viewer web server running on *:${currentPort}`)
  console.log(`OBJ loaded: ${inputPath}`)
  console.log(`Cache ${cache.cacheHit ? 'hit' : 'created'}: ${cache.cacheDir}`)
  console.log(`Mesh vertices: ${cache.mesh.counts.vertexCount}`)
  console.log(`Mesh triangles: ${cache.mesh.counts.triangleCount}`)
  console.log(`Material groups: ${cache.mesh.groups.length}`)
  if (cache.preferredAtlasPath) console.log(`Texture atlas: ${cache.preferredAtlasPath}`)
  console.log(`Open http://127.0.0.1:${currentPort}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
