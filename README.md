# dsh-paper-studio —— 论文方案（编排层）+ DSH 插件 V3

## 安装：装一次就拿到全部能力（v3.2.3）

本仓库是**一个整包**（不是"插件壳 + 外置资产"）：`files` 已含 `bin`（CLI）· `references`（判据资产与期刊体系）· `plugin`（DSH 插件半体、MCP 服务端）· `SKILL.md`（技能手册）。

- **整包**：`npm i -g dsh-paper-studio`（或把本仓库作为 bundle 装进 profile）⇒ `paper-studio` 命令、`paper-studio-mcp` 服务端、以及全部判据资产一次到位。
- **从仓库**：`dsh plugin --profile <p> add github:liuhaolong16/dsh-paper-studio`（等价，整棵树）。
- 插件定位能力树的顺序：`DSH_PAPER_STUDIO_ROOT` → **包内自带**（`<pkg>/plugin/dist` 往上两级）→ `~/.agents/skills/paper-studio` → `~/.dsh/skills/paper-studio` → `~/paper-studio` → `/opt/paper-studio`。
- 只装 `plugin/` 单目录**不支持**，且会**显形失败**（缺资产即退出码 1），不会静默降级。


把「**论文方案**」（＝论文框架 + 方法论 + 工作流）做成**可编排、可机检、可在对话里直接用**的一套东西：
一个 **CLI 编排层**（`bin/studio.cjs` + 唯一真源 `references/pipeline.json`）＋ 一个 **DSH 插件**（`plugin/`，**对话驱动、无面板、双模式、五种写作模式**）。

> 判据不在这里：门、体裁、模板、篇幅预算、教训都在 `references/` 的真源文件里，本仓只做**编排与桥接**。

## 它解决什么

- **不用记流程**：在对话里说「启用论文插件」「帮我写论文」，插件先**确认一次**，再用**可点击选项**给你五种模式（每项一行小字），选定后**按该模式差异化提问**。
- **不空转**：每个动作都返回**退出码与读数**；门跑没跑、过没过，有据可查。
- **不假封闭**：用户模式下**写入真的被拒**（有夹具证明目标文件未变）；开发者模式需用户**原话**解锁。
- **不造第二套说法**：`--selftest` 与 `audit` 会把"文档覆盖、规则表重复、真源单一所有者、门元数据、工具自检、数字漂移"六项**自动核**一遍。

## 目录

```
bin/                 CLI 编排层（studio.cjs 及各子工具，全部自带 --selftest）
references/          真源：pipeline.json（门/阶段/契约）· templates.json（章节骨架与预算）
                     market-parity.md（市面对齐取证与缺口）· plugin-spec-v3.md（V3 规格）
                     audit-2026-10-14.md（出厂审查报告）· aris-read-report.md（已读/未读如实报告）
plugin/              DSH 插件 V3（免编译 ESM）：dist/plugin.js · skill/SKILL.md · hub/ · selftest.mjs
docs/                快速上手
SKILL.md             技能说明（触发语 · 子命令用法 · 红线）
```

## 快速开始（CLI）

```bat
node bin\studio.cjs route "给这篇稿子做投稿前体检"     :: 判任务类型 + 链路 + 必过门
node bin\studio.cjs sections --genre research          :: 章节骨架（含篇幅预算与"必答问题"）
node bin\studio.cjs audit                              :: 出厂审查（完整性/重复性/数字一致性 6 项）
node bin\studio.cjs selftest                           :: 编排层自检
```

## 安装为 DSH 插件

```bat
:: 作为 bundle 装进 DSH profile（本地路径安装用 link: 规格）
plugin_manager install_bundle target="link:<本仓路径>/plugin"
```

装完宿主会注册两个工具：

| 工具 | 作用 |
|---|---|
| **`paper_studio`** | 唯一使用入口。`action=modes` 取五模式菜单（用宿主的可点击选项呈现）· `action=intent` **确定性判意图**（该启/不该启/拿不准）· 其余 action 桥接 CLI 并返回**退出码** |
| **`paper_dev`** | 开发者模式：`list/read/write/unlock/seal`。**用户模式默认封闭**，`write` 被拒并给解锁指引；写入仅限白名单资产根，越界拒收 |

**环境变量**：`DSH_PAPER_STUDIO_ROOT`（指向本仓根，未设时按 `~/.agents/skills/paper-studio` → `~/.dsh/skills/paper-studio` → `~/paper-studio` → `/opt/paper-studio` 顺序找）· `DSH_PAPER_HUB`（状态目录，默认 `~/.dsh/paper-studio`）。

## 自检（改完必跑）

```bat
node plugin\selftest.mjs         :: 20 项：注册形态 · 严格 JSON Schema · 真封闭 · 越界拒收 · 五模式差异化 · 意图夹具 · 端到端跑 CLI
node bin\studio.cjs audit        :: 6 项：文档覆盖 · 规则表重复 · 真源单一所有者 · 门元数据 · 工具自检实跑 · 数字漂移
node bin\studio.cjs selftest     :: 编排层 53 项
```

## 依赖与边界

- **运行时**：Node.js ≥ 20。联网/检索能力由宿主或你的其它技能提供，本仓**不要求任何付费或需登录的 API**。
- **本机路径登记**：`references/pipeline.json` 的 `assets` 段登记了**作者本机的资产路径**（论文方法本体仓、Python 解释器等）。换机器时按你的布局改这几项，或用环境变量覆盖。
- **明确不做**：不生成图片（图表只给题注文本/绘图建议/Mermaid 源码）· 不做规避 AI 检测类操作。
- **许可**：见 `LICENSE`（MIT）与 `NOTICE.md`（**三分类口径**：机制/思想不受著作权保护 · 本方实现 MIT · 本仓不含逐字复印的上游正文）。

## 两端同步说明（**如实记录**）

- **主仓：Gitee** —— <https://gitee.com/Suzumiya-haruhi16/dsh-paper-studio>
- **GitHub 侧** —— <https://github.com/liuhaolong16/dsh-paper-studio>（**公开可读**）

> **当前状态（2026-10-14 复核）**：**两端均已公开可读**，三端 commit 一致。
> 可见性判据：`git -c credential.helper= clone <url>` **且**配一个已知公开仓做对照（只用"clone 成功"判公开会被 git 凭据助手污染）；另用匿名 API 复核（GitHub `api.github.com` / Gitee `api/v5` 均 200）。

作者所在网络**无法直连 `github.com` 的 git over HTTPS**（实测：`curl https://github.com/...` 超时；但 `https://api.github.com` 200 正常）。因此 GitHub 侧的同步采用**由 GitHub 自己拉取**的方式，而不是本机推上去：

1. **一次性引导**：在 GitHub 网页用 **Import a repository** 指向上面 Gitee 主仓地址 —— GitHub 服务端会连 Gitee 克隆整个仓（含历史），本机网络不参与。
2. **此后的自动同步**：本仓自带 `.github/workflows/sync-from-gitee.yml`，会**每 6 小时**（以及手动 dispatch 时）由 Actions 运行器把 Gitee 的 `main` 镜像过来 —— **无需任何额外凭据**（用运行器自带的 `GITHUB_TOKEN`）。

> 为什么不用"本机直推"：本机没有可用代理 / `gh` / SSH 密钥，且逐文件走 API 需把 530 KB 内容经模型上下文传输（约十几万 token）——**代价不可接受**，故不采用。

## 相关仓

- 论文方法本体（11 维判据 · 机器门 · 投稿前检查表）：`research-paper-playbook`

## 机器本地路径（装包后**必做一步**）

真源 `references/pipeline.json` / `references/templates.json` 里**不含任何本机绝对路径**，只放 `__LOCAL__/<key>` 占位符
（证据纪律：对外文本不得含路径分隔符）。真值放在 **git 忽略**的 `references/local-paths.json`：

```bash
cp references/local-paths.example.json references/local-paths.json   # 然后按你的机器填
# 或：export DSH_PAPER_LOCAL_PATHS=/path/to/your/local-paths.json
```

需要填的 key：`playbook_root` · `playbook_skill` · `writer_skill` · `polish_skill` · `python_exe` · `phrase_bank`。
**取不到时不会静默变成空串**——运行时会明确提示"该值是未解析的本机路径占位符"，并给出上面这一步。
