# 变更记录

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
