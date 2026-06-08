const minecraftData = require('minecraft-data')
const { convertBedrockBlock } = require('./bedrock-adapter/convertBlocks')
const { postProcessUnifiedBedrockStructure } = require('./bedrock-adapter/postProcess')
const {
  decodePackedLitematicStates,
  isAirName,
  isBedrockMcstructureData,
  isJavaStructureNbt,
  isLitematicData,
  litematicAxisMinAndSize,
  normalizePosition,
  parseNbtAuto,
  positionFromIndexYZX,
  positionFromIndexZYX,
  readSchematicWithFallback,
  resolveUnifiedParseVersion,
  stripMinecraftNamespace
} = require('./structure_parser')

function stableStringify (value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function normalizeScalarPropValue (value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return stableStringify(value)
}

function normalizePropsObject (props) {
  if (!props || typeof props !== 'object' || Array.isArray(props)) return {}

  const normalized = {}
  for (const [key, value] of Object.entries(props)) {
    normalized[key] = normalizeScalarPropValue(value)
  }
  return normalized
}

function ensureNamespacedName (name) {
  if (!name) return null
  return name.includes(':') ? name : `minecraft:${name}`
}

function resolveJavaDataVersion (version) {
  if (!version) return null

  try {
    return minecraftData(version)?.version?.dataVersion ?? null
  } catch (_) {
    return null
  }
}

function resolveTargetDataVersion ({ sourceEdition, sourceDataVersion, targetVersion }) {
  if (sourceEdition === 'java' && sourceDataVersion !== null && sourceDataVersion !== undefined) return sourceDataVersion
  return resolveJavaDataVersion(targetVersion)
}

function entriesEqual (left, right) {
  return stableStringify(left) === stableStringify(right)
}

function paletteKey (entry) {
  return stableStringify(entry)
}

function createPaletteAccumulator () {
  return {
    entries: [],
    keyToIndex: new Map()
  }
}

function upsertPaletteEntry (acc, entry) {
  const key = paletteKey(entry)
  const existing = acc.keyToIndex.get(key)
  if (existing !== undefined) return existing

  const pid = acc.entries.length
  acc.entries.push(entry)
  acc.keyToIndex.set(key, pid)
  return pid
}

function createEmptyStats () {
  return {
    paletteSize: 0,
    blockCount: 0,
    entityCount: 0,
    unresolvedPaletteCount: 0,
    unresolvedBlockCount: 0,
    droppedBlockCount: 0
  }
}

function finalizeStats (stats, palette, blocks, entities) {
  stats.paletteSize = palette.length
  stats.blockCount = blocks.length
  stats.entityCount = entities.length
  stats.unresolvedPaletteCount = palette.filter((entry) => entry.mapping?.status === 'unresolved').length
  return stats
}

function normalizeBlocksToOccupiedBounds (blocks, declaredSize) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return {
      size: declaredSize,
      offset: [0, 0, 0]
    }
  }

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity

  for (const block of blocks) {
    const x = Number(block[0])
    const y = Number(block[1])
    const z = Number(block[2])
    if (![x, y, z].every(Number.isFinite)) continue
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    minZ = Math.min(minZ, z)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    maxZ = Math.max(maxZ, z)
  }

  if (![minX, minY, minZ, maxX, maxY, maxZ].every(Number.isFinite)) {
    return {
      size: declaredSize,
      offset: [0, 0, 0]
    }
  }

  for (const block of blocks) {
    block[0] -= minX
    block[1] -= minY
    block[2] -= minZ
  }

  return {
    size: [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1],
    offset: [minX, minY, minZ]
  }
}

function applyUnknownPolicy (entry, unknownPolicy) {
  if (entry.mapping?.status === 'unresolved' && unknownPolicy === 'drop') {
    return { action: 'drop' }
  }

  return { action: 'keep', entry }
}

function createUnifiedBuilder ({ sourceFormat, sourceEdition, sourceVersion, parser, sourceDataVersion, targetVersion, unknownPolicy }) {
  const paletteAcc = createPaletteAccumulator()
  const blocks = []
  const entities = []
  const stats = createEmptyStats()

  function addCanonicalBlock ({ x, y, z, canonical }) {
    const result = applyUnknownPolicy(canonical, unknownPolicy)
    if (result.action === 'drop') {
      stats.droppedBlockCount++
      return
    }

    const pid = upsertPaletteEntry(paletteAcc, result.entry)
    blocks.push([x, y, z, pid])

    if (result.entry.mapping?.status === 'unresolved') stats.unresolvedBlockCount++
  }

  function finalize (size) {
    const declaredSize = Array.isArray(size) ? size.slice(0, 3).map((axis) => Number(axis) || 0) : [0, 0, 0]
    const occupied = normalizeBlocksToOccupiedBounds(blocks, declaredSize)
    return {
      meta: {
        DataVersion: resolveTargetDataVersion({ sourceEdition, sourceDataVersion, targetVersion }),
        source: {
          format: sourceFormat,
          edition: sourceEdition,
          version: sourceVersion ?? null,
          parser,
          declaredSize,
          occupiedOffset: occupied.offset
        },
        target: {
          edition: 'java',
          version: targetVersion || null
        },
        coordinateSpace: 'relative',
        unknownPolicy,
        stats: finalizeStats(stats, paletteAcc.entries, blocks, entities)
      },
      size: occupied.size,
      palette: paletteAcc.entries,
      blocks,
      entities
    }
  }

  return { addCanonicalBlock, finalize }
}

async function postProcessUnifiedBedrockResult (result, options) {
  if (!result || result.meta?.source?.edition !== 'bedrock') return result

  const processed = await postProcessUnifiedBedrockStructure({
    palette: result.palette,
    blocks: result.blocks,
    targetVersion: options.targetVersion || null,
    logger: options.logger
  })

  return {
    ...result,
    meta: {
      ...result.meta,
      stats: finalizeStats({ ...result.meta.stats }, processed.palette, processed.blocks, result.entities)
    },
    palette: processed.palette,
    blocks: processed.blocks
  }
}

function canonicalFromJavaBlock ({ name, props }) {
  return {
    name: ensureNamespacedName(name),
    props: normalizePropsObject(props)
  }
}

function canonicalFromBedrockBlock ({ name, props, sourceVersion }) {
  const sourceName = ensureNamespacedName(name)
  const converted = convertBedrockBlock(stripMinecraftNamespace(sourceName || ''), props || {}, {
    sourceVersion: sourceVersion || null
  })

  const canonicalName = ensureNamespacedName(converted.name || sourceName)
  const canonicalProps = normalizePropsObject(converted.properties || {})

  let status = 'unresolved'
  if (converted.matched) {
    status = entriesEqual(
      { name: canonicalName, props: canonicalProps },
      { name: sourceName, props: normalizePropsObject(props) }
    )
      ? 'preserved'
      : 'mapped'
  }

  return {
    name: canonicalName,
    props: canonicalProps,
    mapping: {
      status,
      sourceKey: converted.sourceKey
    }
  }
}

async function parseUnifiedSchematicLike (buffer, format, options) {
  const schematic = await readSchematicWithFallback(buffer, options.version)
  const size = [Number(schematic.size.x) || 0, Number(schematic.size.y) || 0, Number(schematic.size.z) || 0]
  const builder = createUnifiedBuilder({
    sourceFormat: format,
    sourceEdition: 'java',
    sourceVersion: schematic.version || options.version || null,
    parser: 'prismarine-schematic',
    sourceDataVersion: null,
    targetVersion: options.targetVersion || options.version || null,
    unknownPolicy: options.unknownPolicy || 'keep'
  })

  await schematic.forEach(async (block, pos) => {
    if (isAirName(block.name)) return

    const properties = typeof block.getProperties === 'function' ? block.getProperties() : {}
    builder.addCanonicalBlock({
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      z: Number(pos.z) || 0,
      canonical: canonicalFromJavaBlock({
        name: block.name,
        props: properties
      })
    })
  })

  return builder.finalize(size)
}

function parseUnifiedJavaStructureNbt (simplified, format, options) {
  if (!isJavaStructureNbt(simplified)) return null

  const size = [Number(simplified.size[0]) || 0, Number(simplified.size[1]) || 0, Number(simplified.size[2]) || 0]
  const builder = createUnifiedBuilder({
    sourceFormat: format,
    sourceEdition: 'java',
    sourceVersion: simplified.DataVersion ?? null,
    parser: 'prismarine-nbt',
    sourceDataVersion: simplified.DataVersion ?? null,
    targetVersion: options.targetVersion || null,
    unknownPolicy: options.unknownPolicy || 'keep'
  })

  for (const entry of simplified.blocks) {
    if (!entry || !Array.isArray(entry.pos) || entry.pos.length !== 3) continue

    const srcPaletteIndex = Number(entry.state)
    if (Number.isNaN(srcPaletteIndex) || srcPaletteIndex < 0 || srcPaletteIndex >= simplified.palette.length) continue

    const paletteEntry = simplified.palette[srcPaletteIndex] || {}
    const blockName = paletteEntry.Name || paletteEntry.name || null
    if (isAirName(blockName)) continue

    builder.addCanonicalBlock({
      x: Number(entry.pos[0]) || 0,
      y: Number(entry.pos[1]) || 0,
      z: Number(entry.pos[2]) || 0,
      canonical: canonicalFromJavaBlock({
        name: blockName,
        props: paletteEntry.Properties || paletteEntry.properties || {}
      })
    })
  }

  return builder.finalize(size)
}

function parseUnifiedMcstructure (simplified, format, options) {
  if (!isBedrockMcstructureData(simplified)) return null

  const palette = simplified.structure.palette.default.block_palette
  const primaryIndices = simplified.structure.block_indices[0]
  if (!Array.isArray(primaryIndices)) return null

  const size = [Number(simplified.size[0]) || 0, Number(simplified.size[1]) || 0, Number(simplified.size[2]) || 0]
  const dims = normalizePosition(size[0], size[1], size[2])
  const builder = createUnifiedBuilder({
    sourceFormat: format,
    sourceEdition: 'bedrock',
    sourceVersion: options.version || simplified.format_version || null,
    parser: 'prismarine-nbt',
    sourceDataVersion: null,
    targetVersion: options.targetVersion || null,
    unknownPolicy: options.unknownPolicy || 'keep'
  })

  for (let i = 0; i < primaryIndices.length; i++) {
    const srcPaletteIndex = Number(primaryIndices[i])
    if (srcPaletteIndex < 0 || srcPaletteIndex >= palette.length) continue

    const paletteEntry = palette[srcPaletteIndex] || {}
    const blockName = paletteEntry.name || null
    if (isAirName(blockName)) continue

    const pos = positionFromIndexZYX(i, dims)
    builder.addCanonicalBlock({
      x: pos.x,
      y: pos.y,
      z: pos.z,
      canonical: canonicalFromBedrockBlock({
        name: blockName,
        props: paletteEntry.states || {},
        sourceVersion: options.version || paletteEntry.version || null
      })
    })
  }

  return builder.finalize(size)
}

function parseUnifiedLitematic (simplified, format, options) {
  if (!isLitematicData(simplified)) return null

  const regionNames = Object.keys(simplified.Regions)
  const prepared = []
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (const regionName of regionNames) {
    const region = simplified.Regions[regionName]
    if (!region || !region.Size || !region.Position) continue

    const sx = Number(region.Size.x)
    const sy = Number(region.Size.y)
    const sz = Number(region.Size.z)
    const ox = Number(region.Position.x)
    const oy = Number(region.Position.y)
    const oz = Number(region.Position.z)
    if ([sx, sy, sz, ox, oy, oz].some(Number.isNaN)) continue

    const xAxis = litematicAxisMinAndSize(ox, sx)
    const yAxis = litematicAxisMinAndSize(oy, sy)
    const zAxis = litematicAxisMinAndSize(oz, sz)
    if (xAxis.size === 0 || yAxis.size === 0 || zAxis.size === 0) continue

    minX = Math.min(minX, xAxis.min)
    minY = Math.min(minY, yAxis.min)
    minZ = Math.min(minZ, zAxis.min)
    maxX = Math.max(maxX, xAxis.min + xAxis.size - 1)
    maxY = Math.max(maxY, yAxis.min + yAxis.size - 1)
    maxZ = Math.max(maxZ, zAxis.min + zAxis.size - 1)

    prepared.push({
      xAxis,
      yAxis,
      zAxis,
      palette: Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : [],
      packedStates: Array.isArray(region.BlockStates) ? region.BlockStates : []
    })
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null

  const size = [maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1]
  const builder = createUnifiedBuilder({
    sourceFormat: format,
    sourceEdition: 'java',
    sourceVersion: simplified.MinecraftDataVersion ?? null,
    parser: 'prismarine-nbt',
    sourceDataVersion: simplified.MinecraftDataVersion ?? null,
    targetVersion: options.targetVersion || null,
    unknownPolicy: options.unknownPolicy || 'keep'
  })

  for (const region of prepared) {
    const regionBlockCount = region.xAxis.size * region.yAxis.size * region.zAxis.size
    if (region.palette.length === 0) continue

    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, region.palette.length))))
    const unpackedStates = decodePackedLitematicStates(region.packedStates, bitsPerBlock, regionBlockCount)

    for (let i = 0; i < unpackedStates.length; i++) {
      const srcPaletteIndex = unpackedStates[i]
      if (srcPaletteIndex < 0 || srcPaletteIndex >= region.palette.length) continue

      const paletteEntry = region.palette[srcPaletteIndex] || {}
      const blockName = paletteEntry.Name || paletteEntry.name || null
      if (isAirName(blockName)) continue

      const local = positionFromIndexYZX(i, {
        x: region.xAxis.size,
        y: region.yAxis.size,
        z: region.zAxis.size
      })

      builder.addCanonicalBlock({
        x: region.xAxis.min + local.x - minX,
        y: region.yAxis.min + local.y - minY,
        z: region.zAxis.min + local.z - minZ,
        canonical: canonicalFromJavaBlock({
          name: blockName,
          props: paletteEntry.Properties || paletteEntry.properties || {}
        })
      })
    }
  }

  return builder.finalize(size)
}

async function loadUnifiedStructure (buffer, format, options = {}) {
  const normalizedOptions = {
    version: options.version,
    normVersion: options.normVersion || null,
    targetVersion: options.targetVersion || null,
    unknownPolicy: options.unknownPolicy || 'keep',
    logger: options.logger
  }

  if (!['keep', 'drop'].includes(normalizedOptions.unknownPolicy)) {
    throw new Error('Invalid unknown policy. Expected keep or drop')
  }

  if (normalizedOptions.normVersion) {
    throw new Error(`Not implemented: palette normalization to ${normalizedOptions.normVersion}`)
  }

  const parseVersionSelection = await resolveUnifiedParseVersion(buffer, format, normalizedOptions.version, {
    logger: normalizedOptions.logger
  })
  normalizedOptions.version = parseVersionSelection.version

  if (format === 'schem' || format === 'schematic') {
    return parseUnifiedSchematicLike(buffer, format, normalizedOptions)
  }

  const nbtInfo = await parseNbtAuto(buffer)
  const { simplified } = nbtInfo

  if (format === 'litematic') {
    const litematic = parseUnifiedLitematic(simplified, format, normalizedOptions)
    if (litematic) return litematic
    throw new Error('File extension is .litematic but required Litematic tags were not found')
  }

  if (format === 'mcstructure') {
    const mcstructure = parseUnifiedMcstructure(simplified, format, normalizedOptions)
    if (mcstructure) return postProcessUnifiedBedrockResult(mcstructure, normalizedOptions)
    throw new Error('File extension is .mcstructure but Bedrock structure tags were not found')
  }

  if (format === 'nbt') {
    const litematic = parseUnifiedLitematic(simplified, format, normalizedOptions)
    if (litematic) return litematic

    const javaStructure = parseUnifiedJavaStructureNbt(simplified, format, normalizedOptions)
    if (javaStructure) return javaStructure

    const mcstructure = parseUnifiedMcstructure(simplified, format, normalizedOptions)
    if (mcstructure) return postProcessUnifiedBedrockResult(mcstructure, normalizedOptions)

    throw new Error('Unrecognised .nbt schema. Tried: Not a valid Java NBT structure: missing palette or blocks array | Not a valid Litematic: missing Regions tag | Not a valid Bedrock .mcstructure: missing required fields')
  }

  throw new Error(`Internal error: unsupported detected format ${format}`)
}

module.exports = {
  loadUnifiedStructure
}
