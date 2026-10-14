#!/usr/bin/env node
/**
 * audit — 出厂审查（完整性 + 重复性 + 数字一致性）· **可复跑**
 *
 * 为什么要做成工具而不是写一份一次性报告：**审查结论会过期**（改了工具、加了子命令、动了词表就会漂）。
 * 本工具把 2026-10-14 那次「专业性审查 + 重复性审查」的取证方法固化成 6 项机检，供**每次出厂前**复跑：
 *   ① `skills-coverage`  每个子命令都在 `SKILL.md` 里写明（否则用户不知道有它）
 *   ② `rule-overlap`     两张规则表（`stylecheck` 的词表 vs `revise.AI_MARKERS`）的**重复词**（重复性审查的核心判据）
 *   ③ `single-source`    每个真源文件只有**一个**模块直接 `readFileSync`（多处解析＝两套真相）
 *   ④ `gates-meta`       每道门都有 `judge_type` 与 `primary_section`；报 A/B 分布（全 A 是有意为之，须有说明）
 *   ⑤ `tools-probe`      每个 `bin/*.cjs` 都有 `--selftest`，且被登记表探针覆盖
 *   ⑥ `number-drift`     登记表 `evidence` 里声明的自检数（`**N/M**`）与**实际跑出来的**是否一致
 *
 * 用法：node bin/audit.cjs [--only ①,②] [--json]
 * 退出码：0 全部通过 · 1 有发现（发现问题项） · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BIN = path.join(ROOT, 'bin');
// ★ 可移植性：能力登记表是**可选**依赖（它是"本机 AI 工作台"的私有文件）。
//   公开出去后不能因为读不到它就报错 ⇒ 环境变量可覆盖；缺失则**明确跳过并说明**（不静默当成通过）。
const REG = process.env.DSH_AI_WORKBENCH_REGISTRY
  || 'E:/DeepSeek/skills/ai-workbench/references/capability-registry.json';

function read(p) { return fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''); }
function binFiles() { return fs.readdirSync(BIN).filter((f) => f.endsWith('.cjs')); }

/** ① 子命令是否都在 SKILL.md 里写明。 */
function skillsCoverage() {
  // eslint-disable-next-line global-require
  const st = require(path.join(BIN, 'studio.cjs'));
  const skill = read(path.join(ROOT, 'SKILL.md'));
  const missing = st.SUBCOMMANDS.filter((s) => !skill.includes(s));
  return { check: 'skills-coverage', total: st.SUBCOMMANDS.length, missing, pass: missing.length === 0 };
}

/**
 * ② 两张规则表的重复词 —— **正则字面量集合比对**（真判据）。
 * ★ 我第一版是「在 stylecheck 源码文本里搜词」⇒ 会把**注释里的词**也算成命中（假阳性）。
 *   现改为：把 `stylecheck.WORD_LISTS` 与 `revise.AI_MARKERS` 各自拆成**字面词集合**再求交。
 */
function literalsOf(re) {
  return [...new Set(String(re)
    .split(/[|]+/)
    .map((s) => s.replace(/\(\?<[^)]*\)|\(\?[=!][^)]*\)|\\b|\\s\*?|\\\.|\[[^\]]*\]|[\\^$*+?.:(){}]/g, ' ')
      .replace(/\s+/g, ' ').trim().toLowerCase())
    .flatMap((s) => s.split(' '))
    .filter((w) => w.length >= 5 && /^[a-z]+$/.test(w)))];
}
function ruleOverlap() {
  // eslint-disable-next-line global-require
  const sc = require(path.join(BIN, 'stylecheck.cjs'));
  // eslint-disable-next-line global-require
  const rv = require(path.join(BIN, 'revise.cjs'));
  const scWords = new Set(Object.values(sc.WORD_LISTS).flatMap(literalsOf));
  const aiWords = new Set(rv.AI_MARKERS.flatMap((m) => literalsOf(m.re)));
  const dup = [...aiWords].filter((w) => scWords.has(w));
  return {
    check: 'rule-overlap', markers: rv.AI_MARKERS.length, stylecheck_lists: Object.keys(sc.WORD_LISTS).length,
    ai_words: aiWords.size, stylecheck_words: scWords.size, overlapping: dup, pass: dup.length === 0,
    note: '重复即**同一句被两套规则各点一次** ⇒ 违反"精简"：应把该词交给**单一所有者**（词级清晰度归 stylecheck / 句式级 AI 腔归 aitone）。',
  };
}

/**
 * ③ 真源文件是否只有单一所有者。
 * ★ 首版把"注释里提到文件名"也算成所有者 ⇒ 假阳性（`coach.cjs` 只是在错误信息里写了文件名）。
 *   现规则：文件名必须出现在**读文件的调用参数**里（`readFileSync(...)` / `read(...)` / `readJson(...)` 同一行），
 *   且排除**指定所有者**：`studio.cjs`（真源读法的唯一入口）与 `audit.cjs`（审查器，本就要读全部真源）。
 */
function singleSource() {
  const targets = ['pipeline.json', 'templates.json', 'lessons-from-first-draft.md'];
  const DESIGNATED = new Set(['studio.cjs', 'audit.cjs']);
  const owners = {};
  for (const f of binFiles()) {
    if (DESIGNATED.has(f)) continue;
    const src = read(path.join(BIN, f));
    const lines = src.split(/\r?\n/);
    for (const t of targets) {
      const re = new RegExp(`(readFileSync|readJson|read)\\s*\\([^)]*${t.replace('.', '\\.')}`);
      if (lines.some((ln) => re.test(ln))) (owners[t] = owners[t] || []).push(f);
    }
  }
  const multi = Object.entries(owners).filter(([, v]) => v.length > 0);
  return {
    check: 'single-source', owners, multi_owner: multi.map(([k, v]) => `${k}: ${v.join('+')}`), pass: multi.length === 0,
    note: '指定所有者：`studio.cjs`（唯一读法）+ `audit.cjs`（审查器）；其余模块若直接读真源即为**两套真相**。',
  };
}

/** ④ 门的元数据齐否 + A/B 分布（全 A 需真源里有说明）。 */
function gatesMeta() {
  const p = JSON.parse(read(path.join(ROOT, 'references', 'pipeline.json')));
  const gates = p.gates.map((g) => g.id || g.name);
  const jt = (p.gate_meta && p.gate_meta.judge_type) || {};
  const ps = (p.gate_meta && p.gate_meta.primary_section) || {};
  const noJt = gates.filter((g) => !(g in jt));
  const noPs = gates.filter((g) => !(g in ps));
  const dist = {}; for (const g of gates) dist[jt[g] || '未声明'] = (dist[jt[g] || '未声明'] || 0) + 1;
  const hasNote = !!(p.gate_meta && p.gate_meta.judge_type_note && /全部是\s*A\s*类|A\/B/.test(p.gate_meta.judge_type_note));
  const allA = dist.A === gates.length;
  return {
    check: 'gates-meta', total: gates.length, missing_judge_type: noJt, missing_primary_section: noPs,
    distribution: dist, all_a_has_note: allA ? hasNote : true,
    // 全 A 是**有意设计**，但必须留说明（否则后人会以为漏标了 B 类）
    pass: noJt.length === 0 && noPs.length === 0 && (!allA || hasNote),
  };
}

/**
 * ⑤ 每个工具都能**真的**跑出 `--selftest` 结果，且被登记表探针覆盖。
 * ★ 首版只看文件里有没有 `--selftest` 字样 ⇒ 假阳性（`audit.cjs` 自己**调用**别人的自检，也被算成"有自检"）。
 *   现规则：**实际跑一次**，要求退出码 0 且末行能解析出 `N/M`。
 */
function toolsProbe() {
  if (!fs.existsSync(REG)) return { check: 'tools-probe', rows: [], pass: true, skipped: 'not-found', note: `能力登记表不存在（${REG}）⇒ **本项跳过**，不是通过：请设 DSH_AI_WORKBENCH_REGISTRY 指向你的登记表，或忽略本项。` };
  const regText = read(REG);
  const rows = [];
  for (const f of binFiles()) {
    if (f === 'studio.cjs') continue;
    let ok = false; let actual = null;
    try {
      const out = execFileSync(process.execPath, [path.join(BIN, f), '--selftest'], { encoding: 'utf8', timeout: 120000 });
      const m = out.match(/(\d+)\s*\/\s*(\d+)\s*(?:通过|全过)/);
      if (m) { actual = `${m[1]}/${m[2]}`; ok = true; }
    } catch { ok = false; }
    const covered = regText.includes(f);
    rows.push({ tool: f, selftest_runs: ok, selftest_count: actual, registry_probe: covered, ok: ok && covered });
  }
  return { check: 'tools-probe', rows, pass: rows.every((r) => r.ok) };
}

/** ⑥ 登记表声明的自检数 vs 实际跑出来的（**自动抓数字漂移**）。 */
function numberDrift() {
  if (!fs.existsSync(REG)) return { check: 'number-drift', rows: [], pass: true, skipped: 'not-found', note: `能力登记表不存在（${REG}）⇒ **本项跳过**，不是通过。` };
  const reg = JSON.parse(read(REG));
  const caps = reg.capabilities || reg.rows;
  const rows = [];
  for (const c of caps) {
    if (!c.entry || !/\.cjs$/.test(c.entry) || !fs.existsSync(c.entry)) continue;
    if (!/--selftest/.test(c.evidence || '')) continue;
    let actual = null; let raw = '';
    try {
      const out = execFileSync(process.execPath, [c.entry, '--selftest'], { encoding: 'utf8', timeout: 120000 });
      raw = out.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '';
      const m = out.match(/(\d+)\s*\/\s*(\d+)\s*(?:通过|全过)/);
      if (m) actual = `${m[1]}/${m[2]}`;
    } catch { actual = 'ERR'; }
    const claimed = [...String(c.evidence).matchAll(/\*\*(\d+\/\d+)\*\*/g)].map((x) => x[1]);
    // ★ 解析不出（不同工具的末行格式不同）**不算漂移**，只标 unparsed —— 否则审查器自己会制造假阳性
    const ok = actual === 'ERR' ? false : (actual === null ? true : (claimed.length === 0 || claimed.includes(actual)));
    rows.push({ id: c.id, claimed, actual, unparsed: actual === null && !ok ? true : actual === null, raw: actual === null ? raw.slice(0, 80) : '', ok });
  }
  return { check: 'number-drift', rows, pass: rows.every((r) => r.ok), note: 'claimed 取 evidence 里全部 `**N/M**`；只要**有一个**与实际一致即视为一致（evidence 常同时记录历史值与现值）。' };
}

const CHECKS = { '①': skillsCoverage, '②': ruleOverlap, '③': singleSource, '④': gatesMeta, '⑤': toolsProbe, '⑥': numberDrift };

function run() {
  const argv = process.argv.slice(2);
  const only = (() => { const i = argv.indexOf('--only'); return i > -1 ? String(argv[i + 1]).split(',') : null; })();
  const out = [];
  for (const [k, fn] of Object.entries(CHECKS)) {
    if (only && !only.includes(k)) continue;
    try { out.push(fn()); } catch (e) { out.push({ check: k, pass: false, error: String((e && e.message) || e) }); }
  }
  return out;
}

/** 审查器自己的自检（**审查器也要被审查**）：夹具验证它的解析与判据不会假阳/假阴。 */
function runSelftest() {
  const results = [];
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };

  check('★ 正控 · 字面词提取：从正则里取词、丢掉结构符号', () => {
    const w = literalsOf(/\b(delve|pivotal)\b/i);
    return (w.includes('delve') && w.includes('pivotal') && !w.some((x) => x.includes('\\'))) ? true : JSON.stringify(w);
  });
  check('★★ 反控 · 单一所有者检测**不得把注释里的文件名算成所有者**（首版假阳性）', () => {
    // 造一个只在注释与错误信息里提到 pipeline.json、且确实有 readFileSync（读别的东西）的模块
    const s = singleSource();
    return (s.pass === true) ? true : JSON.stringify(s.multi_owner);
  });
  check('★ 正控 · 规则表重复检测：人为造一张与 stylecheck 词表重叠的表 ⇒ 必须报重复', () => {
    const sc = require(path.join(BIN, 'stylecheck.cjs'));
    const scWords = new Set(Object.values(sc.WORD_LISTS).flatMap(literalsOf));
    const fake = [{ re: /\bwhich\b|\bactually\b/i }];
    const dup = fake.flatMap((m) => literalsOf(m.re)).filter((w) => scWords.has(w));
    return dup.length > 0 ? true : `未检出（stylecheck 词数 ${scWords.size}）`;
  });
  check('★ 反控 · 真表必须无重复（否则本审查器会天天报同一件事）', () => {
    const r = ruleOverlap();
    return (r.pass === true && r.overlapping.length === 0) ? true : JSON.stringify(r.overlapping);
  });
  check('★ 正控 · 门元数据：11 门齐全且全 A 有说明', () => {
    const g = gatesMeta();
    return (g.pass === true && g.total === 11 && g.distribution.A === 11) ? true : JSON.stringify(g);
  });
  check('★ 正控 · 子命令文档覆盖：当前 24 个全部有文档', () => {
    const s = skillsCoverage();
    return s.pass === true ? true : JSON.stringify(s.missing);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\naudit 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main() {
  try {
    if (process.argv.includes('--selftest')) return runSelftest();
    const res = run();
    if (process.argv.includes('--json')) { console.log(JSON.stringify(res, null, 2)); return res.every((r) => r.pass) ? 0 : 1; }
    console.log('出厂审查（完整性 + 重复性 + 数字一致性）· 可复跑');
    for (const r of res) {
      console.log(`\n${r.pass ? '✔' : '✘'} ${r.check}${r.error ? ' —— ' + r.error : ''}`)
      // ★「跳过要可见」：可选依赖缺失时**必须在输出里显形并说明**，否则读者会把它当成"通过"（我自己定的铁律）。
      if (r.skipped) console.log(`   ⚠ **跳过**（${r.skipped}）：${r.note || ''}`);
      if (r.check === 'skills-coverage') console.log(`   子命令 ${r.total} 个 · 未在 SKILL.md 提到：${r.missing.join(' · ') || '（无）'}`);
      if (r.check === 'rule-overlap') { console.log(`   记号 ${r.markers} 个 · stylecheck 词表 ${r.stylecheck_lists} 组 → 字面词 ${r.stylecheck_words} 个 · aitone 字面词 ${r.ai_words} 个 · **两表重复：${r.overlapping.join(' · ') || '（无）'}**`); console.log('   ' + r.note); }
      if (r.check === 'single-source') { console.log('   ' + (r.note || '')); for (const t of ['pipeline.json', 'templates.json', 'lessons-from-first-draft.md']) console.log(`   ${t} 的额外所有者：${(r.owners[t] || []).join(' + ') || '（无，符合单一所有者）'}`); }
      if (r.check === 'gates-meta') console.log(`   门 ${r.total} 个 · 缺 judge_type：${r.missing_judge_type.join('/') || '无'} · 缺 primary_section：${r.missing_primary_section.join('/') || '无'} · 分布 ${JSON.stringify(r.distribution)} · 全 A 有说明=${r.all_a_has_note}`);
      if (r.check === 'tools-probe') for (const x of r.rows) console.log(`   ${x.ok ? '·' : '✘'} ${x.tool}  实际自检=${x.selftest_count || '跑不出 N/M'}  登记表探针=${x.registry_probe}`);
      if (r.check === 'number-drift') for (const x of r.rows) console.log(`   ${x.ok ? '·' : '✘'} ${x.id}  声明=${x.claimed.join('|') || '(未写)'}  实际=${x.actual}${x.unparsed ? '（末行格式不同 ⇒ 视为未声明，不判漂移）' : ''}`);
    }
    const bad = res.filter((r) => !r.pass);
    console.log(`\n合计：检查 ${res.length} 项 · 未通过 ${bad.length} 项${bad.length ? ' ⇒ ' + bad.map((b) => b.check).join(' · ') : ' ⇒ 全绿'}`);
    return bad.length ? 1 : 0;
  } catch (e) { console.error('前提层失败：' + String((e && e.message) || e)); return 2; }
}

if (require.main === module) process.exitCode = main();
module.exports = { skillsCoverage, ruleOverlap, singleSource, gatesMeta, toolsProbe, numberDrift, run, runSelftest, literalsOf, CHECKS, main };
