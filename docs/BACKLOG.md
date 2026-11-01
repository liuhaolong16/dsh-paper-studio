# paper-studio 欠账真源（BACKLOG）

> 本文件是本项目**唯一**的欠账清单。状态合法值：`待办` / `进行中` / `等人决策` / `未查清` / `不做` / `已关闭`。
> 关闭必须有证据（提交号 / docs 路径 / tests 路径 / selftest 输出 / URL），否则 `bin/backlog-check.cjs` 会红。
> 只有用户能说“不做”；模型最多写“待办 + 触发条件”。

| 编号 | 状态 | 项 | 可失败验收 | 证据 / 来源 |
|---|---|---|---|---|
| P-01 | 已关闭 | longform 终稿自动接期刊检查 | `longform --deliver --journal <刊>` 生成 docx 并跑 `journal-template --check`，失败退出 1 | v3.86.0 selftest 21/21「deliver 自动套版并检查通过」；`bin/longform.cjs` |
| P-02 | 已关闭 | 选题「空白分支」接真实引用图数据 | `--graph-check` 用 OpenAlex 实测 n 与声明 n 比对（容差 10%），不符退出 1 | 10.1038/nature12373 声明 1958 / 实测 1955 PASS；`--graph-check` |
| P-03 | 待办 | ACS 官方 Word 模板 | `templates/acs-journals` 含官方 docx 且 `--verify` PASS | 2026-10-22 取证：pubs.acs.org / pubsapp 均 403；触发条件=拿到官方文件 |
| P-04 | 待办 | Wiley 官方 Word 模板 | 同上，`templates/wiley-*` | 2026-10-22：onlinelibrary 卡 Cloudflare；触发条件=浏览器会话可过验证 |
| P-05 | 待办 | HAUT 中文刊模板 | `templates/cn-haut` 有 docx 且 `--verify` PASS | 2026-10-22：官网只有须知；2026-11-01 未找到其 CNKI 腾云门户模板 |
| P-11 | 已关闭 | HJNU 中文刊模板 | 人文社科/自科两套 docx 且 `--verify` PASS | v3.87.0：hjsyxb.cbpt.cnki.net 官网模板页，verify 16/16；build+check PASS |
| P-06 | 已关闭 | 双远端推送 | gitee / github 均显示最新 main | v3.86.0 已 `git push gitee main` + `git push github main`（均 exit 0） |
| P-07 | 等人决策 | 外部 `paper-writer/SKILL.md` 接入段的归属 | 该目录成为 git 仓库或并入已有仓库并提交 | `E:\DeepSeek\skills\paper-writer` 经查不是 git 仓库；需用户定是否建仓 |
| P-08 | 已关闭 | 跑团面板「类别选择」固定（工作区1 跑团线） | workbench 的跑团设置 iframe 内类别栏滚动后仍贴顶（top=0），无重复顶栏 | trpg-package 本地 commit `53588442`；Chrome 实测：可见 header=0、tabs 滚动前 70→滚动 500 后 0 |
| P-10 | 待办 | 跑团仓提交推送 | gitee `main` 含 `53588442` | 2026-11-01 `git push gitee main` → `pre-receive hook declined`；需仓库权限/用户推送 |
| P-09 | 待办 | npm 发布 3.50.1 → 3.86.0 | `npm view dsh-paper-studio version` 返回 3.86.0 | 2026-11-01：`npm whoami` → E401（未登录）；`npm publish --dry-run` 正常（228 文件 / 2.9MB）；需 `npm login` 或 Automation Token |
