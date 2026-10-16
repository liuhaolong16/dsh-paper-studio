# 投稿信（Cover Letter）· 结构与必需声明

> 用 `node bin/studio.cjs cover --cover <投稿信.md> --contract <目标刊契约.json>` 核对要素与**刊名一致性**。
> 机器只核"**声明是否在场**" · "**刊名是否与契约一致**" · "**是否残留模板占位符**"；信的说服力仍属人读。

## 必需声明（缺一条就可能被编辑部退回）

| 声明 | 常用英文写法 | 中文写法 |
| --- | --- | --- |
| 未一稿多投 / 专投本刊 | `not under consideration elsewhere` · `not submitted elsewhere` · `exclusively submitted` | 未一稿多投 · 专投贵刊 |
| 全体作者同意投稿 | `All authors have read and approved the submission` | 全体作者同意投稿 |
| 无利益冲突 | `The authors declare no competing interests` | 无利益冲突 |
| 原创、未发表 | `original` · `has not been published before` | 原创 · 未曾发表 |

## 结构模板

```markdown
Dear Editor,

We submit our original manuscript entitled "<稿题>", which has not been published before and
is not under consideration elsewhere, for exclusive consideration by <目标刊名，必须与契约一致>.

<一到两段：为什么适合本刊、主要贡献（可引用稿件中的关键结果编号）>

All authors have read and approved the submission. The authors declare no competing interests.

Sincerely,
<通信作者与单位>
```

## 硬性注意

- **刊名必须与目标刊一致**（改投时最易忘记改；`cover` 命令会与契约的 `journal` 交叉核对并报错）。
- **不要留下模板占位符**：`[待填]` / `TODO` / `TBD` 一旦投出去，编辑部会直接看到（`cover` 命令会抓）。
- 若该刊要求**推荐/回避审稿人**，按该刊须知另附；本命令默认不要求（逐刊不同）。
