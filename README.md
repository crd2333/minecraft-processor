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

## Fix
1. Fix the error of rendering 'stairs' as 'air' in PrismarineJS (caused by `.include('air)` in its `models.js`)
