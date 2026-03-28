# Cross-Layer Thinking Guide

> Purpose: think through contract boundaries before implementing.

---

## Why this matters in minecraft-processor

Most important bugs in this repository happen at boundaries such as:

- native parse output vs unified IR expectations,
- unified IR vs world-building assumptions,
- `serve_mc.js` socket/route behavior vs frontend expectations,
- Bedrock conversion vs Bedrock post-processing.

The project is small, but it crosses file parsing, data normalization, local server wiring, and browser rendering. That means boundary mistakes are easy to make.

---

## Before implementing a cross-layer change

### Step 1: map the actual flow

For this repo, the common flows are:

```text
File -> native parse -> JSON output
File -> unified parse -> canonical IR -> JSON output
File -> unified parse -> world builder -> serve_mc.js -> socket/routes -> browser viewer
```

For each step, ask:

- what shape does the data have here?
- is it source-oriented or canonical?
- which module owns the contract?
- which doc files describe it?

### Step 2: identify the exact boundary

Examples of real project boundaries:

| Boundary | Typical mistake |
|----------|-----------------|
| `apps/cli/parse_mc.js` -> `src/structure_parser.js` | leaking unified assumptions into native output |
| `apps/cli/parse_mc_unified.js` -> `src/unified_parser.js` | changing tuple/palette shape without updating callers/docs |
| `src/unified_parser.js` -> `src/world_builder.js` | assuming world-builder accepts source-oriented blocks |
| `apps/cli/serve_mc.js` -> browser scripts | changing route/socket payloads on one side only |
| Bedrock conversion -> Bedrock post-process | fixing context-derived behavior in the wrong layer |

### Step 3: define the contract explicitly

Before editing, write down:

- input shape
- output shape
- allowed error paths
- whether the change is native-only, unified-only, viewer-only, or shared

If you cannot state those four things, you probably do not fully understand the change yet.

---

## Project-specific cross-layer mistakes

### Mistake 1: treating native parse as stage 1 of unified parse

Wrong mental model:

- “native output is basically unified output with different field names”

Current reality:

- native output is source-oriented
- unified output is a separate canonical contract

### Mistake 2: changing viewer behavior only in the frontend

The viewer depends on:

- Express routes from `apps/cli/serve_mc.js`
- Socket.IO events from `apps/cli/serve_mc.js`
- browser globals from `apps/frontend/viewer/src/client.js`
- control logic in `apps/frontend/viewer/src/hooks/viewer-hooks.js`

If you change one side, check the others.

### Mistake 3: fixing Bedrock issues in the wrong layer

Ask first:

- Is this a source parsing issue?
- Is this a Bedrock -> Java mapping issue?
- Is this a neighbor-context / shape issue?

Those belong in different places.

### Mistake 4: updating code but not docs

This project relies heavily on docs for fast orientation. If you change:

- entrypoint responsibilities,
- folder responsibilities,
- payload shapes,
- viewer routes,
- build/runtime assumptions,

then docs are part of the change.

### Mistake 5: blaming `serve_mc.js` for viewer meshing bugs

Wrong mental model:

- "If the browser shows X-Ray or missing faces, the server probably failed to send full world data."

Current reality:

- `apps/cli/serve_mc.js` sends chunk data and viewer assets, but it does not decide which block faces are emitted into section geometry.
- Base face omission for ordinary block rendering happens in the patched Prismarine meshing path under `patches/prismarine-viewer/viewer/lib/models.js` before bundling.
- `static/vendor/packages/prismarine-viewer/public/worker.js` is built output from that patched source path, so renderer fixes require rebuilding browser assets.

Practical debugging rule:

- If opaque structure surfaces are missing in normal viewer mode, trace `serve_mc.js` end-to-end first, then inspect `patches/prismarine-viewer/viewer/lib/models.js`, `worker.js`, and `worldrenderer.js` before changing parse or server code.
- Distinguish "neighbor exists" from "neighbor truly occludes this face"; collision-box cube checks alone may over-cull rendered faces.

### Mistake 6: mistaking viewer chunk-window focus for parse truncation

Wrong mental model:

- "A large structure starts near the interesting center content in the viewer, so parse coordinates must be shifted or clipped."

Current reality:

- `apps/cli/serve_mc.js` places unified blocks at structure-relative `x,z` and offsets only y through `src/world_builder.js`.
- The viewer default center is the structure center unless `--center x,y,z` is provided.
- The server sends chunks around that center using `--view-distance`, so very large structures can look truncated even when unified bounds are complete.

Practical debugging rule:

- First check unified bounds and `buildWorldFromUnifiedStructure()` placement before changing parser code.
- For huge overview screenshots, prefer a mesh/overview path over increasing chunk view distance until the browser OOMs.

---

## Checklist for cross-layer work

Before implementation:

- [ ] Mapped the complete flow
- [ ] Identified every module boundary involved
- [ ] Wrote down the exact contract at each boundary
- [ ] Decided where the change logically belongs

After implementation:

- [ ] Verified the affected CLI/viewer command end-to-end
- [ ] Confirmed backend/frontend route and socket alignment
- [ ] Confirmed native vs unified contracts are still distinct where intended
- [ ] Updated docs if the practical contract changed

---

## When to create extra flow notes

Create additional notes when:

- a task spans parse + unified + viewer,
- a payload shape is being intentionally changed,
- Bedrock behavior is being debugged across multiple stages,
- the change is easy to misread from old documentation.
