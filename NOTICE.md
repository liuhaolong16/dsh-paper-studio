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

## 依赖许可（**读 `node_modules/*/package.json` 原文字段**，不采信登记）

| 依赖 | 版本 | 许可（原文） | 我们怎么用 | 义务 |
|---|---|---|---|---|
| `citeproc` | 2.4.63 | **CPAL-1.0 OR AGPL-1.0**（传染性） | **仅作运行时依赖**（`require('citeproc')` 做 CSL 格式化）；**未修改、未随包分发**（`package.json.files` 不含 `node_modules`） | 如实登记即可；**若将来把它内联进包，必须停下**（`bin/license-audit.cjs` 会 FAIL） |
| `citeproc-locales` | 1.0.2 | MIT | 运行时依赖（CSL 语言包） | 保留许可 |

> ★ 口径说明：**"作依赖使用"≠"再分发"**。我们不在 tarball 里分发它们的代码，用户由 npm 自行安装；因此不触发传染性许可对我们代码的要求。
> ★ 这句是**机器核过的**：`node bin/license-audit.cjs` 会检查"传染性依赖是否落进 `files` 白名单"（落进去就 FAIL）。
> ★ 历史教训：本仓早先的生态扫描把 `citeproc` 记成了 **MIT** —— **许可标注不可信，必须读原文**；这句话对自己的依赖同样成立。

## 随包分发的第三方资产（机器台账）

- 台账：`references/asset-provenance.json`（逐文件：`sha256` + 许可 + 来源 + 是否需署名）；人读说明：`assets/csl/PROVENANCE.md`。
- 机器核：`node bin/license-audit.cjs` —— 未登记 / sha256 不符 / 许可不可再分发 / 需署名而未署名 ⇒ **FAIL**。
- 现有资产：3 个 CSL 样式（**CC-BY-SA 3.0**，来自 CSL 官方样式库，未改动内容，署名与来源见 `assets/csl/PROVENANCE.md`）+ `assets/phrase-bank.json`（本仓自产）。

## 第三方吸收（2026-10-17 批次 · 逐家许可与处置）

| 来源 | 许可（读 LICENSE 原文） | 处置 | 落点 |
|---|---|---|---|
| `lifecycle-skills` | **Apache-2.0** | 可复制（带声明）——我们**只吸收规则与流程并重写实现**，未复制其代码 | `bin/talk.cjs` · `bin/reviewers.cjs` · `review.js`(严重度分诊) · `references/external-adoptions.md` |
| `kalaris-skills` | **MIT** | 同上（通用学术子集 37 项待逐个比对） | `references/absorption-matrix-20261017.md` |
| `auto-empirical-research-skills` | **CC-BY** | 可改编（须署名）——仅作方法参考 | 同上 |
| `dsh-sci-fault-diag-paper` | **木兰宽松许可证 第 2 版**（其 `package.json` 写 MIT 属标注不准确） | 可复制（带声明）——吸收了插件打包体例与教训分级范式 | `plugin/*` · `references/pipeline.json` |
| `paperdebugger` | **AGPL-3.0** | **只学架构，不搬代码** | 仅记于吸收矩阵 |
| `academic-research-skills` | **CC-BY-NC** | **只吸思想，不复制内容**（NC 不得随包分发） | 仅记于吸收矩阵 |
| `awesome-ai-research-writing` · 3 个 DSH npm 包 | **无 License**（默认保留全部权利） | 只学思路 | 仅记于吸收矩阵 |

> ★ 机器核：`node bin/license-scan.cjs --scan "<扫描件目录>"` —— 我方文本 × **受限源**（NC/传染性/无许可）做 13 词窗口重合比对，命中即 FAIL。
> 真扫描（2026-10-17）：受限源 8 个 · 我方 121 文件 / 131,205 指纹 / **命中 0**。
> ★ 该工具的边界已写明：只能抓逐字与近似逐字，**改写/换词/翻译抓不到** —— 地板线，不是免罪符。

## 归属分栏（**机器校验**：`bin/license-audit.cjs` 的归属一致性）

> 分栏口径：**使用了其表达**（正文/提示词/代码/清单措辞）⇒ 许可与署名是**法定义务**，不得删除；**只吸收思想/方法/结构**、产出为自有表达 ⇒ **无许可义务**，此处注记属**自愿致意**，对外可省略。
> 降级判据（从"须署名"降为"仅致意"，三条须齐备）：① `bin/license-scan.cjs` 对该源长片段命中 0 ② 人工复核无措辞/结构照搬 ③ 未把其文件当依赖或资产分发。

### A. 须署名（法定义务 · 不得删除）

<!-- ATTR-REQUIRED:start -->
- **CSL 样式 ×3**（`vancouver.csl` · `china-national-standard-gb-t-7714-2025-numeric.csl` · `china-national-standard-gb-t-7714-2025-author-date.csl`）—— **CC-BY-SA 3.0**，来自 CSL 官方样式库（Zotero Style Repository），未改动内容；署名与来源见 `assets/csl/PROVENANCE.md`（此三项**真的用了其内容**，不可降级）。
- **依赖如实登记**（非署名义务，但必须写明）：`citeproc` = **CPAL-1.0 OR AGPL-1.0**，仅作依赖、未修改、未随包分发；`citeproc-locales` = MIT。
<!-- ATTR-REQUIRED:end -->

### B. 受其思路影响（自有表达 · 无许可义务 · 此处为自愿致意）

<!-- ATTR-COURTESY:start -->
- `lifecycle-skills`（Apache-2.0）：槽位→预算 · problem-first 配比 · claim 式标题 · 置信加权与 champion 规则 · 严重度×成本分诊 —— 落点 `bin/talk.cjs` · `bin/reviewers.cjs`
- `kalaris-skills`（MIT）：技能目录按「何时用」切分、可被按需加载 —— 落点 `skills/*/SKILL.md`
- `auto-empirical-research-skills`（CC-BY）：实证流程阶段划分（仅参照）
- `dsh-sci-fault-diag-paper`（木兰宽松许可证第 2 版）：插件打包体例 · 严格 JSON Schema 教训 · 风格档案与教训分级
- `ARIS`（MIT）：验收门认识论 · 保证级别轴 · 复核独立性 · 注入卫生 · 输出版本化
- `research-paper-playbook`：11 维判据 · 机器门 · 投稿前检查表（同源本机资产）
- `paperdebugger`（AGPL-3.0）：多智能体与编辑器内集成的**架构观察**（未采纳任何代码）
- `academic-research-skills`（CC-BY-NC）：agent 角色分解的分类方式（仅参照，未复制内容）
- `awesome-ai-research-writing`（无 License）：写作生命周期清单分类（仅参照）
- `dsh-lit-search/@ai4paper-dsh-ipaper/@ggboy123-dsh-paper-reader`（无 License）：同赛道功能面与产品形态观察（仅参照）
<!-- ATTR-COURTESY:end -->

> 机器核：`node bin/license-audit.cjs` —— **漏署**（表达源不在须署名区）与**虚标**（思想源被写进须署名区）都会 **FAIL**；NOTICE 缺分区标记同样 FAIL（无法判定 ≠ 通过）。
