#!/usr/bin/env node

const fs = require('fs').promises
const path = require('path')
const { detectStructureFormat, loadStructurePayload } = require('./utils/structure')
const { resolveBlockIndex, validateBlockVocabulary } = require('./utils/blockVocabulary')

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})

function showUsage () {
  console.log([
    'Usage:',
    '  node parse_mc_ids.js <input.{schem|schematic|litematic|nbt|mcstructure}> <vocab.json> [output.json] [options]',
    '',
    'Options:',
    '  -v, --version <mc-version>  Minecraft version hint for .schem/.schematic parsing (optional)',
    '  -r, --res <resolution>      Resolution restriction (optional, e.g. "64")',
    '  -b, --base <x,y,z>          Base offset for resolution restriction; supports negative values (optional, e.g. "-3,0,0")',
    '      --include-air           Include air blocks (default: false)',
    '      --entity-only           Keep only entity blocks (non-entity blocks are ignored)',
    '      --stdout                Write JSON to stdout instead of a file',
    '      --absolute              Output world-absolute coordinates instead of structure-relative (default: relative)',
    '      --pretty                Pretty-print JSON output',
    '  -h, --help                  Show this help',
    '',
    'Output shape:',
    '  { meta, blocks }',
    '  blocks: [[x, y, z, index], ...]'
  ].join('\n'))
}

function parseIntegerCoordinate (value, optionName) {
  if (!/^-?\d+$/.test(value)) {
    throw new Error(`Invalid value for ${optionName}, all coordinates must be integers`)
  }

  return parseInt(value, 10)
}

function parseBaseOffset (value) {
  if (!value) throw new Error('Missing value for --base')

  const parts = value.split(',').map((part) => part.trim())
  if (parts.length !== 3) {
    throw new Error('Invalid value for --base, must be in the format "x,y,z"')
  }

  return [
    parseIntegerCoordinate(parts[0], '--base'),
    parseIntegerCoordinate(parts[1], '--base'),
    parseIntegerCoordinate(parts[2], '--base')
  ]
}

function getBlockCoordinates (block, absolute, baseOffset) {
  if (absolute) {
    return {
      x: block.position.x,
      y: block.position.y,
      z: block.position.z
    }
  }

  if (block.relativePosition && typeof block.relativePosition.x === 'number') {
    return {
      x: block.relativePosition.x,
      y: block.relativePosition.y,
      z: block.relativePosition.z
    }
  }

  if (baseOffset) {
    return {
      x: block.position.x - baseOffset.x,
      y: block.position.y - baseOffset.y,
      z: block.position.z - baseOffset.z
    }
  }

  return {
    x: block.position.x,
    y: block.position.y,
    z: block.position.z
  }
}

function normalizeToBoundingBox (position, resolution, baseOffset) {
  if (!resolution) return position

  const baseX = baseOffset ? baseOffset[0] : 0
  const baseY = baseOffset ? baseOffset[1] : 0
  const baseZ = baseOffset ? baseOffset[2] : 0

  if (
    position.x < baseX || position.y < baseY || position.z < baseZ ||
    position.x >= baseX + resolution || position.y >= baseY + resolution || position.z >= baseZ + resolution
  ) {
    return null
  }

  return {
    x: position.x - baseX,
    y: position.y - baseY,
    z: position.z - baseZ
  }
}

function parseArgs (argv) {
  const result = {
    positional: [],
    version: undefined,
    resolution: 64,
    base_offset: null,
    includeAir: false,
    entityOnly: false,
    absolute: false,
    stdout: false,
    pretty: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }

    if (arg === '-v' || arg === '--version') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --version')
      result.version = value
      i++
      continue
    }

    if (arg === '-r' || arg === '--res') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --res')
      result.resolution = parseInt(value, 10)
      if (isNaN(result.resolution) || result.resolution <= 0) {
        throw new Error('Invalid value for --res, must be a positive integer')
      }
      i++
      continue
    }

    if (arg === '-b' || arg === '--base') {
      result.base_offset = parseBaseOffset(argv[i + 1])
      i++
      continue
    }

    if (arg === '--include-air') {
      result.includeAir = true
      continue
    }

    if (arg === '--entity-only') {
      result.entityOnly = true
      continue
    }

    if (arg === '--stdout') {
      result.stdout = true
      continue
    }

    if (arg === '--absolute') {
      result.absolute = true
      continue
    }

    if (arg === '--pretty') {
      result.pretty = true
      continue
    }

    result.positional.push(arg)
  }

  return result
}

function resolveOutputPath (inputPath, outputPathArg) {
  if (outputPathArg) return path.resolve(process.cwd(), outputPathArg)
  return path.resolve(process.cwd(), `${path.basename(inputPath)}.ids.json`)
}

async function loadVocabularyFile (vocabularyPath) {
  const content = await fs.readFile(vocabularyPath, 'utf8')
  return validateBlockVocabulary(JSON.parse(content))
}

function summarizeCounts (counts) {
  return Object.entries(counts)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([name, count]) => ({ name, count }))
}

function summarizeUnknowns (unknownCounts) {
  return summarizeCounts(unknownCounts)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    showUsage()
    return
  }

  const inputPathArg = args.positional[0]
  const vocabularyPathArg = args.positional[1]
  const outputPathArg = args.positional[2]

  if (!inputPathArg || !vocabularyPathArg) {
    showUsage()
    throw new Error('Missing input path or vocabulary path')
  }

  const inputPath = path.resolve(process.cwd(), inputPathArg)
  const vocabularyPath = path.resolve(process.cwd(), vocabularyPathArg)
  const format = detectStructureFormat(inputPath)

  const [buffer, vocabulary] = await Promise.all([
    fs.readFile(inputPath),
    loadVocabularyFile(vocabularyPath)
  ])

  if (args.entityOnly && !vocabulary.flagsByName) {
    throw new Error('The provided vocabulary does not include entity/non-entity classification. Re-generate it with node scripts/generate_vocab.js.')
  }

  const payload = await loadStructurePayload(buffer, format, args, inputPath)
  const unknownCounts = {}
  const skippedNonEntityCounts = {}
  let unknownBlockCount = 0
  let skippedNonEntityBlockCount = 0

  const baseOffset = payload.meta?.offset || null // base offset from the structure file (if any)

  const blocks = payload.blocks.flatMap((block) => {
    const resolved = resolveBlockIndex(block, vocabulary)

    if (!resolved.matched && resolved.name) {
      unknownCounts[resolved.name] = (unknownCounts[resolved.name] || 0) + 1
      unknownBlockCount++
    }

    if (args.entityOnly && !resolved.isEntity) {
      const skippedName = resolved.name || vocabulary.unknownToken
      skippedNonEntityCounts[skippedName] = (skippedNonEntityCounts[skippedName] || 0) + 1
      skippedNonEntityBlockCount++
      return []
    }

    const blockPosition = getBlockCoordinates(block, args.absolute, baseOffset)
    const normalizedPosition = normalizeToBoundingBox(blockPosition, args.resolution, args.base_offset)

    if (!normalizedPosition) return []

    return [[normalizedPosition.x, normalizedPosition.y, normalizedPosition.z, resolved.index]]
  })

  const output = {
    meta: {
      sourceFile: inputPath,
      sourceFormat: format,
      normalizedFormat: payload.meta?.normalizedFormat || null,
      parserVersionHint: args.version || null,
      includeAir: args.includeAir,
      entityOnly: args.entityOnly,
      coordinateSpace: args.absolute ? 'absolute' : 'relative',
      boundingBox: args.resolution
        ? {
            base: {
              x: args.base_offset ? args.base_offset[0] : 0,
              y: args.base_offset ? args.base_offset[1] : 0,
              z: args.base_offset ? args.base_offset[2] : 0
            },
            size: {
              x: args.resolution,
              y: args.resolution,
              z: args.resolution
            },
            outputOrigin: { x: 0, y: 0, z: 0 }
          }
        : null,
      vocabFile: vocabularyPath,
      vocabVersion: vocabulary.mcVersion || null,
      unknownIndex: vocabulary.unknownIndex,
      entityIndexRange: vocabulary.ranges?.entity || null,
      nonEntityIndexRange: vocabulary.ranges?.nonEntity || null,
      inputBlockCount: payload.blocks.length,
      outputBlockCount: blocks.length,
      unknownBlockCount,
      unknownBlockNames: summarizeUnknowns(unknownCounts),
      skippedNonEntityBlockCount,
      skippedNonEntityBlockNames: summarizeCounts(skippedNonEntityCounts),
      schema: {
        blockTuple: ['x', 'y', 'z', 'index']
      }
    },
    blocks
  }

  const json = JSON.stringify(output, null, args.pretty ? 2 : 0)

  if (args.stdout) {
    process.stdout.write(`${json}\n`)
    return
  }

  const outputPath = resolveOutputPath(inputPath, outputPathArg)

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, json, 'utf8')

  console.log(`Parsed ${inputPath}`)
  console.log(`Detected format: ${format}`)
  console.log(`Blocks: ${blocks.length}, unknown: ${unknownBlockCount}, skippedNonEntity: ${skippedNonEntityBlockCount}`)
  console.log(`Vocabulary: ${vocabulary.mcVersion} (${vocabularyPath})`)
  console.log(`Wrote JSON to ${outputPath}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})