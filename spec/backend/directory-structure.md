# Directory Structure

> How backend code is organized in this project.

---

## Overview

This project separates backend responsibilities by runtime role, not by enterprise layers.

- root files are stable public wrappers,
- `apps/cli/` contains executable runtimes,
- `src/` contains reusable domain logic,
- `scripts/` contains generation/build helpers,
- `patches/` contains local overlays applied to third-party packages before bundling,
- `static/` contains built browser runtime assets, prebuilt vendor packages, and browser-served lookup data.

If a function is reused by more than one entrypoint, it should probably live in `src/`.

---

## Directory Layout

```text
parse_mc.js
parse_mc_unified.js
serve_mc.js                     # stable public entrypoints

apps/
└── cli/
    ├── parse_mc.js             # native/source-oriented parse runtime
    ├── parse_mc_unified.js     # unified IR export runtime
    └── serve_mc.js             # Express + Socket.IO viewer runtime

src/
├── structure_parser.js         # format detection + native parse helpers
├── unified_parser.js           # canonical unified IR construction
├── world_builder.js            # unified IR -> prismarine world placement
└── bedrock-adapter/
    ├── convertBlocks.js        # Bedrock -> Java block conversion
    ├── postProcess.js          # context-aware Bedrock fixups
    └── version.js              # Bedrock version normalization helpers

scripts/                        # asset generation and smoke/helper scripts
patches/
└── prismarine-viewer/           # local overlays applied before bundling npm prismarine-viewer

static/                         # browser build output, vendor bundles, and static lookup data
└── vendor/
    └── packages/               # prebuilt runtime package bundles and package-local assets
```

---

## Module Organization

### 1. Root wrappers stay thin

The repository contract is the root filenames. They should continue delegating into `apps/cli/`.

Good pattern:

- `parse_mc.js` at repo root delegates to `apps/cli/parse_mc.js`
- `parse_mc_unified.js` at repo root delegates to `apps/cli/parse_mc_unified.js`
- `serve_mc.js` at repo root delegates to `apps/cli/serve_mc.js`

Do not move heavy implementation back into root wrappers.

### 2. `apps/cli/` owns executable orchestration

Put these concerns in `apps/cli/`:

- parsing command-line arguments
- reading/writing files
- process exit behavior
- wiring shared modules together
- Express/Socket.IO route setup for the viewer

Examples:

- `apps/cli/parse_mc.js` parses args, reads the input file, calls `loadNativeStructure()`, writes JSON.
- `apps/cli/parse_mc_unified.js` reads the input file, calls `loadUnifiedStructure()`, writes the canonical IR.
- `apps/cli/serve_mc.js` owns route registration, socket lifecycle, and viewer asset checks.

### 3. `src/` owns reusable domain logic

Put these concerns in `src/`:

- format detection and structure interpretation
- native/source-oriented parsing helpers
- unified payload construction
- world placement rules
- Bedrock conversion/post-processing

Examples:

- `src/structure_parser.js` centralizes format detection and native parsing helpers.
- `src/unified_parser.js` owns canonical unified IR shaping.
- `src/world_builder.js` isolates world placement from the viewer server.

### 4. `bedrock-adapter/` is a focused subdomain

Keep Bedrock-specific logic grouped together.

- table-driven conversion in `convertBlocks.js`
- version normalization in `version.js`
- world-context derived corrections in `postProcess.js`

Do not scatter Bedrock special cases across unrelated modules unless they are truly local.

---

## Naming Conventions

- Use the existing lowercase snake-style filenames:
  - `structure_parser.js`
  - `unified_parser.js`
  - `world_builder.js`
- Name exported helpers after the domain action they perform:
  - `loadNativeStructure`
  - `loadUnifiedStructure`
  - `buildWorldFromUnifiedStructure`
- Keep module names descriptive to the runtime contract, not generic names like `utils.js` or `helpers.js`.

---

## Refactor Routing Rules

When adding code during a refactor, route it like this:

- new native/source parse behavior -> `src/structure_parser.js`
- new unified mapping logic -> `src/unified_parser.js`
- new Bedrock mapping or version helper -> `src/bedrock-adapter/`
- new viewer-server route or socket behavior -> `apps/cli/serve_mc.js`
- new generated/browser-served lookup file -> `scripts/` + `static/`
- new third-party viewer overlay -> `patches/prismarine-viewer/`
- new browser-only export/capture behavior -> `apps/frontend/viewer/`, not backend

---

## Anti-Patterns

- Do not put reusable parsing logic directly in `serve_mc.js` if `parse_mc.js` or `parse_mc_unified.js` would need it too.
- Do not add a catch-all `src/utils.js`.
- Do not mix browser globals into backend modules.
- Do not treat generated files as the hand-edited source of truth.

---

## Examples

### Example 1: thin CLI delegating to shared code

- `apps/cli/parse_mc.js`
- `src/structure_parser.js`

`parse_mc.js` handles process/IO concerns; `structure_parser.js` handles format-specific parsing helpers.

### Example 2: dedicated unified contract module

- `apps/cli/parse_mc_unified.js`
- `src/unified_parser.js`

The CLI owns output orchestration; `unified_parser.js` owns canonical IR shaping.

### Example 3: viewer runtime split from world-building logic

- `apps/cli/serve_mc.js`
- `src/world_builder.js`

`serve_mc.js` coordinates the server; `world_builder.js` encapsulates block placement into the Prismarine world.

## Scenario: Mineways OBJ Viewer Entrypoint

### 1. Scope / Trigger

- Trigger: adding or modifying the Mineways OBJ overview viewer.
- This path is intentionally separate from the structure parser/chunk viewer path because it consumes Mineways OBJ/MTL/PNG mesh exports, not Minecraft structure files.

### 2. Signatures

- Root command: `node serve_mc_obj.js <file.obj> [--port <port>] [--cache-dir <dir>]`
- Runtime implementation: `apps/cli/serve_mc_obj.js`
- Reusable parsing/cache logic: `src/obj-mesh/`

### 3. Contracts

- Input file must be `.obj`.
- MTL is discovered from `mtllib ...` in the OBJ, with same-basename `.mtl` as fallback.
- Mineways atlas files are served from the OBJ directory; same-basename `-RGBA.png` is preferred when present.
- Mesh cache writes generated typed-array files under `.cache/mineways-obj/` by default and must not be committed.
- Browser API routes: `GET /api/mesh`, `GET /api/mesh/buffer/:file`, and `GET /api/mesh/texture/:key`.

### 4. Validation & Error Matrix

- Missing input path -> print usage and exit non-zero.
- Non-OBJ extension -> throw a descriptive unsupported-extension error.
- Missing built `static/obj-viewer.js` -> tell the user to run `npm run build`.
- Unknown buffer or texture key -> HTTP 404 JSON error.
- Invalid OBJ face/index data -> parser throws with OBJ line context.

### 5. Good/Base/Bad Cases

- Good: `scene.obj`, `scene.mtl`, and `scene-RGBA.png` in one directory; `node serve_mc_obj.js scene.obj` starts the viewer and uses typed-array cache.
- Base: OBJ has material groups but no usable MTL; the viewer still renders with default material metadata.
- Bad: parsing OBJ text in the browser; large Mineways OBJ files can spike memory before rendering.

### 6. Tests Required

- Smoke cache generation with `assets/mineways/1.obj` when the fixture exists.
- Assert cache metadata has positive vertex/triangle counts and material groups.
- Assert generated buffer files named by `mesh.buffers` exist.
- Run `npm test` and `npm run build` after changing this path.

### 7. Wrong vs Correct

#### Wrong

Put Mineways OBJ parsing directly in `apps/cli/serve_mc.js` or load large OBJ text in the browser.

#### Correct

Keep `serve_mc_obj.js` additive, put CLI/server orchestration in `apps/cli/serve_mc_obj.js`, and keep streaming OBJ/MTL/cache logic in `src/obj-mesh/`.

## Scenario: Headless Structure Point Clouds For SuperDec

### 1. Scope / Trigger

- Trigger: converting one structure file or a directory of structures into
  model-aware surface point clouds without starting the browser viewer.
- Minecraft-specific meshing belongs in `src/structure_mesh.js`; numerical
  surface sampling/FPS and research artifact orchestration belong in
  `scripts/sample_structure_pointcloud.py`.

### 2. Signatures

```bash
python3 scripts/sample_structure_pointcloud.py <file-or-directory> \
  [--version 1.21.8] [--surface-points 100000] [--points 4096] \
  [--seed 0] [--output-dir <directory>]

node scripts/export_structure_mesh.js <structure-file> \
  --output-dir <temporary-directory> [--version 1.21.8]
```

Shared JavaScript API:

```js
const { buildStructureMesh } = require('./src/structure_mesh')
const mesh = await buildStructureMesh(inputPath, { version, logger })
// mesh = { positions: Float32Array, indices: Uint32Array, metadata }
```

### 3. Contracts

- Supported inputs remain `.schem`, `.schematic`, `.litematic`, `.nbt`, and
  `.mcstructure` through `loadUnifiedStructure()`.
- The headless mesh path is unified IR -> `buildWorldFromUnifiedStructure()` ->
  patched `getSectionGeometry()`; do not replace block-model geometry with
  occupied-cell cubes when the requested contract is rendered surface shape.
- Section-local positions must add `geometry.sx/sy/sz`, then subtract the
  world builder's `originWorldPos` so output returns to structure-relative
  Minecraft coordinates. Missing either step silently shifts every point.
- The Node bridge writes versioned `mesh.json`, `positions.f32`, and
  `indices.u32`; large meshes must not cross the Node/Python boundary as JSON.
- Python samples triangles proportional to area, applies exact greedy FPS, then
  rotates y-up to right-handed z-up with `(x, y, z) -> (x, -z, y)`.
- SuperDec normalization is
  `normalized = (z_up - mean(z_up)) / (2 * max(abs(z_up - mean(z_up))))`.
- Each source writes normalized XYZ-only PLY, complete NPZ arrays, and JSON
  transform metadata. Directory runs are recursive, sorted by relative path,
  collision-safe, and write `batch-summary.json`.
- Batch processing continues after per-file failures but exits non-zero if any
  item failed. Successful sibling outputs remain valid.

### 4. Validation & Error Matrix

- Unsupported/missing input -> fail before item processing with the exact path
  or extension.
- Missing block-state model JSON -> fail with `npm run build` guidance.
- Missing Prismarine Node dependencies -> fail with `npm install` guidance.
- No renderable blocks/faces or no positive-area triangles -> fail that item.
- Invalid buffer lengths or out-of-range indices -> fail before sampling.
- `--points > --surface-points` -> fail before mesh extraction.
- Per-item batch failure -> remove that item's final artifacts, record the
  error, continue siblings, and return non-zero after writing the summary.

### 5. Good/Base/Bad Cases

- Good: a nested directory containing duplicate stems in different paths
  produces isolated outputs and deterministic same-seed coordinates.
- Base: one `.schem` produces a 4,096-vertex normalized PLY plus NPZ/JSON.
- Bad: sampling unified block centers; that changes a surface decomposition
  baseline into a volume/occupancy distribution.
- Bad: invoking browser OBJ export or WebGL on a headless preprocessing server.

### 6. Tests Required

- `npm run test:pointcloud` must assert area weighting, point counts,
  same-seed equality, z-up determinant `+1`, normalization extent, inverse
  transform round-trip, recursive ordering, collision isolation, and partial
  failure behavior.
- `npm test`, `npm run lint`, and `npm run type-check` must keep the existing
  native/unified smoke contract green.
- Before changing coordinate composition, run a real fixture and assert mesh
  bounds align with its structure-relative bounds rather than y=60 world space.
- Validate at least one Bedrock `.mcstructure` fixture after meshing changes.

### 7. Wrong vs Correct

Wrong:

```text
unified.blocks -> block centers -> random 4096 points
```

Correct:

```text
unified blocks -> Prismarine world -> patched triangle geometry
  -> 100k area-uniform surface samples -> exact FPS 4096
  -> right-handed z-up -> SuperDec normalization
```
