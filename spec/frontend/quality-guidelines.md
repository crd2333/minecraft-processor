# Quality Guidelines

> Code quality standards for frontend development.

---

## Overview

Frontend quality in this repository means:

- preserving viewer boot order,
- maintaining backend/frontend contract alignment,
- keeping DOM-driven UI readable,
- avoiding unnecessary framework abstractions,
- verifying real browser behavior, not just static code shape.

---

## Forbidden Patterns

### 1. Framework cargo-culting

Do not add React-style components/hooks/state libraries unless the task is an intentional frontend rewrite.

### 2. Breaking browser-global contracts casually

Do not rename/remove:

- `window._pw_*` globals
- `window.__capture*` helpers
- DOM IDs used by binding code
- socket event names shared with `serve_mc.js`

### 3. Moving CSS/HTML concerns into overcomplicated JS abstractions

For this viewer, simple HTML + inline CSS is the established pattern.

### 4. Silent backend/frontend drift

Do not change fetch routes or socket payload shapes in one side only.

---

## Required Patterns

### 1. Keep script responsibilities separated

- `viewer.html` = shell/styles/load order
- `client.js` = viewer bootstrap/capture/socket listeners
- `viewer-hooks.js` = UI controls and overlays
- `viewer-preload.js` = early browser patching

### 2. Provide user feedback for long/async actions

Use `setStatus(...)` or equivalent when actions may fail or take time.

Examples:

- asset switching
- screenshot capture
- gbuffer rendering
- mapping load failures

### 3. Use focused helper functions even in imperative code

Examples:

- `downloadBlob`
- `refreshAssetList`
- `updateBoundingBoxFromControls`
- `resolveCaptureSize`

---

## Testing Requirements

There is no mature automated frontend test suite currently in the repo.
Frontend verification is manual/runtime-oriented.

Minimum verification for frontend changes:

1. run `npm run build`
2. start the viewer with a real asset
3. load the page in a browser
4. exercise the changed control path end-to-end
5. confirm no console/runtime errors for the scenario

Suggested manual checks:

- viewer loads and renders structure
- socket-driven asset switching still works
- screenshot/export buttons still download expected files
- bounding-box controls update overlays and filtering correctly
- GBuffer export still succeeds

---

## Code Review Checklist

- Does the script load order in `viewer.html` still make sense?
- Does the change preserve existing globals used across scripts?
- Are new controls wired with stable IDs and clear status messages?
- Does the change require matching backend updates in `serve_mc.js`?
- Are browser-only concerns kept out of backend modules?
- Was `npm run build` run after bundling/runtime changes?

---

## Accessibility

This is a tooling UI, but reviewers should still check:

- native buttons/labels/selects are used,
- controls remain readable over the viewer,
- status feedback is visible,
- numeric inputs are labeled.

---

## Concrete Examples

### Example 1: async action with user feedback

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:141-153`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js:322-351`

### Example 2: clear bootstrap/runtime separation

- `apps/frontend/viewer/src/client.js`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js`

### Example 3: HTML/CSS shell kept simple

- `apps/frontend/viewer/public/viewer.html`
