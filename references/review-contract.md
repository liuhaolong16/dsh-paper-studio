# 审稿契约（ARIS / Codex 审稿人）

> 实读日期 2026-11-01；本文件是**当前值 + 偏差 + 决策**，不是承诺。改配置后必须更新本文件并复跑「体检命令」。

## 1. 当前值（机器实读）

| 项 | 当前值 | 证据 |
|---|---|---|
| Codex CLI | `codex-cli 0.160.0` | `codex --version` |
| provider | `volc`（Volcengine Ark，`https://ark.cn-beijing.volces.com/api/v3`，`wire_api="responses"`） | `~/.codex/config.toml` |
| model | `glm-5-2-260617` | 同上 |
| reasoning effort | **未设置**（运行时打印 `reasoning effort: none`） | `codex exec` 启动头 |
| 凭证 | provider 要求 `VOLC_ARK_KEY`；**User 作用域有值，当前宿主进程无此变量** | `[Environment]::GetEnvironmentVariable(...,'User')` vs `$env:VOLC_ARK_KEY` |
| DEEPSEEK_API_KEY | **进程 / User / Machine 三处都未设置** | 同上；Harness Models 页是否另有配置未在本文核 |
| ARIS 桥 | `codex-exec` MCP `serverInfo 1.0.0`，`tools/list` 返回 `codex` / `codex-reply` | 2026-11-01 直接起 `server.py` 做 initialize + tools/list |

## 2. ARIS 的契约（包内 README）

ARIS 要求审稿人满足两条：**非 DeepSeek 家族** + **xhigh 档**；`~/.codex/config.toml` 就是审稿人姿态契约。当前 GLM 是非 DeepSeek 家族（这条满足），但 effort 是 `none`（不满足）。

## 3. 实测失败（不是推断）

1. **不带 key 直接跑**：`codex exec --skip-git-repo-check 'Reply exactly: OK'`
   → exit 1；`ERROR: Missing environment variable: VOLC_ARK_KEY`；同时警告 `Model metadata for glm-5-2-260617 not found`。
2. **临时注入 User 作用域 key 后再跑**：同一命令启动后 **>4 分钟无返回**，被人工终止；没有拿到 threadId。
3. **桥本身可用**：`initialize` 与 `tools/list` 都成功（见上表），说明「桥起不来」不是当前问题；问题在**审稿人执行侧**（凭证 / provider 响应 / 模型元数据）。

## 4. 结论与决策 B

**当前不能把 ARIS 审稿当主审。** 原因不是「GLM 文风不够狠」，而是：
- 宿主进程缺 `VOLC_ARK_KEY`，桥一调用就报错；
- 补 key 后 `codex exec` 仍未在 4 分钟内返回，未拿到 threadId，无法证明 `codex-reply` 多轮可续；
- effort 未设置，即使调用成功也不满足 ARIS 的 xhigh 契约。

**决策 B（默认方案 2 + 兜底）**：
- 默认：保留 `glm-5-2`，但必须显式设置 `model_reasoning_effort`（先试 `xhigh`，provider 拒绝再降到 `high`），并在每次审稿记录里标注「同族/跨族」与 effort；
- 兜底：关键稿改走 `manual-review`（人工跨模型复核），不把 ARIS 的「自动通过」当独立性证明；
- 不选方案 1（改 gpt-6-astra）：本机没有 OpenAI 账号/配额，改用会直接不可跑；
- 不选「保持现状不记录」：那等于把无审稿人当成有审稿人。

**决策 A**：ARIS 暂不上 desktop。web 验证闭环（拿到 threadId + codex-reply 续接）完成前，desktop 保持不装；`aris-codex` 是 `failOnStartupError: true`，桥起不来会拒启动。

## 5. 体检命令（改完必须复跑）

```powershell
codex --version
codex exec --skip-git-repo-check 'Reply exactly: OK'   # 期望 30s 内返回 OK；失败要贴原始报错
[bool]$env:VOLC_ARK_KEY; [bool]$env:DEEPSEEK_API_KEY
```

拿到 threadId 后，还必须用 `codex-reply`（或桥的 `codex-reply` 工具）续接一次；只拿到首轮不算闭环。
