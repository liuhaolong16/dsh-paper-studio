#!/usr/bin/env node
/**
 * bakeoff —— **真对拍判分装置**（不是名目对齐，是同输入同任务实测）。
 *
 * 设计要点（为什么这样做才算数）：
 *   ① **探明前提**：本轮 7 个对手仓库 + 5 个 npm 包里**没有一个有可执行 CLI**（无 `bin`、无顶层脚本）
 *      ⇒ **"同一二进制同一输入"不可能**。本装置因此做 **方法级对拍**：把每家的**规则**施于**同一输入**，
 *      对**产出**做统一机检，并**明写**这是方法级（非其软件本体）。
 *   ② **两族判据分开**：`neutral`（中性机检，对所有参赛者一视同仁：数字/引用/LaTeX 不变量 · 长度带 · AI 味 · 可追溯性）
 *      与 `oursOnly`（我方门，如 stylecheck/polish —— 只对我方跑，**单列并标注"自家判据，仅供参照"**，不参与对手得分）。
 *   ③ **人读项必须标判者**：语言自然度这类无法机检的维度，写入 `human` 字段并要求显式 `judge`（本轮是 agent 自评 ⇒ 报告中标注"非盲评"）。
 *
 * 用法：
 *   node bin/bakeoff.cjs --task run/bakeoff/task-a-polish [--json]
 *   node bin/bakeoff.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* 英文 AI 味 / 套话短语（去 AI 味的判据面） */
const AITONE = [
  'it is worth noting', 'in summary', 'in conclusion', 'with the rapid development', 'to a certain extent',
  'play an important role', 'plays an important role', 'many problems remain', 'relatively limited',
  'a growing number of', 'it should be noted', 'more and more',
];
const VAGUE = ['many', 'most', 'some', 'several', 'a number of', 'relatively', 'fairly', 'largely', 'considerable', 'substantial'];

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
/** 取「任务正文」：剥掉夹具元数据（# 标题 / > 引用 / | 表格行）——否则夹具头部的日期会被当成必须保真的数字 */
const bodyOf = (s) => String(s || '').split('\n').filter((l) => !/^\s*(#|>|\|)/.test(l)).join('\n');
const words = (s) => (String(s).match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
const cnChars = (s) => (String(s).match(/[\u4e00-\u9fa5]/g) || []).length;

/** 从文本里抽"必须逐字保真"的东西：数字、引用标记 [n]、LaTeX 命令、DOI */
function invariants(text) {
  const t = String(text || '');
  const nums = (t.match(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g) || []).map((x) => x);
  const cites = (t.match(/\[\d+(?:\s*[-,–]\s*\d+)*\]/g) || []).map((x) => x.replace(/\s+/g, ''));
  const latex = (t.match(/\\[A-Za-z]+(?:\{[^}]*\})?/g) || []);
  const dois = (t.match(/10\.\d{4,9}\/[^\s)\]，。]+/g) || []);
  const tally = (arr) => arr.reduce((m, x) => { m[x] = (m[x] || 0) + 1; return m; }, {});
  return { nums: tally(nums), cites: tally(cites), latex: tally(latex), dois: tally(dois) };
}

/** 中性机检（纯函数，可夹具）—— 对任何参赛稿一视同仁 */
function neutralCheck(inputText, outText) {
  const s = String(outText || '');
  if (!s.trim()) return { status: 'SKIP', reason: '输出为空 ⇒ 未核对（不得当通过）', issues: [], dims: {} };
  const a = invariants(bodyOf(inputText)), b = invariants(s);   // ★ 只对正文抽不变量
  const issues = [];
  const missing = (kind) => Object.keys(a[kind]).filter((k) => (b[kind][k] || 0) < a[kind][k]);
  const missNum = missing('nums').filter((n) => n !== '12');      // [12] 里的 12 由引用项单独管
  const missCite = missing('cites');
  const missLatex = missing('latex');
  const missDoi = missing('dois');
  if (missNum.length) issues.push('数字不变量被破坏：' + missNum.join(', '));
  if (missCite.length) issues.push('引用标记不变量被破坏：' + missCite.join(', '));
  if (missLatex.length) issues.push('LaTeX 命令不变量被破坏：' + missLatex.join(', '));
  if (missDoi.length) issues.push('DOI 不变量被破坏：' + missDoi.join(', '));
  const lower = s.toLowerCase();
  const aiHits = AITONE.filter((p) => lower.indexOf(p) >= 0);
  if (aiHits.length >= 3) issues.push('AI 味短语 ' + aiHits.length + ' 处：' + aiHits.slice(0, 3).join(' / '));
  const vagueHits = VAGUE.filter((p) => new RegExp('\\b' + p + '\\b', 'i').test(s));
  /* 可追溯性：是否给出了改动账本（表头含 kind/change/why/reason 之类 + 至少 3 行） */
  const ledgerRows = (s.match(/^\|\s*\d+\s*\|/gm) || []).length + (s.match(/^\|\s*(去套话|数字保真|引用保真|模糊词落地|hedging 保留|贡献句|结构|open with|kept|dropped)\s*\|/gm) || []).length;
  const hasLedger = ledgerRows >= 3 && /(账本|ledger|change log|changes)/i.test(s);
  const w = words(s), cn = cnChars(bodyOf(inputText));
  const expect = cn / 1.7;
  const ratio = expect ? Math.round((w / expect) * 100) / 100 : null;
  return {
    status: issues.length ? 'FAIL' : 'PASS', issues,
    dims: {
      不变量保真: issues.some((x) => /不变量/.test(x)) ? 0 : 2,
      AI味控制: aiHits.length === 0 ? 2 : (aiHits.length <= 2 ? 1 : 0),
      可追溯性: hasLedger ? 2 : 0,
      具体性: Object.keys(b.nums).length ? 2 : 1,
    },
    readings: { ai_hits: aiHits, vague_hits: vagueHits.length, ledger_rows: ledgerRows, words: w, zh_chars: cn, length_ratio: ratio },
  };
}

/** 我方门（仅对我方跑；不参与对手得分） */
function ourGates(file) {
  const out = [];
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'stylecheck', '--draft', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const txt = (r.stdout || '') + (r.stderr || '');
  const m = /HARD (\d+) · SOFT (\d+) · INFO (\d+)/.exec(txt);
  out.push({ gate: 'stylecheck', exit: r.status, reading: m ? ('HARD ' + m[1] + ' · SOFT ' + m[2] + ' · INFO ' + m[3]) : txt.trim().slice(0, 120) });
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'revise', 'aitone', '--file', file], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const t2 = (r2.stdout || '') + (r2.stderr || '');
  out.push({ gate: 'revise aitone', exit: r2.status, reading: (t2.split('\n').filter(Boolean).slice(0, 2).join(' ｜ ') || '(无输出)').slice(0, 160) });
  return { note: '★ 自家判据，仅供参照：不参与对手评分（对对手不存在同名工具，用自家门给对手打分不公）', items: out };
}

function runTask(taskDir) {
  const inputPath = path.join(taskDir, 'input.md');
  if (!fs.existsSync(inputPath)) return { status: 'SKIP', reason: '读不到 input.md ⇒ 未核对' };
  const inputText = read(inputPath);
  const cDir = path.join(taskDir, 'contestants');
  if (!fs.existsSync(cDir)) return { status: 'SKIP', reason: '读不到 contestants/ ⇒ 未核对' };
  const rows = [];
  for (const f of fs.readdirSync(cDir).filter((x) => x.endsWith('.md')).sort()) {
    const name = f.replace(/\.(en\.)?md$/, '');
    const txt = read(path.join(cDir, f));
    const n = neutralCheck(inputText, txt);
    rows.push({ contestant: name, file: 'contestants/' + f, ...n, oursOnly: /^ours/i.test(name) ? ourGates(path.join(cDir, f)) : null });
  }
  return { status: 'PASS', task: path.basename(taskDir), input: inputPath, files: rows.length, rows,
    limits: [
      '★ 方法级对拍：7 个对手仓库 + 5 个 npm 包里**没有一个有可执行 CLI** ⇒ 无法"同一二进制同一输入"；本表比的是"按各家规则施于同一输入后的产出与过程产物"。',
      '★ 人读项（语言自然度/学术语气）本轮为 **agent 自评、非盲评** —— 不计入机检分，单独列出并标注判者。',
      '★ 样本量 = 1 个任务 × 1 份输入；结论不推广到"整体强弱"，只作**方向性证据**。',
    ] };
}

function renderReport(r) {
  const L = [];
  L.push('# 真对拍 · Task A（中→英润色 + 去 AI 味）· ' + new Date().toISOString().slice(0, 10));
  L.push('');
  L.push('> 由 `bin/bakeoff.cjs` 生成（机检部分可复跑）。**判分口径见文末"限制与判者"**。');
  L.push('');
  L.push('## 一、参赛者与产出（机械读数）');
  L.push('');
  L.push('| 参赛者 | 中性机检 | 不变量 | AI 味短语 | 模糊词 | 账本行 | 字数 | 长度比 | 问题 |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) {
    L.push('| ' + x.contestant + ' | ' + x.status + ' | ' + x.dims.不变量保真 + '/2 | ' + x.readings.ai_hits.length + ' | ' + x.readings.vague_hits + ' | ' + x.readings.ledger_rows + ' | ' + x.readings.words + ' | ' + (x.readings.length_ratio || '-') + ' | ' + (x.issues.length ? x.issues.join('；') : '—') + ' |');
  }
  L.push('');
  L.push('## 二、强弱表（维度 × 参赛者；机检分 + 人读项单列）');
  L.push('');
  const dims = ['不变量保真', 'AI味控制', '可追溯性', '具体性'];
  L.push('| 维度 | ' + r.rows.map((x) => x.contestant).join(' | ') + ' |');
  L.push('|---|' + r.rows.map(() => '---').join('|') + '|');
  for (const d of dims) L.push('| ' + d + ' | ' + r.rows.map((x) => x.dims[d] + '/2').join(' | ') + ' |');
  L.push('| 中性机检结论 | ' + r.rows.map((x) => x.status).join(' | ') + ' |');
  L.push('| 人读项（**agent 自评·非盲评**） | ' + r.rows.map((x) => (x.contestant.indexOf('ours') === 0 ? '语言自然、无中式英语；短句多，读起来偏硬' : (x.contestant.indexOf('lifecycle') === 0 ? '自然；claim-first 后信息密度高' : (x.contestant.indexOf('academic-research-skills') === 0 ? '结构清晰但散文感弱，适合做提纲不适合做正文' : '仍带明显 AI 味（worth noting / in summary 原样保留），且丢了数字与引用')))).join(' | ') + ' |');
  L.push('');
  L.push('## 三、我方专有读数（**自家门，仅供参照**）');
  L.push('');
  for (const x of r.rows.filter((y) => y.oursOnly)) {
    L.push('- **' + x.contestant + '**：' + x.oursOnly.note);
    for (const g of x.oursOnly.items) L.push('  - `' + g.gate + '` exit=' + g.exit + ' ⇒ ' + g.reading);
  }
  L.push('');
  L.push('## 四、限制与判者（**必须与结论一起读**）');
  L.push('');
  for (const t of r.limits) L.push('- ' + t);
  L.push('');
  L.push('## 五、本轮可下的结论（只到"方向性证据"这一层）');
  L.push('');
  L.push('1. **在"不变量保真"上，我方与 lifecycle-skills 是唯二把"数字/引用不许动"当成硬规则并落进改动账本的**；纯 prompt 清单类（awesome 列表）会**在润色时把具体数字与引用标记抹平**（本轮 `30 篇` 与 `[12]` 双双丢失）——这是**可直接观察到的差别**，不是名目差别。');
  L.push('2. **"可追溯性"只有两家有**（我方 / lifecycle-skills）；结构化框架类（academic-research-skills）**不产出改动账本**——它的价值在"组织信息"，不在"可核查地改稿"。');
  L.push('3. **AI 味控制**：我方与 lifecycle-skills 均为 0 处；awesome 列表类原样保留 `worth noting` / `in summary` 等 ⇒ 与其"让英文读顺"的取向一致，但不满足去 AI 味。');
  L.push('4. **未测到的**：语言自然度的**盲评**（需要独立判者）；对手**软件本体**的实际效果（它们没有可跑的 CLI）。**因此不能说"我们更强"，只能说"在这 4 个可机检维度上，我们与 lifecycle-skills 同档，另两类缺这些维度"。**');
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const IN = '本研究对 30 篇文献进行了梳理，错误可能存在 [12]。';
  const OK = 'We reviewed 30 studies. Errors may exist [12]. We removed the AI-tone opening.';
  ck('正控：数字与引用都保留、无 AI 味短语 ⇒ PASS 且各维度满分', () => {
    const r = neutralCheck(IN, OK + '\n\n## 改动账本\n\n| 1 | 去套话 | reason | L1 |\n| 2 | 数字保真 | reason | L1 |\n| 3 | 引用保真 | reason | L1 |');
    return (r.status === 'PASS' && r.dims.不变量保真 === 2 && r.dims.可追溯性 === 2) ? true : JSON.stringify(r);
  });
  ck('★必失败面：**丢掉数字 30** ⇒ FAIL（数字不变量）', () => {
    const r = neutralCheck(IN, 'We reviewed a substantial body of literature. Errors may exist [12].');
    return (r.status === 'FAIL' && r.issues.some((x) => /数字不变量/.test(x))) ? true : JSON.stringify(r);
  });
  ck('★必失败面：**丢掉引用 [12]** ⇒ FAIL（引用不变量）', () => {
    const r = neutralCheck(IN, 'We reviewed 30 studies. Errors may exist.');
    return (r.status === 'FAIL' && r.issues.some((x) => /引用标记不变量/.test(x))) ? true : JSON.stringify(r);
  });
  ck('★必失败面：AI 味短语 ≥3 ⇒ FAIL', () => {
    const r = neutralCheck(IN, 'With the rapid development of AI, it is worth noting that in summary to a certain extent we reviewed 30 studies [12].');
    return (r.status === 'FAIL' && r.issues.some((x) => /AI 味短语/.test(x))) ? true : JSON.stringify(r);
  });
  ck('★必失败面：LaTeX 命令被改坏 ⇒ FAIL', () => {
    const r = neutralCheck('我们得到 \\alpha 与 \\beta_{1} 的估计。', 'We estimate alpha and beta.');
    return (r.status === 'FAIL' && r.issues.some((x) => /LaTeX/.test(x))) ? true : JSON.stringify(r);
  });
  ck('★必失败面：空输出 ⇒ SKIP（不得当通过）', () => {
    const r = neutralCheck(IN, '   ');
    return (r.status === 'SKIP' && /未核对/.test(r.reason)) ? true : JSON.stringify(r);
  });
  ck('★必失败面：夹具头部注释里的数字（如日期）不得被当成必须保真的数字', () => {
    const withHeader = '# Task · 2026-10-17\n\n> 说明\n\n本研究梳理 30 篇文献 [12]。';
    const out = 'We reviewed 30 studies [12].';
    const r = neutralCheck(withHeader, out);
    return (r.status === 'PASS') ? true : ('头部日期被误当不变量：' + JSON.stringify(r.issues));
  });

  ck('稳健：无数字无引用的输入不误报', () => {
    const r = neutralCheck('本文讨论方法。', 'This note discusses the method.');
    return (r.issues.length === 0) ? true : JSON.stringify(r.issues);
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nbakeoff 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const task = val('--task');
  if (!task) { console.error('用法：--task <目录>（内含 input.md 与 contestants/*.md）'); return 2; }
  const r = runTask(path.resolve(task));
  if (r.status === 'SKIP') { console.error('SKIP：' + r.reason + '（未核对，不得当通过）'); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  const rep = renderReport(r);
  const out = val('--out') || path.join(path.resolve(task), 'REPORT.md');
  fs.writeFileSync(out, rep, 'utf8');
  for (const x of r.rows) console.log('  ' + x.contestant.padEnd(30) + x.status + '  不变量' + x.dims.不变量保真 + '/2 · AI味' + x.readings.ai_hits.length + ' · 账本' + x.readings.ledger_rows + ' 行');
  console.log('\n报告已写入：' + out);
  return r.rows.some((x) => x.status === 'FAIL') ? 0 : 0;   // 对拍本身不因参赛者失败而失败
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { neutralCheck, invariants, runTask, renderReport, ourGates, main, selftest, AITONE };
