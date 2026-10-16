# dsh-paper-studio-v3

论文插件 V3：把「论文方案」（论文框架 + 方法论 + 工作流）做成 **DSH 原生、对话驱动、无面板**的插件。

- **两个工具**：`paper_studio`（唯一使用入口，桥接已冻结的 paper-studio CLI）· `paper_dev`（开发者模式：展示并允许改资产；用户模式下写入**真被拒**；解锁按**意图等价**（逐字原话或含「开发者模式」的等价说法均可，回执回显识别依据））。
- **五种写作模式**：全代写 / 共同创作 / 辅助创作 / 润色 / 其他 —— 用宿主的 `ask_user_question` 呈现为**可点击选项**，每项一行小字解释，且**行为差异化**（不是措辞差异）。
- **不复制判据**：门、体裁、模板、篇幅预算、教训全在 `../references/pipeline.json`（唯一真源），本插件只做编排与桥接。

## 安装（bundle）

`package.json` 声明了 `dsh.bundle.patch = ./cordis.patch.yml`，补丁内容：

```yaml
- insert:
    - id: paper-studio-v3
      name: dsh-paper-studio-v3
```

把本目录作为 bundle 安装到 DSH profile 即可（`plugin_manager install_bundle`），或先把整个 `paper-studio` 目录放到 `~/.agents/skills/paper-studio` 并用 `DSH_PAPER_STUDIO_ROOT` 指向它。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_PAPER_STUDIO_ROOT` | 指向 paper-studio 根（含 `bin/studio.cjs` 与 `references/pipeline.json`）；不设时按内置候选顺序找 |
| `DSH_PAPER_HUB` | 状态目录（默认 `~/.dsh/paper-studio`）；自检与多实例隔离用 |

## 自检

```bat
node plugin\selftest.mjs      :: 16 项（注册形态 · 严格 JSON Schema · 真封闭 · 解锁/回封 · 越界拒收 · 五模式差异化 · 端到端跑 CLI）
node bin\studio.cjs audit     :: 出厂审查 6 项（完整性 + 重复性 + 数字一致性）
```

## 设计边界（诚实声明）

- **不生成图片**：图表相关只给题注文本、绘图建议与 Mermaid 源码骨架。
- **不做规避 AI 检测类操作**。
- **没有面板/前端资产**（用户明确要求：易崩难做），交互全部走对话与 `ask_user_question`。

---

## 版本口径（勿混用）

本仓库有**两条独立演进的版本线**，互不覆盖：

| 线 | 位置 | 当前 |
|---|---|---|
| 技能版本 | `SKILL.md` 的 `metadata.version` | **2.4.0** |
| 插件包版本 | `plugin/package.json` 的 `version` | **3.2.0** |

插件包从 V3 起独立编号（V3 = 去面板 + 双模式），因此包版本号高于技能版本号**属正常**，不要为"对齐"而改任何一侧。判定兼容性只看**插件包版本**；判定流水线/判据能力只看**技能版本**。

## 合规门（v3.2.0 新增 · 蒸馏自真实投稿经历）

`node bin/studio.cjs compliance <投稿包目录>` —— **投稿前**扫一遍投稿包，把"会让稿子被打回或撤稿"的合规面做成可机检：

| 级别 | 检查项 |
|---|---|
| **硬**（缺即非零退出） | 稿件主文件（`.md/.docx`，排除投稿信/回复信）· **Cover Letter**（单独文件） |
| 软（缺即显形，由作者定夺） | 图件文件 · 参考文献清单 · 该刊契约 json · 稿件里的 5 段声明（Data Availability / CRediT / Conflict of Interest / Funding / Ethics） |

**三态**：命中 / 缺失 / **取不到**——取不到（目录不存在、稿件读不到）**一律按失败处理，不静默通过**。
知识源：`references/compliance-checklist.md`（7 节，含 **Elsevier 官方问答一手原文**：摘要 / 学位论文 / 电子预印本**不算**在先发表，但 **Cell Press、The Lancet、部分学会刊政策不同**；取证日期 2026-10-16；未取证的条目写明「未取证」）。

## 自证三道门（v3.1.9 新增 · 由 2026-10-16 生态日审的真实问题驱动）

| 命令 | 门 | 防的是什么 |
|---|---|---|
| `node bin/studio.cjs selftest --json` | **机器可读计数出口** | 下游（登记表 / 文档 / 数字侧车）只能手抄中文输出 ⇒ 抄错无人发现（本插件真漂过一整版：登记表写 53/53，脚本实报 61/61） |
| `node bin/studio.cjs claims` | **文档数字一致性门** | 文档里写了「N/N 通过」就必须与**实跑**一致；历史文档用 `<!-- claims: snapshot -->` 标为快照（CHANGELOG 与 V1 验收报告已标） |
| `node bin/studio.cjs hygiene` | **残留件门** | 备份/临时件（`.bak-*`/`~`/`.tmp`/`__pycache__`）**不得留在技能树内**——本插件真被生态的「残留文件」判据抓过；备份一律归档到技能树外（`<归档根>\<日期>\`），**只归档不删除** |
| `node bin/studio.cjs coverage` | **自检覆盖门** | `bin/*.cjs` 里凡含自检的脚本必须在真源 `references/pipeline.json` 的 `selfchecks` 登记（登记的是**取数命令**，不是冻结数字） |

**纪律**：任何"当前状态类的数字"都不写在文档里只写一次——**文档写数字就必须被 `claims` 盯住**；历史记录一律标快照标记。

## 分发口径（v3.2.3 改写 · 重要）

**目标：装一次就拿全部能力。** 现在支持两种装法，**推荐整包**：

| 装法 | 命令 | 拿到什么 | 说明 |
|---|---|---|---|
| **整包（推荐）** | `npm i -g dsh-paper-studio` 或把本仓库作为 bundle 安装 | CLI（`bin/studio.cjs`）+ 判据资产（`references/`）+ 期刊体系 + 插件半体 + MCP 服务端 | 仓库根 `package.json` 的 `files` 已含 `bin` / `references` / `plugin` / `SKILL.md`；`resolveRoot()` 有**包内自带**候选 ⇒ 无需另存一份仓库 |
| 仓库（git） | `dsh plugin --profile <p> add github:liuhaolong16/dsh-paper-studio` | 同上（整棵树） | 老路径，继续可用 |

**仍不支持**：只装 `plugin/` 单目录（npm 的 `files` 打不出仓库根的 `../references`）。这种情况**会显形失败**而不是静默降级 —— CLI 打印 `该读：references/… [缺失]` 并以退出码 1 结束；`compliance` 门也会以退出码 2 报"找不到能力树根"。

**自证（装机后一条命令）**：
```bash
node bin/studio.cjs route "把这篇稿子按中文核心期刊的要求改一遍"   # 应出现 [存在] 且退出码 0
node plugin/selftest.mjs                                      # 整包自证：files 齐备 + dsh 补丁与 main 真在盘上 + 包内自带候选在
```


## 期刊分类路由可执行化（v3.1.8 新增）

- `route` 不再只给任务类型/链路/门，还会输出**期刊分类路由**：判定键（`cn+zh` / `intl+en` / `intl+en+plos` / `cn+en` / `intl+zh`）+ 命中的关键词 + **该读哪份资产**（含磁盘存在性）+ 真源里的边界条款。
- 两条硬纪律（都进自检，且各有必失败夹具）：① 分类判出来了却**解析不出资产路径**（真源取值没写显式 `references/*.md`）⇒ 抛 `JOURNAL_ASSET_UNRESOLVED`；② 解析出的资产**在磁盘上不存在** ⇒ 显形并让 `route` 退出码 1。第 ② 条同时兜住「只装了插件包、仓库根的 references 不在」这类分发缺口。
- 自检新增 **8 条夹具（含 4 条必失败）**：中文刊任务⇒`cn+zh` 且资产存在 · PLOS⇒`intl+en+plos` 指向 `plos-one.md` · Elsevier⇒`intl+en` 指向 `submission-runbook.md` · 无期刊关键词的任务**不得输出资产**（不猜）· 真源 routing 自洽性 · 上述两条硬纪律的必失败面 · 资产缺失必显形。

## PLOS 系投稿规范（v3.1.1 新增）

- `references/plos-one.md` —— **PLOS ONE 投稿规范专章**：与 Elsevier 系的差异对照表 · 排版硬项（双倍行距 + 连续行号 + 标题≤3 级）· 稿件组织顺序 · 图件规格（TIFF/尺寸/dpi/LZW/图题位置/豁免窗口）· **Vancouver 参考文献四类样例** · Cover Letter 必含项与「不得提减免」· 系统内另填项 · 人工边界 · 可机检要点。

## 期刊分类与国内刊专章（v3.1.0 新增）

- `references/cn-journals.md` —— **国内中文期刊专章**：六套收录体系 · 知网腾云/玛格泰克/勤云三平台的注册与逐字投稿步骤 · 国内刊标准书写顺序与量化硬项 · **GB/T 7714—2025** 著录要点 · 国内特有材料（著作权转让协议/申请单/利益冲突声明）· 审稿规则 · **逐刊档案（含《储能科学与技术》《电工技术学报》等）**。
- `references/journal-taxonomy.md` —— **两轴分类与路由**（region × language 四象限），说明「该查哪份资产、该走哪条清单」。
- 机器真源：`references/pipeline.json` 的 `journal_classes`（含 `reference_style_by_language`、`checklist_rules`、`boundaries`）。
