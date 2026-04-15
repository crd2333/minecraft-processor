#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { detectStructureFormat, loadNativeStructure } = require('../../src/structure_parser')

const fsPromises = fs.promises

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
    '      --readable              Faithfully decode opaque native fields in place',
    '      --filter-air            Remove air entries from readable translated block collections',
    '      --stdout                Write JSON to stdout instead of a file',
    '      --pretty                Pretty-print JSON output',
    '  -h, --help                  Show this help',
    '',
    'Output shape:',
    '  Thin native envelope: { format, schema, parser, ..., data }',
    '  data is the parser-native readable JSON, not a unified IR.'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    version: undefined,
    includeAir: false,
    readable: false,
    filterAir: false,
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

    if (arg === '--readable') {
      result.readable = true
      continue
    }

    if (arg === '--filter-air') {
      result.filterAir = true
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

function writeChunk (stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('error', onError)
      reject(error)
    }

    stream.on('error', onError)
    const done = () => {
      stream.off('error', onError)
      resolve()
    }

    if (stream.write(chunk)) {
      done()
      return
    }

    stream.once('drain', done)
  })
}

async function writeJsonValue (stream, value, pretty, depth = 0) {
  const indentUnit = pretty ? '  ' : ''
  const newline = pretty ? '\n' : ''
  const childIndent = pretty ? indentUnit.repeat(depth + 1) : ''
  const currentIndent = pretty ? indentUnit.repeat(depth) : ''

  if (value === null || typeof value !== 'object') {
    await writeChunk(stream, JSON.stringify(value))
    return
  }

  if (Array.isArray(value)) {
    await writeChunk(stream, '[')
    for (let i = 0; i < value.length; i++) {
      if (i > 0) await writeChunk(stream, `,${newline}`)
      else if (pretty && value.length > 0) await writeChunk(stream, newline)

      if (pretty) await writeChunk(stream, childIndent)
      await writeJsonValue(stream, value[i], pretty, depth + 1)
    }
    if (pretty && value.length > 0) await writeChunk(stream, `${newline}${currentIndent}`)
    await writeChunk(stream, ']')
    return
  }

  const entries = Object.entries(value)
  await writeChunk(stream, '{')
  for (let i = 0; i < entries.length; i++) {
    const [key, entryValue] = entries[i]
    if (i > 0) await writeChunk(stream, `,${newline}`)
    else if (pretty && entries.length > 0) await writeChunk(stream, newline)

    if (pretty) await writeChunk(stream, childIndent)
    await writeChunk(stream, `${JSON.stringify(key)}:${pretty ? ' ' : ''}`)
    await writeJsonValue(stream, entryValue, pretty, depth + 1)
  }
  if (pretty && entries.length > 0) await writeChunk(stream, `${newline}${currentIndent}`)
  await writeChunk(stream, '}')
}

async function writeJsonOutput (stream, value, pretty) {
  await writeJsonValue(stream, value, pretty, 0)
  await writeChunk(stream, '\n')
}

function closeWritableStream (stream) {
  return new Promise((resolve, reject) => {
    stream.on('error', reject)
    stream.end(resolve)
  })
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

  if (args.filterAir && !args.readable) {
    throw new Error('--filter-air requires --readable on the native parse path')
  }

  const inputPath = path.resolve(process.cwd(), inputPathArg)
  const outputPath = resolveOutputPath(inputPath, outputPathArg)
  const detectedFormat = detectStructureFormat(inputPath)

  const buffer = await fsPromises.readFile(inputPath)
  const nativePayload = await loadNativeStructure(buffer, detectedFormat, args, inputPath)

  if (args.stdout) {
    await writeJsonOutput(process.stdout, nativePayload, args.pretty)
    return
  }

  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true })
  const outputStream = fs.createWriteStream(outputPath, { encoding: 'utf8' })
  await writeJsonOutput(outputStream, nativePayload, args.pretty)
  await closeWritableStream(outputStream)

  console.log(`Parsed ${inputPath}`)
  console.log(`Detected format: ${detectedFormat}`)
  console.log(`Native schema: ${nativePayload.schema || 'unknown'}`)
  console.log(`Parser: ${nativePayload.parser || 'unknown'}`)
  console.log(`Wrote JSON to ${outputPath}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
