#!/usr/bin/env node
/**
 * number-consistency —— **承重数字四处一致门**。
 *
 * 来源：《论文写作基因图谱 v1》R3（4/4 类体裁共有，`paper-gene/ATLAS-v1.md` §2）。
 * 真实事故（本工程实测）：Transformer 摘要与 Table 2 记 41.8、§6.1 同句记 41.0，两处都没交代；
 * Dropout 表内均值 95 与附录 about 94 不一致；短篇 P1 的 1,264/89 与表内合计差 364。
 * 另一族是**单位混用**：把 global cycles 与 epochs 并称（"30/20/10/50 epochs" 里 20 与 10 其实是 cycles）。
 *
 * ⚠️ 复用说明：原计划复用 `figures-kit` 的数字抽取器，**实测不存在**（它只处理图尺寸 mm 与面板号 A–D），
 *    所以本工具自带抽取器，并在回执里如实写明。
 *
 * 判据（窄口径）：
 *   1. 只抽取**够格当指标名**的「标签＋数值(+单位)」对 —— 命中指标词表 / 数值自带单位 / 标签是全大写缩写；
 *      虚词（of/the/with…）、纯数字标签、章节与图表号一律不算（首版误报的主因）。
 *   2. 同一指标**出现 ≥2 次**才进比较；出现 ≥2 个**不同值**时：
 *      · 任一单句同时含这两个原始写法 ⇒ 视为已交代（PASS）；
 *      · 否则 ⇒ **FAIL 未交代**（本门只拦这个）。
 *   3. **单位混用**：同指标下有的带 %／有的不带，或单位不同 ⇒ **FAIL**（0.86 与 86% 不是一回事）。
 *   4. **同段 cycles/epochs 混称**：同一行同时出现 轮/cycles 与 轮次/epochs 且挂数字 ⇒ **WARN**。
 *   5. 抽不出指标名的数字计入「未判」并**报未判率**；未判率 >50% 且本来 PASS ⇒ 降 **WARN**（覆盖不足不得当通过）。
 *   6. **三套值并存（v1.2.0 · 图谱 R3 形态③）**：同一指标出现 **≥3 个不同值**且无人交代 ⇒ `THREE_SETS`
 *      （比"两值"更重：三套值往往来自两套输出被拼进同一张表，读者拿哪套都不对）。跨表出现时在文案里点明表数。
 *   7. **表内列和自洽（v1.2.0 · 图谱 R3 形态④）**：表头含 Total/合计 且同表有分项列（Trainable/Non-trainable…）时
 *      · 分项之和 ≠ Total（容差 0.5%）⇒ `COLS_SUM`
 *      · 某分项 > Total ⇒ `COLS_SWAPPED`（两列写反，真实形态：C3·P2 表 3.2 Model 3）
 *      这是**唯一不需要跨处比对**的形态：一张表内部就能证伪。
 *
 * 诚实边界（必须打印）：
 *   · 指标名靠词表＋启发式，**会漏也会错配**；本工具**不判数值对不对**；
 *   · 每个指标名只出现一次 ⇒ `SKIP（无可比对象，不得当通过）`。
 *
 * 用法：
 *   node bin/number-consistency.cjs --draft <稿.md> [--json]
 *   node bin/number-consistency.cjs --selftest
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'v1.2.0';

/** 文档类型守卫：分析笔记不是稿件（详见 absence.cjs 同名函数注释）。 */
function looksLikeAnalysisNote(text) {
  if (/(^#{1,6}[^\n]*证据索引|^#{1,6}[^\n]*evidence\s+index)/im.test(text)) return '含「证据索引」节';
  if (/(^##\s*0\.\s*摘要式结论|^\|\s*\*\*论证\*\*\s*\|)/m.test(text)) return '含「摘要式结论」或 7 栏论证表';
  return null;
}

const PAIR_RE = /([A-Za-z][A-Za-z0-9\-_.²³]{0,19}(?:\s*[a-z]{2}\s*[-–—→]\s*[a-z]{2})?|[\u4e00-\u9fa5]{2,8})\s*(?:[|｜]\s*)?[:：=]?\s*(?:[|｜]\s*)?(\d+(?:\.\d+)?)\s*(%|％|‰|×|倍|ms|s\b|min\b|h\b|GB\b|MB\b)?/g;
const NOISE = /^(?:fig|figure|table|tab|section|sec|chapter|p|pp|eq|equation|版本|第|图|表|节|章|页|式|年份|年|月|日)$/i;
const STOPWORD = /^(?:a|an|the|of|in|on|at|by|for|to|from|with|without|and|or|but|as|is|are|was|were|be|been|being|this|that|these|those|its|their|our|we|it|they|than|then|also|each|both|more|less|per|over|under|into|such|all|any|some|only|very|can|may|might|must|should|would|could|will|shall|has|have|had|do|does|did|not|no|yes|vs|versus|etc|e\.g|i\.e)$/i;
const METRIC_LEX = /(auc|aupr|auprc|roc|acc|accuracy|f1|f2|precision|recall|specificity|sensitivity|rmse|nrmse|mae|nmae|mse|mape|smape|mase|bleu|rouge|meteor|perplexity|ppl|loss|error|score|rate|ratio|percent|percentage|kappa|icc|cohen|iou|dice|hits|wape|r²|r\^2|r2\b|soh|capacity|efficiency|latency|throughput|fps|gflops|footprint|memory|准确|精度|误差|召回|精确|损失|得分|分数|准确率|命中|覆盖|容量|效率|时长|延迟|吞吐|相关系数|方差|标准差|均值|中位数|决定系数)/i;
const CYCLE_RE = /(\bcycles?\b|轮)/i;
const EPOCH_RE = /(\bepochs?\b|轮次|世代)/i;
const UNIT_RE = /(%|％|‰|×|倍)/;

/** 标签够不够格当"指标名"：命中词表 / 数值自带单位 / 全大写缩写。 */
function isMetricLabel(label, unit) {
  if (!label) return false;
  if (label.length > 40) return false;              // 长句不是指标名（表头误配的典型形态）
  if (NOISE.test(label)) return false;
  if (STOPWORD.test(label)) return false;
  // 标识符（电芯号 b002、cell3、Fig12…）不是指标名 —— 真实误报来源
  if (/^[A-Za-z]{0,5}\d{1,6}$/.test(label)) return false;
  if (METRIC_LEX.test(label)) return true;
  if (unit) return true;
  if (/^[A-Z][A-Z0-9\-]{1,9}$/.test(label)) return true;
  return false;
}

function zoneOf(line, state) {
  if (/^\s*[|｜]/.test(line)) return 'table';
  if (/^#{1,6}\s*(附录|appendix)/i.test(line)) { state.inAppendix = true; return 'appendix'; }
  if (/^#{1,6}\s*/.test(line) && !/附录|appendix/i.test(line)) state.inAppendix = false;
  if (/^#{1,6}\s*(abstract|摘要)/i.test(line)) { state.inAbstract = true; return 'abstract'; }
  if (/^#{1,6}\s*(introduction|引言|1\s)/i.test(line)) state.inAbstract = false;
  if (state.inAppendix) return 'appendix';
  if (state.inAbstract) return 'abstract';
  return 'body';
}

function extract(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  let numbersSeen = 0;
  let judged = 0;
  const state = { inAbstract: false, inAppendix: false, tableHeader: null };
  let inFence = false;

  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; return; }
    if (inFence || !line.trim()) return;

    // ── 表格：按表头配对（横排「指标｜A｜B」与竖排「指标｜值」都支持）──
    if (/^\s*[|｜]/.test(line)) {
      const cells = line.split(/[|｜]/).map((c) => c.trim());
      while (cells.length && cells[0] === '') cells.shift();
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (!state.tableHeader) { state.tableHeader = cells; return; }
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return;
      const labelCol = state.tableHeader.findIndex((h) => /^(指标|指标名|metric|measure|项目|名称|name)$/i.test(h || ''));
      cells.forEach((cell, ci) => {
        const nums = cell.match(/\d+(?:\.\d+)?/g);
        if (!nums) return;
        const headerCell = state.tableHeader[ci] || '';
        // 行标签＝本行第一个非数值文本格（横排表的指标名通常在这里）
        const rowLabel = cells.find((c, k) => k !== ci && c && !/\d/.test(c) && /[A-Za-z\u4e00-\u9fa5]/.test(c)) || '';
        let label = '';
        if (labelCol >= 0 && labelCol !== ci) label = cells[labelCol] || '';        // 竖排
        else if (/\d/.test(headerCell)) label = rowLabel;                          // 表头含数字（如 "…(4 / 24 / 43 °C)"）⇒ 用行标签
        else label = rowLabel || headerCell;                                      // 横排：优先行标签
        label = String(label).replace(/[*`]/g, '').trim();
        const unit = (cell.match(UNIT_RE) || [])[0] || '';
        if (!/[A-Za-z\u4e00-\u9fa5]/.test(label)) return;
        if (!isMetricLabel(label, unit)) return;
        const raw = nums[0];
        const value = parseFloat(raw);
        if (!isFinite(value)) return;
        for (let k = 0; k < nums.length; k++) numbersSeen++;
        judged++;
        pairs.push({
          label, key: label.toLowerCase(), raw, value, unit, zone: 'table', line: i + 1,
          text: line.trim().slice(0, 150),
          cycles: CYCLE_RE.test(line), epochs: EPOCH_RE.test(line)
        });
      });
      return;
    }

    state.tableHeader = null;
    const zone = zoneOf(line, state);
    const found = line.match(/\d+(?:\.\d+)?/g) || [];
    numbersSeen += found.length;
    PAIR_RE.lastIndex = 0;
    let m;
    while ((m = PAIR_RE.exec(line)) !== null) {
      const label = m[1];
      const unit = m[3] || '';
      if (!isMetricLabel(label, unit)) continue;
      const raw = m[2];
      const value = parseFloat(raw);
      if (!isFinite(value)) continue;
      judged++;
      pairs.push({
        label, key: label.toLowerCase(), raw, value, unit, zone, line: i + 1,
        text: line.trim().slice(0, 150),
        cycles: CYCLE_RE.test(line), epochs: EPOCH_RE.test(line)
      });
    }
  });

  return { pairs, numbersSeen, judged };
}

/** 抽出表格块（表头 + 数据行），供「表内列和自洽」使用。 */
function parseTables(lines) {
  const tables = [];
  let cur = null;
  lines.forEach((line, i) => {
    if (!/^\s*[|｜]/.test(line)) { if (cur && cur.rows.length) tables.push(cur); cur = null; return; }
    const cells = line.split(/[|｜]/).map((c) => c.trim());
    while (cells.length && cells[0] === '') cells.shift();
    while (cells.length && cells[cells.length - 1] === '') cells.pop();
    if (!cells.length) return;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) return;   // 分隔行
    if (!cur) { cur = { header: cells, rows: [], startLine: i + 1 }; return; }
    cur.rows.push({ cells, line: i + 1 });
  });
  if (cur && cur.rows.length) tables.push(cur);
  return tables;
}

const TOTAL_RE = /^(?:total|sum|总计|合计|总数|参数总量)$/i;
const PART_RE = /(?:trainable|non-?trainable|可训练|不可训练|分项|其中)/i;

/**
 * 表内列和自洽（图谱 R3 形态④）：一张表内部就能证伪，不需要跨处比对。
 * 真实形态：C3·P2 表 3.2 的 Model 3 —— Total 43,411,882 小于同行 Trainable 43,415,850 ⇒ 两列写反。
 */
function checkTableSums(tables) {
  const issues = [];
  for (const t of tables) {
    const header = t.header.map((x) => String(x).replace(/[*`]/g, '').trim());
    const totalCols = header.map((x, i) => (TOTAL_RE.test(x) ? i : -1)).filter((i) => i >= 0);
    if (!totalCols.length) continue;
    const partCols = header.map((x, i) => (PART_RE.test(x) ? i : -1)).filter((i) => i >= 0);
    if (!partCols.length) continue;
    const numOf = (s) => {
      const v = String(s == null ? '' : s).replace(/[,\s]/g, '');
      return /^-?\d+(?:\.\d+)?$/.test(v) ? parseFloat(v) : NaN;
    };
    for (const tc of totalCols) {
      for (const r of t.rows) {
        const total = numOf(r.cells[tc]);
        if (!isFinite(total) || total === 0) continue;
        const vals = partCols.filter((c) => c !== tc).map((c) => numOf(r.cells[c])).filter((v) => isFinite(v));
        if (!vals.length) continue;
        const rowText = r.cells.slice(0, 5).join(' | ');
        // 分项不可能大于 Total —— 只要大一点点（哪怕 1），就是两列写反，不该给容差
        const allInt = vals.every((v) => Number.isInteger(v)) && Number.isInteger(total);
        const swapTol = allInt ? 0 : 0.5;
        if (vals.some((v) => v > total + swapTol)) {
          issues.push({
            level: 'FAIL', code: 'COLS_SWAPPED',
            why: `表内某行「Total」= ${total}，却小于同行分项（${vals.join(' / ')}）—— 两列很可能写反了`,
            where: `table@L${r.line}: ${rowText}`
          });
          continue;
        }
        const sum = vals.reduce((a, b) => a + b, 0);
        // 整数列（参数量、条数）求和必须严丝合缝；带小数的列才给 0.5% 容差（四舍五入）
        const tol = allInt ? 0 : Math.max(total * 0.005, 0.5);
        if (Math.abs(sum - total) > tol) {
          issues.push({
            level: 'FAIL', code: 'COLS_SUM',
            why: `表内某行分项之和 ${sum} 与 Total ${total} 不等（差 ${(total - sum).toFixed(2)}，容差 ${tol.toFixed(2)}）`,
            where: `table@L${r.line}: ${rowText}`
          });
        }
      }
    }
  }
  return issues;
}

function run(file) {
  const text = fs.readFileSync(file, 'utf8');
  const noteMark = looksLikeAnalysisNote(text);
  if (noteMark) {
    return {
      status: 'SKIP', file, numbersSeen: 0, judged: 0, skipRate: 0, compared: 0, coverage: null, issues: [],
      note: `疑似分析笔记（${noteMark}），不是稿件 ⇒ 本门不适用；请对**投稿稿**运行`
    };
  }
  const { pairs, numbersSeen, judged } = extract(text);
  const skipRate = numbersSeen ? 1 - judged / numbersSeen : 0;
  const lines = text.split(/\r?\n/);

  const groups = new Map();
  for (const p of pairs) {
    if (!groups.has(p.key)) groups.set(p.key, []);
    groups.get(p.key).push(p);
  }

  const issues = [];
  const compared = [];
  for (const [key, arr] of groups) {
    if (arr.length < 2) continue;
    compared.push({ key, count: arr.length, values: [...new Set(arr.map((x) => x.value))], zones: [...new Set(arr.map((x) => x.zone))] });
    const distinct = [...new Set(arr.map((x) => x.value))];
    if (distinct.length < 2) continue;

    const raws = [...new Set(arr.map((x) => x.raw))];
    const declared = raws.length >= 2 && lines.some((ln) => raws.every((r) => new RegExp(`(?:^|[^\\d.])${r.replace('.', '\\.')}(?:[^\\d]|$)`).test(ln)));
    if (!declared) {
      if (distinct.length >= 3) {
        // 形态③：三套值并存（比两值更重 —— 往往是把两套输出拼进了同一张表，读者拿哪套都不对）
        const tblZones = [...new Set(arr.filter((x) => x.zone === 'table').map((x) => x.line))];
        issues.push({
          level: 'FAIL', code: 'THREE_SETS',
          why: `指标「${key}」出现 ${distinct.length} 个不同值（${raws.join(' / ')}），且全文没有任何一句交代该用哪套 —— 三套值并存` +
               (tblZones.length ? `（其中 ${tblZones.length} 处落在表格里，可能是两套输出被拼进同一张表）` : ''),
          where: arr.map((x) => `${x.zone}:L${x.line}`).join(' · ')
        });
      } else {
        issues.push({
          level: 'FAIL', code: 'UNRECONCILED',
          why: `指标「${key}」出现 ${distinct.length} 个不同值（${raws.join(' / ')}），全文没有任何一句同时交代这两处`,
          where: arr.map((x) => `${x.zone}:L${x.line}`).join(' · ')
        });
      }
    }
    const units = [...new Set(arr.map((x) => x.unit))];
    if (units.length > 1) {
      issues.push({
        level: 'FAIL', code: 'UNIT_MIXED',
        why: `指标「${key}」同一组数值单位不一致（${units.map((u) => u || '(无)').join(' / ')}）—— 0.86 与 86% 不是一回事`,
        where: arr.map((x) => `${x.raw}${x.unit}`).join(' · ')
      });
    }
  }

  // 同段 cycles / epochs 混称（行级，不依赖指标配对）
  lines.forEach((ln, i) => {
    if (!/\d/.test(ln)) return;
    if (CYCLE_RE.test(ln) && EPOCH_RE.test(ln)) {
      issues.push({
        level: 'WARN', code: 'CYCLES_EPOCHS',
        why: '同一行同时出现 cycles/轮 与 epochs/轮次且都挂着数字 —— 两者是不同单位，并称会被读成同一刻度',
        where: `L${i + 1}: ${ln.trim().slice(0, 110)}`
      });
    }
  });

  // 形态④：表内列和自洽（不需要跨处比对，一张表内部即可证伪）
  issues.push(...checkTableSums(parseTables(lines)));

  const fail = issues.filter((i) => i.level === 'FAIL').length;
  const warn = issues.filter((i) => i.level === 'WARN').length;
  let status;
  if (fail) status = 'FAIL';
  else if (warn) status = 'WARN';
  else if (!compared.length) status = 'SKIP';
  else status = 'PASS';
  // 覆盖不足不自动降档（避免小样本夹具被误降），但必须把覆盖读数交出去，由 print/presubmit 显式提示
  const coverage = { comparedGroups: compared.length, judgedValues: judged, unjudgedRate: skipRate, thin: compared.length < 3 || judged < 5 };

  return {
    status, file, numbersSeen, judged, skipRate, compared: compared.length, coverage, issues,
    note: (compared.length || issues.length)
      ? '本工具不判数值对不对，只判「同指标多值有没有交代、单位是否一致、表内列和是否自洽」；指标名靠词表＋启发式；三套值的成因（拼接/版本混用）需人读确认'
      : '无重复指标值（每个指标名只出现一次）⇒ 无可比对象，不得当通过'
  };
}

function print(r) {
  console.log(`number-consistency ${VERSION} —— 承重数字四处一致门（来源：基因图谱 R3）`);
  console.log(`稿：${r.file}`);
  console.log(`抽取：数字 ${r.numbersSeen} 个 · 判为指标值 ${r.judged} 个 · 未判率 ${(r.skipRate * 100).toFixed(1)}%`);
  if (r.status === 'SKIP') {
    console.log(`\nSKIP：${r.note}`);
    return;
  }
  console.log(`可比指标组 ${r.compared} 组 · 问题 ${r.issues.length} 条 ⇒ ${r.status}`);
  if (r.coverage && r.coverage.thin) {
    console.log(`⚠ 覆盖不足：可比组 ${r.coverage.comparedGroups} 组、判到指标值 ${r.coverage.judgedValues} 个、未判率 ${(r.coverage.unjudgedRate * 100).toFixed(1)}% —— 这份稿上本门只能作参考，不得当"已核对"`);
  }
  console.log('');
  for (const i of r.issues) {
    console.log(`${i.level === 'FAIL' ? '✘' : '△'} [${i.code}] ${i.why}`);
    console.log(`    ${i.where}`);
  }
  if (!r.issues.length) console.log('✔ 同指标无未交代的双值、无单位混用');
  console.log(`\n边界：${r.note}`);
  console.log('复核命令：node bin/number-consistency.cjs --draft <稿.md> --json');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'numcon-'));
  const mk = (n, b) => { const p = path.join(tmp, n); fs.writeFileSync(p, b, 'utf8'); return p; };
  const cases = [];

  cases.push(['同值不报', mk('a.md', '# Abstract\nAUCPR 0.23 表现最好。\n\n| 指标 | 值 |\n|---|---|\n| AUCPR | 0.23 |\n'), 'PASS']);
  cases.push(['双值未交代', mk('b.md', '# Abstract\nBLEU 41.8 达到最好。\n\n## 6.1\nBLEU 41.0 也接近。\n'), 'FAIL']);
  cases.push(['双值已交代', mk('c.md', '# Abstract\nBLEU 41.8 达到最好。\n\n## 6.1\n摘要与表 2 记 BLEU 41.8，§6.1 记 BLEU 41.0，差异来自分词。\n'), 'PASS']);
  cases.push(['单位混用', mk('d.md', '# Abstract\n准确率 0.86 很高。\n\n| 指标 | 值 |\n|---|---|\n| 准确率 | 86% |\n'), 'FAIL']);
  cases.push(['单位混称', mk('e.md', '# Abstract\n训练 10 cycles 即 50 epochs。\n'), 'WARN']);
  cases.push(['负控（无重复）', mk('f.md', '# Abstract\nAUCPR 0.23。\n'), 'SKIP']);
  cases.push(['负控（单值表）', mk('g.md', '| 指标 | 值 |\n|---|---|\n| RMSE | 1.2 |\n'), 'SKIP']);
  cases.push(['表号不算指标', mk('h.md', '# Abstract\n结果见表 2 与表 3。\n'), 'SKIP']);
  cases.push(['虚词不算指标', mk('i.md', 'the 41.8 of 26 with 10 and 24 also 11\n'), 'SKIP']);
  cases.push(['负控（分析笔记）', mk('n.md', '# 某篇结论\n\nBLEU 41.8 与 BLEU 41.0 有分歧。\n\n## 9. 证据索引\n| P1 §2 ‖ quote |\n'), 'SKIP']);
  // R² 这类带符号的短标签（真实漏报：改了 R² 数值却没抓到）
  cases.push(['R² 双值未交代', mk('o.md', '# Abstract\nR² 0.874 表现最好。\n\n## 6.1\nR² 0.860 也接近。\n'), 'FAIL']);
  // 语向不同 ⇒ 不是同一指标两值（图谱 §9.3 修正的同族误报）
  cases.push(['不同语向不算冲突', mk('p.md', '# Abstract\nBLEU en-de 41.8 and BLEU de-en 41.0.\n\n## 6.1\nBLEU.\n'), 'SKIP']);
  cases.push(['同语向两值仍报', mk('q.md', '# Abstract\nBLEU en-de 41.8 on WMT.\n\n## 6.1\nBLEU en-de 40.2.\n'), 'FAIL']);

  // ── 形态③：三套值并存（≥3 个不同值）──
  cases.push(['三套值并存', mk('r.md', '# Abstract\nR² 0.874 表现最好。\n\n## 6.1\nR² 0.860 也接近。\n\n| 指标 | 值 |\n|---|---|\n| R² | 0.812 |\n'), 'FAIL:THREE_SETS']);
  // ── 形态④：表内列和自洽 ──
  cases.push(['表内 Total 小于分项（两列写反）', mk('s.md', '# Abstract\nTrainable 43415850。\n\n| 模型 | Trainable | Non-trainable | Total |\n|---|---|---|---|\n| Model 3 | 43415850 | 896 | 43411882 |\n'), 'FAIL:COLS_SWAPPED']);
  cases.push(['表内分项之和≠Total', mk('t.md', '# Abstract\nTrainable 2397226。\n\n| 模型 | Trainable | Non-trainable | Total |\n|---|---|---|---|\n| Model 2 | 2397226 | 1896 | 2397226 |\n'), 'FAIL:COLS_SUM']);
  cases.push(['负控（表内合计自洽）', mk('u.md', '| 模型 | Trainable | Non-trainable | Total |\n|---|---|---|---|\n| Model 1 | 22784938 | 1920 | 22786858 |\n'), 'SKIP']);

  let ok = 0;
  for (const [name, file, want] of cases) {
    const r = run(file);
    const [wantStatus, wantCode] = String(want).split(':');
    // 判定必须严格为 true：若用 !!r 之类真值判断，空数组/空字符串会把失败读成通过
    const okStatus = r.status === wantStatus;
    const okCode = wantCode ? r.issues.some((i) => i.code === wantCode) : true;
    if (okStatus === true && okCode === true) { ok++; console.log(`  ✔ ${name}: ${r.status}${wantCode ? '+' + wantCode : ''}`); }
    else {
      const got = r.status + (r.issues.length ? ' [' + r.issues.map((i) => i.code).join(',') + ']' : ' [无issue]');
      console.log(`  ✘ ${name}: 期望 ${want}，实得 ${got}`);
    }
  }
  // 必失败臂（②列和）：把 Total 列删掉，同一张表必须不再报
  const withTotal = mk('v1.md', '| 模型 | Trainable | Non-trainable | Total |\n|---|---|---|---|\n| Model 2 | 2397226 | 1896 | 2397226 |\n');
  const noTotal = mk('v2.md', '| 模型 | Trainable | Non-trainable | 备注 |\n|---|---|---|---|\n| Model 2 | 2397226 | 1896 | 待核 |\n');
  const w = run(withTotal), n = run(noTotal);
  if (w.status === 'FAIL' && n.status === 'SKIP') { ok++; console.log('  ✔ 必失败臂（列和）：删掉 Total 列后同一张表不再报'); }
  else { console.log(`  ✘ 必失败臂（列和）失灵（with=${w.status} without=${n.status}）`); }
  // 必失败臂：同一对数字，删掉交代句必须翻红
  const withDecl = mk('j1.md', '# Abstract\nBLEU 41.8 达到最好。\n\n## 6.1\n摘要与表 2 记 BLEU 41.8，§6.1 记 BLEU 41.0，差异来自分词。\n');
  const withoutDecl = mk('j2.md', '# Abstract\nBLEU 41.8 达到最好。\n\n## 6.1\nBLEU 41.0 也接近。\n');
  const aStat = run(withDecl).status;
  const bStat = run(withoutDecl).status;
  if (aStat === 'PASS' && bStat === 'FAIL') { ok++; console.log('  ✔ 必失败臂：删掉交代句后同一组数字由 PASS 翻 FAIL'); }
  else { console.log(`  ✘ 必失败臂失灵（with=${aStat} without=${bStat}）`); }

  const total = cases.length + 2;
  console.log(`\nnumber-consistency 自检：${ok}/${total} 通过`);
  process.exit(ok === total ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else {
  const i = argv.indexOf('--draft');
  const file = i >= 0 ? argv[i + 1] : null;
  if (!file || !fs.existsSync(file)) {
    console.log('用法：node bin/number-consistency.cjs --draft <稿.md> [--json]  |  --selftest');
    process.exit(2);
  }
  const r = run(file);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
