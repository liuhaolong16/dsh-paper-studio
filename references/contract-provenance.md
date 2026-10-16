# 契约的来源分级与重核纪律（contract provenance）

## 为什么要写这个

契约里的每个数字都会直接决定门的判红/判绿。**数字来源不写清，门就会用二手口径去判一手稿子**，而且看不出来。本项目 2026-10-16 起把来源**机器化**：

| 字段 | 取值 | 含义 |
|---|---|---|
| `verified_from` | 文本 | 取证来源（URL/页面名/文件） |
| `provenance_level` | `first-hand` / `archived-secondary` | 一手门户原文 / 归档二手口径（存档页、逐刊对照表、历史记录） |
| `needs_official_recheck` | `true` / 缺省 | 标 `true` ⇒ 门**每次运行都打一条 WARN**（`contract_recheck_required`），报告永远不会"看起来很干净" |

## 三条硬纪律

1. **不推定**：对照表里**标了其他来源刊**的数字，不得推定适用于本刊（例：某表"题名 ≤20 字"标注来源为《推进技术》⇒ 用于他刊时移入 `human_only` 并写明理由）。
2. **同刊多来源冲突时以最新一手为准**，并在契约里显式写出冲突（例：某刊 2026 官网"摘要 300 字左右" vs 2022 存档表"≤200 字"）。
3. **取不到不能写成要求**：拿不到官方原文时，数字进 `human_only`，契约标 `archived-secondary` + `needs_official_recheck`。

## 重核步骤（人来做；自动化遇到验证码即止）

1. 官方域优先：期刊自建域 → 主办单位机构域（`*.edu.cn` / `*.ac.cn`）→ 知网采编平台（`*.cbpt.cnki.net`）；**第三方站（`llyj.net` 等）数字一律标"第三方口径"**。
2. 若入口重定向到验证码页（本机实测 `showValidateCode.aspx` 即此类）⇒ **人工登录后重核，不使用任何绕过手段**。
3. 重核后更新：`verified_from` · `verified_at` · `provenance_level: first-hand` · 删除 `needs_official_recheck`；README 式地把改前的值记进 commit/台账。

## 已实测的两类通道结果（2026-10-16）

- **可达且有正文**：期刊官方门户（如某刊腾云门户「投稿须知」页）⇒ 可作一手。
- **可达但被验证码阻断**：`hjsf.cbpt.cnki.net` 跳转壳 129 B；`WKA/WebPublication/index.aspx` 302 → 验证码页 ⇒ **只能人工**。
- 另有两类失败要分型记：**DNS 解析失败**（域名层）与**导航/连接超时**（通道层）—— 都不得写成"站点不可用"。
