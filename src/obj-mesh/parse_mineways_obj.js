const fs = require('fs')
const readline = require('readline')

const DEFAULT_MATERIAL = '__default__'

function splitDataLine (line) {
  const hashIndex = line.indexOf('#')
  const withoutComment = hashIndex === -1 ? line : line.slice(0, hashIndex)
  return withoutComment.trim().split(/\s+/).filter(Boolean)
}

function parseVectorTuple (parts, expectedLength) {
  if (parts.length < expectedLength) return null
  const values = parts.slice(0, expectedLength).map(Number)
  return values.every(Number.isFinite) ? values : null
}

function parseHeaderValue (value) {
  const trimmed = value.trim()
  const tuple = /^\(([^)]+)\)$/.exec(trimmed)
  if (tuple) {
    return tuple[1].split(',').map((part) => {
      const number = Number(part.trim())
      return Number.isFinite(number) ? number : part.trim()
    })
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true'
  const number = Number(trimmed)
  return Number.isFinite(number) ? number : trimmed
}

function parseMinewaysComment (line, metadata) {
  const commonMatch = /^#\s*([a-zA-Z0-9_]+):\s*(.+)$/.exec(line)
  if (commonMatch) {
    metadata[commonMatch[1]] = parseHeaderValue(commonMatch[2])
    return
  }

  const countsMatch = /^#\s*(\d+)\s+vertices,\s+(\d+)\s+faces\s+\((\d+)\s+triangles\),\s+(\d+)\s+blocks/.exec(line)
  if (countsMatch) {
    metadata.advertisedCounts = {
      vertices: Number(countsMatch[1]),
      faces: Number(countsMatch[2]),
      triangles: Number(countsMatch[3]),
      blocks: Number(countsMatch[4])
    }
  }
}

function resolveObjIndex (rawValue, count, required, lineNumber) {
  if (!rawValue) {
    if (required) throw new Error(`Missing required face index at OBJ line ${lineNumber}`)
    return -1
  }

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value === 0) {
    throw new Error(`Invalid face index "${rawValue}" at OBJ line ${lineNumber}`)
  }

  const index = value < 0 ? count + value : value - 1
  if (index < 0 || index >= count) {
    throw new Error(`Face index "${rawValue}" is out of range at OBJ line ${lineNumber}`)
  }
  return index
}

function parseFaceToken (token, counts, lineNumber) {
  const parts = token.split('/')
  return {
    v: resolveObjIndex(parts[0], counts.positions, true, lineNumber),
    vt: resolveObjIndex(parts[1], counts.uvs, false, lineNumber),
    vn: resolveObjIndex(parts[2], counts.normals, false, lineNumber)
  }
}

function updateBounds (bounds, x, y, z) {
  if (x < bounds.min[0]) bounds.min[0] = x
  if (y < bounds.min[1]) bounds.min[1] = y
  if (z < bounds.min[2]) bounds.min[2] = z
  if (x > bounds.max[0]) bounds.max[0] = x
  if (y > bounds.max[1]) bounds.max[1] = y
  if (z > bounds.max[2]) bounds.max[2] = z
}

function ensureMaterialBucket (state, materialName) {
  const key = materialName || DEFAULT_MATERIAL
  let bucket = state.materialBuckets.get(key)
  if (!bucket) {
    bucket = []
    state.materialBuckets.set(key, bucket)
    state.materialOrder.push(key)
  }
  return bucket
}

function getOrCreateVertex (state, faceVertex) {
  const key = `${faceVertex.v}/${faceVertex.vt}/${faceVertex.vn}`
  const existing = state.vertexMap.get(key)
  if (existing !== undefined) return existing

  const outIndex = state.vertexCount
  state.vertexCount++
  state.vertexMap.set(key, outIndex)

  const posOffset = faceVertex.v * 3
  const x = state.sourcePositions[posOffset]
  const y = state.sourcePositions[posOffset + 1]
  const z = state.sourcePositions[posOffset + 2]
  state.positions.push(x, y, z)
  updateBounds(state.bounds, x, y, z)

  if (faceVertex.vn >= 0) {
    const normalOffset = faceVertex.vn * 3
    state.normals.push(
      state.sourceNormals[normalOffset],
      state.sourceNormals[normalOffset + 1],
      state.sourceNormals[normalOffset + 2]
    )
  } else {
    state.normals.push(0, 1, 0)
  }

  if (faceVertex.vt >= 0) {
    const uvOffset = faceVertex.vt * 2
    state.uvs.push(state.sourceUvs[uvOffset], state.sourceUvs[uvOffset + 1])
  } else {
    state.uvs.push(0, 0)
  }

  return outIndex
}

function appendTriangle (state, bucket, a, b, c) {
  bucket.push(
    getOrCreateVertex(state, a),
    getOrCreateVertex(state, b),
    getOrCreateVertex(state, c)
  )
  state.triangleCount++
}

async function parseMinewaysObj (objPath, options = {}) {
  const state = {
    sourcePositions: [],
    sourceNormals: [],
    sourceUvs: [],
    positions: [],
    normals: [],
    uvs: [],
    vertexMap: new Map(),
    materialBuckets: new Map(),
    materialOrder: [],
    vertexCount: 0,
    triangleCount: 0,
    faceCount: 0,
    bounds: {
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity]
    }
  }

  const metadata = {
    comments: {},
    mtllibs: []
  }
  let currentMaterial = DEFAULT_MATERIAL
  let lineNumber = 0

  const input = fs.createReadStream(objPath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input, crlfDelay: Infinity })

  for await (const rawLine of rl) {
    lineNumber++
    const trimmed = rawLine.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('#')) {
      parseMinewaysComment(trimmed, metadata.comments)
      continue
    }

    const parts = splitDataLine(rawLine)
    if (!parts.length) continue
    const tag = parts.shift()

    if (tag === 'v') {
      const tuple = parseVectorTuple(parts, 3)
      if (!tuple) throw new Error(`Invalid vertex at OBJ line ${lineNumber}`)
      state.sourcePositions.push(tuple[0], tuple[1], tuple[2])
    } else if (tag === 'vn') {
      const tuple = parseVectorTuple(parts, 3)
      if (!tuple) throw new Error(`Invalid normal at OBJ line ${lineNumber}`)
      state.sourceNormals.push(tuple[0], tuple[1], tuple[2])
    } else if (tag === 'vt') {
      const tuple = parseVectorTuple(parts, 2)
      if (!tuple) throw new Error(`Invalid texture coordinate at OBJ line ${lineNumber}`)
      state.sourceUvs.push(tuple[0], tuple[1])
    } else if (tag === 'mtllib') {
      const name = parts.join(' ')
      if (name) metadata.mtllibs.push(name)
    } else if (tag === 'usemtl') {
      currentMaterial = parts.join(' ') || DEFAULT_MATERIAL
      ensureMaterialBucket(state, currentMaterial)
    } else if (tag === 'f') {
      if (parts.length < 3) throw new Error(`Face has fewer than three vertices at OBJ line ${lineNumber}`)
      const counts = {
        positions: state.sourcePositions.length / 3,
        normals: state.sourceNormals.length / 3,
        uvs: state.sourceUvs.length / 2
      }
      const faceVertices = parts.map((token) => parseFaceToken(token, counts, lineNumber))
      const bucket = ensureMaterialBucket(state, currentMaterial)
      for (let i = 1; i < faceVertices.length - 1; i++) {
        appendTriangle(state, bucket, faceVertices[0], faceVertices[i], faceVertices[i + 1])
      }
      state.faceCount++
    }
  }

  const materialList = []
  const mergedIndices = []
  let indexOffset = 0

  for (const materialName of state.materialOrder) {
    const indices = state.materialBuckets.get(materialName) || []
    if (!indices.length) continue
    const materialIndex = materialList.length
    materialList.push({
      name: materialName === DEFAULT_MATERIAL ? 'default' : materialName,
      start: indexOffset,
      count: indices.length,
      materialIndex
    })
    for (let i = 0; i < indices.length; i++) mergedIndices.push(indices[i])
    indexOffset += indices.length
  }

  if (!state.vertexCount || !mergedIndices.length) {
    throw new Error(`No renderable geometry found in OBJ: ${objPath}`)
  }

  return {
    positions: new Float32Array(state.positions),
    normals: new Float32Array(state.normals),
    uvs: new Float32Array(state.uvs),
    indices: new Uint32Array(mergedIndices),
    groups: materialList.map(({ name, start, count, materialIndex }) => ({ name, start, count, materialIndex })),
    metadata: {
      mtllibs: metadata.mtllibs,
      mineways: metadata.comments,
      sourceVertexCount: state.sourcePositions.length / 3,
      sourceNormalCount: state.sourceNormals.length / 3,
      sourceUvCount: state.sourceUvs.length / 2,
      vertexCount: state.vertexCount,
      faceCount: state.faceCount,
      triangleCount: state.triangleCount,
      bounds: state.bounds
    }
  }
}

module.exports = {
  parseMinewaysObj
}
