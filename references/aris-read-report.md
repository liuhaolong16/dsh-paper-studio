# ARIS 逆向：已读 / 未读如实报告

> 用户判据（`plugin-spec-v3.md` §8）：「收尾报告**如实列出** ARIS 已读/未读与理由（**不假装读完了 731 个文件**）」。
> 本文件就是那份报告。**先说结论：没有读完，也不声称读完。**

## 1. 结论（诚实先行）

| 口径 | 数量 | 说明 |
|---|---|---|
| **已读**（逐字全文） | **16** | 全部是 **Tier-A 方法论核心**；每条都**已落成本仓规则**（见 §3 映射表） |
| **未读**（台账内登记但未读） | **714** | 见 §4 的分类与不读理由 |
| 台账登记条目 | 730 | `E:\DevTools\ARIS-逆向台账.md`（`[x]`=16 · `[ ]`=714） |
| 实盘文件总数 | **1309** | 含 `.git` 内部 44 · `.json` **613**（多为数据/清单，非方法论源） |
| 排除 `.git` 后 | 1265 | 与台账 730 的差额约 535，主要是 `.json` 数据/清单类未逐条登记 |

⚠ **更正**：此前口头说的「731 个文件」**不准确** —— 那是把台账条目数（730）当成了文件总数。**实盘 1309，台账 730**，两个数不能混用。

## 2. 口径纪律（为什么要把三个数分开）

- **1309** = 磁盘上有多少个文件（含 `.git`、含数据）。
- **1265** = 排除 `.git` 后的真实内容文件数。
- **730** = 台账登记数（只登记了**可能有方法论价值**的文件；`.json` 批量未逐条登记）。
- **16** = 真正逐字读完的。
⇒ 任何"覆盖率"结论都必须写明用的是哪个分母；**用 730 当分母算"已读 2.2%"，用 1309 算是 1.2%** —— 两者都对，但必须说清。

## 3. 已读的 16 条与**吸收落点**（机制 → 本仓规则，附证据）

| # | ARIS 文件 | 吸收成的本仓规则（落点） |
|---|---|---|
| 1 | `shared-references/acceptance-gate.md` | **「门可以 DRIVE，不能 ACQUIT」**；A/B 门分类的认识论（全绿 ≠ 质量通过）→ `references/pipeline.json` 的 `gate_meta.judge_type[_note]` |
| 2 | `reviewer-independence.md` | 同族不得自判 ⇒ `runstate.cjs` 的**同族告警**（`accept` 需 `verdict_id` + 跨族 `reviewer`） |
| 3 | `review-scope-limits.md` | 复核**范围声明** ⇒ `gate-runner.cjs` 的 `scopeStatement()` |
| 4 | `assurance-contract.md` | **保证级别轴**（`BLOCKED` 比 `NOT_APPLICABLE` 更危险）⇒ 门判定状态机（缺输入必须阻断） |
| 5 | `effort-contract.md` | **投入不移动复核档位**（`hard_invariants`）⇒ `pipeline.gate_meta.hard_invariants` |
| 6 | `review-tracing.md` | 复核可追踪（逐条留痕）⇒ 改动账本 + `crosscheck` |
| 7 | `experiment-integrity.md` | 四类禁用模式 + 主张上限 + 范围声明 ⇒ 门与 `scope` 口径 |
| 8 | `capture-antipatterns.md` | 存「怎么修」不存「X 不能做 Y」⇒ 教训库写法（L-1…L-13 的 `practice` 列） |
| 9 | `evidence-precheck.md` | **`verified` ≠ `correct`** ⇒ 引用核实口径（L-10） |
| 10 | `output-manifest.md` | 产物清单（>15 件才登记）⇒ `runstate` 与工件状态 |
| 11 | `citation-discipline.md` | 生成式引用五类幻觉 + 保留而非静默删除（`[UNVERIFIED]`）+ **核验结论住工件不住正文** ⇒ 引用门/L-10/L-11 |
| 12 | `writing-principles.md` | 写作纪律 ⇒ `pipeline.gate_meta.writing_discipline` + `stylecheck.cjs` |
| 13 | `injection-hygiene.md` | **注入卫生两层**：clean ≠ safe；作用域阶梯是**检测广度**不是动作严重度 ⇒ `threat-scan.cjs` 的 `partition/blocksOn` |
| 14 | `resumable-runs.md` | **done ≠ accepted**；resume → 第一个非终态 ⇒ `runstate.cjs` |
| 15 | `output-versioning.md` | 时间戳+定名双写、永不删除、24h 陈旧告警 ⇒ `gate-runner.cjs` 的 `ageWarning()` |
| 16 | `external-cadence.md` | **Count, don't vibe**：陈旧计数 ≥2 转结构、≥4 升级；重启只可删尝试、不可删状态 ⇒ `iteration-log.cjs` 的陈旧阶梯 |

## 4. 未读的 714 条：分类与**不读的理由**（不是"来不及"）

| 类别 | 估计占比 | 为什么不逐条读 |
|---|---|---|
| 同族契约/参考文档（`shared-references/*` 其余） | 中 | **同族结构重复**：同族 20+ 篇里读其代表性 6 篇已取全部判据；逐条读是**重复取证**，不加新规则 |
| 各技能自己的 `SKILL.md` / 模板 | 高 | 我方治理裁决已定：**不再造第 17 个论文技能，只做编排层** ⇒ 只取其**判据与机制**，不搬其正文 |
| `.json` 数据/清单（613 个中未登记部分） | 高 | 多为数据与清单（如 marketplace 清单），**不是方法论源**；需要时按名精确取 |
| `tools/*.py`、脚本 | 中 | 与我方定位不同（我方不实现实验执行线）；**已有等效或更严的门**（11 道机器门） |
| LaTeX 模板/`.bst`/`.sty`/图片 | 低 | 属排版资产，非方法论；本仓只登记真源路径 |

**若继续读，优先级（可执行的第一步）**：① `shared-references/reviewer-routing.md`（859 行，B 类复核对接口）· ② `integration-contract.md`（外部能力接入契约）· ③ `fan-out-pattern.md`（扇出 ≠ 陪审团）。这三篇是**唯一还没吸收的 Tier-A 级判据**；其余属重复或数据。

## 5. 可复核（不靠我说）

```bat
:: 台账里的已读/未读计数（应得 16 / 714）
findstr /R /C:"^ *[-*] *\[x\]" E:\DevTools\ARIS-逆向台账.md | find /c /v ""
findstr /R /C:"^ *[-*] *\[ \]" E:\DevTools\ARIS-逆向台账.md | find /c /v ""

:: 实盘文件数
dir /s /b E:\DevTools\ARIS | find /c /v ""
```

## 6. 这份报告自身的边界

- 它证明的是「**我读了多少、吸收成了什么、没读的为什么不读**」，**不证明**未读部分没有价值 —— 未读里可能仍有值得吸收的判据（§4 已给出继续读的优先级）。
- 已读 16 条的「吸收落点」是**可点开的证据**（每条都指向本仓的真源字段、脚本函数或教训 id），不是自我评价。
