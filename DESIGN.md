# 论文工作室（paper-studio）· 设计方案与事后总结 v1.1

> 生成时间：2026-10-14 02:4x（DSH / JARVIS）· **事后总结追加：2026-10-14 12:5x**
> 定位：**把「论文写作」从综合工作台/整合包里单独拎出来，做成一个可独立安装、可迭代的插件**。
> 状态：**已落地并验收**（V1 冻结 → V1.1 五项升级；版本 1.1.0）——
> 验收凭据见 `V1-验收报告.md` / `V1.1-验收报告.md`；本文件 §1 §2 已由「设计稿推断」升级为**事后总结**（原推断保留，新增内容标明来源）。

---

## 0. 一句话与边界

**一句话**：论文工作室 = **编排层** —— 它不重写任何已有的论文方法论，而是把本机已有的「方法论（playbook）＋ 门禁（14 道机器门）＋ 写作/润色技能」收敛成**一个入口 + 一条流水线 + 一组必过门**，并明确自己的许可边界。

**它做什么**：判类型（写 / 改 / 查 / 投稿体检）→ 选链路 → 调已有资产 → 跑门 → 出待修项与成品件。
**它不做什么**：不复制第三方技能正文、不代做研究判断、不做"规避 AI 检测"、不绕过已有技能的许可限制。

---

## 1. 这一段做插件的方法与路线（总结）

按"实际做过并留下证据"的口径列，每条都指得出出处：

| # | 方法 | 为什么有效（证据） |
|---|---|---|
| 1 | **先定唯一真源，再写三个入口** | 工作台三个入口（CLI / MCP / 面板）只读 `capability-registry.json`；判档逻辑只有一份 `lib/route-core.js`（UMD，Node 与浏览器共用）。**双实现必然漂移**——对抗评审两次证实：CLI 判 T2、面板判 T0 |
| 2 | **能力表用 `verified` 日期管** | 没实测过的能力一律 `unverified`、不进主链路；实测通过才登记 |
| 3 | **成本分档按后果判，不按字数判** | T0 机械（跑脚本）/ T1 常规（一次强模型）/ T2 重要（强模型 + 对抗复核 + 过门）；判据："错了会被人看见 → T2" |
| 4 | **每条判据都必须有"必失败夹具"，且改动后要回读真值** | 两次真实事故换来：变异没匹配上 ⇒ "必红"是假的；⑭ 门被我自己的 `applyDraft` 前缀骗过 ⇒ 判据静默失明 |
| 5 | **数字一律从真源推导，不手写** | 同一个文件数两周内漂了三次（65→66→70）；现在 README 数字与载荷数、清单自报数三者互为门 |
| 6 | **兼容性写死在代码里，不靠记性** | DSH 客户端插件：纯具名导出（禁 `default`）、`apply` 绝不 throw、缺依赖降级 noop、**可选服务用延迟注入**（静态必需依赖缺一个 ⇒ 宿主不调 `apply` ⇒ 面板整块消失且不报错） |
| 7 | **跨 Agent 情报：先本机实测再采纳** | 4 个免 key 源实测：3 个 200 可用、1 个 404 不可用（对端说可用）⇒ 以本机实测为准 |
| 8 | **交付物要有台账** | `bridge-exchange.md`（EF-BRIDGE）、`handoff/*.md`（四段式交接）、`memory_log`、豆包 `task-log` —— 跨窗口续命靠这些，不靠上下文 |

补充两条工程纪律（都踩过）：
- **PS 5.1 传参**：`--json` 载荷含空格必被拆坏（实测报 `unknown command`）；正解＝零空格 JSON 或转义双引号，长载荷走文件 + `--stdin`。
- **替换/插入要锚定整行声明**：用 `function cmdRegress() {` 当锚点插函数会把 `async ` 吃掉 ⇒ 语法崩 ⇒ 两条"退出码 1"是假证据。

### 1.1 实际走出来的方法（V1 → V1.1 追加，每条都有一次真实事故作来源）

上表是**动工前**的推断；下面这些是**跑过一遍之后**才浮出来的，单独列出以免与推断混淆：

| # | 方法 | 来源事故 / 证据 |
|---|---|---|
| 9 | **「前面想清楚的」和「跑出来成立的」要分栏写** | 本文件自己：§1 原表是推断，V1→V1.1 之后必须加这一栏——否则读者会把没验证过的推断当结论 |
| 10 | **判定器必须把「取不到」与「断言失败」分开**（子进程崩溃/缺件/参数错 ⇒ 前提层失败，独立退出码） | 成品件同步门在 venv 缺 `python-docx` 时把核验器崩溃读成「成品落后于源稿」，产出一条**看起来很像真的假结论**；我据此**两次误告用户"你的稿子不同源"**（实测其实是同步的） |
| 11 | **抽取类判据的候选必须带边界，并配"不该报的必须不报"的反向控制夹具** | 引用抽取正则扩展名无尾边界 ⇒ `references/pipeline.json` 被读成 `.js`、`assets.python_exe` 被读成 `.py`，一条文档引用变成两条"引用了不存在的脚本"告警（技能体检 WARN 0 → 14） |
| 12 | **入口守卫（`require.main`）必须放在 `module.exports` 之后、`const` 声明之后** | 两处同族事故：守卫在前 ⇒ 惰性 `require` 拿到**空导出**（`studio.readPipeline is not a function`）；`const` 表在守卫之后 ⇒ **TDZ** |
| 13 | **夹具本身也要被判**：期望值必须逐条对着**读数**写，并同时给"必红"与"不得误报"两类 | 三处夹具写错：把正文句当事故形状（该不报的却被我写成必须报）、`--allow-comments` 语义写反、注释体期望值写死 1（实际 2）。**夹具写错比判据写错更危险——它会让你以为判据在守，其实在骗** |
| 14 | **登记进「能力表」会扩大判据扫描面**：登记与横幅/数字侧车必须**同批**做 | paper.studio 入表后技能体检从 0 WARN 变 14 WARN（它开始扫这个技能的 SKILL.md）；能力数 41→42 同时牵动横幅、README、package.json、数字侧车 |
| 15 | **改了声明的自检数字，必须同批改登记表里的自报数** | 技能体检自检 19/19→20/20（我加了夹具）而登记表还写 19/19 ⇒ 数字一致性门同时红两条（数字核对 + 登记表） |
| 16 | **语言/类型推断要剔除"不是自然语言"的东西，且判不出来就说判不出来** | `lang` 把模板头里的 `paper-studio` / `references/templates.json` 当成英文 ⇒ 短中文骨架被判 `en`；修法＝剔除代码/URL/路径/缩写/标识符 + 样本太小判 `unknown` + `--lang` 覆盖 |
| 17 | **"回头改口"要有成本意识**：报出去的结论一旦被推翻，必须显式更正而不是悄悄改 | 上面第 10 条的假结论已两次进入我给你的汇报；更正写在 `V1.1-验收报告.md` 与当日日志，不藏 |

**一句话**：V1 的推断里「判据化 / 实测优先 / 治理前置」三条都兑现了；而**真正花掉大半返工时间的，全是"判定器自己骗自己"这一类**（上表 10–13、15）。

---

## 2. 反思

**做对的**：
1. **判据化**是这一路最大的复利——把"我记得要检查"变成"改坏必然变红"，于是敢连续重构（工作台从 4 个页签扩到 5 个、加图片/加文件、加两条数字门，每次都能立刻自证）。
2. **实测优先于声明**：宿主进程比文件旧（静态全绿、真请求全 404）那次，如果只读文件就会得出完全相反的结论。
3. **治理前置**：本次开工第一件事查重，才没有造出第 17 个论文技能。

**做错/差点做错的**：
1. **只看输出不看退出码** —— 预检自检输出 30/30 却 exit=2，我连跑两轮都没看退出码（假绿）。
2. **自己的检查器反复骗自己**（本会话 7 次量级）：ANSI 色码切断正则捕获、全角括号致 SyntaxError、数了字面量而不是数组长度、`indexOf` 前缀撞名。
3. **整合包线铺得过宽**：为了"清单完整性"不断加门、加数字、加脚本，边际收益下降、token 消耗上升 —— 用户叫停是对的。**教训：先做窄而闭环的一条线，再谈扩张。**
4. **没有一开始就定"谁来读"**：门加了但没人跑（后来靠"带 selftest 的脚本必须被某道门跑到"这条前提判据才补上）。

**迁移到论文插件上的三条（回头看：兑现两条半）**：
- 只做**一条闭环**（体检 → 待修 → 复验），别一上来铺 11 个维度。→ ✅ **完全兑现**：编排层只跑「判类型 → 过门 → 出带行号待修项」一条线，方法论仍留在 playbook。
- 门禁**复用** playbook 现成的 14 道，不新写、不复制。→ ✅ **兑现**：八道门全部登记真源路径、运行时现取；两道新门（L-1 工作注记泄漏 / L-2 声明四件套）落在 playbook 根、与既有门同规矩，**L-12 复核后主动不建第三门**。
- 许可与归属**写进 SKILL.md 与登记表**，第三方内容只引用不搬运。→ ✅ **兑现**：`SKILL.md` 有许可边界章节，`pipeline.json` 的 `assets` 只存路径、`lessons_coverage` 只存映射；CC BY-NC 与无许可仓库的内容一行未进产物。

**V1 → V1.1 阶段的事后反思（2026-10-14 追加）**：

1. **最大的返工来源不是领域知识，而是"判定器自己骗自己"**。两条根因贯穿本轮：① 把「取不到/抽错了」读成「结果为否」（同步门把崩溃读成"成品落后"、引用抽取把 `.json` 读成 `.js`）；② **夹具写错**——它比判据写错更危险，因为你会以为有人在守。→ 已固化成纪律：**退出码分类 + 反向控制夹具 + 夹具期望值对着读数写**。
2. **我对外报过一个假结论，且报了两次**。教训不是"下次小心"，而是**判定器输出必须能被独立质疑**：现在 `report` 把「前提层失败」与「需修改」**分区显示**，就是为了让人一眼看出"这条是环境问题、别照着改稿"。
3. **推断与实证必须分栏**。设计稿写得很顺，但真正定型的判据几乎都来自事故（上表 10–17）。→ 本文件因此从"v0 设计稿"改成"v1.1 设计方案**与事后总结**"，两栏并列而不是覆盖。
4. **"同批"是这套体系的硬约束**：登记能力 / 改横幅 / 改自报数字 / 刷新数字侧车，四件事分开做必然产生假红（本轮各撞过一次）。→ 与跨 Agent 对拍里那条「合并是格式选择、分层是判据前提」同构：**一致性靠批，不靠记性**。
5. **兼容性这次没出事，但靠的是"复用而非新建"**：不注册客户端半体、不改既有技能、只登记路径 ⇒ 没有"面板消失"类的面；整仓日审 28 门全过、判据区分力全部有效。**下次若要加客户端半体，风险面就完全不同了**（那才是白屏高发区，必须走插件预检 + 关机窗口）。

---

## 3. 外部调研（能不能逆向 / 借鉴什么）

已把 4 个仓库**浅克隆到本地**做结构级逆向：`<外部参考克隆>\`

| 仓库 | 许可 | 结构 | 可借鉴 | 红旗 |
|---|---|---|---|---|
| [xiaoshuntian/academic-paper-skill](https://github.com/xiaoshuntian/academic-paper-skill) | **MIT** ✓ | `skill.json` + `src/{api,cli,prompts}.js` + `prompts/*.md`（abstract/caption/cite/draft/polish/review/system 一任务一文件）+ `templates/*.md`（ACM/IEEE/Nature/中文期刊/中国科学系列/社科）+ `bin/` + `tests/` | **"一任务一 prompt 文件 + 按刊物模板 + CLI"** 三件套；MIT 可直接借鉴（署名） | 无（唯一需注意：别把它的 prompt 原文当自己的方法论搬） |
| [yanlin-cheng/skill-thesis-writer](https://github.com/yanlin-cheng/skill-thesis-writer) | **木兰宽松 v2** ✓ | `SKILL.md`(361 行) + `references/`（学科指南 ×4 + GB/T 7714 spec + 写作规范 + 质量清单 + 统计表格）+ `scripts/*.py`（ai_humanizer / format_references / generate_stat_table / quality_checker） | **"SKILL.md + references + 可执行脚本"** 三元结构；**GB/T 7714 与统计表格**两块与中文投稿直接相关 | ⛔ **`ai_humanizer` / "降 AI 痕迹"模块 ＝ 规避 AI 检测** —— 触碰学术诚信红线，**不采纳**（并要记录拒绝原因） |
| [Leooo-Huang/academic-research-skills](https://github.com/Leooo-Huang/academic-research-skills) | **CC BY-NC**（禁商用）⚠️ | 多技能 + `shared/handoff_schemas.md`(**跨技能交接契约**：每阶段产物的必填字段 + 缺字段即 `HANDOFF_INCOMPLETE`) + `academic-pipeline/agents/`（orchestrator / state_tracker / integrity_verification 三 agent） | **最强借鉴＝"阶段间交接契约"**：把"上一阶段交给下一阶段的东西"写成带必填字段的表，缺字段直接判失败 | 许可禁商用 ⇒ **只能学模式，不能搬内容**；随包分发前必须过许可 |
| [Xtra-Computing/XtraGPT](https://github.com/Xtra-Computing/XtraGPT)（ACL 2026） | **无 LICENSE 文件** ⛔ | 研究仓库 + 自带 `xtragpt-paper-revision-skill/`（`providers/*.yaml` + `routers/*.yaml` + `skills/*.yaml` + `templates/` + `bin/` scaffolder） | **"provider + router + skill" 声明式三件套**：路由规则按请求自动触发技能；**prompt 模板即契约面**；README 还如实披露"scaffold 出来的 YAML 宿主并不自动收录" | 无许可 ⇒ **一行代码都不能进我们的产物**；只能提炼架构模式 |

> 另有两个候选（`GPTAlgoPro/academic-research-skills` 疑似 fork、`shuozhao-academic-skills` npm 包被标记）——本轮**不深入**，等 P1 需要时再评审。

**结论（一句话）**：**方法可以学，内容不能搬**。可学四件事：① 一任务一 prompt 文件；② 按刊物/学科切模板；③ 阶段间交接契约（必填字段 + 缺字段判失败）；④ 声明式 provider/router/skill 三件套（路由即入口）。

---

## 4. 本机存量盘点与治理裁决

**已有论文类技能 16 个**（`<技能根>\`），其中与本次直接相关的四个：

| 技能 | 规模 | 定位（据其 description） | 许可 |
|---|---|---|---|
| `research-paper-playbook` | 70 行 SKILL + D 盘真源（**4118 个 md / 16286 文件**） | 中文全流程方法论：11 维判据源 + **14 道机器门** + 138 条投稿前检查表 | 本侧自有 |
| `paper-writer` | 284 行 | 由作者自有材料起草正文；引用过"独立核验阶梯"；零占位符 | CC-BY-NC-SA-4.0 |
| `paper-polish` | 267 行 | 忠实润色 + 中译英 + 去 AI 味 + 抑制过强断言 | CC-BY-NC-SA-4.0 |
| `doubao-academic-polish` | 53 文件 / 654 KB | 豆包侧总入口：paper-write-zh / paper-write-en / paper-shape | 豆包侧 |

**登记表已有 10 条**：`paper.playbook` · `paper.gate.contract` · `paper.gate.claim` · `paper.gate.doi` · `paper.gate.phrase` · `paper.phrasebank` · `paper.fulltext` · `paper.writing-assistant` · `paper.ultron-pack` · `env.claim-check`（全部 `verified`）。

### 裁决（按"撞重叠→裁决、无分类→登记、无用途→不入库"）

- **不新建方法论技能**：方法论已有真源（playbook），再写一份 = 造第二个会分叉的副本。
- **不合并、不改写第三方技能**：`paper-writer` / `paper-polish` 是 CC-BY-NC-SA，动它要连带处理许可与归属；**它们保持原样，被编排层按需调用**。
- **要新建的是编排层**：`paper-studio`（本方案），只做**判类型 → 选链路 → 调资产 → 跑门 → 出待修项**，不承载方法论正文。
- **登记**：新建后须在 `capability-registry.json` 登记（`kind=pipeline` 或 `kind=skill`），并跑 `check-registry` + `doctor`。

---

## 5. 插件设计

### 5.1 架构（三层，全部复用，不重写）

```
┌─ 入口层  paper-studio ───────────────────────────────┐
│  CLI: node bin/studio.cjs <intake|check|gates|deliver>│
│  （P2 可选）DSH 面板页签 = 只读 studio 的 JSON 产物    │
└───────┬──────────────────────────────────────────────┘
        │ 判类型（写/改/查/体检）→ 选链路 → 过门
┌───────┴─ 资产层（引用，不复制）───────────────────────┐
│ 方法论  research-paper-playbook（D 盘真源 · 138 条）  │
│ 门禁    playbook 的 14 道机器门（node / python）      │
│ 写作    paper-writer（起草）                          │
│ 润色    paper-polish（润色/中译英）                   │
│ 精读    doubao-paper-close-reading（豆包侧，走共享记忆）│
└───────────────────────────────────────────────────────┘
```

### 5.2 目录（拟）

```
<包根>\
├── SKILL.md              # 入口描述（何时用/不用于/示例/许可声明）
├── DESIGN.md             # 本文件
├── bin\
│   ├── studio.cjs        # 统一 CLI（子命令：intake / route / gates / report）
│   └── gate-runner.cjs   # 按 registry 跑 playbook 的门，汇总退出码与失败项
├── references\
│   ├── pipeline.json     # 流水线定义（阶段/产物/必填字段/门）——**单一真源**
│   ├── handoff.json      # 阶段间交接契约（借鉴 academic-skills 的 schema 思路）
│   └── licenses.md       # 第三方归属与许可边界（CC-BY-NC-SA / 木兰 / MIT）
└── docs\快速上手.md
```

### 5.3 数据流（一条闭环，先窄）

```
intake（把稿子/主题收进来）
  → 判类型：write | polish | check
  → 选链路：write = playbook 框架门 → paper-writer 起草 → 语言门 → 引用锚点门
            polish = paper-polish → 语言门 → 数字一致性门
            check  = 直接跑「投稿前体检」（14 门 + 138 条清单）
  → 跑门：gate-runner 逐门执行，**收集退出码 + 失败项**（不是只看汇总）
  → 出报告：待修项（带行号）+ 成品件状态 + 门通过表
```
**必过门（P0 先接这四道）**：`_contract-check.cjs`（契约门）· `_gate-claim-anchor.cjs`（引用锚点门）· `_phrase-lint.py`（语言门）· `_verify-docx.py`（成品核验）。

### 5.4 兼容性设计（"别把自己搞崩"的具体条款）

| 风险 | 处置 |
|---|---|
| 新技能与已有 16 个撞名/撞职责 | 名称用 `paper-studio`；SKILL.md 明确"不用于起草/润色本体，那走 paper-writer / paper-polish" |
| 复制方法论导致双份真源分叉 | **只引用 D 盘 playbook 路径**，不复制 `research/`、不复制门脚本 |
| Python/Node 环境差异 | 门执行前**无条件前置**：断言解释器与脚本存在（本机有 PSModulePath 缺目录致 `Get-FileHash` 不存在的先例） |
| 门"跑了但没看退出码" | gate-runner 逐门打印**退出码 + stdout 是否为空**，并把"rc≠0 且 stdout 空"归前提层失败 |
| 面板/宿主版本差异 | P2 才做面板；面板只读 `pipeline.json` 派生的 JSON，**不内联第二份判据** |
| 第三方许可 | `licenses.md` 声明三层边界；**CC-BY-NC-SA 与无许可内容一律不进包** |
| 我自己搞崩 DSH | 本插件**纯技能 + CLI**（不动 DSH 插件清单）；若将来要暴露成 MCP 工具，遵守"纯具名导出 / apply 不抛 / 可选服务延迟注入" |

### 5.5 明确不做

- ❌ 不写"降 AI 率 / 规避 AI 检测"（`ai_humanizer` 那类）——学术诚信红线，已在 §3 记录拒绝原因。
- ❌ 不把"代写"扩展成无材料凭空生成：起草必须有作者材料/已验证检索/领域常识三者之一。
- ❌ 不自动投稿、不代填期刊系统、不碰账号类操作。
- ❌ 不复制第三方技能正文（只引用路径与用途）。

---

## 6. 落地分期

| 期 | 交付 | 判据（完成才算） |
|---|---|---|
| **P0 骨架** | `SKILL.md` + `bin/studio.cjs`（intake/route）+ `references/pipeline.json` + `docs/快速上手.md` | `node bin/studio.cjs route "给这篇稿子做投稿前体检"` 输出链路与必过门；`check-registry` P0/P1=0 |
| **P1 接门** | `bin/gate-runner.cjs` 接四道门 + `handoff.json` | 对**真稿**跑一遍：逐门退出码可见；故意改坏一处必变红（必失败证明） |
| **P2 面板（可选）** | DSH 面板页签只读产物 | 面板与 CLI **同源**（同一 JSON），不内联第二份判据 |
| **P3 稳定态** | 加第二条链路（polish）、登记 `licenses.md` 复核 | 一条链路端到端跑通 ≥3 次无人工修正 |

---

## 7. 参考链接

- [xiaoshuntian/academic-paper-skill](https://github.com/xiaoshuntian/academic-paper-skill)（MIT）
- [yanlin-cheng/skill-thesis-writer](https://github.com/yanlin-cheng/skill-thesis-writer)（木兰宽松 v2；含须拒绝的 `ai_humanizer`）
- [Leooo-Huang/academic-research-skills](https://github.com/Leooo-Huang/academic-research-skills)（CC BY-NC；交接契约思路来源）
- [Xtra-Computing/XtraGPT](https://github.com/Xtra-Computing/XtraGPT)（ACL 2026；无许可，仅学架构）
- 本地克隆：`<外部参考克隆>\`
- 本地真源：`<playbook 仓>\`（138 条检查表 + 14 道门）
