---
name: paper-gates
description: |
  门与合规体检（权威门 · 期刊契约 · 声明件 · 数字一致性）。稿子基本成形、要做「投稿前体检」，或要核对期刊契约 / 声明件 / 数字一致性 / 可复现材料时；也用于出厂前检查本插件自身是否自洽
  **不用于**：起草与润色（paper-forms / paper-writing）· 单个引用的核对（paper-citing）。
  Triggers on: 投稿前检查 · 体检 · 期刊契约 · 声明件 · 合规 · 数字一致性 · preflight · submission check · journal requirements。
  真源：`references/pipeline.json` 的 `skill_modules.paper-gates`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 门与合规体检（权威门 · 期刊契约 · 声明件 · 数字一致性）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

稿子基本成形、要做「投稿前体检」，或要核对期刊契约 / 声明件 / 数字一致性 / 可复现材料时；也用于出厂前检查本插件自身是否自洽

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `gates` | 列全部必过门（含运行器与脚本路径是否存在） |
| `verify` | 工件复核（重算输入哈希 ⇒ FRESH / STALE；与 report 同源，惰性加载 gate-runner） |
| `crosscheck` | **同判回归**（两对判据：材料声明 / 成品件结构）必须同判 |
| `compliance` | 合规门（投稿前过：硬项=稿件+Cover Letter；软项=图件/参考文献/契约/声明段；取不到即失败）（含**硬检查「包卫生」**：内部产物/陈旧/临时文件不得进包，与契约门 `package_hygiene` 同规则） |
| `hygiene` | 残留件门（备份/临时件不得留在技能树内） |
| `claims` | 文档数字一致性门（文档写的 N/N 必须与实跑一致） |
| `coverage` | 自检覆盖门（bin/*.cjs 含自检者须在真源 selfchecks 登记） |
| `retract-check` | 引用撤稿检查（OpenAlex is_retracted；撤稿须显式说明；取不到≠通过） |
| `credit` | CRediT 官方 14 角色核对（非官方写法＝失败；缺 CRediT 段＝未通过；依据 references/credit-roles.json） |
| `audit` | **出厂审查**（完整性 + 重复性 + 数字一致性，6 项可复跑） |
| `docx` | **不依赖文档库**读成品件结构（表格/图/段落/残留标记） |

## 相关门

- `12 道门（含 journal-contract · claim-anchor · review-protocol · confidentiality）`

## 相关真源与资产

- `references/contracts/*.json（7 份期刊契约）`
- `references/compliance-checklist.md`
- `references/pipeline.json（门与 args 模板）`

## 边界（这些事本模块不做）

- 门只照它认识的判据判；**判据前提扫到零必须报红**，跳过一律单列且不计入通过数
- 不代替人读：语义与学术判断留给人或跨模型 reviewer

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
