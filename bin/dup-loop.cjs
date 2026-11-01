#!/usr/bin/env node
/**
 * dup-loop —— 降重闭环：改前 → 改后 → 重合率是否真的下降 + 关键数字/图表/引用是否还在
 *
 * 用法：
 *   node bin/dup-loop.cjs --before <旧版.md> --after <新版.md> --corpus <已发表作品目录> [--n 12] [--min-drop 1] [--json]
 *   node bin/dup-loop.cjs --selftest
 *
 * 边界：plagself 是**字面重合估计**，不是任何查重系统读数；语料库只含给定目录 ⇒ 低估是必然的。
 * 本工具只回答「这次改写有没有让重合下降、有没有把数字/图表/引用改丢」，不保证外部查重通过。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('./plagself.cjs');

function corpusTexts(dir) {
  return P.readCorpus(dir).map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));
}
function sig(text) {
  const nums = (String(text).match(/\d+(?:\.\d+)?%?/g) || []);
  const figs = (String(text).match(/(?:图|表|Figure|Table)\s*\d+/gi) || []).map((s) => s.replace(/\s+/g, ' ').toLowerCase());
  const refs = (String(text).match(/\[[0-9]+(?:[,\-–][0-9]+)*\]/g) || []);
  return { nums: Array.from(new Set(nums)), figs: Array.from(new Set(figs)), refs: Array.from(new Set(refs)) };
}
function missing(before, after) {
  const b = sig(before), a = sig(after);
  const miss = (x, y) => x.filter((v) => !y.includes(v));
  return { nums: miss(b.nums, a.nums), figs: miss(b.figs, a.figs), refs: miss(b.refs, a.refs) };
}
function run(beforeText, afterText, corpus, opt) {
  const o = opt || {};
  const before = P.check(beforeText, corpus, { n: o.n });
  const after = P.check(afterText, corpus, { n: o.n });
  const delta = (after.ratio || 0) - (before.ratio || 0);
  const minDrop = Number(o.minDrop == null ? 1 : o.minDrop);
  const loss = missing(beforeText, afterText);
  const lost = loss.nums.length + loss.figs.length + loss.refs.length;
  let status = 'PASS';
  if (before.status === 'SKIP' || after.status === 'SKIP') status = 'SKIP';
  else if (after.rawStatus === 'FAIL' || delta > 0) status = 'FAIL';
  else if (after.rawStatus === 'WARN') status = 'WARN';
  else if (delta > -minDrop) status = 'WARN';
  if (lost && status === 'PASS') status = 'WARN';
  return { status, before, after, delta: Math.round(delta * 10) / 10, minDrop, loss, lost, n: before.n };
}
function render(r) {
  const L = [];
  L.push('降重闭环：' + r.status);
  L.push('  改前 ' + (r.before.status === 'SKIP' ? 'SKIP' : r.before.ratio + '%（' + r.before.overlapped + '/' + r.before.tokens + '）'));
  L.push('  改后 ' + (r.after.status === 'SKIP' ? 'SKIP' : r.after.ratio + '%（' + r.after.overlapped + '/' + r.after.tokens + '）'));
  L.push('  变化 ' + (r.delta > 0 ? '+' : '') + r.delta + ' 个百分点（要求至少下降 ' + r.minDrop + '）');
  if (r.lost) {
    L.push('  ⚠ 改写后丢失：数字 ' + (r.loss.nums.join(',') || '无') + ' · 图表 ' + (r.loss.figs.join(',') || '无') + ' · 引用 ' + (r.loss.refs.join(',') || '无'));
  } else {
    L.push('  ✓ 数字/图表/引用标记未发现丢失');
  }
  L.push('  ⇒ 这是字面重合估计，不是查重系统读数；语料只含给定目录，低估是必然的。');
  if (r.status === 'FAIL') L.push('  ⇒ 改后更差：先停下，别继续"降重"；检查是否引入新的照抄段。');
  return L.join('\n');
}
function selftest() {
  const os = require('os');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'duploop-'));
  const corpusDir = path.join(d, 'corpus'); fs.mkdirSync(corpusDir);
  const base = '人工智能代理系统在复杂任务中需要稳定的记忆机制与可验证的工具调用链。本文提出一种分层记忆结构，并在三个基准上验证其有效性。如图1所示，准确率为95%。[1]';
  fs.writeFileSync(path.join(corpusDir, 'old.md'), base, 'utf8');
  const before = base; // 100%
  const after = '针对复杂任务，我们设计了一种分层记忆架构，并配合外部工具检索与结果校验。图1 给出任务完成率；在三个基准上，准确率达到95%。[1]';
  const r1 = run(before, after, [{ file: 'old.md', text: base }], { n: 8, minDrop: 1 });
  const r2 = run(before, before, [{ file: 'old.md', text: base }], { n: 8, minDrop: 1 });
  const r3 = run(before, after.replace('图1', '').replace('[1]', ''), [{ file: 'old.md', text: base }], { n: 8, minDrop: 1 });
  const checks = [
    ['正控：改写后重合下降 ⇒ PASS', r1.status === 'PASS'],
    ['必失败：改后与改前同文 ⇒ FAIL', r2.status === 'FAIL'],
    ['数字丢失 ⇒ 至少 WARN', r3.lost > 0 ? (r3.status === 'WARN' || r3.status === 'FAIL') : false],
    ['SKIP 不被当通过', run('', after, [{ file: 'old.md', text: base }], { n: 8 }).status === 'SKIP'],
  ];
  let ok = 0;
  for (const [name, pass] of checks) { console.log((pass ? 'PASS ' : 'FAIL ') + name); if (pass) ok += 1; }
  fs.rmSync(d, { recursive: true, force: true });
  console.log('dup-loop selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}
function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const bf = v('--before'), af = v('--after'), dir = v('--corpus');
  if (!bf || !af || !fs.existsSync(bf) || !fs.existsSync(af) || !fs.existsSync(dir)) {
    console.error('前提层失败：需要 --before <旧版> --after <新版> --corpus <已发表作品目录>');
    return 2;
  }
  const r = run(fs.readFileSync(bf, 'utf8'), fs.readFileSync(af, 'utf8'), corpusTexts(dir), { n: v('--n'), minDrop: v('--min-drop') });
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return r.status === 'FAIL' ? 1 : 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { run, render, selftest, sig, missing };
