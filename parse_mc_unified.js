#!/usr/bin/env node

require('./src/vendor_runtime').activateVendorModules()
require('./apps/cli/parse_mc_unified')
