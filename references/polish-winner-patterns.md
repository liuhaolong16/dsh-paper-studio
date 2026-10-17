# 借鉴：lifecycle-skills 为什么在三判盲评里赢（可落地的 5 条）

> 依据：`run/bakeoff/task-a-polish/contestants/` 四份同输入产出 + `BLIND-REVIEW-MULTI.md` 三判读数。
> 三判给 lifecycle：**19 / 20 / 15**（自然度 5 · 学术语气 5 · 信息密度 5，准确性 4 或 3）；给我方：**13 / 10 / 13**（准确性 3）。
> 下面每条都写成「**它做了什么 → 我方做了什么 → 可机检的判据**」，能进工具的就进工具，进不去的标"人读"。

## 1. 首句就是主张（claim-first），我方首句是背景
- **它**：`AI-assisted academic writing tools are widely used. Their reliability, however, is not settled: we reviewed 30 studies and found agreement on efficiency, disagreement on error introduction [12].`
  —— 第二句里**同时**有主张（not settled）、证据（30 studies）、引用（[12]）。
- **我方**：`…have become widely used as AI technology has advanced, yet their reliability remains under-examined. We reviewed 30 studies…`
  —— 首句是背景 + 一个"未充分研究"的弱断言，证据被推到第二句。
- **判据（可机检）**：`critique` 类检查 —— **第 1 句**是否含「数字 / 引用 / 明确的断言动词（found / show / report / argue）」三项中至少一项；只含背景词（widely used / has advanced / plays a role）⇒ `BACKGROUND-ONLY-OPENING`。
- 落地：接入 `polish` 的 check 或新增 `opening` 检查（**只报不改**，因为改写首句是语义操作）。

## 2. 一句里放证据，不把证据推到下一段
- **它**：30 篇 + [12] 都在第一句；第二段再出现一次 [12] 用来**分庭抗礼**（一条线记录错误 / 另一条线说核查能消除）。
- **我方**：30 篇在第二句（可接受），但 **[12] 只出现 1 次**，没有"两派各引一次"的结构。
- **判据**：同一引用标记在**论证对立面**各出现一次 ⇒ `CITATION-BOTH-SIDES`；只出现一次且段落里同时说"有分歧" ⇒ WARN。
- 这解释了为什么判者 3 觉得我方"信息更薄"——**不是丢引用，而是引用没承担论证**。

## 3. 表态（stance），而不是堆对冲（hedge-stack）
- **它**：`We read both as claims that need an error-rate test.` —— **一个明确的判断动作**（把两派都读成"需要误差率检验的主张"）。
- **我方**：`We therefore treat reliability as an open problem: the field needs error-rate evidence…` —— 意思接近，但用 `open problem / needs` 这类**回避性**名词化表达，语气偏软。
- **判据（半机检）**：动词性表态（we read / we treat as / we argue / we find）vs 名词性回避（open problem / remains to be / needs further）。**比率**可机检，但"哪个更好"属人读。

## 4. 元信息不进正文（我方这条是自己给自己扣分）
- **它**：把改动账本、自检读数**分节放**（`## Change ledger`），与正文物理隔开。
- **我方**：正文之后紧跟 `## 改动账本` + `## 自检读数（我方工具）`，且**混中文**。
- 判者要在"信息密度/学术语气"上给分时，**这些块会被当成正文的噪声**（判者 3 甚至把中文块误读成内容缺失）。
- **判据（可机检）**：`presubmit` 已有 —— 把 **元信息块（账本/自检/notes）排除出"语言质量"计分面**；并在盲评打包时**只发正文节**（`blind-pack --only-body`：按 `## 译文 / ## Rewritten text / ## Polished English` 之后、下一个 `## 改动账本|Change ledger|Notes|自检` 之前截断）。
- **这条是本轮最便宜的一分**：不改一个字的正文，只把噪声挡在评分面外。

## 5. 删限定语是"准确性"杀手（我方已修，写进结论备查）
- 我方账本自述「`一定程度上` 两处删（无量化即无信息）」⇒ 判者给 accuracy 3。
- 已落成硬约束：`polish rewrite` **对冲词守恒**（`largely/relatively/may/一定程度上/可能…` 计数不得减少，否则整篇退回）；
  写作约束写进 `paper-writing` 资产：**保留原文对冲词与限定语，宁可啰嗦不许删**。
- **判据（可机检）**：`polish-losscheck` 的 `hedge-weakened`（现为 WARN，因词表覆盖不足 ⇒ 待扩表）。

## 一句话总结
**它赢在"结构上的表态 + 证据成句"，我方输在"结构上的回避 + 证据被推后 + 元信息混入评分面"。**
前两条要改写作策略（人读主导），**后一条（元信息隔离）今天就能改，且不改正文**。
