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
| P-09 | 待办 | npm 发布 3.50.1 → 3.88.0 | `npm view dsh-paper-studio version` 返回 3.88.0 | 2026-11-01：`npm whoami` → E401（未登录）；`npm publish --dry-run` 正常；需 `npm login` 或 Automation Token |
| P-12 | 待办 | 中文文献检索腿 | 中文关键词返回 ≥10 条可核验题录/摘要，并接入论文流水线 | 2026-11-01：CNKI kns8s 是 SPA 壳；百度学术触发安全验证；需合法公开 API/机构权限（触发条件=拿到可用源） |
| P-13 | 等人决策 | SCI 分区/选刊专项 | 输入 AI Agent 方向 + 目标二至三区，输出候选刊 + 分区 + 匹配理由 | 缺 JCR/中科院分区数据授权；OpenAlex 只有引用代理，不能冒充分区 |
| P-14 | 已关闭 | 中英双语初稿 + 术语锁定 | `bin/bilingual.cjs --selftest` 4/4；术语两侧都出现、图表/引用/数字不漂移 | v3.88.0：`bin/bilingual.cjs --selftest` 4/4（正控+两条必失败+空术语表） |
| P-15 | 已关闭 | 降重闭环（改前→改后→重测） | `bin/dup-loop.cjs --selftest` 4/4；改后重合下降且数字/图表/引用不丢 | v3.88.0：`bin/dup-loop.cjs --selftest` 4/4（改后同文必 FAIL、丢标记必 WARN、SKIP 不算通过） |
| P-16 | 待办 | ARIS web 菜单与 threadId 实跑 | web 新会话 `/` 菜单见 ARIS 技能；`mcp__codex__codex` 返回 threadId 且 `codex-reply` 可续 | 2026-11-01 只验了桥 initialize/tools/list；web 会话与 threadId 未验；见 references/review-contract.md |
| P-17 | 进行中 | ARIS 审稿人凭证/effort | `codex exec` 30s 内返回；`model_reasoning_effort` 显式设置并可复跑 | 宿主无 `VOLC_ARK_KEY`；补 key 后 4 分钟未返回；effort=none；见 review-contract |
