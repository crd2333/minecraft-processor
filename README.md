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

### Headless SuperDec point clouds

Install the Python dependency. The required block-state model assets are included in the Git LFS checkout:

```bash
python3 -m pip install -r requirements-pointcloud.txt
```

Convert one structure file into a normalized 4,096-point SuperDec input:

```bash
python3 scripts/sample_structure_pointcloud.py \
  assets/other/1.schem \
  --version 1.21.8 \
  --surface-points 100000 \
  --points 4096 \
  --seed 0 \
  --output-dir outputs/pointcloud/1
```

The positional input may also be a directory. Directory mode recursively finds
all supported structure formats, sorts them by relative path, and writes each
source into an isolated mirrored output directory:

```bash
python3 scripts/sample_structure_pointcloud.py \
  assets/boxelizer \
  --output-dir outputs/pointcloud/boxelizer
```

The pipeline is fully headless: JavaScript parses the structure and generates
the patched Prismarine block-model triangle mesh, then Python samples 100,000
surface points by triangle area and applies exact greedy FPS. No HTTP server,
browser, or WebGL context is used.

Each successful source produces:

- `<stem>.superdec.ply`: binary PLY containing normalized z-up XYZ points only;
- `<stem>.superdec.npz`: surface samples, FPS points, normalized points, and
  reversible transform arrays;
- `<stem>.superdec.json`: human-readable source, mesh, sampling, and transform
  metadata.

Minecraft y-up coordinates are always rotated into a right-handed z-up system
with `(x, y, z) -> (x, -z, y)`. The FPS result is then centered and divided by
`2 * max(abs(points - mean))`, giving a maximum absolute coordinate of `0.5`.
The JSON/NPZ rotation, translation, and scale map SuperDec results back to
structure-relative Minecraft coordinates. Directory runs also write
`batch-summary.json` and exit non-zero when any item fails, while preserving
successful sibling outputs.

Run the focused smoke check with reduced point counts:

```bash
npm run test:pointcloud
```

### Headless indexed meshes

Export a single structure as an ASCII PLY with only vertices and triangle
indices. `--normalize` centers the mesh and uniformly scales its largest axis
to the `[-0.5, 0.5]` range:

```bash
node scripts/export_structure_mesh.js \
  assets/other/1.schem \
  --version 1.21.8 \
  --format ply \
  --normalize \
  --output-dir outputs/mesh/1
```

The PLY contains `vertex x y z` records followed by triangular `face` records
with vertex indices; it does not include normals, UVs, or materials. The
coordinates retain Minecraft's right-handed structure-relative `+y`-up axes.

Directory input is recursive and mirrors source-relative paths under the output
directory:

```bash
node scripts/export_structure_mesh.js \
  assets/boxelizer \
  --format ply \
  --normalize \
  --output-dir outputs/mesh/boxelizer
```

Use `--resume` to skip already completed, non-empty PLY files after a stopped
directory run. PLY files are written to a temporary sibling path and renamed
only after streaming finishes, so interrupted outputs are not resumed as if
they were complete:

```bash
node scripts/export_structure_mesh.js \
  outputs/minecraft-dataset/structures \
  --format ply \
  --normalize \
  --resume \
  --output-dir outputs/mesh
```

The legacy default format remains a single-file buffer export containing
`positions.f32`, `indices.u32`, and `mesh.json`, for callers that consume raw
typed arrays directly. Run `npm run test:mesh-export` for the focused mesh
export smoke check.

### Hosted realistic image conversion

`scripts/generate_realistic_images.py` is a standalone batch tool for sending
existing Minecraft renderer screenshots to a hosted image-to-image model. It is
independent of the browser viewer.

The first version supports two image-conditioned contracts:

- `gemini`: Gemini `generateContent` with one inline reference image. The
  default root is `https://generativelanguage.googleapis.com/v1beta` and the
  default model is `gemini-3-pro-image-preview`.
- `openai`: OpenAI-compatible multipart `/images/edits`. The default root is
  `https://api.openai.com/v1` and the default model is `gpt-image-1`.

Use environment variables for credentials:

```bash
export GEMINI_API_KEY='your-key'
python3 scripts/generate_realistic_images.py \
  path/to/render.png \
  --provider gemini \
  --output outputs/realistic
```

For a directory, discovery order is lexical and processing is sequential by
default. Add `--recursive` for descendants; completed image/JSON groups are
skipped automatically:

```bash
export GEMINI_API_KEY='your-key'
export GEMINI_IMAGE_MODEL='gemini-3-pro-image-preview'
export GEMINI_BASE_URL='https://generativelanguage.googleapis.com/v1beta'
python3 scripts/generate_realistic_images.py \
  path/to/renders \
  --provider gemini \
  --recursive \
  --output outputs/realistic
```

For an OpenAI-compatible relay, override the root and model without changing
the script:

```bash
export OPENAI_API_KEY='your-key'
export OPENAI_BASE_URL='https://api.openai.com/v1'
export OPENAI_IMAGE_MODEL='gpt-image-1'
export OPENAI_IMAGE_SIZE='auto'
export OPENAI_IMAGE_QUALITY='high'
export OPENAI_IMAGE_OUTPUT_FORMAT='png'
python3 scripts/generate_realistic_images.py \
  path/to/renders \
  --provider openai \
  --output outputs/realistic
```

`--base-url` also accepts a complete Gemini
`...:generateContent` endpoint, including a provider-required query parameter;
the CLI redacts key-like query values in logs and metadata. `--prompt-file`
selects a different prompt version. The editable default is
`prompts/minecraft_to_realistic_v1.txt`. Use `--dry-run` to inspect discovery
and output mapping without an API key or network request, and `--overwrite` to
rerun a case after changing its prompt, model, provider, or generation settings.
Each completed case writes a generated image and a same-stem JSON metadata file.

OpenAI requests default to `size=auto`, `quality=high`, and
`output_format=png`. Override them with `--size`, `--quality`, and
`--output-format`, or with the corresponding environment variables shown
above. PNG requests do not send `output_compression`; that field only matters
for lossy JPEG/WebP output.

Gemini has no direct quality or output-format equivalent. It supports optional
image size and aspect ratio controls instead:

```bash
export GEMINI_IMAGE_SIZE='2K'
export GEMINI_IMAGE_ASPECT_RATIO='16:9'
python3 scripts/generate_realistic_images.py \
  path/to/render.png \
  --provider gemini \
  --output outputs/realistic
```

Gemini size accepts `auto`, `1K`, `2K`, or `4K`. With the default `auto`, the
script omits `imageConfig.imageSize` and lets the model choose from the source
image. Aspect ratio behaves the same way and is omitted by default.

### Parallel batches and variations

Use `--concurrency` to bound active cases and `--num-images` to request several
variations for each source image. The command keeps up to the selected number
of cases in flight and starts another immediately when one completes:

```bash
python3 scripts/generate_realistic_images.py \
  path/to/renders \
  --provider openai \
  --recursive \
  --output outputs/realistic \
  --concurrency 5 \
  --num-images 2
```

`--concurrency` defaults to `5`; `--num-images` accepts values from `1` to `8`
and defaults to `1`. OpenAI sends the requested count as multipart `n`; Gemini
sends it as `generationConfig.candidateCount`. A multi-image case is complete
only when its metadata and every numbered result exist and match their recorded
hashes. Results use `__01`, `__02`, and so on before the image extension.

Some compatible relays accept `n=2` but return only one image. The CLI saves
every returned image immediately, records the case as `partial`, and sends a
follow-up request only for the missing count. If that top-up fails, the partial
image and metadata remain on disk; rerunning the same command resumes from the
saved count instead of paying to regenerate completed outputs. Retryable HTTP
responses honor both the standard `Retry-After` header and JSON
`retry_after` values before falling back to exponential backoff.

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

## Notes for contributors

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
