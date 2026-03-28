# Error Handling

> How errors are handled in this project.

---

## Overview

The codebase mostly uses **plain `Error` objects with descriptive messages** rather than custom error classes.

The dominant pattern is:

1. throw early in shared logic when input is invalid,
2. let the top-level CLI/runtime boundary catch the error,
3. print a human-usable message,
4. exit with non-zero status or send an HTTP/socket failure response.

This is a small-tooling repository, so simple error flows are preferred over elaborate exception hierarchies.

---

## Error Types

### Current reality

There are effectively two categories:

- **user/input errors**: bad flags, unsupported file extension, missing assets, invalid runtime data file
- **runtime/integration errors**: parser failure, port conflicts, failed chunk/world emission, filesystem access issues

The project does **not** currently define custom subclasses like `ValidationError` or `ApiError`.

Examples of direct descriptive throws:

- `src/structure_parser.js` unsupported file extension
- `apps/cli/parse_mc.js` missing input path
- `apps/cli/parse_mc_unified.js` missing input path or bad unified flags
- `apps/cli/serve_mc.js` missing built asset

---

## Error Handling Patterns

### 1. Validate arguments close to the boundary

Entry files parse flags and throw immediately on malformed input.

Examples:

- `apps/cli/parse_mc.js`
- `apps/cli/parse_mc_unified.js`
- `apps/cli/serve_mc.js`

### 2. Shared modules throw, callers decide presentation

`src/` code should not call `process.exit()`.
It should throw errors with enough detail for the caller to present them.

Examples:

- `src/structure_parser.js` throws on unsupported format and malformed litematic/schematic data.
- `src/world_builder.js` does not exit; it returns diagnostics and logs warnings.

### 3. CLI top-level catch handles process exit

CLI entrypoints end with `main().catch(...)`.

Examples:

- `apps/cli/parse_mc.js`
- `apps/cli/parse_mc_unified.js`
- `apps/cli/serve_mc.js`

For pure CLI tools, this is the preferred termination point.

### 4. HTTP routes translate errors to HTTP responses

In the viewer server, Express handlers return status codes and JSON error bodies.

### 5. Socket handlers acknowledge failures explicitly

Socket flows do not throw uncaught errors back into the transport when an ack callback exists.

---

## API Error Responses

### Express JSON routes

Current shape is intentionally minimal:

```json
{ "error": "message" }
```

Example:

- `GET /api/assets` in `apps/cli/serve_mc.js`

### Socket.IO acknowledgements

Current shape:

```json
{ "ok": false, "error": "message" }
```

Success shape:

```json
{ "ok": true, "asset": "...", "format": "..." }
```

Example:

- `switchAsset` ack in `apps/cli/serve_mc.js`

---

## Anti-Patterns

- Do not swallow errors silently.
- Do not return `null`/`false` for failure when the caller expects an exception-driven flow.
- Do not call `process.exit()` from `src/` modules.
- Do not expose giant stack traces to end users when a concise message is enough.
- Do not invent custom error-class hierarchies unless multiple callers truly need typed branching.

---

## Common Mistakes

1. Catching too low and losing useful context.
2. Throwing vague messages like `invalid input` instead of naming the exact flag/file/schema problem.
3. Mixing warnings and fatal errors; for example, unknown renderable blocks in `world_builder.js` are warnings, not process-ending failures.

---

## Concrete Examples

### Example 1: CLI usage + fatal message

- `apps/cli/parse_mc.js`

Shows help, then throws a specific message.

### Example 2: fallback parser with wrapped context

- `src/structure_parser.js`

Native schematic parsing is attempted first, then fallback readers, and fallback failure is wrapped with more context.

### Example 3: recoverable server startup issue

- `apps/cli/serve_mc.js`

Port conflicts are retried; only exhausting the range becomes a hard failure.
