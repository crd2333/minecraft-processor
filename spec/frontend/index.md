# Frontend Development Guidelines

> Project-specific frontend guidance for the browser viewer in minecraft-processor.

---

## Overview

This frontend is **not** a React/Vue/TypeScript SPA.

It is a small browser runtime built from:

- `apps/frontend/viewer/public/viewer.html`
- `apps/frontend/viewer/src/client.js`
- `apps/frontend/viewer/src/preload/viewer-preload.js`
- `apps/frontend/viewer/src/hooks/viewer-hooks.js`

The UI is DOM-driven, depends on browser globals, and integrates directly with Three.js, Socket.IO, and a locally modified Prismarine viewer runtime.

Avoid “upgrading” it to generic modern frontend patterns unless the task explicitly requires a broader rewrite.

---

## Read This First

Before changing frontend code, read:

1. `apps/frontend/viewer/public/viewer.html`
2. `apps/frontend/viewer/src/client.js`
3. `apps/frontend/viewer/src/hooks/viewer-hooks.js`
4. `apps/frontend/viewer/src/preload/viewer-preload.js`
5. `apps/cli/serve_mc.js`
6. `webpack.config.js`

Why `serve_mc.js` is in the list:

- route names are defined there,
- Socket.IO payloads are defined there,
- `/mc_mappings.json` static serving and `/api/assets` behavior is defined there,
- frontend correctness often depends on backend/frontend contract alignment.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Viewer file layout and boundaries | Filled |
| [Component Guidelines](./component-guidelines.md) | DOM/UI composition patterns | Filled |
| [Hook Guidelines](./hook-guidelines.md) | Project-specific meaning of “hooks” | Filled |
| [State Management](./state-management.md) | State placement across globals, DOM, and sockets | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Review and verification standards | Filled |
| [Type Safety](./type-safety.md) | Runtime shape discipline in plain JS | Filled |

---

## Frontend Reality Check

Important truths for this codebase:

- browser source is bundled by webpack,
- `window` globals are part of the design,
- “hooks” means integration behavior files, not React hooks,
- UI is assembled with DOM APIs and string HTML templates,
- styling mostly lives in `viewer.html`,
- export and capture behavior is tightly coupled to the viewer runtime.

---

## Stable Browser Contracts

Be careful with these internal contracts:

- globals exposed by `client.js`, such as:
  - `window._pw_renderer`
  - `window._pw_viewer`
  - `window._pw_worldRenderer`
  - `window.__captureScreenshot`
  - `window.__captureGBuffer`
- socket events exchanged with `serve_mc.js`
- route names served by the backend:
  - `/viewer-preload.js`
  - `/viewer-hooks.js`
  - `/mc_mappings.json`
  - `/api/assets`

---

## Fast routing for frontend tasks

- viewer bootstrap / socket behavior -> `apps/frontend/viewer/src/client.js`
- panel UI / export / bounding-box controls -> `apps/frontend/viewer/src/hooks/viewer-hooks.js`
- early browser patching -> `apps/frontend/viewer/src/preload/viewer-preload.js`
- shell markup / CSS / script order -> `apps/frontend/viewer/public/viewer.html`
- route or payload mismatch -> also inspect `apps/cli/serve_mc.js`

---

## Examples To Copy From

- viewer bootstrap and socket wiring:
  - `apps/frontend/viewer/src/client.js`
- DOM control panel and export flows:
  - `apps/frontend/viewer/src/hooks/viewer-hooks.js`
- minimal HTML shell and CSS:
  - `apps/frontend/viewer/public/viewer.html`
- browser environment patching:
  - `apps/frontend/viewer/src/preload/viewer-preload.js`

---

**Language**: All documentation should be written in **English**.
