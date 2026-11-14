# API / 模型事实与 token 成本模型（调研稿）

> 调研日期：**2026-11-14**（所有价格均为当日抓取；抓取后价格可能变动，上线前请复核 URL）
> 标注约定：**[官方]** = 厂商官方文档页面；**[二手]** = 博客/资讯/第三方价格站，仅作交叉参考；**[未验证]** = 本次未抓到可确认来源。
> 说明：本环境中各厂商文档已进入 **2026 年 Q4 的模型代际**（DeepSeek V4 / Qwen3.8 / GLM-5.3 / Kimi K3.1 / MiniMax M3），任务书里写的 `deepseek-chat`/`deepseek-reasoner`、`qwen-plus` 等旧标识**已不在当前官方价格表**，见 §1.1。

---

## 0. TL;DR（给方案的 5 条硬结论）

| # | 结论 | 依据 |
|---|---|---|
| 1 | **文本推理最便宜的是 DeepSeek-Flash 与 Qwen3.8-Flash / GLM-5.3-Flash**，标准档约 **28~31 元/千回合**（无缓存 ~36~72 元/千回合）；旗舰档（v4-pro、Kimi K3.1 Pro、qwen3.8-max）贵 **4~16 倍** | §2、§5 |
| 2 | **DeepSeek 缓存命中价 = 未命中价的 2%**（峰时 0.04 vs 2 元/百万），多轮游戏几乎每回合都重发全量历史，**开缓存后标准档降本 57%、豪华档 64%**；且缓存**默认开启、无需改代码** | §1.4、§5.4 |
| 3 | **JSON 模式最大的坑在 DeepSeek**：prompt 必须含 `json` 字样并给样例；输出非 JSON 时官方会把非 JSON 内容**替换为空格 U+0020**，`content` 可能整段是空格而 `finish_reason` 仍是 `stop` → 必须做「空 content 兜底重试」 | §1.3 |
| 4 | 三档单回合成本（DeepSeek-Flash 峰时，含缓存）：**极简 ≈0.014 元 / 标准 ≈0.031 元 / 豪华 ≈0.060 元**；200 回合/天月成本分别 **84 / 185 / 363 元**。内测阶段文本成本基本可忽略 | §5 |
| 5 | **美术成本远低于文本**：40 张（12 立绘 + 8 场景 + 20 CG）用 Qwen-Image 2.1 约 **4~10 元**一次性；可灵 Image 3.0 约 0.2 元/张（≈8 元/40 张）。建议「立绘/背景用便宜图像模型 + 关键 CG 才升级」 | §4 |

---

## 1. DeepSeek API 现状（官方）

### 1.1 模型标识与能力 [官方] https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-11-14 抓取）

| 项目 | deepseek-flash | deepseek-v4-pro |
|---|---|---|
| 版本 | DeepSeek-V4.1-Flash-1017 | DeepSeek-V4-Pro-0813 |
| 上下文长度 | **1M** | 1M |
| 最大输出 | 384K | 384K |
| 思考模式 | 支持非思考 + 思考模式（**默认思考**） | 同左 |
| JSON Output | ✅ | ✅ |
| Tool Calls | ✅ | ✅ |
| 图像理解 | ✅ | ❌ |
| 并发（账号级） | **2500** | **500** |

- BASE URL：OpenAI 格式 `https://api.deepseek.com`；Anthropic 格式 `https://api.deepseek.com/anthropic`。[官方]
- **旧模型名状态**：价格页只列上述两个模型；官方注明「旧模型名 `deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 仍可调用，但对应模型已下线，由 V4.1-Flash 提供服务」。`deepseek-chat` / `deepseek-reasoner` **在当前价格页已不存在**，是否仍作为别名可调用 **[未验证，需实测]**——方案里不要再写这两个名字。
- **思考模式默认开启**，而思维链 token 按**输出价**计费；文字游戏叙事不需要长推理，服务端应显式关闭思考模式或限制其预算（`reasoning` 相关参数见 [官方] /zh-cn/guides/thinking_mode）。

### 1.2 人民币定价（元 / 百万 tokens）[官方]

| 模型 | 输入·缓存命中（闲时/峰时） | 输入·未命中（闲时/峰时） | 输出（闲时/峰时） |
|---|---|---|---|
| **deepseek-flash** | **0.02 / 0.04** | **1 / 2** | **4 / 8** |
| **deepseek-v4-pro** | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

- 时段规则：北京时间**周一至周五 9:00–12:00、14:00–18:00 为高峰**（法定节假日除外），其余时间（含周末全天）**半价**。[官方]
- 计费 = 输入 token × 输入单价 + 输出 token × 输出单价；优先扣赠送余额。[官方]

### 1.3 JSON Output 的 4 条硬前提（踩坑点）[官方] https://api-docs.deepseek.com/zh-cn/guides/json_mode

1. 设置 `response_format={"type":"json_object"}`；
2. **system 或 user prompt 里必须出现 `json` 字样，并给出期望输出的 JSON 样例**（否则可能不生效/输出非 JSON）；
3. 必须合理设置 `max_tokens`，防止 JSON 被截断；
4. ⚠️ **输出无法被识别为 JSON 时，API 会把非 JSON 内容替换成空格（U+0020）**，返回的 `content` 可能只剩空格，而 `finish_reason` 仍可能是 `stop` → **服务端必须对空 content 兜底（重试/prompt 修正）**。
- Tool calling 与 JSON Output 可同时使用；但 DeepSeek 是否提供严格 schema 约束（类似 OpenAI `json_schema`/strict）**[未验证]**，目前按「json_object + 样例」用最稳。

### 1.4 上下文硬盘缓存 [官方] https://api-docs.deepseek.com/zh-cn/guides/kv_cache

| 事实 | 内容 |
|---|---|
| 开关 | **默认开启，无需改代码**；缓存构建秒级；不再使用后自动清空（数小时~数天） |
| 计量字段 | `usage.prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` |
| 命中条件 | 需**完整匹配「缓存前缀单元」**；多轮对话天然命中（第 2 轮起命中上一轮整体前缀） |
| 落盘时机 | ① 每次请求的用户输入结束位置、模型输出结束位置各生成一个前缀单元；② 系统检测到多轮公共前缀时单独落盘；③ 长输入/输出按固定 token 间隔截取单元 |
| 省多少 | 命中输入价为未命中的 **2%**（峰 0.04 vs 2）；标准档实测口径**总成本降 57%** |
| 注意 | 「尽力而为」，**不保证 100% 命中**；`user_id` 可用于 KVCache 隔离（多玩家互不污染） |

### 1.5 限速 / 隔离 [官方] https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit

- 并发按**账号**计（与 API Key 无关）：flash 2500、v4-pro 500；超限返回 **HTTP 429**。
- 一个请求从发出到响应完成算一个并发；请求发出后 10 分钟仍未开始推理，服务器断连。
- 可提交扩容工单，扩容不额外收费；`user_id` 参数用于内容安全隔离、KVCache 隔离与调度隔离。

---

## 2. OpenAI 兼容备选通道对比（DeepSeek 为主，其余为备份/多厂商兜底）

| 厂商 | base_url | 代表模型（当前代际） | 输入 / 输出（元/百万 tokens） | 上下文 | 缓存 | JSON | 来源可信度 |
|---|---|---|---|---|---|---|---|
| **DeepSeek** | `https://api.deepseek.com` | deepseek-flash / deepseek-v4-pro | 1~2 / 4~8（flash，闲/峰）；4.5~9 / 13.5~27（pro） | 1M | 命中 2% 价 | json_object | [官方] |
| **阿里云百炼 DashScope** | `https://dashscope.aliyuncs.com/compatible-mode/v1`（官方文档明确 base_url 以 `/compatible-mode/v1` 结尾，按地域分站） | qwen3.8-flash / qwen3.7-plus / qwen3.8-max | flash ≈**0.8 / 2.7**；max ≈11.7 / 35.2（$1.65/$4.951×7.1） | flash 1M；max 1M | 缓存输入约 **10%** 价（官方称显式写入 125%、命中 10%） | 有「结构化输出」文档（json_object） | [官方]价格页为 USD 国际站口径；人民币大陆价 **部分未验证**，0.8/2.7 为 [二手] 佐证 |
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4`（[官方] 文档约定） | GLM-5.3 / GLM-5.3-Flash / GLM-5.3-FlashX | **8 / 28**；**0.8 / 2.8**；2 / 7 | 1M | 缓存命中 2 / 0.23 / 0.57 | 有「结构化输出」能力页 | [官方] |
| **月之暗面 Kimi** | `https://api.moonshot.cn/v1`（[官方] API 文档域名，`platform.kimi.com` 为控制台） | kimi-k3.1-pro / kimi-k3 | **13 / 68**（缓存命中 1.3，缓存写入 13） | 1M | 自动前缀缓存，TTL 默认 5min | OpenAI 兼容 `response_format` [未验证细节] | 价格数字来自 [官方] 站点文案（Tavily 摘要）+ [二手] trae 计费页一致 |
| **MiniMax** | `https://api.minimax.chat/v1`（[未验证]，官方 OpenAI 兼容端点） | MiniMax-M3 / M3.1-Flash | M3 ≈**3.2 / 12.8**（$0.45/$1.80 五折期）；M3.1-Flash **1 / 4**（[二手]） | 1M | M3 缓存读 $0.09/M | OpenAI 兼容 [未验证] | 官方 pricing 页 **fetch 失败**，数字取自 [官方] 页搜索摘要 + [二手] |

补注：
- 百炼的**人民币大陆价**在官方页里以 `$` 混排（多地域），本次抓取被截断；若要用人民币结算的 Qwen，请以控制台账单页为准。[官方] 页面更新时间 Nov 12, 2026。
- 百炼官方另有 **Batch 调用半价**、**上下文缓存折扣**，两者不能同时生效。[官方]
- Kimi：K3 系列批量推理（Batch）为标准价 60%；K2 系列 2026-10-31 起停止对新用户开放、12 月底下线。[官方]
- GLM：缓存**存储**目前「限时免费」（元/百万 tokens/小时）。[官方]

### 2.1 中文 token 估算口径（做成本模型必须先定）
- GLM 官方：Token 与汉字约 **1:1.6**（[官方] 计费基本概念）。
- Kimi 官方：约 **1 token ≈ 1.5~2 个汉字**（[官方] 计费单元）。
- 本报告统一取 **1 token ≈ 1.6 汉字**，即 1000 汉字 ≈ 625 tokens。

---

## 3. JSON / 结构化输出能力横向（游戏服务端最关心）

| 能力 | DeepSeek | Qwen(DashScope) | GLM | Kimi | MiniMax |
|---|---|---|---|---|---|
| `response_format={"type":"json_object"}` | ✅ 需 prompt 含 `json`+样例 | ✅ 有结构化输出文档 | ✅ 有结构化输出文档 | ✅（OpenAI 兼容）[未验证] | ✅（OpenAI 兼容）[未验证] |
| 严格 schema 校验（json_schema/strict） | [未验证] | [未验证] | 文档见「结构化输出」能力页 [未验证细节] | [未验证] | [未验证] |
| 非 JSON 兜底行为 | ⚠️ 非 JSON 内容被替换为空格，content 可能为空白但 finish_reason=stop | 文档未说明 [未验证] | [未验证] | [未验证] | [未验证] |
| Tool calling | ✅ | ✅ | ✅（function-calling 文档） | ✅ | ✅ |

**工程建议**：把「叙事输出」与「状态变更」拆成两次调用或两段 JSON——叙事文本走自然语言（可流式），状态变更（好感度/物品/时间）走强 JSON 的小请求；不要指望一次调用里既要长文笔又要严格 JSON。

---

## 4. 美术资产（立绘 / 背景 / 关键 CG）

| 服务 | 是否开放 API | 计费（抓到的口径） | 来源可信度 |
|---|---|---|---|
| **通义万相 Qwen-Image 2.1** | ✅ DashScope 图像生成 API | **pro $0.0353/张**、turbo **$0.0141/张**（国际站）；大陆人民币价 **[未验证]** | [官方] 价格页（USD 口径） |
| **可灵 Kling Image 3.0** | ✅ 官方开放平台 + 百炼内代理 | **8 积分/张**，官方标注「1 积分 = 0.025 元」→ **≈0.2 元/张**（1K/2K）；4K 16 积分 ≈0.4 元/张 | [官方] 页 + [二手] Tavily 摘要（正文 JS 未抓到） |
| **可灵 Kling 视频 4.0** | ✅ | 按秒计费，720P **1.0 积分/秒**；第三方实测 Kling 3.0 Omni **≈0.43 元/秒**、Q3 720P **≈0.9 元/秒** | [官方] 页摘要 + [二手] 知乎/36氪 |
| **MiniMax 海螺 Hailuo** | 视频 API 存在 | 本次**未抓到价格** [未验证] | — |
| **GLM-Image** | ✅ 智谱有 GLM-Image 模型页 | 价格本次未抓 [未验证] | [官方] 模型页存在 |

**成本最低路线（建议）**
1. **立绘 12 张 + 场景背景 8 张**：Qwen-Image 2.1 turbo 或 可灵 Image 3.0，**40 张总成本 4~10 元**，几乎为零。
2. 角色一致性靠「参考图生图」而非纯文生图（可灵/万相都支持参考图），一致性差就固定 seed + 同一参考图。
3. **关键 CG 才升级**（更高分辨率/4K 或重绘 2~3 次挑图），单张 ≈0.2~0.4 元，几十张也只是十几元。
4. **视频/CG 动画是唯一烧钱项**（0.4~0.9 元/秒）：内测阶段用「静态图 + 前端 CSS 动效/抖动」替代，正式版只给关键剧情做 3~5 秒短片。
5. 资产一次性生成后**本地缓存复用**，不要每回合实时生图。

---

## 5. 成本模型（1 次玩家行动 = 1 次主对话 + 0~3 次 NPC/世界推演）

### 5.1 假设（可替换参数，服务端应可配置）

| 参数 | 极简(A) | 标准(B) | 豪华(C) |
|---|---|---|---|
| 主调用输入（系统提示+世界状态+角色卡+历史） | 7,500 tok（≈8K 上下文） | 24,000 tok | 60,000 tok |
| 主调用输出（叙事） | 700 tok | 900 tok | 1,200 tok |
| NPC/世界推演次数 | 1 | 2 | 3 |
| 每次推演 输入/输出 | 1,500 / 200 tok | 3,000 / 300 tok | 5,000 / 400 tok |
| 主调用缓存命中率 | 70% | 80% | 85% |
| 推演调用缓存命中率 | 30% | 30% | 30% |
| 计价模型 | deepseek-flash 峰时价（最坏情况）：miss 2 / hit 0.04 / out 8 元/百万 | 同左 | 同左 |

> 缓存命中率是**最关键变量**：系统提示、角色卡、世界设定等稳定前缀放前面 → 后续回合几乎全命中；把玩家输入/时间戳放前面会直接毁掉缓存。

### 5.2 单回合与大数量成本（deepseek-flash，峰时 / 闲时）

| 档位 | 单回合（峰/闲） | 每千回合（峰/闲） | 10 回合/天·月 | 50 回合/天·月 | 200 回合/天·月 |
|---|---|---|---|---|---|
| **A 极简 8K** | **0.0140 / 0.0070 元** | **14.0 / 7.0 元** | 4.2 / 2.1 元 | 21.0 / 10.5 元 | **84.2 / 42.1 元** |
| **B 标准** | **0.0308 / 0.0154 元** | **30.8 / 15.4 元** | 9.3 / 4.6 元 | 46.3 / 23.1 元 | **185.0 / 92.5 元** |
| **C 豪华** | **0.0604 / 0.0302 元** | **60.4 / 30.2 元** | 18.1 / 9.1 元 | 90.6 / 45.3 元 | **362.5 / 181.3 元** |

> 「月」按 30 天。表中为**单玩家**口径；100 名同时在线玩家 ×50 回合/天（标准档）≈ **154 元/天 ≈ 4,600 元/月**。

### 5.3 缓存关掉会怎样（同一 B 档、无缓存、对比）

| 模型 | 无缓存 元/千回合 | 开缓存后（本报告 B 档假设） | 降幅 |
|---|---|---|---|
| deepseek-flash 峰 | 72.0 | 30.8 | **−57%** |
| deepseek-flash 闲 | 36.0 | 15.4 | −57% |
| deepseek-v4-pro 峰 | 310.5 | —（更高缓存收益） | — |

单回合输入里**历史部分越大，缓存收益越大**，所以「标准/豪华档」比「极简档」更该开缓存（极简档省 44%，豪华档省 64%）。

### 5.4 每千回合横向对比（统一 B 档口径：30K 输入 + 1.5K 输出，人民币，无缓存）

| 模型 | 元/千回合 | 相对 cheapest |
|---|---|---|
| **Qwen3.8-Flash**（¥0.8 / ¥2.7） | **28.1** | 1.00× |
| **GLM-5.3-Flash**（¥0.8 / ¥2.8） | **28.2** | 1.00× |
| deepseek-flash（无缓存·闲时 ¥1/¥4） | 36.0 | 1.28× |
| MiniMax M3.1-Flash（¥1 / ¥4，[二手]） | 36.0 | 1.28× |
| deepseek-flash（无缓存·峰时 ¥2/¥8） | 72.0 | 2.56× |
| MiniMax-M3（$0.45/$1.80 五折期） | 115.0 | 4.09× |
| GLM-5（32K 内 ¥4/¥18） | 147.0 | 5.23× |
| GLM-5.3（¥8/¥28） | 282.0 | 10.0× |
| deepseek-v4-pro（峰 ¥9/¥27） | 310.5 | 11.0× |
| Qwen3.8-Max（$1.65/$4.951） | 404.2 | 14.4× |
| Kimi-K3.1-Pro（¥13/¥68） | 492.0 | 17.5× |

> 汇率按 1 USD = 7.1 CNY 粗算；实际以账单为准。DeepSeek 的**缓存命中**优势没有体现在上表（上表按无缓存），实际 B 档开缓存后 30.8 元/千回合，与最便宜的 Flash 同级。

### 5.5 选型建议（给方案直接用）
1. **主叙事**：deepseek-flash（峰时 2/8）+ 缓存 + 关闭思考模式；预算极紧可切 qwen3.8-flash / glm-5.3-flash 做 A/B。
2. **NPC 私下密谋/世界推演**：用同族更便宜档或 flash 的非思考模式，输出压到 200~400 tok；不必上旗舰。
3. **需要长上下文（1M）+ 严格多步一致性**：deepseek-v4-pro 或 kimi-k3.1-pro，但成本是 flash 的 4~16 倍，**只在关键章节启用**。
4. **缓存优先设计**：prompt 前缀顺序固定为 [系统规则 → 角色卡 → 世界设定 → 近期剧情摘要 → 本轮玩家输入]，且给每个玩家固定 `user_id` 做缓存隔离。
5. **JSON 走小请求**：状态变更单独一次 200 tok 级 JSON 调用（带样例、max_tokens 留余量、空 content 重试），不要混进长叙事调用。

---

## 6. 数据可信度分级

| 数据 | 级别 | 备注 |
|---|---|---|
| DeepSeek 价格/上下文/并发/缓存/JSON 规则 | **官方** | 4 个官方页，2026-11-14 抓取 |
| GLM 价格表（5.3/5.3-Flash/5.3-FlashX/5/5.1/5-Turbo） | **官方** | docs.bigmodel.cn 定价页 |
| Qwen 国际站 USD 价格、Batch 半价、缓存 125%/10% 规则 | **官方** | alibabacloud model-pricing（Nov 12, 2026 更新） |
| Qwen 大陆人民币价（qwen3.8-flash ¥0.8/¥2.7、缓存 ¥0.1） | **二手** | devtk.ai / bestmodelfor.ai / X 帖；官方页被截断未取到 |
| Kimi K3.1 Pro ¥13/¥68/缓存 1.3 | **官方站点文案 + 二手一致** | 官方定价页表格为 JS 渲染，抓取未取到表格本体 |
| MiniMax 价格 | **二手/官方摘要** | 官方 pricing 页 fetch 失败；M3 $0.45/$1.80 来自官方页搜索摘要，M3.1-Flash ¥1/¥4 来自腾讯云社区 |
| 可灵图片 8 积分/张、1 积分=0.025 元 | **官方页摘要** | 页面 JS 渲染，正文未抓到；建议下单前控制台复核 |
| 可灵视频 0.43~0.9 元/秒 | **二手** | 知乎实测 / 36氪 |
| MiniMax 海螺视频价格、GLM-Image 价格、Kimi/MiniMax 严格 schema 支持 | **[未验证]** | 本次未抓到，不可写进对外报价 |
| 成本模型所有数字 | **推算（基于上述官方价 + 5.1 假设）** | 假设变了数字就变，服务端应实测校准 |

---

## 7. 参考来源（全部于 2026-11-14 抓取）

**官方**
1. https://api-docs.deepseek.com/zh-cn/quick_start/pricing — 模型 & 价格（含人民币价、并发数）
2. https://api-docs.deepseek.com/zh-cn/guides/json_mode — JSON Output 前提与空格替换坑
3. https://api-docs.deepseek.com/zh-cn/guides/kv_cache — 上下文硬盘缓存规则
4. https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit — 并发限速 / user_id 隔离
5. https://docs.bigmodel.cn/cn/guide/start/pricing — 智谱 API 定价
6. https://platform.kimi.com/docs/pricing/chat — Kimi 模型推理定价（表格 JS 渲染）
7. https://help.aliyun.com/zh/model-studio/model-pricing（镜像 https://www.alibabacloud.com/help/zh/model-studio/model-pricing，更新 Nov 12 2026）— 百炼模型价格
8. https://help.aliyun.com/zh/model-studio/qwen-structured-output — 千问结构化输出
9. https://help.aliyun.com/en/model-studio/base-url + https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope — DashScope base_url（`/compatible-mode/v1`）
10. https://klingai.com/dev/pricing — 可灵 API 定价（JS 渲染，仅取到摘要）
11. https://platform.minimax.io/docs/pricing/overview — MiniMax 定价页（本次 fetch 失败）

**二手（仅交叉参考）**
12. https://devtk.ai/zh/models/qwen-3-8-flash 、https://bestmodelfor.ai/models/qwen3.8-flash — Qwen3.8-Flash 人民币价
13. https://docs.trae.cn/enterprise_billing-items — 第三方汇总的 Kimi/GLM/DeepSeek 计费项
14. https://cloud.tencent.com/developer/article/2764558 — MiniMax M3.1 Flash ¥1/¥4
15. https://zhuanlan.zhihu.com/p/2032401642809725873 、https://m.36kr.com/p/4025642512896130 — 视频生成实测单价
16. https://www.allagent.wiki/changelog/2026-10-14-bailian-qwen38-flash-payg-pricing — 百炼 Qwen3.8-Flash 计价变动
