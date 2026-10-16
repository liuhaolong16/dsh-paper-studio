# 外部能力吸收矩阵（2026-10-17）· 下载 → 拆解 → 吸收的台账

> 扫描件落盘：`E:\DeepSeek\third_party\scan-20261017\`（7 个 git 仓库 + 5 个 npm 包解包）· 机器盘点见同目录 `_INVENTORY.md`。
> **纪律**：吸收前先看许可；不许可的**只学思想不搬代码**；每条吸收都要留来源与许可，并把"为什么"写进 CHANGELOG。

## 一、许可判定（读原文，不猜）

| 源 | License 文件 | 判定 | 处置 | 依据 |
|---|---|---|---|---|
| `academic-research-skills` | LICENSE | **CC(未细分)**（package.json: CC-BY-NC-4.0） | 仅吸思想 | CC-BY-NC ⇒ 非商用限制，不复制内容 |
| `ai4paper-dsh-ipaper-0.1.2` | （无） | **未找到 License 文件** | 仅学实现思路 | npm 包内无 License ⇒ 默认保留全部权利 |
| `auto-empirical-research-skills` | LICENSE | **CC(未细分)** | 可改编（带署名） | CC-BY ⇒ 可改编再分发，须署名；不改许可条款 |
| `awesome-ai-research-writing` | （无） | **未找到 License 文件** | 仅吸思想 | 无 License ⇒ 默认保留全部权利 |
| `dsh-lit-search-0.2.2` | （无） | **未找到 License 文件** | 仅学实现思路 | npm 包内无 License |
| `dsh-sci-fault-diag-paper` | LICENSE | **未识别**（package.json: MIT） | 可复制（带署名） | LICENSE 原文判定为准；plugin 字段标注 MIT |
| `ggboy123-dsh-paper-reader-1.5.0` | （无） | **未找到 License 文件** | 仅学实现思路 | npm 包内无 License |
| `kalaris-skills` | LICENSE | **MIT** | 可复制（带署名） | MIT ⇒ 允许复制/修改/再分发，须保留版权与许可声明 |
| `lifecycle-skills` | LICENSE | **Apache-2.0** | 可复制（带署名） | Apache-2.0 ⇒ 可复制/修改/再分发，须保留 NOTICE 与许可 |
| `paper-figure-validator-1.0.0` | （无） | **未找到 License 文件** | 仅学判据口径 | npm 包内无 License |
| `paperdebugger` | LICENSE | **AGPL-3.0** | 仅学架构 | AGPL-3.0 ⇒ 传染性，代码**不得并入**本包；只吸收设计思路 |
| `postext-citeproc-1.35.1` | （无） | **未找到 License 文件** | 不采纳 | 我们已用 citation-js + citeproc（MIT）＋ Zotero 官方 CSL，重复 |

## 二、可复制源的现成能力清单

### 2.1 lifecycle-skills（Apache-2.0）· 42 个生命周期技能

| 技能 | 我方是否已有（启发式） | 说明 |
|---|---|---|
| `add-venue-profile` | ✅ contract | Creates a new venue-profile YAML for venues/conferences/ from a conference CFP URL, validates it against venue |
| `anonymize-paper` | ✅ anonymize | Deep anonymization sweep for double-blind paper submissions, plus clean de-anonymization for camera-ready. Use |
| `assess-paper` | **缺** | One consolidated read on how good a paper is right now — top strengths, biggest risks, scores, and what to do  |
| `benchmark-paper` | **缺** | Scores a draft against the measurable patterns of recent award-winning and top-cited papers at a target venue, |
| `check-originality` | ✅ original | Checks a draft for plagiarism, self-plagiarism, text recycling, and uncited near-quotes using several detectio |
| `draft-related-work` | ✅ related | Drafts or rewrites a Related Work / prior work section positioned against actually-retrieved papers — derives  |
| `draft-survey` | **缺** | Turns a topic into a ranked reading list of the best papers plus a two-column, arXiv-ready literature-review/s |
| `fetch-paper` | ✅ fulltext | >- |
| `find-papers` | ✅ openalex/refs | Searches scholarly literature with zero API keys across DBLP, Crossref, Semantic Scholar, and arXiv. Use when  |
| `fit-page-limit` | ✅ page | >- |
| `literature-review` | ✅ review | Builds a structured literature review — survey of prior work, state of the art, related-work landscape — where |
| `make-poster` | **缺** | >- |
| `make-slides` | ✅ slides | Builds a conference talk deck (Beamer or Marp markdown) from a paper draft - problem-first narrative, one clai |
| `match-style` | ✅ style | Aligns a draft to a target writing voice — the author's own previous papers, a target venue's published style, |
| `orchestrate-paper` | ✅ preflight/stage | Goal-driven conductor for the whole idea-to-published-paper lifecycle. Takes a research idea plus experiments  |
| `paper-profile` | ✅ profile | >- |
| `parse-cfp` | **缺** | Parses a conference Call for Papers (CFP) URL into a machine-checkable requirements card - deadlines with time |
| `plan-submission` | ✅ runbook | Builds a backwards submission timeline from a conference deadline - days remaining (AoE-aware), abstract-regis |
| `polish-prose` | ✅ polish | De-AI-ifies and tightens academic prose without changing any technical claim. Use when a researcher says "this |
| `polish-tables-figures` | ✅ figure/table | Polishes LaTeX tables and figures to publication quality. Use when a researcher mentions table formatting, boo |
| `preflight-check` | ✅ preflight | Deterministic desk-reject preflight linter for LaTeX paper submissions. Use it when a researcher asks "is my p |
| `prepare-artifacts` | ✅ artifact | Prepares a reproducibility artifact (code/data) for submission and badging. Use when a researcher says "artifa |
| `prepare-camera-ready` | **缺** | Step-by-step camera-ready prep for accepted papers — the error-prone final stage before publication. Use when  |
| `refactor-research-code` | ✅ code | Clean research code for public release while preserving reported results. Uses release_audit.py to separate sa |
| `refactor-structure` | ✅ section | Diagnoses and fixes a paper's argument architecture and narrative flow, independent of any venue. Checks wheth |
| `reflect-and-improve` | ✅ lesson | >- |
| `reflect-paper` | **缺** | >- |
| `rehearse-qa` | **缺** | Simulated-audience Q&A rehearsal for conference talks, thesis defenses, job talks, and poster sessions. Use wh |
| `render-workspace-html` | ✅ html | Renders the paper-workspace (outputs + lifecycle progress) into a single self-contained HTML dashboard the aut |
| `select-venue` | ✅ journal | Builds a ranked venue shortlist for a research paper. Use when the user asks where to submit, which conference |
| `simulate-reviewers` | ✅ review | Venue-calibrated peer-review simulation. Use when a researcher says "simulate reviewers", "mock review", "revi |
| `study-exemplars` | **缺** | Studies exemplar papers from a target venue and produces an original style-and-structure brief — fetches best- |
| `tailor-to-venue` | **缺** | Diffs a paper draft against a machine-readable venue profile and produces a four-part tailoring plan - contrib |
| `test-research-code` | ✅ test | Make research code runnable and repeatable for artifact review by auditing README, dependencies, seeds, entryp |
| `triage-reviews` | ✅ review | Turns raw peer reviews into a prioritized triage matrix before any rebuttal is written. Use it when reviews co |
| `verify-citations` | ✅ refs/citation | Verifies every citation in a BibTeX .bib file against Crossref, DBLP, Semantic Scholar, and arXiv to catch hal |
| `verify-claims` | ✅ claim | Audit load-bearing paper claims against evidence in results, tables, figures, experiments, or citations. Use f |
| `verify-results` | ✅ result | Check whether reported paper metrics are consistent with outputs from the local code artifact. Use for result  |
| `work-with-overleaf` | ✅ latex | Bridges an Overleaf project to the local skills so a paper kept on Overleaf can be checked, polished, and revi |
| `write-abstract` | ✅ abstract | Writes, rewrites, and lints venue-aware paper abstracts and prepares abstract-registration packages. Enforces  |
| `write-rebuttal` | ✅ rebuttal | Drafts peer-review rebuttals and author responses in the three real venue formats - (a) strict one-page LaTeX  |
| `write-talk-script` | ✅ talk | Writes a timed, word-budgeted speaker script for an exact conference-talk slot (e.g. a 12-minute talk plus 3-m |

### 2.2 kalaris-skills（MIT）· 与我们相关的通用学术子集（37 / 共 281）

| 技能 | 说明 |
|---|---|
| `abstract-and-title` | Write and sharpen research paper titles, abstracts (structured and unstructured), keywords, highlights, signif |
| `academic-plotting` | Generates publication-quality figures for ML papers from research context. Given a paper section or descriptio |
| `acm-sigconf` | Format ACM conference papers and journal articles with the acmart LaTeX class (sigconf, sigplan, acmsmall, acm |
| `apa7` | Format papers, theses and references in APA Style 7th edition for psychology, education, social sciences, nurs |
| `ara-rigor-reviewer` | Performs ARA Seal Level 2 semantic epistemic review of an Agent-Native Research Artifact directory, reading PA |
| `arxiv-submission` | Prepare and post preprints to arXiv without processing failures or leaks, covering TeX source packaging (.bbl, |
| `bgpt-paper-search` | Search scientific papers and retrieve structured experimental data extracted from full-text studies via the BG |
| `bibtex-hygiene` | Clean, deduplicate and validate BibTeX/BibLaTeX bibliographies before submission. Use when a .bib file has dup |
| `citation-management` | Searches OpenAlex, PubMed, and Google Scholar, extracts metadata from DOIs, PMIDs, PMCIDs, arXiv IDs, and URLs |
| `citation-verification` | Verify that every reference in a manuscript really exists and matches its metadata, catching hallucinated, cor |
| `clinical-reports` | 'Generates fail-closed draft JSON templates and runs local deterministic structure and consistency checks for  |
| `hypothesis-generation` | Formulate evidence-bounded scientific questions, candidate hypotheses, rival explanations, causal or associati |
| `ieee-transactions` | Format and submit papers to IEEE journals (Transactions, Journals, Letters, IEEE Access) and IEEE conferences  |
| `latex-posters` | Creates research posters in LaTeX with beamerposter, tikzposter, or baposter, covering page sizes (A0, A1, 36x |
| `literature-review` | Runs systematic literature reviews by searching PubMed, arXiv, bioRxiv, and Semantic Scholar (plus web search  |
| `market-research-reports` | Build evidence-traceable market research reports and assumption-driven market sizing or forecast scenarios. Us |
| `matplotlib` | Low-level plotting library for full customization. Use when you need fine-grained control over every plot elem |
| `ml-paper-writing` | Write publication-ready ML/AI papers for NeurIPS, ICML, ICLR, ACL, AAAI, COLM. Use when drafting papers from r |
| `paper-corpus-rag` | Build grounded question answering and retrieval-augmented generation (RAG) over your own collection of researc |
| `paper-lookup` | Search 18 scholarly APIs for papers, preprints, citations, open-access full text, repository records, and jour |
| `paperclip` | Search and read full-text biomedical papers, FDA/PMDA/EMA regulatory documents, clinical trial registries, and |
| `paperzilla` | Chat with your agent about projects, recommendations, and canonical papers in Paperzilla. Use when users ask f |
| `peer-review` | Prepare evidence-bounded, constructive peer-review drafts and structured manuscript assessments. Use for autho |
| `pptx-posters` | Create and audit editable scientific posters in macro-free PowerPoint (.pptx) from author-approved local conte |
| `presenting-conference-talks` | Generates conference presentation slides (Beamer LaTeX PDF and editable PPTX) from a compiled paper with speak |
| `rebuttal-and-response-to-reviewers` | Plan and write responses to peer review, including journal "response to reviewers" letters for revise-and-resu |
| `reference-manager-interop` | Move and sync reference libraries between Zotero, Mendeley, EndNote, JabRef, Paperpile and writing tools (LaTe |
| `reproducibility-statement` | Prepare the reproducibility, transparency and open-science parts of a paper, including data and code availabil |
| `research-grants` | Guides writing of competitive research grant proposals for NSF, NIH, DOE, DARPA, and Taiwan NSTC. Covers agenc |
| `scientific-slides` | Build slide decks and presentations for research talks. Use this for making PowerPoint slides, conference pres |
| `stable-baselines3` | Production-ready reinforcement learning algorithms (PPO, SAC, DQN, TD3, DDPG, A2C) with scikit-learn-like API. |
| `stable-diffusion-image-generation` | Generates images with Stable Diffusion models (SD 1.5, SDXL, SD 3.0, Flux) through the HuggingFace Diffusers l |
| `statistical-analysis` | Guided statistical analysis for research data - test selection, assumption checking, effect sizes, power analy |
| `statistical-power` | Sample-size and statistical power calculations for planning studies. Use whenever someone asks "how many subje |
| `systematic-review-prisma` | Plan, run and report systematic reviews and meta-analyses to PRISMA 2020 standards. Use when writing a review  |
| `systems-paper-writing` | Provides paragraph-level structural blueprints for 10-12 page systems papers targeting OSDI, SOSP, ASPLOS, NSD |
| `venue-templates` | Prepare journal manuscripts, conference papers, research posters, and grant documents using venue-specific for |

## 三、我方现状（对照基线，脚本推导）

- CLI 子命令 48 个：`--help`, `-h`, `anchors`, `anonymize`, `audit`, `claims`, `coach`, `compliance`, `cost`, `cover`, `coverage`, `credit`, `crosscheck`, `doctor`, `docx`, `draft`, `figures`, `form`, `formats`, `gates`, `genre`, `ghost-cmd`, `handoff`, `hygiene`, `intake`, `lessons`, `method`, `model`, `polish`, `preflight`, `profile`, `refs`, `report`, `report-check`, `reports`, `response`, `retract-check`, `review`, `revise`, `route`, `scaffold`, `schemacheck`, `sections`, `selftest`, `state`, `stylecheck`, `submission-fields`, `verify`
- 门脚本 12 个：`_contract-check.cjs`, `_gate-artifact-sync.py`, `_gate-author-material.py`, `_gate-claim-anchor.cjs`, `_gate-compliance.cjs`, `_gate-confidentiality.py`, `_gate-declaration-set.py`, `_gate-review-protocol.py`, `_gate-worknote-leak.py`, `_journal-contract.cjs`, `_phrase-lint.py`, `_verify-docx.py`

## 四、优先级 backlog（按"缺口 × 可复制性"排序）

| 优先级 | 要做的事 | 来源 | 处置 |
|---|---|---|---|
| P0 | `make-slides` / `write-talk-script` / `rehearse-qa`（呈现与讲授类，我们全缺；形态层已有课堂演讲形态，正好接上） | lifecycle-skills（Apache-2.0） | 借**流程与检查清单**，实现进我们的形态层 |
| P0 | `simulate-reviewers` / `triage-reviews`（模拟审稿与意见分诊；我们只有 readthrough 与 rebuttal） | lifecycle-skills + 我方 revise | 借判据结构，补两条子命令 |
| P1 | `parse-cfp` / `select-venue` / `add-venue-profile`（会议征稿解析与选刊档案） | lifecycle-skills | 借字段清单，扩我们的契约体系 |
| P1 | `prepare-camera-ready` / `fit-page-limit`（定稿与页数适配） | lifecycle-skills | 借清单；页数类与我们的 docx 版面判据合并 |
| P1 | `check-originality` / `benchmark-paper` / `study-exemplars`（原创性/对标/范例研读） | lifecycle-skills | 借方法；原创性不得联网查重（无 key 且涉隐私）⇒ 只做自引与重复段 |
| P2 | kalaris 的通用子集（`academic-plotting` / `bibtex-hygiene` / `apa7` / `acm-sigconf` / `arxiv-submission` 等） | kalaris-skills（MIT） | 逐个比对我们的 stylecheck/figures/refs，只补缺口 |
| ➖ | `work-with-overleaf` / `refactor-research-code`（LaTeX 通路 / 科研代码重构） | lifecycle | **不做**：LaTeX 通路登记为 known_gap；科研代码重构不在论文插件职责内 |
| ⏸ | `render-workspace-html` 及一切 **UI / 面板形态** | lifecycle + paperdebugger | **暂缓 ≠ 不做**（2026-10-17 用户指出原「不做」是误记）：真实原因是早前连续崩溃后判断当时技术力不足以承担 UI 风险，**决定权保留在用户**；构想与前提条件已收集在 `references/ui-backlog.md`（含我们**已有**的 `panel/` 半体与 25/25 检查器、竞品 UI 做法、7 条启用前提） |
| ⚠️ | paperdebugger 的多智能体编排与 Overleaf 集成 | AGPL | **只写想法不搬码**：其"编辑器内多智能体 + MCP 形态"作为架构参考记入本文件，不复制任何代码 |
