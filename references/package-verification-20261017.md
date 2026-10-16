# paper-studio 交付验证证据（读数采于 v3.2.81 · 文档随 v3.2.82 交付）

> 用途：**任何人可照这份读数复跑**，判断"这一版交付物是否完整、可安装、与线上一致"。
> 纪律：本文件里每个数字都来自**实跑输出**（先跑出 `readings381.json`，再由脚本反写，不手抄）。
> 采集时刻：2026-10-17 02:29（该时刻仓库版本 v3.2.81，HEAD `517636a`）。

## 一、三端同一提交（采集时刻）

| 位置 | 值 |
|---|---|
| 本地 HEAD | `517636a` |
| GitHub `main` | `517636a` |
| Gitee `main` | `517636a` |
| 采集时的最新标签 | `v3.2.81`（本文档随 v3.2.82 交付，其回滚点为采集时 HEAD） |
| 版本 | 主包 **3.2.81** · 插件 **3.2.81** |

## 二、仓库内自检（复跑命令见第六节）

| 套件 | 读数 |
|---|---|
| studio（CLI 主自检） | 自检：245/245 通过 |
| package-audit（源文件完整性与兼容度） | package-audit 自检：7/7 通过 |
| 插件半体（DSH/MCP 面） | 论文插件 V3 自检：38/38 通过 |
| 面板 key 连接器隔离验证 | 自检：25/25 通过 |
| 门执行器 gate-runner | gate-runner 自检：53/53 通过 |
| 期刊契约门（内置副本） | 自检：73/73 通过 |
| 出厂审查 audit | 合计：检查 6 项 · 未通过 0 项 ⇒ 全绿 |
| 凭据存储 keys-store | 自检：10/10 通过 |
| **七要素完整性**（六形态 × 框架/格式/方法论/核心/工作流/重点/字数） | **七要素齐全且形态间有差异** |

## 三、源文件完整性与兼容度（package-audit）

| 项 | 读数 |
|---|---|
| 随包清单（由 `package.json.files` 推导，**不含 npm 自身忽略规则 ⇒ 是 tarball 超集**） | 声明 14 项 ⇒ **122 个文件**，逐文件 sha256 落盘 `run/package-manifest.json`（122 条） |
| 违禁项扫描（`.npmrc` / `node_modules` / `.git/` / `.env` / 密钥文件） | **0 项** |
| 密钥样式扫描（`npm_…` / `ghp_…` / 私钥头） | **0 项** |
| CSL 样式锁 | **3/3** |
| 门副本逐字节对拍（内置 vs 本机外部） | **PASS**（sha256 `d8ad214750be7aa0b8e27a2c…`） |
| 适配器 / 宿主兼容面 | **5 项在册** |

> 口径诚实：清单是发布 tarball 的**超集**（npm 有自己的忽略规则）；对外核验以第四节 registry 读数与实际安装为准。

## 四、npm 线上（分发口径的唯一真判据）

| 项 | 读数 |
|---|---|
| 线上 `latest` | **3.2.81** |
| 已发布版本 | [ '0.0.0-stage', '3.2.59', '3.2.71', '3.2.75', '3.2.81' ] |
| `3.2.81` 的 `dist.shasum` | `e93ed3a81f88d224141014ab39befded2327bf8d` |
| `3.2.81` 的 `dist.fileCount` / `dist.integrity` | 113 / `sha512-ueZBaAmIWn/PTCzw3bO0LQS88V0q4hYa1i68l777JOjeh0Qqf2Y7uEijyqqmR1hU+mQxi8ZrPpcY3h7pGuROPw==` |

**真装验证（干净临时目录，从 npmjs 安装 `3.2.81`）**：113 文件 · 含 `panel/` · `references/forms/` · `bin/package-audit.cjs` · 装后 **studio 245/245** · 面板隔离 **25/25** · 插件半体 **38/38** · `form coverage` 七要素齐全。
**★证据链三处闭合**：发布终端回显的 shasum ＝ registry 的 `dist.shasum` ＝ 实装那一份（`e93ed3a81f88d224141014ab39befded2327bf8d`）⇒ 验证对象与发布对象同一。
**结论：npm 线上与仓库版本已同步**（不再是"线上落后若干版"的状态）。

## 五、★CI（GitHub Actions）结果通道与诊断

问题背景：本机 `api.github.com` 与 `github.com` 网页均不可达（只有 `git.exe` 能通 GitHub），因此**读不到 Actions 日志**。
解法（v3.2.81 起）：流水线把每一步 outcome 写成 `ci-status/publish-npm.json` 并推送到 **`ci-status` 分支** ⇒ 用 `git fetch github ci-status` 即可读到，**不依赖网页/API**。

`v3.2.81` 那次运行的实测结果：

```json
{
  "ref": "v3.2.81", "sha": "517636a82030613054a0bfd7f42d5bd7dc99959d",
  "job_status": "failure",
  "steps": { "npm11": "success", "npmci": "success", "selfchecks": "success", "pack": "success", "publish": "failure" },
  "runner": "ubuntu-latest", "npm": "11.21.1", "node": "v22.23.3"
}
```

**诊断**：触发有效、runner 有效、npm CLI(11.21.1) 与 Node(v22.23.3) 满足 Trusted Publishing 前提、自检与打包全过 —— **只有 `publish` 这一步失败** ⇒ 失败点在 **npm 侧鉴权（Trusted Publisher 未配置或与仓库/工作流不匹配）**，而不是工作流本身或本机环境。

> **发布通路现状**：① **手动发版可用且已验证**（用户在终端走 npm 网页鉴权，3.2.71 / 3.2.75 / 3.2.81 均成功）；② **自动发版（OIDC）未通**，卡在 npm 网站配置 Trusted Publisher 所需的 **2FA 环节**（安全密钥在该流程中未被触发、页面无验证器 App 入口）。

## 六、怎么复跑（全部命令）

```bash
node bin/studio.cjs selftest            # CLI 主自检 → 期望 245/245
node bin/package-audit.cjs              # 源文件完整性与兼容度（六项）→ 期望「判定：通过」
node bin/package-audit.cjs --selftest   # 审计自身 7 条（含必失败臂）
node plugin/selftest.mjs                # 插件半体 → 期望 38/38
node panel/_check-client.cjs            # 面板隔离验证 → 期望 25/25
node bin/studio.cjs audit               # 出厂审查 → 期望 6/6 全绿
node bin/studio.cjs form coverage       # 六形态七要素 → 期望「齐全且形态间有差异」
node bin/gate-runner.cjs --selftest     # 门执行器 → 期望 53/53
node gates/_journal-contract.cjs --selftest   # 内置契约门
git fetch github ci-status              # 读 CI 自报结果（然后 git show FETCH_HEAD:ci-status/publish-npm.json）
```

## 七、已知边界（**没有**被验证的）

1. **npm 自动发布（OIDC）未通**：证据见第五节（只有 `publish` 步失败）；需要 npm 侧一次性配置 Trusted Publisher，而该配置被 2FA 环节挡住。
2. **npm 发布不由本机代跑**：本机非交互 shell 无法应答 `EOTP` ⇒ 发布环节是"用户执行 + 我复验"的模式。
3. **包内不含 `.github/workflows/`**（`files` 白名单未列 `.github`）⇒ 从 npm 装包拿不到 CI 工作流；工作流只对仓库有意义。
4. **外部对照门缺失时记 SKIP 而非 PASS**：换到没有本机外部门的机器上，门副本逐字节对拍会是 `SKIP`。
5. **面板"连接"按钮未做真实付费调用**：只验证了调用路径与错误处理。
6. **契约检查仍有 known_gaps**（版面属性类等，每条写明原因，详见 `references/pipeline.json` 与各契约）。
