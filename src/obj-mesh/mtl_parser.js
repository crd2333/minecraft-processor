const path = require('path')
const fs = require('fs').promises

function parseNumberTriplet (parts) {
  const values = parts.slice(0, 3).map(Number)
  return values.every(Number.isFinite) ? values : null
}

function parseTexturePath (parts) {
  if (!parts.length) return null
  return parts[parts.length - 1]
}

async function parseMtlFile (mtlPath) {
  const materials = new Map()
  let current = null

  let text
  try {
    text = await fs.readFile(mtlPath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return materials
    throw error
  }

  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const parts = line.split(/\s+/)
    const tag = parts.shift()
    if (tag === 'newmtl') {
      const name = parts.join(' ')
      if (!name) continue
      current = {
        name,
        diffuse: [1, 1, 1],
        ambient: [0.2, 0.2, 0.2],
        specular: [0, 0, 0],
        shininess: 0,
        opacity: 1,
        mapKd: null,
        mapD: null
      }
      materials.set(name, current)
      continue
    }

    if (!current) continue

    if (tag === 'Kd') {
      const value = parseNumberTriplet(parts)
      if (value) current.diffuse = value
    } else if (tag === 'Ka') {
      const value = parseNumberTriplet(parts)
      if (value) current.ambient = value
    } else if (tag === 'Ks') {
      const value = parseNumberTriplet(parts)
      if (value) current.specular = value
    } else if (tag === 'Ns') {
      const value = Number(parts[0])
      if (Number.isFinite(value)) current.shininess = value
    } else if (tag === 'd') {
      const value = Number(parts[0])
      if (Number.isFinite(value)) current.opacity = value
    } else if (tag === 'Tr') {
      const value = Number(parts[0])
      if (Number.isFinite(value)) current.opacity = 1 - value
    } else if (tag === 'map_Kd') {
      current.mapKd = parseTexturePath(parts)
    } else if (tag === 'map_d') {
      current.mapD = parseTexturePath(parts)
    }
  }

  for (const material of materials.values()) {
    if (material.mapKd) material.mapKdPath = path.resolve(path.dirname(mtlPath), material.mapKd)
    if (material.mapD) material.mapDPath = path.resolve(path.dirname(mtlPath), material.mapD)
  }

  return materials
}

module.exports = {
  parseMtlFile
}
