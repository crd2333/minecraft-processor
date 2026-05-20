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

If `serve_mc.js` reports missing assets, run `npm run build` first.

## Build

Install dependencies:

```bash
npm install
```

Build runtime assets required by the browser viewer:

```bash
npm run build
```

What `npm run build` does:

- `npm run build:assets` generates browser/runtime assets
- `npm run build:client` bundles frontend viewer scripts into `static/`

`serve_mc.js` depends on built output and runtime static lookup assets under `static/`.

Viewer asset notes:

- `prismarine-viewer-lib/` is vendored third-party viewer code with local patches for this repository.
- `static/` contains built browser assets derived from the viewer/frontend sources.
- When changing viewer runtime code under `prismarine-viewer-lib/` or `apps/frontend/viewer/`, rebuild with `npm run build` so `static/` stays in sync.
- Prefer editing source files, not `static/*`, unless you are intentionally checking in regenerated build output.

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

At the moment, `npm test`, `npm run lint`, and `npm run type-check` all run the repository smoke script `scripts/smoke_native_unified.js`.

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
└── bedrock-adapter/            # Bedrock -> Java conversion and post-processing

static/                         # built browser runtime assets and static lookup data such as mc_mappings.json
prismarine-viewer-lib/          # vendored + locally modified viewer source
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

## Notes for contributors

- Keep root entrypoint filenames stable.
- Do not move heavy logic back into root wrappers.
- Treat `prismarine-viewer-lib/` as third-party code with local patches.
- Do not document behavior that the current code does not actually support.


## Fix/Modifications for prismarine-viewer-lib
1. Fix the error of rendering 'stairs' as 'air' in PrismarineJS (caused by `.include('air)` in its `models.js`)
2. Added depth map and segmentation map rendering support (modifications to vendored PrismarineJS viewer):
   - `prismarine-viewer-lib/models.js`: Extended `getSectionGeometry()` and `renderElement()`/`renderLiquid()` to produce a per-vertex `blockIds` attribute (Float32Array) containing the block stateId for each vertex. Also collects a `stateIdToName` map from stateId to block name strings during geometry generation.
   - `prismarine-viewer-lib/worker.js`: Transfers the `blockIds` buffer alongside existing geometry buffers via `postMessage`.
   - `prismarine-viewer-lib/worldrenderer.js`: Attaches `blockId` as a vertex attribute on each mesh. Adds three custom `ShaderMaterial`s (depth, segmentation-by-ID, segmentation-by-color) and methods `renderDepthMap()`, `renderSegmentationMap()`, `renderColorSegMap()` that perform off-screen render passes and return raw pixel data. Accumulates `stateIdToName` from all worker messages.
3. Face Culling fix: replace simple `!neighbor.transparent && neighbor.isCube` logic with a more robust check that also considers block models and partial transparency. This prevents incorrect culling of faces adjacent to non-cube blocks like stairs, fences, etc.

## References

Structure format references:

- `.schematic`: <https://minecraft.wiki/w/Schematic_file_format>
- `.schem`: <https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-3.md>
- `.litematic`: <https://github.com/maruohon/litematica> (no formal spec; see issue [#53](https://github.com/maruohon/litematica/issues/53))
- `.nbt`: <https://minecraft.wiki/w/Structure_block_file_format>
- `.mcstructure`: <https://wiki.bedrock.dev/nbt/mcstructure>
