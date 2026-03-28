# Thinking Guides

> Purpose: prompt the right questions before touching code.

---

## Why these guides matter here

In this repository, bugs often come from:

- mixing up native vs unified contracts,
- changing backend/frontend route or socket payloads on one side only,
- scattering parse rules across CLI files instead of reusing `src/`,
- assuming old docs still match current code.

These guides exist to prevent that kind of drift.

---

## Available Guides

| Guide | Purpose | When to Use |
|-------|---------|-------------|
| [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md) | Identify shared logic and reduce duplication | When you notice repeated parsing / viewer / helper patterns |
| [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md) | Think through contracts across parser, viewer server, and browser runtime | Features spanning multiple layers |

---

## Quick reference: thinking triggers

### When to think about cross-layer issues

- [ ] A change touches parse output and viewer/world behavior
- [ ] A route, socket event, or payload shape is changing
- [ ] A CLI output contract is changing
- [ ] Bedrock behavior differs between native, unified, and render paths

→ Read [Cross-Layer Thinking Guide](./cross-layer-thinking-guide.md)

### When to think about code reuse

- [ ] You're writing similar parsing or normalization logic again
- [ ] You're adding the same constant/flag/field to multiple files
- [ ] You're about to create a new helper without checking `src/` first
- [ ] You're duplicating viewer contract logic in both frontend and backend

→ Read [Code Reuse Thinking Guide](./code-reuse-thinking-guide.md)

---

## Pre-modification rule

Before changing any contract, confirm all affected layers:

1. root wrapper / CLI boundary
2. shared `src/` logic
3. viewer server routes or sockets
4. browser runtime code
5. docs that describe the contract

---

## How to use this directory

1. Before coding: skim the relevant guide
2. During coding: use it to decide where logic belongs
3. After coding: verify that docs and code still describe the same contract

---

**Core Principle**: in this repo, 20 minutes of contract-checking is often worth more than 2 hours of debugging.
