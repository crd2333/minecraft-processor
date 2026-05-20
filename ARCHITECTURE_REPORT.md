# Minecraft Processor 架构报告

> 帮助维护者快速理解项目当前架构，以代码实现为准。

## 1. 项目定位

Node.js 工具链，处理 Minecraft 结构文件（`.schem`、`.schematic`、`.litematic`、`.nbt`、`.mcstructure`）。

三条核心链路：

1. **native 解析** — 保留源格式语义，输出 native JSON，用于调试和格式对比
2. **unified IR 导出** — 跨格式标准化为 `{ meta, size, palette, blocks, entities }`，面向 ML / 数据消费
3. **viewer 渲染** — 本地服务 + 浏览器渲染，支持截图、模型导出、GBuffer 导出

---

## 2. 稳定入口

根目录三个文件是对外公共契约：

| 根入口 | 真实实现 |
|--------|----------|
| `parse_mc.js` | `apps/cli/parse_mc.js` |
| `parse_mc_unified.js` | `apps/cli/parse_mc_unified.js` |
| `serve_mc.js` | `apps/cli/serve_mc.js` |

根文件只做 `require()` 转发。不要改名，不要把逻辑搬回根文件。

---

## 3. 分层结构

```text
[根入口]  parse_mc.js / parse_mc_unified.js / serve_mc.js
              │
              ▼
[CLI 层]  apps/cli/         参数解析、文件 IO、Express/Socket.IO 编排
              │
              ▼
[领域层]  src/               格式解析、unified IR、world 构建、Bedrock 适配
              │
              ├─► [前端]     apps/frontend/viewer/   浏览器渲染 + 交互
              └─► [资产]     static/
```

一句话总结各层职责：

- `apps/cli/` — 怎么跑（参数、IO、服务编排）
- `src/` — 核心逻辑是什么（解析、转换、world 构建）
- `apps/frontend/viewer/` — 浏览器里怎么显示
- `static/` — 运行时依赖的构建产物和查找数据

---

## 4. 目录职责

### 4.1 `apps/cli/`

三个根命令的实现。负责参数解析、文件读写、调用 `src/` 逻辑、输出结果或启动服务。

可复用的领域逻辑不要放这里，应该放 `src/`。

### 4.2 `src/`

共享领域逻辑。关键文件：

- `structure_parser.js` — 格式探测、native 解析、NBT 解析
- `unified_parser.js` — unified IR 构建入口，Bedrock→Java 转换也在此链路
- `world_builder.js` — unified IR → prismarine world 放置
- `bedrock-adapter/convertBlocks.js` — Bedrock→Java block 映射
- `bedrock-adapter/postProcess.js` — 基于邻接上下文的 Bedrock 后处理（stairs、fence、pane、redstone 等）

### 4.3 `apps/frontend/viewer/`

viewer 前端源码，**不是 React/Vue SPA**，是 DOM 驱动的 Three.js 渲染页面。

- `public/viewer.html` — HTML 壳
- `src/client.js` — Three.js bootstrap、Socket.IO 事件、全局 capture API
- `src/hooks/viewer-hooks.js` — 控制面板 UI、导出、bounding box
- `src/preload/viewer-preload.js` — 浏览器环境补丁

### 4.4 `static/`

webpack 构建的浏览器 bundle、worker、纹理、blockStates，以及浏览器/CLI 可直接读取的静态查找数据（例如 `mc_mappings.json`）。viewer 启动时会检查这些产物是否存在。

### 4.5 `prismarine-viewer-lib/`

vendored 且做过本地修改的 Prismarine viewer 代码。既不是原版上游镜像，也不是普通业务模块——升级或同步上游时要谨慎。

---

## 5. 核心管线

### 5.1 native 解析（`parse_mc.js`）

识别格式 → 读文件 → `loadNativeStructure()` → 输出 `{ format, schema, parser, data }`。

要点：

- 不是 unified 管线的前置阶段
- `--readable` 在 native 语义内做可读化
- `--filter-air` 是 `--readable` 的附加选项

### 5.2 unified IR（`parse_mc_unified.js`）

识别格式 → 读文件 → `loadUnifiedStructure()` → 输出 `{ meta, size, palette, blocks, entities }`。

要点：

- `blocks[*] = [x, y, z, pid]`，`pid` 是 palette 下标
- palette entry 默认为 `{ name, props }`，Bedrock 来源可能附带 `mapping: { status, sourceKey }`；`--solid_color` 会额外附加来自 `static/mc_mappings.json` 的 `solid_color`
- `meta.stats` 包含 `paletteSize`、`blockCount`、`entityCount`、`unresolvedPaletteCount` 等
- unified 行为的源头是 `src/unified_parser.js`，不是 `structure_parser.js`

### 5.3 viewer（`serve_mc.js`）

读结构 → unified 解析 → `world_builder.js` 放入 prismarine world → Express + Socket.IO → 浏览器渲染。

服务的路由包括 `/`（viewer.html）、`/viewer-preload.js`、`/viewer-hooks.js`、`/mc_mappings.json`、`/api/assets`。

viewer 能力：结构渲染、资产切换、截图、OBJ/STL/GLB 导出、GBuffer 导出、bounding box 过滤。

---

## 6. Bedrock 处理模型

Bedrock 处理分三层，这个分层很重要，不要合并：

| 层 | 职责 | 位置 |
|----|------|------|
| native | 保持源格式原貌 | `structure_parser.js` |
| unified | Bedrock→Java 映射，未匹配的保留 `mapping.status` | `unified_parser.js` + `bedrock-adapter/convertBlocks.js` |
| render | 基于邻接上下文修正形态（stairs、fence、pane、redstone 等） | `bedrock-adapter/postProcess.js` |

---

## 7. 数据契约

**native 输出**：`{ format, schema, parser, data }` — 不要把 unified 字段塞进来。

**unified IR**：`{ meta, size, palette, blocks, entities }` — parse:unified 和 viewer 共用的核心契约。

**GBuffer**：magic `MCGBUF01`，header + metadata JSON + channel blobs（`rgb`/`depth`/`seg`/`mask`），depth 是 float16 metric z，背景为 `+Inf`。

---

## 8. 构建与验证

```bash
npm run build          # build:assets + build:client
npm test               # smoke 脚本（test/lint/type-check 目前指向同一个脚本）
```

viewer 运行依赖 `static/`，资产缺失时先跑 `npm run build`。

---

## 9. 问题定位速查

| 问题 | 先看 |
|------|------|
| 解析正确性 | `src/structure_parser.js` |
| unified 输出异常 | `src/unified_parser.js`、`bedrock-adapter/convertBlocks.js` |
| Bedrock 方块形态不对 | `bedrock-adapter/postProcess.js` |
| viewer 页面/交互/导出 | `apps/cli/serve_mc.js`、`apps/frontend/viewer/src/` |
| 构建产物/运行时资产 | `webpack.config.js`、`scripts/generate-assets.js`、`static/` |

---

## 10. 维护红线

1. 根入口文件名是公共契约，不要改名
2. 先看当前代码再下结论，不要从旧文档反推行为
3. `prismarine-viewer-lib/` 是 vendored + 本地 patch，升级要谨慎
4. Bedrock 处理分层完成，不要把所有修正塞进同一阶段
5. 这不是典型 Web 全栈项目，不要套 controller/service/database 思维

---

## 11. 总结

理解这个仓库，抓住五个事实：

1. **Node.js 结构处理工具链**，不是 CRUD Web 应用
2. 三个根入口是稳定契约，真实实现在 `apps/cli/`
3. native 解析在 `structure_parser.js`，unified IR 在 `unified_parser.js`
4. viewer 依赖 `static/`，通过 `serve_mc.js` 串联
5. Bedrock 处理是分层模型：映射 + 上下文后处理
