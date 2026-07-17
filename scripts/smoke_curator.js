#!/usr/bin/env node

const assert = require('assert')
const fs = require('fs').promises
const os = require('os')
const path = require('path')
const {
  CSV_COLUMNS,
  mergeAssetRows,
  parseCsvRowsToObjects,
  selectInitialAsset,
  serializeCsvRows,
  summarizeRows,
  validateRating,
  writeCsvRowsAtomic
} = require('./curate_schematics')

async function main () {
  const curatorHtml = await fs.readFile(
    path.join(__dirname, '../apps/frontend/curator/public/curator.html'),
    'utf8'
  )
  assert.match(curatorHtml, /#curator-app\s*\{[^}]*position:\s*fixed;[^}]*pointer-events:\s*none;/s)
  assert.match(curatorHtml, /canvas\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s)
  assert.match(curatorHtml, /#curator-panel\s*\{[^}]*pointer-events:\s*auto;/s)

  const curatorClient = await fs.readFile(
    path.join(__dirname, '../apps/frontend/curator/src/client.js'),
    'utf8'
  )
  assert.match(curatorClient, /function renderStructureBoundingBox \(\)/)
  assert.match(curatorClient, /curatorStructureBoundingBox/)

  const rows = mergeAssetRows([
    'plain.schem',
    'folder/has,comma"name.schem'
  ], [])
  assert.strictEqual(rows.length, 2)
  assert.strictEqual(rows[0].rating, 'unrated')
  assert.strictEqual(selectInitialAsset(rows), 'plain.schem')

  rows[0].rating = 'keep'
  rows[0].width = '10'
  rows[0].height = '20'
  rows[0].length = '30'
  rows[0].max_size = '30'
  rows[0].block_count = '100'
  rows[0].palette_size = '8'
  rows[0].reviewed_at = '2026-07-17T00:00:00.000Z'
  const roundTrip = parseCsvRowsToObjects(serializeCsvRows(rows))
  assert.deepStrictEqual(roundTrip, rows)
  assert.strictEqual(serializeCsvRows(rows).split('\n')[0], CSV_COLUMNS.join(','))

  const merged = mergeAssetRows(['plain.schem', 'new.schem'], roundTrip)
  assert.strictEqual(merged[0].rating, 'keep')
  assert.strictEqual(merged[1].rating, 'unrated')
  assert.strictEqual(selectInitialAsset(merged), 'new.schem')

  const summary = summarizeRows(merged)
  assert.deepStrictEqual(summary.counts, { unrated: 1, keep: 1, maybe: 0, functional: 0, reject: 0 })
  assert.strictEqual(summary.reviewed, 1)

  assert.throws(() => validateRating('unknown', 'plain.schem'), /Invalid rating/)
  assert.throws(() => parseCsvRowsToObjects('wrong,header\n'), /Invalid CSV header/)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'minecraft-curator-'))
  const csvPath = path.join(tempDir, 'nested', 'ratings.csv')
  await writeCsvRowsAtomic(csvPath, merged)
  const persisted = parseCsvRowsToObjects(await fs.readFile(csvPath, 'utf8'))
  assert.deepStrictEqual(persisted, merged)
  await fs.rm(tempDir, { recursive: true, force: true })

  console.log(JSON.stringify({ ok: true, rows: persisted.length, csvColumns: CSV_COLUMNS.length }))
}

main().catch((error) => {
  console.error(error.message || error)
  process.exit(1)
})
