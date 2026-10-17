---
name: paper-citing
description: |
  文献与引用（著录格式 · 编号 · 核验与锚点）。要格式化参考文献（GB/T 7714—2025 / Vancouver 等）、要核对「引用是否真实存在」、或要给主张配引用锚点时
  **不用于**：文献检索策略本身（走检索技能）· 稿件排版（paper-gates / paper-writing）。
  Triggers on: 参考文献 · 引用格式 · 著录 · GB/T 7714 · Vancouver · 核引用 · 引用锚点 · references · citation · bibliography · DOI 核对。
  真源：`references/pipeline.json` 的 `skill_modules.paper-citing`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 文献与引用（著录格式 · 编号 · 核验与锚点）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

要格式化参考文献（GB/T 7714—2025 / Vancouver 等）、要核对「引用是否真实存在」、或要给主张配引用锚点时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `refs` | **按 CSL 样式格式化参考文献**（零 key、离线）：样式名支持 `gb-t-7714-2025-numeric`（中文刊顺序编码制）/ `gb-t-7714-2025-author-date` / `vancouver`；样式文件在 `assets/csl/`（第三方，CC-BY-SA 3.0，见同目录 PROVENANCE.md），**sha256 锁**在 `references/csl-lock.json` —— `refs --check` 核样式是否被无声替换；取不到样式/引擎一律报错并算未通过 |

**相关 CLI（非 agent_facing，供直接调用）**：`anchors`

## 相关真源与资产

- `assets/csl/*.csl（3 个样式 · CC-BY-SA 3.0 · 见 assets/csl/PROVENANCE.md）`
- `references/csl-lock.json（样式 sha256 锁）`
- `bin/oa-fetch.cjs（OpenAlex/Unpaywall 取数层：礼貌池走环境变量 · 24h 磁盘缓存 · 缺邮箱记 SKIP）`
- `bin/refs-verify.cjs（引用核验门：离线结构 + **多源在线回落 OpenAlex→S2→DataCite** + 撤稿 + 版本核验 + fail-soft）`
- `bin/relevance-gate.cjs（引用相关性弱机检：主题词面重合 + 串簇降级 + 被引用即正当；只报疑似不出 FAIL）`

## 边界（这些事本模块不做）

- **verify-or-drop**：核不实就删或打标，绝不编造
- 零 key、离线可跑；联网核验由宿主或既有技能提供

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
