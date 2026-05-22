Local overlays applied to the installed `prismarine-viewer` package before bundling.

`scripts/build-vendor.js` copies `node_modules/prismarine-viewer` into `.build/vendor-packages/prismarine-viewer`, then overwrites the files listed here before Rollup/Webpack consume that staged package.

Current overlays:

- `viewer/lib/models.js`: block-id attributes for segmentation/GBuffer export, stateId-to-name capture, and model-aware face culling fixes.
- `viewer/lib/worker.js`: transfers the additional `blockIds` geometry buffer.
- `viewer/lib/worldrenderer.js`: depth/RGB/mask/segmentation render passes and vendor-relative texture/block-state asset paths.

These files intentionally replace package files at build time; `prismarine-viewer-lib/` is no longer a runtime source dependency.
