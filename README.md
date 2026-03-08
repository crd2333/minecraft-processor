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

`serve_mc.js` is used to show the structure block files in a web browser using key libraries from PrismarineJS. It also provides an API to export the structure block files into pictures and 3D models.

If serve_mc.js reports missing built assets, run npm run build first.

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
