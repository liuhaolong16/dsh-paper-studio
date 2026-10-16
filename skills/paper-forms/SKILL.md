---
name: paper-forms
description: |
  形态与开稿（论文形态 · 体裁 · 骨架 · 任务书）。要开一篇新稿、要判断该按哪种形态走（学位论文 / 开题 / 课程论文 / 会议 / 期刊 / 课堂演讲）、或要出章节骨架与写作任务书时
  **不用于**：已经成稿后的润色、引用核对与投稿体检（分别走 paper-writing / paper-citing / paper-gates）。
  Triggers on: 开题 · 选形态 · 起稿 · 章节骨架 · 写作任务书 · thesis · proposal · outline · paper type。
  真源：`references/pipeline.json` 的 `skill_modules.paper-forms`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 形态与开稿（论文形态 · 体裁 · 骨架 · 任务书）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

要开一篇新稿、要判断该按哪种形态走（学位论文 / 开题 / 课程论文 / 会议 / 期刊 / 课堂演讲）、或要出章节骨架与写作任务书时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `route` | 判类型 + 出链路 + 出必过门 + 出**期刊分类路由**（该读哪份资产 + 存在性 + 边界） |
| `intake` | 登记稿件 + 出体检前检查项（语言判错可 --lang zh/en 覆盖） |
| `genre` | 判**稿件体裁**（empirical/review/methodological/secondary-analysis）→ 决定哪些门适用 |
| `scaffold` | **开一篇新稿：按 S0–S7 生成骨架 + 复制现成模板** |
| `draft` | node bin/studio.cjs draft --out "<你的稿件目录>" --name "论文名" --journal "目标刊" --lang en |
| `sections` | **章节级框架**（每节：解决什么/必答/篇幅/证据义务/门/常见退回） |

## 相关门

- `author-material（作者材料前提门）`

## 相关真源与资产

- `references/pipeline.json（task_types / stage_kinds / handoff.contracts）`
- `references/forms/*.json（六形态：框架 / 格式 / 方法论 / 核心 / 工作流 / 重点 / 字数）`
- `references/templates.json`

## 边界（这些事本模块不做）

- 不判断投稿去向与期刊匹配（那要期刊契约与选刊资料，见 paper-gates 与 paper-citing）
- 不生成正文（只给骨架、必答问题与证据义务）

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
