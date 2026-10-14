# NOTICE —— 许可与来源（三类对象分开写，避免口径含糊）

本仓（`paper-studio`：论文方案编排层 + DSH 插件）采用三分类许可口径，**不要笼统说"全部 MIT"或"全部不可商用"**：

| 类别 | 对象 | 许可 |
|---|---|---|
| ① **机制 / 思想 / 判据 / 术语** | 例如「门可以 DRIVE 不能 ACQUIT」· A/B 门分类 · `done ≠ accepted` · 作用域阶梯 · 覆盖率分母不可由遍历推导 · 用零命中语料测重叠等于没测 | **不受著作权保护**：学习、改良、重写后即归本方实现，**无商用限制** |
| ② **本方独立实现** | 本仓全部脚本（`bin/*.cjs`）、插件（`plugin/**`）、真源（`references/pipeline.json`、`templates.json`）、文档与自检 | **MIT**（见 `LICENSE`），**可商用** |
| ③ **逐字复印的上游原文** | 本仓**不含**任何逐字复印的上游正文 | —— |

## 机制来源（只学机制，不搬正文）

| 来源 | 取了什么（机制层） | 落点（本仓证据） |
|---|---|---|
| ARIS（本地逆向，MIT） | 验收门认识论、保证级别轴、复核独立性、注入卫生、可续跑、输出版本化、外部节律 | `references/aris-read-report.md` 列出 16 条逐条映射 |
| 既有论文资产（`research-paper-playbook`） | 11 维判据、机器门、投稿前检查表、模板 | `references/pipeline.json` / `templates.json` 只登记**真源路径**并在运行时读取，不复制正文 |
| 市面同类插件/技能（Gitee 逆向，见 `references/market-parity.md`） | 改动账本、LaTeX 保真、中英双通道、去 AI 味、审稿回复、通读协议、图表题注、教训库分级 | `bin/polish.cjs` · `bin/revise.cjs` · `bin/figures.cjs` · `bin/coach.cjs`，缺口表逐条记状态与证据 |
| `dsh-sci-fault-diag-paper`（Gitee，MIT） | 插件打包体例（`dsh.bundle.patch` + `cordis.patch.yml`）、严格 JSON Schema 教训、风格档案与教训分级范式 | `plugin/package.json` · `plugin/cordis.patch.yml` · `bin/profile.cjs` · `bin/coach.cjs` |

## 依赖

- **运行时**：Node.js ≥ 20（本仓 `plugin/package.json` 的 `engines`）；DSH 宿主（插件形式安装时）。
- **可选**：`DSH_AI_WORKBENCH_REGISTRY`（指向你自己的能力登记表；**缺失时出厂审查会显式跳过相关两项**，不是静默通过）。
- 本仓**不要求**任何付费/需登录的 API；联网能力（检索/核对）由宿主或既有技能提供。
