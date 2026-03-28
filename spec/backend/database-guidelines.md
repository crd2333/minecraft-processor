# Database Guidelines

> Database-related conventions for this project.

---

## Overview

This repository currently has **no database**, **no ORM**, and **no migration system**.

That is important enough to document explicitly because generic tooling assumptions may otherwise invent:

- models,
- repositories,
- migrations,
- persistence layers,
- caches backed by SQLite/Postgres.

Do **not** introduce those patterns unless the task explicitly requires a new persistence system.

Instead, this codebase uses:

- input structure files supplied by the user
- built browser assets and static lookup JSON under `static/`

These are files, not database tables.

---

## Runtime Data Patterns

### File-based inputs

CLI commands read structure files directly from disk.

Examples:

- `apps/cli/parse_mc.js`
- `apps/cli/parse_mc_unified.js`
- `apps/cli/serve_mc.js`

### Generated lookup data

Vocabulary and mapping data is stored as static JSON files.

Examples:

- `parse_mc_unified.js` can read `static/mc_mappings.json` for `--solid_color` palette enrichment.

### In-memory processing

Most “data access” is in-memory transformation after file read:

- parse a binary/NBT file
- normalize it to a native envelope or unified `{ meta, size, palette, blocks, entities }`
- optionally validate against vocabulary assets for diagnostics
- optionally materialize a world for rendering

---

## Query Patterns

There are no SQL or ORM query patterns.

Equivalent project patterns are:

1. read file content once,
2. validate/normalize into a predictable shape,
3. derive compact runtime structures,
4. avoid repeated ad hoc transformation logic across entrypoints.

Good examples:

- `loadNativeStructure()` in `src/structure_parser.js`
- `loadUnifiedStructure()` in `src/unified_parser.js`

---

## Migrations

There are no database migrations.

The nearest equivalent is **generated-data versioning**:

- asset generation through scripts such as `scripts/generate-assets.js`

If generated data format changes:

1. update validation logic,
2. preserve backward compatibility if practical,
3. regenerate artifacts,
4. document the contract change in README/specs.

---

## Naming Conventions

For file-backed runtime data:

- put browser-served static lookup data in `static/`
- use descriptive artifact names such as:
  - `blocksB2J.json`
  - `static/mc_mappings.json`
- expose version/schema markers inside JSON where needed

Examples:

- unified CLI contract lives in `parse_mc_unified.js`; generated data assets are separate runtime data, not required positional inputs.

---

## Anti-Patterns

- Do not add a fake repository layer over plain JSON files just to look “architected”.
- Do not store mutable app state in `static/`; it is runtime lookup/build data.
- Do not hand-edit generated artifacts if a script should own them.
- Do not hide file reads/writes behind generic “database” terminology in docs or code.

---

## Common Mistakes

1. Treating generated JSON as if it were source code.
2. Adding duplicated parsing/validation in CLI files instead of reusing `src/` helpers.
3. Proposing ORM/migration patterns that do not fit this repository’s current architecture.
