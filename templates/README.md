# 期刊模板知识库

> 规则（用户 2026-10-22 明确要求）：
> 1. **投指定期刊** ⇒ 严格按本库该刊模板，字号 / 字体 / 页边距 / 颜色一项不能错。
> 2. **没指定期刊** ⇒ 用 `generic` 通用模板。
> 3. **指定了但库里没有** ⇒ 先去收集该刊模板并入本库，**不得直接套通用模板**。

## 目录结构

```
templates/
  index.json                  # 总索引：id / 刊名 / 别名 / kind / status / spec 路径
  generic/spec.json           # 回退模板（本仓通用 Word 格式）
  <journal-id>/
    spec.json                 # 唯一真源：来源、许可、文件 hash、格式参数
    files/                    # 官方模板原件（latex/tex/docx/pdf）
```

`index.json` 的每条 = 一个可调度条目；`spec.json` 里 `kind` 决定检查方式：

| kind | 含义 | 机检命令 |
|---|---|---|
| `latex-class` | 官方 LaTeX 文档类 + 模板 | `--check-tex` 查 `\documentclass` 与必需选项 |
| `docx-template` | Word 模板 / Word 格式参数 | `--check` 查页边距、默认字体字号、行距、颜色 |
| `guidelines` | 只有格式指南（无模板文件） | 按 `spec.docx` 已取证项检查；未取证项必须如实标 partial |

`status`：`verified`（模板与格式都已取证）/ `verified-partial`（部分取证）/ `fallback`（generic）。

## 收录流程（每收一个刊，照做）

1. **找官方页**：期刊官网 `Guide for Authors` / `Templates` / `Submission guidelines` 页；优先官方模板文件（docx / tex / cls）。
2. **下载原件**：存到 `templates/<id>/files/`；记录来源 URL、抓取日期、HTTP 状态。
3. **取格式参数**：从模板文件/官方指南原文取证（页边距、正文字体字号、行距、标题层级字号、颜色、参考文献样式），每项写进 `spec.json` 的 `sources[].note`。
4. **登记**：`index.json` 加条目；`spec.json` 填 `files`（sha256）、`license`、`verified_at`。
5. **机检**：`node bin/journal-template.cjs --list`、`--check-tex` 或 `--check` 必须过；`--selftest` 12/12。
6. **不许猜**：官网打不开 / 被验证码挡住时，改用官方镜像（如 CTAN）或官方 PDF 指南；**不绕过付费墙、验证码、DRM**。拿不到就如实记 `status=unverified`，不得把 guess 写成 verified。

## 当前覆盖（2026-10-22）

| id | 刊 / 范围 | kind | status | 证据 |
|---|---|---|---|---|
| `generic` | 未指定期刊时的回退 | docx-template | fallback | 本仓 Word 生成脚本（A4 / 2.54-3.17cm / 宋体+Times 12pt / 1.5 倍行距） |
| `elsevier-elsarticle` | Elsevier 期刊（含 JoES） | latex-class | verified | CTAN 官方包；模板首行 `[preprint,12pt]`；类默认 a4paper |
| `ieee-journals` | IEEE 期刊/会议 | latex+docx | verified | CTAN 官方包（`[journal]{IEEEtran}`）+ **IEEE Transactions Word 模板**（Letter / 上下1.778 左右1.651cm / Times New Roman / Title24、Abstract9、References8） |
| `acs-journals` | ACS 期刊 | latex-class | verified | CTAN 官方包；`[journal=<code>,manuscript=article]{achemso}`，基类 article 12pt/letter |
| `plos-one` | PLOS ONE | guidelines | verified-partial | PLOS 正文格式 PDF：标题 18/16/14pt 加粗、行号、禁彩色；正文正文字体字号未取证 |
| `mdpi-journals` | MDPI（Materials 官方模板） | docx-template | verified | .dot（实为 OOXML）：A4 / 上2.5 下1.6 左右1.27cm / Palatino Linotype / 1.1667 行距 / 标题18pt、一级12pt、参考文献9pt；`styleMap` 绑定 `MDPI12title`/`MDPI21heading1`/`MDPI81references` |
| `elsevier-data-in-brief` | Data in Brief | docx-template | verified-partial | Elsevier 官方 Word 模板：A4 / 四边 2.54cm / 11pt / Heading1 16pt 加粗；正文字体未在样式层声明 |
| `elsevier-methodsx` | MethodsX | docx-template | verified-partial | Elsevier 官方 Word 模板：A4 / 四边 1.27cm / Times New Roman 11pt / 行距 1.15 |
| `frontiers` | Frontiers | docx-template | verified | 官方 Word 模板：Letter / 上下 2.01、左 2.26、右 2.08cm / Times New Roman 12pt / 单倍行距 / Title 16pt 加粗 |
| `taylor-francis` | Taylor & Francis | docx-template | verified | 官方 Word 模板（.dotx）：A4 / 四边 2.5cm（左右 3.0）/ Times New Roman 12pt / 双倍行距 / 标题14pt 加粗 / 摘要11pt |
| `cn-ctbu` | 重庆工商大学学报（自然科学版） | docx-template | verified-partial | 官方 Word 模板：A4 / 上下2.24 左右2.17cm / 中文宋体+西文 Times New Roman；模板内红/绿为填写说明 |
| `cn-haut` | 河南工业大学学报（自然科学版） | guidelines | verified-partial | 官网投稿须知：中文摘要300字、英文≥400词、GB/T 7714—2015、三线表；**无模板文件** |
| `cn-hjnu` | 汉江师范学院学报 | guidelines | verified-partial | 官网来稿须知：全文≤8500字、摘要200字、GB/T 7714—2015、三线表；模板在 CNKI 投稿系统内 |

### 已知缺口（下一轮）

- Elsevier / IEEE / ACS / PLOS 的 **Word 模板**尚未收集（当前只有 LaTeX 或指南）；Word 投稿时 `--format docx` 会返回 `NO_DOCX_TEMPLATE`，必须先补。MDPI 的 Word 模板已收。
- 中文期刊：已收河南工业大学学报、汉江师范学院学报的**官方须知**（guidelines，partial）；两刊的 Word 模板分别在投稿系统/CNKI 内，尚未取得。
- Springer Nature / Wiley / Taylor & Francis / 中文核心刊未收录。

## 命令

```powershell
node bin/journal-template.cjs --list
node bin/journal-template.cjs --resolve --journal "Journal of Energy Storage" --format latex
node bin/journal-template.cjs --preflight --journal MDPI --format docx
node bin/journal-template.cjs --new --id <id> --journal "<刊名>" --url <官方页>
node bin/journal-template.cjs --verify
node bin/journal-template.cjs --check 稿.docx --journal MDPI --report 检查报告.md
node bin/journal-template.cjs --check-batch 稿件目录 --journal MDPI
node bin/journal-template.cjs --build 稿.md --journal MDPI --out 新稿.docx
node bin/journal-template.cjs --apply 旧稿.docx --journal MDPI --out 新稿.docx
node bin/journal-template.cjs --scaffold --journal MDPI --out 稿.docx
node bin/journal-template.cjs --check-tex 稿.tex --journal elsevier-elsarticle
node bin/journal-template.cjs --check 稿.docx --journal generic
node bin/journal-template.cjs --selftest
```

## 版权

模板原件按各自许可随包分发：Elsevier elsarticle / IEEEtran / achemso 均为 **LPPL 1.3+**（可再分发，保留许可与来源）。PLOS 指南 PDF 仅本地参考、不再分发（`license.redistributable=false`）。新增资产须同步 `NOTICE.md` 与 `references/asset-provenance.json` 的规则（本目录暂无 `assets/` 下的第三方文件，若未来放入需按该规则登记）。
