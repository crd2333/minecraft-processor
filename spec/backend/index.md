# Backend Development Guidelines

> Project-specific backend guidance for the Node.js CLI/server side of minecraft-processor.

---

## Overview

In this repository, “backend” means:

- root entrypoint wrappers,
- runtime implementations under `apps/cli/`,
- shared parsing / normalization / world-building logic under `src/`,
- runtime/static data under `static/`,
- build/generation scripts under `scripts/`.

This is **not** a typical controller/service/database application.
Most backend work in this repo is about:

- parsing files,
- normalizing data contracts,
- preparing runtime assets,
- wiring the local viewer server.

---

## Read This First

Before changing backend code, read `README.md`, this index, and the task-relevant guides below.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Directory Structure](./directory-structure.md) | Module boundaries and file layout | Filled |
| [Database Guidelines](./database-guidelines.md) | What persistent data exists, and what does not | Filled |
| [Error Handling](./error-handling.md) | Error propagation and CLI/server responses | Filled |
| [Quality Guidelines](./quality-guidelines.md) | Review standards and refactor guardrails | Filled |
| [Logging Guidelines](./logging-guidelines.md) | Console logging conventions and limits | Filled |

---

## Backend Reality Check

Patterns that actually matter in this repo:

- CommonJS modules, not ESM.
- Plain JavaScript, not TypeScript.
- Stable file/data contracts matter more than architectural ceremony.
- `apps/cli/` owns executable orchestration.
- `src/` owns reusable domain logic.
- `serve_mc.js` is a local viewer runtime, not a general-purpose web backend.
- Generated JSON/runtime assets are files, not database tables.

---

## Stable Public Contracts

Do not break without an intentional migration plan:

- root wrappers: `parse_mc.js`, `parse_mc_unified.js`, `serve_mc.js`
- native output: `{ format, schema, parser, data }`
- unified output: `{ meta, size, palette, blocks, entities }`
- runtime directory: `static/`

---

## Fast routing for backend tasks

Use this routing summary:

- native parse → `src/structure_parser.js`
- unified mapping → `src/unified_parser.js`
- Bedrock conversion → `src/bedrock-adapter/`
- viewer server → `apps/cli/serve_mc.js`
- world placement → `src/world_builder.js`
- headless structure mesh / SuperDec point clouds → `src/structure_mesh.js`,
  `scripts/export_structure_mesh.js`, `scripts/sample_structure_pointcloud.py`
- asset generation → `scripts/`, `static/`

---

## Examples To Copy From

- thin CLI + shared logic:
  - `apps/cli/parse_mc.js`
  - `apps/cli/parse_mc_unified.js`
- native parse helpers:
  - `src/structure_parser.js`
- canonical unified IR logic:
  - `src/unified_parser.js`
- world materialization logic:
  - `src/world_builder.js`
- focused adapter modules:
  - `src/bedrock-adapter/convertBlocks.js`
  - `src/bedrock-adapter/postProcess.js`

---

**Language**: All documentation should be written in **English**.
