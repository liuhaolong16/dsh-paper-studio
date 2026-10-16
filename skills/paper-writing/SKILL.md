---
name: paper-writing
description: |
  写作与文字（润色 · 文风 · 中英通道 · 图表规格 · 双盲匿名化）。要把某段或整篇改到能投、要去 AI 味、要做中英双向转换、要体检图表题注与规格、或要生成双盲匿名版时
  **不用于**：改动方法论与数据（那不属文字层）· 引用格式（paper-citing）。
  Triggers on: 润色 · 改语言 · 去AI味 · 中英互译 · 图表题注 · 图表规格 · 双盲匿名 · polish · rewrite · AI tone · figure caption · anonymize。
  真源：`references/pipeline.json` 的 `skill_modules.paper-writing`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 写作与文字（润色 · 文风 · 中英通道 · 图表规格 · 双盲匿名化）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

要把某段或整篇改到能投、要去 AI 味、要做中英双向转换、要体检图表题注与规格、或要生成双盲匿名版时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `stylecheck` | 写作质量机检（HARD＝低信息化开头；SOFT＝填充词/hedge/模糊词/贡献句/摘要无数字） |
| `polish` | **LaTeX 保真守卫**（数学与命令必须原样；抓新引入的未转义特殊字符；`\item`/破折号 warn） |
| `revise` | 审稿回复：逐条 4 段骨架；有回应时机检**覆盖/空话/承诺未兑现/对抗措辞** |
| `anonymize` | **双盲投稿匿名化**：抹作者/单位/邮箱/ORCID/电话/基金号/致谢整节，**逐条记 original→replacement 进清单**（清单用于复核与还原，不写进正文）；自引表述与仓库链接**只提醒不擅改**；既无名单又无作者行 ⇒ 明确「未检查」退 1；**文档属性(docx/PDF 元数据)与图内水印不在覆盖范围**（如实标注） |
| `figures` | 题注体检（硬判据＝"见正文"；缺 n/单位只提示）· `figures recommend` 绘图建议 · `figures arch` 架构图 Mermaid 源码 |

## 相关真源与资产

- `assets/phrase-bank.json（本仓自产词库）`
- `references/pipeline.json（篇幅预算 budget_words）`
- `references/external-adoptions.md`
- `bin/figures-kit.cjs（自研图模板生成 + 九条图法判据复核）· references/figure-style-rubric.md`

## 边界（这些事本模块不做）

- **改动账本**：每处改动必须留 kind 与 reason，缺了拒收
- LaTeX 保真：公式原样，百分号 / 下划线 / 和号的转义不得破坏命令
- 去 AI 味只给可替换项与行号，**密度只作 advisory**

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
