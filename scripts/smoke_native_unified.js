#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs').promises
const path = require('path')

const { detectStructureFormat, loadNativeStructure, loadUnifiedStructure } = require('../src/structure_parser')

function assertNativeContract (native, fixturePath) {
  assert(native && typeof native === 'object', `native parse missing payload for ${fixturePath}`)
  assert(native.data, `native parse missing data for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'meta'), `native parse must not expose unified meta for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'size'), `native parse must not expose unified size for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'palette'), `native parse must not expose unified palette for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'blocks'), `native parse must not expose unified blocks for ${fixturePath}`)
  assert(!Object.prototype.hasOwnProperty.call(native, 'entities'), `native parse must not expose unified entities for ${fixturePath}`)

  if (fixturePath.endsWith('.schem') || fixturePath.endsWith('.schematic') || fixturePath.endsWith('.litematic')) {
    assert(native.data._derivedReadable, `native parse missing derived readable view for ${fixturePath}`)
    assert(Array.isArray(native.data._derivedReadable.regions) || native.data._derivedReadable.decodedBlocks || native.data._derivedReadable.primaryLayerBlocks, `native parse derived readable view missing decoded content for ${fixturePath}`)
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
      target: { edition: 'java', version: '1.21.4' },
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

  const native = await loadNativeStructure(buffer, format, { version: '1.21.4' }, absolutePath)
  assertNativeContract(native, fixturePath)

  const unified = await loadUnifiedStructure(buffer, format, {
    version: '1.21.4',
    targetVersion: '1.21.4',
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

async function main () {
  const fixtures = process.argv.slice(2)
  const targets = fixtures.length > 0
    ? fixtures
    : [
        'assets/1.schem',
        'assets/AshleySt131.litematic',
        'assets/bedrock.mcstructure',
        'assets/AshleySt131.nbt'
      ]

  const results = []
  for (const fixture of targets) {
    results.push(await runFixture(fixture))
  }

  assertUnknownPolicyBehavior()

  console.log(JSON.stringify({ ok: true, results }, null, 2))
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
