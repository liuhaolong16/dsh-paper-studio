# 期刊分类与路由（Journal Taxonomy）· v1（2026-10-16）

> 作用：**把期刊分成可路由的类**，让"该查哪份资产、该走哪条清单"变成确定动作，而不是靠记忆。
> 判据真源：`references/pipeline.json` 的 `journal_classes`（本文件是**人类可读的说明**，机器判据只有一份）。

## 两轴分类（正交，必须分别记录）

| 轴 | 取值 | 为什么必须分开 |
|---|---|---|
| **地域轴** | `cn`（国内）· `intl`（国外） | 决定**投稿入口形态**（采编系统 vs EM）、**特有材料**（盖章三件套 vs 系统 attestation）、**费用口径**（刊约 vs 公开 APC） |
| **语言轴** | `zh`（中文）· `en`（英文）· `bilingual`（中英双语刊） | 决定**体例**（中图分类号/中英摘要对等 vs Title page/Vancouver）与**参考文献标准**（GB/T 7714—2025 vs Vancouver/APA） |

> ★ 两轴**不可互相代替**：国内也有英文刊（如部分 CSCD 英文版），国外也有中文刊（如境外中文期刊）。
> ⇒ 插件里一律记 **`region` + `language` 两个字段**，不允许只写"中文刊/外文刊"。

## 四象限与路由表

| 象限 | 例 | 走哪份资产 | 投稿件清单要点 |
|---|---|---|---|
| `cn` + `zh` | 《储能科学与技术》《电工技术学报》《推进技术》 | **`references/cn-journals.md`** + 该刊 `journal-contract-*.json` | 中图分类号 · 文献标志码 · 中英摘要**信息对等** · **著作权转让协议必传** · 三线表 · 单独原图 · **GB/T 7714—2025（前 3 作者 + 等）** |
| `intl` + `en` | JoES（Elsevier）· PLOS ONE · RIPP（BMC） | **`references/submission-runbook.md`** + 该刊契约 | Title page · 系统内 attestation · Funding/Competing 填系统 · 图件硬规格 · Vancouver / 刊自定 |
| `cn` + `en` | 国内英文刊（如部分 CSCD/卓越计划英文刊） | cn-journals（**平台与材料**） + submission-runbook（**正文体例**） | 入口与盖章材料按国内；正文与参考文献按刊约（多数随国际惯例） |
| `intl` + `zh` | 境外中文期刊 | submission-runbook（**入口/流程**） + 该刊体例 | 少见；以刊约为准，不套国内"三件套" |

## 附加分类（写在契约里，不进两轴）

| 维度 | 取值 | 用途 |
|---|---|---|
| 收录体系 | `北大核心` / `CSSCI` / `CSCD` / `科技核心(CSTPCD)` / `AMI` / `WJCI`（可多选） | 汇报与结项口径核对（六套互不覆盖，见 cn-journals §1） |
| 出版模式 | `subscription` / `hybrid` / `OA` | 费用与版权口径 |
| 投稿平台 | `cnki-tengyun` · `magtech` · `qinyun` · `editorial-manager` · `scholarone` · `publisher-portal` · `self-hosted` | 决定"作者端操作步骤"查哪一节 |
| 体裁适配 | `research` / `review` / `method` / `secondary` | 与 `pipeline.json.genres` 对齐（门是否适用） |
| 盲审 | `double-blind` / `single-blind` / `open` | 是否要**盲审版**（去作者信息） |
| 查重阈值 | 例 `0.15`（万方 >15% 退稿） | 投稿前自查 |

## 路由判据（模型该怎么做）

```
1) 先问/先查：region（cn|intl）+ language（zh|en|bilingual）—— 二者缺一，不许开写。
2) cn+zh → 读 cn-journals.md 对应小节 + 该刊契约；清单里必须有「盖章/签署类材料」一栏（三态，不许留白）。
3) intl+en → 读 submission-runbook.md + 该刊契约；清单里必须有「系统内声明（attestation）」一栏。
4) 参考文献标准按 language 选：zh ⇒ GB/T 7714—2025（前 3 + 等）；en ⇒ 刊约（多为 Vancouver，前 6 + et al.）。
   ⇒ 同一篇稿子若中英双投，参考文献必须**分别生成两版**，不许直译。
5) 收录体系只做**核对提示**，不替作者判定是否达线。
```

## 边界与不做什么

- **不替作者判定期刊等级是否达标**（六套名录口径不同，且各单位自定）；
- **不采信商业中介**（代发/代投/加急）的说法，费用只认刊约与编辑部公告；
- **不做"降 AI 率/规避检测"**（与本插件红线一致）；
- **不碰账号与凭据**；投稿系统的注册/登录由作者本人完成，插件只提供步骤与判据。
