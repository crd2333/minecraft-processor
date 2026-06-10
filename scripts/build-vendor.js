const fs = require('fs').promises
const { builtinModules } = require('module')
const crypto = require('crypto')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const NODE_MODULES_DIR = path.join(PROJECT_ROOT, 'node_modules')
const STATIC_DIR = path.join(PROJECT_ROOT, 'static')
const VENDOR_ROOT = path.join(STATIC_DIR, 'vendor')
const BUILD_ROOT = path.join(PROJECT_ROOT, '.build')
const PATCHED_PACKAGES_ROOT = path.join(BUILD_ROOT, 'vendor-packages')
const VENDOR_STAGING_ROOT = path.join(BUILD_ROOT, 'vendor-output')
const VENDOR_STATE_FILE = path.join(BUILD_ROOT, 'vendor-build-state.json')
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

async function bundleEntry (tools, entry, packagesRoot) {
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
    const outputFile = path.join(packagesRoot, entry.output)
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

async function copyMinecraftDataAssets (packagesRoot) {
  const sourcePackageRoot = packagePath('minecraft-data')
  const sourceDataRoot = path.join(sourcePackageRoot, 'minecraft-data')
  const targetPackageRoot = path.join(packagesRoot, 'minecraft-data')
  const targetDataRoot = path.join(targetPackageRoot, 'minecraft-data')

  await fs.mkdir(targetPackageRoot, { recursive: true })
  await fs.copyFile(path.join(sourcePackageRoot, 'index.js'), path.join(targetPackageRoot, 'index.js'))
  await fs.copyFile(path.join(sourcePackageRoot, 'data.js'), path.join(targetPackageRoot, 'data.js'))
  await fs.cp(path.join(sourcePackageRoot, 'lib'), path.join(targetPackageRoot, 'lib'), { recursive: true })
  await fs.cp(path.join(sourceDataRoot, 'data'), path.join(targetDataRoot, 'data'), { recursive: true })
  await fs.cp(path.join(sourceDataRoot, 'schemas'), path.join(targetDataRoot, 'schemas'), { recursive: true })
}

async function copySocketIoClientAssets (packagesRoot) {
  const sourceDir = path.join(packagePath('socket.io'), 'client-dist')
  const targetDir = path.join(packagesRoot, 'socket.io', 'client-dist')
  await fs.mkdir(targetDir, { recursive: true })
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => !src.endsWith('.map')
  })
}

async function copyThreeExporters (vendorRoot) {
  const sourceDir = path.join(NODE_MODULES_DIR, 'three', 'examples', 'js', 'exporters')
  const targetDir = path.join(vendorRoot, 'three', 'exporters')
  await fs.mkdir(targetDir, { recursive: true })

  for (const exporter of THREE_EXPORTERS) {
    await fs.copyFile(path.join(sourceDir, exporter), path.join(targetDir, exporter))
  }
}

async function copyPrismarineViewerAssets (packagesRoot) {
  const sourceRoot = packagePath('prismarine-viewer')
  const targetRoot = path.join(packagesRoot, 'prismarine-viewer')
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

async function writeManifest (vendorRoot) {
  const modules = Object.fromEntries([
    ['minecraft-data', 'packages/minecraft-data/index.js'],
    ['minecraft-data/data.js', 'packages/minecraft-data/data.js'],
    ...BUNDLE_ENTRIES.map((entry) => [entry.specifier, `packages/${entry.output}`])
  ])
  const manifest = {
    layout: 'bundle-manifest',
    generatedBy: 'scripts/build-vendor.js',
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

  await fs.writeFile(path.join(vendorRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
}

async function pathExists (filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function walkFiles (rootDir) {
  const files = []

  async function walk (dirPath) {
    let entries
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true })
    } catch (error) {
      if (error && error.code === 'ENOENT') return
      throw error
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, fullPath))
      }
    }
  }

  await walk(rootDir)
  files.sort()
  return files
}

async function walkExistingFiles (rootDir) {
  return (await pathExists(rootDir)) ? walkFiles(rootDir) : []
}

function toPosixPath (relativePath) {
  return relativePath.split(path.sep).join('/')
}

function isInsidePreservedDir (relativePath, preservedDirs) {
  const normalized = toPosixPath(relativePath)
  return preservedDirs.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
}

async function filesEqual (left, right) {
  try {
    const [leftStat, rightStat] = await Promise.all([fs.stat(left), fs.stat(right)])
    if (leftStat.size !== rightStat.size) return false
  } catch {
    return false
  }

  const [leftBytes, rightBytes] = await Promise.all([fs.readFile(left), fs.readFile(right)])
  return leftBytes.equals(rightBytes)
}

async function copyFileIfChanged (sourceFile, targetFile, force) {
  if (!force && await filesEqual(sourceFile, targetFile)) return false

  await fs.mkdir(path.dirname(targetFile), { recursive: true })
  await fs.copyFile(sourceFile, targetFile)
  return true
}

async function syncDirectoryContents (sourceRoot, targetRoot, options = {}) {
  const force = options.force === true
  const preservedDirs = options.preservedDirs || []
  const sourceFiles = await walkFiles(sourceRoot)
  const targetFiles = await walkExistingFiles(targetRoot)
  const sourceSet = new Set(sourceFiles.map(toPosixPath))
  const summary = {
    copied: 0,
    unchanged: 0,
    removed: 0,
    preserved: 0
  }

  for (const relativePath of sourceFiles) {
    const copied = await copyFileIfChanged(
      path.join(sourceRoot, relativePath),
      path.join(targetRoot, relativePath),
      force
    )
    if (copied) summary.copied++
    else summary.unchanged++
  }

  for (const relativePath of targetFiles) {
    const normalized = toPosixPath(relativePath)
    if (sourceSet.has(normalized)) continue

    if (isInsidePreservedDir(normalized, preservedDirs)) {
      summary.preserved++
      continue
    }

    await fs.unlink(path.join(targetRoot, relativePath))
    summary.removed++
  }

  return summary
}

async function collectFilesUnder (rootDir) {
  const absoluteRoot = path.resolve(rootDir)
  const files = await walkExistingFiles(absoluteRoot)
  return files.map((relativePath) => path.join(absoluteRoot, relativePath))
}

async function computeVendorInputHash () {
  const hash = crypto.createHash('sha256')
  const packageNames = new Set([
    'minecraft-data',
    'prismarine-viewer',
    'socket.io',
    'three',
    ...BUNDLE_ENTRIES.map((entry) => entry.packageName)
  ])
  const inputFiles = [
    path.join(PROJECT_ROOT, 'package.json'),
    path.join(PROJECT_ROOT, 'package-lock.json'),
    path.join(PROJECT_ROOT, 'scripts', 'build-vendor.js'),
    ...(await collectFilesUnder(PRISMARINE_VIEWER_PATCH_ROOT)),
    ...[...packageNames].map((packageName) => path.join(NODE_MODULES_DIR, ...packageName.split('/'), 'package.json'))
  ]

  hash.update(`node:${process.versions.node}\n`)
  for (const filePath of inputFiles.sort()) {
    if (!await pathExists(filePath)) continue
    hash.update(path.relative(PROJECT_ROOT, filePath))
    hash.update('\0')
    hash.update(await fs.readFile(filePath))
    hash.update('\0')
  }

  return hash.digest('hex')
}

async function readVendorState () {
  try {
    return JSON.parse(await fs.readFile(VENDOR_STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function writeVendorState (inputHash) {
  await fs.mkdir(path.dirname(VENDOR_STATE_FILE), { recursive: true })
  await fs.writeFile(VENDOR_STATE_FILE, `${JSON.stringify({
    version: 1,
    inputHash
  }, null, 2)}\n`, 'utf8')
}

async function hasCompleteVendorOutput () {
  const manifestPath = path.join(VENDOR_ROOT, 'manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  } catch {
    return false
  }

  if (!manifest || !manifest.modules) return false

  for (const relativePath of Object.values(manifest.modules)) {
    if (!await pathExists(path.join(VENDOR_ROOT, relativePath))) return false
  }

  const assets = manifest.assets || {}
  const assetPaths = [
    ...(assets.minecraftData || []),
    assets.socketIoClient,
    assets.prismarineViewer && assets.prismarineViewer.package,
    assets.prismarineViewer && assets.prismarineViewer.missingTexture,
    ...(assets.threeExporters || [])
  ].filter(Boolean)

  for (const relativePath of assetPaths) {
    const fullPath = path.join(VENDOR_ROOT, relativePath)
    if (!await pathExists(fullPath)) return false
  }

  return true
}

async function shouldSkipVendorBuild (inputHash) {
  const state = await readVendorState()
  return !!(state && state.inputHash === inputHash && await hasCompleteVendorOutput())
}

async function main () {
  const force = process.argv.includes('-f') || process.argv.includes('--force')

  if (process.argv.includes('--prepare-viewer-only')) {
    await fs.mkdir(PATCHED_PACKAGES_ROOT, { recursive: true })
    await preparePatchedPrismarineViewerPackage()
    console.log('Prepared patched prismarine-viewer package in .build/vendor-packages')
    return
  }

  const inputHash = await computeVendorInputHash()
  await fs.mkdir(PATCHED_PACKAGES_ROOT, { recursive: true })
  await preparePatchedPrismarineViewerPackage()

  if (!force && await shouldSkipVendorBuild(inputHash)) {
    console.log('static/vendor is up to date; skipping vendored package rebuild')
    return
  }

  const stagingPackagesRoot = path.join(VENDOR_STAGING_ROOT, 'packages')
  await fs.rm(VENDOR_STAGING_ROOT, { recursive: true, force: true })
  await fs.mkdir(stagingPackagesRoot, { recursive: true })

  const tools = await loadRollupTools()
  for (const entry of BUNDLE_ENTRIES) {
    await bundleEntry(tools, entry, stagingPackagesRoot)
  }

  await copyMinecraftDataAssets(stagingPackagesRoot)
  await copySocketIoClientAssets(stagingPackagesRoot)
  await copyPrismarineViewerAssets(stagingPackagesRoot)
  await copyThreeExporters(VENDOR_STAGING_ROOT)
  await writeManifest(VENDOR_STAGING_ROOT)

  const syncSummary = await syncDirectoryContents(VENDOR_STAGING_ROOT, VENDOR_ROOT, {
    force,
    preservedDirs: [
      'packages/prismarine-viewer/public'
    ]
  })
  await writeVendorState(inputHash)

  console.log(`Built ${BUNDLE_ENTRIES.length} vendored module bundles into static/vendor/packages`)
  console.log(`Synced static/vendor: ${syncSummary.copied} copied, ${syncSummary.unchanged} unchanged, ${syncSummary.removed} removed, ${syncSummary.preserved} preserved`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
