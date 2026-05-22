#!/usr/bin/env node

require('./src/vendor_runtime').activateVendorModules()
require('./apps/cli/serve_mc')
