<!-- claims: snapshot -->
> 本文件是**历史记录**：每版里的自检数字都是**当时快照**，不是当前声明。当前数字请看 `node bin/studio.cjs selftest --json`。

# 变更记录










## v3.2.9 —— 2026-10-16

**中文刊能力：契约门第一次能真正机检中文稿（此前只按空白分词、只认英文节名）。**

- **中文计数口径**：契约可声明 `limits.count_mode: "cjk"` ⇒ 摘要/正文字数按**汉字字数 + 英文单词**计（中文稿在旧的空白分词口径下会被数成个位数"词"，等于没检）。
- **中文节名别名**：`structure.section_aliases`（`摘要`/`关键词`/`参考文献`/`致谢`…）⇒ 摘要、关键词、致谢**以及正文与参考文献/附录的分界**都走别名（此前 `refsIdx` 只认英文 `References`，中文稿的参考文献会被算进正文、条目检查根本不跑）。
- **新检查 5 条**（全部契约驱动）：`heading_max_chars`（各级标题字数上限）· `abstract_target_chars`（"300 字左右"⇒ 目标 300 / 硬上限 target×1.1，超目标记提醒、超硬上限判失败）· `abstract_required_terms`（中文刊常要求摘要含［目的］［方法］［结果］［结论］）· `keywords_count`（逐刊不同：3–5 或 5–8）· `required_terms_present`（中文刊页脚必著录：基金项目 / 作者简介 / 通信作者）。
- **中文刊机读契约（样板）** `references/contracts/cn-henan-ut.json` —— 《河南工业大学学报（自然科学版）》，全部数字来自腾云官方门户一手取证（题名 ≤20 字 · 摘要 300 字左右且含四要素 · 关键词 5～8 · 页脚著录项 · `[1]` 上标）；**来源分两级**（该刊原文 vs §2 两刊实测口径的"各级标题 ≤15 字"按提醒看待）；未取到的收费等项**只列 human_only**，不写成要求。
- **修一个由本次改动引入的回归**：别名构造把**默认值也当字面量转义** ⇒ 关键词默认正则 `Key\s*words?` 被转义成匹配不到的东西 ⇒ 英文稿的关键词检查**静默失效**（对账项只查"跑没跑"、不查"过没过"，没拦住；由我比对上轮计数发现）。修法：默认值按**正则片段**处理、契约传来的别名才转义；并加一条**回归锁夹具**（无 `section_aliases` 的英文契约必须仍认 `**Keywords**`）。
- 门自检：**12 → 18/18**。实测：中文样例稿 **10 项全过**；英文两份契约**回到基线**（JoES 通过 13 · FAIL 1 · WARN 1；PLOS 通过 6 · FAIL 2 · WARN 1）。

## v3.2.8 —— 2026-10-16

**把外部门的两次升级接回插件（v3.2.7 → 本版之间，门升了两轮），并补上"声明与执行对账"。**

- **外部门 `_journal-contract.cjs` 升级**（论文仓，非本包文件）：
  - **`--package <投稿包目录>`**：Highlights / CRediT / AI 声明等**包级要件**改为可在目录内取证据（文件名或**标题行**），输出写明证据来源；未给 `--package` 时打印**显式警告**（包级要件可能被误报）；新增 `package_dir` 判据（目录不存在即 FAIL）。
  - **`--selftest`（12/12）**：缺输入⇒2 · 契约缺 `verified_at`⇒2 · 契约 JSON 坏⇒2 且不抛栈 · 单文件下包级要件必 FAIL · 包级模式必通过且写证据 · 摘要超限必 FAIL · **待办行不得冒充声明** · 包级目录不存在必 FAIL · 六条新检查的必失败面 · 对账必失败面 · 否定式资助记 WARN。
  - **六条契约驱动的新检查**（契约不声明则不受影响）：`title_max_chars` · `short_title` · `heading_levels_max` · `abstract_no_citations` · `figures_not_embedded` · `funding_not_in_manuscript`（区分"资助披露"=FAIL 与"无资助陈述"=WARN，避免把否定句当披露）。
  - **`checkable_ids` 对账**：契约可声明"本刊有哪些可机检项"，门会核对**每一项是否真的执行了**，未执行即 FAIL（**登记过≠可机检**，本条由 PLOS 契约"声明 12 条、实际只跑 2 项"这一真缺陷驱动）。
- **实测效果**：同一份当前投稿稿（`13-英文投稿稿-v1.md`）——**PLOS 契约覆盖面 2 → 9 项**（通过 6 · FAIL 2：缺短标题、正文内嵌 4 图；WARN 1：无资助陈述）；**JoES 契约 通过 13 · FAIL 1（CRediT）· WARN 1（图表 7 vs Ideally 8–10）**。
- 插件侧登记：`pipeline.json` 的 `journal-contract` 门补 `note`（说明 `--package`/`--selftest`/`checkable_ids`），`assets` 增 `journal_contract_gate`。

## v3.2.7 —— 2026-10-16

**新能力：引用撤稿检查 `retract-check`（素材来自 OpenAlex，只查询不复制数据）+ 修一处措辞。**

- **能力**：`node bin/studio.cjs retract-check <稿件或参考文献文件>`（或 `--dois a,b`）——从文本抽 DOI（清洗尾部标点与 `https://doi.org/` 前缀）→ 批量查 OpenAlex `works.is_retracted`（`filter=doi:A|B`，每批 40）。
- **三态 + 取不到≠通过**：`retracted`（撤稿，须显式说明撤稿状态）/ `clean` / `notFound`（OpenAlex 无记录，**不等于没问题**）/ `unreadable`（批失败）；**全批不可读 ⇒ 退出码 2**；有撤稿 ⇒ 退出码 1。
- **实测通道**：OpenAlex 三条调用（单查 / `filter=is_retracted:true` / 批量 `filter=doi:A|B`）**均 HTTP 200**；已实测样例 `10.1038/nature00870`、`10.1016/s0140-6736(20)30367-6`、`10.1016/j.antimicag.2020.105949` 为 `is_retracted=true`（写在资产里供人工核对）。
- **许可态度**：只在运行时查询，**不复制/不再分发** OpenAlex 数据；若将来要缓存结果，须先核 `docs.openalex.org` 条款。可选礼貌池走环境变量 `OPENALEX_MAILTO`（**代码与文档不留邮箱**）。
- **资产** `references/retraction-check.md`（来源 · 三态 · **已知漏检面**（刚撤稿未更新 / 非 DOI 引用 / 撤稿声明 DOI 不同）· 不替代作者自核）。
- **修**：`credit` 的措辞由"段落存在但无角色名"改为"**仅出现 CRediT 关键词**、未匹配到官方角色名（可能只是待办备注）"——原措辞会让读者以为稿件有该段。
- 新判据 5 条（含 3 必失败：撤稿必报 / 取不到必不通过 / notFound 不得冒充 clean）。自检：CLI **97 → 102**。

## v3.2.6 —— 2026-10-16

**上网找方向与素材（目标轮）：把 CRediT 官方角色做成资产 + 一条"非官方写法"判据。**

- **素材来源（一手 · 可再分发）**：`https://credit.niso.org/`（HTTP 200，2026-10-16 本机取回）——CRediT 官方 14 角色，**ANSI/NISO Z39.104-2022**（2022 批准），**CC-BY 4.0 允许再分发**；角色名逐字入包（含 `Writing – original draft` 的 **en dash**）。
- **新资产** `references/credit-roles.json`（14 角色 + 逐角色官方链接 + 标准号 + 许可 + `verified_at`/`verified_from`），登记进真源 `assets`（16 条）。
- **新能力** `node bin/studio.cjs credit <文件>`：检查稿件/声明里的 CRediT 段——官方角色匹配数、**疑似非官方写法**（编辑距离 =1，如 `Visualisation`/`Conceptualisation` ⇒ 硬判失败）、相近词（距离 =2，如 `Supervisor≈Supervision` ⇒ 仅提醒，避免误杀）。缺 CRediT 段**不判通过**。
- 接入面：CLI 子命令 + `agent_facing`（28 条）+ **插件工具面** `STUDIO_ACTIONS`（跨面判据同时要求，已一并接上）。
- 新判据 4 条（含 2 必失败）：资产形态（14 角色 / en dash / 取证信息 / 逐角色链接）· 官方写法正控 · 非官方写法必被抓 · **缺段必须判未通过**。自检：CLI **93 → 97**。
- **素材通道实测（如实记）**：`raw.githubusercontent.com` 四条全超时、`hub.docker.com` 解析到非公网 IP、`web_fetch` 不收 `application/pdf`（MIT 的角色表是 PDF）；`pandoc`/`citeproc` 本机未装；`cdn.jsdelivr.net` 可达但对 CSL 三条路径返回 **404**（通道通、路径与预期不符）。**CSL 样式库方向**（用 `citation-style-language/styles` + pandoc/citeproc 自动生成各刊参考文献制式）**记为待评估**，需先把通道/路径确认或装工具。

## v3.2.5 —— 2026-10-16

**把在投刊的契约都做成插件可复用资产（搬运已取证件，不改数字），并加一条"契约通则"判据。**

- **搬运（不新建判据）**：`_refs/journal-contract-joes.json` → `references/contracts/joes-elsevier.json`；`_refs/journal-contract-ripp.json` → `references/contracts/ripp-bmc.json`。两份都**原样搬运**（未改动任何数字与条款），新增 `ported_from` / `ported_at` / `ported_note` 交代出处；**插件侧是规范件**，论文仓那份属历史留档。三份契约（PLOS / JoES-Elsevier / RIPP-BMC）覆盖当前全部在投刊。
- **通则判据（+1）**：`references/contracts/*.json` 里**每一份**都必须严格可解析、带 `verified_at`（日期形态）与 `verified_from`（非空）、且 `limits`/`structure` 在场 ⇒ **以后新增契约自动被覆盖**，不用再逐份写夹具。
- 自检：CLI **90 → 93**（分族正控 + 未知族必失败 + 三份契约正控）。
- **契约分族（实测修正）**：搬运后通则判据立刻抓到 `ripp-bmc.json` **没有** `limits`/`structure` —— 复核确认它是**另一种合法形态**（核验族：`verified_facts` + `publisher_level_policies`/`implications_for_this_submission`），而 JoES/PLOS 属**限额结构族**（`limits` + `structure`）。判据改为**分族**：取证四项必在 + 必须属于已知族之一，**未知族显形报错、不放行**；正向锁三份契约、反向一条必失败。
- **真跑（连假阴性一起记）**：A 稿 × JoES 契约跑出 7 项 FAIL/WARN；逐项核对后确认其中 **"无 Highlights 节"是单文件扫描的假阴性** —— Highlights 在 Elsevier 是**独立文件**，本目录 `Highlights.md`/`.docx`/`.txt` 与 `submission\Highlights.docx` **都在**。⇒ **本轮未解决项**：契约门需要**包级模式**（`--package <目录>`），否则包级要件（Highlights / CRediT / AI 声明）会被误报。B 稿那次我取到的"稿件"其实是**投稿前总检查表**，属选件不当，同样记为未解决项。

## v3.2.4 —— 2026-10-16

**两件事：① 首次做「真装实测」并把它写成文档（此前只有打包干跑）；② 补上 PLOS ONE 机器可读契约 + 一条"运行时依赖是否入包"的判据。**

- **真装实测（首次 · 可复现）**：`npm pack` → `npm install --prefix <临时前缀> <tgz>`（**无需联网**）→ 在**装机目录**里跑：
  - `node bin/studio.cjs route "把这篇稿子按中文核心期刊的要求改一遍"` ⇒ 退出码 0，期刊分类路由指向包内 `references/cn-journals.md` **[存在]**；
  - `node bin/studio.cjs selftest` ⇒ **85/85**；`node plugin/selftest.mjs` ⇒ **36/36**；
  - **排除假绿**：把装机副本里那条机器专属兜底候选（`E:\DeepSeek\skills\paper-studio`）**抹掉**（1 → 0 次）后再跑插件自检 ⇒ **仍 36/36** ⇒ 证明起作用的是**「包内自带」候选**，不是本机兜底路径。
- **新增资产**：`references/contracts/plos-one.json` —— PLOS ONE 的**机器可读契约**（limits/structure/references/cover_letter/system_only_fields/**human_only**/machine_checkable + `verified_at`/`verified_from`）。每个数字都取自 `references/plos-one.md` 的官方原文；本机取不到的项（APC/豁免、开放评审、Striking image、系统字段顺序）**只列 human_only，不写成要求**。登记进真源 `assets`，并在 `plos-one.md` §10 建立互指。
- **新增判据 4 条（含 2 条必失败）**：① 契约资产必须存在、严格可解析、**带取证日期与来源**、limits 关键数字齐、`human_only` 非空；② **必失败**：契约缺 `verified_at` 必须被抓；③ **运行时引用的仓内文件必须都被 `package.json.files` 覆盖**（防"代码读了没入包的文件"）；④ **必失败**：`files` 漏顶层目录必须被抓。
- 自检：CLI **85 → 89** · 插件 **36/36** · 审计 **6/6**。

## v3.2.3 —— 2026-10-16

**两件事：①「装了插件包就拿到全部能力」整包化；② 合规门接进 `route`/`gates` 流程提醒（A 方案）。**

- **整包化（用户目标）**：仓库根新增 `package.json`（`dsh-paper-studio`），`files` 含 **`bin` + `references` + `plugin` + `SKILL.md`**，`dsh.bundle.patch` 指向 `plugin/cordis.patch.yml`，`bin` 暴露 `paper-studio` CLI 与 `paper-studio-mcp` ⇒ **一次安装＝CLI + 判据资产 + 期刊体系 + 插件半体 + MCP 服务端**，不再要求用户另有一份仓库。
  - `resolveRoot()` 新增**「包内自带」候选**（`plugin/dist/plugin.js` 往上两级＝能力树根，优先级仅次于环境变量）；只装 `plugin/` 单目录的历史形态下该候选项指向不存在位置，等同跳过（不误伤）。
  - 插件自检新增**整包自证 3 条**（含必失败面）：`files` 必须含四个能力目录、`dsh.bundle.patch` 与 `main` 指向的**文件必须真在盘上**、`resolveRoot` 必须保留包内自带候选 ⇒ **"装了就有全部能力"是可机检的，不靠文档保证**。
- **A：合规门接进流程（本用户本轮授权）**：在 playbook 仓新增**薄门** `_gate-compliance.cjs`（只 `spawn` 插件 CLI 的 `compliance`，**不复制任何判据条文**），登记进真源 `gates`（`rel=playbook_root`，`args=['--draft','{draft}']`，`required_placeholders=['{draft}']`，`used_by=['check','write']`）并挂进 `check`（投稿前体检）与 `write`（起草）两个任务类型 ⇒ **`route` 会自动把合规门列进必过门**（此前任务进来不会被提醒）。
  - 缺输入（没给 `--draft`）⇒ 退出码 2 ⇒ gate-runner 记 `precondition_fail`，**绝不静默通过**；插件 CLI 找不到 ⇒ 显形打印所有候选根。
  - 注：playbook 仓**不是 git 仓**，故该文件不入版本库；真源里登记的是它的路径与退出码约定。
- 文档：`plugin/README.md`「分发口径」由"只支持 git 安装"改写为**整包优先**（含"只装 plugin/ 目录会显形失败"的说明）。
- 自检：插件 **33 → 36** · CLI **85/85**。

## v3.2.2 —— 2026-10-16

**把合规门接进"插件工具面"，并给跨面漂移装上判据（由用户一问"哪种比较完善"追出的可达性缺口）。**

- **起因（实测证据）**：合规门原本只在 **CLI** 与**仓库级 SKILL.md** 可达；`plugin/dist/plugin.js` 里 `compliance` 出现 **0 次** ⇒ **插件的工具面（`paper_studio`，也是 Codex / Claude Code / Cursor 等宿主用的那条路）完全调不到这道门**；`route`/`gates` 输出里也没有它。**结论：不是"要不要再抽一个独立技能"的问题，而是现状本身有三处不可达。**
- **新增单一真源** `references/pipeline.json` 的 **`agent_facing`**（27 条）："哪些命令必须能从 agent 工具面调到"只在这里声明一次。
- **插件工具面**：`STUDIO_ACTIONS` 补上 `compliance` / `hygiene` / `claims` / `coverage`（原本漏接 4 个）。
- **两道跨面判据（各带必失败面）**：① `agent_facing ⊆ SUBCOMMANDS`（CLI 侧，防拼错/删命令）；② `agent_facing ⊆ STUDIO_ACTIONS`（工具面侧，防"CLI 加了命令、工具面漏接"——本轮的缺口正是这一类）。**取不到真源即判失败，不得当通过。**
- **文档**：`plugin/skill/SKILL.md`（插件包自带的技能半体）补上合规门与三个自审动作的调用式，并写明"依据＝仓库单一真源，工具面不复制判据"。
- 自检：CLI **83 → 85** · 插件 **31 → 33**。
- **未做（需你点头）**：把合规门接进 `route`/`gates` 的**真源流程**——现有 11 个门**全部住在 playbook 仓**（`rel=playbook_root`，脚本在 `D:\DeepSeek\research-paper-playbook\`），要接流程得**动那个仓库**；按你此前"论文线只在当轮明确要求时恢复"的指示，我没有自行推进。

## v3.2.1 —— 2026-10-16

**修一处由用户一问追出的真漂移：接口面与文档面。**

- **起因**：用户问「你是以 skill 放进去的吗」⇒ 核对落地身份时发现：`SUBCOMMANDS` 数组**漏登记了我 v3.1.9 与 v3.2.0 新增的全部 4 个命令**（`claims` / `compliance` / `coverage` / `hygiene`），用法行只列 13 个（实际实现 29 个）。**加了实现忘了登记**，与本插件 v3.1.9 修的"数字漂移"是同一族病：**接口面也会漂**。
- **修**：`SUBCOMMANDS` 补到 **29 条**；用法行改为**由 `SUBCOMMANDS` 生成**（结构上不再可能漂）；根 `SKILL.md` 补上漏掉的 `verify`（工件复核：重算输入哈希 ⇒ FRESH / STALE）。
- **新增判据（接口面一致性门，4 条夹具含 2 条必失败）**：① 分派里支持的命令必须都在 `SUBCOMMANDS` 登记（并抓"幽灵登记"——登记了但没实现）；② `SUBCOMMANDS` 每个命令必须在根 `SKILL.md` 出现。**必失败面**证明两条门真能变红，不是空门。
- **实现期又踩一个假阳性并就地修正**：判据按源码文本识别分派，结果把**夹具里作为字符串注入的 `ghost-cmd`** 也算成真分派 ⇒ 真门变红。修法＝只认**行首**的 `if (cmd === '…')`（真分派都在行首，注入串不在）。
- 自检 **81 → 83**；两套自检与 `claims`/`hygiene`/`coverage` 全绿。
- **纪律补一句**：改自检数后必须跑生态侧 `number-report.cjs`（它做 claimed vs actual 对拍）——本轮实证登记表又落后于 78/78。

## v3.2.0 —— 2026-10-16

**新增「合规门」：把投稿合规面做成可机检（知识来自本项目真实投稿经历 + 一手取证）**

- **知识资产 `references/compliance-checklist.md`（7 节）**：① **在先发表/预印本**——Elsevier 官方问答一手原文（页面 Last updated 2026-06-01，取证 2026-10-16）：**摘要 / 学位论文 / 电子预印本不算在先发表**，但 **Cell Press、The Lancet 与部分学会刊政策不同** ⇒ 判据是「查目标刊自己的 Guide for Authors，不用通用印象」；Wiley/Springer/IEEE/PLOS 政策**标注未取证**（不照抄别人口径）。② **第三方材料许可**（复用他人图表需许可、CC-BY 须署名、**复用自己前作的图也可能要许可**）。③ **地图类图件政治正确性**（台湾/港澳/藏南/阿克赛钦/钓鱼岛/南海九段线；判据＝**逐项实测多边形归属，不靠肉眼**）。④ **伦理与声明齐备表**（伦理/知情同意/CRediT/利益冲突/资助/数据可用性/AI 使用）。⑤ **清样(proof)阶段纪律**（只改排版、作者顺序变更需编辑批准、留回执）。⑥ 可机检要点。⑦ **取证台账**（哪条取自哪、何时取、哪条未取）。
- **新命令 `compliance <投稿包目录>`**：硬项（稿件主文件 + Cover Letter）缺即**非零退出**；软项（图件/参考文献/契约 json/5 段声明）缺即**显形**；**取不到一律按失败**（目录不存在、稿件读不到都显形，不静默通过）；`--json` 出三态明细。
- 自检 **68 → 74**（+6 条，含 **3 条必失败**：清单文档被删节必报、缺 Cover Letter 必报硬项、目录不存在必显形；另两条为三值区分与齐备正控）。
- 真源 `pipeline.json` 新增 `assets.compliance_checklist`；根 `SKILL.md` 与 `plugin/README.md` 同步。

## v3.1.9 —— 2026-10-16

**把「生态日审抓出的三类问题」做成插件自带的判据（问题驱动的迭代）**

- **起因（2026-10-16 DSH 生态日审实测）**：① 登记表写 `paper.studio 53/53`、`paper.plugin.v3 29/29`，脚本实报 **61/61 / 31/31** —— 数字漂了一版没人发现；② 插件自己的备份件写在**技能树内**（`refs.json.bak-*`、`投稿前检查表-论文B.md.bak-*`）被生态「残留文件」判据抓出；③ 同日的「门覆盖·前提」判据在 ai-workbench 侧一次清出 4 个"自带自检却没人跑"的脚本 ⇒ 同一纪律本插件也必须有。
- **新增①：机器可读计数出口** —— `node bin/studio.cjs selftest --json` 与 `node plugin/selftest.mjs --json` 输出 `{suite,pass,total,ok,version,failed}`；**下游一律引用命令，不再手抄数字**。
- **新增②：`claims` 文档数字一致性门** —— 扫描仓内 Markdown，凡写「N/N 通过」者必须与**实跑**一致；不一致即列出「文件:行 + 写的数 + 实跑的数」并非零退出。历史文档用 `<!-- claims: snapshot -->` 标快照（`CHANGELOG.md` 与 `V1-验收报告.md` 已标），标记者跳过对拍但**必须留下快照记录**（避免"用标记掩盖漂移"）。
- **新增③：`hygiene` 残留件门** —— 备份/临时件（`.bak-*` / `~` / `.tmp` / `.orig` / `.rej` / `__pycache__` / `.DS_Store`）不得留在技能树内；纪律＝**只归档不删除**，归档到技能树外。
- **新增④：`coverage` 自检覆盖门** —— `bin/*.cjs` 里含自检的脚本必须在真源 `references/pipeline.json` 的 **`selfchecks`**（12 条）登记；登记的是**取数命令**而不是冻结数字（这正是漂移的根治办法）。
- 自检 **61 → 67**（+6 条，其中 **3 条必失败**：残留件必被抓、错数字必被抓、快照标记必须真跳过）。
- 文档同步：根 `SKILL.md`（四条新命令 + 备份纪律）· `plugin/README.md`（自证三道门表 + 版本单元格）· `CHANGELOG.md`/`V1-验收报告.md`（快照标记）。

## v3.1.8 —— 2026-10-16

**期刊分类路由从「声明式」变「可执行」+ 分发口径显形化（A/B 两项）**

- **A · `route` 现在输出「期刊分类路由」块**：判定键（`cn+zh` / `intl+en` / `intl+en+plos` / `cn+en` / `intl+zh`）+ 命中词 + **该读哪份资产（含磁盘存在性）** + 真源边界条款；`--json` 模式新增 `journal_class` / `journal_matched` / `journal_assets` / `journal_boundaries`。实跑：中文刊任务 ⇒ `cn+zh · references/cn-journals.md [存在]`；PLOS ⇒ `intl+en+plos · references/plos-one.md [存在]`。
- **两条硬纪律（各有必失败夹具）**：① 判出分类却解析不出资产路径（真源取值没写显式 `references/*.md`）⇒ 抛 `JOURNAL_ASSET_UNRESOLVED`；② 资产在磁盘上不存在 ⇒ 显形打印缺失路径并让 `route` **退出码 1**（缺输入一律 FAIL）。第 ② 条同时兜住「只装插件包、仓库根 references 缺失」的分发缺口。
- **真源自洽修复**：`journal_classes.routing` 的 `cn+en` 与 `intl+zh` 原为简写（无路径）⇒ 补成显式 `references/*.md`（并加一条自检回归：**每个 routing 取值都必须含显式路径**）。
- **自检 53 → 61（+8 条，含 4 条必失败）**：中文刊/PLOS/Elsevier 三条正控 · 无期刊关键词的任务**不得输出资产（不猜）** · routing 自洽 · 真源缺表必抛 · 取值无路径必抛 · 资产缺失必显形。
- **B · 分发口径写进 `plugin/README.md` 并显形化**：明确**只支持从仓库安装**（`plugin/package.json` 的 `files` 打不出仓库根的 `../references`），给出**一条自证命令**（`route` 中文刊任务，须见 `[存在]` 与退出码 0），并说明**不把资产复制进 `plugin/`** 的理由（避免第二份真源分叉）。
- 文档同步：根 `SKILL.md`（route 用法行 + §9 路由段）· `plugin/skill/SKILL.md`（route 说明 + 真源取值约束）· `plugin/README.md`（版本单元格 + 两个新节）。

## v3.1.7 —— 2026-10-16

**收官：两刊官方口径复核（§6 两行改写）+ 刊代码陷阱判据（§9 第 6 条）+ §7 全部勾完**

- **§6 逐刊档案两行改为官方口径**：《太阳能学报》**官方站 `www.tynxb.org.cn`**（ISSN **0254-0096** · CN **11-2082/K** · 主管中国科协 · 主办中国可再生能源学会 · 出版《太阳能》杂志社有限公司 · 主编谭天伟 · 收录 EI/Scopus/北大核心/CSCD/CA/JST/CNKI/WJCI · DOI 前缀 `10.19912/j.0254-0096.…` · **页上有「采编系统升级维护公告」**）+ **官方投稿系统 `tynxbauthor.manuscriptcloud.com`（ManuscriptCloud）**；《电源技术》**官方站 `manu70.magtech.com.cn/dyjs/CN/1002-087X/`**（ISSN **1002-087X** · CN **12-1126/TM** · 邮发 6-28 · 主管中国电子科技集团有限公司 · 主办第十八研究所 · 主编刘兴江 · 中文核心/科技核心/行业协会会刊 · 提供论文模板与版权转让协议）+ **作者系统 `manu63.magtech.com.cn/Journalx_dyjs/authorLogOn.action`**。
- **§9 第 6 条判据（刊代码陷阱）**：`tynxb`（《太阳能学报》0254-0096）与 `tynz`（《太阳能》1003-0417）是**两本不同刊**；本轮按搜索结果打开 `tynz.cbpt.cnki.net` 时页内正文写的是「《**太阳能**》投稿须知」⇒ **进入任何投稿平台页后先用页内 ISSN/CN 与刊名逐字核对再采信**。
- **§11 判据升级为两例交叉印证**：`Journalx_dyjs/authorLogOn.action`（电源技术）与 `journalx_xxdlxt/authorLogOn.action`（新型电力系统）同形；另发现玛格泰克系**两套作者入口形态**：`Journalx_*`（老）与 `manuscriptcloud.com`（云）。
- **§7 全部勾完**（逐刊官方口径复核 ✅、接线与版本 ✅）⇒ 本目标的可达范围功课已完成；**未能取到的两项**（pcsee.org DNS 层 / 新型电力系统官方域超时）已在 §9 按通路类型登记。

## v3.1.6 —— 2026-10-16

**新增：费用口径与稿酬（§12）+ 腾云导航式投稿六步官方原文**

- `references/cn-journals.md` 新增 **§12**：**12.1 五条判据**（只认官方原文 · **「未见收费表述」≠「免费」** · **费用与稿酬分记** · 一稿多投与 3 个月改投时限 · OA 与费用是两栏）；**12.2 实测样本**（《河南工业大学学报（自然科学版）》腾云官方门户：「**作者著作权使用费和本刊稿酬一次付给**」「**刊登后即付稿酬，并赠送样书 2 本**」；该页未见「版面费/审稿费」表述；**腾云导航式投稿六步**＝作者注册 → 查看投稿须知 → 查看版权协议 → 填写稿件信息 → 填写作者信息 → 上传稿件和附件；配套：带 `*` 必填、定稿后不得改作者顺序、通知走注册邮箱、**电话 0371-67756156 · 工作 QQ 2060128723**、3 个月未通知可改投；以及格式硬项：书写顺序、页脚四著录项、汉语姓名译法、题名≤20 字、摘要 300 字含四要素）；**12.3 未取到/待续**（其余刊费用须逐刊取，带取证日期）。
- **§7 勾掉费用口径项**（按勾选口径：判据已立 + 官方原文入库；逐刊数值属持续项）。

## v3.1.5 —— 2026-10-16

**新增：国内投稿平台作者端入口与厂商口径（§11）—— 三家平台的 URL 判据闭环**

- `references/cn-journals.md` 新增 **§11**：**11.1 腾云**（刊门户 `WKB3/WebPublication/index.aspx?mid=<刊代码>`；页上「投稿流程/投稿须知/作者投稿系统 `index.aspx?t=1`/线上办公/协同期刊采编平台 `find.cb.cnki.net`」；当期全文在 `mall.cnki.net/eread/…`；**采编端命名空间 `EditorB3N`**）· **11.2 玛格泰克**（厂商页数字：1900+ 刊、50 万+ 篇/年、200 万+ 审稿人次/年、3 亿+ 读者人次/年；产品线与支撑平台；**★`JournalX` ＝ 玛格泰克采编/审稿品牌** ⇒ 见 `journalx_<刊代码>/…authorLogOn.action` 即玛格泰克系、**账号独立**）· **11.3 勤云**（**远程稿件处理系统 8.0**、XML 排版内嵌、多刊一账号/内部转投；实例含《电力系统自动化》）；**11.4** 三家辨识表与共同流程；**未取到项登记**（腾云登录后字段 · 玛格泰克官方域超时 · 勤云入口示例 URL）。
- **§7 勾掉平台操作细节项**（按勾选口径：已按本机可达范围取证并留痕；登录后字段明确标「未取到（需登录）」，不代注册、不登录）。

## v3.1.4 —— 2026-10-16

**新增：GF/OA 与官方入口（§10）—— 卓越行动计划一手取证 + 未取到项如实入库**

- `references/cn-journals.md` 新增 **§10**：**10.1 中国科技期刊卓越行动计划**（官方域 `www.cast.org.cn`／`sj.cast.org.cn`；页脚主办与 **京ICP备10216604号-4**；依据文件 **科协发创字〔2024〕41号**；二期实施方案 **2024—2028**；**二期入选 463 项（2024-11-28 公布）**；2026 年度高起点新刊 **≤120 项、其中中文刊 ≤15 项、不提供经费支持、入选后优先配置刊号**；优先支持对象与领域清单）＋**用法与边界**（可作目标刊筛选线索；**「入选」≠ OA ≠ 免费**）；**10.2 国家科技期刊平台**：搜索与浏览器两路均未命中权威入口 ⇒ **记「未取到」而非「不存在」**，并给复核通路；**10.3 可复用判据**（API 未命中换真实浏览器 → 认官方域与 ICP → 找文号与日期 → 取不到的照样入库并写清通路类型）。
- **§7 新增勾选口径**：[x] ＝**已按本机可达范围取证并留痕**；被外部条件卡住的须在该项内注明通路类型与复核方向（不写成「不可用」）。据此勾掉 GF/OA 项（卓越已取证；国家平台未取到）。

## v3.1.3 —— 2026-10-16

**新增：第三方站 vs 官方域的识别判据（§9）+ 3 条逐刊档案（按证据等级入库）**

- `references/cn-journals.md` 新增 **§9 识别判据**：五条优先级（先认域 → 读页内自我声明 → 看是否只卖服务 → 回官方复核通路 → **失败分型**：DNS 层 vs 连接超时，两者都不得写成「站点不可用」）。实测样本三条（`tynxb.llyj.net` 自述**非官网非代理** · `llyj.net` **一域多刊** · `ntps.epri.sgcc.com.cn` 官方域两次超时）。
- **逐刊档案 +3 行**（《新型电力系统》《太阳能学报》《电源技术》），每行标明**证据等级**：第三方口径一律标「待核」，官方域未取到的标「待换通路」。
- **实务发现（对写作阶段有后果）**：《电源技术》（第三方转载口径）把**使用 AI 辅助写作直接定为学术不端**，阈值：AI 率总体 ≤10%、局部 ≤20%（超则不予送审）、查重 <10%；与国外刊「如实声明 AI 使用」方向**相反** ⇒ 同一稿投中外刊需**分开策略**。
- 纪律重申：第三方站转载的「投稿须知」**可作线索，不得作官方依据**；本轮所有第三方数字均已标注。

## v3.1.2 —— 2026-10-16

**补：中文数据库站点（知网/万方/维普）注册与用法 —— 浏览器实地取证；并修两处自述缺陷**

- `references/cn-journals.md` 新增 **§8 中文数据库站点（注册与用法）**：三家公开页面的**机构/个人双轨**结构（机构登录与馆 `elib` / 机构检测入口 `check.` / 机构知识脉络 `fx.`）· 个人侧充值会员与子域 · **检测（查重/AIGC）与检索互相独立计费** · 机构 IP 授权优先 · 两条链路（投稿走采编平台 §3 / 查文献查重走本节）分记 · 文末列「未核实」三项。取证方式如实标注：真实浏览器只读公开页、不登录、不碰凭据。
- **修自述缺陷一**：§7 原写「版本迭代…本轮已做 v3.2.0」，与仓库实际不符 ⇒ 改为 v3.1.0 → v3.1.1（+ L-19…L-21）并注明已双远端推送核 HEAD。
- **修复核结论**：pcsee.org 原记「本机 DNS 解析失败」⇒ 2026-10-16 用**真实浏览器**复核同样 `ERR_NAME_NOT_RESOLVED`，判定为 **DNS 层失败、非抓取方式问题**（符合 403/429/TLS 与 DNS 的分诊纪律）。
- 自动化的边界：**不代作者注册数据库账号、不进注册表单**（凭据与实名由作者本人处理）。

## v3.1.1 —— 2026-10-16

**新增：PLOS 系投稿规范专章（换刊改造）+ 三条实测经验（L-19…L-21）**

- **新资产 `references/plos-one.md`**：PLOS ONE 官方两页（submission-guidelines / figures，均 HTTP 200，2026-10-16 取回）落成的专章 —— 与 **Elsevier 系的差异对照表**（Highlights/图形摘要不用、参考文献改 Vancouver、图件不进正文、资助不进正文）· 排版硬项（双倍行距 + 连续行号 + 标题层级≤3）· 稿件组织顺序（Title page 第一页 / 结尾 Acknowledgments→References→SI captions）· **图件规格**（TIFF/EPS · 789–2250 px · 300–600 dpi · LZW + 扁平 + 无 alpha · 图题在首次引用段后 · **格式要求可延到暂定接收前**）· **Vancouver 参考文献四类样例**（期刊/会议/预印本/数据集）· Cover Letter 必含项与「**不得提减免**」· 系统内另填项 · 人工边界（凭据与 ORCID 由作者本人）· 可机检要点清单。
- **经验库扩到 L-21**：**L-19** 换刊＝换整套硬约束（8 项清单）· **L-20** 同一动作两道闸（插件模式闸 vs 宿主工具审批闸；解锁成功仍可能被宿主拒，走沙箱文件通路并留痕）· **L-21** 改参考文献制式时缺字段标「待核对」不凭记忆补（Crossref TLS 不可达 / S2 429 / OpenAlex 可用）。
- 机器真源同步：`pipeline.json` 新增资产登记 `plos_one`、路由 `intl+en+plos`、`lessons_coverage` 增 L-19…L-21（如实标 null + 说明哪些部分可机检）。

## v3.1.0 —— 2026-10-16

**新增：国内中文期刊专章 + 期刊分类（地域轴 × 语言轴）——把「国内/国外、中文/外文」做成可路由的分类，而不是靠记忆**

- **新资产 `references/cn-journals.md`（v0.2）**：六套收录体系（北大核心/CSSCI/CSCD/科技核心/AMI/WJCI）· 三平台注册与**逐字投稿步骤**（知网腾云 = 注册三步 + 导航式/一步式 + 标准七步 + **著作权转让协议必传**；玛格泰克 = `journalx/authorLogOn.action?mag_Id=N` 作者端形态；勤云待补）· 国内刊标准书写顺序（12 段）与量化硬项 · **GB/T 7714—2025**（2026-07-01 起施行；前 3 人 + 等）· 国内特有材料（著作权转让协议真实条款要点/申请单/利益冲突声明）· 审稿规则（双盲/查重/时间窗/一稿多投惩罚）· **逐刊档案**（《储能科学与技术》《河南工业大学学报》《中国预防医学杂志》《推进技术》《电工技术学报》）。
- **新资产 `references/journal-taxonomy.md`**：两轴分类（`region` × `language`）四象限 + 路由表 + 边界（不替作者判等级、不采信商业中介、不碰账号凭据）。
- **机器真源**：`pipeline.json` 新增 `journal_classes`（axes/routing/reference_style_by_language/platforms/indexes_cn/checklist_rules/boundaries），并在 `assets` 注册两个新资产。
- **手工取证纪律**：商业中介站点（代发/代投/加急）一律不作依据；PDF/DOCX 类官方规范用「下载 + PyMuPDF/python-docx 抽文本」通路（fetch 工具不支持）；不可达站点如实记（本轮 `www.pcsee.org` 本机 DNS 解析失败）。
- 文档同步：根 `SKILL.md` §9 · `plugin/skill/SKILL.md` §8 · `plugin/README.md` · `references/submission-runbook.md` §6。


## v3.0.3 —— 2026-10-16

**修：开发者模式解锁从「逐字比对」改为「逐字 + 意图等价」（用户裁定；原实现比 spec 更严）**
- `references/plugin-spec-v3.md` 的文字标准是「用户说出『进入论文插件开发者模式』**或类似意思**」，但代码只认逐字原话 ⇒ 用户说「进入开发者模式」被拒，形成**无意义往返**。
- 落法：新增 `matchDeveloperIntent()`（`plugin/dist/plugin.js` 与 `plugin/bin/mcp-server.mjs` **同判**）——强形式＝逐字原话（form=exact）；弱形式＝含「开发者模式」（或 dev mode）即 form=intent；空话 empty；无关话 none。**两种形式都在回执里回显识别依据**，解锁状态额外记 `unlock_form`（便于事后审计）。
- 拒绝信息改为**可直接复制**的原话 + 说明等价说法也放行。
- **新增 2 条夹具**：① 正控「只说『进入开发者模式』也放行且 form=intent」；② 必失败「与本意图无关的话仍不解锁（form=none）」。
- 文档同步：`plugin/skill/SKILL.md` §5 · 根 `SKILL.md` §6 · `plugin/README.md`。

## v3.0.2 —— 2026-10-16

**新增：投稿执行 Runbook（首次实战：*Journal of Energy Storage* / Elsevier 新门户）**
- 增 `references/submission-runbook.md`：提交前 / 中 / 后三段 + 8 条陷阱（**两套入口**：投递在新门户、跟踪在 EM · **回读确认页才算提交** · **稿号未生成不得编造** · **附件与 SI 属"未核实"** · 门户不列附件清单 · SSRF 守卫挡取页改用真实浏览器 · PowerShell 变量大小写陷阱 · 未核实不写成已完成）。
- 经验库扩到 **L-18**：L-14「点了提交 ≠ 提交」· L-15 稿号口径 · L-16 附件 / SI 未核实 · L-17 两套入口 · L-18 人工边界（attestation 与凭据不代点 / 代填）。
- `pipeline.json.lessons_coverage` 如实登记 L-14…L-18 = `null`（**人读项，不虚构门映射**）；`assets` 登记 runbook 路径。`SKILL.md` 新增 §2.2 引用，§4 红线按 Runbook 口径精确化。

## v3.0.1 —— 2026-10-14

**插件（`plugin/`）**
- 修：`output.presentationMeta` 在无 `exit_code` 的动作（如 `modes`）下返回 `{exitCode: undefined}`，被宿主判为 **non-lossless JSON** 而**整次工具调用失败**（真机冒烟抓到的宿主级要求）。落法：只放 JSON 可表示的值，没有就不放这个键；`presentResult` 改读 `res.meta`。并**新增夹具**「`presentationMeta` / `render` / 返回值必须能无损 JSON 往返（缺键与 undefined 视为不同）」。
- 增：**确定性意图判据** `classifyIntent` + `paper_studio action=intent`，配 **13 条夹具**（该启 / 不该启 / 拿不准三类）。夹具当场抓出一个真漏判：倒序表述（「这篇稿子帮我润色一下」）被误判为不相关 ⇒ 判据从"相邻词序"改为**「动作词 × 对象」共现**；「只有动作词、没有对象」定级为**拿不准、先问**。
- 增：端到端夹具**重试一次 + 偶发显形**（`flakes` 段）—— 偶发不许隐藏，也不因此放宽判据。
- 自检：**16/16 → 20/20**。

**编排层（`bin/`）**
- 修：`studio.cjs audit` 的转发曾写成 `require(...).main ? ... : 2`，而 `audit.cjs` 漏导出 `main` ⇒ **静默返回 2、零输出**（看起来像 CLI 挂了）。已改为缺 `main` 时**显式报错**。
- 修（可移植性）：`audit.cjs` 不再硬编码私有登记表路径 —— 改为**可选依赖**（`DSH_AI_WORKBENCH_REGISTRY` 可覆盖；缺失则**显式跳过并说明**），并在输出里**显形**「跳过」而不是让人误读成通过。
- 修（可移植性）：`plugin.js` 的根目录候选把本机路径降为**最后兜底**；`studio.cjs` 两处夹具去掉本机下载路径/假盘符，改合成路径（公开仓不泄漏本机路径）。
- CLI 桥接改用**文件描述符捕获**（不用管道）：在受限执行环境里也能跑，且不受 maxBuffer 限制。
- 自检：**53/53**。

**文档与合规**
- 增：`README.md`（含两端同步说明）· `LICENSE`（MIT）· `NOTICE.md`（三分类许可口径 + 机制来源表）· `references/aris-read-report.md`（**已读 16 / 台账 730 / 实盘 1309**，三个分母分清）· `references/audit-2026-10-14.md`（出厂审查报告）· `SKILL.md` 增「质量验收（A 类门 ≠ 质量通过）」（跨模型族复核 + **双停止条件**：`score ≥ 6` 且 `verdict ∈ {ready, almost}`）。
- 增：`plugin/tools-manifest.json`（两个工具的严格 JSON Schema 清单，供下游校验）。
- `references/plugin-spec-v3.md` §8 完成判据**逐条打勾并附证据**；§10 记录真机发现。

**已知限制（如实记录）**
- 真机 `paper_studio action=modes` 在**重启 DSH 前**仍会因模块缓存报 `non-lossless JSON`（`link:` 安装的代码改动不热生效；`set_bundle` 开关与升版本重装均无效，已实测）。仅此一条路径受影响，其余真机可用。
