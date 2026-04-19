# Unified Parsing, Vocabulary, and ML Roadmap TODO

This document records the broader roadmap discussed in the current planning session.
It intentionally mixes **current parser behavior**, **near-term engineering TODOs**, and **longer-term ML/data-pipeline goals** so future work can resume from a single source of truth.

---

## 1. Current Implemented Behavior

### 1.1 Unified parse version selection

`parse_mc_unified.js` now uses deterministic parse-version selection:

1. If the user passes `--version`, use it as an explicit override.
2. Otherwise, try to infer the source version from file metadata.
3. If inference is unavailable, fall back to default parse version `1.21.8`.

### 1.2 Format-specific version inference

Current inference behavior:

- `.schem` / `.schematic`
  - infer from `DataVersion` when accessible;
  - otherwise fall back.
- `.litematic`
  - infer from `MinecraftDataVersion` when present.
- Java `.nbt`
  - infer from `DataVersion` when present.
- `.mcstructure`
  - inspect `structure.palette.default.block_palette[*].version`;
  - if all normalized palette versions agree, use that single Bedrock source version;
  - if palette versions are mixed, choose the **most frequent normalized version** and emit a warning;
  - if no usable version can be inferred, fall back to default parse version `1.21.8`.

### 1.3 Bedrock single-version conversion

For Bedrock `.mcstructure`, the selected source version is fed into the existing Bedrock→Java conversion path backed by `minecraft-data` `blocksB2J.json`.

This means current Bedrock handling is intentionally still **single-version-oriented**, even when mixed palette versions exist: mixed-version inputs currently collapse to the dominant normalized source version and log a warning instead of doing per-entry multi-version conversion.

### 1.4 Reserved normalization flag

`parse_mc_unified.js` now accepts:

- `--norm_version <mc-version>`

The flag is intentionally reserved for future work and currently fails with a descriptive `Not implemented` error.

---

## 2. Project-Level End Goal

The long-term goal of this repository is not only structure parsing and rendering, but also building a large-scale **ML / DL-ready Minecraft structure dataset**.

That implies the pipeline should eventually support:

1. parsing many Minecraft structure formats from assets found in the wild;
2. converting them into a unified intermediate representation;
3. canonicalizing them across versions sufficiently for downstream learning;
4. exporting them into vocabulary-aligned tensor-friendly forms for ML training.

At the dataset level, the immediate priority is the block domain:

- `palette`
- `blocks`

`entities` are currently out of scope for ML preparation.

---

## 3. Confirmed ML Representation Direction

### 3.1 Unified source structure for ML export

The current unified parse output remains the stable intermediate contract:

```json
{
  "meta": { "...": "metadata" },
  "size": [x, y, z],
  "palette": [{ "name": "minecraft:stone", "props": {} }],
  "blocks": [[x, y, z, pid]],
  "entities": []
}
```

For ML preparation:

- `blocks` are sparse placements of `(x, y, z, palette_id)`;
- semantic content lives in `palette`;
- downstream export should therefore encode palette entries first, then let blocks reference encoded palette rows.

### 3.2 Chosen two-level vocabulary design

The current intended ML vocabulary design is:

1. **block-level vocabulary**
   - token unit: block name only, e.g. `minecraft:oak_stairs`
   - handled with `nn.Embedding`

2. **prop-level vocabulary**
   - token unit: each `key=value` pair as one entry, e.g.:
     - `facing=down`
     - `waterlogged=true`
     - `half=top`
   - handled with `nn.EmbeddingBag`

### 3.3 Chosen embedding composition rule

For a palette entry:

- if a block has properties, embed all `key=value` prop tokens and sum them;
- if a block has no properties, use a reserved pad entry for prop-level embedding.

Target formula:

```text
E_total = E_name(id_name) + sum_i E_prop(id_prop_i)
```

This is the currently preferred design because it lets the model share property semantics across many different blocks. For example, repeated exposure to `open=true` across doors and trapdoors may help the model learn that the property implies a collision-box / spatial-geometry change, even for less-frequent materials.

---

## 4. Deferred Cross-Version Normalization Work

This is still deferred because it is substantially harder than single-version parsing.

### 4.1 Java-to-Java cross-version normalization

Future work may need to remap canonical Java palette entries from one Java version to another, including:

- block renames across Java releases;
- property renames;
- property value migrations;
- split/merged block-state families;
- removals and replacements when an exact target-version state no longer exists.

### 4.2 Scope expectation for normalization

The intended normalization target for future dataset work is a **cross-version canonical vocabulary anchored to Java 1.21.8**.

However, current implementation does **not** yet normalize Java source palettes into 1.21.8 canonical names/props.

### 4.3 `--norm_version` future goal

The reserved `--norm_version` flag is expected to eventually perform palette normalization before JSON output is written.

Future implementation needs to define:

- when normalization runs relative to unified parsing;
- whether normalization touches only palette entries or also other metadata;
- what diagnostics are emitted for lossy or unresolved migrations;
- whether normalized output records both original source version and normalization target version.

---

## 5. Upstream Asset / Ecosystem Research Notes

Existing PrismarineJS / `minecraft-data` assets appear useful, but incomplete for full Java cross-version normalization.

### 5.1 Useful existing pieces

- `minecraft-data` provides:
  - per-version registries;
  - Java `dataVersion` metadata;
  - Bedrock `blocksB2J.json` / `blocksJ2B.json` mappings;
  - legacy Java pre-flattening mapping data such as `pc/common/legacy.json`.
- `prismarine-schematic` helps infer/parse schematic data with version awareness.
- `prismarine-block` helps validate and reconstruct block states inside a chosen version registry.

### 5.2 Missing upstream capability

What does **not** appear to exist upstream as a ready-made solution:

- a complete Java version A → Java version B block/state migration table;
- a direct API for normalizing an arbitrary old Java palette into Java `1.21.8`;
- a generalized packaged rule set for Java block/property rename migration across modern releases.

### 5.3 Consequence for future work

Future normalization will likely require a repo-owned layer that combines:

- upstream registries/version metadata,
- explicit rename tables,
- property/value migration rules,
- and unresolved/lossy handling policy.

---

## 6. Vocabulary Generation TODO

This was discussed and intentionally postponed for later implementation.

### 6.1 Fixed target vocabulary version

The target vocabulary should be fixed to **Java 1.21.8**.

### 6.2 Planned generated file

A future generate script should produce something like:

- `block_prop_vocab_1.21.8.json`

Expected contents include at least:

- target version metadata;
- block-name vocabulary;
- prop `key=value` vocabulary;
- special entries such as pad/unknown if needed;
- possibly counts/statistics for debugging and reproducibility.

### 6.3 Vocabulary generation precondition

Meaningful cross-version vocabulary generation depends on at least one of:

1. robust source-version normalization into 1.21.8;
2. or a deliberately limited single-version-only export mode.

---

## 7. Python-Side Conversion Helper TODO

This was also explicitly discussed but deferred.

### 7.1 Intended responsibility split

JavaScript / Node side should own:

- structure parsing;
- unified IR generation;
- version inference;
- future normalization;
- future vocabulary generation.

Python side should own:

- subprocess invocation of `parse_mc_unified.js`;
- loading the fixed `block_prop_vocab_1.21.8.json`;
- mapping each palette entry into:
  - `block_name_id`
  - `prop_ids[]`
- reusing `blocks` as references into encoded palette rows.

### 7.2 Non-goal of the Python helper

The Python helper is **not** intended to reimplement parsing or version normalization logic. It should consume outputs generated by the JavaScript pipeline.

---

## 8. Mixed-Version Bedrock Follow-Up Questions

Current behavior for mixed-version `.mcstructure` inputs is pragmatic:

- select the dominant normalized source version;
- emit a warning;
- continue parsing with that selected version.

Potential future follow-up questions:

- Should mixed-version inputs also produce a structured diagnostic field in unified metadata?
- Should per-entry conversion ever be supported?
- Should heavily mixed palettes be rejected when confidence is too low?
- Should warning thresholds depend on minority-version proportion?

---

## 9. Verification / Fixture Expansion TODO

Future work should add more targeted fixtures for:

- Java structures that need normalization across versions;
- Bedrock fixtures from multiple source versions;
- intentionally mixed-version `.mcstructure` examples;
- known rename/property migration edge cases;
- explicit lossy normalization scenarios;
- future vocabulary-generation round trips.

---

## 10. Current Recommended Next Steps

Reasonable future task breakdown:

1. **Research task**
   - continue investigating whether upstream data can be mined/generated into Java cross-version rename tables.

2. **Normalization design task**
   - define the exact `--norm_version` contract and diagnostics.

3. **Vocabulary generation task**
   - generate fixed `1.21.8` block-name and prop-pair vocabularies.

4. **Python export helper task**
   - convert unified JSON + fixed vocab into ML-ready palette encodings.

5. **ML integration task**
   - consume those outputs in the downstream training repository.
