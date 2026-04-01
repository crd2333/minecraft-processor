# Minecraft Processor

A node-based Minecraft data processor. This project utilizes the [Prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) library, but reduces unnecessary features. Prismarine-viewer supports Minecraft versions from 1.8 to 1.21.4, so is this project.

The main goal of this project is to provide a simple and efficient way to process Minecraft data for ML applications. It is able to parse, render, export minecraft structure block files (.schem, .schematic, .litematic, .nbt, .mcstructure) into readable data / pictures / 3D models.

## Build
Install dependencies and generate the local rendering assets:

```bash
npm install
```

## Usage
`parse_mc.js` parses structure block files into normalized JSON (`{ meta, palette, blocks }`).

`scripts/generate_vocab.js` is used to pre-generate a fixed Java block vocabulary for a target version under `data/generated/`. It reserves index `0` for unknown blocks, assigns entity blocks to one continuous index range, and assigns non-entity blocks to a second continuous range.

`parse_mc_ids.js` is used to export a minimal ML-oriented payload. It reuses the shared structure parser, converts Bedrock block names to Java names when needed, and outputs `blocks: [[x, y, z, index], ...]` by looking up a pre-generated vocabulary file from `data/generated/`. If you only want entity blocks, pass `--entity-only` and non-entity blocks will be ignored during export.

The current entity/non-entity split is based on `minecraft-data` metadata: a block is treated as an entity block when `boundingBox !== 'empty'`.

`serve_mc.js` is used to show the structure block files in a web browser using key libraries from PrismarineJS. It also provides an API to export the structure block files into pictures and 3D models.

For `.schem/.schematic`, `serve_mc.js` first tries native `prismarine-schematic` parsing for accurate state-id handling. If native parsing fails for a valid but incompatible variant (for example Sponge v3 layouts), it now falls back to the shared parser automatically instead of crashing.

If serve_mc.js reports missing built assets, run npm run build first.

Example:

```bash
npm run generate:vocab -- 1.21.4

# Full normalized parse
node parse_mc.js assets/xxx.schem --pretty

# ID-only ML payload
node parse_mc_ids.js assets/xxx.mcstructure data/generated/block-vocab.1.21.4.json --entity-only --stdout --pretty

# Viewer
node serve_mc.js assets/xxx.schem --version 1.21.4 --port 3000
```

A minimal Python subprocess example is available at `scripts/python_example.py`. It reads the pre-generated vocabulary from `data/generated/block-vocab.1.20.1.json` and only calls `parse_mc_ids.js` at runtime.

## Code Layout
`parse_mc.js`, `serve_mc.js`, `parse_mc_ids.js` are the only root entrypoints.

Shared structure parsing logic now lives under `src/structure_parser.js`: shared format detection, NBT probing, coordinate helpers, and the unified structure-to-payload loader used by both parse and serve flows.

Rendering-specific world population logic lives under `src/world_builder.js`: converts normalized block payloads into a prismarine world and applies Bedrock post-processing when needed.

The browser page is no longer embedded in `serve_mc.js`. Frontend source files now live under `apps/frontend/viewer/` (`public/viewer.html`, `src/preload/viewer-preload.js`, `src/hooks/viewer-hooks.js`), while webpack outputs runtime bundles to `static/`.

Vendored Prismarine viewer code remains isolated under `prismarine-viewer-lib/`.

## Packages Fix/Modification
1. Fix the error of rendering 'stairs' as 'air' in PrismarineJS (caused by `.include('air)` in its `models.js`)
2. Added depth map and segmentation map rendering support (modifications to vendored PrismarineJS viewer):
   - `prismarine-viewer-lib/models.js`: Extended `getSectionGeometry()` and `renderElement()`/`renderLiquid()` to produce a per-vertex `blockIds` attribute (Float32Array) containing the block stateId for each vertex. Also collects a `stateIdToName` map from stateId to block name strings during geometry generation.
   - `prismarine-viewer-lib/worker.js`: Transfers the `blockIds` buffer alongside existing geometry buffers via `postMessage`.
   - `prismarine-viewer-lib/worldrenderer.js`: Attaches `blockId` as a vertex attribute on each mesh. Adds three custom `ShaderMaterial`s (depth, segmentation-by-ID, segmentation-by-color) and methods `renderDepthMap()`, `renderSegmentationMap()`, `renderColorSegMap()` that perform off-screen render passes and return raw pixel data. Accumulates `stateIdToName` from all worker messages.

## Depth Map & Segmentation Map

The viewer can capture three special render passes from the current camera view:

- **Depth Map** (`depth_map.png`): Linear grayscale depth. `d = (viewDepth - near) / (far - near)`, black = near, white = far.
- **Segmentation ID Map** (`segmentation_id.png`): Each pixel's RGB encodes the block `stateId` as `R*65536 + G*256 + B`. Background/air is black `(0,0,0)`. This provides a unique mapping per block state.
- **Segmentation Color Map** (`segmentation_color.png`): Each pixel uses a human-readable color from `data/generated/mc_mappings.json` (served at `/generated/mc_mappings.json`) based on block type. Multiple block types may share the same color.

**Capture All + Meta** downloads all three images plus a `capture_metadata.json` containing:
- Camera near/far planes for depth reconstruction
- Complete stateId → block name + RGB encoding table
- Color mapping reference from mc_mappings

All three maps preserve the actual block geometry (flowers render as cross-planes, slabs as half-blocks, stairs as stepped shapes, etc.) because the rendering uses the same vertex geometry as the normal textured view — only the material/shader is swapped during capture.

## GBuffer Export (current)

The viewer panel now exposes a single button:

- **Render GBuffer (.bin)**
- Optional checkbox: **Seg uses mc_mappings color** (unchecked = stateId RGB encoding)
- Optional checkbox: **Force square render** and size input (default 512)
- Optional checkbox: **Show square guide** overlays a visible square crop guide in the viewer

Output file: `gbuffer.bin`

### Binary layout

1. Header (16 bytes)
   - `magic[8] = "MCGBUF01"`
   - `version (uint32 LE)`
   - `metadataLength (uint32 LE)`
2. `metadata` JSON UTF-8 bytes
3. Raw channel blobs (concatenated):
   - `rgb`: uint8 RGBA, shape `[H, W, 4]` (includes alpha from texture/material transparency)
   - `depth`: float16, shape `[H, W]`, **metric depth z** (world units). Background is `+Inf`.
   - `seg`: uint8 RGBA, shape `[H, W, 4]` (`id` mode or `color` mode)
   - `mask`: uint8, shape `[H, W]`, value 1 if any fragment exists (opaque/translucent), else 0

Depth is already decoded to metric `z` and stored directly as float16.

### Python reader (headless-friendly)

Use:

```bash
python scripts/read_gbuffer.py gbuffer.bin --save --out gbuffer_out
```

This script prints tensor stats and writes `.npy` arrays always. If `imageio` is available, it also writes PNG previews (`rgb.png`, `seg.png`, `mask.png`, `depth_norm.png`) for remote/headless inspection.
