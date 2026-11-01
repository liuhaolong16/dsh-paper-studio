#!/usr/bin/env node
/**
 * bilingual —— 中英双语初稿的术语锁定与一致性门
 *
 * 用法：
 *   node bin/bilingual.cjs --zh <中文稿.md> --en <English.md> --glossary <术语表.json> [--json]
 *   node bin/bilingual.cjs --selftest
 *
 * 术语表格式：[{"zh":"智能体","en":"agent"}, ...] 或 {"terms":[...]}
 * 检查：每个术语在两侧都出现；图表编号/引用标记/数字集合一致；任一缺失 ⇒ FAIL。
 * 边界：只查「锁定术语是否漂移、结构标记是否对齐」，不判定译文质量。
 */
'use strict';
const fs = require('fs');

function loadGlossary(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const arr = Array.isArray(j) ? j : (j.terms || []);
  return arr.filter((t) => t && t.zh && t.en).map((t) => ({ zh: String(t.zh), en: String(t.en) }));
}
function markers(text) {
  const s = String(text);
  const pick = (re, label) => Array.from(s.matchAll(re)).map((m) => label + ' ' + m[1]);
  const figs = pick(/(?:图|figure)\s*(\d+)/gi, 'figure').sort();
  const tables = pick(/(?:表|table)\s*(\d+)/gi, 'table').sort();
  const refs = (s.match(/\[[0-9]+(?:[,\-–][0-9]+)*\]/g) || []).sort();
  const nums = (s.match(/\d+(?:\.\d+)?%?/g) || []).sort();
  const uniq = (a) => Array.from(new Set(a));
  return { figs: uniq(figs.concat(tables)), refs: uniq(refs), nums: uniq(nums) };
}
function run(zh, en, terms) {
  const z = String(zh), e = String(en);
  const rows = terms.map((t) => ({
    zh: t.zh, en: t.en,
    zhOk: z.includes(t.zh), enOk: e.includes(t.en),
  }));
  const missing = rows.filter((r) => !r.zhOk || !r.enOk);
  const mz = markers(z), me = markers(e);
  const diff = (a, b) => a.filter((x) => !b.includes(x));
  const drift = {
    figs: { onlyZh: diff(mz.figs, me.figs), onlyEn: diff(me.figs, mz.figs) },
    refs: { onlyZh: diff(mz.refs, me.refs), onlyEn: diff(me.refs, mz.refs) },
    nums: { onlyZh: diff(mz.nums, me.nums), onlyEn: diff(me.nums, mz.nums) },
  };
  const driftCount = ['figs', 'refs', 'nums'].reduce((n, k) => n + drift[k].onlyZh.length + drift[k].onlyEn.length, 0);
  const status = missing.length || driftCount ? 'FAIL' : 'PASS';
  return { status, terms: rows.length, missing, drift, driftCount };
}
function render(r) {
  const L = ['双语一致性：' + r.status];
  L.push('  术语 ' + r.terms + ' 条 · 缺失 ' + r.missing.length + ' · 结构标记漂移 ' + r.driftCount);
  for (const m of r.missing) L.push('  ✗ 术语未锁定：' + m.zh + ' / ' + m.en + '（中=' + m.zhOk + ' 英=' + m.enOk + '）');
  for (const k of ['figs', 'refs', 'nums']) {
    const d = r.drift[k];
    if (d.onlyZh.length || d.onlyEn.length) L.push('  ✗ ' + k + ' 仅中稿=' + (d.onlyZh.join(',') || '无') + ' · 仅英稿=' + (d.onlyEn.join(',') || '无'));
  }
  L.push('  ⇒ 只查术语与结构标记；译文质量需人工/审稿人复核。');
  return L.join('\n');
}
function selftest() {
  const terms = [{ zh: '智能体', en: 'agent' }, { zh: '工具调用', en: 'tool call' }];
  const zh = '智能体通过工具调用完成任务。图1 给出结果，准确率为 95%。[1]';
  const en = 'The agent completes tasks through tool calls. Figure 1 shows results with 95% accuracy. [1]';
  const r1 = run(zh, en, terms);
  const r2 = run(zh, en.replace('tool calls', 'function invocations'), terms);
  const r3 = run(zh, en.replace('Figure 1', 'Figure 2').replace('[1]', ''), terms);
  const checks = [
    ['正控：术语与标记对齐 ⇒ PASS', r1.status === 'PASS'],
    ['必失败：英文术语漂移 ⇒ FAIL', r2.status === 'FAIL'],
    ['必失败：图表/引用不一致 ⇒ FAIL', r3.status === 'FAIL'],
    ['无术语表 ⇒ PASS（不检查）', run(zh, en, []).status === 'PASS'],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('bilingual selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}
function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const zf = v('--zh'), ef = v('--en'), gf = v('--glossary');
  if (!zf || !ef || !gf || !fs.existsSync(zf) || !fs.existsSync(ef) || !fs.existsSync(gf)) {
    console.error('前提层失败：需要 --zh <中文稿> --en <英文稿> --glossary <术语表.json>');
    return 2;
  }
  const r = run(fs.readFileSync(zf, 'utf8'), fs.readFileSync(ef, 'utf8'), loadGlossary(gf));
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return r.status === 'FAIL' ? 1 : 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { run, render, selftest, loadGlossary, markers };
