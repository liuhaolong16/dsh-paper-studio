# 同行与开源生态扫描（2026-10-16）

> 目的：按用户要求"用 npm + GitHub + Gitee 找同行与素材，选出有用的，下载逆向改进，吸收进本插件，做到**各方面都被考虑到**"。
> 检索方式（全部实测）：`npm search` / `npm view` / **`npm pack` 解包读实现** / **装到临时目录真跑**；GitHub `search_repositories` + `search_code`（读片段）+ 目录列表；Gitee `search_open_source_repositories`；**Zotero Style Repository**（CSL 样式官方源）。
> **本机网络边界**：`raw.githubusercontent.com` 与 `api.github.com` **不可达**（解析到非公网地址）⇒ GitHub 内容一律走 **MCP 工具**；`www.zotero.org` **可达** ✓；npm registry 可达 ✓。

## 一、npm 侧（包）

| 包 | 版本 | 是什么 | 许可 | 我们能否用 | 结论 |
|---|---|---|---|---|---|
| `@citation-js/core` + `plugin-csl` + `plugin-doi` + `plugin-bibtex` | 0.9.0 | 书目元数据转换 + **CSL 格式化**（内部即 citeproc-js） | **MIT** | 装 8 包/**5 秒**、**离线**；实测 Vancouver 直接出结果 | **采纳（引擎）** |
| `citeproc` | 2.4.63 | CSL 处理器本体 | MIT | 可作底层 | 参考 |
| `citeproc-locales` | 1.0.2 | 打包的 CSL 语言包 | MIT | 中文 `zh-CN` 术语需要它 | **采纳（辅）** |
| `postext-citeproc` | 1.33.11 | **已把样式+locales+citeproc 打包**（含 APA/IEEE/Vancouver/**GB/T 7714**/OSCOLA…） | 待核 | 少一步自备样式；体积更大 | **备选**（采纳前核许可与体积） |
| `paper-figure-validator` | — | **校验论文图件（DPI/格式/尺寸）** | 待核 | 与我们图件门**直接重叠** | **优先逆向对拍** |
| `mammoth` | 1.13.0 | docx → HTML/Markdown | BSD | Node 侧解析 docx | 备选 |
| `officeparser` | — | Office 文档解析（严格类型） | 待核 | 可替 python-docx 的 Node 通路 | 备选 |
| `@modelcontextprotocol/server-pdf` | — | **PDF 文本抽取 MCP server** | 待核 | 读稿通路 | 备选 |
| `openalex-client` / `@cyanheads/openalex-mcp-server` / `openalex-research-mcp` | — | OpenAlex SDK 与 **MCP server** | 待核 | 我们已用 OpenAlex HTTP；MCP 形态可选 | 参考 |
| `arxiv-client` | — | arXiv API 客户端 | 待核 | ⚠ **本机 arXiv API 不可用** | 记录边界 |
| `crossref-ts` / `@jamesgopsill/crossref-client` | — | Crossref 客户端 | 待核 | ⚠ 本机 `api.crossref.org` 证书异常 | 记录边界 |
| `@alisio/plugin-literature-research` | — | **零 key 学术元数据研究工具** | 待核 | 与我们"零 key"路线同族 | 参考 |
| `plagiarism-detector-pro` | — | 文本相似度/引用/写作模式 | 待核 | 原创性检查的候选 | 候选 |
| `@dodona/dolos` | — | 代码相似度（**Winnowing 算法**） | 待核 | 算法可借来做**自引/重复段检测** | 借鉴算法 |
| `@reactwright/template-ieee` / `template-neurips` | — | IEEE/NeurIPS 论文模板（文档引擎） | 待核 | 我们有 journal 契约但**无会议模板** | 缺口参考 |
| **`dsh-lit-search`** | 0.2.2 | **DSH 插件**：文献检索+引用+BibTeX（Crossref+OpenAlex+Semantic Scholar） | **MIT** | **同平台同赛道** | **兼容评估** |
| **`@ai4paper/dsh-ipaper`** | 0.1.2 | **DSH 产品包**：论文规划/调研/起草/修订（含 Web UI，三包精确版本） | 待核 | 同赛道，走 Web 路线 | **兼容/差异化参考** |
| **`@ggboy123/dsh-paper-reader`** | — | **DSH 插件**：论文伴读（文献库+PDF 阅读器+页码锚定问答） | 待核 | **互补**（读稿） | 兼容评估 |
| `dsh-plugin-catalog` | 2026.1016.5649 | 第三方 **DSH 插件目录（4765 条）** | — | **我们不在其中** | 分发下一环 |

## 二、GitHub 侧（仓库，按星）

| 仓库 | 星 | 是什么 | 对我们的价值 |
|---|---|---|---|
| `PaperDebugger/paperdebugger` | **1546★** | 插件式**多智能体**编辑器内写作/评审/编辑（topics 含 **mcp / mcp-client / mcp-server / overleaf / latex / openai**） | **逆向首选**：多智能体编排 + MCP 形态 + Overleaf 通路 |
| `ShaishavMaisuria/research-paper-lifecycle-skills` | 53★ | **42 个 agent 技能**：文献综述/写作/**引用核验**/投稿/**rebuttal**/发表/演示 | **★覆盖清单**（目录名已取全，见第四节） |
| `thefooliman/multi-agent-academic-paper-workflow` | 99★ | 多智能体论文流程（topics 含 **ai-detection / humanize-ai-text**） | ⚠ **不采纳**：规避 AI 检测属**学术伦理红线**；只记"存在此类做法" |
| `Aryia-Behroziuan/References` | 74★ | 参考文献集合（非工具） | 价值低，忽略 |

## 三、Gitee 侧（中文生态）

| 仓库 | 是什么 | 价值 |
|---|---|---|
| `badhope/sciflow` | 本地优先 AI 科研助手：LangGraph 编排 / Agentic RAG / **8 种引用样式** / Electron | 中文侧同赛道对照 |
| `yanlin-cheng/skill-thesis-writer` | 中国学术规范（**GB/T 7714-2015**）论文写作+数据分析+文献管理一体化 | 中文规范落地参照 |
| `mirrors_Haixing-Hu/GBT7714-2005-BibTeX-Style` | 国标 BibTeX 样式 | 样式实现对照（另有 CSL 官方源，已下载） |
| `Tsybius2014/Quinctia_CitationListMaker` | C# 图形化**国标引用生成** | 国标著录规则实现参照 |
| `Suzumiya-haruhi16/research-paper-playbook` | **我们自己的仓库**（Gitee 可见 ✓） | 分发面已覆盖 |

## 四、能力矩阵（"所有方面"对照 —— 用 42 技能清单当尺子）

| 轴 | 我们已有（可复核） | 生态里有、我们**缺**的 | 动作 |
|---|---|---|---|
| 写作与结构 | `stylecheck`/`polish`/`phrase-lint`（本地判据） | 段落级改写建议（需模型） | 归入 **key 装载**轮 |
| 引用与文献 | `refs` 完整性/编号/著录项 · `anchors` 三级 · DOI 三态 | **CSL 格式化**（GB/T 7714—2025 / Vancouver）· `find-papers` · `fetch-paper` | **R2 做格式化**；检索/抓取列为候选 |
| 投稿与合规 | **12 道门 + 6 份期刊契约**（最强项） | `parse-cfp`（会议征稿）· `camera-ready` · `anonymize`（双盲）· `fit-page-limit` | R5 |
| 图表 | `figure_spec` + C18 六项 + 图内字体登记为 known_gap | **`paper-figure-validator` 的 DPI/格式细则** · `make-poster` · `make-slides` | **R3 对拍**；呈现类 R6 |
| 评审与返修 | `response`/`cover`/`preflight` | `simulate-reviewers` · `triage-reviews`（分诊）· `rehearse-qa` | R5 |
| 数据与复现 | `artifact-sync` · 复现声明 · 报告指纹 | `refactor-research-code` · `test-research-code` | 候选 |
| 呈现与传播 | 无 | `make-slides` · `write-talk-script` · `render-workspace-html` | R6 |
| **模型能力（可选）** | 全本地、零 key | 多模型 CLI（`academic-paper-skill` 的思路：Claude/DeepSeek/GLM/Qwen） | **R4：装载 key（API/MCP），无 key 时降级为本地判据** |

## 五、选型结论与采纳纪律

**已完成的采纳（本轮）**：从 **Zotero（CSL 官方源）** 下载并落库三个样式，附来源与许可留痕 `assets/csl/PROVENANCE.md`：

| 文件 | 许可 | 作者 | sha256(16) |
|---|---|---|---|
| `china-national-standard-gb-t-7714-2025-numeric.csl` | CC-BY-SA 3.0 | Zeping Lee | `4DF240A008123CB0` |
| `china-national-standard-gb-t-7714-2025-author-date.csl` | CC-BY-SA 3.0 | Zeping Lee | `5B8B56B8D9F18A15` |
| `vancouver.csl` | CC-BY-SA 3.0 | Michael Berkowitz | `3BCEBFE5AC07CBA3` |

**待办（下一轮起）**：`refs --format <style>`（引擎用 citation-js，样式用本地文件，**零 key、离线**）+ 三套夹具（GB/T 数字制 / 著者-年制 / Vancouver）+ **样式文件 sha256 绑定**（防止样式被无声替换）。

**采纳纪律（每条都来自事故）**：
1. **采纳前必查四件**：许可（能否随包分发）· 直接依赖数 · 是否联网/是否要 key · **是否与现有能力重复**（重复时优先"借鉴判据"而非"加依赖"）。
2. 第三方样式/资产**必须留来源与许可**，并像对拍制品一样**绑定哈希**（样式被替换会静默改变所有人的输出）。
3. **伦理红线不碰**：规避 AI 检测 / humanize / 代写 —— 即使生态里有、有人用，也不进本插件。
4. 依赖只进"**离线可用且许可清晰**"的；需要 key 的能力一律设计成**可选**，且必须有"**无 key 也能用**"的替代路径说明。

## 六、分轮计划（本目标下）

| 轮 | 内容 | 准出判据 |
|---|---|---|
| R1（本轮） | 扫描（npm/GitHub/Gitee/Zotero）+ 下载样式 + 来源许可留痕 | 本文件 + `assets/csl/*` 三份 + PROVENANCE |
| R2 | `refs --format`（citation-js + 本地样式） | 新子命令可用 · 三套夹具（含必失败面）· 样式 sha256 绑定 · 自检计数增长 |
| R3 | 图件判据对拍 `paper-figure-validator` | 逐条对照表（我们漏的项要么实现、要么登记 known_gap） |
| R4 | **key/MCP 装载** | 配置文件不落明文（env/凭据管理器）· 支持 DeepSeek/OpenAI 兼容/GLM/Qwen · **无 key 时全部本地判据仍可用**（必失败面：撤掉 key 后不得红） |
| R5 | 覆盖补齐（anonymize / parse-cfp / fit-page-limit / camera-ready / simulate-reviewers / triage-reviews） | 每项一个可跑子命令 + 夹具 |
| R6 | 呈现类（slides / poster / talk-script） | 视用户需要再定 |
