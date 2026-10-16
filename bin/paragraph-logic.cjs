#!/usr/bin/env node
/**
 * paragraph-logic —— **段落级逻辑的启发式弱机检**（用户缺口表：段落级逻辑检查「只有软规则，实质要模型，不算机检」）。
 *
 * ★ 诚实边界（**回执里必须打印，且状态名不叫 PASS**）：
 *   本工具**只看表层标记**——论点句在不在段首、段内有没有支撑信号（数字/引用/图表引用/因果词/数据词）、
 *   段落长度带、相邻段是否共词。它**不判断论证是否成立**（那是人读项）。
 *   因此：机器可判项全过时状态为 **`OK`（≠ 段落逻辑没问题）**；只有软提示时为 **`REVIEW`（须人读）**；
 *   无段落可判 ⇒ **`SKIP`（未检查 ≠ 通过）**。
 *
 * 规则（每条都标"硬/软"，硬的才让状态变 `ISSUES`）：
 *   H1 段过长（>6 句或 >220 词）⇒ 建议拆分
 *   H2 段首是**断言**（claim 标记）但**全段无支撑信号** ⇒ 提示补证据或降调
 *   S1 段首是纯过渡词且不足 6 词 ⇒ 疑无论点句
 *   S2 全段只有支撑、无论点句 ⇒ 只堆证据
 *   S3 相邻两段**零共词**（无共同实词）⇒ 疑跳跃（**最弱的一条，仅 INFO**）
 *
 * 用法：
 *   node bin/paragraph-logic.cjs --draft <稿.md> [--json] [--max-sent 6] [--max-words 220]
 *   node bin/paragraph-logic.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CLAIM = /(we (?:show|find|demonstrate|propose|argue|conclude|observe|hypothesi[sz]e)|this (?:paper|study|review|analysis) (?:shows|argues|proposes|finds|demonstrates)|therefore|thus|hence|these (?:results|findings) (?:show|suggest|indicate)|本文|本研究|我们认为|因此|综上|表明|说明)/i;
const SUPPORT = [
  { re: /\d/, why: '数字' },
  { re: /\[\s*\d+(?:\s*[-,–]\s*\d+)*\s*\]|\\(?:cite|ref)\b/, why: '引用标记' },
  { re: /(?:\bFig(?:ure)?\.?|\bTable\b|\bEq\.?|图\s*\d|表\s*\d|式\s*\d)/i, why: '图表/公式引用' },
  { re: /(because|since|due to|as a result|owing to|which suggests|consistent with|因为|由于|据此|与.{0,6}一致)/i, why: '因果/推理连接' },
  { re: /(dataset|sample|cohort|n\s*=\s*\d|accuracy|precision|recall|p\s*[<=]\s*0?\.\d|r\s*=\s*0?\.\d|数据集|样本量|准确率)/i, why: '数据词' },
];
const PURE_TRANSITION = /^(moreover|furthermore|in addition|besides|however|nevertheless|therefore|thus|overall|in summary|to sum up|next|finally|其次|此外|然而|因此|总之|另外)[,，:：]?\s*$/i;
const STOP = new Set('the a an and or of to in on for with by as at from that this these those is are was were be been it its their our we they i you he she them his her not no but if then than also such can may might should could would will shall do does did have has had there here which who whom whose what when where why how all any both each few more most other some only own same so too very s t just don now'.split(' '));

const words = (s) => (String(s || '').match(/[\u4e00-\u9fa5]|[A-Za-z][A-Za-z'\-]*/g) || []);
const sentences = (p) => String(p || '').split(/(?<=[.。!？!?])\s+/).map((x) => x.trim()).filter(Boolean);
const contentTokens = (p) => new Set(words(p).map((w) => w.toLowerCase()).filter((w) => w.length >= 4 && !STOP.has(w)));

/** 非散文节：这些节不是"段落"，一律不判（**如实报出跳过了几节几段**） */
const NON_PROSE = /(references|bibliograph|acknowledg|declaration|funding|author contributions|conflict|data availability|appendix|supplementar|参考文献|致谢|声明|附录|资助)/i;

/** 切段（含所属节）；**非散文节与过短的行走噪声行不入判**，跳过量挂在返回数组的 `.skipped` 上 */
function paragraphs(text) {
  const out = [];
  let section = '(题前)';
  let buf = [];
  const skippedSections = new Set();
  let skippedShort = 0;
  let inNonProse = false;
  const push = () => {
    const p = buf.join('\n').trim();
    buf = [];
    if (!p || /^#{1,6}\s/.test(p) || /^\|/.test(p) || /^!\[/.test(p)) return;
    if (inNonProse) { skippedSections.add(section); return; }
    if (words(p).length < 4) { skippedShort += 1; return; }   /* 作者行/日期/单token 行属噪声 */
    out.push({ section, text: p });
  };
  for (const line of String(text || '').split('\n')) {
    const h = /^\s*#{1,6}\s*(.+?)\s*$/.exec(line);
    if (h) { push(); section = h[1]; inNonProse = NON_PROSE.test(section); continue; }
    if (!line.trim()) { push(); continue; }
    buf.push(line);
  }
  push();
  out.skipped = { sections: Array.from(skippedSections), paragraphs: skippedSections.size ? undefined : 0, shortLines: skippedShort };
  return out;
}

function analyse(text, opts) {
  const o = opts || {};
  const maxSent = Number(o.maxSent) || 6, maxWords = Number(o.maxWords) || 220;
  const paras = paragraphs(text);
  if (!paras.length) return { status: 'SKIP', why: '没有可判段落（空稿或全是表格/图片行）⇒ 未检查' };
  const items = paras.map((p, i) => {
    const sents = sentences(p.text);
    const w = words(p.text).length;
    const first = sents[0] || '';
    const supHits = [];
    for (const s of SUPPORT) if (s.re.test(p.text)) supHits.push(s.why);
    const claim = CLAIM.test(p.text);
    const firstClaim = CLAIM.test(first);
    const hard = [], soft = [];
    if (sents.length > maxSent || w > maxWords) hard.push({ rule: 'H1', msg: '段过长（' + sents.length + ' 句 / ' + w + ' 词，带 ' + maxSent + ' 句 / ' + maxWords + ' 词）⇒ 建议拆分' });
    if (firstClaim && !supHits.length) hard.push({ rule: 'H2', msg: '段首断言但全段无支撑信号（无数字/引用/图表引用/因果/数据词）⇒ 补证据或降调' });
    if (PURE_TRANSITION.test(first.trim()) && words(first).length < 6) soft.push({ rule: 'S1', msg: '段首疑为纯过渡词，缺论点句：' + first.slice(0, 40) });
    if (!claim && supHits.length >= 2 && sents.length >= 2) soft.push({ rule: 'S2', msg: '全段只有支撑（' + supHits.join('/') + '）而无论点句 ⇒ 建议补一句论点' });
    return { idx: i + 1, section: p.section, sentences: sents.length, words: w, claim, firstClaim, support: supHits, hard, soft, first: first.slice(0, 60) };
  });
  for (let i = 1; i < items.length; i++) {
    if (items[i].section !== items[i - 1].section) continue;
    const a = contentTokens(paras[i - 1].text), b = contentTokens(paras[i].text);
    if (!a.size || !b.size) continue;
    let shared = 0;
    for (const x of a) if (b.has(x)) shared += 1;
    if (shared === 0) items[i].soft.push({ rule: 'S3', msg: '与上一段**零共词** ⇒ 疑跳跃（最弱判据，仅提示）' });
  }
  const hardCount = items.reduce((n, x) => n + x.hard.length, 0);
  const softCount = items.reduce((n, x) => n + x.soft.length, 0);
  return {
    status: hardCount ? 'ISSUES' : (softCount ? 'REVIEW' : 'OK'),
    counts: { paragraphs: items.length, hard: hardCount, soft: softCount, overlong: items.filter((x) => x.hard.some((h) => h.rule === 'H1')).length, unsupported: items.filter((x) => x.hard.some((h) => h.rule === 'H2')).length, skippedShort: paras.skipped ? paras.skipped.shortLines : 0 },
    skippedSections: paras.skipped ? paras.skipped.sections : [],
    items,
    boundary: '**这是启发式弱机检，不是"段落逻辑合规"**：只看表层标记（论点句位置 / 段内有无支撑信号 / 段长 / 相邻段共词），**不判断论证是否成立**。'
      + '状态 `OK` 只表示"没有触发本工具的表层规则"，**不等于段落逻辑没问题**；`REVIEW` 表示有软提示须人读；`SKIP` 表示没有可判段落。人读项：论证有效性、段落间推理链、是否存在逻辑谬误。'
      + (paras.skipped && paras.skipped.sections.length ? '（**已跳过非散文节 ' + paras.skipped.sections.length + ' 个**：' + paras.skipped.sections.slice(0, 3).join(' / ') + ' —— 参考文献/致谢/声明等不是段落，不判）' : ''),
  };
}

function render(r) {
  const L = [];
  L.push('# 段落级逻辑 · 启发式弱机检');
  L.push('');
  L.push('状态：**' + r.status + '**（段 ' + r.counts.paragraphs + ' · 硬提示 ' + r.counts.hard + ' · 软提示 ' + r.counts.soft + ' · 过长 ' + r.counts.overlong + ' · 断言无支撑 ' + r.counts.unsupported + '）');
  L.push('');
  L.push('| # | 节 | 句 | 词 | 断言 | 支撑信号 | 硬 | 软 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of r.items) {
    L.push('| ' + x.idx + ' | ' + x.section.slice(0, 26) + ' | ' + x.sentences + ' | ' + x.words + ' | ' + (x.claim ? '有' : '—') + ' | ' + (x.support.join('/') || '—') + ' | ' + x.hard.length + ' | ' + x.soft.length + ' |');
  }
  L.push('');
  for (const x of r.items) {
    for (const h of x.hard) L.push('- ✘ [' + h.rule + '] 第 ' + x.idx + ' 段（' + x.section + '）：' + h.msg);
    for (const s of x.soft) L.push('- · [' + s.rule + '] 第 ' + x.idx + ' 段：' + s.msg);
  }
  L.push('');
  L.push('> ' + r.boundary);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };

  ck('正控：论点句 + 支撑（数字/引用）⇒ OK，零提示', () => {
    const t = '# Results\nWe show that the dual protocol improves accuracy by 4.2 points, reaching 0.973 on 30 cells [12].\n';
    const r = analyse(t);
    return (r.status === 'OK' && r.counts.hard === 0 && r.counts.soft === 0) ? true : JSON.stringify({ s: r.status, h: r.counts.hard, so: r.counts.soft });
  });

  ck('★必失败面 H2：段首断言但全段无支撑信号 ⇒ ISSUES', () => {
    const t = '# Discussion\nWe demonstrate that the proposed taxonomy is superior to all previous attempts and should be adopted widely.\n';
    const r = analyse(t);
    return (r.status === 'ISSUES' && r.items[0].hard.some((h) => h.rule === 'H2')) ? true : JSON.stringify(r.items[0]);
  });

  ck('★必失败面 H1：段过长 ⇒ ISSUES（>6 句）', () => {
    const t = '# Intro\n' + ('This is a sentence about the problem. '.repeat(8)) + '\n';
    const r = analyse(t);
    return (r.status === 'ISSUES' && r.items[0].hard.some((h) => h.rule === 'H1')) ? true : JSON.stringify(r.items[0]);
  });

  ck('★必失败面：**空稿/只有表格行 ⇒ SKIP**（未检查 ≠ 通过）', () => {
    const a = analyse('   '), b = analyse('| a | b |\n| - | - |\n');
    return (a.status === 'SKIP' && b.status === 'SKIP') ? true : JSON.stringify([a.status, b.status]);
  });

  ck('软提示 S2：全段只有支撑、无论点句 ⇒ REVIEW（不是 ISSUES）', () => {
    /* 夹具按判据条件设计：S2 要求 ≥2 句 */
    const t = '# Background\nPrior work reported 0.91 accuracy on 12 datasets [3]. The same protocol reached 0.88 on 8 datasets [4].\n';
    const r = analyse(t);
    return (r.status === 'REVIEW' && r.items[0].soft.some((s) => s.rule === 'S2')) ? true : JSON.stringify(r.items[0]);
  });

  ck('软提示 S3：相邻段零共词 ⇒ REVIEW；反面对照（有共词）不报', () => {
    const a = analyse('# X\nThe dual protocol improves accuracy on the battery dataset considerably.\n\nMeasured capacitance values indicate gradual degradation across every cycling condition examined.\n');
    if (!a.items[1] || !a.items[1].soft.some((s) => s.rule === 'S3')) return '未报 S3：' + JSON.stringify(a.items.map((x) => x.soft));
    const b = analyse('# X\nThe dual protocol improves accuracy on the battery dataset considerably.\n\nThe battery dataset was split chronologically to avoid leakage between the training conditions.\n');
    return (b.items[1] && !b.items[1].soft.some((s) => s.rule === 'S3')) ? true : '反面对照误报：' + JSON.stringify(b.items[1] && b.items[1].soft);
  });

  ck('阈值可覆盖：--max-sent 2 会让 4 句段变 H1', () => {
    const t = '# P\nAlpha beta gamma delta. Alpha beta gamma delta. Alpha beta gamma delta. Alpha beta gamma delta.\n';
    const a = analyse(t), b = analyse(t, { maxSent: 2 });
    return (a.status === 'OK' && b.status === 'ISSUES') ? true : JSON.stringify([a.status, b.status]);
  });

  ck('v3.15.0·真稿抓出：**参考文献节不得当段落判**（不得出现"段过长建议拆分"），且要报出跳过了哪些节', () => {
    const t = '# Introduction\nWe show that the proposed taxonomy explains the observed failures across all three layers [1].\n\n# References\n' + ('Author, A. A very long citation entry with many words inside it. Journal, 12(3), 45-67. '.repeat(40)) + '\n';
    const r = analyse(t);
    if (r.status === 'ISSUES' && r.items.some((x) => /References/.test(x.section))) return '参考文献被当段落判：' + JSON.stringify(r.items.filter((x) => /References/.test(x.section)));
    if (!r.skippedSections.some((s) => /References/.test(s))) return '未报出跳过节：' + JSON.stringify(r.skippedSections);
    return true;
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nparagraph-logic 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const d = val('--draft');
  if (!d) { console.error('前提层失败：需要 --draft <稿.md>'); return 2; }
  const p = path.resolve(d);
  if (!fs.existsSync(p)) { console.error('前提层失败：稿件不存在 —— ' + p); return 2; }
  const r = analyse(fs.readFileSync(p, 'utf8'), { maxSent: val('--max-sent'), maxWords: val('--max-words') });
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why + '（未检查 ≠ 通过）'); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'ISSUES' ? 1 : 0; }
  const out = val('--out'); const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('报告已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('状态：' + r.status + '（段 ' + r.counts.paragraphs + ' · 硬 ' + r.counts.hard + ' · 软 ' + r.counts.soft + '）—— **OK ≠ 逻辑没问题，本工具只判表层**');
  return r.status === 'ISSUES' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyse, render, paragraphs, sentences, contentTokens, main, selftest };
