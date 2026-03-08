const { convertBedrockBlock, postProcessWorld } = require('./bedrockToJava')
const { stripMinecraftNamespace } = require('./structure')

function normalizeRenderableBlock (block) {
  const sourceFormat = block.source?.format || null
  const rawName = block.namespaceName || block.blockName || ''

  if (sourceFormat === 'mcstructure-bedrock') {
    const converted = convertBedrockBlock(stripMinecraftNamespace(rawName), block.properties || {})
    return {
      name: converted.name,
      properties: converted.properties
    }
  }

  return {
    name: stripMinecraftNamespace(rawName),
    properties: block.properties || {}
  }
}

async function buildWorldFromPayload ({ world, version, payload, Block, Vec3, logger = console }) {
  if (!payload || !Array.isArray(payload.blocks) || payload.blocks.length === 0) {
    logger.warn('Warning: no non-air blocks found in structure')
    return { size: new Vec3(1, 1, 1), errorPositions: [], placedPositions: [] }
  }

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity

  for (const block of payload.blocks) {
    const { x, y, z } = block.position
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (z < minZ) minZ = z
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
    if (z > maxZ) maxZ = z
  }

  const yBase = 60
  const errorPositions = []
  const skippedNames = {}
  const placedPositions = []

  for (const blockRecord of payload.blocks) {
    const pos = new Vec3(
      blockRecord.position.x - minX,
      blockRecord.position.y - minY + yBase,
      blockRecord.position.z - minZ
    )
    const renderable = normalizeRenderableBlock(blockRecord)

    let block
    try {
      block = Block.fromProperties(renderable.name, renderable.properties, 0)
    } catch (_) {
      try {
        block = Block.fromProperties(renderable.name, {}, 0)
      } catch (_inner) {
        errorPositions.push({ x: pos.x, y: pos.y, z: pos.z, name: renderable.name })
        skippedNames[renderable.name] = (skippedNames[renderable.name] || 0) + 1
        continue
      }
    }

    await world.setBlock(pos, block)
    placedPositions.push(new Vec3(pos.x, pos.y, pos.z))
  }

  if (errorPositions.length > 0) {
    logger.warn(`Warning: ${errorPositions.length} block(s) not found in version ${version} registry (will render as error blocks):`)
    for (const [name, count] of Object.entries(skippedNames)) {
      logger.warn(`  - ${name}: ${count}`)
    }
  }

  if (payload.meta?.normalizedFormat === 'mcstructure-bedrock') {
    await postProcessWorld({ world, Block, Vec3, positions: placedPositions, logger })
  }

  return {
    size: new Vec3(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1),
    errorPositions,
    placedPositions
  }
}

module.exports = {
  buildWorldFromPayload
}