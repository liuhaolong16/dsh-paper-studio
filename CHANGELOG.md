# 变更记录

## v3.0.1 —— 2026-10-14

**插件（`plugin/`）**
- 修：`output.presentationMeta` 在无 `exit_code` 的动作（如 `modes`）下返回 `{exitCode: undefined}`，被宿主判为 **non-lossless JSON** 而**整次工具调用失败**（真机冒烟抓到的宿主级要求）。落法：只放 JSON 可表示的值，没有就不放这个键；`presentResult` 改读 `res.meta`。并**新增夹具**「`presentationMeta` / `render` / 返回值必须能无损 JSON 往返（缺键与 undefined 视为不同）」。
- 增：**确定性意图判据** `classifyIntent` + `paper_studio action=intent`，配 **13 条夹具**（该启 / 不该启 / 拿不准三类）。夹具当场抓出一个真漏判：倒序表述（「这篇稿子帮我润色一下」）被误判为不相关 ⇒ 判据从"相邻词序"改为**「动作词 × 对象」共现**；「只有动作词、没有对象」定级为**拿不准、先问**。
- 增：端到端夹具**重试一次 + 偶发显形**（`flakes` 段）—— 偶发不许隐藏，也不因此放宽判据。
- 自检：**16/16 → 20/20**。

**编排层（`bin/`）**
- 修：`studio.cjs audit` 的转发曾写成 `require(...).main ? ... : 2`，而 `audit.cjs` 漏导出 `main` ⇒ **静默返回 2、零输出**（看起来像 CLI 挂了）。已改为缺 `main` 时**显式报错**。
- 修（可移植性）：`audit.cjs` 不再硬编码私有登记表路径 —— 改为**可选依赖**（`DSH_AI_WORKBENCH_REGISTRY` 可覆盖；缺失则**显式跳过并说明**），并在输出里**显形**「跳过」而不是让人误读成通过。
- 修（可移植性）：`plugin.js` 的根目录候选把本机路径降为**最后兜底**；`studio.cjs` 两处夹具去掉本机下载路径/假盘符，改合成路径（公开仓不泄漏本机路径）。
- CLI 桥接改用**文件描述符捕获**（不用管道）：在受限执行环境里也能跑，且不受 maxBuffer 限制。
- 自检：**53/53**。

**文档与合规**
- 增：`README.md`（含两端同步说明）· `LICENSE`（MIT）· `NOTICE.md`（三分类许可口径 + 机制来源表）· `references/aris-read-report.md`（**已读 16 / 台账 730 / 实盘 1309**，三个分母分清）· `references/audit-2026-10-14.md`（出厂审查报告）· `SKILL.md` 增「质量验收（A 类门 ≠ 质量通过）」（跨模型族复核 + **双停止条件**：`score ≥ 6` 且 `verdict ∈ {ready, almost}`）。
- 增：`plugin/tools-manifest.json`（两个工具的严格 JSON Schema 清单，供下游校验）。
- `references/plugin-spec-v3.md` §8 完成判据**逐条打勾并附证据**；§10 记录真机发现。

**已知限制（如实记录）**
- 真机 `paper_studio action=modes` 在**重启 DSH 前**仍会因模块缓存报 `non-lossless JSON`（`link:` 安装的代码改动不热生效；`set_bundle` 开关与升版本重装均无效，已实测）。仅此一条路径受影响，其余真机可用。
