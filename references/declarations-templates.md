# 声明段模板（CRediT / 利益冲突 / 资助 / 中文刊页脚）

> **红线**：模板里的三处**必须由作者提供**，机器不得代填、不得编造：① 每位作者的**贡献角色归属**；② **基金名称与项目编号**；③ **是否存在利益冲突**（有则列出）。
> 本文件只提供**合规措辞与结构**；填不实的声明比缺声明更糟（可能构成学术不端）。

## 1. CRediT 作者贡献声明（英文，Elsevier/PLOS/BMC 通用）

角色名必须用官方 14 角色**逐字写法**（见 `references/credit-roles.json`；注意 `Writing – original draft` 里是 **en dash**）。可用 `node bin/studio.cjs credit <文件>` 自检：

```markdown
## CRediT authorship contribution statement

**<Author A>**: Conceptualization, Methodology, Software, Writing – original draft.
**<Author B>**: Data curation, Formal analysis, Visualization.
**<Author C>**: Supervision, Funding acquisition, Writing – review & editing.
```

## 2. Declaration of Competing Interest（英文）

```markdown
## Declaration of competing interest

The authors declare that they have no known competing financial interests or personal relationships
that could have appeared to influence the work reported in this paper.
```
> 若确有利益冲突：把上句换成逐条列明（与某机构的关系/资助/专利等），**不得为了"干净"而写"无"**。

## 3. Funding（英文）

```markdown
## Funding

This work was supported by <Funder Full Name> [grant number <ID>].
```
> 无资助时写规范表述（如 `This research did not receive any specific grant from funding agencies in the public, commercial, or not-for-profit sectors.`）。
> **注意逐刊差异**：PLOS 要求资助**只在投稿系统**填（稿件内不得出现，见 `contracts/plos-one.json` 的 `funding_in_manuscript: false`）；Elsevier 系常写在 Funding 或 Acknowledgements 节。

## 4. 中文刊（页脚 + 声明）

```text
收稿日期：YYYY-MM-DD
基金项目：<基金名称>（<项目编号>）
作者简介：<姓名>（<出生年>—），<性别>，<籍贯>，<职称>，<学位>，研究方向：<方向>。
通信作者：<姓名>，<职称>，Email：<邮箱>。
```
```markdown
## 利益冲突声明
作者声明不存在利益冲突。

## 作者贡献
<姓名>负责<角色中文名（对应 CRediT）>；……
```
> 中文刊的「中图分类号 / 文献标志码」是**正文前普通行**（不是标题）：
> `中图分类号：<代码>　文献标志码：A`（其取值须按稿定，机器只查"在不在"）。

## 5. 自检怎么做

- 英文：`node <论文仓>/_journal-contract.cjs --draft <稿> --contract contracts/joes-elsevier.json --package <包目录> --report <报告.md>`
- CRediT 写法：`node bin/studio.cjs credit <稿>`
- 合规面（在先发表/许可/伦理）：`node bin/studio.cjs compliance <包目录>`
