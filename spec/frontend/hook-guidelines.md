# Hook Guidelines

> How “hooks” are used in this project.

---

## Overview

In this repository, “hooks” does **not** mean React hooks.

`apps/frontend/viewer/src/hooks/viewer-hooks.js` is an injected browser script that hooks into the viewer runtime by:

- patching existing browser/Three behavior,
- reading globals exposed by `client.js`,
- binding UI controls,
- listening/emitting socket events.

Future contributors should interpret “hook” as **integration behavior layered onto the viewer**, not a `useSomething()` API.

---

## Custom Hook Patterns

Current project-specific patterns:

### 1. Monkey-patch only when necessary and near startup

Examples:

- `viewer-hooks.js:4-8` patches `THREE.Scene.prototype.updateMatrixWorld` to capture the scene reference.
- `viewer-preload.js:2-9` patches `HTMLCanvasElement.prototype.getContext` to preserve the drawing buffer.

If you must patch, do it early and keep the patch narrowly scoped.

### 2. Build around runtime globals intentionally

Examples:

- `window._pw_scene`
- `window._pw_renderer`
- `window.__captureGBuffer`

These globals are part of the current integration contract between `client.js` and `viewer-hooks.js`.

### 3. Wrap behaviors in named helper functions

Examples:

- `bindAssetSwitchControls()`
- `bindExportButtons()`
- `bindBoundingBoxControls()`
- `applyBoundingBoxClipping()`

Even though the file is imperative, behavior is still decomposed into named units.

---

## Data Fetching

There is no React Query/SWR/client cache library.

Current patterns are simple browser fetches and socket events:

- REST-style fetch for asset lists and generated mappings
- Socket.IO for live viewer/world interaction

Examples:

- `refreshAssetList()` fetches `/api/assets`
- `loadMcMappings()` fetches `/mc_mappings.json`
- `socket.emit('switchAsset', ...)` requests a backend asset swap

Guidelines:

- use `fetch()` for simple one-shot resource loads,
- use Socket.IO for live world/viewer interactions,
- cache only when the file is relatively static and reused repeatedly.

---

## Naming Conventions

- File-level integration scripts may use names like `viewer-hooks.js`.
- Internal helpers should be imperative verb phrases:
  - `renderAssetSelectOptions`
  - `scheduleBoundingBoxFilterUpdate`
  - `disposeErrorBlocksMesh`
- Do not create fake React hook names like `useBoundingBox` unless the architecture actually changes.

---

## Anti-Patterns

- Do not assume `hooks/` means React hooks.
- Do not create `use*` helpers that are just regular functions in plain JS.
- Do not patch global prototypes in multiple places for the same concern.
- Do not add fetch/socket behavior without matching backend support in `serve_mc.js`.

---

## Common Mistakes

1. Treating `viewer-hooks.js` as if it could use React state/effects.
2. Forgetting that `client.js` and `viewer-hooks.js` are loosely coupled through globals and sockets.
3. Adding asynchronous UI actions without visible status updates.

---

## Concrete Examples

### Example 1: hook script extending renderer lifecycle

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:4-8`

### Example 2: fetch-based hook behavior

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:106-117`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js:233-243`

### Example 3: backend-integrated live hook behavior

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:417-427`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js:470-493` in backend counterpart `serve_mc.js`
