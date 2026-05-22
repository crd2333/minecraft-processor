const webpack = require('webpack')
const path = require('path')

const patchedPrismarineViewerPath = path.resolve(__dirname, './.build/vendor-packages/prismarine-viewer')

const allowedWorkerFiles = ['blocks', 'blockCollisionShapes', 'tints', 'blockStates',
  'biomes', 'features', 'version', 'legacy', 'versions', 'protocolVersions']

function minecraftDataFilter (req, cb) {
  const request = req.request || ''
  const context = req.context || ''

  if (context.includes('minecraft-data') && request.includes('/data/bedrock/')) {
    cb(null, [])
    return
  }

  if (context.includes('minecraft-data') && request.endsWith('.json')) {
    const fileName = request.split('/').pop().replace('.json', '')
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
    alias: {
      'prismarine-viewer': patchedPrismarineViewerPath
    },
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
    entry: './apps/frontend/viewer/src/client.js',
    output: {
      path: path.resolve(__dirname, './static'),
      filename: './index.js'
    }
  },
  {
    ...commonConfig,
    entry: './.build/vendor-packages/prismarine-viewer/viewer/lib/worker.js',
    output: {
      path: path.resolve(__dirname, './static/vendor/packages/prismarine-viewer/public'),
      filename: './worker.js'
    },
    externals: [minecraftDataFilter]
  }
]
