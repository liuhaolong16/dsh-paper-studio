# 写作侧接入约定（paper-writer × 期刊模板知识库）

**定位**：本文只写“写作开工时怎么调用模板知识库”，判据真源仍是 `references/pipeline.json` 与 `templates/*/spec.json`。写作方法本体在外部技能 `paper-writer`（CC-BY-NC-SA），本插件只给调用契约、不复制其正文。

## 一、开工前（写第一个字之前）

1. **确定目标刊**：用户指定了刊 ⇒ 记下刊名/简称；没指定 ⇒ `journal = generic`，并告知用户“按通用模板写，指定刊后需重排”。
2. **查库**：`node bin/journal-template.cjs --resolve --journal "<刊名>"`。
   - 命中 ⇒ 进入第 3 步。
   - 未命中 ⇒ **停止写作**，先收集：`--new --id <id> --journal "<刊名>" --url <官方页>` → 下载官方模板 → 填 spec → `--verify` 通过后才回到第 3 步。**不得回退到 generic 顶替指定刊。**
3. **预检**：`node bin/journal-template.cjs --preflight --journal "<刊名>"`。
   - `PASS` ⇒ 继续。
   - `BLOCK`（`NO_TEMPLATE` / `NO_DOCX_TEMPLATE` / `NO_TEMPLATE_FILE`）⇒ 不得开写；按回执里的下一步处理。
4. **起稿文件**：
   - 已有 Markdown 稿 ⇒ `--build 稿.md --journal "<刊名>" --out 稿.docx`
   - 要从官方模板直接写 ⇒ `--scaffold --journal "<刊名>" --out 稿.docx`
   - 已有旧 docx ⇒ `--apply 旧.docx --journal "<刊名>" --out 稿.docx`

## 二、写作中

- 正文写作交给 `paper-writer`；其“证据-声明”硬规则不变。
- 本插件只保证**版式层**与**交付层**：纸张、四边页边距、西文/中文字体、字号、行距、命名样式、正文颜色。
- 模板自带说明色（红/绿）只允许留在模板里；正文不得出现彩色文字。

## 三、交付前

```powershell
node bin/journal-template.cjs --check 稿.docx --journal "<刊名>" --report 检查报告.md
```

- 退出 0 ⇒ 版式合规；仍有 `WARN`（正文直接字号/字体）时人工核对，`--apply` 不会清除直接格式。
- 退出 1 ⇒ 按报告里的 `E_*` 逐项修，或回到 `--apply` 重排后重跑。
- 批量交付包：`--check-batch 包目录 --journal "<刊名>"`。
- 报告与检查表一并留档；不要口头声称“已按模板”。

## 四、handoff 字段（机器可检）

`studio handoff` 的 `gate:author-material → handoff:paper-writer` 契约新增可选字段：

| 字段 | 取值 | 何时填 |
|---|---|---|
| `journal_template_id` | spec 的 `id`，如 `mdpi-journals` | 任何指定刊写作 |
| `journal_template_spec` | `templates/<id>/spec.json` | 同上 |
| `journal_template_status` | `verified` / `verified-partial` / `fallback` / `none` | 同上 |

`journal_template_status=fallback` 只允许用于**用户未指定刊**的场景；指定刊必须 `verified` 或 `verified-partial`（partial 需在交付说明里写明未取证项）。
