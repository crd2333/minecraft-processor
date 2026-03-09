# Minecraft Processor

A node-based Minecraft data processor. This project utilizes the [Prismarine-viewer](https://github.com/PrismarineJS/prismarine-viewer) library, but reduces unnecessary features. Prismarine-viewer supports Minecraft versions from 1.8 to 1.21.4, so is this project.

The main goal of this project is to provide a simple and efficient way to process Minecraft data for ML applications. It is able to parse, render, export minecraft structure block files (.schem, .schematic, .litematic, .nbt, .mcstructure) into readable data / pictures / 3D models.

## Build
Install dependencies and generate the local rendering assets:

```bash
npm install
```

## Usage
`parse_mc.js` is used to parse the structure block files into json data.

`scripts/generate_vocab.js` is used to pre-generate a fixed Java block vocabulary for a target version under `generated/`. It reserves index `0` for unknown blocks, assigns entity blocks to one continuous index range, and assigns non-entity blocks to a second continuous range.

`parse_mc_ids.js` is used to export a minimal ML-oriented payload. It reuses the shared structure parser, converts Bedrock block names to Java names when needed, and outputs `blocks: [[x, y, z, index], ...]` by looking up a pre-generated vocabulary file from `generated/`. If you only want entity blocks, pass `--entity-only` and non-entity blocks will be ignored during export.

The current entity/non-entity split is based on `minecraft-data` metadata: a block is treated as an entity block when `boundingBox !== 'empty'`.

`serve_mc.js` is used to show the structure block files in a web browser using key libraries from PrismarineJS. It also provides an API to export the structure block files into pictures and 3D models.

If serve_mc.js reports missing built assets, run npm run build first.

Example:

```bash
npm run generate:vocab -- 1.20.1
node scripts/generate_vocab.js 1.20.1 --pretty
node parse_mc_ids.js assets/bedrock.mcstructure generated/block-vocab.1.20.1.json --pretty
node parse_mc_ids.js assets/bedrock.mcstructure generated/block-vocab.1.20.1.json --entity-only --pretty
node parse_mc_ids.js assets/bedrock.mcstructure generated/block-vocab.1.20.1.json --entity-only --stdout --pretty
```

A minimal Python subprocess example is available at `scripts/python_example.py`. It reads the pre-generated vocabulary from `generated/block-vocab.1.20.1.json` and only calls `parse_mc_ids.js` at runtime.

## Code Layout
`parse_mc.js` and `serve_mc.js` remain the only root entrypoints.

Shared structure parsing logic now lives under `utils/structure.js`:

- `structure.js`: shared format detection, NBT probing, coordinate helpers, and the unified structure-to-payload loader used by both parse and serve flows

Rendering-specific world population logic lives under `utils/worldBuilder.js`:

- `worldBuilder.js`: converts normalized block payloads into a prismarine world and applies Bedrock post-processing when needed

The browser page is no longer embedded in `serve_mc.js`.
Static viewer assets now live in `public/viewer.html`, `public/viewer-preload.js`, and `public/viewer-hooks.js`.

Vendored Prismarine viewer code remains isolated under `vendor/prismarine-viewer/`.

## Fix
1. Fix the error of rendering 'stairs' as 'air' in PrismarineJS (caused by `.include('air)` in its `models.js`)
