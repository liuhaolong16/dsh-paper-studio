# dsh-paper-studio-v3

论文插件 V3：把「论文方案」（论文框架 + 方法论 + 工作流）做成 **DSH 原生、对话驱动、无面板**的插件。

- **两个工具**：`paper_studio`（唯一使用入口，桥接已冻结的 paper-studio CLI）· `paper_dev`（开发者模式：展示并允许改资产；用户模式下写入**真被拒**；解锁按**意图等价**（逐字原话或含「开发者模式」的等价说法均可，回执回显识别依据））。
- **五种写作模式**：全代写 / 共同创作 / 辅助创作 / 润色 / 其他 —— 用宿主的 `ask_user_question` 呈现为**可点击选项**，每项一行小字解释，且**行为差异化**（不是措辞差异）。
- **不复制判据**：门、体裁、模板、篇幅预算、教训全在 `../references/pipeline.json`（唯一真源），本插件只做编排与桥接。

## 安装（bundle）

`package.json` 声明了 `dsh.bundle.patch = ./cordis.patch.yml`，补丁内容：

```yaml
- insert:
    - id: paper-studio-v3
      name: dsh-paper-studio-v3
```

把本目录作为 bundle 安装到 DSH profile 即可（`plugin_manager install_bundle`），或先把整个 `paper-studio` 目录放到 `~/.agents/skills/paper-studio` 并用 `DSH_PAPER_STUDIO_ROOT` 指向它。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_PAPER_STUDIO_ROOT` | 指向 paper-studio 根（含 `bin/studio.cjs` 与 `references/pipeline.json`）；不设时按内置候选顺序找 |
| `DSH_PAPER_HUB` | 状态目录（默认 `~/.dsh/paper-studio`）；自检与多实例隔离用 |

## 自检

```bat
node plugin\selftest.mjs      :: 16 项（注册形态 · 严格 JSON Schema · 真封闭 · 解锁/回封 · 越界拒收 · 五模式差异化 · 端到端跑 CLI）
node bin\studio.cjs audit     :: 出厂审查 6 项（完整性 + 重复性 + 数字一致性）
```

## 设计边界（诚实声明）

- **不生成图片**：图表相关只给题注文本、绘图建议与 Mermaid 源码骨架。
- **不做规避 AI 检测类操作**。
- **没有面板/前端资产**（用户明确要求：易崩难做），交互全部走对话与 `ask_user_question`。

---

## 版本口径（勿混用）

本仓库有**两条独立演进的版本线**，互不覆盖：

| 线 | 位置 | 当前 |
|---|---|---|
| 技能版本 | `SKILL.md` 的 `metadata.version` | **2.4.0** |
| 插件包版本 | `plugin/package.json` 的 `version` | **3.1.0** |

插件包从 V3 起独立编号（V3 = 去面板 + 双模式），因此包版本号高于技能版本号**属正常**，不要为"对齐"而改任何一侧。判定兼容性只看**插件包版本**；判定流水线/判据能力只看**技能版本**。
