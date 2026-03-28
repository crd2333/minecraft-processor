# Quality Guidelines

> Code quality standards for backend development.

---

## Overview

This codebase values:

- stable CLI/data contracts,
- focused shared modules,
- explicit normalization steps,
- readable plain JavaScript,
- low ceremony over abstract architecture.

Because the repo is a tooling pipeline, correctness of payloads and runtime assets matters more than introducing patterns borrowed from CRUD applications.

---

## Forbidden Patterns

### 1. Breaking stable entrypoints

Do not rename or repurpose:

- `parse_mc.js`
- `parse_mc_unified.js`
- `serve_mc.js`

### 2. Re-duplicating parsing logic across CLIs

If logic is needed by more than one command, keep it in `src/`.

Bad:

- duplicating format detection or file-interpretation logic in multiple CLI files

Good:

- reuse `detectStructureFormat()` and `loadNativeStructure()` from `src/structure_parser.js`
- reuse `loadUnifiedStructure()` from `src/unified_parser.js`

### 3. Generic dumping-ground utility files

Avoid `utils.js`, `helpers.js`, or `misc.js` when the code belongs to a clear domain module.

### 4. Over-abstraction without repeated need

Do not invent service/repository/factory layers unless multiple call sites justify them.

### 5. Silent contract changes

Do not change normalized payload fields, tuple ordering, or generated schema versions without updating docs and dependent code.

---

## Required Patterns

### 1. Keep IO boundaries explicit

CLI files should make reads/writes obvious.

Examples:

- `apps/cli/parse_mc.js`
- `apps/cli/parse_mc_unified.js`

### 2. Centralize domain rules

Examples:

- native parsing helpers in `src/structure_parser.js`
- unified contract shaping in `src/unified_parser.js`
- Bedrock conversion in `src/bedrock-adapter/convertBlocks.js`

### 3. Use descriptive small helpers inside large modules

Large files are acceptable in this repo when they represent one dense domain, but they should still be internally decomposed.

Examples from current code:

- `src/structure_parser.js`: format detection, NBT probing, format-specific parse helpers
- `src/unified_parser.js`: palette accumulation, canonicalization, per-format unified loaders
- `src/bedrock-adapter/postProcess.js`: context-derived block-state correction helpers

### 4. Preserve compatibility where it is already part of the contract

Examples:

- root entrypoint filenames remain stable
- native parse output remains distinct from unified output
- unified block tuples stay `[x, y, z, pid]`

### 5. Treat NBT auto-detection as a probe, not a final contract

`prismarine-nbt.parse(buffer)` can reject large big-endian Java NBT arrays under its default array-size guard, then auto-detect another format and return an empty compound. Do not treat an empty auto-detected parse as authoritative when parsing structure files.

For shared NBT parsing in `src/structure_parser.js`, keep a fallback that can explicitly parse big-endian Java NBT with `noArraySizeCheck` after normal probes fail or return no tags. This is required for large Sponge v3 `.schem` files whose `Blocks.Data` byte arrays exceed the default guard.

Good:

```js
const parsed = await nbt.parseAs(buffer, 'big', { noArraySizeCheck: true })
```

Bad:

```js
const { parsed } = await nbt.parse(buffer)
return nbt.simplify(parsed)
```

Regression tests for parser changes should include a synthetic large byteArray case so the behavior is covered without committing multi-megabyte fixtures.

---

## Verification Requirements

There is currently no mature backend unit/integration suite checked in.
Until one exists, changes should be verified with command-level smoke tests.

Minimum verification for backend changes:

1. run `npm run build` if asset/runtime behavior could be affected,
2. run `npm test`,
3. run the relevant CLI command(s) manually,
4. verify output contract shape and important counts,
5. for viewer changes, start `node serve_mc.js ...` and exercise the relevant path.

Suggested smoke commands:

```bash
npm run build
npm test
node parse_mc.js assets/<file> --stdout --pretty
node parse_mc_unified.js assets/<file> --target-version 1.21.8 --stdout --pretty
node serve_mc.js assets/<file> --version 1.21.8 --port 3000
```

Note: at the moment, `npm test`, `npm run lint`, and `npm run type-check` all point at the same smoke script. Do not describe them as separate mature systems unless the codebase actually adds them later.

---

## Code Review Checklist

- Does the change preserve root entrypoint behavior?
- Is reusable logic in `src/` instead of copied into CLI files?
- Are native and unified payload contracts preserved?
- Are Bedrock-specific rules still isolated to adapter modules?
- Are errors descriptive and surfaced at the correct boundary?
- If generated data or runtime asset expectations changed, were scripts/docs updated too?

---

## Concrete Examples

### Example 1: thin wrapper + shared parser

- `apps/cli/parse_mc.js`
- `src/structure_parser.js`

### Example 2: dedicated unified contract logic

- `apps/cli/parse_mc_unified.js`
- `src/unified_parser.js`

### Example 3: isolated Bedrock post-processing domain

- `src/bedrock-adapter/postProcess.js`

This file is long, but still coherent because it is entirely about context-aware Bedrock corrections.
