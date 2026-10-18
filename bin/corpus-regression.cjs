#!/usr/bin/env node
/**
 * corpus-regression —— **真实语料回归**：把「判据在真实论文上会报什么」固化成基线，改判据后自动比对。
 *
 * 为什么需要它（2026-10-18 的教训）：
 *   `number-consistency` 新增「三套值并存」后，用 11 份真实论文原文回扫，**11/11 全 FAIL**。
 *   自检 19/19 全绿、audit 6/6 全绿，**一条都没看出来** —— 因为自检只覆盖我们自己造的夹具，
 *   而六个误报族全来自 PDF 文本的真实形态（页码、年份、编号被拆、文献卷期页、会议届次、动词带单位）。
 *   ⇒ 光有夹具不够，必须有**真实语料基线**：改判据后跑一遍，若结果与基线偏离就报警。
 *
 * 判据：
 *   1. 对语料目录下每个 `*.txt` 跑若干门（默认 number-consistency + abstract-strength），
 *      记录 `status` 与 `issue codes`。
 *   2. 与基线比对：
 *      · **恶化**（PASS/SKIP → WARN/REVIEW/FAIL，或 FAIL 的 code 集合变大）⇒ 报红，退出码 1
 *      · **改善**（FAIL/REVIEW → PASS/SKIP）⇒ 只提示，要求人确认后 `--update` 刷基线
 *      · 无变化 ⇒ 绿
 *   3. 基线里没有的新文件 ⇒ 记为 NEW（提示，不判红）；基线里有但目录里没有 ⇒ 记为 MISSING（提示）。
 *
 * 诚实边界：**基线记录的是"当时的行为"，不是"正确的行为"**。刷基线必须人确认是改善，不能因为报红就刷。
 *
 * 用法：
 *   node bin/corpus-regression.cjs [--corpus <目录>] [--baseline <json>] [--update] [--json]
 *   node bin/corpus-regression.cjs --selftest
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = 'v1.0.0';
const BIN = __dirname;
const DEFAULT_CORPUS = 'D:/deep seek工作区1/paper-gene/corpus';
const DEFAULT_BASELINE = path.join(BIN, '..', 'references', 'corpus-baseline.json');

/** 参与回归的门（顺序即输出顺序）。 */
const GATES = [
  { id: 'number-consistency', file: 'number-consistency.cjs' },
  { id: 'abstract-strength', file: 'abstract-strength.cjs' },
];

const SEVERITY = { SKIP: 0, PASS: 0, OK: 0, WARN: 1, REVIEW: 2, FAIL: 3 };

function runGate(gateFile, draft) {
  const r = spawnSync(process.execPath, [path.join(BIN, gateFile), '--draft', draft, '--json'], { encoding: 'utf8' });
  const out = String(r.stdout || '');
  try {
    const j = JSON.parse(out);
    const codes = [...new Set((j.issues || []).map((i) => i.code))].sort();
    return { status: j.status, codes };
  } catch (e) {
    // 工具崩了也要如实记：不能把"跑不起来"记成"没问题"
    return { status: 'CRASH', codes: [`PARSE_FAIL:${(r.stderr || '').split('\n')[0].slice(0, 60)}`] };
  }
}

function snapshot(corpus) {
  const files = fs.readdirSync(corpus, { recursive: true })
    .filter((f) => String(f).toLowerCase().endsWith('.txt'))
    .map((f) => path.join(corpus, String(f)))
    .sort();
  const snap = {};
  for (const f of files) {
    const key = path.basename(f);
    snap[key] = {};
    for (const g of GATES) snap[key][g.id] = runGate(g.file, f);
  }
  return snap;
}

/** 纯比对：返回 { worse: [], better: [], same: [], added: [], missing: [] } */
function compare(cur, base) {
  const res = { worse: [], better: [], same: [], added: [], missing: [] };
  for (const name of Object.keys(cur)) {
    if (!base[name]) { res.added.push(name); continue; }
    for (const g of GATES) {
      const c = cur[name][g.id] || {};
      const b = base[name][g.id] || {};
      const cs = String(c.status || '');
      const bs = String(b.status || '');
      const cSev = SEVERITY[cs] == null ? 3 : SEVERITY[cs];
      const bSev = SEVERITY[bs] == null ? 3 : SEVERITY[bs];
      const newCodes = (c.codes || []).filter((x) => !(b.codes || []).includes(x));
      if (cSev > bSev || (cSev === bSev && newCodes.length)) {
        res.worse.push({ file: name, gate: g.id, base: bs, cur: cs, newCodes });
      } else if (cSev < bSev) {
        res.better.push({ file: name, gate: g.id, base: bs, cur: cs });
      } else {
        res.same.push({ file: name, gate: g.id, status: cs });
      }
    }
  }
  for (const name of Object.keys(base)) if (!cur[name]) res.missing.push(name);
  return res;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const corpus = v('--corpus', DEFAULT_CORPUS);
  const baselinePath = v('--baseline', DEFAULT_BASELINE);
  if (!fs.existsSync(corpus)) {
    console.error(`语料目录不存在：${corpus}`);
    return 2;
  }
  const cur = snapshot(corpus);

  if (argv.includes('--update')) {
    fs.writeFileSync(baselinePath, JSON.stringify({ version: VERSION, corpus, at: new Date().toISOString(), snapshot: cur }, null, 1) + '\n', 'utf8');
    console.log(`基线已写入 ${baselinePath}（${Object.keys(cur).length} 份 × ${GATES.length} 门）`);
    return 0;
  }

  if (!fs.existsSync(baselinePath)) {
    console.error(`没有基线：${baselinePath}\n先跑一次 --update 生成基线（并在报告里写明这是"当时行为"）`);
    return 2;
  }
  const baseFile = JSON.parse(fs.readFileSync(baselinePath, 'utf8').replace(/^\uFEFF/, ''));
  const res = compare(cur, baseFile.snapshot);

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ corpus, baseline: baselinePath, ...res }, null, 2));
    return res.worse.length ? 1 : 0;
  }

  console.log(`corpus-regression ${VERSION} —— 真实语料回归（${Object.keys(cur).length} 份 × ${GATES.length} 门）`);
  console.log(`语料：${corpus}`);
  console.log(`基线：${baselinePath}（${baseFile.at || '未记时间'}）`);
  console.log(`\n判定：${res.worse.length ? '**退步**' : '无退步'} · 退步 ${res.worse.length} · 改善 ${res.better.length} · 未变 ${res.same.length} · 新增 ${res.added.length} · 缺失 ${res.missing.length}`);
  for (const w of res.worse) console.log(`  ✘ ${w.file} [${w.gate}] ${w.base} → ${w.cur}${w.newCodes.length ? ' 新代码 ' + w.newCodes.join(',') : ''}`);
  for (const b of res.better) console.log(`  ↑ ${b.file} [${b.gate}] ${b.base} → ${b.cur}（改善：需人确认后 --update）`);
  for (const a of res.added) console.log(`  + 新文件未在基线：${a}`);
  for (const m of res.missing) console.log(`  - 基线里有、语料里没有：${m}`);
  console.log('\n边界：基线记录的是**当时的行为**，不是"正确行为"。出现退步先查判据，不要直接 --update 把红刷绿。');
  return res.worse.length ? 1 : 0;
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-reg-'));
  const corpus = path.join(tmp, 'corpus');
  fs.mkdirSync(corpus);
  const mk = (n, body) => fs.writeFileSync(path.join(corpus, n), body, 'utf8');

  // 三份夹具：一份会 PASS（单值）、一份 SKIP（无重复）、一份含三套值（会 FAIL）
  mk('ok.txt', '# Abstract\nAUCPR 0.23 is reported.\n\n## 1 Intro\nBody.\n');
  mk('three.txt', '# Abstract\nR² 0.874 best.\n\n## 6.1\nR² 0.860 near.\n\n| 指标 | 值 |\n|---|---|\n| R² | 0.812 |\n');
  mk('empty.txt', '# Abstract\nNo numbers here.\n\n## 1 Intro\nNothing.\n');

  const snap = snapshot(corpus);

  // 1) 用自身快照做基线 ⇒ 必须无退步
  const res1 = compare(snap, JSON.parse(JSON.stringify(snap)));
  const ok1 = res1.worse.length === 0;

  // 2) 人为把基线里三分值那格改成 PASS（模拟"判据曾经更宽松"）⇒ 现在必须判退步
  const weak = JSON.parse(JSON.stringify(snap));
  weak['three.txt']['number-consistency'] = { status: 'PASS', codes: [] };
  const res2 = compare(snap, weak);
  const ok2 = res2.worse.length === 1 && res2.worse[0].file === 'three.txt';

  // 3) 人为把基线里某格改成 FAIL（模拟"判据曾经更严"）⇒ 现在应判改善
  const strict = JSON.parse(JSON.stringify(snap));
  strict['ok.txt']['number-consistency'] = { status: 'FAIL', codes: ['UNRECONCILED'] };
  const res3 = compare(snap, strict);
  const ok3 = res3.better.length === 1;

  // 4) 新文件与缺失
  const res4 = compare({ ...snap, 'new.txt': snap['ok.txt'] }, snap);
  const ok4 = res4.added.length === 1;
  const { ['empty.txt']: _, ...withoutEmpty } = snap;
  const res5 = compare(withoutEmpty, snap);
  const ok5 = res5.missing.length === 1;

  const cases = [
    ['同快照 ⇒ 无退步', ok1],
    ['基线曾更宽松 ⇒ 判退步（必失败臂）', ok2],
    ['基线曾更严格 ⇒ 判改善', ok3],
    ['新文件 ⇒ 记 added', ok4],
    ['文件消失 ⇒ 记 missing', ok5],
  ];
  let pass = 0;
  for (const [name, ok] of cases) {
    // 严格 === true：用真值判断会把失败读成通过
    if (ok === true) { pass++; console.log(`  ✔ ${name}`); } else { console.log(`  ✘ ${name}`); }
  }
  console.log(`\ncorpus-regression 自检：${pass}/${cases.length} 通过`);
  process.exit(pass === cases.length ? 0 : 1);
}

process.exit(main(process.argv.slice(2)));
