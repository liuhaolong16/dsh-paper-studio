# 面板化「论文插件外置 key 连接器」· 设计（侦察已核实）

> 目标（用户 2026-10-16 要求）：在 DSH 面板里加一个**设置页**，名字叫**「论文插件外置 key 连接器」**，能在上面**发 token / 连接 / 查看已连了哪些 key / 停用（保留但关闭）/ 删除**；并且**谨慎到不把宿主搞崩**；最后要校对源文件、兼容性与完整性。

## 一、已在**本机实测核实**的宿主契约（不是猜的）

| 事实 | 证据（怎么核到的） |
|---|---|
| paper-studio 的 `plugin/` **已经是本机 DSH 插件半体** | profile `package.json`：`"dsh-paper-studio-v3": "link:E:/DeepSeek/skills/paper-studio/plugin"`，且在 `bundles` 里 |
| 面板页槽位是 **`settings.section`（列表型）**，目录原文：**“Use an id of your own: a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it”** | `cordis_inspect_query(client, Slots, listSubTree, root=settings.section)` |
| `settings.section` 现占用者：`account(-10) general(0) models(10) plugins(15) agent-presets(20) auto-memory-pre(25) im-assistant(28) stratagate-memory(32) market(40) dsh-tiddlywiki(50) better-sidebar(100)` | 同上（`occupants`）⇒ 我们取一个**新 id**（如 `paper-keys`）与一个不冲突的 order（如 60）即可**加法插入，零替换风险**（`replaceRisk: none`） |
| 注册形态（参考实现） | `dsh-mcp-connector/lib/client.js`：`ctx.slots.inject("<slot>", () => ctx.slots.register({ name: "<slot>", id/key, order, store, inject: () => ({...}) }, Component))` |
| 客户端可用内置符号 | `cordis_inspect_query(client, Builtin, listBuiltins)`：**`ctx`**（`get/on/provide/effect`）· **`React`**（`createElement/useState/useEffect`，**无 JSX**）· **`host.call(method,args)`** · **`styles.insert(css)`** · `console` |
| 客户端可用服务 | `cordis_inspect_query(client, Service, listService)`：`layout` · `locale` · `sessions` · **`slots`** · `theme` · `timer` · `uiWorkspace` · `workspaces` |
| **持久化的官方通道 = `settingsScope` + 插件 `Config`**（参考实现里 `host.call` 出现 **0 次**） | `client.js`：`ctx.inject(["settingsScope"], (c) => { const settingsScope = c.settingsScope.bind({ namespace, decode }) })`；宿主 `index.js`：`export const Config = z.object({...})` + `inject = ['tools','storageDomain','loader','workspaceRegistry']` |
| 客户端半体必须**具名导出** `apply`/`inject`，且 **apply 整体 try/catch**（参考实现就是这么写的，与我们「插件开发硬约束」一致） | `client.js` L1750-1787：`function apply(ctx){ try { ... } catch(e){ console.error(...) } }` + `exports.apply = apply; exports.inject = inject` |
| 客户端半体声明方式 | `dsh-mcp-connector/package.json`：`exports["./client"] = "./lib/client.js"`，`dsh.client = { inject: [...], platform: "web" }` |

## 二、架构（三层，逐层可单独验证）

```
① 面板（客户端半体，新文件 plugin/client/client.js）
     React.createElement（无 JSX）→ 列表：provider / 掩码 / 来源 / 状态
     操作：新增 token · 连接测试 · 停用(保留) · 恢复 · 删除
     读写走官方通道：ctx.inject(['settingsScope']) 绑本插件 Config 命名空间
        ↓
② 宿主半体（扩展现有 plugin/dist/plugin.js）
     Config（zod）新增 modelKeys 段（每 provider 一个可选字符串 + disabled 列表 + baseUrls）
     配置变化时**物化**到本机文件（供 CLI 读）：%USERPROFILE%\.dsh\paper-studio-keys.json
     附带一个工具（如 paper_keys）供 agent 侧同样能查/测/停/删（人机同一套语义）
        ↓
③ CLI（bin/studio.cjs 的 model 子系统）
     凭据解析顺序：--key（一次性）→ 环境变量 → **面板物化文件**（新增）
     ⇒ 「面板里启用的 provider」与「model 能用的 provider」**同判**（同源，且面板停用即 CLI 不可见）
```

## 三、安全措施（针对"别把宿主搞崩"）

1. **加法插入**：新 `id: 'paper-keys'`，不动任何现有 section；`replaceRisk: none`。
2. **客户端半体全护栏**：`apply` 整体 try/catch（照参考实现）；`ctx.get(...)` 一律 `undefined` 检查；**不 await 未确认存在的服务**。
3. **隔离验证**：先写"无宿主渲染冒烟测试"（用 stub 的 ctx/React/slots 直接跑我们的组件与 apply），**再**启用；参考包自带 `scripts/ui-harness.mjs` 说明这是官方认可的做法（"只提供可交互 mock API，不读凭据、不连真实服务"）。
4. **可回滚**：启用前对 `profiles/desktop/package.json` 与 `cordis.patch.yml` 做时间戳快照（该目录已有 `_rollback-*` 与 `.bak-*` 先例）；客户端 bundle 改名前后都保留旧文件。
5. **凭据纪律**：面板只显示掩码（`sk-***ab（长度 N）`）；**不写仓库、不进日志、不在对话回显**；物化文件只写本机用户目录且文件权限收敛。
6. **不碰核心行**：只注册 `settings.section` 一个新 id（列表型槽位），**不做任何 `overrides`/补丁行替换**。

## 四、验收判据（要留读数）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 面板出现名为「论文插件外置 key 连接器」的设置页 | 重启后 `cordis_inspect_query(client, Slots, listSubTree, root=settings.section)` ⇒ occupants 里能看到我们的 id |
| 2 | 面板能写、能读、能停用、能删除 | 面板操作后，宿主物化文件与 `model providers` 同步变化（截图 + CLI 读数） |
| 3 | **面板与 CLI 同判** | 面板停用某 provider ⇒ `model providers` 显示"未配置/已停用"；启用后恢复 |
| 4 | 凭据不入库 | `scanForSecrets()`（已有）扫仓库 0 命中；`git status` 干净 |
| 5 | 宿主不崩 | 启用后**会话正常**（能继续对话）、设置页可开合、无 `apply failed` 日志 |
| 6 | 可回滚 | 回滚快照存在，回滚步骤写在文档里 |

## 五、已知风险与对策

- **客户端 bundle 的模块形态**：参考实现是"包装器 + `exports.apply`"形态，而我们的 `dist/plugin.js` 是 **ESM 具名导出**。⇒ 先读一个**小而清晰的第三方客户端半体**（如 `dsh-tiddlywiki/client` 或 `dsh-market`）确认它对 `settings.section` 的注册与导出形态，再照抄。
- **Config 中放密钥是否会被渲染到别处/落日志**：⇒ 面板只显示掩码；物化文件在用户目录；必要时把密钥放进 `storageDomain`（参考实现用它存 OAuth grant）而不是 Config，作为 v2。
- **CLI 读物化文件的优先级**：`--key` > env > 面板文件；且**面板停用**必须优先于 env（否则"停用了却还在用"）——这条要写成夹具。
