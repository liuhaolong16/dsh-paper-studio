---
name: paper-process
description: |
  过程与沉淀（状态机 · 教训 · 方法 · 交接 · 成本 · 模型通道）。要跨会话续跑（done 不等于 accepted 的状态机）、要查或记教训与方法、要做阶段交接、要算本会话成本、或要配置模型通道与自检时
  **不用于**：论文内容本身（见其余模块）。
  真源：`references/pipeline.json` 的 `skill_modules.paper-process`；本文件由 `bin/sync-skill-modules.cjs` 生成，**勿手改**。
---

# 过程与沉淀（状态机 · 教训 · 方法 · 交接 · 成本 · 模型通道）

<!-- AUTO:skill-module:start 由 bin/sync-skill-modules.cjs 生成 -->

## 何时用

要跨会话续跑（done 不等于 accepted 的状态机）、要查或记教训与方法、要做阶段交接、要算本会话成本、或要配置模型通道与自检时

## 这个模块管什么（命令面）

| 命令 | 说明 |
|---|---|
| `state` | 运行状态机（**done ≠ accepted**；accept 需 verdict_id + reviewer，同族会告警） |
| `lessons` | 初稿经验库 L-1…L-18（每条带出处与"能不能机检"） |
| `method` | 11 维方法论索引（指向真源文件，不复制） |
| `handoff` | 列交接契约（必填 / 闭集 / 逐项 schema） |
| `cost` | node bin/studio.cjs cost [--latest/--file <会话日志>] [--out 交付总结.md] [--prices <价格表>] [--usd-cny <汇率>] |
| `coach` | **开工教练**：教训 × 强制级别（已挂门＝enforced / advisory）× 用过次数 ⇒ 取 top-N（`coach use <id>` 记使用） |
| `profile` | **研究风格档案**（`brief` 开工注入；**凭证类字段一律拒收**） |
| `selftest` | 机器可读计数（下游一律引用本命令，别手抄数字） |
| `model` | **面板凭据的 CLI 通道**（与面板写同一份本机存储；`set` 用 `--key` 或 `--from-file`） |

## 相关真源与资产

- `plugin/hub/*（跨会话中枢）`
- `references/lessons-from-first-draft.md`

## 边界（这些事本模块不做）

- **凭证值不入任何记忆 / 文件 / 日志**（model 只记处理方式）
- 教训必须带「怎么验」（可机检判据优先于口号）

## 与整包的关系

- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。
- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。
- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。

<!-- AUTO:skill-module:end -->
