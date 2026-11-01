# ARIS 部署决策记录

> 2026-11-01 实读；只记录「为什么这样装/不装」与可复跑证据。

## 决策

- **装 web profile，不装 desktop。** web 是验证场；desktop 是用户日常面板，`dsh-aris` 的 `aris-codex` 是 `failOnStartupError: true`，桥起不来会拒启动（2026-10-14 desktop 误装已崩过一次，已回滚）。
- **唯一生效源**：`C:\Users\ASUS\.dsh\profiles\web\node_modules\dsh-aris\skills`（插件包，87 个技能目录）。
- 其余副本（`E:\DevTools\ARIS-dsh\skills`、`E:\DevTools\ARIS\skills` 等）标「参考副本」，不参与运行。

## 已验证

| 项 | 结果 | 证据 |
|---|---|---|
| 包安装 | `dsh-aris ^0.1.1`，web `package.json` dependencies 有它 | `profiles/web/package.json` |
| 技能数 | 87 个目录（包描述写 82） | `Get-ChildItem ...\skills -Directory` |
| 桥握手 | `initialize` + `tools/list` PASS；工具 `codex` / `codex-reply` | 2026-11-01 直接起 `mcp-servers/codex-exec/server.py` |
| 审稿人调用 | **未通过**：宿主进程无 `VOLC_ARK_KEY` → 报 Missing environment variable；补 key 后 4 分钟未返回 | `references/review-contract.md` |
| `/` 菜单 | **已实测**：web profile 63999 的 `/` 列表出现 ARIS 技能（auto-review-loop / research-pipeline / research-lit 等） | 2026-11-01 截图/快照 |
| web 会话执行 | **失败在模型鉴权**：发送即 `AUTH`（默认 DeepSeek-V4-Pro 无 `DEEPSEEK_API_KEY`）；未进入任何工具调用 | 2026-11-01 |
| 直连 codex | **threadId 可续**：禁用 Tulpa 后 `codex exec --json` 返回 `thread_id=01a1979e…`，`exec resume` 返回 `SECOND` | 2026-11-01 |
| 桥 tools/call codex | **已闭环**：bridge 打两个本地补丁（turn.completed 后 taskkill /T 进程树 + 从 User 环境补 VOLC_ARK_KEY），`codex` 返回 threadId `01a197bc…`，`codex-reply` 返回 `SECOND` | 2026-11-01 |
| 审稿 effort | `model_reasoning_effort="xhigh"` 已写入 `~/.codex/config.toml`，`codex exec` 返回 OK（备份 `config.toml.bak-effort-20261102`） | 2026-11-02 |
| web 模型鉴权 | **已解**：model 列表有 API-key 与 account 两组同名条目；选 account 侧（本次 Flash 1017）后会话可用。API-key 侧仍 401，不要选它 | 2026-11-02 |
| web → codex 闭环 | `mcp__codex__codex` 返回 threadId `01a19836-8632-7c60-8b33-0040dbb055ca` + `OK`；`codex-reply` 同 threadId 返回 `SECOND`（web 63999 实跑） | 2026-11-02 |
| `threadId` 多轮 | **未验证**（同上，且首轮未拿到 threadId） | 待办 P-16 |

## 回滚

1. 备份 `profiles/web/{package.json,cordis.patch.yml,cordis.yml,pnpm-lock.yaml}`；
2. `dsh plugin --profile web remove dsh-aris`（或还原备份）；
3. 重启 web profile；确认 desktop 的 `cordis.patch.yml` 不含 `dsh-aris`。

## 不在本文件范围

- 不讨论把 ARIS 技能「搬进」paper-studio：两套技能语料不同源，搬会漂移；只在 `paper-landscape.md` 做索引与选路。
## 副本漂移检查（2026-11-01）

- 对比 `E:\DevTools\ARIS-dsh\skills`（全量 clone）与 `C:\Users\ASUS\.dsh\profiles\web\node_modules\dsh-aris\skills`（插件包/生效源）：
  - 文件数：347 vs 347；仅 A 有 0；仅 B 有 0；内容不同 0。
  - 结论：当前两份逐字节一致；生效源仍以插件包为准，clone 只作参考。