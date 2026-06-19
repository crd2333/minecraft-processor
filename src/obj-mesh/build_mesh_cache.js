const path = require('path')
const fs = require('fs').promises
const fsSync = require('fs')
const readline = require('readline')
const crypto = require('crypto')
const { parseMinewaysObj } = require('./parse_mineways_obj')
const { parseMtlFile } = require('./mtl_parser')

const CACHE_SCHEMA_VERSION = 1
const CACHE_PARSER_VERSION = 'mineways-obj-cache-v2'
const BUFFER_FILES = {
  positions: 'positions.f32',
  normals: 'normals.f32',
  uvs: 'uvs.f32',
  indices: 'indices.u32'
}

async function pathExists (filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

function typedArrayToBuffer (array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
}

async function discoverMtllibPath (objPath) {
  const input = fsSync.createReadStream(objPath, { encoding: 'utf8', start: 0 })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let lineCount = 0

  try {
    for await (const rawLine of rl) {
      lineCount++
      const line = rawLine.trim()
      if (line.startsWith('mtllib ')) {
        const mtlRef = line.slice('mtllib '.length).trim()
        if (mtlRef) return path.resolve(path.dirname(objPath), mtlRef)
      }
      if (line.startsWith('v ') || lineCount > 10000) break
    }
  } finally {
    rl.close()
    input.destroy()
  }

  const fallback = path.join(path.dirname(objPath), `${path.basename(objPath, path.extname(objPath))}.mtl`)
  return (await pathExists(fallback)) ? fallback : null
}

async function statForKey (filePath) {
  if (!filePath) return null
  try {
    const stat = await fs.stat(filePath)
    return {
      path: path.resolve(filePath),
      size: stat.size,
      mtimeMs: stat.mtimeMs
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return null
    throw error
  }
}

function makeCacheKey (parts) {
  const hash = crypto.createHash('sha1')
  hash.update(JSON.stringify(parts))
  return hash.digest('hex')
}

function materialToJson (material, sourceDir) {
  const mapKdPath = material && material.mapKdPath ? path.resolve(material.mapKdPath) : null
  const mapDPath = material && material.mapDPath ? path.resolve(material.mapDPath) : null
  return {
    name: material.name,
    diffuse: material.diffuse,
    ambient: material.ambient,
    specular: material.specular,
    shininess: material.shininess,
    opacity: material.opacity,
    mapKd: material.mapKd || null,
    mapD: material.mapD || null,
    mapKdFile: mapKdPath ? path.basename(mapKdPath) : null,
    mapDFile: mapDPath ? path.basename(mapDPath) : null,
    mapKdPath: mapKdPath && path.relative(sourceDir, mapKdPath),
    mapDPath: mapDPath && path.relative(sourceDir, mapDPath)
  }
}

async function findPreferredAtlas (objPath, mtlMaterials) {
  const sourceDir = path.dirname(objPath)
  const base = path.basename(objPath, path.extname(objPath))
  const candidates = [
    path.join(sourceDir, `${base}-RGBA.png`),
    path.join(sourceDir, `${base}-RGB.png`),
    path.join(sourceDir, `${base}.png`)
  ]

  for (const material of mtlMaterials.values()) {
    if (material.mapKdPath) candidates.push(material.mapKdPath)
  }

  for (const candidate of candidates) {
    if (candidate && await pathExists(candidate)) return path.resolve(candidate)
  }
  return null
}

async function readCachedMeshJson (cacheDir) {
  const meshJsonPath = path.join(cacheDir, 'mesh.json')
  const text = await fs.readFile(meshJsonPath, 'utf8')
  return JSON.parse(text)
}

async function isCacheComplete (cacheDir) {
  if (!await pathExists(path.join(cacheDir, 'mesh.json'))) return false
  for (const fileName of Object.values(BUFFER_FILES)) {
    if (!await pathExists(path.join(cacheDir, fileName))) return false
  }
  return true
}

async function writeMeshCache (cacheDir, mesh, context) {
  await fs.mkdir(cacheDir, { recursive: true })

  await fs.writeFile(path.join(cacheDir, BUFFER_FILES.positions), typedArrayToBuffer(mesh.positions))
  await fs.writeFile(path.join(cacheDir, BUFFER_FILES.normals), typedArrayToBuffer(mesh.normals))
  await fs.writeFile(path.join(cacheDir, BUFFER_FILES.uvs), typedArrayToBuffer(mesh.uvs))
  await fs.writeFile(path.join(cacheDir, BUFFER_FILES.indices), typedArrayToBuffer(mesh.indices))

  const materials = mesh.groups.map((group) => {
    const mtlMaterial = context.mtlMaterials.get(group.name)
    const material = mtlMaterial
      ? materialToJson(mtlMaterial, context.sourceDir)
      : {
          name: group.name,
          diffuse: [1, 1, 1],
          ambient: [0.2, 0.2, 0.2],
          specular: [0, 0, 0],
          shininess: 0,
          opacity: 1,
          mapKd: null,
          mapD: null,
          mapKdFile: null,
          mapDFile: null,
          mapKdPath: null,
          mapDPath: null
        }
    if (context.preferredAtlasPath) {
      material.mapKdFile = path.basename(context.preferredAtlasPath)
      material.mapKdPath = path.relative(context.sourceDir, context.preferredAtlasPath)
    }
    return material
  })

  const meshJson = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    parserVersion: CACHE_PARSER_VERSION,
    source: context.source,
    buffers: BUFFER_FILES,
    counts: {
      vertexCount: mesh.metadata.vertexCount,
      indexCount: mesh.indices.length,
      triangleCount: mesh.metadata.triangleCount,
      faceCount: mesh.metadata.faceCount
    },
    bounds: mesh.metadata.bounds,
    mineways: mesh.metadata.mineways,
    groups: mesh.groups,
    materials
  }

  await fs.writeFile(path.join(cacheDir, 'mesh.json'), JSON.stringify(meshJson, null, 2))
  return meshJson
}

async function prepareMinewaysObjCache (inputPath, options = {}) {
  const objPath = path.resolve(inputPath)
  const cacheRoot = path.resolve(options.cacheDir || path.join(process.cwd(), '.cache', 'mineways-obj'))
  const objStat = await statForKey(objPath)
  if (!objStat) throw new Error(`OBJ file not found: ${objPath}`)

  const mtlPath = await discoverMtllibPath(objPath)
  const mtlStat = await statForKey(mtlPath)
  const mtlMaterials = mtlPath ? await parseMtlFile(mtlPath) : new Map()
  const preferredAtlasPath = await findPreferredAtlas(objPath, mtlMaterials)

  const source = {
    obj: objStat,
    mtl: mtlStat,
    preferredAtlas: preferredAtlasPath ? path.resolve(preferredAtlasPath) : null
  }
  const cacheKey = makeCacheKey({
    parserVersion: CACHE_PARSER_VERSION,
    obj: objStat,
    mtl: mtlStat
  })
  const cacheDir = path.join(cacheRoot, cacheKey)

  if (await isCacheComplete(cacheDir)) {
    return {
      cacheDir,
      cacheKey,
      mesh: await readCachedMeshJson(cacheDir),
      sourceDir: path.dirname(objPath),
      mtlPath,
      preferredAtlasPath,
      cacheHit: true
    }
  }

  const parsed = await parseMinewaysObj(objPath)
  const mesh = await writeMeshCache(cacheDir, parsed, {
    source,
    sourceDir: path.dirname(objPath),
    mtlMaterials,
    preferredAtlasPath
  })

  return {
    cacheDir,
    cacheKey,
    mesh,
    sourceDir: path.dirname(objPath),
    mtlPath,
    preferredAtlasPath,
    cacheHit: false
  }
}

module.exports = {
  CACHE_PARSER_VERSION,
  CACHE_SCHEMA_VERSION,
  BUFFER_FILES,
  prepareMinewaysObjCache
}
