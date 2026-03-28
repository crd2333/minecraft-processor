# Component Guidelines

> How UI pieces are built in this project.

---

## Overview

There are no framework components with props/state lifecycles here.
The project’s equivalent of “components” is **DOM sections created and managed imperatively**.

The main example is the export/control panel assembled in `viewer-hooks.js`.

When adding UI, prefer extending the existing panel and helper functions instead of introducing a new frontend framework.

---

## Component Structure

The common pattern is:

1. create or locate a DOM container,
2. fill it with stable IDs/classes,
3. append to `document.body`,
4. bind listeners with focused helper functions,
5. keep update/render helpers separate from event wiring.

Example:

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:10-52` creates the panel markup.
- `bindAssetSwitchControls()`, `bindExportButtons()`, and `bindBoundingBoxControls()` attach behavior.

This is the current project’s substitute for component composition.

---

## Props Conventions

There are no props in the React sense.

Equivalent patterns are:

- function arguments
- shared closure state
- browser globals
- DOM IDs/values

Guidelines:

- pass explicit arguments into helper functions when possible,
- use shared module variables only for viewer-wide state,
- keep DOM IDs stable because other functions depend on them directly.

Examples:

- `setStatus(message)` accepts a plain argument and updates one DOM target.
- `downloadBlob(blob, filename)` is a focused reusable UI utility.
- `renderAssetSelectOptions()` reads `availableAssets` and `currentAssetPath` from closure state.

---

## Styling Patterns

Styling is currently inline in `viewer.html` inside a `<style>` block.

Use the existing pattern unless a task explicitly introduces a different build/setup path.

Guidelines:

- keep panel styling in `viewer.html`
- use semantic IDs/classes already present in generated markup
- avoid inline style mutation unless it is dynamic and state-driven

Examples:

- static panel layout styles: `viewer.html:10-82`
- dynamic overlay style setup: `viewer-hooks.js:299-309` for the square guide

---

## Accessibility

This viewer is tool-oriented, but basic semantics still matter.

Current patterns worth preserving:

- real `<button>` elements for actions
- real `<label>` wrappers for checkboxes/inputs
- visible text labels for numeric controls

Examples:

- `viewer-hooks.js` panel HTML uses `<button>`, `<select>`, and `<label>` elements.
- bounding-box fields are labeled by axis and size in the generated markup.

When adding controls:

- prefer native form controls,
- keep text labels visible,
- avoid clickable `div`s pretending to be buttons.

---

## Anti-Patterns

- Do not introduce JSX/React components into this viewer without an intentional architecture change.
- Do not scatter UI creation across unrelated files when the panel is the main control surface.
- Do not use anonymous magic selectors if a stable `id` is more maintainable.
- Do not rely on CSS-only hidden state when the real source of truth is JS state.

---

## Common Mistakes

1. Treating `viewer-hooks.js` as React-like hooks code.
2. Adding UI that bypasses existing status messaging (`setStatus`) and leaves users without feedback.
3. Forgetting that many controls depend on backend socket events and browser globals, not local DOM only.

---

## Concrete Examples

### Example 1: large but coherent control panel component

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:10-52`

### Example 2: reusable action utility

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:161-172` (`downloadBlob`)

### Example 3: dynamic visual component built imperatively

- `apps/frontend/viewer/src/hooks/viewer-hooks.js:285-315` (GBuffer square guide)
