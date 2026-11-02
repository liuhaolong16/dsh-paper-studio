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
| P-05 | 待办 | HAUT 中文刊模板 | `templates/cn-haut` 有 docx 且 `--verify` PASS | 2026-11-02：取得官方《投稿须知》docx（cbimg.cnki.net/Editor/2022/0303/zzls/2c67c984-...docx）；模板页 zzls.cbpt.cnki.net/EditorB3N/PromptPageInfo.aspx?c=3&t=v 返回 200，但模板内容内嵌在 HTML/__VIEWSTATE，无 docx 附件；须转 docx 或由编辑部提供官方文件 |
| P-11 | 已关闭 | HJNU 中文刊模板 | 人文社科/自科两套 docx 且 `--verify` PASS | v3.87.0：hjsyxb.cbpt.cnki.net 官网模板页，verify 16/16；build+check PASS |
| P-06 | 已关闭 | 双远端推送 | gitee / github 均显示最新 main | v3.86.0 已 `git push gitee main` + `git push github main`（均 exit 0） |
| P-07 | 等人决策 | 外部 `paper-writer/SKILL.md` 接入段的归属 | 该目录成为 git 仓库或并入已有仓库并提交 | `E:\DeepSeek\skills\paper-writer` 经查不是 git 仓库；需用户定是否建仓 |
| P-08 | 已关闭 | 跑团面板「类别选择」固定（工作区1 跑团线） | workbench 的跑团设置 iframe 内类别栏滚动后仍贴顶（top=0），无重复顶栏 | trpg-package 本地 commit `53588442`；Chrome 实测：可见 header=0、tabs 滚动前 70→滚动 500 后 0 |
| P-09 | 待办 | npm 发布 3.50.1 → 3.88.0 | `npm view dsh-paper-studio version` 返回 3.88.0 | 2026-11-01：`npm whoami` → E401（未登录）；`npm publish --dry-run` 正常；需 `npm login` 或 Automation Token |
| P-12 | 已关闭 | 中文文献检索腿 | 中文关键词返回 ≥10 条可核验题录/摘要 | v3.89.0：`bin/zh-lit.cjs`（OpenAlex language:zh + type:article，selftest 4/4；实查「人工智能 智能体」命中 42636 条）；**不是 CNKI 全文库**，覆盖不全 |
| P-13 | 已关闭 | SCI 分区/选刊专项 | 输入 AI Agent 方向 + 目标二至三区，输出候选刊 + 分区 + 匹配理由 | v3.89.0：`bin/venue-select.cjs`（LetPub 公开页，selftest 4/4；实查 KBS 1区 IF8 / AA-MAS 3区 IF2.4 / IEEE TKDE 2区 IF11.6）；以页面当日为准 |
| P-14 | 已关闭 | 中英双语初稿 + 术语锁定 | `bin/bilingual.cjs --selftest` 4/4；术语两侧都出现、图表/引用/数字不漂移 | v3.88.0：`bin/bilingual.cjs --selftest` 4/4（正控+两条必失败+空术语表） |
| P-15 | 已关闭 | 降重闭环（改前→改后→重测） | `bin/dup-loop.cjs --selftest` 4/4；改后重合下降且数字/图表/引用不丢 | v3.88.0：`bin/dup-loop.cjs --selftest` 4/4（改后同文必 FAIL、丢标记必 WARN、SKIP 不算通过） |
| P-16 | 已关闭 | ARIS web 菜单与 threadId 实跑 | web 新会话 `/` 菜单见 ARIS 技能；`mcp__codex__codex` 返回 threadId 且 `codex-reply` 可续 | 2026-11-01：web 63999 `/` 菜单见 ARIS 技能；桥 `tools/call codex` 返回 threadId `01a197bc-f681-75c2-b56c-271a7b259891`，`codex-reply` 返回 SECOND（本地补丁见 ARIS部署决策）；web 模型 AUTH 归 P-17 |
| P-17 | 已关闭 | ARIS 审稿人凭证/effort | `codex exec` 30s 内返回；`model_reasoning_effort` 显式设置并可复跑 | 2026-11-02：桥自加载 User `VOLC_ARK_KEY`；xhigh 已设且 codex 返回 OK；web 选 account 侧模型后会话可用：`mcp__codex__codex` 返回 threadId `01a19836-8632-7c60-8b33-0040dbb055ca` + OK，`codex-reply` 返回 SECOND；API-key 侧同名条目仍 401，选 account 条目即可 |
| P-18 | 已关闭 | AI 写作两类硬伤机检 | `bin/ai-writing-check.cjs --selftest` 4/4；`studio ai-writing` 可跑 | 2026-11-02 蒸馏 BV1oZx762Edu：防御性废话 + 跳跃性推理；selftest 4/4；见 references/ai-writing-rejection.md |
| P-19 | 已关闭 | 投稿前 AI 预审闭环 | `bin/ai-prescreen.cjs --selftest` 4/4；`studio ai-prescreen` 可跑 | 2026-11-02 蒸馏 BV1FCxe6AE4N：AI 审稿 → 标 AI 痕迹 → 三版润色 → AI 披露；见 references/ai-prescreen-workflow.md |
| P-20 | 已关闭 | 三种防御性写作机检 | `bin/ai-writing-check.cjs --selftest` 6/6；`studio ai-writing` 可跑 | 2026-11-02 蒸馏 BV1Anxq6yE53：先扬后抑 / 限定堆叠 / 扩大局限；见 references/ai-writing-rejection.md |
| P-21 | 已关闭 | SCI 结论五句话机检 | `bin/conclusion-check.cjs --selftest` 5/5；`studio conclusion` 可跑 | 2026-11-02 蒸馏 BV1kVxg6eEhU：问题+判断/意义/关系/局限/下一步；见 references/conclusion-five-moves.md |
