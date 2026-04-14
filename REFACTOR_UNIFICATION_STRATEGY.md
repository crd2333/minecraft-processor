# Minecraft 结构统一化重构建议（面向 Prismarine 生态）

## 0. 目标与范围

这份文档回答两件事：

1. `stateId` / `blockId` / `metadata` 在游戏与 Prismarine 生态中的真实语义是什么。
2. 在不重复造轮子的前提下，如何把仓库重构为“解析保真 + 统一输出清晰”的双阶段架构。

本建议不涉及直接改代码，只给出可执行的设计决策与迁移路线。

---

## 1. 概念澄清（游戏语义 + Prismarine 语义）
### 1.1 namespaceName 和 blockName 的关系
- **namespace（namespaceName）:** 表示资源的“域/来源”，通常是 mod id 或者 `minecraft`（原版）。用于避免命名冲突，通常小写字符串。
- **blockName:** 表示该域下的具体方块标识（路径/名字），例如 `oak_planks`、`stone`。
- **组合成完整 ID:** 两者合起来构成注册/资源定位符 `namespace:blockName`，例如 `minecraft:oak_planks`（namespace=`minecraft`，blockName=`oak_planks`）。
- **实践影响:** namespace 决定来源（哪个 mod/资源包），blockName 决定方块类型；资源、纹理、翻译键等都用完整 ID 去查找（例如翻译键通常为 `block.<namespace>.<blockName>`）。

简言之：namespace = 谁出的（域），blockName = 出了什么（具体方块），两者联合形成唯一标识。

### 1.2 `stateId` 到底是什么

结论：`stateId` 是“按版本定义的全局方块状态 ID”，不是某个结构文件内的 palette 下标。

在 Prismarine / minecraft-data 里：

- Java 现代版本（例如 1.21.4）在 `blocks.json` 中给每个 block 定义 `minStateId` / `maxStateId` / `defaultState` 与 `states`。
- 例如 `oak_stairs`（1.21.4）可见：
  - `id: 184`
  - `minStateId: 2929`
  - `maxStateId: 3008`
  - `defaultState: 2940`
  - `states: facing/half/shape/waterlogged`
- 这表示一个 block type 对应一个连续 state 区间，区间内每个整数就是一个完整状态。

典型数据位置：

- `node_modules/minecraft-data/minecraft-data/data/pc/1.21.4/blocks.json`
- 运行时索引：`mcData.blocksByStateId[stateId]`

补充：结构文件自身（`.schem` / `.litematic` / `.mcstructure`）里的 palette index 是“文件局部索引”，语义完全不同，不应与 `stateId` 混用。

### 1.3 `blockId` 是什么，是否过时

结论：`blockId` 是“方块类型 ID（type id）”，不是完整状态 ID。

- 在 Java 1.13+ 与 Bedrock 现代格式中，存储和网络核心都以 state 为主；`blockId` 仍可作为类型级别标识存在，但不足以表达朝向/含水等状态。
- 在 Prismarine `Block` 对象中，`type`（即 blockId）和 `stateId` 都会存在；`stateId` 更细，`type` 更粗。

对应实现可见：

- `node_modules/prismarine-block/index.js`
- `Block.fromStateId(...)` 在支持 block states 的版本直接用 `stateId` 反查；旧版才拆成 `id + metadata`。

### 1.4 `metadata` 是什么

结论：`metadata` 是旧时代（Java pre-1.13）用于表达方块变体的附加值（通常 0~15）。

- 经典语义是 `state = (blockId << 4) | metadata`。
- 在 `prismarine-schematic/lib/states.js` 中，如果 `minStateId` 缺失，会走 `(block.id << 4) + data`。
- 例子：Java 1.12 `wool` 在 `blocks.json` 中有 `variations`，每个颜色对应 `metadata: 0..15`。

关键结论：在旧版本里，多个变体确实共享同一个 blockId，再由 metadata 区分。

---

## 2. 你提出的两个关键问题：直接回答

### 2.1 stateId 是全局词表 ID 还是文件 palette ID

答案：两者都有，但不是同一个概念。

1. 全局 stateId：来自版本数据表（`minecraft-data`），是版本级统一状态索引。
2. 文件 palette index：来自单个结构文件，是局部压缩索引。

统一流程正确做法应是：

1. 先读文件 palette index。
2. 还原为完整状态字符串/属性。
3. 再映射到目标版本的“全局 stateId 或你的统一词表 ID”。

### 2.2 blockId、metadata 在新版和跨版本里的关系

答案：

1. Java pre-1.13：主要是 `blockId + metadata`。
2. Java 1.13+：核心是 block states，`stateId` 更重要。
3. Bedrock 现代：也有 state 级语义（可见 `blockStates.json`），但状态命名与 Java 不同，需要映射。
4. blockId 仍可作为“类型层”特征，但不能单独代表完整状态。

---

## 3. 关于重构方向的核心决策

### 3.1 以 Java 还是 Bedrock 为统一基准

建议：以 Java 为 canonical 语义层。

原因：

1. 生态工具链更成熟（Prismarine viewer/模型/资源大量围绕 Java 命名）。
2. ML 语料与社区共享样本通常更偏 Java 命名。
3. Bedrock 到 Java 已有版本化映射资产（`blocksB2J.json` / `blocksJ2B.json`）。

但要保留 source sidecar：

1. 统一后仍保存原始 Bedrock 名称/属性，便于回溯与误差分析。
2. 不要把不可映射项直接抹成 air。

### 3.2 是否构建“跨版本跨平台超大一体词表”

建议：不要一开始就做一个全量超级词表。

建议改为“两层词表 + 版本标签”：

1. 层 A（block-level）：`minecraft:<name>` 级别，尺寸可控，适合主 embedding。
2. 层 B（property-level）：独立编码属性键值（如 `facing=north`、`waterlogged=true`）。
3. 样本带 edition/version 条件特征（如 `src=bedrock_1.21.111`, `tgt=java_1.21.4`）。

这样可避免 state-level 词表爆炸，同时保留状态信息。

### 3.3 state 级词表会不会过大

你的直觉是对的。

推荐默认策略：

1. 主模型使用 block embedding。
2. properties 使用额外 embedding（键和值可分开）。
3. 在需要几何精细区分的任务（比如 segmentation 或严格重建）再启用 state-level 头。

可选混合表示：

1. `E_final = E_block + E_prop_keys + E_prop_values + E_version`。
2. 或者 `concat([E_block, E_prop_pool, E_version])` 交给下游 MLP。

### 3.4 最终 ML 输出格式建议

你设想的 `meta + palette + blocks` 是正确方向。

建议精简为：

```json
{
  "meta": {
    "schemaVersion": "unified-v2",
    "source": {"edition": "bedrock", "version": "1.21.111", "format": "mcstructure"},
    "target": {"edition": "java", "version": "1.21.4"},
    "coordinateSpace": "relative",
    "unknownPolicy": "keep-unknown"
  },
  "palette": [
    {
      "pid": 0,
      "blockName": "grass_block", // 对应 block-level 词表项
      "namespace": "minecraft",
      "displayName": "Grass Block",
      "props": {"snowy": false}, // 对应 property-level 词表项
      "sourceProps": {},
      "flags": {"isUnknown": false}
    }
  ],
  "blocks": [[x, y, z, pid]]
}
```

精简原则：

1. 块级重复字段（`blockName/namespaceName/properties/sourceHints`）只放 palette。
2. `blocks` 仅保留坐标 + `pid`。
3. 需要追踪时再开可选 `debug` 扩展块。

---

## 4. 强烈建议的架构改造（与你的命令语义一致）

### 4.1 命令职责

1. `parse_mc.js`
- 只做“原始解析 + 保真导出”，不做跨版本统一。
- 输出 native payload（按输入格式区分 schema），尽量保留原字段。

2. `parse_mc_unified.js`（由 `parse_mc_ids.js` 演进）
- 输入 native payload 或原文件。
- 执行 normalize/unify（edition/version/canonical mapping/unknown policy）。
- 输出 `meta + palette + blocks`（ML-ready）。

3. `serve_mc.js`
- 继续专注渲染，不耦合 ML 词表策略。

### 4.2 统一层需要明确的策略参数

建议统一层支持这些显式参数：

1. `--target-edition java|bedrock`（默认 java）
2. `--target-version <ver>`（必须显式）
3. `--granularity block|state|hybrid`（默认 hybrid）
4. `--unknown-policy keep|index0|drop`（默认 keep）
5. `--coord-space relative|absolute`

---

## 5. 映射资产使用建议（避免手工 copy/generate）

你这个判断是正确的：优先依赖 Prismarine/minecraft-data 上游资产。

建议：

1. Java/Bedrock 基础注册表来自 `minecraft-data` 版本目录。
2. Bedrock/Java 双向映射来自 `blocksB2J.json` 与 `blocksJ2B.json`。
3. 不建议继续维护仓库内手写映射作为主源。
4. 允许本仓库仅维护“补丁层”（少量 override），并记录来源与版本。

关键注意：

1. 在当前 `minecraft-data` 包里，`mcData.blockMappings` 可能为空（取决于版本资产）。
2. 但版本目录下的 `blocksB2J/blocksJ2B` 是存在且可直接读取的。
3. 因此实现上要明确从版本资产读取，不要只依赖 `blockMappings` 字段。

---

## 6. Unknown 处理的统一原则（必须改）

统一原则：未知块永不在早期解析阶段强行替换为空气。

建议策略：

1. 解析阶段：完整保留原名与属性，打 `isUnknown` 标记。
2. 统一阶段：按策略决定 `keep/index0/drop`。
3. 渲染阶段：可选择视觉 fallback（例如 air）但不污染语义数据。
4. 报表阶段：输出 unknown 计数、来源版本、样本 key top-k。

---

## 7. 迁移路线（低风险分阶段）

### Phase 1：定义与数据源收口

1. 固化术语：`filePaletteIndex` 与 `globalStateId` 分名。
2. 统一从 `minecraft-data` 拉取版本资产。
3. 写一个“资产探针”命令，验证目标版本是否存在：
- `blocks.json`
- `blockStates.json`（Bedrock）
- `blocksB2J.json` / `blocksJ2B.json`

### Phase 2：命令职责拆分

1. `parse_mc.js` 改成纯 native parse。
2. 新增 `parse_mc_unified.js`（可先兼容旧 `parse_mc_ids.js` 输出）。

### Phase 3：输出 schema v2 落地

1. 采用 `meta + palette + blocks` 精简版。
2. 增加 `schemaVersion` 与向后兼容转换器。

### Phase 4：ML 策略验证

1. block-only、hybrid、state-level 三组 A/B。
2. 对比 embedding 参数量、收敛速度、任务指标。

---

## 8. 快速自检清单

在你真正开重构前，建议先保证以下 8 条：

1. 任何格式输入都能导出 native 且不丢字段。
2. `stateId` 与 `file palette index` 在命名上永不混淆。
3. unknown 不会在 parse 阶段被 silent air 化。
4. 统一层显式记录 source/target edition+version。
5. 映射源可追溯到上游版本文件。
6. `meta` 内保留 unify policy 与统计摘要。
7. 输出最小冗余（重复字段只保留在 palette）。
8. schema 带版本号，便于后续升级。

---

## 9. 你当前方案的结论（简版）

1. 方向正确：`parse_mc` 做保真，`parse_mc_unified` 做统一。
2. 统一基准建议选 Java，同时保留 source sidecar。
3. 不要先做全量 state 超大词表；先上 block+property 的 hybrid。
4. 输出结构继续 `meta+palette+blocks`，但要做“去冗余 + 强 schema + 可追溯”。

这套方案能最大化复用 Prismarine 已有成果，同时把你仓库的核心价值聚焦在“可解释、可控、可扩展”的统一化流程上。
