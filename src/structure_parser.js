const path = require('path')
const nbt = require('prismarine-nbt')
const { Schematic } = require('prismarine-schematic')
const spongeSchematic = require('prismarine-schematic/lib/spongeSchematic')
const mceditSchematic = require('prismarine-schematic/lib/mceditSchematic')
const { parseBlockName, getStateId } = require('prismarine-schematic/lib/states')
const { Vec3 } = require('vec3')
const minecraftData = require('minecraft-data')
const versions = require('minecraft-data').versions.pc
const { convertBedrockBlock } = require('./bedrock-adapter/convertBlocks')

function detectStructureFormat (inputPath) {
  const ext = path.extname(inputPath).toLowerCase()

  if (ext === '.schem') return 'schem'
  if (ext === '.schematic') return 'schematic'
  if (ext === '.litematic') return 'litematic'
  if (ext === '.mcstructure') return 'mcstructure'
  if (ext === '.nbt') return 'nbt'

  throw new Error(`Unsupported file extension: ${ext || '(none)'}. Supported: .schem, .schematic, .litematic, .mcstructure, .nbt`)
}

function normalizePosition (x, y, z) {
  return {
    x: Number(x) || 0,
    y: Number(y) || 0,
    z: Number(z) || 0
  }
}

function relativePosition (pos, origin) {
  return {
    x: pos.x - origin.x,
    y: pos.y - origin.y,
    z: pos.z - origin.z
  }
}

function isAirName (name) {
  return name === 'air' || name === 'minecraft:air'
}

function stripMinecraftNamespace (name) {
  if (!name) return ''
  return name.startsWith('minecraft:') ? name.slice('minecraft:'.length) : name
}

function positionFromIndexYZX (index, size) {
  const x = index % size.x
  const z = Math.floor(index / size.x) % size.z
  const y = Math.floor(index / (size.x * size.z))
  return { x, y, z }
}

function positionFromIndexZYX (index, size) {
  const z = index % size.z
  const y = Math.floor(index / size.z) % size.y
  const x = Math.floor(index / (size.z * size.y))
  return { x, y, z }
}

function toUnsignedBigInt64 (value) {
  const b = BigInt(value)
  const mask = (1n << 64n) - 1n
  return b & mask
}

function decodePackedLitematicStates (packedLongs, bitsPerBlock, blockCount) {
  if (bitsPerBlock <= 0) throw new Error(`Invalid bitsPerBlock for litematic: ${bitsPerBlock}`)

  const expectedLongs = Math.ceil((blockCount * bitsPerBlock) / 64)
  if (packedLongs.length < expectedLongs) {
    throw new Error(`Litematic BlockStates too short: got ${packedLongs.length}, expected at least ${expectedLongs}`)
  }

  const out = new Array(blockCount)
  const mask = (1n << BigInt(bitsPerBlock)) - 1n

  for (let i = 0; i < blockCount; i++) {
    const startBit = i * bitsPerBlock
    const longIndex = Math.floor(startBit / 64)
    const bitOffset = startBit % 64

    const current = toUnsignedBigInt64(packedLongs[longIndex])
    let value = (current >> BigInt(bitOffset)) & mask

    const bitsInCurrent = 64 - bitOffset
    if (bitsInCurrent < bitsPerBlock) {
      const next = longIndex + 1 < packedLongs.length ? toUnsignedBigInt64(packedLongs[longIndex + 1]) : 0n
      value = ((current >> BigInt(bitOffset)) | (next << BigInt(bitsInCurrent))) & mask
    }

    out[i] = Number(value)
  }

  return out
}

function litematicAxisMinAndSize (origin, sizeSigned) {
  const sizeAbs = Math.abs(Number(sizeSigned) || 0)
  if (sizeAbs === 0) return { min: Number(origin) || 0, size: 0 }

  const min = sizeSigned >= 0
    ? Number(origin) || 0
    : (Number(origin) || 0) + Number(sizeSigned) + 1

  return { min, size: sizeAbs }
}

async function parseNbtAuto (buffer) {
  const tries = [
    { hint: 'auto', parseHint: undefined },
    { hint: 'little', parseHint: 'little' },
    { hint: 'littleVarint', parseHint: 'littleVarint' }
  ]

  let lastErr = null
  for (const attempt of tries) {
    try {
      const { parsed, type } = await nbt.parse(buffer, attempt.parseHint)
      return {
        simplified: nbt.simplify(parsed),
        nbtEndian: type,
        nbtParseHint: attempt.hint
      }
    } catch (err) {
      lastErr = err
    }
  }

  throw lastErr || new Error('Failed to parse NBT buffer')
}

function unwrapSchematicRoot (simplifiedNbt) {
  if (!simplifiedNbt || typeof simplifiedNbt !== 'object') return simplifiedNbt
  if (simplifiedNbt.Schematic && typeof simplifiedNbt.Schematic === 'object') {
    return simplifiedNbt.Schematic
  }
  return simplifiedNbt
}

function looksLikeSpongeSchematic (nbtData) {
  return Boolean(
    nbtData &&
    typeof nbtData === 'object' &&
    nbtData.Palette &&
    nbtData.BlockData &&
    typeof nbtData.BlockData[Symbol.iterator] === 'function'
  )
}

function looksLikeMcEditSchematic (nbtData) {
  return Boolean(
    nbtData &&
    typeof nbtData === 'object' &&
    Array.isArray(nbtData.Blocks) &&
    Array.isArray(nbtData.Data)
  )
}

function looksLikeSpongeV3Schematic (nbtData) {
  return Boolean(
    nbtData &&
    typeof nbtData === 'object' &&
    nbtData.Blocks &&
    typeof nbtData.Blocks === 'object' &&
    nbtData.Blocks.Palette &&
    nbtData.Blocks.Data &&
    typeof nbtData.Blocks.Data[Symbol.iterator] === 'function'
  )
}

function findMinecraftVersion (dataVersion) {
  for (const entry of versions) {
    if (entry.dataVersion === dataVersion) return entry.minecraftVersion
  }
  return versions[0].minecraftVersion
}

function decodeVarintArray (values) {
  const out = []
  let i = 0

  while (i < values.length) {
    let value = 0
    let varintLength = 0

    while (true) {
      const nextByte = Number(values[i++]) & 0xFF
      value |= (nextByte & 127) << (varintLength++ * 7)
      if (varintLength > 5) throw new Error('VarInt too big (probably corrupted data)')
      if ((nextByte & 128) !== 128) break
      if (i >= values.length) throw new Error('Unexpected end of varint data in schematic')
    }

    out.push(value)
  }

  return out
}

function createSchematicFromSpongeV3 (nbtData, versionHint) {
  const width = Number(nbtData.Width)
  const height = Number(nbtData.Height)
  const length = Number(nbtData.Length)
  if (![width, height, length].every(Number.isFinite)) {
    throw new Error('Invalid Sponge v3 schematic dimensions')
  }

  const volume = width * height * length
  const offsetArray = Array.isArray(nbtData.Offset) ? nbtData.Offset : [0, 0, 0]
  const offset = new Vec3(Number(offsetArray[0] || 0), Number(offsetArray[1] || 0), Number(offsetArray[2] || 0))
  const version = versionHint || findMinecraftVersion(Number(nbtData.DataVersion))
  const mcData = require('minecraft-data')(version)

  const palette = []
  for (const [blockStateString, paletteIndexRaw] of Object.entries(nbtData.Blocks.Palette || {})) {
    const paletteIndex = Number(paletteIndexRaw)
    if (!Number.isFinite(paletteIndex) || paletteIndex < 0) continue
    const { name, properties } = parseBlockName(blockStateString)
    palette[paletteIndex] = getStateId(mcData, name, properties)
  }

  for (let i = 0; i < palette.length; i++) {
    if (palette[i] === undefined) palette[i] = 0
  }

  const rawData = Array.from(nbtData.Blocks.Data, (value) => Number(value))
  const blocks = rawData.length === volume ? rawData : decodeVarintArray(rawData)
  if (blocks.length !== volume) {
    throw new Error(`Invalid Sponge v3 block data length: got ${blocks.length}, expected ${volume}`)
  }

  return new Schematic(version, new Vec3(width, height, length), offset, palette, blocks)
}

async function readSchematicWithFallback (buffer, versionHint) {
  try {
    return await Schematic.read(buffer, versionHint)
  } catch (primaryError) {
    const nbtInfo = await parseNbtAuto(buffer)
    const unwrapped = unwrapSchematicRoot(nbtInfo.simplified)

    try {
      if (looksLikeSpongeV3Schematic(unwrapped)) {
        return createSchematicFromSpongeV3(unwrapped, versionHint)
      }

      if (looksLikeSpongeSchematic(unwrapped)) {
        return spongeSchematic.read(unwrapped, versionHint)
      }

      if (looksLikeMcEditSchematic(unwrapped)) {
        return mceditSchematic.read(unwrapped, versionHint)
      }
    } catch (fallbackError) {
      throw new Error(
        `Failed to parse schematic with native and fallback readers: ${fallbackError.message || fallbackError}`
      )
    }

    throw primaryError
  }
}

function stableStringify (value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`

  const keys = Object.keys(value).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
}

function isJavaStructureNbt (simplified) {
  return Boolean(
    simplified &&
    Array.isArray(simplified.size) &&
    simplified.size.length === 3 &&
    Array.isArray(simplified.palette) &&
    Array.isArray(simplified.blocks)
  )
}

function isBedrockMcstructureData (simplified) {
  return Boolean(
    simplified &&
    Array.isArray(simplified.size) &&
    simplified.size.length === 3 &&
    Array.isArray(simplified?.structure?.palette?.default?.block_palette) &&
    Array.isArray(simplified?.structure?.block_indices)
  )
}

function isLitematicData (simplified) {
  if (!simplified || typeof simplified !== 'object' || Array.isArray(simplified)) return false
  if (!simplified.Regions || typeof simplified.Regions !== 'object' || Array.isArray(simplified.Regions)) return false
  return Object.keys(simplified.Regions).length > 0
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
    return {
      meta: {
        DataVersion: resolveTargetDataVersion({ sourceEdition, sourceDataVersion, targetVersion }),
        source: {
          format: sourceFormat,
          edition: sourceEdition,
          version: sourceVersion ?? null,
          parser
        },
        target: {
          edition: 'java',
          version: targetVersion || null
        },
        coordinateSpace: 'relative',
        unknownPolicy,
        stats: finalizeStats(stats, paletteAcc.entries, blocks, entities)
      },
      size,
      palette: paletteAcc.entries,
      blocks,
      entities
    }
  }

  return { addCanonicalBlock, finalize }
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
    sourceVersion: simplified.format_version ?? null,
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
        sourceVersion: paletteEntry.version ?? null
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
      regionName,
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

function classifyNativeNbtSchema (simplified, declaredFormat) {
  const unwrapped = unwrapSchematicRoot(simplified)

  if (declaredFormat === 'schem') {
    if (looksLikeSpongeV3Schematic(unwrapped)) return 'sponge-schematic-v3'
    if (looksLikeSpongeSchematic(unwrapped)) return 'sponge-schematic'
    return 'schem-nbt'
  }

  if (declaredFormat === 'schematic') {
    if (looksLikeMcEditSchematic(unwrapped)) return 'mcedit-schematic'
    if (looksLikeSpongeSchematic(unwrapped)) return 'sponge-schematic'
    if (looksLikeSpongeV3Schematic(unwrapped)) return 'sponge-schematic-v3'
    return 'schematic-nbt'
  }

  if (declaredFormat === 'litematic') {
    return isLitematicData(simplified) ? 'litematic' : 'litematic-nbt'
  }

  if (declaredFormat === 'mcstructure') {
    return isBedrockMcstructureData(simplified) ? 'bedrock-mcstructure' : 'mcstructure-nbt'
  }

  if (declaredFormat === 'nbt') {
    if (isLitematicData(simplified)) return 'litematic-in-nbt'
    if (isJavaStructureNbt(simplified)) return 'java-structure-nbt'
    if (isBedrockMcstructureData(simplified)) return 'bedrock-mcstructure-like-nbt'
    return 'generic-nbt'
  }

  return 'unknown'
}

async function loadNativeStructure (buffer, format, options = {}, sourcePath = null) {
  if (format === 'schem' || format === 'schematic' || format === 'litematic' || format === 'mcstructure' || format === 'nbt') {
    const nbtInfo = await parseNbtAuto(buffer)
    return {
      format,
      schema: classifyNativeNbtSchema(nbtInfo.simplified, format),
      parser: 'prismarine-nbt',
      sourceFile: sourcePath,
      nbtEndian: nbtInfo.nbtEndian,
      nbtParseHint: nbtInfo.nbtParseHint,
      versionHint: options.version || null,
      data: nbtInfo.simplified
    }
  }

  throw new Error(`Internal error: unsupported detected format ${format}`)
}

async function loadUnifiedStructure (buffer, format, options = {}) {
  const normalizedOptions = {
    version: options.version,
    targetVersion: options.targetVersion || null,
    unknownPolicy: options.unknownPolicy || 'keep'
  }

  if (!['keep', 'drop'].includes(normalizedOptions.unknownPolicy)) {
    throw new Error('Invalid unknown policy. Expected keep or drop')
  }

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
    if (mcstructure) return mcstructure
    throw new Error('File extension is .mcstructure but Bedrock structure tags were not found')
  }

  if (format === 'nbt') {
    const litematic = parseUnifiedLitematic(simplified, format, normalizedOptions)
    if (litematic) return litematic

    const javaStructure = parseUnifiedJavaStructureNbt(simplified, format, normalizedOptions)
    if (javaStructure) return javaStructure

    const mcstructure = parseUnifiedMcstructure(simplified, format, normalizedOptions)
    if (mcstructure) return mcstructure

    throw new Error('Unrecognised .nbt schema. Tried: Not a valid Java NBT structure: missing palette or blocks array | Not a valid Litematic: missing Regions tag | Not a valid Bedrock .mcstructure: missing required fields')
  }

  throw new Error(`Internal error: unsupported detected format ${format}`)
}

module.exports = {
  classifyNativeNbtSchema,
  decodePackedLitematicStates,
  detectStructureFormat,
  isAirName,
  litematicAxisMinAndSize,
  normalizePosition,
  parseNbtAuto,
  positionFromIndexYZX,
  positionFromIndexZYX,
  relativePosition,
  stripMinecraftNamespace,
  loadNativeStructure,
  loadUnifiedStructure
}
