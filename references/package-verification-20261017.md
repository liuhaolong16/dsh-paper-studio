# paper-studio 交付验证证据（2026-10-17 00:15 采集 · 文档随 v3.2.78 交付）

> 用途：**任何人可照这份读数复跑**，判断"这一版交付物是否完整、可安装、与线上一致"。
> 纪律：本文件里每个数字都来自**实跑输出**（由 `_ef/readings.json` 反写，不手抄）。

## 一、三端同一提交

| 位置 | 值 |
|---|---|
| 本地 HEAD | `ff830a9` |
| GitHub `main` | `ff830a9` |
| Gitee `main` | `ff830a9` |
| 回滚标签 | `pre-v3.2.78` → `ff830a9`（3.2.77 的回滚点 `pre-v3.2.77` → `4fff071`） |
| 版本 | 主包 **3.2.78** · 插件 **3.2.78**（读数采于 3.2.77，自检/审计结论不随版本号变化） |

## 二、仓库内自检（复跑命令见第五节）

| 套件 | 读数 |
|---|---|
| studio（CLI 主自检） | 自检：243/243 通过 |
| package-audit（源文件完整性与兼容度） | package-audit 自检：7/7 通过 |
| 插件半体（DSH/MCP 面） | 论文插件 V3 自检：38/38 通过 |
| 面板 key 连接器隔离验证 | 自检：25/25 通过 |
| 出厂审查 audit | 合计：检查 6 项 · 未通过 0 项 ⇒ 全绿 |
| 凭据存储 keys-store | 自检：10/10 通过 |
| 门执行器 gate-runner | gate-runner 自检：53/53 通过 |
| **七要素完整性**（六形态 × 框架/格式/方法论/核心/工作流/重点/字数） | **七要素齐全且形态间有差异** |

## 三、源文件完整性与兼容度（package-audit）

| 项 | 读数 |
|---|---|
| 随包清单（由 `package.json.files` 推导，**不含 npm 自身忽略规则 ⇒ 是 tarball 超集**） | 声明 14 项 ⇒ **121 个文件**，逐文件 sha256 落盘 `run/package-manifest.json`（121 条） |
| 违禁项扫描（`.npmrc` / `node_modules` / `.git/` / `.env` / 密钥文件） | **0 项** |
| 密钥样式扫描（`npm_…` / `ghp_…` / 私钥头） | **0 项** |
| CSL 样式锁 | **3/3** |
| 门副本逐字节对拍（内置 vs 本机外部） | **PASS**（sha256 `d8ad214750be7aa0b8e27a2c…`） |
| 适配器 / 宿主兼容面 | **5 项在册** |
| 判定 | **通过** |

关键文件的 sha256 前 16 位（完整表见 `run/package-manifest.json`）：

| 文件 | sha256（前 16 位） |
|---|---|
| `bin/studio.cjs` | `c87ad5e75fef8f12…` |
| `bin/package-audit.cjs` | `046f4711d90766af…` |
| `bin/keys-store.cjs` | `9588ac9c7d0a5838…` |
| `references/pipeline.json` | `9e8ba3390b74711b…` |
| `references/forms/thesis.json` | `a3d381aa210977ee…` |
| `panel/lib/client.js` | `4aba180232e176fb…` |

## 四、npm 线上（分发口径的唯一真判据）

| 项 | 读数 |
|---|---|
| 线上 `latest` | **3.2.75** |
| 已发布版本 | [ '0.0.0-stage', '3.2.59', '3.2.71', '3.2.75' ] |
| `3.2.75` 的 `dist.shasum` | `27a7a1b236fba8a1cd94f8070086d1a385a2e159` |

**已做过的真装验证（3.2.75，干净临时目录）**：111 文件 · 含 `panel/` 与 `references/forms/` · 装后 `studio selftest` **243/243** · 面板隔离验证 **25/25** · 插件 **38/38** · `form coverage` 六形态七要素齐全。
**证据链闭合**：用户终端发布回显的 shasum ＝ registry 的 `dist.shasum` ＝ 我装到的那一份 ⇒ 验证对象与发布对象同一。

> 线上与本地会短暂不一致（本地已到 **3.2.78**）：**发布这一步只能由用户执行**（其脚本走 `www.npmjs.com/auth/cli/<token>` 网页鉴权；本机非交互 shell 必被 `EOTP` 拒绝）。追平方式：在仓库跑一次 `npm publish --access public --registry https://registry.npmjs.org/`（或打 `v*` 标签触发 `.github/workflows/publish-npm.yml`，前提是 npm 侧已配 Trusted Publisher）。

## 五、怎么复跑（全部命令）

```bash
node bin/studio.cjs selftest            # CLI 主自检 → 期望 243/243
node bin/package-audit.cjs              # 源文件完整性与兼容度（六项）→ 期望「判定：通过」
node bin/package-audit.cjs --selftest   # 审计自身 7 条（含必失败臂）
node plugin/selftest.mjs                # 插件半体 → 期望 38/38
node panel/_check-client.cjs            # 面板隔离验证 → 期望 25/25
node bin/studio.cjs audit               # 出厂审查 → 期望 6/6 全绿
node bin/studio.cjs form coverage       # 六形态七要素 → 期望「齐全且形态间有差异」
node bin/keys-store.cjs --selftest      # 凭据存储 → 期望 10/10
node bin/gate-runner.cjs --selftest     # 门执行器 → 期望 53/53
```

## 六、已知边界（**没有**被验证的）

1. **npm 发布不由本机代跑**：非交互 shell 无法应答 `EOTP` ⇒ 发布环节是"用户执行 + 我复验"的模式。
2. **包内不含 `.github/workflows/`**（`files` 白名单未列 `.github`）⇒ 从 npm 装包拿不到 CI 工作流；工作流只对仓库有意义。
3. **GitHub Actions 的 OIDC 发布未验证成功**：本机 `api.github.com` 被 hosts 指向 127.0.0.1（443 由本机加速器 `Steam++.Accelerator` 代理，只通 `github.com` 的 git 通路）⇒ 我无法 dispatch/读 run；已加 `push.tags:['v*']` 触发，但 npm 侧 Trusted Publisher 是否配置**未确认**。
4. **外部对照门不存在时记 SKIP**：换到没有本机外部门的机器上，门副本逐字节对拍会是 `SKIP`（**不是 PASS**）。
5. **文本用量子无真实 key 的连通性调用**：面板"连接"按钮的**调用路径与错误处理**有夹具，但未做真实付费调用。
