---
name: paper-studio
description: |
  论文工作室（中文/英文投稿双线）· **编排层**。把「投稿前体检 / 忠实润色 / 起草辅助」三类任务，
  路由到本机已有的论文资产（research-paper-playbook 的 138 条检查表与 14 道机器门 · paper-writer 起草 ·
  paper-polish 润色），并逐门执行、汇总待修项（带行号）。
  当你（用户）说「给这篇稿子做投稿前体检」「跑一遍投稿前的门」「帮我把这段润色到能投」
  「这稿还差什么」时使用；也用于查流水线、查必过门。
  **不用于**：起草与润色的**正文方法论本体**（那走 paper-writer / paper-polish）· 论文精读（走 doubao-paper-close-reading）·
  研究评价（走 doubao-academic-evaluator）· 规避 AI 检测类操作（本技能明确不做，见「红线」）。
metadata:
  version: "2.4.0"
  author: JARVIS (DSH)
  created: "2026-10-14"
  acceptance: "V1-验收报告.md + V1.1-验收报告.md + V1.2-验收报告.md + V1.3-验收报告.md + references/good-practices-learned.md + references/external-adoptions.md（V2.4 = 上轮新判据**回灌进产品**：新稿声明模板与后置件必答直接带上「未发表数据是否外发」；报告加 `--show-context`）"
  entry: "bin/studio.cjs"
  pipeline: "references/pipeline.json"
  changelog: "2.4.0 = **判据回灌（从"投稿前才提示"改成"新稿一开始就写对"）+ 说明可视**：① 声明模板（`08-声明四件套.md`）的 AI 段新增**必填句**：未发表数据是否外发第三方服务（三种照实写法，含"曾上传则写明服务与范围"）；② 两套章节集的**后置件**必答新增同一条 ⇒ `draft` 任务书与 `sections` 都会提示；③ `report --show-context`：把被跳过的说明/豁免（INFO / HUMAN_VERIFIED / 软提示）**按需列原文**（真跑实测 84 条可见，含 review-protocol 命中的证据行）。2.3.0 = 外部取证落一条 AI 数据外发判据 + 报告自带 docx 读数；2.2.0 = 报告章节级 + 修两类假信号；2.1.0 = 第二对判据（docx 结构独立读数）；2.0.0 = 章节级论文框架；1.9.0 = 同判回归 crosscheck；1.8.0 = 交接契约可执行；1.7.0 = 第 11 道门 confidentiality + 还两笔工具债；1.6.0 = 外部取证（体裁→骨架 + PRISMA 知情骨架与判据）；1.5.0 = 骨干/模型/框架三处结构迭代；1.4.0 = 第 10 道门 review-protocol；1.3.0 = draft 子命令；1.2.0 = 作者材料前提真门；1.1.0 = L-1/L-2 真门 + report + 修 lang + 修「前提层当断言层」（L-13）"
---

# 论文工作室（paper-studio）

> 一句话：**不重写方法论，只做路由与过门** —— 论文这条线上"该跑什么、跑没跑、差什么"由它回答。

## 0. 它是什么 / 不是什么

| | 内容 |
|---|---|
| **是** | 编排层：判任务类型 → 选链路 → 调已有资产 → **逐门执行** → 出待修项（带行号）与成品件状态 |
| **不是** | 方法论本体（`research-paper-playbook`）· 起草本体（`paper-writer`）· 润色本体（`paper-polish`） |
| **不动** | 不复制任何第三方技能正文；不修改上述技能；不新建第二份判据（判据只在 `references/pipeline.json`） |

**真源**：`references/pipeline.json`（任务类型 / 链路阶段 / 必过门 / 交接契约 / 资产路径）。CLI 只读它。

## 1. 快速开始

```bat
cd /d E:\DeepSeek\skills\paper-studio
node bin/studio.cjs route "给这篇稿子做投稿前体检"     :: 判类型 + 出链路 + 出必过门
node bin/studio.cjs scaffold --out "<你的稿件目录>" --name "论文名"   :: **开一篇新稿：按 S0–S7 生成骨架 + 复制现成模板**
node bin/studio.cjs draft --out "<你的稿件目录>" --name "论文名" --journal "目标刊" --lang en
                                                       :: ★ **从 0 写**：出「写作任务书 + 检索计划」并铺好骨架（不给材料 ⇒ 只出框架，不硬写正文）
node bin/studio.cjs lessons                            :: 初稿经验库 L-1…L-13（每条带出处与"能不能机检"）
node bin/studio.cjs coach brief --root "<工作目录>"     :: **开工教练**：教训 × 强制级别（已挂门＝enforced / advisory）× 用过次数 ⇒ 取 top-N（`coach use <id>` 记使用）
node bin/studio.cjs stylecheck --file "<稿.md>"         :: 写作质量机检（HARD＝低信息化开头；SOFT＝填充词/hedge/模糊词/贡献句/摘要无数字）
node bin/studio.cjs polish guard --before a.tex --after b.tex   :: **LaTeX 保真守卫**（数学与命令必须原样；抓新引入的未转义特殊字符；`\item`/破折号 warn）
node bin/studio.cjs polish ledger add --file l.jsonl --kind wording --reason "为什么这么改" --before "旧" --after "新"   :: 改动账本（**缺 kind/reason 拒收**）
node bin/studio.cjs polish check --channel cn2en --file "<稿.md>"   :: 通道检查（中→英不得残留中文；英→中/Word 不得残留 LaTeX）
node bin/studio.cjs profile set domain "<领域>" --file p.json       :: **研究风格档案**（`brief` 开工注入；**凭证类字段一律拒收**）
node bin/studio.cjs revise rebuttal --comments "<意见.md>" [--responses "<回应.md>"]  :: 审稿回复：逐条 4 段骨架；有回应时机检**覆盖/空话/承诺未兑现/对抗措辞**
node bin/studio.cjs revise aitone --file "<稿.md>"       :: 去 AI 味词表（20 个英中记号，逐条行号 + 替换建议；**密度只作 advisory**）
node bin/studio.cjs revise readthrough --file "<稿.md>"  :: **Reviewer 视角通读**：机械证据 + 10 问，逐条标「机械证据 / 需人读」
node bin/studio.cjs revise budget --file "<稿.md>"       :: 缩写/扩写：与真源篇幅预算逐节比对（超额给删减候选；不足给该节「必答」问题）
node bin/studio.cjs figures caption --check --file "<稿.md>"   :: 题注体检（硬判据＝"见正文"；缺 n/单位只提示）· `figures recommend` 绘图建议 · `figures arch` 架构图 Mermaid 源码
node bin/studio.cjs schemacheck --manifest tools.json    :: **工具 parameters 严格性校验**（防严格通道 400 / "换模型才报错"）
node bin/studio.cjs audit                                :: **出厂审查**（完整性 + 重复性 + 数字一致性，6 项可复跑）
node bin/studio.cjs state show --run "<run 目录>"        :: 运行状态机（**done ≠ accepted**；accept 需 verdict_id + reviewer，同族会告警）
node bin/studio.cjs method                             :: 11 维方法论索引（指向真源文件，不复制）
node bin/studio.cjs gates                              :: 列全部必过门（含运行器与脚本路径是否存在）
node bin/studio.cjs intake "<稿件.md 的路径>"           :: 登记稿件 + 出体检前检查项（语言判错可 --lang zh|en 覆盖）
node bin/studio.cjs genre "<稿件.md 的路径>"          :: 判**稿件体裁**（empirical/review/methodological/secondary-analysis）→ 决定哪些门适用
node bin/studio.cjs draft --out "<目录>" [--name ...] [--genre review]   :: 从 0 写（按体裁选骨架）
node bin/studio.cjs scaffold --out "<目录>" [--genre review]          :: 只铺骨架（按体裁选骨架）
node bin/studio.cjs handoff --list                      :: 列交接契约（必填 / 闭集 / 逐项 schema）
node bin/studio.cjs handoff intake --file decl.json     :: **真校验**一份交接声明（缺字段/类型/闭集/条件规则）
node bin/studio.cjs sections [--genre review]             :: **章节级框架**（每节：解决什么/必答/篇幅/证据义务/门/常见退回）
node bin/studio.cjs crosscheck [--pair=material|docx]   :: **同判回归**（两对判据：材料声明 / 成品件结构）必须同判
node bin/studio.cjs docx "<成品.docx 路径>"                   :: **不依赖文档库**读成品件结构（表格/图/段落/残留标记）
node bin/studio.cjs selftest                           :: 自检 51 项（含必失败夹具）
node bin/gate-runner.cjs --task "投稿前体检" --draft 稿.md --docx 稿.docx   :: 逐门真跑
node bin/studio.cjs report --task "投稿前体检" --draft 稿.md --docx 稿.docx --anchors 锚点.json
                                          :: 带行号待修项 + **按节看哪一节要改** + 成品件自带读数；
                                             加 `--show-context` 另列被跳过的说明/豁免原文
                                                       :: ★ 出**带行号的待修项清单**（行号 + 规则 + 原文三层）
node bin/studio.cjs report --type write --draft 草稿.md --declaration 材料声明.json
                                                       :: 起草链路：**材料前提门**先判「有没有作者材料」，无材料不许硬写
```

> **`scaffold` 是最省事的那一步**：一次生成 14 个文件 —— S0–S7 阶段骨架（每个带「必填」格）+ 现成模板（填空模板 / 一页速查 / 投稿前总检查表 / 期刊要求核实清单 / 声明四件套）。
> 模板**从真源复制**（不预存副本），已存在的文件**一律不覆盖**，模板真源缺失**报错不生成空壳**。

## 2. 三条链路（与档位）

| 类型 | 触发词（示例） | 档位 | 链路 |
|---|---|---|---|
| `check` 投稿体检 | 投稿前 / 体检 / 过门 / 检查表 | T1 | 收稿 → 逐门执行 → 待修项清单 → 成品件状态 |
| `polish` 忠实润色 | 润色 / 中译英 / 语病 / 降重（**不含**规避检测） | T1 | 交 `paper-polish` → 语言门 → 数字一致性门 |
| `write` 起草辅助 | 写 / 起草 / 扩写 / 搭框架 / **从0写 / 代写 / 初稿** | **T2** | 判类型 → **`draft` 出写作任务书 + 检索计划 + 骨架** → 材料前提门（无材料不许硬写）→ 逐节起草（交 `paper-writer` 或由助手写）→ 契约门 → 引用锚点门 → 语言门 |

> **T2 的含义**：投稿级产出 = 强模型 + 对抗复核 + 过完门禁才算完成（判据：错了会被人看见）。
> 起草**必须**有作者材料 / 已验证检索 / 领域常识三者之一；三者皆无 ⇒ 只给框架与检索计划，不硬写。

### 2.1 三处结构（V1.5 迭代：骨干 / 模型 / 框架）

| 层 | 是什么 | 落在哪里 | 自检怎么守 |
|---|---|---|---|
| **骨干** | **阶段词汇表** + **可执行交接契约**：链路每个阶段必须解析到真实实现（`subcommand:` \| `gate:` \| `handoff:` \| `manual:` \| `report:`），且阶段之间的交接由 `handoff.contracts` **真校验**（必填 / 类型 / 闭集 / 字段内容规则 / 条件规则 / 逐项 schema） | `pipeline.json.task_types[].chain` + `stage_kinds` + `handoff.contracts` | 断言：阶段名可解析、子命令真实存在、有 `handoff:` 必须写明由谁做；**契约两端必须能在链路里找到**；契约校验器 8 类违反都必须判失败；与既有门对同一对象**必须同判** |
| **模型** | **体裁模型**：`empirical` / `review` / `methodological` / `secondary-analysis` —— **体裁决定哪些门适用**（门声明 `applies_to`，缺省 `*`） | `pipeline.json.genres` + `gate_meta` | 断言：体裁判定五例（含无信号回退、`--genre` 优先、未知体裁必须抛）＋机制必须被真正使用 |
| **框架** | **两级框架**：① 阶段级＝骨架**按体裁选**（实证套 S0–S7 / 综述套 R0–R8，PRISMA 知情）② **章节级**＝`section_skeletons_by_genre`（default＝IMRaD 十节 / review＝七节，逐节标 PRISMA 条目号），**每节六项**：解决什么 · 必答 · 篇幅预算 · 证据义务 · 相关门 · 常见退回原因 | `templates.json.stage_skeletons` + `stage_skeletons_by_genre` + `section_skeletons_by_genre` | 断言：两套阶段骨架与两套章节集都齐全；综述套每节标 PRISMA 条目号；**借用外部清单必须带 attribution + 许可声明 + 「只借结构不搬正文」**；`draft` 任务书必须逐节渲染 |

**综述套骨架的出处（许可纪律）**：条目结构参考 **PRISMA 2020** 清单（Page MJ, et al. *BMJ* 2021;372:n71，**CC BY 4.0**），插件只借条目结构与编号对应、**不搬其正文措辞**；骨架集的 attribution 字段把出处与许可写在生成的任务书里（借用他人清单必须署名与标许可，这是硬纪律，不是礼貌）。

**新增判定 `skipped_not_applicable`（体裁不适用）**：**既不算通过、也不算失败**，且**不 spawn 那道门**；
它与「跳过（缺输入）」**分列不合并**（缺输入 ≠ 不适用）；**全不适用 ⇒ 退出码 1** —— 体裁判错时绝不许变成静默假绿。

## 3. 必过门

见 `references/pipeline.json` 的 `gates`。当前接入（**引用 D 盘 playbook 现成脚本，不复制**）：

| 门 | 脚本 | 运行时 | 接口 |
|---|---|---|---|
| **隐私与保密门（第 11 道 · HARD/SOFT 两级）** | `_gate-confidentiality.py` | python | `--draft`（可加 `--docx`）；**HARD**＝审稿/编辑通信痕迹、内部路径与内部材料名、敏感个人标识（身份证/手机号/病历号/患者编号）；**SOFT**＝联系邮箱、引用未发表内容、提到受试者却全稿无伦理表述、**写了 AI 使用却未交代未发表数据是否外发**（V2.3 加，依据 Lee et al. 2025 *JEEHP* §Privacy 的 pre-publication data protection / model data retention） |
| **综述/审计类方法完整性门（第 10 道）** | `_gate-review-protocol.py` | python | `--draft`；判 8 条方法要件（检索来源+时间窗 / 检索式 / 纳排 / **二次数据标注** / 可得性与可重采 / **「没测就不下结论」** / 下界口径 / 局限节）。★ **不适用对象**：非综述稿判「不适用」并退出码 0（适用性只看标题与摘要区） |
| **作者材料前提门** | `_gate-author-material.py` | python | `--declaration <材料声明.json>`（就是交接契约 `material-check→paper-writer` 的实例：`material_kind` / `material_path_or_note` / `claim_policy`）。路径须真存在且非空壳（<512 B 判空壳）、说明须 ≥40 字且不含占位符、口径须自洽；**缺声明 ⇒ 跳过，绝不当通过**。它**不扫正文占位符**（那是工作注记门的活） |
| **工作注记泄漏门（L-1）** | `_gate-worknote-leak.py` | python | `--draft` + 可选 `--docx`（**成品件才是事故现场**，给了就必须扫）；区分正文命中与注释体命中，可选 `--allow-comments` |
| **声明四件套门（L-2）** | `_gate-declaration-set.py` | python | `--draft` + 可选 `--docx`；只判四段**在不在**（内容属实性是人读项） |
| 契约门 | `_contract-check.cjs` | node | **位置参数给稿子**（只扫该文件；不给我会扫整仓 114 文件） |
| 引用锚点门 | `_gate-claim-anchor.cjs` | node | `--draft` + 可选 `--anchors` / `--manifest`；`--json` 输出**自带 `line` 字段**（report 靠它出行号） |
| 语言门 | `_phrase-lint.py` | python | `--draft` + **必须显式 `--phrases`**（词库在工作台 `references/phrase-bank.json`） |
| 期刊契约门 | `_journal-contract.cjs` | node | `--draft` + **必须 `--contract`**（缺契约文件 ⇒ 跳过，不算通过） |
| 成品件核验 | `_verify-docx.py` | python | 位置参数给 docx |
| md↔docx 同步门 | `_gate-artifact-sync.py` | python | `--md` + `--docx`；**前提层失败（核验器缺失/崩溃）退出码 2，与断言失败 1 分开** |

> 十道门的接口**各不相同**（有的吃位置参数、有的吃 flag、有的要两份输入）——所以参数模板写在真源里，执行器不硬编码。
> **L-12 没有单独的第三道门**（2026-10-14 复核）：它的两条判据已由 `docx-verify` + `artifact-sync` 覆盖，再建一门就是重复判据 —— 改为把缺陷修在既有的那一门上（见 L-13）。
> **经验 → 门的映射**只写在一处：`references/pipeline.json` 的 `lessons_coverage`。

**执行纪律（每条都由一次真实事故换来）**：
1. **逐门打印退出码 + stdout 是否为空**；`rc≠0 且 stdout 为空` 一律归**前提层失败**（不是"结果为空"）。
2. 跑门前**无条件断言**解释器与脚本存在 —— 本机出现过子进程缺系统模块目录导致 `Get-FileHash` 不存在、探针把"取不到"读成零的先例。
3. 判据改动**必须回读真值**，并有必失败件（改坏必须变红，且红的是这一条）。
4. **判定器自己也要被判**（L-13）：子进程 `rc≠0` 必须**分类** —— 崩溃/缺模块/参数错 ⇒ **前提层失败**，绝不折成断言失败。2026-10-14 实测：venv 缺 `python-docx` 让核验器一 import 就崩，同步门报出「成品落后于源稿」，于是一条**看起来很像真的假发现**进了验收记录。⇒ `report` 里前提层失败与"需修改"**分区显示**，就是防这个。
5. **入口守卫（`require.main`）必须在 `module.exports` 之后**：它一执行就跑 `main()`，而 `report` 会惰性 `require` 另一个文件、后者又反过来 `require` 本文件 —— 守卫放前面会拿到**空的导出对象**（实测报 `studio.readPipeline is not a function`）。

## 4. 红线（明确不做）

- ❌ **不做"降 AI 率 / 规避 AI 检测"**：外部仓库里有这类模块（`ai_humanizer`），本技能**明确不采纳**——学术诚信红线（已在 `DESIGN.md` §3 记录拒绝原因）。
- ❌ 不无材料凭空生成正文；不替作者下研究结论。
- ❌ 不自动投稿、不代填期刊系统、不碰账号与凭证。
- ❌ 不复制第三方技能/仓库正文：`paper-writer` / `paper-polish` 为 **CC-BY-NC-SA-4.0**（个人自用可，**随包分发不可**）；`academic-research-skills` 为 **CC BY-NC**；`XtraGPT` **无许可**（一行代码都不进产物）。许可边界见 `references/licenses.md`。

## 5. 许可与归属

本技能（paper-studio）为 JARVIS/DSH 自建，编排逻辑与 `pipeline.json` 自写；
其调用的第三方技能与仓库**各自保留原许可**，本技能只**引用路径与用途**，不分发其内容。

## 6. 兼容性

- 纯技能 + CLI（`bin/studio.cjs` 带 `require.main` 守卫，被 require 时必须静默零副作用）。
- **同时提供 DSH 插件**（`plugin/`，2026-10-14 起）：对话驱动、**无面板**、双模式（用户模式默认封闭 / 开发者模式需用户原话解锁）、五种写作模式。安装：`plugin_manager install_bundle target="link:<本仓路径>/plugin"`。插件**只注册两个工具**（`paper_studio` / `paper_dev`），不注册任何客户端 Slot、路由或前端资源 —— 因此**不会出现"面板消失/白屏"类事故**（这也是当初决定不做面板的原因）。
- 零第三方依赖；Node ≥ 20。

## 7. 质量验收（A 类门 ≠ 质量通过）

**A 类门（本仓 11 道）只能判"可机检项"**：能证伪格式、缺件、口径冲突、数字漂移；**不能**判"这篇稿子好不好"。所以：

1. **全绿 ≠ 质量通过**。A 类全绿只说明"没有已知的机器可判缺陷"，不构成质量结论。
2. **B 类＝跨模型族复核**（换一个模型族当审稿人，而不是同一模型自评，避免同族自证）。
3. **双停止条件（两个都满足才停）**：`score ≥ 6` **且** `verdict ∈ {ready, almost}`。任一不满足 ⇒ **继续改，不宣布完成**。
4. **审查器自身也会造假阳性**（实测三类：注释当代码、解析不出当漂移、字样当实现）⇒ **每个假阳性都要变成一个夹具**，否则门会被噪声废掉，最后没人看。
5. **同一证据不得为同一结论提供第二次"独立"支撑**；**"跑过"≠"准"**（要么给出逐类命中率与 FNR/FPR + 样本量，要么只能标 advisory；样本 <20 时 FPR 只作下界）。
6. **B 类复核的产物必须落成可点开的证据**（评审记录 + 逐条判据 + 分数与 verdict），不能只说"我审过了"。

> 出厂审查 `node bin\studio.cjs audit` 的 6 项（文档覆盖 / 规则表重复 / 真源单一所有者 / 门元数据 / 工具自检实跑 / 数字漂移）也属 **A 类**，同样不能替代 B 类。

## 8. 许可与归属（摘要）

本编排层为自建（MIT，见 `LICENSE`）；它**引用的第三方技能与仓库各自保留原许可**，本仓只登记路径与用途、**不分发其内容**（三分类口径见 `NOTICE.md`）。
- Python 门需要真解释器：本机**优先用 playbook 自带 venv**（`D:\DeepSeek\research-paper-playbook\.venv\Scripts\python.exe`，列在 `pipeline.json` 的 `assets.python_exe`）；
  **PATH 上的 `python`/`python3` 在 Windows 上常是 Microsoft Store 占位符，脚本会跳过它**。真缺解释器时 `gates` 如实标注「运行时不可用 + 已试过哪些」，**不假装通过**。
