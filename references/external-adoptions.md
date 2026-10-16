# 外部取证与采纳台账（paper-studio V1.6 · 2026-10-14）

> 纪律：**只学结构与方法，不搬他人内容**；凡借用清单/骨架，**必须署名 + 标许可 + 声明"只借结构"**。
> 判据：来源可信度（可核验的原始出处）· 许可（能不能用）· 依赖安全（不引入新依赖）· 功能必要性（补的是我真实缺的那块）。
> **星数不是质量证据**：本轮命中的仓库多为 2026 年新建、星数极高 —— 我只按**结构**判断是否值得学，不按 star。

## 一、取证清单（跑过什么、拿到什么）

| 源 | 方式 | 结果 |
|---|---|---|
| GitHub 搜索（academic paper writing agent skill, stars>20） | GitHub API | 命中 522 个；**可逆向的同类**：`Imbad0202/academic-research-skills`（academic-pipeline / sr-screener / evals / `.command-invariants.toml`）· `Yuan1z0825/nature-skills` · `K-Dense-AI/scientific-agent-skills`（177 skills）· `VoltAgent/awesome-openclaw-skills`（技能目录）。其余多为 awesome-* 清单，**不可逆向** |
| Gitee 搜索（论文 写作 AI 助手） | Gitee API | 命中 40 个；**同类**：`大学生论文写作助手`（student-thesis，主打合规与可核验、拒绝代写与降 AI 痕迹）· `scipivot`（科研全流程助手）· `xit-markdown-thesis-assistant` |
| OpenAlex（免 key，实测可用） | HTTP API | 取到：**PRISMA 2020 声明**（BMJ 2021;372:n71，引 10 万+）· Sun 2025 *Scientometrics*（LLM 与同行评审）· **Lee et al. 2025 JEEHP**（OA 全文，已下载）· 研究制品评估实践 |
| PRISMA 官方站 | HTTP | 取到 **checklist PDF**（2 页 / 7.3K 字符），**27 条全部抽出**并核对到条目号；页面明示 **CC BY 4.0** |
| 知网 CNKI | HTTP | 首页可达（HTTP 200）——**但检索/下载需登录或付费 ⇒ 本轮未取证，如实记录，不假称读过** |

**未取证（如实记录，不下结论）**：`Yuan1z0825/nature-skills`、`K-Dense-AI/scientific-agent-skills`、Gitee 的 `student-thesis`/`scipivot` 等只看了描述与目录，**没读代码** ⇒ 不评其优劣（避免用 star 数与描述词冒充判断，这是本机已有过一次教训的老毛病）。

## 二、采纳项（已落地，可复跑）

| # | 来源 | 采纳的是什么 | 落地 | 许可判定 |
|---|---|---|---|---|
| 1 | **PRISMA 2020** 清单（Page et al., BMJ 2021;372:n71） | **条目结构**：#5 纳排 · #6 来源与最后检索日期 · #7 完整检索式 · #8 筛选与独立复核 · #9/#10 提取与数据项 · #11 偏倚风险 · #12 效应量 · #13a–f 合成 · #14 报告偏倚 · #15 确定性 · #16a/b 流程计数与近似排除 · #17–#22 结果 · #23 讨论 · #24a–c 注册与协议 · #25 支持 · #26 竞争利益 · #27 可得性 | 综合骨架 **R0–R8**（`templates.json.stage_skeletons_by_genre.review`，每节标题标条目号）+ 综述门新增 4 条判据（检索日期 / 流程计数 / 偏倚风险 / 注册） | **CC BY 4.0**：允许改编与再分发，**须署名**。已在真源 `attribution` 字段写全出处、许可与"只借结构不搬正文"，并由自检断言强制 |
| 2 | `academic-research-skills` 的**目录结构** | 佐证三条：① **系统综述筛选是独立能力**（它有 `sr-screener/`）—— 印证我补的"流程计数"判据方向对；② **评测独立成目录**（`evals/` + `plugin-evals/` + `tests/`）—— 我的自检已内嵌，暂不拆；③ **命令不变式数据化**（`.command-invariants.toml`）—— 我的不变式在代码里（可跑、可断言），**本轮不改**（改了要重验，收益不足） | 仅作为①的佐证；②③记为"看过、暂不采纳" | **未取用任何代码** ⇒ 不涉及许可；将来若取代码必先核其许可 |

## 三、未采纳项与理由（写清"为什么不用"，避免下次重复调研）

- `awesome-*` 系列（offhand 命中）：**清单而非实现**，无结构可逆向。
- **拆分 `evals/` 目录**：我的 40 条自检已覆盖（含必失败夹具），拆分只增维护面。
- **不变式外置成数据文件**：会让"判据"与"执行"分家（正是我 V1.5 立的那条纪律的反面）；且需重验。
- **直接引入他人 skill/插件**：与「不造第 17 个论文技能、只做编排层」的既有治理裁决冲突。

## 四、本轮由取证抓出的两个"我方判据缺陷"（同类错，留痕）

1. **过松**：注册判据原写 `protocol (is|was|can be|available)`，被正文里的 "protocol-driven" 蒙中（实测命中词就是那个 `is`）⇒ 已收紧为"注册/协议的**明确状态**"（登记在哪 / 明确未注册 / 协议是否准备好）。
2. **过松**：流程计数的中文侧原含 `记录\s*\d+`，会把"编码记录 17 项"这类**无关计数**当成筛选流程计数 ⇒ 已收紧为必须带筛选语义（初检/检索到/去重后/全文评估/纳入 N 篇）。
   ⇒ 两条都是**跑真稿 + 核对"命中的到底是哪一段"**才发现的 —— 判据只看"命中/未命中"是不够的，**必须看命中证据**。

## lifecycle-skills（Apache-2.0）· 呈现与讲授类 —— 2026-10-17

- **来源**：`https://github.com/ShaishavMaisuria/research-paper-lifecycle-skills`（本地扫描件 `E:\DeepSeek\third_party\scan-20261017\lifecycle-skills`，258 文件）。
- **许可**：**Apache-2.0**（可复制/修改/再分发，须保留版权与许可声明）。⇒ 本仓**未复制其代码**，只吸收**规则与流程**：槽位→预算（≈1 张/内容分钟，硬上限 1.25×）· problem-first 分节配比 · claim 式标题（禁"Background/方法"这类非断言标题）· 单页 >100 词即"文档不是幻灯片" · 要点 >6 条即过载 · 图片缺失/不可渲染 · 备份页不占预算 · **绝不臆测槽位时长** · 口播稿按语速摊词（中文字/分、英文词/分）。
- **落地**：`bin/talk.cjs`（`talk budget|script|lint`，纯函数 + 10 条夹具含必失败面）· 文档见 `SKILL.md` · 真源登记 `pipeline.json`（`selfchecks` + `agent_facing`）。
- **未吸收项与其后**：`rehearse-qa` / `simulate-reviewers` / `triage-reviews` / `make-poster` / `fit-page-limit` / `prepare-camera-ready` 排在后续轮次（见 `absorption-matrix-20261017.md` backlog）。

## lifecycle-skills（Apache-2.0）· 审稿与问答类 —— 2026-10-17

- **来源**：同上（本地 `E:\DeepSeek\third_party\scan-20261017\lifecycle-skills`）。
- **许可**：**Apache-2.0** ⇒ 本仓**未复制其代码**，只吸收**规则与流程**：
  · simulate-reviewers：按会议族校准 harshness · 四维打分（新颖性/严谨性/可复现性/清晰度）· **置信加权均值** · 分歧/champion/detractor ·
    拖后腿维度 · 决策风险带（likely-reject / borderline-reject / borderline-accept / likely-accept）· **「borderline 且无 champion ⇒ 向下判」** ·
    未采纳的严谨性缺陷在 harshness≥4 时把总分压到"边缘偏拒" · 修法三类标签（fix-now / rebuttal-defensible / structural）
  · rehearse-qa：`grade_answers` 的逐答判据（计时 vs 目标/上限 · 未答 · 对冲开头 · 填充词密度 · 是否把答案埋在 yes-no 之后）·
    "连续两次站得住才算练成" · 绝不给演练题编造引文
- **落地**：`bin/reviewers.cjs`（`aggregate` / `grade`，纯函数 + **10 条夹具含 4 条必失败面**）。
- **刻意未做（与既有能力重复，改为"并进 `review`"）**：上游 `triage-reviews` 的"拆分意见 + 分类 + 矩阵"我方 `studio review` **已具备**
  （切条 / 启发式分类 / 对稿定位 / 矩阵输出）；其**严重度×成本评分与按回复预算分配**列为下一轮**并入 `review`** 的改进项，
  不另起一套并行命令（遵守"同一件事只有一个所有者"）。
- **未吸收项**：`review_form`（面板与量表模板）· `qa_drill`（槽位→提问节奏与人格配额）· `make-poster` / `fit-page-limit` / `prepare-camera-ready`，排在后续轮。

## 吸收方法（**A 路径** · 2026-10-17 用户确认「对，我就是这个意思」）

**版权保护表达、不保护思想。** 所以吸收只有一条正道：

> **A 路径**：读懂它的**方法 / 判据 / 流程** → 用**我们自己的语言与代码重写** → 用**我们自己的夹具验证** ⇒ 产出**是我们的**，可自由许可（不受 NC 污染）。

**A 路径的四步（每一步都要留痕）**：

| 步 | 动作 | 必须留下的证据 |
|---|---|---|
| 1 | **读源**：把源文件下到本地**逐字读完**（不是看标题、不是看描述） | 文件清单 + 行数（例：`scholar-search.py` 296 行） |
| 2 | **抽方法**：抽出方法/判据/流程，**并把许可读清**（以 LICENSE 原文为准，`package.json` 的 license 字段可能不准） | 许可判定 + 「取了什么（方法层）」一行 |
| 3 | **自写**：用我们自己的表达与代码实现；**不复制其文本/代码/提示词** | 我方产出文件路径（`bin/*.cjs` 等） |
| 4 | **自验**：自己的夹具（**含必失败面**）+ 接进自检链 | 自检读数（例：`oa-fetch` 9/9） |

**两条机器兜底**（把"我说没抄"变成"能证明没抄"）：
- `bin/license-scan.cjs`：我方文本 × 受限源 13 词窗口重合扫描 ⇒ **命中必须为 0**；
- `bin/license-audit.cjs` 归属面：真用了其内容的进 A 栏（须署名），只吸思想的进 B 栏（无义务）——**漏署与虚标都 FAIL**。

**禁止项**：只读标题/描述就断言"能力重合、不吸收"（须逐项对比后才能判）；把对方文本改词/换序/翻译后当自有（仍是演绎作品，NC 跟着走）；复制无许可源的代码。

### A 路径落地清单（每一行都能复跑）

| 源 | 许可 | 取的方法（方法层） | 我方产出 | 自验读数 |
|---|---|---|---|---|
| `lifecycle-skills` | Apache-2.0 | 槽位→预算（≈1 张/内容分钟，硬上限 1.25×）· problem-first 配比 · claim 式标题 · 单页 >100 词即过载 · 置信加权均值与 champion · 严重度×成本分诊 | `bin/talk.cjs` · `bin/reviewers.cjs` | talk **10/10** · reviewers **10/10** |
| `kalaris-skills` | MIT | 技能按「何时用」切分、可被按需单独加载 | `skills/*/SKILL.md`（7 模块） | `sync-skill-modules` **8/8** |
| `dsh-sci-fault-diag-paper` | 木兰宽松 v2 | 插件打包体例 · 教训分级 · **图法**（面板字母/共享色条/箭头轴/比例尺/时间窗括号） | `plugin/*` · `bin/figures-kit.cjs` · `references/figure-style-rubric.md` | figures-kit **9/9** |
| SkillHub `academic-research` | **包内未声明许可 ⇒ 只学方法、不搬代码** | Unpaywall 兜底 OA-PDF 直链 · 24h 磁盘缓存 · 触发短语密集的 description | `bin/oa-fetch.cjs` · `skill_modules[*].triggers` | oa-fetch **9/9** |
| **ARIS**（本地逆向） | MIT | 验收门认识论 · 保证级别轴 · 复核独立性 · 注入卫生 · 输出版本化 | `references/aris-read-report.md`（16 条逐条映射） | studio **251/251** |
| **PRISMA 2020**（Page et al., BMJ 2021;372:n71） | CC BY 4.0 | 27 条目结构 ⇒ 综述骨架 R0–R8 + 4 条门判据 | `templates.json` · 综述门 | 契约门 **69/69** |
| `research-paper-playbook`（同源本机资产） | 自有 | 11 维判据 · 机器门 · 投稿前检查表 | `pipeline.json` · `templates.json` | studio **251/251** |
| `paperdebugger` | **AGPL-3.0** | 仅架构观察（多智能体 + 编辑器内集成）——**无产出**，只入吸收矩阵 | —（记录） | license-scan 命中 0 |
| `academic-research-skills` | **CC-BY-NC** | 仅 agent 角色分解的**分类方式**参照——**无产出** | —（记录） | license-scan 命中 0 |

> 判据：凡上表有产出的行，必须能**复跑出读数**；无产出的行（AGPL / NC）只允许出现在吸收矩阵里，**不得出现在包里**。
