# 市面能力清单（论文类插件/技能）· 对齐取证

> 目的：用户要求「**拥有市面上所有论文相关插件或技能的功能**」⇒ 先摸清市面、逐条对齐、**如实标注我方缺口**。
> 建立于 2026-10-14。命名：**「论文方案」**＝论文框架 + 方法论 + 工作流。

---

## 0. 取证方式与**通路真相**（先记，免得下次重复踩）

| 通路 | 状态 | 证据 |
|---|---|---|
| `raw.githubusercontent.com` | **不通** | `web_fetch` ⇒ `getaddrinfo ENOENT` |
| `cdn.jsdelivr.net/gh/...` | **不通** | 302 回源到 raw ⇒ 跨域重定向被拒 |
| `git clone https://github.com/...` | **不通** | `fatal: unable to access ... Connection timed out after 300012 ms`（实测 300s 超时） |
| **Gitee `git clone`** | ✅ **可用** | 三家一次成功：`whatalee/awesome-ai-research-writing` · `guluxiaojiaozi/dsh-sci-fault-diag-paper` · `frontxiang/Auto-Empirical-Research-Skills` |
| **GitHub MCP**（`search_repositories` / `get_file_contents` 目录列举） | ✅ **可用** | 能拿仓库结构（文件/目录名）；**取文件正文返回 embedded resource，本机 harness 无法内联** ⇒ 只能拿结构，拿不到正文 |
| `web_search` | ✅ 可用 | 拿到 PyPI/GitHub 条目与描述 |
| PyPI JSON API | 未测（备选通路） | — |

⇒ **结论：GitHub 仓库的"正文级"逆向在本机不可行；但"结构级"（目录/文件名）可行，Gitee 仓库可完整克隆。** 市面清单以**可克隆的 Gitee 仓库 + GitHub 结构 + 搜索结果描述**为准，**不假装读到了正文**。

---

## 1. 竞品矩阵

| 竞品 | 形态 | 我方取证深度 | 定位 |
|---|---|---|---|
| **`guluxiaojiaozi/dsh-sci-fault-diag-paper`**（Gitee） | **DSH Cordis 原生插件**（plugin/ + hub/ + skill/） | **README 前 120 行全文** + 672 文件结构 | 故障诊断/知识图谱类 SCI 写作主插件 + 科研中枢；**八阶段流水线 + Checkpoint** |
| **`whatalee/awesome-ai-research-writing`**（Gitee） | Prompt 模板库 + 技能清单（905 行 README） | README 前 130 行（目录全 + 2 个完整 prompt） | 一线科研人员写作技巧开源：**全生命周期 prompt** |
| **`wp-a/paper-refine`**（GitHub） | Claude/Codex Skill（`.claude-plugin` + SKILL.md + references/ + evals/ + plugins/ + tests/） | **目录结构 + references/ 逐文件名**（正文不可取） | 中文优先**润色与逻辑重构**，保留科学事实 |
| **`KalarisLabs/research-agent-skills`**（GitHub） | 生态型（`plugin.json` + catalog/ + skills/ + cli/ + tools/ + evals/ + **benchmarks/** + install.sh/ps1 + mkdocs 站点 + security/ + LICENSES/） | 目录结构 | 学术多学科技能库（写作/文献/引用/工作流） |
| **`frontxiang/Auto-Empirical-Research-Skills`**（Gitee） | 生态型（`aers_score/` + agents/ + benchmark/ + catalog/ + eval-harness/ + evals/ + plugins/ + demo-notebooks/） | 结构（4603 文件 / 91 MB） | 实证研究自动化（Stata/Python/Jupyter） |
| `Imbad0202/academic-research-skills`（GitHub，5.2 万星） | Claude Code 插件 | **此前已逆向**（CC BY-NC，只吸思想） | 综述/idea 全流程 |
| `seele-scholar-agent` · `med-paper-assistant` · `research-plugins`（PyPI） | Python 包 | 仅元数据 | 领域化论文助手 |

---

## 2. 功能对齐表（逐条：谁有 · 我方状态）

> 我方状态口径：**✅ 有**（真源+代码+自检三处齐）· **◐ 部分**（只有规则没有机检/只有其一）· **✗ 缺**

### A. 启动与交互
| 功能 | 竞品 | 我方 |
|---|---|---|
| 对话内触发（说"帮我写论文"就进流程） | DSH 插件以**工具**为主，靠模型自己调 | ✗ **待建**（V3 意图判断流程） |
| **双模式（用户/开发者）** | 未见任何一家有 | ✗ **待建**（这是我方**差异化**） |
| 每步 Checkpoint / 点点选项 | dsh-sci 有「每阶段 Checkpoint 等你确认」 | ◐（有确认概念，无点击式选项） |
| 五种写作模式可选 | 未见有（多为固定单流程） | ✗ **待建**（差异化） |

### B. 写作与结构
| 功能 | 竞品 | 我方 |
|---|---|---|
| 阶段流水线（S0–S7 / 八阶段） | dsh-sci 八阶段；Leo 五阶段 | ✅ 有（S0–S7 + 阶段契约） |
| 体裁适配（IMRaD/综述/快报…） | 少数有（Leo） | ✅ 有（`genre` + 分体裁节骨架） |
| 章节骨架 + 字数预算 | dsh-sci 有 | ✅ 有 |
| **叙事原则/一句话贡献/摘要五句公式** | **未见**（他们给模板不给原理） | ✅ **有**（V2.9 真源+stylecheck） |
| 逻辑检查（段落级） | awesome 有「逻辑检查」prompt | ◐（有 stylecheck 的软规则，无段落逻辑检查） |
| **缩写 / 扩写** | awesome 有（缩写、扩写两个专门 prompt） | ✗ **缺** |

### C. 润色（**竞品最集中的域，也是我方最大缺口**）
| 功能 | 竞品 | 我方 |
|---|---|---|
| 表达润色（中/英） | awesome（表达润色英文/中文）；paper-refine | ◐（润色模式只有边界规则，无手法） |
| **改动账本（逐处改动留痕）** | **paper-refine `change-ledger.md`** | ✗ **缺**（我只有"给理由"的口头要求） |
| **LaTeX 保真 + 特殊字符转义** | **paper-refine `latex-preservation.md`**；awesome 明列 `95%→95\%` · `model_v1→model\_v1` · `R&D→R\&D`、公式原样 | ✗ **缺** |
| **去 AI 味（词汇/句式）** | awesome（去 AI 味 LaTeX/Word）；dsh-sci（去AI化词汇表） | ◐（stylecheck 删填充词，无 AI 味词表） |
| 分节改写指南 | paper-refine `section-revision-guides.md` | ✗ **缺** |
| 主张-证据边界 | paper-refine `claim-evidence-boundaries.md` | ✅ 有（claim-anchor 门） |
| 自然学术措辞 | paper-refine `natural-academic-prose.md` | ◐（有模糊词/hedging 清单） |
| 时态规范（方法/结论用现在时） | awesome 明列 | ✗ 缺 |
| 禁 `\item`、禁破折号、禁过度排版 | awesome 明列 | ✗ 缺 |
| 中→英 / 英→中（LaTeX 与 Word 双通道） | awesome 四种通道 | ✗ **缺**（**中文用户刚需**） |

### D. 图表
| 功能 | 竞品 | 我方 |
|---|---|---|
| 论文架构图生成 | awesome「论文架构图」 | ✗ 缺 |
| 实验绘图推荐 + 图/表标题生成 | awesome 三项 | ◐（有图规则，无生成/推荐） |
| 绘图闭环（图库 + 四阶段） | dsh-sci `plot-is-all-you-need`（119 张图库） | ✗ 缺 |
| Anti-slop 图表设计原则 | dsh-sci `taste-skill` | ◐（有"图 1 至关重要/图注自包含"） |

### E. 文献与引用
| 功能 | 竞品 | 我方 |
|---|---|---|
| **verify-or-drop（核验否则删）/ 严禁编造** | dsh-sci（critical 教训）；Leo | ✅ **有**（V2.8 citation_discipline + 五形态 + 保留打标） |
| 多源核验（DBLP/CrossRef/arXiv/OpenAlex/S2） | Leo；dsh-sci（12KB 纯 stdlib 后端） | ✅ 有（机制 + 通路分层 403/429/DNS/404） |
| 文献检索→**交用户勾选** | 少数 | ✗ **待建**（共同创作模式的一步） |
| 最少引用条数 / 全核验 | dsh-sci 明列（≥40 条） | ◐（有核验，无条数下限） |

### F. 审稿与交付
| 功能 | 竞品 | 我方 |
|---|---|---|
| **以 Reviewer 视角整体审视** | awesome 专门 prompt | ◐（有 11 道门 + 跨模型 reviewer 概念，无"审稿人视角通读"流程） |
| **审稿回复 / rebuttal** | awesome 全生命周期含「审稿回复」 | ✗ **缺**（**重要缺口**） |
| Camera-ready 定稿 | awesome 含 | ◐（有 docx/artifact 校验） |
| 投稿件清单/声明集 | 未见系统化 | ✅ 有（declaration-set 门 8/8） |

### G. 工程质量与持久化
| 功能 | 竞品 | 我方 |
|---|---|---|
| **教训库（分级 + 用过次数排序 + 开工自动注入）** | **dsh-sci：62 条，critical/important/note，按触发次数排序，`lessons_brief` 开工注入** | ◐（L-1…L-12 无分级/无计数/无自动注入） |
| **研究风格档案（结构化，按点路径读写）** | **dsh-sci `style/profile.json`（领域/任务/方法/数据集/目标期刊/最少引用）** | ✗ **缺**（**高价值缺口**） |
| 归档（只追加、绝不删除） | dsh-sci `sci_archive` | ✅ 有（append-only + 软删 + 历史不丢） |
| **工具 parameters 严格 JSON Schema** | **dsh-sci v2.1 修过的 400 报错坑**：扁平写法 ⇒ 严格通道 400 拒收、宽松通道静默通过 ⇒ "换模型才报错" | ✗ **待建**（V3 每个工具必须 `type:'object'` + `properties` + `required[]`） |
| eval / benchmark / score | KalarisLabs（benchmarks/ + evals/）· Auto-Empirical（eval-harness/ + aers_score/） | ✅ **我方更强**（每个检查器带自检 + `calibrate` 真语料标定 + `check-registry` 数字一致性） |
| 跨会话持久中枢（NAS/hub） | dsh-sci `hub/` | ✅ 有（记忆系统 + 交接账本 + 工件） |

---

## 3. **缺口清单（按优先级）** —— 两家独立竞品在「润色」上**收敛到同一组要素**，这是最强证据

> **状态列**：✅ 已补齐（2026-10-14 起逐步关闭）· ⏳ 待补 · ➖ 决定不做（并写明理由）

| 优先级 | 缺口 | 状态 | 证据来源（收敛） |
|---|---|---|---|
| **P0** | **改动账本**（逐处改动 + 理由，可复核） | ✅ **已补**（`bin/polish.cjs ledger`，缺 kind/reason 拒收，可渲染成表） | `paper-refine/change-ledger.md` |
| **P0** | **LaTeX 保真与转义**（公式原样；`%` `_` `&` 转义；命令不被破坏） | ✅ **已补**（`polish guard`；真 LaTeX 对拍拦下三类违规；60 个真实 .tex 反身性误报 **0%**） | `paper-refine/latex-preservation.md` + awesome |
| **P0** | **中↔英双通道**（LaTeX / Word 各一） | ✅ **已补**（`polish check --channel cn2en\|en2cn\|word`：残留 CJK / 残留 LaTeX 各报） | awesome 四个专门 prompt |
| **P0** | **研究风格档案**（结构化，按点路径读写，开工注入） | ✅ **已补**（`bin/profile.cjs`：10 个结构化字段 + 点路径 + `brief` 只列已设置项；**凭证类字段名一律拒收**；BOM/吞引号都能兜） | dsh-sci `style/profile.json` |
| **P0（兼容）** | **工具 JSON Schema 严格化**（防 400 / 防"换模型才报错"假象） | ✅ **已补**（`bin/schema-check.cjs`：布尔 `required`＝事故签名必报；`--manifest` 结构化 + `--scan` 源码痕迹；真事故插件 dist 扫描 0 处，与其 v2.1 已修一致） | dsh-sci v2.1 实测教训 |
| **P1** | **去 AI 味**（词汇表 + 句式） | ✅ **已补**（`revise aitone`：20 个记号，英中双语，逐条行号 + 替换建议；**密度只作 advisory**） | awesome + dsh-sci |
| **P1** | **审稿回复 / rebuttal** 流程 | ✅ **已补**（`revise rebuttal`：逐条 4 段骨架 + 四类硬问题机检＝覆盖/空话/承诺未兑现/对抗措辞） | awesome 全生命周期 |
| **P1** | **Reviewer 视角整体通读** | ✅ **已补**（`revise readthrough`：机械证据清单（图/表/引用/风格）＋**10 个通读问题**，每个都标明「机械证据」或「需人读」；**只给证据与问题，不判质量**） | awesome 专门 prompt |
| **P1** | 缩写 / 扩写 | ✅ **已补**（`revise budget`：与真源 `budget_words` 逐节比对 —— 超预算给**删减候选**（AI 味行＋近似重复句），低于预算给该节**必答问题**作补内容方向；**父节含子节词数**（真稿实测踩过 0 词）） | awesome |
| **P1** | 分节改写指南 | ✅ **已覆盖，不重复造**：`studio sections` 每节已给「解决什么 / 必答 / 篇幅 / 门 / 证据义务 / 常见退回」（真源 `templates.json`） | `paper-refine/section-revision-guides.md` |
| **P2** | 论文架构图生成 / 图表标题生成 / 绘图推荐 | ✅ **已补（机械部分）**（`bin/figures.cjs`：`caption` 题注模板+体检 · `recommend` 绘图推荐+反模式 · `arch` **Mermaid 源码骨架**。**诚实边界：不生成图片**，只给可渲染源码与规格） | awesome · dsh-sci 图库 |
| **P2** | 教训库分级 + 用过次数排序 + 自动注入 | ✅ **已补**（`bin/coach.cjs`：**强制级别从 `checkable` 推导**（已挂门＝enforced）· **用过次数账本** `use <id>`（未知 id 拒收）· **`brief` 开工注入**按「用过次数降序 → enforced 优先」取 top-N，一行一条做法；**真实覆盖 6/13 已挂门**，如实报出） | dsh-sci |
| **P2** | 时态规范、禁 `\item`、禁破折号、禁过度排版 | ✅ **部分已补**（`polish guard` 对 `\item`/破折号给 warn；时态仍缺） | awesome |
| ➖ | **面板/GUI** | ➖ **决定不做**（用户明确：易崩难做；模式选择改用宿主 `ask_user_question`） | 用户 2026-10-14 指令 |


---

## 4. 打包教训（**直接用在我方 V3 插件上**）

**DSH 原生论文插件的结构（`dsh-sci-fault-diag-paper` 实证）**：
```
plugin/     ← 安装进 profile node_modules：package.json + cordis.patch.yml（insert 注册清单）+ dist/plugin.js（免编译纯 ESM）
hub/        ← 跨会话持久中枢（建议 NAS）：lessons/lessons.jsonl（只追加）· style/profile.json · skills/ · tools/
skill/      ← 平铺 SKILL.md 副本，放进 ~/.agents/skills/ 让 DSH 发现器扫到
```
⇒ **我方 V3 对齐**：`plugin/`（严格 schema 的工具）+ `hub/`（教训库 + 风格档案，我方的 lessons/记忆可挂这里）+ `skill/`（SKILL.md）。
⇒ 另有可借鉴的成熟件：`plugin.json` / `catalog/` / `evals/` / `benchmarks/` / `install.sh`+`install.ps1` / `mkdocs.yml` / `LICENSES/` / `third_party/` / `SECURITY.md`（生态型仓的完整度标准）。

---

## 5. 我方真实差异化（**不许吹**）

1. **双模式（用户封闭 / 开发者可改）** —— 市面**未见**任何一家做权限分层；这是用户要的独有设计。
2. **五种写作模式 + 点击式选项 + 每项一行小字** —— 市面多为"固定单流程"，无模式选择。
3. **可机检的门体系 + 真语料标定** —— 竞品有 evals/benchmark，但**未见"误报率随语料口径"的标定纪律**（我方 `calibrate` + `check-registry` 数字一致性 + `gate-runner` 工件哈希复核）。
4. **外部纪律吸收**（ARIS 的 acceptance-gate / reviewer-independence / assurance / citation-discipline / runstate done≠accepted 等）—— 竞品均为单流程 prompt，无此层。
5. **知之为知之的诚实记录** —— 本文件第 0 节明写通路受限与"没读到正文"，这是竞品 README 里看不到的东西。

---

## 实测修正（2026-10-17 · 真对拍 Task A 之后加，**旧结论保留在上，勿当现状**）

**旧结论**：「润色域 —— 竞品最集中的域，也是我方最大缺口」。

**★ 2026-10-17 二次修正（用户质问后自查，前一句"已推翻"是过度概括，**以此为准**）**：
- **测到的**：在**四个可机检维度**（数字/引用不变量 · 去 AI 味 · 改动账本可追溯性 · 具体性）上，我方与 lifecycle-skills **同档**，另两家 FAIL。
- **没测到的**：**润色质量本身**（人读项是 **agent 自评、非盲评**、1 份输入）⇒ **"不是缺口"这句话说过头了**。
- **我方到底"有没有"润色**：**有机械保障层，没有润色引擎** —— `polish.cjs` 自己的注释写着「只做机械可判的，判断仍归模型」。**执笔改写的是模型。**
- **补的测量装置**（本轮新增 `bin/polish-metrics.cjs`，自检 7/7）：对四家同输入产出用同一把尺子量 6 项代理 —— **只有我方零 WARN**（名词化 3.9% vs 8.0%/8.3%；被动 0 vs 1.4%/4.2%；AI 味 0；最长句 27 词 vs 66 词）。**代理 ≠ 质量。**

**证据**（`run/bakeoff/task-a-polish/REPORT.md`，可复跑：`node bin/bakeoff.cjs --task run/bakeoff/task-a-polish`）：

| 参赛者 | 中性机检 | 不变量 | AI 味 | 改动账本 | 失败原因 |
|---|---|---|---|---|---|
| **ours** | **PASS** | 2/2 | 0 | 7 行 | — |
| lifecycle-skills（Apache-2.0） | **PASS** | 2/2 | 0 | 5 行 | — |
| academic-research-skills（CC-BY-NC） | FAIL | 0/2 | 0 | 无 | 丢 `30` 与 `[12]`；不产出改动账本 |
| awesome-ai-research-writing（无许可） | FAIL | 0/2 | 7 处 | 无 | 丢 `30`/`[12]`；AI 味原样保留 |

**修正后的口径**（只到方向性证据这一层）：
1. 在**数字/引用不变量 · 去 AI 味 · 改动账本可追溯性 · 具体性**这四个可机检维度上，**我方与对手里最强的规则集同档**；
2. **真正有差别的不是"润色质量"，而是"是否把不变量与可追溯性当硬规则"** —— prompt-清单类会**在润色时抹平具体数字与引用标记**；
3. **仍未测**：语言自然度的**盲评**（需独立判者）· 对手**软件本体**效果（它们**没有可执行的 CLI**，本轮为方法级对拍）⇒ **不得声称"我们更强"，只能说"我们不再落后"**；
4. 「呈现类（slides/poster/talk-script）」与「parse-cfp / camera-ready / fit-page-limit / simulate-reviewers / triage-reviews」两项缺口**仍成立**（`talk` 已补呈现的第一块，其余待做）。

- **呈现类缺口状态（2026-10-17 Task B 后）**：`talk`（预算 / 口播 / deck lint）**已补**；deck 侧与唯一对手 `lifecycle-skills` **同档**（交叉工具对拍：两份独立 linter 对三份 deck 给出同样风险数），并据其对拍补齐 `no-marp-header`/`tiny-font`/`aspect-ratio` 三项、改正 `bullet-overload`/`generic-title`/`dense` 的严重度口径。
  **仍缺**：`make-poster`（海报 + 2/5 分钟 pitch）· `rehearse-qa`（问答彩排）· `fit-page-limit` · `parse-cfp` · `camera-ready`。
- **引用核验缺口状态（2026-10-17 Task C 后）**：`refs-verify` 已补（离线结构 + 在线元数据比对 + 撤稿 + fail-soft），判定分类法与对手同表；**仍缺**多源回落（DataCite/arXiv/DBLP/S2）· canonical-instance（预印本 vs 正式版）· relevance gate（离题条目）。

---

## 附录 A · 2026-10-17 复核（v3.23.0）——**缺口清单逐项结清 + 两次真对拍**

> 本文件第 0 节记录的取证限制（`raw.githubusercontent.com` / `api.github.com` 不通 ⇒ 只能做 README/结构级对比）**仍然成立**。
> 但 2026-10-17 新增了**两条真取证路径**：① 对手工具**从 npm 真装真跑**；② 我方工具在**真稿/真文件**上实跑。
> 下面是逐项复核结果。**凡未做到的不写"已覆盖"。**

### A1 · 缺口清单（本文件前文的"仍缺"项）逐项结清

| 原缺口 | 现状 | 落点 | 证据 |
|---|---|---|---|
| 时态规范（方法/结论用现在时等） | ✅ 已补 | `bin/tense-check.cjs` | 自检 6/6 |
| 段落级逻辑检查（原"只有软规则，不算机检"） | ✅ 已补（**启发式**） | `bin/paragraph-logic.cjs` | 自检 8/8；状态用 `OK/REVIEW/ISSUES/SKIP`，**不叫 PASS** |
| 呈现类：slides / talk-script | ✅ 已有 | `bin/talk.cjs` | 自检 10/10 |
| 呈现类：poster | ✅ 已补 | `bin/poster.cjs` | 自检 7/7；真稿生成 A0（3.6KB · 3 栏 · 5 节 · QR），版面计划报出「结论槽位 156 词 > 90」 |
| parse-cfp（会议征稿解析） | ✅ 已补 | `bin/cfp.cjs` | 自检 8/8；真形态征稿抽出 4 个截止（含 `2027年5月10日`）· 主页数 12 · 双盲 · elsarticle · Editorial Manager · 3 主题 |
| camera-ready | ✅ 已补 | `bin/camera-ready.cjs` | 自检 9/9；论文 A 真包（36.8KB 稿 + 5 PDF）⇒ **PASS · 0 ERROR · 6 WARN · 12 INFO** |
| fit-page-limit | ✅ 已补 | `bin/fit-pages.cjs` | 自检 8/8；论文 B 实测**超 7.32 页** |
| simulate-reviewers | ✅ 已补 | `bin/rehearse.cjs` | 自检 6/6；论文 A 报 2 条（缺伦理 + 图表未解读）、论文 B 报 4 条；**明确标注"模拟≠真实意见"** |
| triage-reviews | ✅ 已补 | `bin/triage.cjs` | 自检 8/8 |
| venue 预算合规 | ✅ 已补 | `bin/venue-budget.cjs` | 自检 6/6；论文 A × 12 页/250 词/6 图 ⇒ 页 11.69 ✔ · 摘要 237 ✔ · 图 4 ✔ |
| **润色域**（原文：「竞品最集中的域，也是我方最大缺口」） | ⚠️ **三次修正后的最终口径**：①**"可核查地改稿"**（不变量保真 / 改动账本 / AI 味控制）我方与 lifecycle-skills **同档**，另两家 FAIL；②**"润色质量"已补盲评（2026-10-17，`run/bakeoff/task-a-polish/BLIND-REVIEW.md`）**：独立判者把我方排 **第三**（lifecycle 19 > academic 17 > **ours 13** > awesome 12），理由「D 丢失数据」；③**代理指标与盲评打架**（我方 `polish-metrics` 零 WARN、名词化 3.9% 最佳，但盲评准确性只给 3）⇒ **"我方润色更好"不成立；代理指标不能代替盲评**；④我方**有规则化改写引擎（`polish rewrite`）+ 保障层**，**不是"懂语义的润色"** | `bin/polish.cjs`（rewrite）· `bin/polish-metrics.cjs` · **`bin/blind-pack.cjs`（盲评装置）** | 盲评：lifecycle **19** / academic 17 / **ours 13** / awesome 12（单判者·单样本）；代理：我方名词化 3.9% vs 8.0/8.3%、被动 0、AI 味 0、最长句 27 vs 66。**可改之处**：我方**过度压缩**（删 `一定程度上` 被读成丢信息）⇒ 应把"删模糊词"降级为"标注待定"。 |

### A2 · 真对拍（2026-10-17 · npm 真装真跑）——引用任务

**对手**：`dsh-lit-search@0.2.2`（npm 真装，有 CLI：`search/cite/bib/related`，Crossref + OpenAlex + Semantic Scholar）
**同输入**：2 条真 DOI（AlphaFold `10.1038/s41586-021-03819-2` · PRISMA `10.1136/bmj.n71`）+ 1 条假 DOI（`10.1234/fabricated2026`）

| 维度 | dsh-lit-search 0.2.2 | 我方 v3.22.0（修前） | 我方 **v3.23.0（修后）** |
|---|---|---|---|
| 2 条真 DOI | ✅ 完整 **BibTeX**（title/journal/year/**volume/number**/author 全，key 规范 `jumper2021highly`） | 仅核验（不生成 bib，**任务方向不同**） | 同 |
| 假 DOI | ✅ 明确 `-- missing: 10.1234/fabricated2026` | ⚠️ `CHECK_SKIPPED`「未核对」——**不如对手清楚** | ✅ **`NOT_FOUND` + `ERROR/UNRESOLVED`**（与对手对等） |
| 耗时 | **2.4 秒** | 10.1 秒 | **3.9 秒**（快 2.6×） |
| 撤稿标记 | ❌ 无 | ✅ 有 | ✅ 有 |
| 标题/年份/重复 DOI 交叉核对 | ❌ 无 | ✅ 有（`TITLE_MISMATCH`/`YEAR_MISMATCH`/`DUPLICATE_DOI`） | ✅ 有 |
| 版本核验（预印本 vs 正式版） | ❌ 无 | ✅ 有（`--canonical`，只提醒不自动改） | ✅ 有 |

**修法（由对拍直接换来）**：主源（第一个来源）**明确 404 就直接结案 `not_found`，不再遍历后备源** —— 语义从"未核对"变成"不存在"，同时省掉 6 秒。**这是"对拍 → 改代码"的实例，不是名目对齐。**

**如实记我方仍输的一项**：**速度**（3.9s vs 2.4s）—— 我方多做了撤稿/标题/年份/重复/版本五类交叉核对，这部分成本是"更全"的价格。**没有免费的全。**

### A3 · `@ai4paper/dsh-ipaper@0.1.2` 实测（npm 真装）

- 包结构：113 文件 · `lib/index.js` + `preset/` + `cordis.patch.yml` + `client.js`（Web UI）。
- 提供的核心：**注册 `agentPresets` 的写作 preset（`ipaper`）+ Web 界面**。
- **可机检的门/自检：未发现**（`lib/` 内无 gate/check/test/audit/lint 文件）。
- **结论（只说我测到的）**：它是**产品形态/界面与预设**层面更强（有 Web UI、开箱即用），**但我们没测到它的机检能力**；它的写作效果需要在其宿主里加载 preset 才能评，**本轮未做**（不计入对拍结论）。

### A4 · 仍**不能**声称的（更新）

1. **不能说"市面最优质"** —— 上面三家（PaperDebugger 1546★ / dsh-ipaper / academic-research-skills 5.2 万★）里：
   - `dsh-ipaper` 已真装、已看结构，**但写作效果未评**（需宿主加载）；
   - `PaperDebugger` 需 Overleaf 环境，**本轮无法跑**；
   - `academic-research-skills` 在 npm 与 Gitee 搜索均**未取到**（非 npm 包）。
2. **能说（可复核）**：在**同输入的引用任务**上，我方与 `dsh-lit-search` 各有胜项（它快而会生成 BibTeX；我方核验维度更多且会判撤稿/版本）；**假 DOI 的判定在 v3.23.0 已与对手对等**。
3. **速度**：我方引用核验 3.9 秒 / 3 条（对手 2.4 秒），差异原因已列（五类交叉核对）。
