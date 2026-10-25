---
name: paper-longform
description: |
  多角色长文（9 角色 路 人在环 → 机检交付）。要从零写一篇长文（学术/公众号/报告/书评/政策），需要多角色分工、批判-审计-终审回环，而不是只润色一段文字时
  **不用于**：已有成稿的格式套版与投稿门（paper-gates）· 单段润色（paper-writing）。
  Triggers on: 长文 · 深度稿 · 公众号 · 书评 · 政策解读 · 研究报告 · 多角色 · 流水线。
  真源：`references/pipeline.json` 的 `skill_modules.paper-longform`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 多角色长文（9 角色 路 人在环 → 机检交付）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

要从零写一篇长文（学术/公众号/报告/书评/政策），需要多角色分工、批判-审计-终审回环，而不是只润色一段文字时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `longform` | 多角色长文流水线（11 角色 · 11 阶段 · 人在环 3 次 · 审稿回环；文类 academic/wechat/report/book-review/policy） |

## 相关真源与资产

- `references/longform.json`
- `references/writer-integration.md`
- `bin/longform.cjs`

## 边界（这些事本模块不做）

- 只判流程状态与可机械检项（字数/结构/引用/声明/AI 痕迹）；语义质量仍由人与角色交付物负责
- 角色 prompt 只是任务书，不代替作者判断

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
