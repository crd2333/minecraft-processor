# Type Safety

> Type safety patterns in this project.

---

## Overview

This frontend uses **plain JavaScript**, not TypeScript.

Type safety therefore comes from:

- explicit runtime checks,
- stable object shapes,
- careful naming,
- narrow helper functions,
- defensive parsing of DOM/network values.

Do not write TypeScript-oriented guidance here unless the project actually adopts TS.

---

## Type Organization

There are no standalone `.d.ts` or shared TS type modules.

Current shape conventions live in code through:

- helper functions that normalize values,
- implicit contracts between backend and frontend,
- comments/docstrings where necessary.

Examples:

- capture API return shapes in `client.js`
- socket payload shapes in `client.js` and `serve_mc.js`
- bounding-box config shape in `viewer-hooks.js`

For future refactors, if introducing stronger typing incrementally, start with JSDoc and contract docs before a full TS migration.

---

## Validation

There is no Zod/Yup/io-ts layer.

Current runtime validation patterns include:

- `Number(...)` coercion with `Number.isFinite` checks
- null/shape guards before use
- response `.ok` checks for fetch calls
- fallback defaults when optional fields are missing

Examples:

- `resolveCaptureSize()` in `client.js:200-208`
- `getInputNumber()` in `viewer-hooks.js:471-476`
- `cloneBoundingBoxConfig()` in `viewer-hooks.js:429-442`
- `refreshAssetList()` in `viewer-hooks.js:106-117`

---

## Common Patterns

### 1. Normalize inputs immediately

Examples:

- size clamping in `resolveCaptureSize()`
- checkbox/number normalization in bounding-box handlers

### 2. Guard optional globals/features

Examples:

- `if (!window.__captureScreenshot) ...`
- `if (!socket) ...`
- `if (!window._pw_scene) ...`

### 3. Use helper functions as shape boundaries

Examples:

- `quoteArg(value)`
- `isPositionInsideBoundingBox(position, boundingBox)`
- `filterErrorPositionsByBoundingBox(...)`

---

## Forbidden Patterns

- Do not assume fetched JSON has the correct shape without checking.
- Do not rely on unchecked string values from inputs when numeric bounds matter.
- Do not add TS-like pseudo-typing comments that are not enforced and contradict runtime behavior.
- Do not widen function responsibilities so far that input/output shapes become unclear.

---

## Common Mistakes

1. Treating DOM input values as numbers without coercion.
2. Assuming globals are initialized before script ordering guarantees it.
3. Forgetting that backend and frontend payloads must stay in sync even without compile-time types.

---

## Concrete Examples

### Example 1: guarded numeric normalization

- `apps/frontend/viewer/src/client.js:200-208`

### Example 2: defensive fetch handling

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:106-117`

### Example 3: object-shape normalization helper

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:429-442`
