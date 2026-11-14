# 01 · 主叙事调用模板（每回合 1 次）

> 服务端组装顺序（**前缀稳定优先**，见方案 §4.6）：
> `system 消息 = 00-world-system.md` → 再拼下面这份 user 消息。
> `PROMPT_VERSION: 2026-11-14.1`

---

## 【当前角色】

```json
{{NPC_CARD_JSON}}
```

> 没有对话对象时（玩家独自行动/观察）整段省略。
> 字段说明：`persona.speech` 决定他怎么说；`persona.aim` 是他在乎的事；`relations.player` 是他对你的态度。
> `secrets` **只供你判断"他会不会露破绽"**，绝不能被说出口（见 00 号文件规则 4）。

## 【当前场景】

- 时间：第 {{DAY}} 天 · {{PHASE_CN}} · 天气 {{WEATHER}}
- 地点：{{LOCATION_NAME}}（{{LOCATION_TAGS}}）
- 在场：{{PRESENT_NPCS}}
- 玩家状态：体力 {{STAMINA}} / 金钱 {{MONEY}} / 智力 {{INTELLECT}} / 声望 {{REPUTATION}}
- 与当前对话者的关系：信任 {{TRUST}}，畏惧 {{FEAR}}，人情 {{DEBT}}

## 【你记得的事】

> 这些是当前视角角色（对话对象，或玩家自己）私有的记忆，别人不知道。

{{MEMORY_BLOCK}}

## 【最近发生】

{{RECENT_TURNS}}

## 【本回合的既成事实】（只能描述，不能推翻）

{{FACTS}}

> 由引擎/模块给出，例如："玩家购买了 2 个面包，花费 6 元，手中剩 14 元。" 叙事必须与此一致。

## 【玩家本次行动】

"{{PLAYER_INPUT}}"

## 【额外要求】

{{MODULE_CONTEXT}}

> 模块可能注入临时规则，例如交易模块："本次交易已结算，只需描写老板的表情与动作。" 没有则留空。

---

## 写作清单（提交前自检）

- [ ] 第二人称，无"玩家"字样
- [ ] 没有替玩家说话/下结论
- [ ] 在场者才出现
- [ ] 秘密未被说出（只给可疑细节）
- [ ] 没有数值宣告
- [ ] 120~200 字
- [ ] 对话 ≤3 条，符合 `speech` 特征
- [ ] 输出纯 JSON，字段顺序 narrative→dialogue→proposals→memory→scene→flags
