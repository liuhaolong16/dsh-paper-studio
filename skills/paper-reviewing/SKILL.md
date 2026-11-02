---
name: paper-reviewing
description: |
  审稿、精读与返修（模拟评审 · 单篇精读 · 意见分诊 · 回复与投稿信）。要模拟审稿人、读一篇论文做精读工作单、把审稿/答辩意见分诊、或写返修回复与投稿信时
  **不用于**：投稿件本身的合规体检（paper-gates）· 纯文字润色（paper-writing）。
  Triggers on: 模拟审稿 · 审稿意见 · 返修 · 回复审稿人 · 投稿信 · reviewer · rebuttal · response to reviewers · cover letter · 文献精读 · 单篇文献。
  真源：`references/pipeline.json` 的 `skill_modules.paper-reviewing`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 审稿、精读与返修（模拟评审 · 单篇精读 · 意见分诊 · 回复与投稿信）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

要模拟审稿人、读一篇论文做精读工作单、把审稿/答辩意见分诊、或写返修回复与投稿信时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `reviewers` | **聚合评审**：置信加权均值 · champion/detractor · 拖后腿维度 · 决策风险带（含「borderline 无 champion ⇒ 向下判」） |
| `reading` | **单篇文献精读工作单**（13 个工作项：问题/动机/差异/方法/示例/数据/指标/发现/证据/边界/启发/追问/我的判断；只抽候选原文，不代替阅读；`--prompt` 打印精读提示词） |

**相关 CLI（非 agent_facing，供直接调用）**：`review` · `response` · `cover`

## 相关真源与资产

- `references/pipeline.json（handoff.contracts）`
- `bin/triage.cjs（审稿意见分诊：判定空间 + severity×effort 评分 + 分带 + 矩阵；建议值需人工确认）`
- `bin/pdf-meta.cjs（编译产物 PDF 元数据实读：Info 字典 + XMP + 分级身份检查；三态含「读不到 ⇒ 未核对」）`
- `bin/rehearse.cjs（投稿前预演：三画像模拟审稿人 + 问答预演；每条带节名与行号；**模拟≠真实意见，未命中≠没问题**）`

## 边界（这些事本模块不做）

- **咨询性、不预测结果**：风险带只帮你在还能改的时候发现问题
- 分诊未完成（有未分类项）就退 1，不许直接写 rebuttal
- 严重度＝对录用的威胁、成本＝回复窗口内的代价；同源关切被 2 个以上审稿人提出升一级

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
