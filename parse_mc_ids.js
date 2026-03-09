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

function parseArgs (argv) {
  const result = {
    positional: [],
    version: undefined,
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

  const baseOffset = payload.meta?.offset || null

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

    let x, y, z
    if (args.absolute) {
      x = block.position.x
      y = block.position.y
      z = block.position.z
    } else {
      if (block.relativePosition && typeof block.relativePosition.x === 'number') {
        x = block.relativePosition.x
        y = block.relativePosition.y
        z = block.relativePosition.z
      } else if (baseOffset) {
        x = block.position.x - baseOffset.x
        y = block.position.y - baseOffset.y
        z = block.position.z - baseOffset.z
      } else {
        x = block.position.x
        y = block.position.y
        z = block.position.z
      }
    }

    return [[x, y, z, resolved.index]]
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