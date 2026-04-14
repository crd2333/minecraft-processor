# Minecraft Structure File Processing Analysis
User:
分析一下这个仓库，告诉我它如何处理 java edition, bedrock edition 的不同版本输入，尤其是这些输入如何被转换并处理到一个统一的词表中（以 java 为准还是以 bedrock 为准？）。我问这个问题的目的是，它出现了很多无法识别的方块：
```
Unknown block firefly_bush replacing with air
Unknown block bush replacing with air
Unknown block spruce_shelf replacing with air
Unknown block wildflowers replacing with air
Unknown block wildflowers replacing with air
Unknown block spruce_shelf replacing with air
Unknown block cow replacing with air
Unknown block chicken replacing with air
Unknown block donkey replacing with air
Unknown block oxidized_copper_golem_statue replacing with air
Unknown block oxidized_copper_golem_statue replacing with air
Unknown block waxed_copper_lantern replacing with air
Unknown block spruce_shelf replacing with air
Unknown block birch_shelf replacing with air
Unknown block iron_chain replacing with air
Unknown block spruce_shelf replacing with air
Unknown block oxidized_copper_golem_statue replacing with air
Unknown block oxidized_copper_golem_statue replacing with air
```
我想要调查一下这个问题，并视情况决定是否需要重构一下这方面的逻辑（我可以参考其它同时支持 java/bedrock 的仓库的处理逻辑），但在此之前我需要先审视现有逻辑。

---
---

GPT5.4分析：
结论先说：**这个仓库的统一词表是 Java Edition（PC）为准**，不是 Bedrock。
Bedrock 输入会先做 `Bedrock -> Java` 名称转换，再去查 Java 词表。

---

### 1) 版本输入和入口

主要入口：

- `parse_mc.js`（native 可读翻译）
- `parse_mc_unified.js`（输出 unified IR）
- `serve_mc.js`（浏览器渲染）

相关位置：

- `--version` 参数解析：`parse_mc.js`、`parse_mc_unified.js`、`serve_mc.js`
- 格式识别（按扩展名）：`src/structure_parser.js`
- 总调度：`src/structure_parser.js` 中的 `loadNativeStructure(...)` / `loadUnifiedStructure(...)`

> 注意：`parse_mc_unified.js` 里的 `--version` 主要影响 `.schem/.schematic` 解析，`--target-version` 才决定 unified Java 目标版本。

---

### 2) Java / Bedrock 输入如何走到统一词表

## Java 输入链路（.nbt/.litematic/.schem）

1. 解析成统一 payload `{meta, palette, blocks}`
   - Java NBT: `parseJavaStructureNbt`（`src/structure_parser.js`）
   - litematic: `parseLitematic`（`src/structure_parser.js`）
   - schematic: schematic 读取与 fallback 逻辑（`src/structure_parser.js`）
2. 每个 block 做词表归一化：
   - 非 Bedrock：直接 `stripMinecraftNamespace`（去掉 `minecraft:`）
     `src/block_vocab.js:106-116`
3. 用 `nameToIndex` 查词表，查不到给 `unknownIndex=0`
   `src/block_vocab.js:118-131`

## Bedrock 输入链路（.mcstructure）

1. 解析 Bedrock palette/states
   `parseBedrockMcstructure`（`src/structure_parser.js`）
2. 词表归一化阶段发现 `source.format === 'mcstructure-bedrock'`，调用：
   - `convertBedrockBlock(name, states)`
     `src/block_vocab.js:110-113`
   - 其内部查 `data/generated/blocksB2J.json`
     `src/bedrock-adapter/convertBlocks.js`
3. 转成 Java 名后，再查 Java vocab
   `src/block_vocab.js:118-131`
4. 查不到仍是 `unknownIndex=0`

---

### 3) 统一词表到底基于谁？

**基于 Java（minecraft-data 的 pc 版本）**

- 构建函数：`buildVersionedBlockVocabulary(version)`
  `src/block_vocab.js:13-74`
- 数据源：`minecraft-data(version).blocksArray`（PC）
- 默认 unknown token/index：`__unknown__` / `0`
- 生成脚本：`scripts/generate_vocab.js:5,80`
- README 也明确写了“fixed Java block vocabulary”
  `README.md:17-20`

另外，词表内部名是**去 namespace 的短名**（如 `stone`，不是 `minecraft:stone`），见 `stripMinecraftNamespace` (`src/structure_parser.js:42-45`)。

---

### 4) 你看到的这条日志从哪来？

你贴的：

```txt
Unknown block xxx replacing with air
```

这句**不是这个仓库自己打的**，而是 `prismarine-schematic` 依赖里的日志：

- `node_modules/prismarine-schematic/lib/states.js:32-36`
- 逻辑：`mcData.blocksByName[name]` 找不到 -> 打日志 -> 返回 `0`（air）

这意味着在 schematic 路径里，未知块会在很早阶段被替换成 air（有信息损失）。

---

### 5) 你这批 unknown 的具体判断

我在当前仓库里对 `generated/block-vocab.1.21.4.json` 和 `generated/blocksB2J.json` 交叉查过：

- `firefly_bush`：在 `blocksB2J.json` 有映射（基本映射到自己），但**不在 Java vocab 1.21.4**
- `wildflowers`：在 `blocksB2J.json` 有状态映射，但**不在 Java vocab 1.21.4**
- `bush`：在 `blocksB2J.json` 有映射，但**不在 Java vocab 1.21.4**
- `spruce_shelf / birch_shelf / oxidized_copper_golem_statue / waxed_copper_lantern / iron_chain`：在当前 `blocksB2J.json` 和 vocab 都没找到
- `cow / chicken / donkey`：这是实体名，不是 block 名，进 block 词表一定会 unknown

所以你这批报错里，至少有三类问题混在一起：

1. **版本漂移/新方块**（映射表或上游数据有，但 Java 词表版本没有）
2. **映射缺失**（Bedrock->Java 表没覆盖）
3. **非方块对象混入 block 流**（实体名）

---

### 6) 现有实现的重构压力点（你关心“要不要重构”）

我会给你一个很直接的判断：**如果你要长期支持 Java/Bedrock 多版本，当前逻辑有明显重构压力。**

关键点：

1. **版本耦合不一致**
   - Java vocab 是按版本生成的
   - Bedrock->Java 映射是单一静态文件 `generated/blocksB2J.json`（运行时不按版本切换）
2. **unknown 处理分散且不一致**
   - schematic 路径直接替换 air（依赖内部）
   - ids 路径给 `unknownIndex=0`
   - worldBuilder 路径是 render error/warn
3. **映射再生成链路不完整**
   - `scripts/generate-bedrock-b2j.js` 依赖 `blocksJ2B.json`，仓库里当前没有这个源文件
4. **信息损失过早**
   - schematic unknown 在 parse 阶段就掉成 air，不利于后续诊断

---
