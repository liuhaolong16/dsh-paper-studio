#!/usr/bin/env node
/**
 * polish losscheck —— **跨语言丢信息检测器**（中→英/英→中）
 *
 * 起因：三判盲评说我方「丢失数据」，而 `polish rewrite --fidelity` 在我方产出上 **0 处可改**
 * ⇒ 我方弱点**不在机械层面**（AI 味 0、名词化 3.9%），而在**译文本身丢了原文的信息**。
 * 那就必须有一个**对着原文查产出**的检测器，而不是对着产出做美化。
 *
 * 检四类**可核查信息**（不做语义判断，只做出现/缺失）：
 *   1. **数字**：原文的数字记号（含 30、27%、1.5、2020）必须都出现在产出里；
 *   2. **引用标记**：`[12]` / `\cite{…}` 的多重集合必须一致（少一个就是丢引用）；
 *   3. **对冲/限量词**：原文有 `一定程度上/可能/较为/相对/通常/往往/约/部分`，产出必须有**至少同等数量**的英文对冲词
 *      （largely / mostly / generally / relatively / somewhat / may / might / could / approximately / partly / likely）；
 *   4. **专有名词/缩写**：原文的全大写缩写（SOH、NASA、BMS）必须原样出现在产出里。
 *
 * ★ 边界：只查"在不在"，**不查"对不对"**；同义改写（e.g. `a large number of` ↔ `many`）不算丢失。
 * ★ 三态：PASS / WARN（信息可能被弱化）/ FAIL（确有信息缺失）—— **WARN 不等于通过**。
 *
 * 用法：
 *   node bin/polish.cjs losscheck --src <原文> --out <产出> [--json]
 *   node bin/polish.cjs losscheck --selftest
 */
'use strict';

const HEDGE_ZH = /(一定程度上|可能|或许|大约|近似|部分|似乎|倾向于|往往|通常|较为|相对|比较|约)/g;
const HEDGE_EN = /\b(largely|mostly|generally|relatively|somewhat|presumably|possibly|likely|may|might|could|roughly|approximately|about|nearly|partly|partially|arguably|reportedly|tend|tends|often|usually)\b/gi;

const numbersOf = (s) => (String(s).match(/\d+(?:\.\d+)?%?/g) || []);
const citesOf = (s) => {
  const a = String(s).match(/\[\d+(?:[,\-–]\d+)*\]/g) || [];
  const b = String(s).match(/\\cite[a-z]*\{[^}]+\}/g) || [];
  return a.concat(b).map((x) => x.replace(/\s+/g, ''));
};
const acrOf = (s) => Array.from(new Set(String(s).match(/\b[A-Z]{2,6}\b/g) || []));
const hedgesIn = (s, re) => (String(s).match(re) || []).length;

/** ★ 真稿抓出的坑：原文头部有元数据行（`# contestant:` / `<!-- … -->` / 日期行），
    翻译本不该带它们，但按"数字缺失"会被误报 ⇒ 抽取前先剥元数据行。 */
function stripMeta(s) {
  return String(s).split('\n').filter((L) => {
    if (/^\s*#/.test(L)) return false;           // markdown 标题/自曝头
    if (/^\s*<!--/.test(L)) return false;        // HTML 注释
    if (/^\s*(date|source|contestant|task|input)\s*[:：]/i.test(L)) return false;
    if (/^\s*---+\s*$/.test(L)) return false;    // front-matter 分隔线
    return true;
  }).join('\n');
}
function losscheck(srcRaw, outRaw) {
  const src = stripMeta(srcRaw), out = stripMeta(outRaw);
  const problems = [];
  const notes = [];
  /* 1. 数字 */
  const srcN = numbersOf(src), outN = numbersOf(out);
  const outSet = new Set(outN);
  const missingN = srcN.filter((n) => !outSet.has(n));
  if (missingN.length) problems.push({ rule: 'number-missing', detail: '原文的数字在产出里找不到：' + Array.from(new Set(missingN)).join(', ') });
  /* 2. 引用 */
  const srcC = citesOf(src), outC = citesOf(out);
  const outCSet = new Set(outC);
  const missingC = srcC.filter((c) => !outCSet.has(c));
  if (missingC.length) problems.push({ rule: 'citation-missing', detail: '原文的引用标记缺失：' + Array.from(new Set(missingC)).join(' ') });
  /* 3. 对冲词（数量守恒） */
  const hz = hedgesIn(src, HEDGE_ZH), he = hedgesIn(out, HEDGE_EN);
  if (hz > 0 && he < hz) notes.push({ rule: 'hedge-weakened', detail: '原文对冲词 ' + hz + ' 处，产出仅 ' + he + ' 处 ⇒ 不确定性被弱化（这是"改原意"，不是"润色"）' });
  /* 4. 缩写 */
  const srcA = acrOf(src), outUp = String(out).toUpperCase();
  const missingA = srcA.filter((a) => !outUp.includes(a));
  if (missingA.length) problems.push({ rule: 'acronym-missing', detail: '原文缩写缺失：' + missingA.join(', ') });
  if (!srcN.length) notes.push({ rule: 'no-numbers', detail: '原文没有数字 ⇒ 该项未核对（≠ 通过）' });

  const status = problems.length ? 'FAIL' : (notes.some((n) => n.rule === 'hedge-weakened') ? 'WARN' : 'PASS');
  return { status, problems, notes, counts: { numbers: srcN.length, cites: srcC.length, hedgesZh: hz, hedgesEn: he, acronyms: srcA.length } };
}

function render(r) {
  const lines = [];
  lines.push('跨语言丢信息检测：' + r.status + (r.status === 'WARN' ? '（信息可能被弱化 —— WARN **不等于**通过）' : '') + (r.status === 'FAIL' ? '（确有信息缺失）' : ''));
  lines.push('  计数：原文数字 ' + r.counts.numbers + ' · 引用 ' + r.counts.cites + ' · 对冲词 ' + r.counts.hedgesZh + '（产出 ' + r.counts.hedgesEn + '）· 缩写 ' + r.counts.acronyms);
  for (const p of r.problems) lines.push('  ✘ [' + p.rule + '] ' + p.detail);
  for (const n of r.notes) lines.push('  · [' + n.rule + '] ' + n.detail);
  lines.push('  边界：只查"在不在"，不查"对不对"；同义改写不算丢失。');
  return lines.join('\n');
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const src = '我们回顾了30篇文献，发现效率提升较为一致，但在是否引入错误上存在分歧[12]。一定程度上，结果依赖于核查强度。SOH 估计需要更多证据。';

  ck('正控：数字/引用/缩写/对冲词都在 ⇒ PASS', () => {
    const out = 'We reviewed 30 studies and found largely consistent efficiency gains, but disagreement on error introduction [12]. Results relatively depend on checking intensity. SOH estimation needs more evidence.';
    const r = losscheck(src, out);
    return (r.status === 'PASS') ? true : JSON.stringify(r);
  });
  ck('★必失败面：漏掉引用 [12] ⇒ FAIL（citation-missing）', () => {
    const out = 'We reviewed 30 studies. SOH estimation needs more evidence.';
    const r = losscheck(src, out);
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'citation-missing')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：漏掉数字 30 ⇒ FAIL（number-missing）', () => {
    const out = 'We reviewed many studies [12]. SOH needs evidence.';
    const r = losscheck(src, out);
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'number-missing')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：对冲词被删尽 ⇒ **WARN 而不是 PASS**（WARN ≠ 通过）', () => {
    const out = 'We reviewed 30 studies and found consistent gains, with disagreement on errors [12]. Results depend on checking. SOH needs evidence.';
    const r = losscheck(src, out);
    return (r.status === 'WARN' && r.notes.some((n) => n.rule === 'hedge-weakened')) ? true : JSON.stringify(r);
  });
  ck('缩写遗失 ⇒ FAIL（acronym-missing）', () => {
    const out = 'We reviewed 30 studies [12]. State estimation needs evidence.';
    const r = losscheck(src, out);
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'acronym-missing')) ? true : JSON.stringify(r);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nlosscheck 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

module.exports = { losscheck, render, selftest, numbersOf, citesOf, acrOf };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const fs = require('fs');
  const s = v('--src'), o = v('--out');
  if (!s || !o || !fs.existsSync(s) || !fs.existsSync(o)) { console.error('前提层失败：需要 --src <原文> --out <产出>'); process.exit(2); }
  const r = losscheck(fs.readFileSync(s, 'utf8'), fs.readFileSync(o, 'utf8'));
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
