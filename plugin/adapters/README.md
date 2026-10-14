# 跨宿主适配（adapters）

本插件有**两半**，它们对宿主的依赖程度不同 —— 这是理解兼容性的关键：

| 半体 | 内容 | 依赖宿主？ |
|---|---|---|
| **技能 + CLI（可移植半体）** | `SKILL.md`（技能说明）· `bin/studio.cjs`（24 个子命令）· `references/`（判据真源） | **不依赖**任何宿主：只要能跑 `node`，任何 agent 都能用 |
| **工具层（三种封装）** | DSH 插件封装 · **MCP 服务器** · 纯 CLI | 见下表 |
| **客户端半体** | 无（本插件**没有面板**，这是规格硬约束） | — |

## 宿主能力矩阵（**已验证 / 未验证 分列，不混**）

| 宿主 | 接入方式 | 目标/自动推进用什么 | 状态 |
|---|---|---|---|
| **DSH** | `dsh.bundle.patch` → `cordis.patch.yml`（`paper_studio` / `paper_dev` 两个工具） | 宿主原生 `create_goal` | ✅ **已实测**（本机真机 27/27 自检 + 工具可用） |
| **Codex** | `codex mcp add paper-studio -- <node> …/bin/mcp-server.mjs` | Codex 的 goals / `AGENTS.md` 任务清单；**或用本插件自带的 `paper_progress`** | ✅ **MCP 注册已实测**（见下）；⚠️ 技能目录发现未实测 |
| **Claude Code** | `claude mcp add paper-studio -- <node> …/bin/mcp-server.mjs` | `TodoWrite` + 子代理；或用 `paper_progress` | ⚠️ **未实测**（本机没装 Claude Code）—— 命令按官方文档写，**未经验证** |
| **Cursor / Cline / 其它 MCP 宿主** | 在宿主的 MCP 配置里加一条 stdio server | 各自的待办机制；或用 `paper_progress` | ⚠️ **未实测** |
| **TRAE CN（字节 AI IDE）** | 同一台机器上已验证：写 `%APPDATA%\Trae CN\User\mcp.json` 的 `mcpServers`（标准 VS Code 系格式） | 用 `paper_progress` | ✅ **已实测**（`install-mcp.cjs --host trae-cn` 真写入 + JSON 复核 + 原有 3 条无损） |
| **TRAE（国际版）** | 同上，路径 `%APPDATA%\Trae\User\mcp.json` | 同上 | ⚠️ 本机未装（仅路径不同，格式同） |
| **任何能跑 shell 的 agent** | 直接 `node bin/studio.cjs <子命令>` | `PROGRESS.md`（纯文件，最少依赖） | ✅ **已实测**（本机 `studio.cjs selftest` 53/53，不依赖 DSH） |

> **诚实标注**：上表只有 DSH 与 Codex(MCP) 是**本机实测**过的；Claude Code / Cursor 是按官方文档写的，**没有**在这台机器上验证 —— 不要把它们当成"已验证可用"。

## 核心设计：一份判据，多宿主共用

MCP 服务器（`bin/mcp-server.mjs`）**不复制任何判据**：模式菜单、意图判据、双模式状态、白名单根、解锁原话
全部 `import { __test__ } from '../dist/plugin.js'`；24 个子命令一律转发给 `bin/studio.cjs`。
⇒ 换宿主**不会**产生"第二套说法"（这是本项目最硬的一条纪律）。

## 三个工具（MCP 通道）

| 工具 | 作用 |
|---|---|
| `paper_studio` | `action=modes` 取五模式菜单 · `action=intent` 判意图 · 其余转发 24 个子命令 |
| `paper_dev` | 双模式：`status/list/read/write/unlock/seal`（默认**用户模式封闭**，写入被拒） |
| **`paper_progress`** | **宿主中立的"目标"**：长任务在磁盘上留阶段账（`read` 先读 → 干活 → `append` 追加）。宿主没有原生目标工具时，就靠它顶住「写几步就停、要人反复催」这个毛病 |

## Codex 快速接入（**已实测**）

```bat
:: 1) 注册 MCP 服务器（官方入口；node 需在 PATH，否则写 node 的绝对路径）
codex mcp add paper-studio -- node E:\path\to\paper-studio\plugin\bin\mcp-server.mjs
:: 2) 复核（应看到 paper-studio 一行且 Status=enabled）
codex mcp list
```

本机实测结果（2026-10-15）：

```
Name          Command      Args                                          Status
paper-studio  node.exe     ...\plugin\bin\mcp-server.mjs                 enabled
```

也可用脚本一键做（含把技能拷进 `~/.codex/skills/`）：`node adapters/install-codex.cjs`
（该脚本会**先备份** `~/.codex/config.toml`，且只调用官方 `codex mcp add`，不手改配置）。

## 卸载 / 回退

```bat
codex mcp remove paper-studio          :: 撤销 Codex 注册
:: 若手改过 config.toml：用 ~/.codex/config.toml.bak-paperstudio-<时间戳> 覆盖回去
```
DSH 侧回退：`node E:\DeepSeek\tools\dsh-paper-plugin.cjs off`（行级开关，见根 README）。

---

## 一键接多宿主：`install-mcp.cjs`（**推荐**，2026-10-15 新增）

一家家写文档太慢，所以把「宿主 → 配置位置 → 写法」做成一张表，一次装到位。**内置 12 个宿主**：

```bat
node adapters/install-mcp.cjs --list                 :: 看本机检测到哪些宿主（只判断存在性，不读凭证值）
node adapters/install-mcp.cjs --host auto            :: 装进所有检测到且支持的宿主
node adapters/install-mcp.cjs --host trae-cn,cursor  :: 只装指定的
node adapters/install-mcp.cjs --host trae-cn --dry-run
node adapters/install-mcp.cjs --host trae-cn --remove
```

内置宿主：`trae-cn` · `trae` · `cursor` · `vscode`(Copilot) · `claude-desktop` · `windsurf` · `cline` · `gemini-cli` · `continue` · `zed`(用 `context_servers` 键) · `claude-code`(官方 CLI) · `codex`(官方 CLI)。

**它的安全纪律**（写进代码，不靠自觉）：
1. **写前必留备份**（`<配置>.bak-paperstudio-<时间戳>`）；
2. **只增删 `paper-studio` 这一条**，其它键原样保留；写后**自校验"原有条目一条不少"**；
3. **幂等**（重复运行报 `noop`）；`--remove` 只删自己那条；
4. 有官方 CLI 的宿主（Codex / Claude Code）**只走官方入口**，不手改其配置文件；
5. `--list` / 报错信息**只判断存在性，不打印任何凭证值**。

> **实测（2026-10-15）**：`--host trae-cn` 真写入成功 —— 合并后 `mcpServers` 为 `gitee, windows-cli, dsh-collab, paper-studio`（原有 3 条无损），JSON 可解析，复跑 `noop`。
> **且这条自检本身被证伪过**：早期实现把"原有条目数"取自**已被改动的同一个对象**，等于自己跟自己比 —— 报告永远通过。修正为**改动前快照**，并写了**能变红的夹具**（复现该 bug 时自检直接报"报告未如实反映原有条目数"）。

