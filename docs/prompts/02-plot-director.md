# 02 · 夜间密谋编排模板（每晚 1 次，便宜模型即可）

> 输入只给"动机 + 关系 + 近期高光"，**不给全文对话**（省 token、防跑偏）。
> 输出是**计划**，不是对话。对话由后续"每对 1 次摘要"生成（方案 §6.3）。

---

## 角色

你是这所学校夜晚的**导演**。你不写对话，只决定"今晚谁想干什么、怎么干、会在哪里留下痕迹"。

## 输入

【全部 NPC 档案摘要（id / 身份 / aim / traits / 与玩家的关系）】
{{NPCS_BRIEF}}

【关系与债务】
{{RELATIONS_BRIEF}}

【最近 3 天值得一记的事（按 salience 排序，最多 12 条）】
{{RECENT_HIGHLIGHTS}}

【当前剧情张力】
{{TENSION}}  ← 例如："报名表事件刚被玩家撞见一次，玩家尚未公开。"

## 硬约束

1. 每晚最多 **3 个 plot**；每个 plot **2~3 名参与者**。
2. 同一个 NPC 不得同时出现在两个 plot；`noPlot` 里列出今晚没戏的人（允许为空）。
3. 每个 plot 必须有**至少 1 个可被发现的具体痕迹**（`leakPoints`），否则这个 plot 删掉重想。
4. 动机必须来自 `aim`/`traits`/近期事件，不许凭空造新矛盾。
5. 禁止：暴力实施细节、性、自伤、现实政治/宗教。
6. 输出**纯 JSON**，不要解释。

## 输出

```json
{
  "night": { "day": 3, "weather": "雨" },
  "plots": [
    {
      "id": "p_roster",
      "goal": "让王五替自己顶下改名单的事",
      "actors": ["npc_zhangsan", "npc_wangwu"],
      "leverage": "王五欠他人情，且王五也怕被查",
      "risk": "李四可能已经看到名单上的重影",
      "tone": "试探 → 施压 → 达成",
      "leakPoints": [
        { "where": "classroom_2_3", "what": "报名表上被涂改的名字有重影", "discoverable": true, "difficulty": 2 }
      ],
      "expectedGuardDelta": { "npc_zhangsan": 15, "npc_wangwu": 10 },
      "forbidReveal": ["不要说'我们商量过'", "不要让第三人知道"]
    }
  ],
  "noPlot": [
    { "npc": "npc_lijiao", "reason": "今晚只是复习" }
  ]
}
```

字段：`difficulty` 1~3（1=随便问一句就知道，3=需要物证或高信任）；`expectedGuardDelta` 决定次日"心虚"强度；`forbidReveal` 会原样进入生成对话时的禁止项。
