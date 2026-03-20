#!/usr/bin/env node

const fs = require('fs').promises
const path = require('path')
const { detectStructureFormat, loadStructurePayload } = require('./utils/structure')

process.stdout.on('error', (err) => {
  if (err?.code === 'EPIPE') process.exit(0)
  throw err
})

function showUsage () {
  console.log([
    'Usage:',
    '  node parse_mc.js <input.{schem|schematic|litematic|nbt|mcstructure}> [output.json] [options]',
    '',
    'Options:',
    '  -v, --version <mc-version>  Minecraft version hint for .schem/.schematic parsing (optional)',
    '      --include-air           Include air blocks (default: false)',
    '      --stdout                Write JSON to stdout instead of a file',
    '      --pretty                Pretty-print JSON output',
    '  -h, --help                  Show this help',
    '',
    'Output shape:',
    '  { meta, palette, blocks }'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    version: undefined,
    includeAir: false,
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
  return path.resolve(process.cwd(), `${path.basename(inputPath)}.parsed.json`)
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
  const detectedFormat = detectStructureFormat(inputPath)

  const buffer = await fs.readFile(inputPath)
  const payload = await loadStructurePayload(buffer, detectedFormat, args, inputPath)

  if (detectedFormat === 'nbt' && payload.meta?.normalizedFormat === 'nbt-generic') {
    throw new Error('Unrecognised .nbt schema. Tried: Not a valid Java NBT structure: missing palette or blocks array | Not a valid Litematic: missing Regions tag | Not a valid Bedrock .mcstructure: missing required fields')
  }

  const json = JSON.stringify(payload, null, args.pretty ? 2 : 0)

  if (args.stdout) {
    process.stdout.write(`${json}\n`)
    return
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, json, 'utf8')

  console.log(`Parsed ${inputPath}`)
  console.log(`Detected format: ${detectedFormat}`)
  console.log(`Normalized format: ${payload.meta?.normalizedFormat || 'unknown'}`)
  console.log(`Blocks: ${payload.meta.outputBlockCount}, Palette: ${payload.meta.paletteCount}`)
  console.log(`Wrote JSON to ${outputPath}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
