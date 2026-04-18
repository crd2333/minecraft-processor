# Deferred Cross-Version Java Normalization TODO

This note records follow-up goals that are intentionally **out of scope for the current task**.

## Current Task Scope

The current implementation only does:

- single-version source inference for unified parsing when metadata makes that possible;
- deterministic fallback to the existing default parse version when inference is unavailable;
- feeding the selected single source version into the existing Bedrock-to-Java conversion path backed by `minecraft-data` `blocksB2J.json`.

It does **not** implement cross-version Java palette normalization.

## Explicitly Deferred Work

### 1. Java-to-Java cross-version normalization

Future work may need to remap canonical Java palette entries from one Java version to another, including:

- block renames across Java releases;
- property renames;
- property value migrations;
- split/merged block-state families;
- removals and replacements when an exact target-version state no longer exists.

### 2. Full `--norm_version` behavior

The CLI flag is reserved, but still intentionally rejects with `Not implemented`.

Future implementation should define:

- when normalization runs relative to unified parsing;
- whether normalization operates on palette entries only or also affects block/entity metadata;
- what diagnostics are emitted for lossy or unresolved migrations.

### 3. Reusable upstream-data research outcomes

Existing upstream data appears useful but incomplete for full cross-version normalization:

- `minecraft-data` already provides per-version registries and Bedrock `blocksB2J` mappings that help with **single-version** Bedrock→Java conversion;
- PrismarineJS / `minecraft-data` also expose Java version metadata such as `dataVersion` and versioned registries;
- however, they do **not** appear to provide a ready-made, complete Java block-state migration table covering arbitrary source-version → target-version normalization.

That means future normalization work will likely need a repo-owned layer that combines:

- upstream registries/version metadata,
- explicit rename tables,
- property/value migration rules,
- and clear unresolved/lossy handling policy.

### 4. Mixed-version Bedrock source handling

The current task stays intentionally focused on **single-version** inference.

If future `.mcstructure` inputs expose inconsistent palette-entry versions, follow-up work should decide:

- whether to reject mixed-version sources,
- whether to choose a dominant version,
- or whether to support per-entry conversion with diagnostics.

### 5. Verification expansion

Future work should add more targeted fixtures for:

- Java structures that need normalization across versions;
- Bedrock fixtures from multiple source versions;
- known rename/property migration edge cases;
- explicit lossy normalization scenarios.
