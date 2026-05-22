const fs = require('fs').promises
const { builtinModules } = require('module')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const NODE_MODULES_DIR = path.join(PROJECT_ROOT, 'node_modules')
const STATIC_DIR = path.join(PROJECT_ROOT, 'static')
const VENDOR_ROOT = path.join(STATIC_DIR, 'vendor')
const PACKAGES_ROOT = path.join(VENDOR_ROOT, 'packages')
const BUILD_ROOT = path.join(PROJECT_ROOT, '.build')
const PATCHED_PACKAGES_ROOT = path.join(BUILD_ROOT, 'vendor-packages')
const PRISMARINE_VIEWER_PATCH_ROOT = path.join(PROJECT_ROOT, 'patches', 'prismarine-viewer')

const THREE_EXPORTERS = ['OBJExporter.js', 'STLExporter.js', 'GLTFExporter.js']
const PRISMARINE_VIEWER_PATCHED_FILES = new Map([
  [path.join('viewer', 'lib', 'models.js'), path.join(PRISMARINE_VIEWER_PATCH_ROOT, 'viewer', 'lib', 'models.js')],
  [path.join('viewer', 'lib', 'worker.js'), path.join(PRISMARINE_VIEWER_PATCH_ROOT, 'viewer', 'lib', 'worker.js')],
  [path.join('viewer', 'lib', 'worldrenderer.js'), path.join(PRISMARINE_VIEWER_PATCH_ROOT, 'viewer', 'lib', 'worldrenderer.js')]
])

const SHARED_PRISMARINE_SPECIFIERS = new Set([
  'minecraft-data',
  'minecraft-data/data.js',
  'vec3',
  'prismarine-nbt',
  'prismarine-schematic',
  'prismarine-schematic/lib/spongeSchematic',
  'prismarine-schematic/lib/mceditSchematic',
  'prismarine-schematic/lib/states',
  'prismarine-world',
  'prismarine-chunk',
  'prismarine-block',
  'prismarine-registry',
  'prismarine-biome',
  'prismarine-chat',
  'prismarine-item',
  'prismarine-viewer/viewer/lib/worldrenderer',
  'prismarine-viewer/viewer/lib/worker'
])

const SHARED_PRISMARINE_PACKAGES = new Set([...SHARED_PRISMARINE_SPECIFIERS].map(packageNameFromId))

const BUNDLE_ENTRIES = [
  { specifier: 'vec3', packageName: 'vec3', input: 'index.js', output: 'vec3/index.js' },
  { specifier: 'prismarine-nbt', packageName: 'prismarine-nbt', input: 'nbt.js', output: 'prismarine-nbt/nbt.js', minify: false },
  { specifier: 'prismarine-schematic', packageName: 'prismarine-schematic', input: 'index.js', output: 'prismarine-schematic/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-schematic/lib/spongeSchematic', packageName: 'prismarine-schematic', input: 'lib/spongeSchematic.js', output: 'prismarine-schematic/lib/spongeSchematic.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-schematic/lib/mceditSchematic', packageName: 'prismarine-schematic', input: 'lib/mceditSchematic.js', output: 'prismarine-schematic/lib/mceditSchematic.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-schematic/lib/states', packageName: 'prismarine-schematic', input: 'lib/states.js', output: 'prismarine-schematic/lib/states.js' },
  { specifier: 'prismarine-world', packageName: 'prismarine-world', input: 'index.js', output: 'prismarine-world/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-chunk', packageName: 'prismarine-chunk', input: 'index.js', output: 'prismarine-chunk/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-block', packageName: 'prismarine-block', input: 'index.js', output: 'prismarine-block/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-registry', packageName: 'prismarine-registry', input: 'lib/index.js', output: 'prismarine-registry/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-biome', packageName: 'prismarine-biome', input: 'index.js', output: 'prismarine-biome/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-chat', packageName: 'prismarine-chat', input: 'index.js', output: 'prismarine-chat/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-item', packageName: 'prismarine-item', input: 'index.js', output: 'prismarine-item/index.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-viewer/viewer/lib/worldrenderer', packageName: 'prismarine-viewer', input: 'viewer/lib/worldrenderer.js', output: 'prismarine-viewer/viewer/lib/worldrenderer.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'prismarine-viewer/viewer/lib/worker', packageName: 'prismarine-viewer', input: 'viewer/lib/worker.js', output: 'prismarine-viewer/viewer/lib/worker.js', externalPackages: SHARED_PRISMARINE_PACKAGES },
  { specifier: 'express', packageName: 'express', input: 'index.js', output: 'express/index.js' },
  { specifier: 'compression', packageName: 'compression', input: 'index.js', output: 'compression/index.js' },
  { specifier: 'socket.io', packageName: 'socket.io', input: 'dist/index.js', output: 'socket.io/dist/index.js' }
]

function packageNameFromId (id) {
  if (!id || id.startsWith('.') || path.isAbsolute(id)) return null
  if (id.startsWith('@')) {
    const [scope, name] = id.split('/')
    return scope && name ? `${scope}/${name}` : id
  }
  return id.split('/')[0]
}

function packagePath (packageName) {
  const patchedPath = path.join(PATCHED_PACKAGES_ROOT, ...packageName.split('/'))
  if (packageName === 'prismarine-viewer') return patchedPath
  return path.join(NODE_MODULES_DIR, ...packageName.split('/'))
}

async function loadRollupTools () {
  const { rollup } = require('rollup')
  const { nodeResolve } = require('@rollup/plugin-node-resolve')
  const commonjs = require('@rollup/plugin-commonjs')
  const json = require('@rollup/plugin-json')
  const terserModule = await import('@rollup/plugin-terser')

  return {
    rollup,
    nodeResolve,
    commonjs,
    json,
    terser: terserModule.default
  }
}

function patchProtodefCompilerPlugin () {
  return {
    name: 'patch-protodef-compiler-eval',
    transform (code, id) {
      if (!id.endsWith(path.join('protodef', 'src', 'compiler.js'))) return null

      const patched = code.replace(
        'return eval(code)() // eslint-disable-line',
        "return Function('native', 'PartialReadError', `return (${code})()`)(native, PartialReadError) // eslint-disable-line"
      )

      return patched === code ? null : { code: patched, map: null }
    }
  }
}

function makeExternalPredicate (entry) {
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)])
  const externalRelative = entry.externalRelative || new Set()
  const externalPackages = entry.externalPackages || new Set()

  return function external (id) {
    if (builtins.has(id)) return true
    if (entry.externalJson && id.endsWith('.json')) return true
    if (externalRelative.has(id)) return true
    if (id.startsWith('.') || path.isAbsolute(id)) return false

    const packageName = packageNameFromId(id)
    return packageName !== entry.packageName && externalPackages.has(packageName)
  }
}

async function bundleEntry (tools, entry) {
  const bundle = await tools.rollup({
    input: path.join(packagePath(entry.packageName), entry.input),
    external: makeExternalPredicate(entry),
    plugins: [
      patchProtodefCompilerPlugin(),
      tools.nodeResolve({ preferBuiltins: true }),
      tools.json({ compact: true, preferConst: true }),
      tools.commonjs({ ignoreDynamicRequires: true }),
      ...(entry.minify === false
        ? []
        : [tools.terser({
            compress: true,
            mangle: true,
            format: { comments: false }
          })])
    ],
    onwarn (warning, warn) {
      if (warning.code === 'CIRCULAR_DEPENDENCY') return
      warn(warning)
    }
  })

  try {
    const outputFile = path.join(PACKAGES_ROOT, entry.output)
    await fs.mkdir(path.dirname(outputFile), { recursive: true })
    await bundle.write({
      file: outputFile,
      format: 'cjs',
      exports: 'auto',
      sourcemap: false,
      generatedCode: 'es2015'
    })
  } finally {
    await bundle.close()
  }
}

async function copyMinecraftDataAssets () {
  const sourcePackageRoot = packagePath('minecraft-data')
  const sourceDataRoot = path.join(sourcePackageRoot, 'minecraft-data')
  const targetPackageRoot = path.join(PACKAGES_ROOT, 'minecraft-data')
  const targetDataRoot = path.join(targetPackageRoot, 'minecraft-data')

  await fs.mkdir(targetPackageRoot, { recursive: true })
  await fs.copyFile(path.join(sourcePackageRoot, 'index.js'), path.join(targetPackageRoot, 'index.js'))
  await fs.copyFile(path.join(sourcePackageRoot, 'data.js'), path.join(targetPackageRoot, 'data.js'))
  await fs.cp(path.join(sourcePackageRoot, 'lib'), path.join(targetPackageRoot, 'lib'), { recursive: true })
  await fs.cp(path.join(sourceDataRoot, 'data'), path.join(targetDataRoot, 'data'), { recursive: true })
  await fs.cp(path.join(sourceDataRoot, 'schemas'), path.join(targetDataRoot, 'schemas'), { recursive: true })
}

async function copySocketIoClientAssets () {
  const sourceDir = path.join(packagePath('socket.io'), 'client-dist')
  const targetDir = path.join(PACKAGES_ROOT, 'socket.io', 'client-dist')
  await fs.mkdir(targetDir, { recursive: true })
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => !src.endsWith('.map')
  })
}

async function copyThreeExporters () {
  const sourceDir = path.join(NODE_MODULES_DIR, 'three', 'examples', 'js', 'exporters')
  const targetDir = path.join(VENDOR_ROOT, 'three', 'exporters')
  await fs.mkdir(targetDir, { recursive: true })

  for (const exporter of THREE_EXPORTERS) {
    await fs.copyFile(path.join(sourceDir, exporter), path.join(targetDir, exporter))
  }
}

async function copyPrismarineViewerAssets () {
  const sourceRoot = packagePath('prismarine-viewer')
  const targetRoot = path.join(PACKAGES_ROOT, 'prismarine-viewer')
  const sourceLibDir = path.join(sourceRoot, 'viewer', 'lib')
  const targetLibDir = path.join(targetRoot, 'viewer', 'lib')
  await fs.mkdir(targetLibDir, { recursive: true })
  await fs.copyFile(path.join(sourceLibDir, 'missing_texture.png'), path.join(targetLibDir, 'missing_texture.png'))

  await fs.mkdir(path.join(targetRoot, 'public'), { recursive: true })
}

async function preparePatchedPrismarineViewerPackage () {
  const sourceRoot = path.join(NODE_MODULES_DIR, 'prismarine-viewer')
  const targetRoot = packagePath('prismarine-viewer')

  await fs.rm(targetRoot, { recursive: true, force: true })
  await fs.mkdir(targetRoot, { recursive: true })
  await fs.cp(sourceRoot, targetRoot, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      if (base === '.git' || base === '.github') return false
      if (base === 'examples' || base === 'test') return false
      if (base === 'public') return false
      if (base.endsWith('.map')) return false
      return true
    }
  })

  for (const [relative, patchedPath] of PRISMARINE_VIEWER_PATCHED_FILES) {
    await fs.copyFile(patchedPath, path.join(targetRoot, relative))
  }
}

async function writeManifest () {
  const modules = Object.fromEntries([
    ['minecraft-data', 'packages/minecraft-data/index.js'],
    ['minecraft-data/data.js', 'packages/minecraft-data/data.js'],
    ...BUNDLE_ENTRIES.map((entry) => [entry.specifier, `packages/${entry.output}`])
  ])
  const manifest = {
    generatedAt: new Date().toISOString(),
    layout: 'bundle-manifest',
    modules,
    assets: {
      minecraftData: [
        'packages/minecraft-data/minecraft-data/data',
        'packages/minecraft-data/minecraft-data/schemas'
      ],
      socketIoClient: 'packages/socket.io/client-dist',
      prismarineViewer: {
        package: 'packages/prismarine-viewer',
        missingTexture: 'packages/prismarine-viewer/viewer/lib/missing_texture.png',
        runtimeAssets: [
          'packages/prismarine-viewer/public/textures',
          'packages/prismarine-viewer/public/blocksStates'
        ],
        patchSource: 'patches/prismarine-viewer'
      },
      threeExporters: THREE_EXPORTERS.map((file) => `three/exporters/${file}`)
    }
  }

  await fs.writeFile(path.join(VENDOR_ROOT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function main () {
  if (process.argv.includes('--prepare-viewer-only')) {
    await fs.mkdir(PATCHED_PACKAGES_ROOT, { recursive: true })
    await preparePatchedPrismarineViewerPackage()
    console.log('Prepared patched prismarine-viewer package in .build/vendor-packages')
    return
  }

  await fs.rm(VENDOR_ROOT, { recursive: true, force: true })
  await fs.mkdir(PATCHED_PACKAGES_ROOT, { recursive: true })
  await fs.mkdir(PACKAGES_ROOT, { recursive: true })
  await preparePatchedPrismarineViewerPackage()

  const tools = await loadRollupTools()
  for (const entry of BUNDLE_ENTRIES) {
    await bundleEntry(tools, entry)
  }

  await copyMinecraftDataAssets()
  await copySocketIoClientAssets()
  await copyPrismarineViewerAssets()
  await copyThreeExporters()
  await writeManifest()

  console.log(`Built ${BUNDLE_ENTRIES.length} vendored module bundles into static/vendor/packages`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
