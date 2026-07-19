#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')
const {
  buildCaptureBasename,
  parseArgs,
  parseInputList,
  parsePathList,
  persistCapture,
  readPngDimensions,
  sanitizeStem,
  scanCaptureState,
  validateAssetEntries,
  validateCapturePayload
} = require('./render_schematic_list')

function makePngHeader (width, height) {
  const buffer = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer, 0)
  buffer.write('IHDR', 12, 4, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

async function main () {
  const rendererHtml = await fs.readFile(
    path.join(__dirname, '../apps/frontend/renderer/public/renderer.html'),
    'utf8'
  )
  assert.match(rendererHtml, /#square-guide\s*\{[^}]*aspect-ratio:\s*1;[^}]*pointer-events:\s*none;/s)
  assert.match(rendererHtml, /data-capture-size="1024"/)
  assert.match(rendererHtml, /data-capture-size="2048"/)
  assert.match(rendererHtml, /id="next-button"[^>]*>Next Scene</)
  assert.doesNotMatch(rendererHtml, /viewer-hooks\.js|curator\.js/)

  const rendererClient = await fs.readFile(
    path.join(__dirname, '../apps/frontend/renderer/src/client.js'),
    'utf8'
  )
  assert.match(rendererClient, /__captureScreenshot\(\{ square: true, size: size \}\)/)
  assert.match(rendererClient, /renderer:saveCapture/)
  assert.match(rendererClient, /elements\.next\.addEventListener\('click'/)

  assert.strictEqual(parseArgs(['--asset-root', 'assets', '--output', 'renders', 'list.txt']).assetRoot, 'assets')
  assert.throws(() => parseArgs(['--unknown']), /Unknown option/)

  const list = parsePathList('\n# keep list readable\ncastle.schem\nfolder\\house.litematic\n')
  assert.deepStrictEqual(list, ['castle.schem', 'folder/house.litematic'])
  const ratingsCsv = [
    'asset_path,rating,width,height,length,max_size,block_count,palette_size,reviewed_at',
    'castle.schem,keep,10,10,10,10,1,1,2026-07-19T00:00:00.000Z',
    'folder/house.litematic,maybe,10,10,10,10,1,1,2026-07-19T00:00:00.000Z',
    'functional.schem,functional,10,10,10,10,1,1,2026-07-19T00:00:00.000Z'
  ].join('\n')
  assert.deepStrictEqual(parseInputList(ratingsCsv), ['castle.schem'])
  assert.throws(() => parseInputList(ratingsCsv.replace('castle.schem,keep', 'castle.schem,reject')), /no assets rated keep/)
  assert.throws(() => parsePathList('castle.schem\ncastle.schem\n'), /Duplicate asset path/)
  assert.throws(() => parsePathList('/tmp/out.schem'), /must be relative/)
  assert.strictEqual(sanitizeStem('folder/house with spaces.schem'), 'house_with_spaces')

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-renderer-'))
  const assetRoot = path.join(tempDir, 'assets')
  const outputDir = path.join(tempDir, 'renders')
  await fs.mkdir(path.join(assetRoot, 'folder'), { recursive: true })
  await fs.writeFile(path.join(assetRoot, 'castle.schem'), 'placeholder')
  await fs.writeFile(path.join(assetRoot, 'folder', 'house.litematic'), 'placeholder')
  const validated = await validateAssetEntries(assetRoot, list)
  assert.strictEqual(validated.assets.length, 2)
  await assert.rejects(() => validateAssetEntries(assetRoot, ['../outside.schem']), /must stay within/)

  const assets = validated.assets
  assert.strictEqual(buildCaptureBasename(assets[0], 3, 2048), '0001__castle__view-003__2048')
  await fs.mkdir(path.join(outputDir, 'images'), { recursive: true })
  await fs.writeFile(path.join(outputDir, 'images', '0001__castle__view-004__1024.png'), makePngHeader(1024, 1024))
  await fs.writeFile(path.join(outputDir, 'images', '0001__different__view-099__1024.png'), makePngHeader(1024, 1024))
  const state = await scanCaptureState(path.join(outputDir, 'images'), assets)
  assert.deepStrictEqual(state.get('castle.schem'), { count: 1, maxViewIndex: 4 })

  const png = makePngHeader(1024, 1024)
  assert.deepStrictEqual(readPngDimensions(png), { width: 1024, height: 1024 })
  const payload = {
    asset: assets[0].path,
    caseIndex: assets[0].caseIndex,
    size: 1024,
    png,
    camera: { fov: 75 },
    pixal3d: { format: 'minecraft-pixal3d-transform' }
  }
  assert.strictEqual(validateCapturePayload(payload, assets[0]).size, 1024)
  assert.throws(() => validateCapturePayload({ ...payload, size: 2048 }, assets[0]), /dimensions must be 2048x2048/)

  const metadata = await persistCapture({ outputDir, captureState: state, asset: assets[0], payload })
  assert.strictEqual(metadata.view_index, 5)
  assert.strictEqual(metadata.width, 1024)
  assert.strictEqual((await fs.readdir(path.join(outputDir, 'images'))).filter((name) => name.endsWith('.png')).length, 3)
  assert.strictEqual((await fs.readFile(path.join(outputDir, 'manifest.jsonl'), 'utf8')).trim().split('\n').length, 1)

  await fs.rm(tempDir, { recursive: true, force: true })
  console.log(JSON.stringify({ ok: true, assets: assets.length, resumedView: metadata.view_index }))
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
