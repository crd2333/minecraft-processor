# Logging Guidelines

> How logging is done in this project.

---

## Overview

The project currently uses **plain console logging**:

- `console.log` for normal lifecycle/status output
- `console.warn` for recoverable problems or degraded behavior
- `console.error` for fatal failures at the CLI/server boundary

There is no structured logging library today. Keep logging simple unless the project deliberately adopts one.

---

## Log Levels

### `console.log`

Use for normal operator-facing lifecycle messages:

- successful parse/write summaries
- viewer startup details
- file paths and selected runtime options

Examples:

- `apps/cli/parse_mc.js`
- `apps/cli/parse_mc_unified.js`
- `apps/cli/serve_mc.js`

### `console.warn`

Use for recoverable issues where the program continues:

- no non-air blocks found
- block names that cannot be rendered in the selected version
- port already in use, retrying next port

Examples:

- `src/world_builder.js`
- `apps/cli/serve_mc.js`

### `console.error`

Use at the top-level failure boundary when the command is about to fail.

Examples:

- `apps/cli/parse_mc.js`
- `apps/cli/parse_mc_unified.js`
- `apps/cli/serve_mc.js`

---

## Structured Logging

There is no formal structured logging format yet.

Current convention is concise human-readable messages with embedded context, for example:

- `Parsed <inputPath>`
- `Detected format: <format>`
- `Warning: <count> block(s) not found...`

If a future refactor introduces a logger, preserve these qualities:

1. operator-friendly output for CLI usage,
2. enough context to debug file/version issues,
3. no noisy per-block logging during successful normal runs.

---

## What to Log

- selected input file and detected format
- output location and counts
- selected target version or other relevant runtime options
- server port and URL
- fallback/retry behavior that changes execution flow
- counts and names for skipped/unknown blocks when useful for debugging

Examples:

- `parse_mc.js` prints input, detected format, native schema/parser info, and output path.
- `parse_mc_unified.js` prints block count, palette count, unresolved count, and target version info.
- `serve_mc.js` prints port, structure path, bbox info, and asset base directory.

---

## What NOT to Log

- full raw binary file contents
- giant object dumps of parsed payloads during normal runtime
- per-block logs in large structures
- every poll/request from local job APIs when a client already shows progress
- secrets or credentials if any are ever added in future
- noisy browser/client internals from shared backend modules

Also avoid double-logging the same fatal error at multiple layers.

---

## Anti-Patterns

- Do not add a logging dependency just to wrap `console` without a real need.
- Do not log inside tight loops over every block/chunk unless explicitly debugging.
- Do not log high-frequency job polling or progress updates during normal model runs.
- Do not treat warnings as fatal errors.
- Do not log paths/counts in one place and hide the actual failure reason elsewhere.

---

## Concrete Examples

### Example 1: concise successful CLI summary

- `apps/cli/parse_mc.js`

### Example 2: degraded-but-usable rendering warning

- `src/world_builder.js`

### Example 3: operational retry information

- `apps/cli/serve_mc.js`
