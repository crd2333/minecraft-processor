const fs = require('fs').promises
const path = require('path')
const { detectStructureFormat } = require('./structure_parser')
const { loadUnifiedStructure } = require('./unified_parser')
const { buildWorldFromUnifiedStructure } = require('./world_builder')
const { defaultViewerVersion, supportedVersions } = require('./viewer_versions')
const { getSectionGeometry } = require('../patches/prismarine-viewer/viewer/lib/models')

const PROJECT_ROOT = path.resolve(__dirname, '..')

function sectionOrigin (value) {
  return Math.floor(value / 16) * 16
}

function sectionKey (position) {
  return [sectionOrigin(position.x), sectionOrigin(position.y), sectionOrigin(position.z)].join(',')
}

function parseCoordinateKey (key) {
  return key.split(',').map((value) => Number(value))
}

function compareCoordinateKeys (left, right) {
  const a = parseCoordinateKey(left)
  const b = parseCoordinateKey(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index++) {
    const difference = (a[index] || 0) - (b[index] || 0)
    if (difference !== 0) return difference
  }
  return 0
}

function loadViewerWorldClass () {
  try {
    return require('prismarine-viewer/viewer/lib/world').World
  } catch (error) {
    throw new Error(`Cannot load the Prismarine viewer world adapter. Run "npm install" first. ${error.message}`)
  }
}

async function loadBlockStates (version) {
  const blockStatesPath = path.join(
    PROJECT_ROOT,
    'static',
    'vendor',
    'packages',
    'prismarine-viewer',
    'public',
    'blocksStates',
    `${version}.json`
  )

  let text
  try {
    text = await fs.readFile(blockStatesPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Missing block-state model asset for Minecraft ${version}: ${blockStatesPath}. Run "npm run build" first.`)
    }
    throw error
  }

  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`Invalid block-state model JSON at ${blockStatesPath}: ${error.message}`)
  }
}

function calculateBounds (positions) {
  if (positions.length === 0) return null

  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i + axis]
      if (!Number.isFinite(value)) throw new Error(`Generated mesh contains a non-finite vertex at scalar index ${i + axis}`)
      min[axis] = Math.min(min[axis], value)
      max[axis] = Math.max(max[axis], value)
    }
  }

  return { min, max }
}

function combineSectionGeometry (sections, originWorldPos) {
  let vertexCount = 0
  let indexCount = 0

  for (const section of sections) {
    vertexCount += section.geometry.positions.length / 3
    indexCount += section.geometry.indices.length
  }

  if (vertexCount > 0xffffffff) {
    throw new Error(`Generated mesh has ${vertexCount} vertices, exceeding the uint32 index limit`)
  }

  const positions = new Float32Array(vertexCount * 3)
  const indices = new Uint32Array(indexCount)
  let positionOffset = 0
  let indexOffset = 0
  let baseVertex = 0

  for (const section of sections) {
    const geometry = section.geometry
    const translation = [
      geometry.sx - originWorldPos.x,
      geometry.sy - originWorldPos.y,
      geometry.sz - originWorldPos.z
    ]

    for (let i = 0; i < geometry.positions.length; i += 3) {
      positions[positionOffset + i] = geometry.positions[i] + translation[0]
      positions[positionOffset + i + 1] = geometry.positions[i + 1] + translation[1]
      positions[positionOffset + i + 2] = geometry.positions[i + 2] + translation[2]
    }

    for (let i = 0; i < geometry.indices.length; i++) {
      indices[indexOffset + i] = geometry.indices[i] + baseVertex
    }

    positionOffset += geometry.positions.length
    indexOffset += geometry.indices.length
    baseVertex += geometry.positions.length / 3
  }

  return { positions, indices, bounds: calculateBounds(positions) }
}

async function buildStructureMesh (inputPath, options = {}) {
  const resolvedInputPath = path.resolve(inputPath)
  const version = options.version || defaultViewerVersion
  const logger = options.logger || console

  if (!supportedVersions.includes(version)) {
    throw new Error(`Unsupported mesh target version ${version}. Expected one of: ${supportedVersions.join(', ')}`)
  }

  const format = detectStructureFormat(resolvedInputPath)
  const [buffer, blockStates] = await Promise.all([
    fs.readFile(resolvedInputPath),
    loadBlockStates(version)
  ])

  const unified = await loadUnifiedStructure(buffer, format, {
    version,
    targetVersion: version,
    unknownPolicy: options.unknownPolicy || 'keep',
    logger
  }, resolvedInputPath)

  const World = require('prismarine-world')(version)
  const Chunk = require('prismarine-chunk')(version)
  const Block = require('prismarine-block')(version)
  const world = new World(() => new Chunk())
  const placement = await buildWorldFromUnifiedStructure({
    world,
    version,
    unified,
    Block,
    logger
  })

  if (placement.placedPositions.length === 0) {
    throw new Error(`Structure produced no renderable blocks: ${resolvedInputPath}`)
  }

  const sectionKeys = [...new Set(placement.placedPositions.map(sectionKey))].sort(compareCoordinateKeys)
  const columnKeys = [...new Set(sectionKeys.map((key) => {
    const [x, , z] = parseCoordinateKey(key)
    return `${x},${z}`
  }))].sort(compareCoordinateKeys)

  const ViewerWorld = loadViewerWorldClass()
  const viewerWorld = new ViewerWorld(version)

  for (const key of columnKeys) {
    const [worldX, worldZ] = parseCoordinateKey(key)
    const column = await world.getColumn(worldX / 16, worldZ / 16)
    viewerWorld.addColumn(worldX, worldZ, column.toJson())
  }

  const sections = sectionKeys.map((key) => {
    const [x, y, z] = parseCoordinateKey(key)
    return {
      key,
      geometry: getSectionGeometry(x, y, z, viewerWorld, blockStates)
    }
  })
  const mesh = combineSectionGeometry(sections, placement.originWorldPos)

  if (mesh.indices.length === 0) {
    throw new Error(`Structure produced no triangle faces: ${resolvedInputPath}`)
  }
  if (mesh.indices.length % 3 !== 0) {
    throw new Error(`Generated mesh index count ${mesh.indices.length} is not divisible by 3`)
  }

  return {
    positions: mesh.positions,
    indices: mesh.indices,
    metadata: {
      schemaVersion: 1,
      generator: 'minecraft-structure-mesh-v1',
      source: {
        path: resolvedInputPath,
        format,
        version: unified.meta?.source?.version || null,
        targetVersion: version
      },
      coordinateSpace: {
        name: 'minecraft_structure_relative',
        axes: ['x', 'y', 'z'],
        up: '+y',
        units: 'blocks'
      },
      structureSize: unified.size,
      counts: {
        unifiedBlockCount: unified.blocks.length,
        placedBlockCount: placement.placedPositions.length,
        skippedBlockCount: placement.errorPositions.length,
        sectionCount: sections.length,
        vertexCount: mesh.positions.length / 3,
        indexCount: mesh.indices.length,
        triangleCount: mesh.indices.length / 3
      },
      bounds: mesh.bounds
    }
  }
}

module.exports = {
  buildStructureMesh
}
