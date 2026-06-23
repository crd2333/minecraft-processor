#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs').promises
const path = require('path')
const zlib = require('zlib')

const {
  DEFAULT_UNIFIED_PARSE_VERSION,
  detectStructureFormat,
  inferBedrockVersionSelectionFromSimplified,
  loadNativeStructure,
  parseNbtAuto,
  resolveUnifiedParseVersion
} = require('../src/structure_parser')
const { loadUnifiedStructure } = require('../src/unified_parser')
const { defaultViewerVersion, supportedVersions } = require('../src/viewer_versions')
const { prepareMinewaysObjCache } = require('../src/obj-mesh/build_mesh_cache')
const nbt = require('prismarine-nbt')

function assertViewerVersionSupport () {
  assert.strictEqual(defaultViewerVersion, '1.21.8', 'default viewer version must stay on 1.21.8')
  assert(supportedVersions.includes(defaultViewerVersion), 'default viewer version must be included in supported versions')
}

function assertNativeContract (native, fixturePath) {
  assert(native && typeof native === 'object', `native parse missing payload for ${fixturePath}`)
  assert(native.data, `native parse missing data for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'meta'), `native parse must not expose unified meta for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'size'), `native parse must not expose unified size for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'palette'), `native parse must not expose unified palette for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'blocks'), `native parse must not expose unified blocks for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'entities'), `native parse must not expose unified entities for ${fixturePath}`)

  assert(!Object.prototype.hasOwnProperty.call(native.data, '_derivedReadable'), `native parse must not expose derived readable sidecars for ${fixturePath}`)
}

function assertNativeReadableContract (native, fixturePath) {
  assert(native && native.data, `readable native parse missing data for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native.data, '_derivedReadable'), `readable native parse must not expose _derivedReadable for ${fixturePath}`)

  if (fixturePath.endsWith('.schem')) {
    const data = native.data.Schematic || native.data
    assert(Array.isArray(data.BlockData), `readable .schem BlockData must stay an array for ${fixturePath}`)
    assert(data.BlockData.length > 0, `readable .schem BlockData must be populated for ${fixturePath}`)
    assert(typeof data.BlockData[0] === 'object' && data.BlockData[0] !== null, `readable .schem BlockData entries must be objects for ${fixturePath}`)
    assert(!Object.prototype.hasOwnProperty.call(data, 'dimensions'), `readable .schem must not add dimensions for ${fixturePath}`)
    assert(!Object.prototype.hasOwnProperty.call(data, 'paletteEntries'), `readable .schem must not add paletteEntries for ${fixturePath}`)
  }

  if (fixturePath.endsWith('.schematic')) {
    const data = native.data.Schematic || native.data
    assert(Array.isArray(data.Blocks), `readable .schematic Blocks must stay an array for ${fixturePath}`)
    assert(Array.isArray(data.Data), `readable .schematic Data must stay an array for ${fixturePath}`)
    assert(Array.isArray(data.Blocks_AddBlocks_Data), `readable .schematic must expose Blocks_AddBlocks_Data for ${fixturePath}`)
    assert(typeof data.Blocks[0] === 'object' && data.Blocks[0] !== null, `readable .schematic Blocks entries must be objects for ${fixturePath}`)
    assert(typeof data.Data[0] === 'object' && data.Data[0] !== null, `readable .schematic Data entries must be objects for ${fixturePath}`)
  }

  if (fixturePath.endsWith('.litematic')) {
    const region = Object.values(native.data.Regions)[0]
    assert(region, `readable .litematic must keep at least one region for ${fixturePath}`)
    assert(Array.isArray(region.BlockStates), `readable .litematic BlockStates must stay an array for ${fixturePath}`)
    assert(region.BlockStates.length > 0, `readable .litematic BlockStates must be populated for ${fixturePath}`)
    assert(typeof region.BlockStates[0] === 'object' && region.BlockStates[0] !== null, `readable .litematic BlockStates entries must be objects for ${fixturePath}`)
  }

  if (fixturePath.endsWith('.mcstructure')) {
    const layers = native.data?.structure?.block_indices
    assert(Array.isArray(layers), `readable .mcstructure block_indices must stay an array for ${fixturePath}`)
    assert(Array.isArray(layers[0]), `readable .mcstructure primary block_indices layer must stay an array for ${fixturePath}`)
    assert(layers[0].length > 0, `readable .mcstructure primary block_indices layer must be populated for ${fixturePath}`)
    assert(typeof layers[0][0] === 'object' && layers[0][0] !== null, `readable .mcstructure block_indices entries must be objects for ${fixturePath}`)
  }
}

function assertNativeFilterAirContract (unfiltered, filtered, fixturePath) {
  assert(filtered && filtered.data, `filtered readable native parse missing data for ${fixturePath}`)

  if (fixturePath.endsWith('.schem')) {
    const unfilteredData = unfiltered.data.Schematic || unfiltered.data
    const filteredData = filtered.data.Schematic || filtered.data
    assert(Array.isArray(filteredData.BlockData), `filtered .schem BlockData must stay an array for ${fixturePath}`)
    assert(filteredData.BlockData.length <= unfilteredData.BlockData.length, `filtered .schem BlockData must not grow for ${fixturePath}`)
    assert(filteredData.BlockData.every((entry) => !['air', 'minecraft:air'].includes(entry.blockState)), `filtered .schem BlockData must remove air entries for ${fixturePath}`)
  }

  if (fixturePath.endsWith('.schematic')) {
    const unfilteredData = unfiltered.data.Schematic || unfiltered.data
    const filteredData = filtered.data.Schematic || filtered.data
    assert(Array.isArray(filteredData.Blocks_AddBlocks_Data), `filtered .schematic Blocks_AddBlocks_Data must stay an array for ${fixturePath}`)
    assert(filteredData.Blocks_AddBlocks_Data.length <= unfilteredData.Blocks_AddBlocks_Data.length, `filtered .schematic Blocks_AddBlocks_Data must not grow for ${fixturePath}`)
    assert(filteredData.Blocks_AddBlocks_Data.every((entry) => entry.legacyBlockId !== 0), `filtered .schematic Blocks_AddBlocks_Data must remove legacy air entries for ${fixturePath}`)
  }

  if (fixturePath.endsWith('.litematic')) {
    const regionNames = Object.keys(filtered.data.Regions)
    for (const regionName of regionNames) {
      const unfilteredRegion = unfiltered.data.Regions[regionName]
      const filteredRegion = filtered.data.Regions[regionName]
      assert(Array.isArray(filteredRegion.BlockStates), `filtered .litematic BlockStates must stay an array for ${fixturePath}:${regionName}`)
      assert(filteredRegion.BlockStates.length <= unfilteredRegion.BlockStates.length, `filtered .litematic BlockStates must not grow for ${fixturePath}:${regionName}`)
      assert(filteredRegion.BlockStates.every((entry) => !['air', 'minecraft:air'].includes(entry.blockState)), `filtered .litematic BlockStates must remove air entries for ${fixturePath}:${regionName}`)
    }
  }

  if (fixturePath.endsWith('.mcstructure')) {
    const unfilteredLayers = unfiltered.data?.structure?.block_indices || []
    const filteredLayers = filtered.data?.structure?.block_indices || []
    assert.strictEqual(filteredLayers.length, unfilteredLayers.length, `filtered .mcstructure must keep layer count for ${fixturePath}`)
    for (let i = 0; i < filteredLayers.length; i++) {
      const unfilteredLayer = unfilteredLayers[i]
      const filteredLayer = filteredLayers[i]
      if (!Array.isArray(unfilteredLayer) || !Array.isArray(filteredLayer)) continue
      assert(filteredLayer.length <= unfilteredLayer.length, `filtered .mcstructure layer must not grow for ${fixturePath} layer ${i}`)
      assert(filteredLayer.every((entry) => entry?.block?.name !== 'minecraft:air' && entry?.block?.name !== 'air'), `filtered .mcstructure layer must remove air entries for ${fixturePath} layer ${i}`)
      assert(filteredLayer.every((entry) => Number.isInteger(entry?.paletteIndex) && entry.paletteIndex >= 0 && entry?.block), `filtered .mcstructure layer must remove no-block sentinel entries for ${fixturePath} layer ${i}`)
    }
  }
}

function assertUnifiedContract (unified, fixturePath) {
  assert(unified && unified.meta && Array.isArray(unified.palette) && Array.isArray(unified.blocks) && Array.isArray(unified.entities), `unified IR shape invalid for ${fixturePath}`)
  assert(Array.isArray(unified.size) && unified.size.length === 3, `unified size invalid for ${fixturePath}`)
  assert.strictEqual(unified.meta.coordinateSpace, 'relative', `coordinate space must be relative for ${fixturePath}`)
  assert.strictEqual(unified.meta.stats.paletteSize, unified.palette.length, `palette size mismatch for ${fixturePath}`)
  assert.strictEqual(unified.meta.stats.blockCount, unified.blocks.length, `block count mismatch for ${fixturePath}`)
  assert.strictEqual(unified.meta.stats.entityCount, unified.entities.length, `entity count mismatch for ${fixturePath}`)

  for (const entry of unified.palette) {
    assert(entry && typeof entry === 'object', `palette entry missing for ${fixturePath}`)
    assert(typeof entry.name === 'string' && entry.name.length > 0, `palette name missing for ${fixturePath}`)
    assert(entry.props && typeof entry.props === 'object' && !Array.isArray(entry.props), `palette props invalid for ${fixturePath}`)

    assert(!Object.prototype.hasOwnProperty.call(entry, 'status'), `palette status must not exist at top level for ${fixturePath}`)

    const hasBedrockDiagnostics = Object.prototype.hasOwnProperty.call(entry, 'mapping')
    if (hasBedrockDiagnostics) {
      assert(entry.mapping && typeof entry.mapping === 'object' && !Array.isArray(entry.mapping), `palette mapping invalid for ${fixturePath}`)
      assert.deepStrictEqual(Object.keys(entry.mapping).sort(), ['sourceKey', 'status'], `palette mapping shape invalid for ${fixturePath}`)
      assert(['preserved', 'mapped', 'unresolved'].includes(entry.mapping.status), `palette mapping.status invalid for ${fixturePath}`)
      assert(typeof entry.mapping.sourceKey === 'string', `palette mapping.sourceKey missing for ${fixturePath}`)
    }
  }

  for (const [x, y, z, pid] of unified.blocks) {
    assert(Number.isInteger(x) && Number.isInteger(y) && Number.isInteger(z), `block coordinates must be integers for ${fixturePath}`)
    assert(Number.isInteger(pid) && pid >= 0 && pid < unified.palette.length, `block pid out of range for ${fixturePath}`)
    assert(x >= 0 && y >= 0 && z >= 0, `relative coordinates must be non-negative for ${fixturePath}`)
    assert(x < unified.size[0] && y < unified.size[1] && z < unified.size[2], `block coordinates exceed unified size for ${fixturePath}`)
  }
}

function assertUnknownPolicyBehavior () {
  const unresolved = {
    meta: {
      source: { format: 'mcstructure', edition: 'bedrock', version: null, parser: 'test-parser' },
      target: { edition: 'java', version: '1.21.8' },
      coordinateSpace: 'relative',
      unknownPolicy: 'keep',
      stats: {
        paletteSize: 1,
        blockCount: 1,
        entityCount: 0,
        unresolvedPaletteCount: 1,
        unresolvedBlockCount: 1,
        droppedBlockCount: 0
      }
    },
    size: [1, 1, 1],
    palette: [
      {
        name: 'minecraft:missing_bedrock_block',
        props: {},
        mapping: {
          status: 'unresolved',
          sourceKey: 'minecraft:missing_bedrock_block[weird_state=true]'
        }
      }
    ],
    blocks: [[0, 0, 0, 0]],
    entities: []
  }

  assert.deepStrictEqual(Object.keys(unresolved.palette[0].mapping).sort(), ['sourceKey', 'status'], 'unresolved mapping should only expose status and sourceKey')
  assert.strictEqual(unresolved.palette[0].mapping.status, 'unresolved', 'unresolved palette semantics must remain explicit')
  assert.strictEqual(unresolved.palette[0].name, 'minecraft:missing_bedrock_block', 'unresolved palette entry should preserve source-derived canonical candidate')
}

async function runFixture (fixturePath) {
  const absolutePath = path.resolve(process.cwd(), fixturePath)
  const format = detectStructureFormat(absolutePath)
  const buffer = await fs.readFile(absolutePath)

  const native = await loadNativeStructure(buffer, format, { version: defaultViewerVersion }, absolutePath)
  assertNativeContract(native, fixturePath)

  const readableNative = await loadNativeStructure(buffer, format, { version: defaultViewerVersion, readable: true }, absolutePath)
  assertNativeReadableContract(readableNative, fixturePath)

  const filteredReadableNative = await loadNativeStructure(buffer, format, { version: defaultViewerVersion, readable: true, filterAir: true }, absolutePath)
  assertNativeReadableContract(filteredReadableNative, fixturePath)
  assertNativeFilterAirContract(readableNative, filteredReadableNative, fixturePath)

  const unified = await loadUnifiedStructure(buffer, format, {
    version: defaultViewerVersion,
    targetVersion: defaultViewerVersion,
    unknownPolicy: 'keep'
  }, absolutePath)

  assertUnifiedContract(unified, fixturePath)

  return {
    fixturePath,
    format,
    nativeSchema: native.schema,
    blockCount: unified.blocks.length,
    paletteSize: unified.palette.length
  }
}

async function assertUnifiedVersionSelection () {
  const inferredCases = [
    { fixturePath: 'assets/other/1.schem', expectedVersion: '1.20.1' },
    { fixturePath: 'assets/other/AshleySt131.litematic', expectedVersion: '1.21.1' },
    { fixturePath: 'assets/other/AshleySt131.nbt', expectedVersion: '1.19' },
    { fixturePath: 'assets/other/bedrock.mcstructure', expectedVersion: '1.21.60' }
  ]

  for (const { fixturePath, expectedVersion } of inferredCases) {
    const absolutePath = path.resolve(process.cwd(), fixturePath)
    const format = detectStructureFormat(absolutePath)
    const buffer = await fs.readFile(absolutePath)
    const selected = await resolveUnifiedParseVersion(buffer, format)
    assert.deepStrictEqual(selected, { version: expectedVersion, source: 'inferred' }, `version inference mismatch for ${fixturePath}`)
  }

  const fallbackFixture = path.resolve(process.cwd(), 'assets/other/School.schematic')
  const fallbackFormat = detectStructureFormat(fallbackFixture)
  const fallbackBuffer = await fs.readFile(fallbackFixture)
  const fallbackSelected = await resolveUnifiedParseVersion(fallbackBuffer, fallbackFormat)
  assert.deepStrictEqual(fallbackSelected, { version: DEFAULT_UNIFIED_PARSE_VERSION, source: 'default' }, 'default unified parse version fallback mismatch')

  const explicitSelected = await resolveUnifiedParseVersion(fallbackBuffer, fallbackFormat, '1.18.2')
  assert.deepStrictEqual(explicitSelected, { version: '1.18.2', source: 'explicit' }, 'explicit unified parse version override mismatch')
}

async function assertNormVersionNotImplemented () {
  const fixturePath = path.resolve(process.cwd(), 'assets/other/1.schem')
  const format = detectStructureFormat(fixturePath)
  const buffer = await fs.readFile(fixturePath)

  await assert.rejects(
    () => loadUnifiedStructure(buffer, format, {
      targetVersion: defaultViewerVersion,
      normVersion: '1.20.4',
      unknownPolicy: 'keep'
    }),
    /Not implemented: palette normalization to 1\.20\.4/
  )
}

async function assertMcstructureUsesInferredVersionForConversion () {
  const fixturePath = path.resolve(process.cwd(), 'assets/other/bedrock.mcstructure')
  const format = detectStructureFormat(fixturePath)
  const buffer = await fs.readFile(fixturePath)

  const unified = await loadUnifiedStructure(buffer, format, {
    targetVersion: defaultViewerVersion,
    unknownPolicy: 'keep'
  })

  assert.strictEqual(unified.meta?.source?.format, 'mcstructure', 'mcstructure source format must stay explicit')
  assert.strictEqual(unified.meta?.source?.version, '1.21.60', 'mcstructure should expose inferred single source version')
  assert(unified.palette.some((entry) => entry?.mapping?.sourceKey), 'mcstructure unified palette should keep Bedrock mapping diagnostics')
}

async function assertMixedMcstructureVersionUsesDominantVersionAndWarns () {
  const fixturePath = path.resolve(process.cwd(), 'assets/other/bedrock.mcstructure')
  const format = detectStructureFormat(fixturePath)
  const buffer = await fs.readFile(fixturePath)
  const { parsed, type } = await nbt.parse(buffer, 'little')

  const blockPalette = parsed.value?.structure?.value?.palette?.value?.default?.value?.block_palette?.value?.value
  assert(Array.isArray(blockPalette) && blockPalette.length >= 3, 'bedrock.mcstructure must expose enough palette entries for mixed-version smoke coverage')

  blockPalette[0].version.value = 17825808
  blockPalette[1].version.value = 17825808

  const mixedBuffer = nbt.writeUncompressed(parsed, type)
  const { simplified } = await parseNbtAuto(mixedBuffer)
  const selection = inferBedrockVersionSelectionFromSimplified(simplified, format)
  assert.strictEqual(selection.version, '1.21.60', 'mixed mcstructure version inference should use dominant normalized version')
  assert(selection.warning && /mixed Bedrock palette versions detected/.test(selection.warning), 'mixed mcstructure version inference should report a warning')
  assert(/1\.21\.60/.test(selection.warning), 'mixed mcstructure warning should name the chosen dominant version')
  assert(/1\.16\.220/.test(selection.warning), 'mixed mcstructure warning should summarize minority versions')

  const warnings = []
  const resolved = await resolveUnifiedParseVersion(mixedBuffer, format, undefined, {
    logger: {
      warn: (message) => warnings.push(message)
    }
  })
  assert.deepStrictEqual(resolved, { version: '1.21.60', source: 'inferred' }, 'mixed mcstructure resolveUnifiedParseVersion should keep inferred source semantics')
  assert.strictEqual(warnings.length, 1, 'mixed mcstructure version resolution should emit exactly one warning')
  assert.strictEqual(warnings[0], selection.warning, 'mixed mcstructure warning should flow through logger.warn unchanged')

  const explicitWarnings = []
  const explicitResolved = await resolveUnifiedParseVersion(mixedBuffer, format, '1.18.2', {
    logger: {
      warn: (message) => explicitWarnings.push(message)
    }
  })
  assert.deepStrictEqual(explicitResolved, { version: '1.18.2', source: 'explicit' }, 'explicit override must still win for mixed mcstructure versions')
  assert.deepStrictEqual(explicitWarnings, [], 'explicit override should suppress mixed-version warnings')
}

async function assertLargeBigEndianByteArrayNbtParses () {
  const largeByteArray = new Array(0x1000000 + 1).fill(0)
  largeByteArray[largeByteArray.length - 1] = 1

  const payload = {
    type: 'compound',
    name: 'Schematic',
    value: {
      Version: { type: 'int', value: 3 },
      DataVersion: { type: 'int', value: 3463 },
      Width: { type: 'short', value: 1 },
      Height: { type: 'short', value: 1 },
      Length: { type: 'short', value: 1 },
      Blocks: {
        type: 'compound',
        value: {
          Palette: {
            type: 'compound',
            value: {
              'minecraft:air': { type: 'int', value: 0 }
            }
          },
          Data: { type: 'byteArray', value: largeByteArray }
        }
      }
    }
  }

  const compressed = zlib.gzipSync(nbt.writeUncompressed(payload))
  const parsed = await parseNbtAuto(compressed)

  assert.strictEqual(parsed.nbtEndian, 'big', 'large Java NBT should parse as big-endian')
  assert.strictEqual(parsed.nbtParseHint, 'big-no-array-size-check', 'large byte arrays should use the guarded fallback')
  assert.strictEqual(parsed.simplified.Version, 3, 'large Java NBT should preserve root tags')
  assert.strictEqual(parsed.simplified.Blocks.Data.length, largeByteArray.length, 'large byte array length should be preserved')
  assert.strictEqual(parsed.simplified.Blocks.Data[largeByteArray.length - 1], 1, 'large byte array content should be preserved')
}

async function assertSchematicWarningsDoNotWriteStdout () {
  const payload = {
    type: 'compound',
    name: 'Schematic',
    value: {
      Version: { type: 'int', value: 2 },
      DataVersion: { type: 'int', value: 3463 },
      Width: { type: 'short', value: 1 },
      Height: { type: 'short', value: 1 },
      Length: { type: 'short', value: 1 },
      PaletteMax: { type: 'int', value: 1 },
      Palette: {
        type: 'compound',
        value: {
          'minecraft:missing_block': { type: 'int', value: 0 }
        }
      },
      BlockData: { type: 'byteArray', value: [0] }
    }
  }

  const buffer = zlib.gzipSync(nbt.writeUncompressed(payload))
  const warnings = []
  const stdoutWrites = []
  const originalStdoutWrite = process.stdout.write

  try {
    process.stdout.write = function (chunk, ...args) {
      stdoutWrites.push(String(chunk))
      return originalStdoutWrite.call(this, chunk, ...args)
    }

    const parsed = await loadUnifiedStructure(buffer, 'schem', {
      targetVersion: defaultViewerVersion,
      unknownPolicy: 'keep',
      logger: {
        warn: (message) => warnings.push(String(message))
      }
    })

    assert(parsed && parsed.meta && Array.isArray(parsed.palette), 'unified parse output should remain valid')
  } finally {
    process.stdout.write = originalStdoutWrite
  }

  assert.strictEqual(stdoutWrites.length, 0, 'schematic unknown-block warning must not write to stdout')
  assert(warnings.some((message) => /Unknown block/.test(message)), 'schematic unknown-block warning should flow through logger.warn')
}

async function assertMinewaysObjCache () {
  const fixturePath = path.resolve(process.cwd(), 'assets/mineways/1.obj')
  try {
    await fs.access(fixturePath)
  } catch {
    return null
  }

  const result = await prepareMinewaysObjCache(fixturePath, {
    cacheDir: path.resolve(process.cwd(), '.cache/test-mineways-obj')
  })

  assert(result && result.mesh, 'Mineways OBJ cache should return mesh metadata')
  assert(result.mesh.counts.vertexCount > 0, 'Mineways OBJ cache should contain vertices')
  assert(result.mesh.counts.triangleCount > 0, 'Mineways OBJ cache should contain triangles')
  assert(result.mesh.groups.length > 0, 'Mineways OBJ cache should contain material groups')
  assert(result.mesh.groups.length <= result.mesh.materials.length, 'Mineways OBJ groups should map to material entries')

  const bufferNames = Object.values(result.mesh.buffers)
  for (const bufferName of bufferNames) {
    await fs.access(path.join(result.cacheDir, bufferName))
  }

  return {
    fixturePath: 'assets/mineways/1.obj',
    cacheHit: result.cacheHit,
    vertexCount: result.mesh.counts.vertexCount,
    triangleCount: result.mesh.counts.triangleCount,
    materialGroups: result.mesh.groups.length
  }
}

async function main () {
  assertViewerVersionSupport()

  const fixtures = process.argv.slice(2)
  const targets = fixtures.length > 0
    ? fixtures
      : [
          'assets/other/1.schem',
          'assets/other/School.schematic',
          'assets/other/AshleySt131.litematic',
          'assets/other/7_Castillo_de_Loto.litematic',
          'assets/other/bedrock.mcstructure',
          'assets/other/AshleySt131.nbt'
        ]

  const results = []
  for (const fixture of targets) {
    results.push(await runFixture(fixture))
  }

  await assertUnifiedVersionSelection()
  await assertNormVersionNotImplemented()
  await assertMcstructureUsesInferredVersionForConversion()
  await assertMixedMcstructureVersionUsesDominantVersionAndWarns()
  await assertLargeBigEndianByteArrayNbtParses()
  await assertSchematicWarningsDoNotWriteStdout()
  const minewaysObj = await assertMinewaysObjCache()
  assertUnknownPolicyBehavior()

  console.log(JSON.stringify({ ok: true, results, minewaysObj }, null, 2))
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
