---
name: paper-presenting
description: |
  呈现与讲授（幻灯片预算 · 口播稿 · 幻灯片 lint）。论文要变成报告 / 答辩 / 课堂演讲（汇报时长已定），要做幻灯片预算、写口播稿、或检查已有幻灯片是否超时超载时
  **不用于**：论文正文写作（paper-writing）· 海报与定稿页数（后续轮次）。
  真源：`references/pipeline.json` 的 `skill_modules.paper-presenting`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 呈现与讲授（幻灯片预算 · 口播稿 · 幻灯片 lint）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

论文要变成报告 / 答辩 / 课堂演讲（汇报时长已定），要做幻灯片预算、写口播稿、或检查已有幻灯片是否超时超载时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `talk` | **讲授预算**：内容页目标（≈1 张/分钟）与硬上限 1.25×，problem-first 分节配时（**槽位时长必须由你给出，绝不臆测**） |

## 相关真源与资产

- `references/forms/class-talk.json（课堂演讲形态）`
- `references/external-adoptions.md（吸收自 lifecycle-skills，Apache-2.0）`

## 边界（这些事本模块不做）

- **槽位时长必须由用户给出**，绝不从记忆或场所档案臆测
- 备份页不占预算；标题必须是断言，非断言标题判风险

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
