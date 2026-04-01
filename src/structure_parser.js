const path = require('path')
const nbt = require('prismarine-nbt')
const { Schematic } = require('prismarine-schematic')
const spongeSchematic = require('prismarine-schematic/lib/spongeSchematic')
const mceditSchematic = require('prismarine-schematic/lib/mceditSchematic')
const { parseBlockName, getStateId } = require('prismarine-schematic/lib/states')
const { Vec3 } = require('vec3')
const versions = require('minecraft-data').versions.pc

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
  const body = keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')
  return `{${body}}`
}

function createPaletteKey (entry) {
  return [
    entry.namespaceName || '',
    entry.stateId ?? 'null',
    entry.blockId ?? 'null',
    entry.metadata ?? 'null',
    stableStringify(entry.properties || {})
  ].join('|')
}

function createPaletteAccumulator () {
  return {
    entries: [],
    keyToIndex: new Map()
  }
}

function upsertPalette (acc, blockDescriptor) {
  const key = createPaletteKey(blockDescriptor)
  const existing = acc.keyToIndex.get(key)
  if (existing !== undefined) return existing

  const paletteIndex = acc.entries.length
  acc.entries.push({
    paletteIndex,
    blockName: blockDescriptor.blockName || null,
    namespaceName: blockDescriptor.namespaceName || null,
    displayName: blockDescriptor.displayName || null,
    stateId: blockDescriptor.stateId ?? null,
    blockId: blockDescriptor.blockId ?? null,
    metadata: blockDescriptor.metadata ?? null,
    properties: blockDescriptor.properties || {},
    usageCount: 0,
    sourceHints: blockDescriptor.sourceHints || {}
  })
  acc.keyToIndex.set(key, paletteIndex)
  return paletteIndex
}

function addBlockRecord ({
  blocks,
  paletteAcc,
  position,
  structureOrigin,
  blockName,
  namespaceName,
  displayName,
  stateId,
  blockId,
  metadata,
  properties,
  blockEntityData,
  source,
  sourcePaletteIndex,
  regionOrigin
}) {
  const paletteIndex = upsertPalette(paletteAcc, {
    blockName,
    namespaceName,
    displayName,
    stateId,
    blockId,
    metadata,
    properties,
    sourceHints: {
      format: source?.format || null,
      sourcePaletteIndex: sourcePaletteIndex ?? null
    }
  })

  paletteAcc.entries[paletteIndex].usageCount++

  const relStructure = relativePosition(position, structureOrigin)
  const relRegion = regionOrigin ? relativePosition(position, regionOrigin) : null

  blocks.push({
    position,
    relativePosition: relStructure,
    relativePositionByScope: {
      structure: relStructure,
      region: relRegion
    },
    paletteIndex,
    stateId: stateId ?? null,
    blockName: blockName || null,
    namespaceName: namespaceName || null,
    displayName: displayName || null,
    blockId: blockId ?? null,
    metadata: metadata ?? null,
    properties: properties || {},
    blockEntityData: blockEntityData || null,
    isAir: isAirName(blockName),
    source: {
      ...(source || {}),
      native: {
        ...(source?.native || {}),
        sourcePaletteIndex: sourcePaletteIndex ?? null
      }
    }
  })
}

function getMcstructurePositionData (blockPositionData, absoluteIndex) {
  if (!blockPositionData || typeof blockPositionData !== 'object') return null
  return blockPositionData[String(absoluteIndex)] || null
}

function defaultSchemaFields () {
  return [
    'position',
    'relativePosition',
    'relativePositionByScope',
    'paletteIndex',
    'stateId',
    'blockName',
    'namespaceName',
    'displayName',
    'blockId',
    'metadata',
    'properties',
    'blockEntityData',
    'isAir',
    'source'
  ]
}

function buildMeta ({
  sourceFile,
  sourceFormat,
  normalizedFormat,
  parser,
  parserVersionHint,
  parsedMinecraftVersion,
  nbtEndian,
  includeAir,
  size,
  offset,
  totalPositions,
  outputBlockCount,
  paletteCount,
  extra
}) {
  const meta = {
    sourceFile,
    sourceFormat,
    normalizedFormat,
    parsedAt: new Date().toISOString(),
    parser,
    parserVersionHint: parserVersionHint || null,
    parsedMinecraftVersion: parsedMinecraftVersion ?? null,
    nbtEndian: nbtEndian || null,
    includeAir,
    size: size || null,
    offset: offset || null,
    totalPositions: totalPositions ?? null,
    outputBlockCount,
    paletteCount,
    schema: { blockFields: defaultSchemaFields() }
  }

  if (extra) meta.extra = extra
  return meta
}

async function parseSchematicLike (buffer, options, sourcePath, sourceFormat) {
  const schematic = await readSchematicWithFallback(buffer, options.version)
  const blocks = []
  const paletteAcc = createPaletteAccumulator()

  const offset = normalizePosition(schematic.offset.x, schematic.offset.y, schematic.offset.z)
  const size = normalizePosition(schematic.size.x, schematic.size.y, schematic.size.z)

  await schematic.forEach(async (block, pos) => {
    const air = isAirName(block.name)
    if (air && !options.includeAir) return

    const position = normalizePosition(pos.x, pos.y, pos.z)
    const stateId = schematic.getBlockStateId(pos)
    const properties = typeof block.getProperties === 'function' ? block.getProperties() : {}
    const namespaceName = block.name && block.name.includes(':') ? block.name : (block.name ? `minecraft:${block.name}` : null)

    addBlockRecord({
      blocks,
      paletteAcc,
      position,
      structureOrigin: offset,
      blockName: block.name || null,
      namespaceName,
      displayName: block.displayName || null,
      stateId,
      blockId: block.type ?? null,
      metadata: block.metadata ?? null,
      properties,
      blockEntityData: null,
      source: {
        format: sourceFormat === 'schematic' ? 'mcedit-or-sponge-schematic' : 'sponge-schematic',
        native: {
          biome: block.biome?.name || null,
          hardness: block.hardness ?? null,
          diggable: block.diggable ?? null,
          transparent: block.transparent ?? null,
          emitLight: block.emitLight ?? null,
          filterLight: block.filterLight ?? null,
          boundingBox: block.boundingBox || null
        }
      },
      sourcePaletteIndex: schematic.palette.indexOf(stateId),
      regionOrigin: null
    })
  })

  return {
    meta: buildMeta({
      sourceFile: sourcePath,
      sourceFormat,
      normalizedFormat: 'schematic-like',
      parser: 'prismarine-schematic',
      parserVersionHint: options.version,
      parsedMinecraftVersion: schematic.version,
      nbtEndian: null,
      includeAir: options.includeAir,
      size,
      offset,
      totalPositions: size.x * size.y * size.z,
      outputBlockCount: blocks.length,
      paletteCount: paletteAcc.entries.length
    }),
    palette: paletteAcc.entries,
    blocks
  }
}

function parseJavaStructureNbt (simplified, options, sourcePath, nbtInfo, sourceFormat) {
  const sizeArr = simplified.size
  const palette = simplified.palette
  const blockList = simplified.blocks

  if (!Array.isArray(sizeArr) || sizeArr.length !== 3 || !Array.isArray(palette) || !Array.isArray(blockList)) {
    return null
  }

  const size = normalizePosition(sizeArr[0], sizeArr[1], sizeArr[2])
  const offset = normalizePosition(0, 0, 0)
  const blocks = []
  const paletteAcc = createPaletteAccumulator()

  for (const entry of blockList) {
    if (!entry || !Array.isArray(entry.pos) || entry.pos.length !== 3) continue

    const srcPaletteIndex = Number(entry.state)
    if (Number.isNaN(srcPaletteIndex) || srcPaletteIndex < 0 || srcPaletteIndex >= palette.length) continue

    const paletteEntry = palette[srcPaletteIndex] || {}
    const blockName = paletteEntry.Name || paletteEntry.name || null
    if (isAirName(blockName) && !options.includeAir) continue

    const position = normalizePosition(entry.pos[0], entry.pos[1], entry.pos[2])
    const properties = paletteEntry.Properties || paletteEntry.properties || {}

    addBlockRecord({
      blocks,
      paletteAcc,
      position,
      structureOrigin: offset,
      blockName,
      namespaceName: blockName,
      displayName: null,
      stateId: null,
      blockId: null,
      metadata: null,
      properties,
      blockEntityData: entry.nbt || null,
      source: {
        format: 'java-structure-nbt',
        native: {
          dataVersion: simplified.DataVersion ?? null
        }
      },
      sourcePaletteIndex: srcPaletteIndex,
      regionOrigin: null
    })
  }

  return {
    meta: buildMeta({
      sourceFile: sourcePath,
      sourceFormat,
      normalizedFormat: 'nbt-java-structure',
      parser: 'prismarine-nbt',
      parserVersionHint: options.version,
      parsedMinecraftVersion: simplified.DataVersion ?? null,
      nbtEndian: nbtInfo.nbtEndian,
      includeAir: options.includeAir,
      size,
      offset,
      totalPositions: size.x * size.y * size.z,
      outputBlockCount: blocks.length,
      paletteCount: paletteAcc.entries.length,
      extra: {
        nbtParseHint: nbtInfo.nbtParseHint
      }
    }),
    palette: paletteAcc.entries,
    blocks
  }
}

function parseBedrockMcstructure (simplified, options, sourcePath, nbtInfo, sourceFormat) {
  const sizeArr = simplified.size
  const structure = simplified.structure
  const palette = structure?.palette?.default?.block_palette
  const blockIndicesLayers = structure?.block_indices

  if (!Array.isArray(sizeArr) || sizeArr.length !== 3 || !Array.isArray(palette) || !Array.isArray(blockIndicesLayers)) {
    return null
  }

  const primaryIndices = blockIndicesLayers[0]
  if (!Array.isArray(primaryIndices)) return null

  const size = normalizePosition(sizeArr[0], sizeArr[1], sizeArr[2])
  const originArr = simplified.structure_world_origin
  const offset = Array.isArray(originArr) && originArr.length === 3
    ? normalizePosition(originArr[0], originArr[1], originArr[2])
    : normalizePosition(0, 0, 0)

  const blocks = []
  const paletteAcc = createPaletteAccumulator()
  const blockPositionData = structure?.palette?.default?.block_position_data

  for (let i = 0; i < primaryIndices.length; i++) {
    const srcPaletteIndex = Number(primaryIndices[i])
    if (srcPaletteIndex < 0 || srcPaletteIndex >= palette.length) continue

    const p = positionFromIndexZYX(i, size)
    const position = normalizePosition(p.x + offset.x, p.y + offset.y, p.z + offset.z)

    const paletteEntry = palette[srcPaletteIndex] || {}
    const blockName = paletteEntry.name || null
    if (isAirName(blockName) && !options.includeAir) continue

    addBlockRecord({
      blocks,
      paletteAcc,
      position,
      structureOrigin: offset,
      blockName,
      namespaceName: blockName,
      displayName: null,
      stateId: null,
      blockId: null,
      metadata: null,
      properties: paletteEntry.states || {},
      blockEntityData: getMcstructurePositionData(blockPositionData, i),
      source: {
        format: 'mcstructure-bedrock',
        native: {
          formatVersion: simplified.format_version ?? null,
          paletteVersion: paletteEntry.version ?? null,
          hasSecondaryLayer: Array.isArray(blockIndicesLayers[1])
        }
      },
      sourcePaletteIndex: srcPaletteIndex,
      regionOrigin: null
    })
  }

  return {
    meta: buildMeta({
      sourceFile: sourcePath,
      sourceFormat,
      normalizedFormat: 'mcstructure-bedrock',
      parser: 'prismarine-nbt',
      parserVersionHint: options.version,
      parsedMinecraftVersion: null,
      nbtEndian: nbtInfo.nbtEndian,
      includeAir: options.includeAir,
      size,
      offset,
      totalPositions: size.x * size.y * size.z,
      outputBlockCount: blocks.length,
      paletteCount: paletteAcc.entries.length,
      extra: {
        nbtParseHint: nbtInfo.nbtParseHint
      }
    }),
    palette: paletteAcc.entries,
    blocks
  }
}

function parseLitematic (simplified, options, sourcePath, nbtInfo, sourceFormat) {
  const regions = simplified.Regions
  if (!regions || typeof regions !== 'object' || Array.isArray(regions)) return null

  const regionNames = Object.keys(regions)
  if (regionNames.length === 0) return null

  const blocks = []
  const paletteAcc = createPaletteAccumulator()

  let totalPositions = 0
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY

  for (const regionName of regionNames) {
    const region = regions[regionName]
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

    const regionOrigin = normalizePosition(xAxis.min, yAxis.min, zAxis.min)
    const regionSize = normalizePosition(sx, sy, sz)

    const regionPalette = Array.isArray(region.BlockStatePalette) ? region.BlockStatePalette : []
    const packedStates = Array.isArray(region.BlockStates) ? region.BlockStates : []
    const regionBlockCount = xAxis.size * yAxis.size * zAxis.size

    totalPositions += regionBlockCount
    if (regionPalette.length === 0) continue

    const bitsPerBlock = Math.max(2, Math.ceil(Math.log2(Math.max(1, regionPalette.length))))
    const unpackedStates = decodePackedLitematicStates(packedStates, bitsPerBlock, regionBlockCount)

    for (let i = 0; i < unpackedStates.length; i++) {
      const srcPaletteIndex = unpackedStates[i]
      if (srcPaletteIndex < 0 || srcPaletteIndex >= regionPalette.length) continue

      const local = positionFromIndexYZX(i, { x: xAxis.size, y: yAxis.size, z: zAxis.size })
      const position = normalizePosition(xAxis.min + local.x, yAxis.min + local.y, zAxis.min + local.z)

      const paletteEntry = regionPalette[srcPaletteIndex] || {}
      const blockName = paletteEntry.Name || paletteEntry.name || null
      if (isAirName(blockName) && !options.includeAir) continue

      addBlockRecord({
        blocks,
        paletteAcc,
        position,
        structureOrigin: { x: 0, y: 0, z: 0 },
        blockName,
        namespaceName: blockName,
        displayName: null,
        stateId: null,
        blockId: null,
        metadata: null,
        properties: paletteEntry.Properties || paletteEntry.properties || {},
        blockEntityData: null,
        source: {
          format: 'litematic',
          native: {
            regionName,
            regionOrigin,
            regionSize
          }
        },
        sourcePaletteIndex: srcPaletteIndex,
        regionOrigin
      })
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(minZ)) return null

  const globalOffset = normalizePosition(minX, minY, minZ)
  const globalSize = normalizePosition(maxX - minX + 1, maxY - minY + 1, maxZ - minZ + 1)

  for (const block of blocks) {
    const rel = relativePosition(block.position, globalOffset)
    block.relativePosition = rel
    block.relativePositionByScope.structure = rel
  }

  return {
    meta: buildMeta({
      sourceFile: sourcePath,
      sourceFormat,
      normalizedFormat: 'litematic',
      parser: 'prismarine-nbt',
      parserVersionHint: options.version,
      parsedMinecraftVersion: simplified.MinecraftDataVersion ?? null,
      nbtEndian: nbtInfo.nbtEndian,
      includeAir: options.includeAir,
      size: globalSize,
      offset: globalOffset,
      totalPositions,
      outputBlockCount: blocks.length,
      paletteCount: paletteAcc.entries.length,
      extra: {
        nbtParseHint: nbtInfo.nbtParseHint,
        litematicVersion: simplified.Version ?? null,
        litematicSubVersion: simplified.SubVersion ?? null,
        regionCount: regionNames.length,
        metadata: simplified.Metadata || null
      }
    }),
    palette: paletteAcc.entries,
    blocks
  }
}

function parseGenericNbt (simplified, options, sourcePath, nbtInfo, sourceFormat) {
  return {
    meta: buildMeta({
      sourceFile: sourcePath,
      sourceFormat,
      normalizedFormat: 'nbt-generic',
      parser: 'prismarine-nbt',
      parserVersionHint: options.version,
      parsedMinecraftVersion: null,
      nbtEndian: nbtInfo.nbtEndian,
      includeAir: options.includeAir,
      size: null,
      offset: null,
      totalPositions: null,
      outputBlockCount: 0,
      paletteCount: 0,
      extra: {
        nbtParseHint: nbtInfo.nbtParseHint,
        warning: 'NBT parsed successfully, but no recognized block-structure schema was detected.'
      }
    }),
    palette: [],
    blocks: [],
    rawNbt: simplified
  }
}

async function loadStructurePayload (buffer, format, options = {}, sourcePath = null) {
  const normalizedOptions = {
    includeAir: Boolean(options.includeAir),
    version: options.version
  }

  if (format === 'schem' || format === 'schematic') {
    return parseSchematicLike(buffer, normalizedOptions, sourcePath, format)
  }

  const nbtInfo = await parseNbtAuto(buffer)
  const { simplified } = nbtInfo

  if (format === 'litematic') {
    const litematic = parseLitematic(simplified, normalizedOptions, sourcePath, nbtInfo, format)
    if (litematic) return litematic
    throw new Error('File extension is .litematic but required Litematic tags were not found')
  }

  if (format === 'mcstructure') {
    const mcstructure = parseBedrockMcstructure(simplified, normalizedOptions, sourcePath, nbtInfo, format)
    if (mcstructure) return mcstructure
    throw new Error('File extension is .mcstructure but Bedrock structure tags were not found')
  }

  if (format === 'nbt') {
    const litematic = parseLitematic(simplified, normalizedOptions, sourcePath, nbtInfo, format)
    if (litematic) return litematic

    const javaStructure = parseJavaStructureNbt(simplified, normalizedOptions, sourcePath, nbtInfo, format)
    if (javaStructure) return javaStructure

    const mcstructure = parseBedrockMcstructure(simplified, normalizedOptions, sourcePath, nbtInfo, format)
    if (mcstructure) return mcstructure

    return parseGenericNbt(simplified, normalizedOptions, sourcePath, nbtInfo, format)
  }

  throw new Error(`Internal error: unsupported detected format ${format}`)
}

module.exports = {
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
  loadStructurePayload
}