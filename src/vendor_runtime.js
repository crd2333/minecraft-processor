const fs = require('fs')
const Module = require('module')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const VENDOR_ROOT = path.join(PROJECT_ROOT, 'static', 'vendor')
const VENDOR_MANIFEST = path.join(VENDOR_ROOT, 'manifest.json')

let activated = false

function loadManifest () {
  if (!fs.existsSync(VENDOR_MANIFEST)) return null
  return JSON.parse(fs.readFileSync(VENDOR_MANIFEST, 'utf8'))
}

function activateVendorModules () {
  if (activated) return

  const manifest = loadManifest()
  if (!manifest || !manifest.modules) return
  activated = true

  const moduleMap = new Map(Object.entries(manifest.modules).map(([specifier, relativePath]) => {
    return [specifier, path.join(VENDOR_ROOT, relativePath)]
  }))

  const originalResolveFilename = Module._resolveFilename
  Module._resolveFilename = function resolveVendoredModule (request, parent, isMain, options) {
    const target = moduleMap.get(request)
    if (target) return target

    return originalResolveFilename.call(this, request, parent, isMain, options)
  }
}

module.exports = {
  activateVendorModules,
  activateVendorNodeModules: activateVendorModules,
  VENDOR_ROOT,
  VENDOR_MANIFEST
}
