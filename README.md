# Minecraft Processor

Minecraft Processor is a Node.js toolchain for Minecraft structure files. It provides three core capabilities:

- parse source files into native/source-oriented JSON,
- convert them into a canonical unified IR for ML/data pipelines,
- render and export structures in a browser viewer.

Supported input formats:

- `.schem`
- `.schematic`
- `.litematic`
- `.nbt`
- `.mcstructure`

The repository is centered around three stable root entrypoints:

- `parse_mc.js`
- `parse_mc_unified.js`
- `serve_mc.js`

These root files are thin wrappers. Their real implementations live under `apps/cli/`.

## What each command does

### `parse_mc.js`

`parse_mc.js` is the native/source-oriented parser.

It detects the structure format, chooses the appropriate native parser, and emits a thin descriptive envelope whose `data` field contains parser-native JSON.

Output shape:

```json
{
  "format": "mcstructure",
  "schema": "bedrock-mcstructure",
  "parser": "prismarine-nbt",
  "data": { "...": "parser-native readable JSON" }
}
```

Important notes:

- This is **not** the unified pipeline.
- Default output stays source-oriented.
- `--readable` decodes opaque native fields in place on the native path.
- `--filter-air` only works together with `--readable`.

Use this command when you need source-faithful semantics instead of a cross-format canonical structure.

### `parse_mc_unified.js`

`parse_mc_unified.js` is the canonical unified export command.

It parses source files directly, normalizes them into a fixed IR, and outputs canonical Java block-state data for the requested target version.

Output shape:

```json
{
  "meta": {
    "DataVersion": 4189,
    "source": {
      "format": "mcstructure",
      "edition": "bedrock",
      "version": null,
      "parser": "prismarine-nbt"
    },
    "target": {
      "edition": "java",
      "version": "1.21.8"
    },
    "coordinateSpace": "relative",
    "unknownPolicy": "keep",
    "stats": {
      "paletteSize": 1,
      "blockCount": 1,
      "entityCount": 0,
      "unresolvedPaletteCount": 0,
      "unresolvedBlockCount": 0,
      "droppedBlockCount": 0
    }
  },
  "size": [1, 1, 1],
  "palette": [
    {
      "name": "minecraft:stone",
      "props": {}
    }
  ],
  "blocks": [[0, 0, 0, 0]],
  "entities": []
}
```

Unified IR facts:

- `blocks[*]` is `[x, y, z, pid]`
- `pid` is the palette index
- palette entries are minimal by default: `{ name, props }`
- Bedrock-derived palette entries may also include:
  - `mapping: { status, sourceKey }`
- `--unknown-policy` currently supports `keep` and `drop`
- `--solid_color` enriches each palette entry with `solid_color` from `static/mc_mappings.json` for simple single-color voxel consumers

Use this command when downstream consumers need one stable cross-format representation.

### `serve_mc.js`

`serve_mc.js` starts a local browser viewer.

Current runtime flow:

1. read a structure file,
2. parse it through the unified pipeline,
3. build a Prismarine world from unified blocks,
4. start Express + Socket.IO,
5. serve the viewer page and bundled runtime/static assets.

The viewer supports:

- structure rendering,
- asset switching within the same asset directory,
- screenshot capture,
- OBJ / STL / GLB export,
- GBuffer export,
- bounding-box display and filtering.

## Quick start

Install Node.js and Git LFS, then clone the repository with its prebuilt runtime assets:

```bash
git lfs install
git clone https://github.com/crd2333/minecraft-processor.git
cd minecraft-processor
node serve_mc.js assets/<file> --version 1.21.8 --port 3000
```

The parse and viewer entrypoints run directly from the checked-in assets under `static/`; normal use does not require `npm install`, a project-level `node_modules` directory, or `npm run build`.

If an entrypoint reports missing or invalid assets after cloning, fetch the Git LFS objects first:

```bash
git lfs pull
```

### Prebuilt runtime assets

The release-oriented vendor layout lives under `static/vendor/`:

- `static/vendor/manifest.json` maps package specifiers such as `prismarine-block` to prebuilt bundle files.
- `static/vendor/packages/` contains the Rollup-built runtime packages.
- `minecraft-data` is split into loader/source files plus versioned `data/` and `schemas/` assets because its data tree is intentionally large and asset-like.
- `prismarine-viewer` is staged from `node_modules/prismarine-viewer`, patched from `patches/prismarine-viewer/`, bundled into `static/vendor/packages/prismarine-viewer/`, and stores its generated runtime assets under `static/vendor/packages/prismarine-viewer/public/`.
- server runtime packages used by `serve_mc.js`, including `express`, `compression`, and `socket.io`, are also exposed through the manifest.
- `static/vendor/three/exporters/` contains the browser exporter scripts served by `/vendor/three/:file`.
- `static/vendor/manifest.json` records the generated package set.

The root entrypoints activate this manifest automatically when `static/vendor/manifest.json` exists, so a prebuilt release can run without a live project-level `node_modules` directory. Development checkouts can still use normal `node_modules`; the manifest only redirects package names that are explicitly listed in `static/vendor/manifest.json`.

Viewer asset notes:

- `patches/prismarine-viewer/` contains local overlays applied to the installed `prismarine-viewer` package before bundling.
- `static/index.js` is the final browser application bundle. The viewer worker bundle lives with the vendored viewer package at `static/vendor/packages/prismarine-viewer/public/worker.js`.
- Prefer editing source files, not `static/*`, unless you are intentionally checking in regenerated build output.

### Development builds

Only contributors changing dependencies, viewer source, Prismarine viewer patches, or generated runtime assets need to install npm dependencies and rebuild:

```bash
npm install
npm run build
```

`npm install` does not trigger a build automatically. Run `npm run build` explicitly after making build-relevant changes and commit the regenerated assets with the source changes.

What `npm run build` does:

- `npm run build:vendor-packages` builds/copies runtime vendor package payloads into `static/vendor/`
- `npm run build:viewer-assets` generates Prismarine viewer textures/block-state assets into `static/vendor/packages/prismarine-viewer/public/`
- Webpack bundles the application viewer runtime into `static/index.js` and the Prismarine viewer worker runtime into `static/vendor/packages/prismarine-viewer/public/worker.js`

The vendor package build is content-aware. It prepares patched package sources under `.build/vendor-packages/`, stages generated vendor output under `.build/vendor-output/`, then syncs into `static/vendor/` only when file bytes differ. If the recorded input fingerprint still matches and the expected output files exist, the vendor build is skipped. Use `npm run build:vendor-packages -- -f` to force a vendor artifact refresh.

## Usage

### Native parse

```bash
node parse_mc.js assets/<file> --stdout --pretty
```

Readable native parse:

```bash
node parse_mc.js assets/<file> --readable --stdout --pretty
```

Readable native parse with air filtering:

```bash
node parse_mc.js assets/<file> --readable --filter-air --stdout --pretty
```

### Unified parse

```bash
node parse_mc_unified.js assets/<file> --target-version 1.21.8 --stdout --pretty
```

Drop unresolved Bedrock-derived blocks instead of keeping them:

```bash
node parse_mc_unified.js assets/<file> --target-version 1.21.8 --unknown-policy drop --stdout --pretty
```

Add per-palette solid colors for downstream single-color voxel renderers:

```bash
node parse_mc_unified.js assets/<file> --target-version 1.21.8 --solid_color --stdout --pretty
```

### Viewer

```bash
node serve_mc.js assets/<file> --version 1.21.8 --port 3000
```

Optional viewer flags:

- `--view-distance <chunks>`
- `--center x,y,z`
- `--bbox-origin x,y,z`
- `--bbox-size n|x,y,z`
- `--no-bbox`


## Practical verification commands

The repository currently uses smoke-style verification rather than a mature test suite.

Useful commands:

```bash
npm run build
npm test
npm run lint
npm run type-check
node parse_mc.js assets/<file> --stdout --pretty
node parse_mc_unified.js assets/<file> --target-version 1.21.8 --stdout --pretty
node serve_mc.js assets/<file> --version 1.21.8 --port 3000
```

At the moment, `npm test`, `npm run lint`, and `npm run type-check` all run the repository smoke script `scripts/test/smoke_native_unified.js`.

## Repository layout

```text
parse_mc.js
parse_mc_unified.js
serve_mc.js                     # stable root entrypoints

apps/
├── cli/                        # real CLI/server implementations
└── frontend/viewer/            # viewer HTML + browser runtime source

src/
├── structure_parser.js         # native parsing helpers and format detection
├── unified_parser.js           # canonical unified IR construction
├── world_builder.js            # unified IR -> prismarine world placement
├── structure_mesh.js           # headless unified world -> indexed triangle mesh
└── bedrock-adapter/            # Bedrock -> Java conversion and post-processing

static/                         # built browser runtime assets and prebuilt vendor packages
patches/prismarine-viewer/      # local overlays applied to the npm prismarine-viewer package
scripts/                        # generators and smoke/helper scripts
```

## Bedrock handling model

Bedrock handling is intentionally split by layer:

- native parse does **not** convert Bedrock blocks into Java names/states
- unified parse converts Bedrock palette entries into canonical Java-oriented block-state output when possible
- unresolved Bedrock mappings stay explicit through `mapping.status === "unresolved"`
- Bedrock-specific world-context corrections live in `src/bedrock-adapter/postProcess.js`

This separation is important:

- native output stays source-oriented,
- unified output becomes canonical,
- render correctness depends on Bedrock post-processing where neighbor context matters.

## Viewer export notes

The viewer exposes screenshot, mesh export, and GBuffer export functionality.

Current GBuffer facts:

- binary magic: `MCGBUF01`
- file layout: header + metadata JSON + concatenated channel blobs
- channels include `rgb`, `depth`, `seg`, and `mask`
- depth stores metric `z` as float16
- background depth is `+Inf`

Helper reader:

```bash
python scripts/read_gbuffer.py gbuffer.bin --save --out gbuffer_out
```

## Notes for development

- Keep root entrypoint filenames stable.
- Do not move heavy logic back into root wrappers.
- Treat `patches/prismarine-viewer/` as the local patch set for the npm `prismarine-viewer` package.
- Do not document behavior that the current code does not actually support.


## Fix/Modifications for prismarine-viewer
1. Fix the error of rendering 'stairs' as 'air' in PrismarineJS (caused by `.include('air)` in its `models.js`)
2. Added depth map and segmentation map rendering support (modifications to vendored PrismarineJS viewer):
   - `patches/prismarine-viewer/viewer/lib/models.js`: Extended `getSectionGeometry()` and `renderElement()`/`renderLiquid()` to produce a per-vertex `blockIds` attribute (Float32Array) containing the block stateId for each vertex. Also collects a `stateIdToName` map from stateId to block name strings during geometry generation.
   - `patches/prismarine-viewer/viewer/lib/worker.js`: Transfers the `blockIds` buffer alongside existing geometry buffers via `postMessage`.
   - `patches/prismarine-viewer/viewer/lib/worldrenderer.js`: Attaches `blockId` as a vertex attribute on each mesh. Adds custom materials and methods `renderDepthMap()`, `renderSegmentationMap()`, `renderColorSegMap()` that perform off-screen render passes and return raw pixel data. Accumulates `stateIdToName` from all worker messages.
3. Face Culling fix: replace simple `!neighbor.transparent && neighbor.isCube` logic with a more robust check that also considers block models and partial transparency. This prevents incorrect culling of faces adjacent to non-cube blocks like stairs, fences, etc.

## References

Structure format references:

- `.schematic`: <https://minecraft.wiki/w/Schematic_file_format>
- `.schem`: <https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-3.md>
- `.litematic`: <https://github.com/maruohon/litematica> (no formal spec; see issue [#53](https://github.com/maruohon/litematica/issues/53))
- `.nbt`: <https://minecraft.wiki/w/Structure_block_file_format>
- `.mcstructure`: <https://wiki.bedrock.dev/nbt/mcstructure>
