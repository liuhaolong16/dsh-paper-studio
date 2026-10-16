# PLOS ONE 投稿规范（v1 · 2026-10-16 实测取证）

> **取证来源与日期**：`https://journals.plos.org/plosone/s/submission-guidelines` 与 `https://journals.plos.org/plosone/s/figures`，两页 **HTTP 200**（2026-10-16 本机取回）。
> **投稿系统**：Editorial Manager —— `https://www.editorialmanager.com/pone/`（预注册页 `/PreRegistration.aspx`）。
> **纪律**：本文件只写这两页官方原文能支撑的条目；凡是"本机取不到"的（如刊页以外的政策细节），一律标「未核实」，不得当成通过。

## 1. 与 Elsevier 系（如 Journal of Energy Storage）的差异对照 —— 换刊必须先看这张表

| 项 | PLOS ONE | Elsevier 系（对照） |
|---|---|---|
| Highlights | **不用** | 必需（3–5 条，字符上限） |
| 图形摘要 | 不用；另有可选的 **Striking image** | 常用 Graphical Abstract |
| 参考文献 | **Vancouver 编号制**（正文 `[n]`，按首次出现顺序） | 多为编号制但样式不同（须按刊） |
| 资助信息 | **一律不写进正文**，只在投稿系统里填 | 常写进 Declarations/Acknowledgements |
| 图件 | **不进正文**；单独文件 `Fig1.tif…`，只收 TIFF/EPS | 可嵌正文/单独上传，格式更宽 |
| 图题位置 | **首次引用段落之后** | 常集中在文末 |
| 篇幅 | **无字数/图表数限制** | 各刊常有限制 |
| 标题 | 全标题 ≤250 字符 **+ 短标题 ≤100 字符** | 通常只要一个标题 |

## 2. 文件与排版（硬要求）

- 稿件格式：**DOC / DOCX / RTF**（Word 不得加密或保护）；LaTeX 须交 PDF。
- **双倍行距**；**禁止多栏排版**；**必须含页码与连续行号**（行号不逐页重置）。
- **禁止脚注**：脚注内容须并入正文或参考文献。
- **标题层级 ≤3 级**（超出的第 4 级必须压平）。
- 英文；缩写**首次出现即定义**，且非标准缩写须出现 ≥3 次；单位用 SI。

## 3. 稿件组织（顺序是硬要求）

- **开头段（按序）**：**Title page**（标题、作者、单位，作为**第一页**）→ Abstract → Introduction
- **中段（可改名、顺序可调）**：Materials and Methods · Results · Discussion · Conclusions（可选）
- **结尾段（按序）**：Acknowledgments → **References** → **Supporting information captions**
- **其他**：图题插在**首次引用该图的段落之后**；表插在**首次引用该表的段落之后**；**图件单独上传、不进稿件文件**；SI 文件单独上传。

## 4. 各部分要点

- **标题**：全标题 ≤**250 字符**（句首大写；避免专业缩写）；**短标题 ≤100 字符**。
- **作者/单位**：姓名按「名 + 姓」写在 title page 与系统里；每位作者须有单位（含院系、城市、州/省、国家）；**每位通讯作者须给邮箱**；**通讯作者必须在投稿系统里提供 ORCID iD**。
- **作者贡献**：系统里按 **CRediT** 至少给每位作者一项贡献（会随文发表）。
- **摘要**：≤**300 词**；**不得含引用**；尽量不含缩写；须含目的/做法/主要结果与意义。
- **正文**：`Materials and Methods` 须细到可复现；**统计报告**要给软件**名称与版本**、可复现的技术细节、以及**代码仓库标识**（见代码共享政策）。
- **Acknowledgments**：只写不满足作者资格但确有贡献者；**不得写资助来源**（也不得写编辑或 PLOS 员工）。
- **References**：见下节。
- **SI**：任何文件类型，**单个 <20 MB**；条目名须含「**S**+编号」（如 `S1 Table`、`S2 Appendix`）；**说明（captions）写在稿件文件末尾**，不得单独交；SI 原样发表、**不校订**。
- **表**：标签（`Table 1`）+ 简述标题置于**表上方**，图例/脚注置于**表下方**；表须在稿件文件里（不单独交）。
- **图**：见下节。

## 5. 图件规格（PLOS figures 页原文要点）

| 项 | 要求 |
|---|---|
| 格式 | **仅 TIFF 或 EPS**（TIFF 更省事） |
| 尺寸 | 宽 **789–2250 px**（@300 dpi）；高 ≤**2625 px** |
| 分辨率 | **300–600 dpi** |
| 文件大小 | <**10 MB** |
| 图内文字 | 仅 **Arial / Times / Symbol**，**8–12 pt** |
| 命名 | `Fig1.tif`、`Fig2.eps`…，**文件名 ↔ 图题标签 ↔ 正文引用三者一致** |
| 色彩 | RGB（8 bit/通道）或灰度 |
| TIFF 附加 | **扁平无图层**（"layer 1"亦算有层）· **无 alpha 通道** · **LZW 压缩** · 不得跨页 |
| 白边 | 建议 2 pt 白边，裁掉多余白边 |
| 图题 | **写在稿件里**（不得写进图文件）：标签用 `Fig 1` + 标题 ≤**15 词**；图例可选 |
| 正文引用 | `Fig 1`、`Fig 1A`…，**按首次出现升序** |
| **豁免窗口** | 官方明确：**格式要求在"暂定编辑接收（provisional Editorial Accept）"之前一律放宽** —— 首投不必为图件规格卡住，但结构/参考/声明该改仍要改 |

## 6. 参考文献（Vancouver / ICMJE）

- 正文用方括号编号 `[19]`，**按首次出现顺序编号**；**摘要内不得引用**。
- 作者：**列前六位 + et al.**（超过六位时）。
- 期刊名用 **NCBI** 所载缩写；有 DOI 时按 `doi: 10.xxxx/yyyy` **带标签**写全，不得给短 DOI 或 URL。
- 可引用：已发表/已接收、**有 DOI 或 arXiv URL 的预印本**；**不可引用**：未发表/未接收、私人通讯、被撤稿文献（除非为交代背景且须注明撤稿状态）。
- 分类型样例（直接照抄结构）：
  - 期刊：`Hou WR, Hou YL, Wu GF, Song Y, Su XL, Sun B, et al. Title. Genet Mol Res. 2011;10: 1576-1588.`
  - 会议：`In: <会议名>; <年>. p. <页>. doi: …`
  - 预印本：`Krick T, Shub DA, Verstraete N, et al. Title. arXiv:1403.3301v1 [Preprint]. 2014 [cited 2014 March 17]. Available from: <arXiv URL>`
  - 数据集/仓库：`Roberts SB. Title; 2013 [cited 2013 Oct 5]. Database: figshare [Internet]. Available from: <URL>`
- **实操纪律（本轮实测）**：换刊改参考制式时，**先按 DOI 从权威源（可用 OpenAlex）取作者/刊/卷/期/页**，再按类型套样例；**取不到的字段标"待核对"，不得凭记忆补**（本机 `api.crossref.org` 因 TLS 检查型网关不可达、Semantic Scholar 返回 429；这两条属通道问题，不写成"该库不可用"）。

## 7. Cover Letter（单独文件，≤1 页）

**须含**：① 对科学文献的贡献；② 与已发表工作的关系；③ 文章类型（如 research article / systematic review）；④ 与 PLOS 关于本稿的既往往来；⑤ **建议的 Academic Editor**（从官方 Editorial Board 名单里选）；⑥ **回避的审稿人**。
**禁止**：**在 cover letter 里提任何费用减免请求** —— 减免在投稿系统里单独填。

## 8. 投稿时在系统里另填（不写进稿件）

- **Financial Disclosure**（资助，含基金号）· **Competing interests** · **Data Availability Statement**（数据可用性；须与稿件内容一致，能给持久标识更好）· 作者贡献（CRediT）· 相关/在先稿件声明。

## 9. 人工边界（不代做，只提示）

- **注册与登录**：预注册页只要 Given/First Name、Family/Last Name、E-mail 三项，随后系统**发验证邮件**；**账号密码与邮箱验证由作者本人操作** —— 不代填凭据、不代替同意任何条款。
- **ORCID**：通讯作者必须提供（系统内绑定；`Login using ORCID` 亦可）。
- **未核实项（须作者在登录后的刊页里核对）**：APC 金额与豁免资格、开放评审相关选择、Striking image 是否必填、以及投稿系统里的具体字段顺序。

## 10. 可机检要点（给机器门用，人读只作说明）

**机器可读契约**：`references/contracts/plos-one.json`（本文件的可机检化形态，供 `journal-contract` 门使用；每个数字都取自本文件，带 `verified_at` / `verified_from`）。

对稿件可自动判定的项：**标题层级 ≤3** · 全标题 ≤250 字符 / **短标题存在且 ≤100 字符** · 摘要 ≤300 词且**不含 `[n]` 引用** · 存在 Title page 且为第一页 · 结尾顺序为 Acknowledgments→References→SI captions · **图件不在正文内嵌** · 图题紧邻首次引用段 · 正文引用编号**按首次出现严格递增** · 参考文献条目符合 Vancouver 三类样例形态 · 正文**不含资助信息**（关键词扫描） · 存在数据可用性声明。**凡本文件未覆盖或本机取不到的项，门必须显形跳过并写明"未被检查 ≠ 通过"。**
