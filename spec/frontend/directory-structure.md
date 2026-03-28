# Directory Structure

> How frontend code is organized in this project.

---

## Overview

Frontend code is organized by viewer runtime role:

- HTML shell in `public/`
- main WebGL/socket bootstrap in `src/client.js`
- browser environment patching in `src/preload/`
- UI/control behavior in `src/hooks/`

This is intentionally smaller and flatter than a component-driven app.

---

## Directory Layout

```text
apps/frontend/viewer/
├── public/
│   └── viewer.html               # HTML shell + CSS
└── src/
    ├── client.js                 # renderer bootstrap + socket listeners + capture APIs
    ├── preload/
    │   └── viewer-preload.js     # canvas/WebGL setup patching
    └── hooks/
        └── viewer-hooks.js       # control panel UI + export/bbox interactions

apps/frontend/obj-viewer/
├── public/
│   └── obj-viewer.html           # OBJ viewer shell + CSS
└── src/
    └── client.js                 # mesh viewer bootstrap + screenshot capture

apps/frontend/shared/
└── pixal3d-metadata.js           # shared screenshot/camera metadata builder

static/                           # webpack output consumed by the browser
```

---

## Module Organization

### `viewer.html`

Owns:

- document shell
- inline CSS
- script load order

It should stay lightweight and declarative.

### `client.js`

Owns:

- Three.js renderer/camera/viewer bootstrap
- Socket.IO event listeners for world state
- browser-global capture helpers such as screenshot and GBuffer APIs
- exposing renderer/viewer globals consumed by `viewer-hooks.js`

### `preload/viewer-preload.js`

Owns:

- browser monkey-patching needed before other scripts run
- drawing-buffer/canvas capture preparation

### `hooks/viewer-hooks.js`

Owns:

- injected DOM panel
- control binding
- export button behavior
- asset switching UI
- bounding-box UI state and scene overlays

If a feature is mostly UI interaction on top of the existing viewer, it probably belongs here.

---

## Naming Conventions

- Keep existing lowercase hyphen/underscore style filenames:
  - `viewer-hooks.js`
  - `viewer-preload.js`
  - `client.js`
- Name globals with the existing `window._pw_*` or `window.__capture*` conventions.
- Prefer descriptive DOM IDs because the UI is queried directly:
  - `btn-render-gbuffer`
  - `bbox-origin-x`
  - `asset-select`

---

## Refactor Routing Rules

When adding code during a refactor:

- new backend-fed socket event handling -> `client.js`
- new control panel widget/behavior -> `viewer-hooks.js`
- new global browser setup patch -> `preload/viewer-preload.js`
- new static layout/style tweaks -> `viewer.html`
- new frontend/backend contract -> update both frontend files and `apps/cli/serve_mc.js`
- capture metadata shared by multiple viewer runtimes -> `apps/frontend/shared/`

Avoid moving everything into a framework-style folder structure unless the whole viewer architecture is intentionally being replaced.

## Shared Capture Metadata

`apps/frontend/shared/pixal3d-metadata.js` owns the Pixal3D camera JSON contract used by both the chunk viewer and the Mineways OBJ viewer.

Required output contract:

- `format: "minecraft-pixal3d-transform"`
- `modes.rotate_voxels_frontview`
- `modes.rotate_camera_unrotated_voxels`
- source fields including `coordinate_space`, `block_point`, `origin_world`, `size`, and `pivot_world`

Do not copy this builder into a second viewer runtime. If a viewer needs screenshot camera JSON, pass that viewer's Three.js camera and export context into the shared builder.

---

## Anti-Patterns

- Do not create React-style `components/` or hook abstractions just because template docs mention them.
- Do not hide script ordering dependencies by moving load-critical code into arbitrary files.
- Do not put backend route/socket contracts only in frontend comments; keep them aligned with `serve_mc.js`.

---

## Examples

### Example 1: clear split between shell and runtime

- `apps/frontend/viewer/public/viewer.html`
- `apps/frontend/viewer/src/client.js`

### Example 2: preload isolated from main runtime

- `apps/frontend/viewer/src/preload/viewer-preload.js`

### Example 3: UI logic isolated from renderer bootstrap

- `apps/frontend/viewer/src/hooks/viewer-hooks.js`

This file is large, but it is the correct place for export-panel controls, asset switching, and bounding-box interactions because those are UI-layer concerns.
