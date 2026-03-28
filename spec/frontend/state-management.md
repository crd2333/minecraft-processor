# State Management

> How state is managed in this project.

---

## Overview

There is no Redux/Zustand/MobX/React state library here.

State is currently split across:

- local function/module variables,
- DOM control values,
- `window` globals shared between scripts,
- server-driven socket state,
- transient fetched data caches.

This is acceptable for the current lightweight viewer, but state placement must remain intentional.

---

## State Categories

### 1. Viewer-global runtime state

Used when multiple scripts need access.

Examples:

- `window._pw_renderer`
- `window._pw_viewer`
- `window._pw_worldMaterial`
- `window._pw_worldRenderer`
- `window._pw_scene`

These are set in `client.js` and consumed in `viewer-hooks.js`.

### 2. Module-local UI state

Used for panel behavior internal to `viewer-hooks.js`.

Examples:

- `currentAssetPath`
- `availableAssets`
- `assetSwitchBusy`
- `currentBoundingBox`
- `axisVisible`

### 3. DOM-backed state

Used when the source of truth naturally lives in form controls.

Examples:

- `gbuffer-square`
- `gbuffer-size`
- `bbox-origin-x`
- `bbox-hide-outside`

### 4. Server-driven state

Comes from Socket.IO or fetch responses.

Examples:

- socket `version`, `loadChunk`, `position`, `boundingBox`, `assetInfo`
- `/api/assets`
- `/mc_mappings.json`

---

## When to Use Global State

Use `window` globals only when state truly crosses script boundaries.

Good uses in this project:

- exposing renderer/viewer objects from `client.js`
- exposing capture APIs used by hook/UI code

Avoid new globals when:

- the value is only needed inside one file,
- it can be passed as a function argument,
- it only mirrors DOM state unnecessarily.

---

## Server State

Server state is lightweight and mostly event-driven.

Patterns:

- fetch once and cache if the resource is stable (`cachedMcMappings`)
- keep world/view position synchronized through socket events
- do not attempt heavyweight client-side normalization if the server already owns the truth

Examples:

- `refreshAssetList()` updates asset selection state from `/api/assets`
- `cachedMcMappings` memoizes `/mc_mappings.json`
- `socket.on('loadChunk' ...)` in `client.js` updates the renderer directly

---

## Derived State

Derived state is usually computed with helper functions rather than stored permanently.

Examples:

- `resolveCaptureSize(options)`
- `filterErrorPositionsByBoundingBox(positions, boundingBox)`
- `isPositionInsideBoundingBox(position, boundingBox)`

Prefer recomputing cheap derived values over creating extra mutable state.

---

## Anti-Patterns

- Do not introduce a global state library for isolated viewer controls.
- Do not duplicate the same state in globals, module vars, and DOM when one source of truth is enough.
- Do not store derived values unless recomputation is expensive or error-prone.
- Do not let frontend state drift away from backend socket contracts.

---

## Common Mistakes

1. Creating new globals for values only one helper needs.
2. Forgetting to synchronize UI state after backend-driven updates.
3. Storing both relative and absolute values without clear recomputation rules.

---

## Concrete Examples

### Example 1: explicit viewer-wide globals

- `apps/frontend/viewer/src/client.js:60-65`

### Example 2: focused module-local UI state

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:61-64`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js:382-394`

### Example 3: derived state instead of duplicated storage

- `apps/frontend/viewer/src/client.js:200-208`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js:444-459`
