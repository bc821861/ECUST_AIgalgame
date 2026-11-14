# AGENTS.md —— 给 AI 协作者的项目规则

> 你是本项目的 AI 编码/写作助手。**先读完本文件再动手**。
> 本文件优先级高于你的默认习惯；与用户当面指令冲突时，以用户指令为准，但要在回复里指出冲突点。
> 项目当前阶段：**M0 骨架已跑通**（`CONTRACT_VERSION 2.2.0`）。代码在 `packages/`（契约/引擎/网关/测试工具）与 `apps/`（server/web），数据在 `content/`。规则不变：改代码前先看 §3 的权限分级，`packages/engine` 仍是闭盒。

---

## 0. 三十秒理解这个项目

一个**校园场景的 AI 文字游戏**：玩家用自然语言行动，NPC 有独立记忆和私心，会在夜里互相密谋，第二天你从他们的态度里读出破绽。

技术立场（**这三条是不变量，任何改动都不得破坏**）：

| # | 不变量 | 通俗解释 |
|---|---|---|
| **I1** | 只有 `Arbiter.apply` 能改世界状态 | LLM 和模块只能"提议"，引擎"裁决"后才落库。谁都不许直接写数据库。 |
| **I2** | 状态里没有硬编码字段 | 属性是 `attrs: Record<string, value>`，键由 `content/registry/attrs.json` 声明。**代码里不许出现 `stamina` 这种具体属性名**。 |
| **I3** | 新玩法 = 新数据 + 新目录 | 加模块不改引擎；加属性只改 JSON；加对话形态只加一个导演文件。 |

一句话记法：**Module 算数，Director 说话，Engine 记账。**

---

## 1. 开工前必读（按顺序，不要跳）

1. `docs/03-接口总表.md` —— **唯一名字来源**。所有接口名/op 名/事件名/错误码都在这里。查不到的名字就是"不存在"，不许自己发明。
2. `docs/00-总方案-v2.md` —— 架构、扩展点矩阵、明确不做的事。
3. 你要改的那一块对应的规范：
   - 写模块 → `docs/01-模块规范.md`
   - 动数据/存档/schema → `docs/02-数据格式.md`
   - 联机/多 agent/对话 → `docs/04-联机与多Agent.md`
   - 内容生成/AI 推演边界 → `docs/05-内容边界与AI推演.md`
4. `docs/v1/开发方案-v1.md` —— 产品定义、记忆检索公式、成本模型（查设计依据时看，不要照抄旧接口）。

> 如果文档之间冲突：**`03-接口总表.md` 赢**。并在回复里报告冲突，不要默默选一个。

---

## 2. 十条铁律（违反即视为交付失败）

| # | 铁律 | 为什么 |
|---|---|---|
| 1 | **不发明接口名**。要用不存在的名字，先改 `03-接口总表.md`（并 bump 版本），再写代码，并在回复里说明。 | 别人（和他家的 AI）会照着表写，名字对不上就是白干。 |
| 2 | **不硬编码属性名**。要"体力"就 `ctx.state.attr(entityId, "stamina")`，不许 `player.stamina`。 | 这是"加变量不改引擎"的命门。 |
| 3 | **不直接写数据库/文件**。产出 `Proposal[]`，交给 Arbiter。 | 绕过裁决 = 数值漂移、存档不可复现。 |
| 4 | **模块不持有 LLM 客户端、不读环境变量里的 key**。需要生成就调 `ctx.llm`（可被 mock）。 | 否则成本与密钥失控、测试没法跑。 |
| 5 | **不新增 op 原语**。12 个是闭集，新玩法只能用它们组合。真需要新增 → 停下来问人。 | 每次新增都是全系统回归。 |
| 6 | **不为了让测试过而放宽契约**。契约改了要 bump 版本并同步文档。 | 兼容性是这个项目唯一的核心资产。 |
| 7 | **测试断言 `Proposal`，不断言文案**。文案由 LLM 生成，永远不稳定。 | 断言文案的测试会在 CI 里随机红。 |
| 8 | **不引入新依赖**除非用户明确同意。一个文本游戏不需要 20 个库。 | 你删不掉的技术债最后都归用户。 |
| 9 | **改完必须自查**：跑 `npm run check:contract` + 自查下面 §7 的清单。说"应该没问题"不算完成。 | 你的自信不是证据，命令输出才是。 |
| 10 | **文档与代码同步**。代码行为变了 → 对应规范文档必须同步改；改了名字 → `03` 必须先改。 | 文档过时比没有文档更害人。 |

---

## 3. 目录地图与你的权限

```
galgame/
├── README.md            ← 给人看的入口
├── AGENTS.md            ← 本文件
├── docs/                ← 规范（可以改，但见 §4 的规矩）
│   ├── 00-总方案-v2.md
│   ├── 01-模块规范.md
│   ├── 02-数据格式.md
│   ├── 03-接口总表.md    ★ 改它要格外小心
│   ├── 04-联机与多Agent.md
│   ├── 05-内容边界与AI推演.md
│   ├── schemas/v2/      ← JSON Schema（与 03 严格对应）
│   ├── prompts/         ← 提示词模板（带 PROMPT_VERSION）
│   └── v1/              ← 归档，只读
├── content/             ← 数据即玩法
│   ├── canon/           ★ 人工锁定，AI 只读
│   ├── registry/        ← 属性/事件/意图声明
│   ├── modules/<id>/    ← 玩法模块（主要工作区）
│   ├── directors/       ← 对话导演
│   └── world/ items/ npcs/
├── packages/
│   ├── shared/          ★ 冻结契约（类型 + zod），改它 = 改所有人的编译
│   ├── engine/          ★ 引擎核心（只有项目所有者能改，见下）
│   ├── llm/             ← 网关
│   └── testkit/         ← 给模块作者的测试工具
└── apps/{server,web}/
```

**权限分级**：

| 区域 | 你能改吗 | 说明 |
|---|---|---|
| `content/modules/**` | ✅ 随便改 | 这是主战场 |
| `content/{registry,world,items,npcs}/**` | ✅ 可以 | 加属性/加数据前先读 `02-数据格式.md` |
| `content/canon/**` | ⛔ 不要动 | 世界观与客观事实由人锁定；你要改必须明确请求 |
| `docs/**`（除 `03`） | ✅ 可以 | 但要保持与 `03` 一致 |
| `docs/03-接口总表.md` | ⚠️ 谨慎 | 只允许"补充缺失条目"，不允许改动已有语义；改语义要 bump 版本并在回复中高亮 |
| `packages/shared/**` | ⚠️ 谨慎 | 契约变更影响全体；附带迁移说明 |
| `packages/engine/**` | ⛔ 默认不许 | **只有项目所有者改引擎**。你若认为必须改，先写"为什么现有扩展点不够"的分析，等人批准 |
| `docs/v1/**` | ⛔ 只读 | 历史归档 |

> 这条最关键：**引擎是闭盒**。如果你发现"必须改引擎才能实现"，99% 是用法不对（见 §4）。剩下 1% 请写清楚，别自己动手。

---

## 4. 常见任务配方（照做，不要即兴发挥）

### 4.1 加一个属性（例如"压力值 stress"）
1. 在 `content/registry/attrs.json` 的 `attrs` 数组加一条（`key/type/scope/min/max/default/visibility/display`）。
2. 如果它会随玩法变化，在对应模块里产出 `{ "op": "attr.delta", "args": { "entityId", "key": "stress", "delta": 5 } }`。
3. 前端不用改（面板读 registry 渲染）。**引擎不用改**。
4. 文档：在 `02-数据格式.md` §2 的示例表里补一行。

### 4.2 加一个玩法模块（例如"图书馆借书"）
1. 建 `content/modules/library/`：`manifest.json` + `module.ts` + `data/books.json`（+ `schema.ts` 如需校验）。
2. `manifest.json` 里声明 `id: "library"`、`apiVersion`、`capabilities`（`intents`/`tools: ["library.borrow","library.return"]`/`triggers`/`views`）、`priority`。
3. **无需登记**：启动时扫描 `content/modules/*/manifest.json` 自动加载。
4. 实现 `init/intent/tool/context/view`（按 `01-模块规范.md` 的签名），**只返回 Proposal**。
5. 写三个测试（正常/越界/抛错被隔离），用 `packages/testkit`。
6. **不要**改 `packages/engine` 任何文件。若发现做不到，停下来报告。

### 4.3 加一个事件类型
1. `content/registry/events.json` 加一条（`type`、`when`、`broadcast: true|false`）。
2. 需要消费就模块里声明 `triggers`。
3. **不改引擎**。

### 4.4 加一种 NPC 对话形态（例如"三人传闲话"）
1. 新建 `content/directors/npc.rumor.ts`，实现 `DialogueDirector` 接口（签名见 `03` §2.7、`04` §7）。
2. 在导演注册表声明（`directorId`、触发条件、`maxTurns`、`budget`）。
3. 触发处只改 `directorId`，**不改引擎**。
4. 注意：导演**不许**自己写记忆/关系，只能产出 `Proposal`；视角化写入由引擎骨架做。

### 4.5 改提示词
1. 改 `docs/prompts/*.md`（或 `content/prompts/*`）。
2. **必须 bump `PROMPT_VERSION`**：提示词是 KV 缓存前缀，改了不 bump 会让缓存命中率崩、成本翻倍，且旧会话行为不一致。
3. 在 `docs/prompts/CHANGELOG.md`（若不存在就建）记一行：版本、改了什么、为什么。

---

## 5. 禁区（做了就是 bug，不是"风格问题"）

| 禁区 | 正确做法 |
|---|---|
| 在引擎里写 `if (moduleId === "trade")` | 改成能力查询：`modules.withCapability("inventory")` |
| 模块里 `import { Arbiter } from "@galgame/engine"` | 只 import `@galgame/shared` 的契约类型 |
| 在模块里 `new OpenAI(...)` | 用 `ctx.llm.chat()`（测试会注入假实现） |
| 自己 clamp 数值 / 自己判钱够不够 | 交给 Arbiter（registry 里有 min/max），模块只提议 |
| 把秘密写进叙事里"暗示到能猜出来" | 秘密只通过 `secret_ref` 强制通道注入，表现层给"可疑细节"不给结论 |
| 用 `any` 绕过类型 | 用 zod 在边界解析一次，之后都是强类型 |
| 在测试里断言 `narrative` 的具体文字 | 断言 `proposals`、`facts`、`view` 的结构 |
| 客户端缓存权威状态 | 只渲染服务端 `View` / `Envelope` |
| 给 AI 生成的内容直接 `canon: true` | 一律 `origin: "ai"`, `canon: false`，转正走 `canonize` |
| 引入 `lodash` 只为 `groupBy` | 手写三行 |

---

## 6. 代码风格（将来写代码时）

- TypeScript `strict: true`，禁用 `any`（`unknown` + zod 解析代替）。
- **zod-first**：所有外部输入（HTTP body、LLM 输出、JSON 文件）先 zod 解析，之后才进业务。
- 命名：`camelCase` 变量/函数，`PascalCase` 类型，常量 `UPPER_SNAKE`；事件/接口名用 `03` 里的点分名，**不要驼峰化**（`"turn.patch"` 就是字符串 `"turn.patch"`，不是 `turnPatch`）。
- 错误：不 `throw` 普通 `Error` 跨模块边界，用 `{ ok:false, code: ErrorCode }`；`ErrorCode` 只在 `03` §7 里取。
- 注释写**为什么**，不写"这行在赋值"。中文注释可以，但标识符一律英文。
- 纯函数优先：模块的业务计算必须是纯函数（输入 ctx → 输出 Proposal），便于测。
- 文件 ≤ 300 行，函数 ≤ 50 行；超了就拆——这个项目的读者是"半年后的另一个人"。

---

## 7. 提交前自查（复制到你的回复里逐条打勾）

```
[ ] 我改的文件都在 §3 允许范围内（没碰 engine / canon / v1）
[ ] `npm run typecheck`、`npm test`、`npm run check:contract` 都贴了真实输出
[ ] 新增的名字都在 docs/03-接口总表.md 能查到（或我已补进去并说明了版本影响）
[ ] 没有硬编码属性名 / 实体 id / 中文标签进代码
[ ] 没有新增 op 原语；没有新增依赖
[ ] 数据变更有 schema 校验 + 迁移说明（若涉及存档）
[ ] 测试断言的是 Proposal/结构，不是文案
[ ] 受影响的规范文档已同步；提示词改了则 PROMPT_VERSION 已 bump
[ ] 我实际运行了验证命令，贴了输出（不是"应该通过"）
```

---

## 8. 与用户的协作约定

- **不确定就问**，尤其是：契约变更、删除数据、改引擎、加依赖、改 canon。这五类不要自作主张。
- **最小改动**：只改与任务相关的文件，不顺手重构、不顺手格式化整篇。
- **报告真实结果**：命令失败就贴失败输出；没跑就写"没跑"，不要含糊。
- **先方案后落地**：用户如果说"先别落地/只出方案"，就只写文档/草案，不创建代码文件、不装依赖。
- **解释取舍**：给建议时说明"为什么选 A 不选 B"，一句话即可。
- **别复述整篇文档**：回复只说结论、改动点、风险。

---

## 9. 名词速查（本项目特有）

| 词 | 含义 |
|---|---|
| **Arbiter** | 裁决器，唯一写入口：校验 `Proposal` → 应用 → 写事件日志 |
| **Proposal** | 状态变更提议 `{ op, args, reason }`，op 只能是 12 个原语之一 |
| **Op 原语** | `attr.delta` / `attr.set` / `entity.create` / `entity.update` / `entity.tombstone` / `link.create` / `link.remove` / `move.to` / `time.advance` / `scene.set` / `memory.write` / `plot.upsert` |
| **Envelope** | 统一消息信封，所有跨系统消息都套它，带 `roomId/seq/type/payload` |
| **Registry** | 数据注册表（属性/事件/意图/工具声明），引擎读它而不是写死 |
| **Module** | 玩法插件（算数），只产出 Proposal |
| **Director** | 对话导演（说话），只产出 Proposal；密谋/闲聊/争论都是它 |
| **canon / soft / x 区** | 人工锁定内容 / AI 可增删内容 / AI 临时属性 |
| **guard** | NPC 的戒备值，决定"心虚程度"的表现分档 |
| **leakPoint** | 密谋留下的可发现痕迹，玩家调查后可获得证据 |
| **Room** | 隔离单位。单人 = 1 个 actor 的房间；联机 = 多个 |

---

## 10. 如果你只有 1 分钟

记住三句话：

1. **名字查 `03`，规则查本文件，架构查 `00`。**
2. **只提议，不写库；只加数据，不改引擎。**
3. **拿不准就问，别猜。**
