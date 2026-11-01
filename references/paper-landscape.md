# 论文能力地图（三套体系）

> 2026-11-01 实读。**唯一入口先看本表**；表中的「状态」是可失败结论，不是标签。

## 一表看全

| id | 体系 | 资产 | 入口 | 安装位置 / profile | 状态 | 适用场景 | 与自建体系的对应 |
|---|---|---|---|---|---|---|---|
| `paper.studio` | 自建 paper-studio（编排层） | 35 条 agent_facing 命令 · 13 道门 · 16 条期刊模板 · longform 11 角色 | `node bin/studio.cjs <cmd>`；技能入口 `SKILL.md` | `E:\DeepSeek\skills\paper-studio`；desktop profile（`dsh-paper-studio-v3` link） | **可用**（studio 254/254 · verify 16/16） | 投稿前体检、套刊、长文流水线、引用/数字/声明门 | 本体 |
| `paper.playbook` | 外部 research-paper-playbook | 138 条检查表 · 14 道门 | `SKILL.md` | `D:\DeepSeek\research-paper-playbook`；desktop | **可用**（14/14） | 方法论、检查表、门定义 | studio 的 `gates/` 与 playbook 同源 |
| `paper.aris` | 外部 ARIS `dsh-aris` | 87 个技能目录（包描述写 82） | web 会话 `/` 菜单；桥 `mcp__codex__codex` | `C:\Users\ASUS\.dsh\profiles\web\node_modules\dsh-aris`；**仅 web profile** | **可用（需补丁与凭证）**：web `/` 菜单可见；桥 `codex`/`codex-reply` 已拿 threadId 并续接（本地 taskkill 补丁）；web 模型 AUTH 与宿主 `VOLC_ARK_KEY` 仍是环境前置 | idea→实验→写作→评审→rebuttal→重投全流程；跨模型审稿 | 与 studio 的 review/longform 重叠；ARIS 强在全流程技能，studio 强在机器门与套版 |
| `paper.supervisor` | 外部 Supervisor-Skills（HKUSTDial） | 12 个技能 | 未装 profile，仅参考副本 | `E:\DevTools\Supervisor-Skills`（非 git 仓库） | **未安装**（参考副本） | paper-writer / paper-polish / pre-submission-reviewer / rebuttal-guidance 等方法论 | 与 studio 的写作/润色/审稿角色互补；不直接调用 |
| `paper.landscape` | 本文件 | 1 张表 | 本文件 | paper-studio `references/` | 已建（2026-11-01） | 回答「论文插件有什么」 | 索引层 |

## 怎么选（入口判据）

1. **要交一篇指定期刊的稿** → `paper.studio`：`--preflight` → `--build/--apply` → `--check`；需要长文走 `longform --deliver --journal`。
2. **要从 idea 一路做到 rebuttal** → `paper.aris`（web profile）；先确认审稿人可用（`references/review-contract.md` 的体检命令），不可用就只当技能库用，不跑 auto-review-loop。
3. **要某一篇英文写作/评审方法论** → 读 `paper.supervisor` 的 `SKILL.md` 参考，不装 profile、不进主链路。
4. **问「有什么能力」** → 本表；不要凭记忆报数。

## 真实数量口径

- paper-studio：`studio.cjs` 的 `SUBCOMMANDS` 35 条；门 13 道；模板 16 条（10 官方 Word / 1 派生 / 2 参数 / 3 LaTeX / 1 指南）。
- ai-workbench registry：107 条能力，其中论文类（`paper.*` + `env.paper-*`）68 条。
- ARIS：`skills/` 下 87 个目录（包描述写 82，差 5 个；以目录实数为准，不合并两个口径）。
- Supervisor：`skills/` 下 12 个目录。

## 已知缺口（对照 SCI 二至三区目标）

| 缺口 | 现状 | 处置 |
|---|---|---|
| 中文文献检索 | **已补**：`bin/zh-lit.cjs`（OpenAlex language:zh 题录；不是 CNKI 全文） | P-12 关闭 |
| 分区/选刊 | **已补**：`bin/venue-select.cjs`（LetPub 公开页取中科院分区 + IF + 候选理由） | P-13 关闭 |
| 双语初稿 | **已补**：`bin/bilingual.cjs`（术语锁定 + 图表/引用/数字一致性，selftest 4/4） | P-14 已关闭 |
| 降重闭环 | **已补**：`bin/dup-loop.cjs`（改前/改后重测 + 数字/图表/引用丢失检查，selftest 4/4） | P-15 已关闭 |
| ARIS 审稿人 | codex provider 需 `VOLC_ARK_KEY`；宿主进程无此变量；有 key 时 4 分钟未返回 | P0，见 review-contract |

## 维护纪律

- 新增/变更一套体系，**必须同时改本表 + registry + 对应体检探针**；只改一处视为未完成。
- 本表里的「可用」必须有可复跑命令与日期；没有就写「未验证」，不得写「应该可以」。
