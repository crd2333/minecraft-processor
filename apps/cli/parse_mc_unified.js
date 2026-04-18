#!/usr/bin/env node

const fs = require('fs').promises
const path = require('path')
const { DEFAULT_UNIFIED_PARSE_VERSION, detectStructureFormat } = require('../../src/structure_parser')
const { loadUnifiedStructure } = require('../../src/unified_parser')

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})

function showUsage () {
  console.log([
    'Usage:',
    '  node parse_mc_unified.js <input.{schem|schematic|litematic|nbt|mcstructure}> [output.json] [options]',
    '  node parse_mc_unified.js <input.{schem|schematic|litematic|nbt|mcstructure}> --target-version <mc-version> [output.json] [options]',
    '',
    'Options:',
    '  -v, --version <mc-version>        Explicit parse version override (otherwise infer from metadata, else default to 1.21.8)',
    '      --norm_version <mc-version>   Reserved palette normalization target (currently errors as not implemented)',
    '      --target-version <mc-version> Canonical Java target version',
    '      --unknown-policy <mode>       keep | drop (default: keep)',
    '      --stdout                      Write JSON to stdout instead of a file',
    '      --pretty                      Pretty-print JSON output',
    '  -h, --help                        Show this help',
    '',
    'Output shape:',
    '  Unified payload: { meta, size, palette, blocks, entities }',
    '  blocks: [[x, y, z, pid], ...]'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    version: undefined,
    normVersion: undefined,
    targetVersion: undefined,
    unknownPolicy: 'keep',
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

    if (arg === '--target-version') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --target-version')
      result.targetVersion = value
      i++
      continue
    }

    if (arg === '--norm_version') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --norm_version')
      result.normVersion = value
      i++
      continue
    }

    if (arg === '--unknown-policy') {
      const value = argv[i + 1]
      if (!value) throw new Error('Missing value for --unknown-policy')
      if (!['keep', 'drop'].includes(value)) {
        throw new Error('Invalid value for --unknown-policy. Expected keep or drop')
      }
      result.unknownPolicy = value
      i++
      continue
    }

    if (arg === '--stdout') {
      result.stdout = true
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
  return path.resolve(process.cwd(), `${path.basename(inputPath)}.unified.json`)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    showUsage()
    return
  }

  const inputPathArg = args.positional[0]
  const outputPathArg = args.positional[1]

  if (!inputPathArg) {
    showUsage()
    throw new Error('Missing input path')
  }

  const inputPath = path.resolve(process.cwd(), inputPathArg)
  const outputPath = resolveOutputPath(inputPath, outputPathArg)
  const format = detectStructureFormat(inputPath)
  const targetVersion = args.targetVersion || null

  const buffer = await fs.readFile(inputPath)

  const output = await loadUnifiedStructure(buffer, format, {
    version: args.version,
    normVersion: args.normVersion,
    targetVersion,
    unknownPolicy: args.unknownPolicy
  }, inputPath)

  const json = JSON.stringify(output, null, args.pretty ? 2 : 0)

  if (args.stdout) {
    process.stdout.write(`${json}\n`)
    return
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, json, 'utf8')

  console.log(`Parsed ${inputPath}`)
  console.log(`Detected format: ${format}`)
  console.log(`Unified parse version: ${output.meta?.source?.version || args.version || DEFAULT_UNIFIED_PARSE_VERSION} (explicit --version overrides metadata; default fallback ${DEFAULT_UNIFIED_PARSE_VERSION})`)
  console.log(`Unified target: java ${output.meta?.target?.version || 'unknown'}`)
  console.log(`Blocks: ${output.meta?.stats?.blockCount || 0}, palette: ${output.meta?.stats?.paletteSize || 0}, unresolved: ${output.meta?.stats?.unresolvedBlockCount || 0}, dropped: ${output.meta?.stats?.droppedBlockCount || 0}`)
  console.log(`Wrote JSON to ${outputPath}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
