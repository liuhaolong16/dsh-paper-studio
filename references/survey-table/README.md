# 综述对比表 · 引用溯源（table-trace）

> 真源：`bin/table-trace.cjs`；本文件只写口径与用法，不复制判据实现。

## 问题

AI 写综述最危险的不是文笔，是**表格里的数字**：一行条件、一个单位、一个"±"，看上去都对，但没人能回到原文那一页核对。审稿人一问"这个 0.09 是哪来的"，返修就已经发生了。

## 四层证据链

```
全文（fulltext.md，带 DOI/页码，声明已对照原始 PDF）
   → 结构化解析（structured.json + parsing-qa.md）
   → 表格元数据（table-metadata.json：列、单位、条件、行、表注）
   → 逐格引用（table-citations.json：每格 → 文献键 → DOI + 页码 + 原文片段）
```

生成表格时只允许从 `table-citations.json` 取引用键；`table-trace` 在交付前把"没有原文依据的格子"抓出来。

## 两条硬规则

1. **数字必须有出处**：任何数值格至少一个引用键；引用键必须能落到 DOI/URL + 页码/定位 + ≥20 字原文片段。
2. **引用必须被用到**：登记过的每条文献都必须至少被一个格子引用（死引用同样失败）。

## 判定码

| 码 | 含义 |
|---|---|
| `E_SOURCE_NO_ID` | 来源缺 DOI/URL |
| `E_SOURCE_NO_LOC` | 来源缺页码/定位 |
| `E_SOURCE_NO_QUOTE` | 原文片段不足 20 字 |
| `E_SOURCE_UNKNOWN` | 格子引用了未登记的文献 |
| `E_SOURCE_UNUSED` | 登记了但没有格子引用 |
| `E_NUM_UNSOURCED` / `E_NUM_CELL_MISSING` | 数值格无出处 / 缺格 |
| `E_ROW_UNKNOWN` / `E_COL_UNKNOWN` | 行列与 metadata 对不上 |
| `E_NOTE_MISSING` | 缺表注（条件边界） |
| `E_FULLTEXT_UNCHECKED` | 全文未声明已对照原始 PDF |
| `E_FILE_MISSING` | 清单里的文件不存在 |

## 用法

```powershell
node bin/table-trace.cjs references\survey-table\examples\demo\manifest.json
node bin/table-trace.cjs --example
node bin/table-trace.cjs --selftest
```

退出码：0 = 全过；1 = 有失败项；2 = 用法/读取错误。

## 与既有门的分工

- `claim-anchor`：正文主张 → 引用锚点；
- `author-loop`（`generate --author-loop`）：正文数字溯源；
- **`table-trace`：综述表格这一层**——条件列、单位、逐格引用、表注。

顺序：表格过 `table-trace` → 再进 `author-loop` 做正文级核对。
