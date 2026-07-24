#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')
const { main: exportMeshes } = require('../export_structure_mesh')

const PROJECT_ROOT = path.resolve(__dirname, '../..')
const FIXTURE = path.join(PROJECT_ROOT, 'assets', 'other', '1.schem')

async function readPly (filePath) {
  const lines = (await fs.readFile(filePath, 'utf8')).trim().split('\n')
  const headerEnd = lines.indexOf('end_header')
  assert.notStrictEqual(headerEnd, -1)
  const vertexCount = Number(lines.find((line) => line.startsWith('element vertex ')).split(' ')[2])
  const faceCount = Number(lines.find((line) => line.startsWith('element face ')).split(' ')[2])
  const vertices = lines.slice(headerEnd + 1, headerEnd + 1 + vertexCount).map((line) => line.split(' ').map(Number))
  const faces = lines.slice(headerEnd + 1 + vertexCount).map((line) => line.split(' ').map(Number))
  return { lines, vertexCount, faceCount, vertices, faces }
}

async function main () {
  await fs.access(FIXTURE)
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'structure-mesh-export-smoke-'))
  try {
    const inputRoot = path.join(temporary, 'inputs')
    const nestedInput = path.join(inputRoot, 'nested', 'sample.schem')
    await fs.mkdir(path.dirname(nestedInput), { recursive: true })
    await fs.copyFile(FIXTURE, nestedInput)
    await fs.copyFile(FIXTURE, path.join(inputRoot, 'root.schem'))

    const outputDir = path.join(temporary, 'output')
    await fs.mkdir(outputDir, { recursive: true })
    const resumedOutput = path.join(outputDir, 'root.ply')
    await fs.writeFile(resumedOutput, 'completed checkpoint\n', 'utf8')
    await exportMeshes([inputRoot, '--output-dir', outputDir, '--format', 'ply', '--normalize', '--resume'])
    assert.strictEqual(await fs.readFile(resumedOutput, 'utf8'), 'completed checkpoint\n')

    for (const relativeOutput of [path.join('nested', 'sample.ply')]) {
      const ply = await readPly(path.join(outputDir, relativeOutput))
      assert.strictEqual(ply.lines[0], 'ply')
      assert.strictEqual(ply.lines[1], 'format ascii 1.0')
      assert(ply.vertexCount > 0)
      assert(ply.faceCount > 0)
      assert.strictEqual(ply.vertices.length, ply.vertexCount)
      assert.strictEqual(ply.faces.length, ply.faceCount)
      assert(ply.vertices.every((vertex) => vertex.length === 3 && vertex.every((value) => Number.isFinite(value) && value >= -0.500001 && value <= 0.500001)))
      assert(ply.faces.every((face) => face.length === 4 && face[0] === 3 && face.slice(1).every((index) => Number.isInteger(index) && index >= 0 && index < ply.vertexCount)))
      const extent = Math.max(...ply.vertices.flat().map(Math.abs))
      assert(Math.abs(extent - 0.5) < 1e-6, extent)
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
  console.log('Structure mesh export smoke checks passed')
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error))
  process.exitCode = 1
})
