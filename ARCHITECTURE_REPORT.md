# Minecraft Processor 架构分析报告

> 目标：帮助后续 agent 在最短时间内建立对仓库的整体认知，并快速定位改动点。

## 1. 项目定位

这是一个 Node.js 工具链，面向 Minecraft 结构文件的**解析、可视化与导出**，支持：

- `.schem`
- `.schematic`
- `.litematic`
- `.nbt`
- `.mcstructure`

核心用途偏向 ML/数据处理：把结构文件统一转换成稳定的数据格式，或导出索引化 payload 与渲染产物。

---

## 2. 顶层入口（核心可执行）

根目录三个主要入口：

1. `parse_mc.js`
   - 标准化解析入口
   - 输出完整语义数据：`{ meta, palette, blocks }`

2. `parse_mc_ids.js`
   - ML 导向导出入口
   - 读取预生成 vocab，把 block 映射为 index
   - 输出：`{ meta, blocks }`，其中 `blocks = [[x, y, z, index], ...]`

3. `serve_mc.js`
   - 本地 web viewer 服务入口（Express + Socket.IO）
   - 加载结构到 prismarine world
   - 提供可视化、模型导出、GBuffer 导出等功能

---

## 3. 高层架构分层

```text
[入口层]
  parse_mc.js / parse_mc_ids.js / serve_mc.js
         │
         ▼
[统一解析层]
   src/structure_parser.js
  - 格式识别
  - NBT 自动探测
  - 多格式归一化解析
  - 统一 meta/palette/blocks
         │
         ├────────► [词表映射层]
         │          src/block_vocab.js
         │          (vocab 生成/校验/index 解析)
         │
         └────────► [世界构建层]
                    src/world_builder.js
                    + src/bedrock-adapter/convertBlocks.js
                    + src/bedrock-adapter/postProcess.js
                    (渲染侧 block 归一化与 Bedrock 后处理)
                               │
                               ▼
                     [Viewer 前后端]
                               serve_mc.js + apps/frontend/viewer/* + static/*
```

---

## 4. 关键模块说明

## 4.1 `src/structure_parser.js`（核心中的核心）

主要职责：

- `detectStructureFormat(inputPath)`：根据扩展名识别格式
- `loadStructurePayload(buffer, format, options, sourcePath)`：统一解析总入口

内部主要解析分支：

- `parseSchematicLike`（`.schem/.schematic`）
- `parseLitematic`
- `parseJavaStructureNbt`
- `parseBedrockMcstructure`
- `parseGenericNbt`（无法识别结构 schema 时兜底）

关键点：

- NBT 尝试 auto/little/littleVarint 三种解析 hint
- `.schem` 解析支持 native + fallback（含 Sponge v3 兼容）
- 输出结构统一，便于后续 CLI 和 viewer 复用

---

## 4.2 `parse_mc_ids.js` + `src/block_vocab.js`

数据流：

1. `loadStructurePayload()` 得到统一 blocks
2. 读取并 `validateBlockVocabulary()`
3. `resolveBlockIndex()` 做 name → index 映射
4. 输出 ID-only payload

设计要点：

- unknown 固定 index=0（`__unknown__`）
- entity/non-entity 由 `minecraft-data` 的 `boundingBox !== 'empty'` 分类
- `--entity-only` 会过滤非 entity 方块
- Bedrock 来源会先做 Bedrock→Java 名称/属性转换，再查 vocab

---

## 4.3 `src/world_builder.js` + `src/bedrock-adapter/*`

`worldBuilder.js`：

- 将统一 payload 放置到 prismarine world
- 汇总放置失败 block（用于 viewer 中 error block 可视化）
- 对 Bedrock 结构触发后处理

`bedrock-adapter/index.js`：

- 使用 `data/generated/blocksB2J.json` 做 Bedrock→Java 映射
- 执行多轮上下文后处理（如 stairs shape、chest type、redstone/fence/pane 连接等）

该模块是“Bedrock 结构渲染正确性”的关键。

---

## 4.4 Viewer：`serve_mc.js` + `apps/frontend/viewer/*` + `static/*`

### 服务端（`serve_mc.js`）

- Express 提供页面与静态资源（`apps/frontend/viewer/public` + `static`）
- Socket.IO 推送 world chunks、position、辅助几何信息
- 支持资产枚举/切换（`/api/assets` + `switchAsset`）
- 支持 bounding box 显示与过滤
- 通过 `/generated` 路由暴露 `data/generated`

### 客户端渲染（`apps/frontend/viewer/src/client.js`）

- 基于 Three.js + vendored prismarine world renderer
- 暴露若干 `window.__capture*` API

### 交互面板（`apps/frontend/viewer/src/hooks/viewer-hooks.js`）

- 导出 OBJ/STL/GLB
- 截图
- 导出 `gbuffer.bin`
- 轴线/包围盒显示、隐藏外部块过滤、资产切换

---

## 5. 构建与产物

`package.json` 中关键脚本：

- `npm run build:assets`：生成 `static/textures/*` 与 `static/blocksStates/*`
- `npm run build:client`：webpack 打包浏览器端入口和 worker 到 `static/`
- `npm run build`：组合上述两步
- `npm run prepare`：安装依赖后自动触发 build

`serve_mc.js` 启动时会检查必要资产，不存在会提示先执行 `npm run build`。

---

## 6. 关键数据契约

1. 标准解析输出（parse）
   - `{ meta, palette, blocks }`

2. ML 索引输出（parse:ids）
   - `{ meta, blocks }`
   - `blocks` 元组结构固定为 `['x', 'y', 'z', 'index']`

3. GBuffer 文件格式
   - magic: `MCGBUF01`
   - header + metadata(JSON) + raw channel blobs
   - depth 已编码为 metric z（float16），背景值为 `+Inf`

---

## 7. 目录职责速查

- `apps/cli/`：CLI 入口实现（根目录入口仅保留兼容转发）
- `apps/frontend/viewer/`：前端页面与运行时代码
- `src/`：共享领域逻辑（解析、词表、Bedrock 适配、世界构建）
- `scripts/`：离线生成器与辅助工具（vocab、assets、mapping、python demo）
- `static/`：浏览器静态产物（bundle、纹理、blockStates）
- `data/generated/`：预生成 vocab/mapping 等运行依赖
- `prismarine-viewer-lib/`：项目内置且已修改的 viewer 依赖

---

## 8. Agent 快速上手建议

1. 先读：`README.md`、`src/structure_parser.js`、`apps/cli/serve-mc/index.js`
2. 再看任务方向：
   - 解析语义问题 → `src/structure_parser.js`
   - 词表/索引问题 → `src/block_vocab.js` + `parse_mc_ids.js`
   - Bedrock 映射问题 → `src/bedrock-adapter/convertBlocks.js` 与 `src/bedrock-adapter/postProcess.js`
   - Viewer 交互导出问题 → `apps/frontend/viewer/src/hooks/viewer-hooks.js` + `apps/frontend/viewer/src/client.js`
3. 运行最小验证：
   - `node parse_mc.js assets/<file> --pretty --stdout`
   - `node parse_mc_ids.js assets/<file> data/generated/block-vocab.<ver>.json --stdout --pretty`
   - `node serve_mc.js assets/<file> --version <ver>`

---

## 9. 风险与维护注意

- 仓库包含 `node_modules/`，检索时需有意识避开
- `prismarine-viewer-lib/` 为本地修改版本，升级依赖时要做差异评估
- `data/generated/` 目录中的产物通常是运行时依赖，变更脚本后应同步再生成并验证
