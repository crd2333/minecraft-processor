const path = require('path')
const util = require('util')
const nbt = require('prismarine-nbt')
const { Schematic } = require('prismarine-schematic')
const spongeSchematic = require('prismarine-schematic/lib/spongeSchematic')
const mceditSchematic = require('prismarine-schematic/lib/mceditSchematic')
const { parseBlockName, getStateId } = require('prismarine-schematic/lib/states')
const { Vec3 } = require('vec3')
const minecraftData = require('minecraft-data')
const versions = require('minecraft-data').versions.pc
const { inferDominantBedrockVersion, inferSingleBedrockVersion } = require('./bedrock-adapter/version')

const DEFAULT_UNIFIED_PARSE_VERSION = '1.21.8'

async function withSchematicConsoleLogRedirect (logger, fn) {
  const originalLog = console.log
  const warningLogger = typeof logger?.warn === 'function'
    ? logger.warn.bind(logger)
    : console.warn.bind(console)
  const messages = []

  console.log = (...args) => {
    messages.push(util.format(...args))
  }

  try {
    return await fn()
  } finally {
    console.log = originalLog
    for (const message of messages) {
      warningLogger(message)
    }
  }
}

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

function resolveReadableBlockStateName (entry) {
  if (!entry || typeof entry !== 'object') return null
  return entry.blockState || entry.name || entry.Name || entry.block?.name || null
}

function filterReadableEntries (entries, getName) {
  if (!Array.isArray(entries)) return entries
  return entries.filter((entry) => !isAirName(getName(entry)))
}

function filterMcstructureReadableEntries (entries) {
  if (!Array.isArray(entries)) return entries
  return entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return false
    if (!Number.isInteger(entry.paletteIndex) || entry.paletteIndex < 0) return false
    return !isAirName(resolveReadableBlockStateName(entry))
  })
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

function isEmptyPlainObject (value) {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  )
}

async function parseNbtBigEndianWithoutArrayGuard (buffer) {
  const parsed = await nbt.parseAs(buffer, 'big', { noArraySizeCheck: true })
  return {
    simplified: nbt.simplify(parsed.data),
    nbtEndian: parsed.type,
    nbtParseHint: 'big-no-array-size-check'
  }
}

async function parseNbtAuto (buffer) {
  const tries = [
    { hint: 'auto', parseHint: undefined },
    { hint: 'little', parseHint: 'little' },
    { hint: 'littleVarint', parseHint: 'littleVarint' }
  ]

  let lastErr = null
  let emptyResult = null
  for (const attempt of tries) {
    try {
      const { parsed, type } = await nbt.parse(buffer, attempt.parseHint)
      const result = {
        simplified: nbt.simplify(parsed),
        nbtEndian: type,
        nbtParseHint: attempt.hint
      }

      if (isEmptyPlainObject(result.simplified)) {
        emptyResult = emptyResult || result
        continue
      }

      return result
    } catch (err) {
      lastErr = err
    }
  }

  try {
    const result = await parseNbtBigEndianWithoutArrayGuard(buffer)
    if (!isEmptyPlainObject(result.simplified)) return result
  } catch (err) {
    lastErr = err
  }

  if (emptyResult) return emptyResult
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

function maybeResolveMinecraftVersionFromDataVersion (dataVersion) {
  const numeric = Number(dataVersion)
  if (!Number.isFinite(numeric)) return null

  for (const entry of versions) {
    if (entry.dataVersion === numeric) return entry.minecraftVersion
  }

  return null
}

function inferJavaDataVersionFromSimplified (simplified, declaredFormat) {
  const unwrapped = unwrapSchematicRoot(simplified)

  if (declaredFormat === 'schem' || declaredFormat === 'schematic') {
    return unwrapped?.DataVersion ?? null
  }

  if (declaredFormat === 'litematic') {
    return simplified?.MinecraftDataVersion ?? null
  }

  if (declaredFormat === 'nbt') {
    if (isLitematicData(simplified)) return simplified?.MinecraftDataVersion ?? null
    if (isJavaStructureNbt(simplified)) return simplified?.DataVersion ?? null
    return null
  }

  return null
}

function inferBedrockVersionFromSimplified (simplified, declaredFormat) {
  if (declaredFormat !== 'mcstructure' && declaredFormat !== 'nbt') return null
  if (!isBedrockMcstructureData(simplified)) return null

  const palette = simplified?.structure?.palette?.default?.block_palette
  if (!Array.isArray(palette)) return null

  return inferSingleBedrockVersion(palette.map((entry) => entry?.version))
}

function inferBedrockVersionSelectionFromSimplified (simplified, declaredFormat) {
  if (declaredFormat !== 'mcstructure' && declaredFormat !== 'nbt') {
    return { version: null, warning: null }
  }
  if (!isBedrockMcstructureData(simplified)) {
    return { version: null, warning: null }
  }

  const palette = simplified?.structure?.palette?.default?.block_palette
  if (!Array.isArray(palette)) {
    return { version: null, warning: null }
  }

  const sourceVersions = palette.map((entry) => entry?.version)
  const singleVersion = inferSingleBedrockVersion(sourceVersions)
  if (singleVersion) {
    return { version: singleVersion, warning: null }
  }

  const dominant = inferDominantBedrockVersion(sourceVersions)
  if (!dominant.version) {
    return { version: null, warning: null }
  }

  if (dominant.mode !== 'mixed') {
    return { version: dominant.version, warning: null }
  }

  const countsLabel = dominant.counts
    .map(({ version, count }) => `${version} (${count})`)
    .join(', ')

  return {
    version: dominant.version,
    warning: `Warning: mixed Bedrock palette versions detected; using most frequent normalized version ${dominant.version} (${countsLabel})`
  }
}

async function inferStructureParseVersion (buffer, format) {
  if (!['schem', 'schematic', 'litematic', 'mcstructure', 'nbt'].includes(format)) return null

  const { simplified } = await parseNbtAuto(buffer)
  const inferredDataVersion = inferJavaDataVersionFromSimplified(simplified, format)
  if (inferredDataVersion !== null && inferredDataVersion !== undefined) {
    return maybeResolveMinecraftVersionFromDataVersion(inferredDataVersion)
  }

  return inferBedrockVersionFromSimplified(simplified, format)
}

async function resolveUnifiedParseVersion (buffer, format, versionHint, options = {}) {
  const logger = options.logger

  if (versionHint) {
    return {
      version: versionHint,
      source: 'explicit'
    }
  }

  const { simplified } = await parseNbtAuto(buffer)
  const inferredDataVersion = inferJavaDataVersionFromSimplified(simplified, format)
  if (inferredDataVersion !== null && inferredDataVersion !== undefined) {
    const inferredVersion = maybeResolveMinecraftVersionFromDataVersion(inferredDataVersion)
    if (inferredVersion) {
      return {
        version: inferredVersion,
        source: 'inferred'
      }
    }
  }

  const bedrockSelection = inferBedrockVersionSelectionFromSimplified(simplified, format)
  if (bedrockSelection.warning && logger?.warn) {
    logger.warn(bedrockSelection.warning)
  }

  if (bedrockSelection.version) {
    return {
      version: bedrockSelection.version,
      source: 'inferred'
    }
  }

  return {
    version: DEFAULT_UNIFIED_PARSE_VERSION,
    source: 'default'
  }
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

function addHighBitsFromMcEditAddBlocks (index, addBlocks) {
  if (!Array.isArray(addBlocks) || addBlocks.length === 0) return 0
  const packed = Number(addBlocks[Math.floor(index / 2)] || 0) & 0xFF
  return index % 2 === 0 ? (packed & 0x0F) : ((packed >> 4) & 0x0F)
}

function normalizeSpongePaletteEntries (paletteObject) {
  const entries = []
  for (const [blockState, paletteIndexRaw] of Object.entries(paletteObject || {})) {
    const paletteIndex = Number(paletteIndexRaw)
    if (!Number.isFinite(paletteIndex) || paletteIndex < 0) continue
    entries[paletteIndex] = {
      paletteIndex,
      blockState
    }
  }

  return Array.from({ length: entries.length }, (_, paletteIndex) => entries[paletteIndex] || { paletteIndex, blockState: null })
}

function getSpongeBlockContainer (data) {
  if (looksLikeSpongeV3Schematic(data)) return data.Blocks
  if (looksLikeSpongeSchematic(data)) return data
  return null
}

function decodeSpongeBlockIndices (data, volume) {
  const container = getSpongeBlockContainer(data)
  if (!container) return null

  const rawData = Array.from(container.Data || container.BlockData || [], (value) => Number(value))
  const decoded = rawData.length === volume ? rawData : decodeVarintArray(rawData)
  if (decoded.length !== volume) {
    throw new Error(`Invalid Sponge schematic block data length: got ${decoded.length}, expected ${volume}`)
  }

  return decoded
}

function cloneNativeValue (value) {
  if (Array.isArray(value)) return value.map(cloneNativeValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [key, cloneNativeValue(entryValue)]))
  }
  return value
}

function translateSpongeReadableDataInPlace (data, options = {}) {
  const width = Number(data.Width) || 0
  const height = Number(data.Height) || 0
  const length = Number(data.Length) || 0
  const volume = width * height * length
  const size = { x: width, y: height, z: length }
  const container = getSpongeBlockContainer(data)
  if (!container) return data

  const paletteEntries = normalizeSpongePaletteEntries(container.Palette || data.Palette)
  const blockIndices = decodeSpongeBlockIndices(data, volume)
  if (!blockIndices) return data

  const fieldName = Object.prototype.hasOwnProperty.call(container, 'BlockData') ? 'BlockData' : 'Data'
  container[fieldName] = blockIndices.map((paletteIndexRaw, index) => {
    const paletteIndex = Number(paletteIndexRaw) || 0
    const paletteEntry = paletteEntries[paletteIndex] || { paletteIndex, blockState: null }
    return {
      index,
      position: positionFromIndexYZX(index, size),
      paletteIndex,
      blockState: paletteEntry.blockState
    }
  })

  if (options.filterAir === true) {
    container[fieldName] = filterReadableEntries(container[fieldName], resolveReadableBlockStateName)
  }

  return data
}

function translateMcEditReadableDataInPlace (data, options = {}) {
  const width = Number(data.Width) || 0
  const height = Number(data.Height) || 0
  const length = Number(data.Length) || 0
  const volume = width * height * length
  const size = { x: width, y: height, z: length }
  if (!Array.isArray(data.Blocks) || !Array.isArray(data.Data)) return data

  const blocks = Array.from(data.Blocks, (value) => Number(value) & 0xFF)
  const metadata = Array.from(data.Data, (value) => Number(value) & 0xFF)
  const addBlocks = Array.isArray(data.AddBlocks) ? Array.from(data.AddBlocks, (value) => Number(value) & 0xFF) : []
  const combinedLength = Math.min(volume, blocks.length, metadata.length)

  data.Blocks = blocks.map((lowId, index) => ({
    index,
    position: positionFromIndexYZX(index, size),
    lowId
  }))

  data.Data = metadata.map((legacyData, index) => ({
    index,
    position: positionFromIndexYZX(index, size),
    legacyData
  }))

  if (Array.isArray(data.AddBlocks)) {
    data.AddBlocks = addBlocks.map((packed, index) => ({
      index,
      evenBlockIndex: index * 2,
      evenHighBits: packed & 0x0F,
      oddBlockIndex: index * 2 + 1,
      oddHighBits: (packed >> 4) & 0x0F
    }))
  }

  // .schematic is the one approved exception because one readable block meaning is
  // jointly encoded across Blocks, AddBlocks, and Data, so a same-layer companion
  // field is needed to express that combined interpretation without inventing a
  // cross-format helper schema elsewhere.
  data.Blocks_AddBlocks_Data = Array.from({ length: combinedLength }, (_, index) => {
    const lowId = blocks[index] || 0
    const highId = addHighBitsFromMcEditAddBlocks(index, addBlocks)
    return {
      index,
      position: positionFromIndexYZX(index, size),
      lowId,
      highId,
      legacyBlockId: lowId + (highId << 8),
      legacyData: metadata[index] || 0
    }
  })

  if (options.filterAir === true) {
    data.Blocks_AddBlocks_Data = filterReadableEntries(data.Blocks_AddBlocks_Data, (entry) => {
      if (!entry || typeof entry !== 'object') return null
      return entry.legacyBlockId === 0 ? 'minecraft:air' : null
    })
  }

  return data
}

function translateLitematicReadableDataInPlace (data, options = {}) {
  if (!isLitematicData(data)) return data

  for (const region of Object.values(data.Regions)) {
    if (!region || !region.Size || !region.Position) continue

    const sx = Number(region.Size.x) || 0
    const sy = Number(region.Size.y) || 0
    const sz = Number(region.Size.z) || 0
    const xAxis = litematicAxisMinAndSize(Number(region.Position.x) || 0, sx)
    const yAxis = litematicAxisMinAndSize(Number(region.Position.y) || 0, sy)
    const zAxis = litematicAxisMinAndSize(Number(region.Position.z) || 0, sz)
    const volume = xAxis.size * yAxis.size * zAxis.size
    const palette = Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : []

    if (!Array.isArray(region.BlockStates) || volume <= 0 || palette.length === 0) continue

    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, palette.length))))
    const decodedStates = decodePackedLitematicStates(region.BlockStates, bitsPerBlock, volume)
    const translatedStates = decodedStates.map((paletteIndexRaw, index) => {
      const paletteIndex = Number(paletteIndexRaw) || 0
      const paletteEntry = palette[paletteIndex] || {}
      return {
        index,
        localPosition: positionFromIndexYZX(index, {
          x: xAxis.size,
          y: yAxis.size,
          z: zAxis.size
        }),
        paletteIndex,
        blockState: paletteEntry.Name || paletteEntry.name || null,
        properties: paletteEntry.Properties || paletteEntry.properties || {}
      }
    })

    region.BlockStates = options.filterAir === true
      ? filterReadableEntries(translatedStates, resolveReadableBlockStateName)
      : translatedStates
  }

  return data
}

function clonePaletteState (paletteEntry) {
  if (!paletteEntry || typeof paletteEntry !== 'object') return null

  const cloned = {}
  if (paletteEntry.name !== undefined) cloned.name = paletteEntry.name
  if (paletteEntry.Name !== undefined) cloned.Name = paletteEntry.Name
  if (paletteEntry.states && typeof paletteEntry.states === 'object' && !Array.isArray(paletteEntry.states)) {
    cloned.states = cloneNativeValue(paletteEntry.states)
  }
  if (paletteEntry.Properties && typeof paletteEntry.Properties === 'object' && !Array.isArray(paletteEntry.Properties)) {
    cloned.Properties = cloneNativeValue(paletteEntry.Properties)
  }
  if (paletteEntry.properties && typeof paletteEntry.properties === 'object' && !Array.isArray(paletteEntry.properties)) {
    cloned.properties = cloneNativeValue(paletteEntry.properties)
  }
  if (paletteEntry.version !== undefined) cloned.version = paletteEntry.version
  return cloned
}

function translateMcstructureReadableDataInPlace (data, options = {}) {
  if (!isBedrockMcstructureData(data)) return data

  const size = normalizePosition(data.size[0], data.size[1], data.size[2])
  const paletteLayers = data?.structure?.palette
  const defaultPalette = Array.isArray(paletteLayers?.default?.block_palette)
    ? paletteLayers.default.block_palette
    : []
  const blockIndices = Array.isArray(data?.structure?.block_indices)
    ? data.structure.block_indices
    : null

  if (!blockIndices) return data

  data.structure.block_indices = blockIndices.map((layerEntries, layerIndex) => {
    if (!Array.isArray(layerEntries)) return layerEntries

    const translatedLayer = layerEntries.map((paletteIndexRaw, index) => {
      const paletteIndex = Number(paletteIndexRaw)
      const resolvedPalette = Number.isInteger(paletteIndex) && paletteIndex >= 0 && paletteIndex < defaultPalette.length
        ? clonePaletteState(defaultPalette[paletteIndex])
        : null

      return {
        index,
        position: positionFromIndexZYX(index, size),
        layer: layerIndex,
        paletteIndex,
        block: resolvedPalette
      }
    })

    if (options.filterAir === true) {
      return filterMcstructureReadableEntries(translatedLayer)
    }

    return translatedLayer
  })

  return data
}

function formatNativeDataForOutput (simplified, declaredFormat, options = {}) {
  if (!options.readable) return simplified

  const translated = cloneNativeValue(simplified)
  const unwrapped = unwrapSchematicRoot(translated)
  const readableOptions = { filterAir: options.filterAir === true }

  if (declaredFormat === 'schem') {
    translateSpongeReadableDataInPlace(unwrapped, readableOptions)
    return translated
  }

  if (declaredFormat === 'schematic') {
    if (looksLikeMcEditSchematic(unwrapped)) {
      translateMcEditReadableDataInPlace(unwrapped, readableOptions)
    } else {
      translateSpongeReadableDataInPlace(unwrapped, readableOptions)
    }
    return translated
  }

  if (declaredFormat === 'litematic') {
    translateLitematicReadableDataInPlace(translated, readableOptions)
    return translated
  }

  if (declaredFormat === 'mcstructure') {
    translateMcstructureReadableDataInPlace(translated, readableOptions)
    return translated
  }

  return translated
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

async function readSchematicWithFallback (buffer, versionHint, logger = console) {
  return withSchematicConsoleLogRedirect(logger, async () => {
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
  })
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
    const schema = classifyNativeNbtSchema(nbtInfo.simplified, format)
    return {
      format,
      schema,
      parser: 'prismarine-nbt',
      sourceFile: sourcePath,
      nbtEndian: nbtInfo.nbtEndian,
      nbtParseHint: nbtInfo.nbtParseHint,
      versionHint: options.version || null,
      data: formatNativeDataForOutput(nbtInfo.simplified, format, options)
    }
  }

  throw new Error(`Internal error: unsupported detected format ${format}`)
}

module.exports = {
  classifyNativeNbtSchema,
  decodePackedLitematicStates,
  detectStructureFormat,
  DEFAULT_UNIFIED_PARSE_VERSION,
  inferStructureParseVersion,
  inferBedrockVersionSelectionFromSimplified,
  isAirName,
  litematicAxisMinAndSize,
  normalizePosition,
  resolveUnifiedParseVersion,
  parseNbtAuto,
  positionFromIndexYZX,
  positionFromIndexZYX,
  relativePosition,
  readSchematicWithFallback,
  stripMinecraftNamespace,
  unwrapSchematicRoot,
  isJavaStructureNbt,
  isBedrockMcstructureData,
  isLitematicData,
  loadNativeStructure
}
