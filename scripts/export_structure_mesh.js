#!/usr/bin/env node

const fs = require('fs').promises
const path = require('path')
const { buildStructureMesh } = require('../src/structure_mesh')
const { defaultViewerVersion } = require('../src/viewer_versions')

const BUFFER_FILES = {
  positions: 'positions.f32',
  indices: 'indices.u32'
}

function showUsage () {
  console.log([
    'Usage:',
    '  node scripts/export_structure_mesh.js <structure-file> --output-dir <directory> [--version <mc-version>]',
    '',
    'Writes a headless indexed triangle mesh as positions.f32, indices.u32, and mesh.json.'
  ].join('\n'))
}

function parseArgs (argv) {
  const result = {
    positional: [],
    outputDir: null,
    version: defaultViewerVersion,
    help: false
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      result.help = true
      continue
    }
    if (arg === '--output-dir') {
      if (!argv[i + 1]) throw new Error('Missing value for --output-dir')
      result.outputDir = argv[++i]
      continue
    }
    if (arg === '--version' || arg === '-v') {
      if (!argv[i + 1]) throw new Error('Missing value for --version')
      result.version = argv[++i]
      continue
    }
    if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`)
    result.positional.push(arg)
  }

  return result
}

function typedArrayToBuffer (array) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength)
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    showUsage()
    return
  }
  if (!args.positional[0]) {
    showUsage()
    throw new Error('Missing structure input path')
  }
  if (!args.outputDir) {
    showUsage()
    throw new Error('Missing required --output-dir')
  }
  if (args.positional.length > 1) throw new Error(`Unexpected positional argument: ${args.positional[1]}`)

  const inputPath = path.resolve(process.cwd(), args.positional[0])
  const outputDir = path.resolve(process.cwd(), args.outputDir)
  const mesh = await buildStructureMesh(inputPath, { version: args.version, logger: console })
  const metadata = {
    ...mesh.metadata,
    buffers: BUFFER_FILES
  }

  await fs.mkdir(outputDir, { recursive: true })
  await fs.writeFile(path.join(outputDir, BUFFER_FILES.positions), typedArrayToBuffer(mesh.positions))
  await fs.writeFile(path.join(outputDir, BUFFER_FILES.indices), typedArrayToBuffer(mesh.indices))
  await fs.writeFile(path.join(outputDir, 'mesh.json'), `${JSON.stringify(metadata, null, 2)}\n`, 'utf8')

  console.log(`Extracted mesh from ${inputPath}`)
  console.log(`Vertices: ${metadata.counts.vertexCount}, triangles: ${metadata.counts.triangleCount}`)
  console.log(`Wrote mesh buffers to ${outputDir}`)
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exitCode = 1
})
