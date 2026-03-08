const webpack = require('webpack')
const path = require('path')

const allowedWorkerFiles = ['blocks', 'blockCollisionShapes', 'tints', 'blockStates',
  'biomes', 'features', 'version', 'legacy', 'versions', 'protocolVersions']

function minecraftDataFilter (req, cb) {
  if (req.context && req.context.includes('minecraft-data') && req.request.endsWith('.json')) {
    const fileName = req.request.split('/').pop().replace('.json', '')
    if (!allowedWorkerFiles.includes(fileName)) {
      cb(null, [])
      return
    }
  }
  cb()
}

const commonConfig = {
  mode: 'production',
  resolve: {
    fallback: {
      assert: require.resolve('assert/'),
      zlib: false
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      process: 'process/browser',
      Buffer: ['buffer', 'Buffer']
    })
  ],
  performance: {
    hints: false
  }
}

module.exports = [
  {
    ...commonConfig,
    entry: './src/client.js',
    output: {
      path: path.resolve(__dirname, './public'),
      filename: './index.js'
    }
  },
  {
    ...commonConfig,
    entry: './vendor/prismarine-viewer/lib/worker.js',
    output: {
      path: path.resolve(__dirname, './public'),
      filename: './worker.js'
    },
    externals: [minecraftDataFilter]
  }
]