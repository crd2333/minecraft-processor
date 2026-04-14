# Minecraft Processor

A node-based Minecraft data processor. This project utilizes the [Prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) library, but reduces unnecessary features. Prismarine-viewer supports Minecraft versions from 1.8 to 1.21.4, so is this project.

The main goal of this project is to provide a simple and efficient way to process Minecraft data for ML applications. It is able to parse, render, export minecraft structure block files (.schem, .schematic, .litematic, .nbt, .mcstructure) into readable data / pictures / 3D models.

## Build
Install dependencies and generate the local rendering assets:

```bash
npm install
```

## Usage
`parse_mc.js` is the faithful readable native translator. It reads a structure file and emits a thin descriptive envelope whose `data` field is parser-native readable JSON. It does **not** fabricate a cross-format `{ meta, size, palette, blocks, entities }` shape and should not be treated as unified pipeline stage 1.

`parse_mc_unified.js` is the canonical ML/data-oriented command. It parses source files directly, applies edition/version mapping only at the unified layer, and outputs the fixed IR:

```json
{
  "meta": {
    "DataVersion": 4189,
    "source": { "format": "mcstructure", "edition": "bedrock", "version": null, "parser": "prismarine-nbt" },
    "target": { "edition": "java", "version": "1.21.4" },
    "coordinateSpace": "relative",
    "unknownPolicy": "keep",
    "stats": { "paletteSize": 1, "blockCount": 1, "entityCount": 0, "unresolvedPaletteCount": 0, "unresolvedBlockCount": 0, "droppedBlockCount": 0 }
  },
  "size": [1, 1, 1],
  "palette": [{ "name": "minecraft:stone", "props": {} }],
  "blocks": [[0, 0, 0, 0]],
  "entities": []
}
```

Unified palette entries are minimal by default: `{ name, props }`.

For Bedrock-sourced entries only, the palette may additionally include:

- `mapping`: `{ status, sourceKey }`

`blocks[*][3]` is still the palette id, but `pid` is now implicit from the palette array index and is no longer stored on palette entries.

Unknown handling is explicit via `--unknown-policy keep|drop`.

`parse_mc_ids.js` has been removed by design. Compact numeric vocabulary export is no longer a top-level CLI contract.

Unified parsing is version-targeted canonical Java block-state output only. Vocabulary/export semantics are no longer part of the unified CLI contract.

`serve_mc.js` is used to show the structure block files in a web browser using key libraries from PrismarineJS. It also provides an API to export the structure block files into pictures and 3D models.

`serve_mc.js` now renders all supported structure formats through the unified parser pipeline. It loads unified `{ meta, size, palette, blocks, entities }` IR for the requested Java version, then builds the Prismarine world directly from canonical Java palette entries.

If serve_mc.js reports missing built assets, run npm run build first.

Example:

```bash
# Native parse
node parse_mc.js assets/xxx.schem --pretty

# Unified canonical payload
node parse_mc_unified.js assets/xxx.mcstructure --target-version 1.21.4 --pretty

# Viewer
node serve_mc.js assets/xxx.schem --version 1.21.4 --port 3000
```

A minimal Python subprocess example is available at `scripts/python_example.py`. It reads unified JSON from `parse_mc_unified.js`.

## Code Layout
`parse_mc.js` and `serve_mc.js` remain stable root entrypoints. `parse_mc_unified.js` is the canonical unified-output command. `parse_mc_ids.js` has been deleted.

Shared structure parsing logic now lives under `src/structure_parser.js`: shared format detection, NBT probing, coordinate helpers, and native parse support.

Unified parsing also lives in `src/structure_parser.js`: the same shared module now owns native loading and unified IR construction.

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


## Reference
Structure files specifications:
- `.schematic`: `https://minecraft.wiki/w/Schematic_file_format`
- `.schem`: `https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-3.md` (and v1, v2)
- `.litematic`: not found yet, maybe there does not exist such a spec, see `https://github.com/maruohon/litematica/issues/53`
- `.nbt`: `https://minecraft.wiki/w/Structure_block_file_format` or in Chinese `https://zh.minecraft.wiki/w/%E7%BB%93%E6%9E%84%E5%AD%98%E5%82%A8%E6%A0%BC%E5%BC%8F`
- `.mcstructure`: `https://wiki.bedrock.dev/nbt/mcstructure` or in Chinese `https://zh.minecraft.wiki/w/%E5%9F%BA%E5%B2%A9%E7%89%88%E7%BB%93%E6%9E%84%E6%96%87%E4%BB%B6`
