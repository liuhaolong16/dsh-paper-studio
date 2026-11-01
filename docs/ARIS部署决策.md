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
| `/` 菜单 | **未在 web 新会话实测**（本会话是 desktop，看不到 web 菜单） | 待办 P-16 |
| `threadId` 多轮 | **未验证**（同上，且首轮未拿到 threadId） | 待办 P-16 |

## 回滚

1. 备份 `profiles/web/{package.json,cordis.patch.yml,cordis.yml,pnpm-lock.yaml}`；
2. `dsh plugin --profile web remove dsh-aris`（或还原备份）；
3. 重启 web profile；确认 desktop 的 `cordis.patch.yml` 不含 `dsh-aris`。

## 不在本文件范围

- 不讨论把 ARIS 技能「搬进」paper-studio：两套技能语料不同源，搬会漂移；只在 `paper-landscape.md` 做索引与选路。
