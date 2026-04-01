const path = require('path')
const { makeTextureAtlas } = require('../prismarine-viewer-lib/atlas')
const { prepareBlocksStates } = require('../prismarine-viewer-lib/modelsBuilder')
const mcAssets = require('minecraft-assets')
const fs = require('fs-extra')

const supportedVersions = require('../prismarine-viewer-lib/version').supportedVersions

function hasAllGeneratedAssets (texturesPath, blockStatesPath) {
  return supportedVersions.every(version => {
    return fs.existsSync(path.resolve(texturesPath, `${version}.png`)) &&
      fs.existsSync(path.resolve(blockStatesPath, `${version}.json`))
  })
}

const texturesPath = path.resolve(__dirname, '../static/textures')
const blockStatesPath = path.resolve(__dirname, '../static/blocksStates')

if (!process.argv.includes('-f') && hasAllGeneratedAssets(texturesPath, blockStatesPath)) {
  console.log('textures folder already exists, skipping...')
  process.exit(0)
}
fs.mkdirSync(texturesPath, { recursive: true })

fs.mkdirSync(blockStatesPath, { recursive: true })

for (const version of supportedVersions) {
  const assets = mcAssets(version)
  const atlas = makeTextureAtlas(assets)
  const out = fs.createWriteStream(path.resolve(texturesPath, version + '.png'))
  const stream = atlas.canvas.pngStream()
  stream.on('data', (chunk) => out.write(chunk))
  stream.on('end', () => console.log('Generated textures/' + version + '.png'))

  const blocksStates = JSON.stringify(prepareBlocksStates(assets, atlas))
  fs.writeFileSync(path.resolve(blockStatesPath, version + '.json'), blocksStates)

  fs.copySync(assets.directory, path.resolve(texturesPath, version), { overwrite: true })
}
