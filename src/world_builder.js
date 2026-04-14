const { Vec3 } = require('vec3')

function getStructureSizeVec3 (size) {
  if (!Array.isArray(size) || size.length !== 3) {
    return new Vec3(1, 1, 1)
  }

  return new Vec3(
    Math.max(1, Number(size[0]) || 1),
    Math.max(1, Number(size[1]) || 1),
    Math.max(1, Number(size[2]) || 1)
  )
}

function normalizePaletteEntry (entry) {
  if (!entry || typeof entry !== 'object') {
    return {
      name: 'air',
      props: {}
    }
  }

  const rawName = typeof entry.name === 'string' ? entry.name : 'minecraft:air'
  return {
    name: rawName.startsWith('minecraft:') ? rawName.slice('minecraft:'.length) : rawName,
    props: entry.props && typeof entry.props === 'object' && !Array.isArray(entry.props) ? entry.props : {}
  }
}

function isAirName (name) {
  return name === 'air' || name === 'minecraft:air'
}

async function buildWorldFromUnifiedStructure ({ world, version, unified, Block, logger = console }) {
  const structureSize = getStructureSizeVec3(unified?.size)
  const blocks = Array.isArray(unified?.blocks) ? unified.blocks : []
  const palette = Array.isArray(unified?.palette) ? unified.palette : []

  if (blocks.length === 0) {
    logger.warn('Warning: no non-air blocks found in structure')
    return {
      size: structureSize,
      errorPositions: [],
      placedPositions: [],
      originWorldPos: new Vec3(0, 60, 0),
      axisLength: Math.max(structureSize.x, structureSize.y, structureSize.z) + 4
    }
  }

  const yBase = 60
  const errorPositions = []
  const skippedNames = {}
  const placedPositions = []

  for (const blockRecord of blocks) {
    if (!Array.isArray(blockRecord) || blockRecord.length < 4) continue

    const x = Number(blockRecord[0])
    const y = Number(blockRecord[1])
    const z = Number(blockRecord[2])
    const pid = Number(blockRecord[3])

    if (![x, y, z, pid].every(Number.isFinite)) continue
    if (pid < 0 || pid >= palette.length) continue

    const paletteEntry = normalizePaletteEntry(palette[pid])
    if (isAirName(paletteEntry.name)) continue

    const pos = new Vec3(x, y + yBase, z)
    let block

    try {
      block = Block.fromProperties(paletteEntry.name, paletteEntry.props, 0)
    } catch (_) {
      try {
        block = Block.fromProperties(paletteEntry.name, {}, 0)
      } catch (_inner) {
        errorPositions.push({ x: pos.x, y: pos.y, z: pos.z, name: paletteEntry.name })
        skippedNames[paletteEntry.name] = (skippedNames[paletteEntry.name] || 0) + 1
        continue
      }
    }

    await world.setBlock(pos, block)
    placedPositions.push(pos)
  }

  if (errorPositions.length > 0) {
    logger.warn(`Warning: ${errorPositions.length} block(s) not found in version ${version} registry (will render as error blocks):`)
    for (const [name, count] of Object.entries(skippedNames)) {
      logger.warn(`  - ${name}: ${count}`)
    }
  }

  const longestAxis = Math.max(structureSize.x, structureSize.y, structureSize.z)
  return {
    size: structureSize,
    errorPositions,
    placedPositions,
    originWorldPos: new Vec3(0, yBase, 0),
    axisLength: longestAxis + Math.max(4, Math.ceil(longestAxis * 0.1))
  }
}

module.exports = {
  buildWorldFromUnifiedStructure
}
