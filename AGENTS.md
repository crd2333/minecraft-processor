# Repository Instructions for Coding Agents

This file is the entry point for automated coding assistants and human contributors working in this repository. Project-specific engineering contracts live under `spec/`; this file defines how those contracts are discovered, applied, verified, and maintained.

## 1. Required Reading Order

Before changing code:

1. Read this file completely.
2. Read `README.md` for the supported commands and workflows.
3. Read the index for every affected layer:
   - `spec/backend/index.md` for CLI entrypoints, parsers, servers, build scripts, generated assets, and shared domain logic.
   - `spec/frontend/index.md` for the browser viewer, DOM controls, capture/export behavior, and socket contracts.
   - `spec/guides/index.md` for cross-layer implementation and review checklists.
4. Follow links from those indexes to the specific contracts relevant to the task.
5. Inspect the implementation only after loading the applicable contracts.

Do not treat an index as a substitute for its linked documents. The detailed spec files contain the implementation and validation rules.

## 2. Project Orientation

Minecraft Processor is a Node.js toolchain for parsing, normalizing, rendering, curating, and exporting Minecraft structure files.

Supported structure inputs include:

- `.schem`
- `.schematic`
- `.litematic`
- `.nbt`
- `.mcstructure`

The codebase is plain CommonJS JavaScript with focused Python utilities. The browser viewer is DOM-driven and bundled with webpack; it is not a React, Vue, or TypeScript application.

Key paths:

- `parse_mc.js`, `parse_mc_unified.js`, `serve_mc.js` - stable root entrypoints.
- `apps/cli/` - CLI and local server implementations.
- `apps/frontend/` - browser viewer, object viewer, curator, and renderer interfaces.
- `src/` - structure parsing, unified IR, Bedrock adaptation, world construction, and mesh logic.
- `scripts/` - build, conversion, rendering, curation, export, and smoke-test utilities.
- `patches/prismarine-viewer/` - local overlays applied before viewer bundles are built.
- `static/` - generated browser bundles, lookup data, and prebuilt vendor packages.
- `spec/` - maintained project engineering contracts.

## 3. Stable Contracts

Do not break these without an intentional migration plan:

- root entrypoint names and command behavior;
- native parse output, which remains source-oriented;
- unified output shape: `{ meta, size, palette, blocks, entities }`;
- unified block tuples: `[x, y, z, pid]`;
- Bedrock conversion boundaries under `src/bedrock-adapter/`;
- browser globals, routes, and Socket.IO payloads shared by the viewer and server;
- generated runtime assets under `static/`.

## 4. Development Rules

### Think before editing

- State assumptions when requirements or existing behavior are ambiguous.
- Search all references before renaming fields, routes, events, IDs, imports, or generated assets.
- Prefer the smallest change that satisfies the requirement.
- Avoid speculative abstractions, broad refactors, and unrelated formatting changes.
- Preserve user changes already present in the working tree.

### Follow repository boundaries

- Keep root command files thin; reusable parsing and conversion logic belongs in `src/`.
- Keep executable orchestration and IO boundaries in `apps/cli/` or focused scripts.
- Keep Bedrock-specific corrections isolated from source-oriented native parsing.
- Keep frontend changes compatible with browser globals and the existing webpack pipeline.
- Do not introduce React, Vue, TypeScript, a database, an ORM, or a new build system without an explicit project decision.
- Treat large voxel arrays and worker messages as performance-sensitive serializable data.

### Maintain cross-layer contracts

Update every participating layer when a change affects:

- CLI arguments and documentation;
- parser output and downstream consumers;
- browser routes, socket payloads, and server handlers;
- worker messages and both sender/receiver implementations;
- source patches, generated vendor bundles, and manifests;
- import/export formats, metadata, and smoke tests.

## 5. Spec Maintenance

The `spec/` directory is a maintained part of the project.

Update the relevant spec in the same change when implementation work introduces or changes:

- an API, payload, file format, or runtime contract;
- a repository structure or file-placement rule;
- a non-obvious implementation constraint;
- a reusable convention or validation command;
- a recurring failure mode or project-specific pitfall.

Keep specs about the current project state. Remove stale alternatives, keep paths and commands accurate, and avoid task-history narration.

## 6. Validation Requirements

Validation must match the affected surface. Baseline checks include:

```bash
git diff --check
node --check <each touched JavaScript entrypoint>
python3 -m py_compile <each touched Python entrypoint>
```

For repository-wide or parser/viewer changes, run the applicable smoke checks:

```bash
npm run build
npm test
npm run test:mesh-export
npm run test:pointcloud
npm run test:voxels
npm run test:realistic-image-api
```

Use targeted tests during iteration and a full affected-scope pass before completion. If a check cannot run, report the exact limitation.

## 7. Completion and Commit Rules

Before committing:

1. Review the full diff and confirm every changed line belongs to the requested work.
2. Run the required code and spec checks.
3. Review whether durable knowledge must be reflected in `spec/`.
4. Confirm staged files are intentional.

Commit coherent functional changes with meaningful messages such as `feat:`, `fix:`, `perf:`, `refactor:`, or `docs(spec):`. Do not commit task records, agent session logs, local editor state, or generated workflow harness metadata.
