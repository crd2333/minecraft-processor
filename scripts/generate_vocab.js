#!/usr/bin/env node

const fs = require('fs').promises
const path = require('path')
const { buildVersionedBlockVocabulary } = require('../src/block_vocab')

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})

function showUsage () {
  console.log([
    'Usage:',
    '  node scripts/generate_vocab.js <mc-version> [output.json] [options]',
    '',
    'Options:',
    '      --stdout   Write JSON to stdout instead of a file',
    '      --pretty   Pretty-print JSON output',
    '  -h, --help     Show this help',
    '',
    'Default output:',
    '  data/generated/block-vocab.<mc-version>.json',
    '',
    'Output shape:',
    '  { format, source, mcVersion, unknownToken, unknownIndex, classification, ranges, size, names, entityNames, nonEntityNames, nameToIndex, flagsByName }'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    stdout: false,
    pretty: false
  }

  for (const arg of argv) {
    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }

    if (arg === '--pretty') {
      result.pretty = true
      continue
    }

    if (arg === '--stdout') {
      result.stdout = true
      continue
    }

    result.positional.push(arg)
  }

  return result
}

function resolveOutputPath (version, outputPathArg) {
  if (outputPathArg) return path.resolve(process.cwd(), outputPathArg)
  return path.resolve(process.cwd(), 'data', 'generated', `block-vocab.${version}.json`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    showUsage()
    return
  }

  const version = args.positional[0]
  const outputPathArg = args.positional[1]

  if (!version) {
    showUsage()
    throw new Error('Missing Minecraft version')
  }

  const vocabulary = buildVersionedBlockVocabulary(version)
  const json = JSON.stringify(vocabulary, null, args.pretty ? 2 : 0)

  if (args.stdout) {
    process.stdout.write(`${json}\n`)
    return
  }

  const outputPath = resolveOutputPath(version, outputPathArg)

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, json, 'utf8')

  console.log(`Generated vocabulary for ${vocabulary.mcVersion}`)
  console.log(`Entries: ${vocabulary.size}, entity: ${vocabulary.ranges.entity.count}, non-entity: ${vocabulary.ranges.nonEntity.count}, unknownIndex: ${vocabulary.unknownIndex}`)
  console.log(`Wrote JSON to ${outputPath}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})