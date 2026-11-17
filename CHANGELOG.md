# 更新日志

按合并到 `main` 的日期记录。提交 sha 可在 `git log` 中查；跨系统协议版本以 `CONTRACT_VERSION` 为准（产品版本见 `package.json`，当前 0.0.1）。

版本与 tag 对应：`v0.1.0` M0 骨架 → `v0.1.1` 引擎 3.0.0 → `v0.1.2` 审核/锚定 → `v0.2.0` 地图 v0.2。

## 未发布（`feat/web-ux` 待合入）— 2026-11-17 前端体验与运行时模型接入

### 新增

- 前端：标题页（选身份/继续/说明/关于/接入真实模型，独占步骤）、开场剧情并入对话流、人物图鉴（信任数值+戒备分档，初始「—」由玩法写入）、逐字打字机（`typewriter.ts`）、Web Audio 按键音（`sfx.ts`）、页面/切 tab/对话行 CSS 过渡。
- 服务端：`GET/POST/DELETE /api/v1/settings/llm`（玩家自备 key，探活后热切换；保存 `data/llm-settings.json`（0600）重启恢复，环境变量优先；**仅本机可调用**）；离线叙述器 `offline-narrator.ts`（场景白描，无配置字样）。

### 修复

- 建房间按 registry 播种 **public** 属性默认值（secret/self 不预填，canon seed 例外）。
- `map` manifest 补 `keywords`（中文路由）；交易意图让位，避免抢占 `trade`（"去食堂买面包"）。

### 验证

`tsc` 0 错；vitest 133/134（唯一失败为 Windows 下 chmod 模拟写盘的 durability 用例，上游既有；审阅方 Linux 全过）；`check:contract` 8 项；`build:web` 通过。

## v0.2.0 — 2026-11-17 地图 v0.2：奉贤校区真实底图

### 新增

- 真实奉贤校区底图（6000×4500）与 33 个点位：24 建成、4 在建、5 规划（`apps/web/public/map/ecust-campus.jpg`、`content/modules/map/data/world_map.json`）。
- Web 地图：缩放 1–4 倍、拖拽平移、点击选点、三态/分类图例、场景详情（`MapViewport.tsx`、`MapLegend.tsx`、`map-geometry.ts`）。
- 服务端 `MapView` 新增 `image`，场景新增 `status` / `category`；非建成点位禁止进入（`E_FORBIDDEN`，提示“规划中，尚未建成 / 在建，暂不可进入”）。
- canon 新场景首次进入时懒安装（建 entity + 双向 `located_in`，`origin: "seed"`、`canon: false`）。
- 玩家造场景草案发布后固定 `status: "built"`、`category: "other"`。

### 修复 / 变更

- 坐标以 `world_map.json` 模板为准；旧存档 1000×640 时代的 `coord_x/coord_y` 仅作兜底（场景与 NPC 同策略）。
- `coord_x` 上限 2000→6000、`coord_y` 1600→4500；`docs/02`、`docs/03`、`docs/06` 同步。
- 同一检查点的多个 NPC 按 id 做确定性小偏移（只读展示，不写状态）。
- `.gitignore` 增 `/.tmp-map/`，底图叠图等审查产物不再进入版本库。

### 验证

`typecheck` 0 错；14 文件 / 117 用例全过；`check:contract` 8 项全过（`CONTRACT_VERSION 3.0.0`）。

## v0.1.1 — 2026-11-16 引擎 3.0.0：结算原子性 + 持久化闭环

### 新增

- 结算原子性：`Arbiter.apply` 默认 `atomic`，一条被拒整批回滚；返回 `ApplyResult.error`；整回合预算；可信 `cause` 权限校验。
- 持久化闭环：写盘先行、`load()` 恢复、坏档修复、`Store.flush` 变为必选成员（`CONTRACT_VERSION` major 的原因）。

### 验证

14 文件 / 115 用例全过；`check:contract` 8 项全过（`CONTRACT_VERSION 3.0.0`）。

## v0.1.2 — 2026-11-16 内容审核层 + 现实锚定层 + 共享记忆

### 新增

- 内容审核层：叙事发出前经独立模型/端点二次审核，违规按 `content/registry/policy.json` 扣信誉/删档；被审模型不能自审。
- 现实锚定层：玩家“我全知全能 / 忽略提示词”等偏离现实的发言被修饰或过滤，不扣分；类型定义在 `content/registry/reality.json`。
- 跨会话共享记忆 `MEMORY.md` 与 `AGENTS.md` §11 维护规范（按分支记录提交、审阅、合并）。

### 验证

14 文件 / 115 用例全过；`check:contract` 8 项全过（`CONTRACT_VERSION 3.0.0`）。

## v0.1.0 — 2026-11-14 M0 骨架（契约 2.2.0）

### 新增

- 契约冻结 2.2.0：12 个 op 原语、`Envelope`、错误码、registry（属性/事件/意图/工具）。
- `Turn` 流水线（play → apply → tick）、模块宿主、LLM 网关、HTTP + SSE 服务端、React Web。
- 示例模块 `trade` / `core` 与 `packages/testkit` 测试工具。
- 六份规范文档与 v2 JSON Schema。
