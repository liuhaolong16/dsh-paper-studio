# 查重与 AI 率检测：机制、偏差、以及我们该做什么（2026-10-17 调研）

> 目的：搞清**别人怎么查**，才能知道自己该防什么。**边界先说清**：
> **本文件不是"绕过检测"的攻略** —— 用改写工具规避 AI 检测属学术不端；本文件的作用是
> **① 避免自己的写作被误判；② 做查重系统真会抓、而作者常忽略的自查**。

## 一、查重（similarity）怎么运作 —— 以 Crossref Similarity Check / iThenticate 为例

**已核实**（Crossref 官方文档，2026-10-17 取）：

| 环节 | 事实 |
|---|---|
| 引擎 | Crossref 的 Similarity Check **由 iThenticate（Turnitin）驱动** |
| 语料 | 会员把自己的**已发表全文**交给 Turnitin 索引；Turnitin 的 **CIS（Content Intake System）每天读 Crossref metadata 里的 full-text URL** 抓取全文 |
| 规模 | iThenticate 库含 **> 78,000,000 篇全文** + 通用网页内容 |
| 输出 | **Similarity Report = Similarity Score + 高亮的具体匹配片段**；由**编辑自行复核后判断**是否构成问题 |
| 关键 | **它给的是"提示"，不是"判决"** —— 官方措辞是"help editors"/"editors can then further review matches" |

**对作者的含义**（可执行）：
1. **你的稿子会和你自己的旧作比对** —— 自我重复（self-plagiarism）是最常见的"意外高分"，作者常忘。**投稿前应拿旧作自查整段复用**。
2. **方法段的样板句最容易被标**（"XGBoost regression with n_estimators=…"这类），因为它们在你多篇稿子里重复。
3. **引用格式错会被算成正文**：直接引语没加引号/没标出处，系统会当成你自己的话 ⇒ 高分 + 学术不端风险。
4. **作者无法自己跑 iThenticate**（那是出版社/机构服务）；能自做的是"与自己的旧稿比对"与"引语规范化"。

**未核实（明确标注）**：中文平台（知网/万方）的判重细则（常见第三方说法是"连续 13 字相同即计"）—— **本次没从官方源核实到**，不得当成事实引用。

## 二、AI 率检测怎么运作 —— **常见说法已过时**

**常见叙事**：检测器算 **perplexity（困惑度，文本有多"可预测"）+ burstiness（困惑度在全文的波动）**，困惑度低、波动小 ⇒ 判为 AI。

**已核实的实况**（GPTZero 官方 FAQ，2026-10-17 取）：
> 「**As of autumn 2023, GPTZero no longer uses perplexity and burstiness** for its AI detection because we migrated to a **deep-learning based architecture**.」

也就是说：**"困惑度 + 突发性"是 2023 年前的旧范式，现在的商用检测器是端到端判别模型**，阈值不公开、语料不公开 ⇒ **黑箱**。
（GPTZero 早期确曾这样解释过自己的判定：perplexity 衡量"模型会不会写出同样的词"，>85 更可能人类；burstiness 衡量困惑度的全文波动，模型写作"更稳定"。这段解释现在**只剩历史意义**。）

**最关键的一条：检测器有已被证实的系统性偏差**（Liang et al. 2023, *Patterns*；arXiv:2304.02819）：
- 用母语与非母语作者的写作样本测多个常用 GPT 检测器 ⇒ **非母语写作被系统性判成 AI 生成，母语写作判得准**；
- 论文原话意译：这些检测器**可能无意中惩罚语言表达受限的作者**，并**告诫不要在评估/教育场景单用检测器**；
- 另有检索到的资料给出量级（**非英语母语者 61.3% vs 母语 5.19% 被标记**）—— 该数字来自二手文献转引，**我未回到原始 PDF 核实**，仅作量级参考。

⇒ **对中文母语作者的直接含义：你写得越"规整、克制、词汇不花哨"，越容易被误判。这不是你的错，是工具的偏差。**

## 三、因此我们该做什么 / 不做什么

### 不做（红线）
1. **不做"降低 AI 率"的优化目标** —— 与"绕过检测"同构，属学术不端。
2. **不承诺"不会被判 AI"** —— 检测器黑箱且已证明会误判；任何承诺都是假的。

### 做（可机检、且真有用）
| 自检项 | 为什么值得做 | 我们现在有什么 |
|---|---|---|
| **自我重复（self-plagiarism）** | 查重系统会标、作者最常忽略 | ❌ **缺**（需与"自己的旧稿集合"比对，是个真缺口） |
| **引语规范化**（直接引语带引号+出处） | 未标注的引语会被算成正文 | 部分（`refs-verify` 查引用是否真实；但"引语有没有加引号"未做） |
| **每条断言是否有引用支撑** | 这是"抄袭"与"引用不当"的分界 | ✅ `claim-anchor` |
| **数字/引用/超参数/对冲词保真** | 改写不丢证据 | ✅ `losscheck`（8/8）+ `presubmit` 四关 |
| **AI 参与披露**（ICMJE/期刊政策要求） | 不写披露本身就是合规风险 | 部分（契约门里部分期刊有，未全覆盖） |
| **"被误判风险"画像** | 非母语写作的已知诱因（句长过均、连接词重复、词汇多样性低）**正是检测器误判的诱因**，`polish-metrics` 已能测 | ✅ 有指标（TTR/句长 SD/连接词），**但没做成"风险提示"** |

### 下一步可落地的两件（按价值排序）
1. **`plagself`（自我重复检测器）**：给定"新稿 + 我以前的稿件目录"，报**连续 n 字重合**（n 可配，默认 12–15）与重合位置。**这是我们目前真正缺的一块** —— 它对应查重系统一定会标的东西，而作者最不设防。
2. **`misflag-report`（误判风险画像，非 AI 率）**：把 `polish-metrics` 的读数翻译成"与已知误判诱因的重合度"，**明确标注"这不是 AI 概率，只是风险提示"**，并给**不改内容、只改表达**的建议（拆超长句、减少连接词堆叠、补具体数值 —— 这三条恰好也是好文风）。
   ⚠️ 这条与"规避检测"技术同构，**只能在"误判自查"口径下做**，且回执必须写明用途边界。

## 四、来源
- Crossref 官方文档 · Similarity Check —— https://www.crossref.org/documentation/similarity-check/ （2026-10-17 取）
- GPTZero 官方 FAQ · How do I interpret burstiness or perplexity? —— https://support.gptzero.me/articles/9585228410-how-do-i-interpret-burstiness-or-perplexity （2026-10-17 取；**含"2023 秋起不再使用"的官方声明**）
- Liang W. et al. *GPT detectors are biased against non-native English writers*, arXiv:2304.02819（Patterns 2023）—— https://arxiv.org/abs/2304.02819
- HEPI 关于 AI 检测与国际学生公平性的讨论（**本次 403 未取到正文**，只从检索摘要得知存在）—— https://www.hepi.ac.uk/2026/07/20/catching-the-wrong-students-ai-detection-international-students-and-the-fairness-crisis-in-uk-universities/
