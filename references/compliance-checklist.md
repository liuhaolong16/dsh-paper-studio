# 投稿合规与许可清单 · v1（2026-10-16 一手取证）

> 用法：**投稿前**逐节过一遍；能机检的走 `node bin/studio.cjs compliance <投稿包目录>`。
> 体例：每条都标**取证来源 + 取证日期**；未取证的写「未取证」，不写结论。
> 本清单纯属合规面（会打回/撤稿的那些），**不判内容质量**。

## §1 在先发表与预印本（Prior publication / Preprint）

**一手原文**（Elsevier Support《Which uses of a work does Elsevier view as a form of 'prior publication'?》，页面标注 **Last updated on June 01, 2026**，取证日期 **2026-10-16**）：

> An author should not in general publish manuscripts describing essentially the same research in more than one journal or primary publication. **Elsevier does not view the following uses of a work as prior publication: publication in the form of an abstract; publication as an academic thesis; publication as an electronic preprint.** Please note that **Cell Press, The Lancet, and some society-owned titles have different policies** on prior publication.

**可操作判据**：
1. **三条不算在先发表**（Elsevier 系通用）：**摘要** · **学位论文** · **电子预印本**。
2. **例外必须逐刊核**：Cell Press / The Lancet / 部分学会刊政策不同 ⇒ **投稿前查该刊自己的 Guide for Authors**，不要用通用印象。
3. **同一研究不得投两家**（concurrent/redundant publication）；摘要级会议投稿、学位论文入库一般不冲突，但**要以目标刊原文为准**。
4. **其他出版商未取证**（Wiley / Springer Nature / Taylor & Francis / IEEE / PLOS 的预印本政策本体**本轮未取**）⇒ 只说「未取证」，**不得照抄 Elsevier 的口径**。

## §2 第三方材料许可（图/表/长引文）

- **复用他人图或表**（哪怕改绘）⇒ 一般需**版权方书面许可**；投稿包里应能指出许可是哪一份。
- **CC-BY 材料**⇒ 可用但**必须署名**（且多数刊要求在图题里写明来源与许可）。
- **复用自己前作的图**⇒ 若版权已转让给前一家出版商，**仍可能要许可**（这点最常被忽略）。
- **长引文**（超过合理引用长度的整段）⇒ 需许可或大幅改写。
- **可机检**：投稿包里每张图都应能归入「自制 / 有许可凭证 / CC-BY 带署名」三者之一；**归不进去就是缺件**（机器只报缺，不判合法性）。

## §3 地图类图件的政治正确性（**涉及中国地图必查**）

- 凡图件含中国地图、领土、国界、行政区划，交付前逐项核对：**台湾是中国领土** · **香港/澳门为特别行政区** · **藏南（阿鲁纳恰尔）、阿克赛钦符合中国官方主张** · **钓鱼岛与南海诸岛及九段线按中国官方立场处理**。
- **判据（硬）**：出图后**逐项实测多边形归属**（例如按 Natural Earth 的 `ADM0_A3`/`SOVEREIGNT` 字段核对并显式覆盖），**不靠肉眼**；代码里写明依据。
- **国外数据源默认归属不等于中国官方画法**（Natural Earth 把台湾单列为 `ADM0_A3=TWN`、`SOVEREIGNT=Taiwan`，**必须显式并入中国**）。
- 目标场景可能与中国官方画法冲突时（如国际课程作业）⇒ **先向作者说明并请其定夺**，不得自行按国外默认处理。

## §4 伦理与声明齐备表（逐刊核对，别用一套投所有刊）

| 项 | 常见要求 | 可机检锚点（在稿件里搜） |
|---|---|---|
| 伦理批准 | 人体/动物研究须批准号与委员会名 | Ethics / 伦理 |
| 知情同意 | 涉及人类受试者/病例 | Consent |
| 作者贡献 | CRediT 分类（多数刊强制） | CRediT |
| 利益冲突 | 独立小节（无则显式声明"无"） | Conflict of Interest |
| 资助 | 基金号与资助方全称 | Funding |
| 数据可用性 | Data Availability Statement（含仓库/DOI） | Data Availability |
| AI 使用声明 | 部分刊要求（写"用于语言润色"等） | AI / 生成式 |

> ⚠️ 各刊名称与是否强制**不相同**；本表只给"找什么"，**要求以该刊原文为准**。

## §5 清样（Proof）阶段纪律

- 清样阶段**只改排版错误**（错字、公式错排、图注错位），**不重写内容**；大改需编辑同意。
- **作者顺序/单位变更**属实质变更 ⇒ 需**全体作者同意 + 编辑批准**，越早提出越好。
- 有回复时限（常见 48 小时）；用**期刊指定通道**回，别回在邮件里当没回。
- 校对后**逐条留回执**（改了哪几处、没改哪几处及理由）——这是"我核过清样"的唯一证据。

## §6 可机检要点（给机器门用；人读只作说明）

```bat
node bin/studio.cjs compliance <投稿包目录>            :: 人读清单
node bin/studio.cjs compliance <投稿包目录> --json     :: 机器读（三态：hit / missing / unreadable）
```

- **硬项缺**：稿件主文件、Cover Letter ⇒ **非零退出**。
- **软项缺**：图件、参考文献清单、该刊契约 json、声明段 ⇒ **显形但不置非零**（由人定夺）。
- **取不到**（目录不存在/读不到稿件）⇒ **必须显形为失败**，绝不静默当通过（本插件铁律）。
- **范围口径**：门**只扫给定目录、不上溯父级**；该刊契约与参考文献清单常放在投稿包的上一级（如 `_refs/`）⇒ **报"缺"不等于没有**，需人工确认位置。
- **措辞口径（两处实测假阴性 + 一处假阳性，全部已修）**：声明段标题各家写法不同 —— `Competing interest`（BMC 系）· `Conflicts of Interest`（IEEE 系）· `Data and code availability`（连写才匹配的正则会漏）· 中文刊用「利益冲突 / 数据可用性」；但**也不能用裸 `/availability/`**（正文里 "an availability limitation" 之类短语会假阳性）。**每加一条口径都要补双向夹具**（该命中的必须命中、不该命中的必须不命中）。

## §7 取证台账

| 条目 | 来源 | 取证日期 | 状态 |
|---|---|---|---|
| Elsevier 在先发表三条例外 + Cell Press/Lancet 例外 | `elsevier.support` 官方问答（页面 Last updated 2026-06-01） | 2026-10-16 | **一手已取** |
| 「预印本可随时在任何地方共享」 | Elsevier 期刊 Guide for Authors（多刊页面同一句） | 2026-10-16（搜索命中，未逐刊开页） | **半取（待逐刊确认）** |
| Wiley / Springer Nature / IEEE / PLOS 预印本政策 | — | — | **未取证** |
| 地图政治正确性判据 | 本项目用户 2026-10-09 明确要求 + 本机实测（Natural Earth 字段核对） | 2026-10-09 / 2026-10-16 | **已定口径** |
