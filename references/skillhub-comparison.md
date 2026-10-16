# SkillHub 对比台账（`skillhub.cstcloud.cn` · 2026-10-17）

> **缘起（用户批评，认下）**：我上一轮把 SkillHub 的 `academic-research` 判为「能力重合 ⇒ 不采纳」，**却没读过它的源文件**。
> 正确判据是：**读了源文件、逐项对比，只有"对比后我方确实更好"才不吸收；有相同能力不是不学习、不吸收的理由。**
> 本文档即补做这件事：**已把 zip 下到本地解开逐字读完**（`E:\DeepSeek\third_party\skillhub\academic-research\`：`SKILL.md` 2.7 KB + `scholar-search.py` 296 行 + `literature-review.py` 304 行 + `_meta.json`）。

## 一、市场概况（纠正我上次的轻率描述）

| 事实 | 读数 |
|---|---|
| 技能总数 | **5746**（639 页） |
| 论文相关（关键词 `paper`） | **44 个 / 5 页** |
| 分类 | Research & Science · Office Tools · Design & UI · Documentation · Development · Data AI · Business · Lifecycle · Lifestyle · Test & Security · Tool · Content & Media · Blockchain · DevOps · Databases · Persona |
| 排序/入口 | 最近更新 · 浏览最多 · 下载最多；浏览 / 排行榜 / 提交 |
| 分发方式 | ① 下载 SKILL（**zip**，`/download/<id>`）② 「把提示词发给 AI 助手」安装 ③ 元信息含 `owner` / `slug` / `version` / **上游 commit URL** |
| 我方登记 | 分发渠道已登记（`references/external-adoptions.md`） |

**论文相关技能（第一页实测）**：`academic-research` · `academic-research-hub` · `arxiv-osiris` · `arxiv-skill-extractor` · `empirical-paper-analysis-skill` · `hugging-face-paper-publisher` · `kagi-summarizer`(需 key) · **`paper-fetcher`（Sci-Hub）**。

## 二、逐项对比（`academic-research` v1.0.0 · 上游 ClawHub / 作者 Topanga）

| # | 他们的做法 | 我方现状（实测证据） | 判定 |
|---|---|---|---|
| 1 | `abstract_inverted_index` 还原摘要（`scholar-search.py:48-56`） | **已具备** `bin/studio.cjs:4853-4861` | ✅ 我方已有（非缺口） |
| 2 | `mailto` 礼貌池，但**硬编码他人邮箱** `topanga@ludwitt.com`（`:15`、`literature-review.py:21`） | **已具备且更正确**：`OPENALEX_MAILTO` **环境变量**注入（`studio.cjs:6665`） | ✅ **我方更好**（不冒用他人身份、不入代码） |
| 3 | DOI → OpenAlex work、`best_oa_location`、批量 DOI 过滤 | 有（`studio.cjs:4221` / `:6669`），且**多一项 `is_retracted` 撤稿状态** | ✅ 我方更好（他们没有撤稿检查） |
| 4 | **Unpaywall** 换 OA PDF 直链（`deep_read`，`:162-173`） | **没有**（grep `unpaywall` = 0） | ⚠️ **真缺口 ⇒ 本轮吸收** |
| 5 | **24h 磁盘缓存**（md5(url+params) 键，`literature-review.py:29-36`） | **没有**；我方同一次运行里会重复打同一 API | ⚠️ **真缺口 ⇒ 本轮吸收**（落 `run/.cache/`，非 `/tmp`） |
| 6 | **触发短语密集的 `description`**（`Triggers on: academic search, paper lookup, citation analysis…`） | 我方模块 frontmatter 只有"何时用/不用于"，**无 triggers** | ⚠️ **吸收**（提升被发现率） |
| 7 | 多查询变体（原名 + 引号精确 + 长问句切半）→ 按 DOI/ID 去重 → 主题聚类 → 综述草稿（`literature-review.py`） | 无（我方以"已有稿件"为中心：`refs`/`anchors`/`claims`/`coverage`） | ⏸ **P2 待办**（定位不同：这是检索技能的活；记入吸收矩阵） |
| 8 | `--years` / `--oa` / `--sort citations` 过滤 | 有同类（契约门按年/库过滤）；**无面向用户的"按主题找文"命令** | ⏸ P2（同 7） |
| 9 | 输出含 emoji（🔓/🔒/📥）与 `print` 直出 | 我方：**机器可读判定码 + 人类读数并存**（铁律 28） | ✅ 我方更好（emoji 不利于机读与转录） |
| 10 | 失败即返回 `None`/空列表，调用方打印空 —— **"取不到"与"没有"不分** | 我方：**SKIP / FAIL / PASS 三态分明**，缺输入记 SKIP（铁律 19/37） | ✅ 我方更好 |
| 11 | **无夹具、无自检**；`/tmp` 硬编码（Windows 不可用）；`--json` 两处解析（`parse_known_args()[0].json`） | 我方：每个工具带夹具与必失败臂；路径全部可移植 | ✅ 我方更好 |
| 12 | SKILL.md **无许可、无来源声明、无"不用于"边界** | 我方：`NOTICE.md` A/B 归属分栏 + 模块含"不用于" + 机检 | ✅ 我方更好 |

## 三、本轮吸收的三项（都已落代码/真源）

1. **Unpaywall OA-PDF 兜底**：`bin/oa-fetch.cjs` 的 `unpaywall(doi)`；**邮箱必须由环境变量提供**（`PAPER_STUDIO_CONTACT_EMAIL` / `OPENALEX_MAILTO`），**未提供 ⇒ SKIP 并写明原因**（绝不冒用他人邮箱、绝不硬编码）。
2. **24h 磁盘缓存**：`oaGet()` 以 `md5(url+params)` 为键、TTL 24h、落 `run/.cache/oa/`，支持 `--no-cache` 绕过；命中/未命中都进回执（**缓存命中不能伪装成"刚取到"**）。
3. **模块 triggers**：真源 `skill_modules[*].triggers`，由生成器写入 `skills/<id>/SKILL.md` 的 frontmatter（形如 `Triggers on: …`），与"何时用/不用于"并列。

## 四、红线（**不吸收**，记录理由）

- ⛔ **`paper-fetcher` = Sci-Hub 按 DOI 抓 PDF**（技能描述自述 "Fetch academic papers from Sci-Hub"）：属**绕过付费墙的盗版通道**。
  **不安装、不学习其取件方式、不写入任何文档步骤**；需要全文时只走合法路径（OA 直链 / Unpaywall / 出版社开放页 / 图书馆权限）。
- ⚠️ **不得复制其源码**：`academic-research` 的 `_meta.json` 指向 `github.com/openclaw/skills`，**许可未在包内声明** ⇒ 按"无许可"处理，**只学方法、不搬代码**（我方实现全部自写）。
