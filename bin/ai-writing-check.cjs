#!/usr/bin/env node
/**
 * ai-writing-check —— 两类“AI 写论文一眼被拒”的硬伤机检
 *
 * 来源：B站《AI写论文，这些问题出现会被一眼拒稿》（BV1oZx762Edu，2026-11-02 蒸馏）
 *   ｜视频要点｜两类致命问题：
 *   1) 防御性废话多：不敢下结论，用天气/常识/重复句把篇幅撑满；
 *   2) 跳跃性写作：论证缺必要推理步骤，直接抛结论。
 *   根因：模型按概率续写，缺少“证据 → 推理 → 结论”的链条。
 *   对策：给足三类可信证据（自己的数据 / 文献数据 / 作者对问题的见解与品味）。
 *
 * 用法：
 *   node bin/ai-writing-check.cjs --file <稿.md|稿.tex> [--json] [--strict]
 *   node bin/ai-writing-check.cjs --selftest
 *
 * 边界：这是启发式机检，不是语义审稿；命中要人工复核，不能替代 reviewer。
 */
'use strict';
const fs = require('fs');

const FILLER = [
  '值得注意的是', '众所周知', '不难发现', '综上所述', '总而言之', '由此可见',
  '需要指出的是', '不得不说', '显而易见', '毋庸置疑', '事实上', '实际上',
  '在一定程度上', '某种意义上', '可以说', '一般来说', '通常情况下',
];
const HEDGES = ['可能', '或许', '也许', '似乎', '大概', '往往', '通常', '基本上', '某种程度上'];
const CONNECTORS = ['因此', '所以', '由此可见', '这表明', '这说明', '证明了', '显然', '可见'];
const ABSOLUTE = ['首次', '前所未有', '显著优于', '大幅提升', '显著提高', '完全证明', '充分证明'];
const EVIDENCE = /(\d+(?:\.\d+)?\s*%?|\[\d+(?:[,\-–]\d+)*\]|图\s*\d+|表\s*\d+|Figure\s*\d+|Table\s*\d+|doi|et al\.?|数据|实验|样本|问卷|访谈|回归|显著[性]?\s*[（(]?p\s*[<>=])/i;

function clean(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\\(?:cite|ref|label|begin|end)\{[^}]*\}/g, ' ')
    .replace(/[#>*_`~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function sentences(text) {
  return clean(text).split(/(?<=[。！？!?；;])\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}
function norm(s) { return s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9%]/g, '').toLowerCase(); }
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}
function analyze(text) {
  const raw = String(text);
  const ss = sentences(raw);
  const body = ss.join('');
  const filler = [];
  for (const w of FILLER) {
    let idx = 0;
    while ((idx = raw.indexOf(w, idx)) >= 0) { filler.push({ word: w, at: idx }); idx += w.length; }
  }
  const hedges = HEDGES.reduce((n, w) => n + (raw.split(w).length - 1), 0);
  const hedgeRate = body.length ? (hedges * 1000) / body.length : 0;

  const jumps = [];
  ss.forEach((s, i) => {
    const prev = i > 0 ? ss[i - 1] : '';
    const hasConnector = CONNECTORS.some((w) => s.includes(w));
    const hasAbsolute = ABSOLUTE.some((w) => s.includes(w));
    const evidence = EVIDENCE.test(s) || EVIDENCE.test(prev);
    if ((hasConnector || hasAbsolute) && !evidence) {
      jumps.push({ sentence: s, reason: hasAbsolute ? '绝对化/强结论无证据' : '因果连接无证据' });
    }
  });

  const redundant = [];
  for (let i = 1; i < ss.length; i += 1) {
    const a = norm(ss[i - 1]); const b = norm(ss[i]);
    if (a.length >= 12 && b.length >= 12 && (a.includes(b) || b.includes(a) || jaccard(a, b) > 0.78)) {
      redundant.push({ a: ss[i - 1], b: ss[i], score: +jaccard(a, b).toFixed(2) });
    }
  }

  /* 三种防御性写作（BV1Anxq6yE53）：
     ① 先扬后抑：先夸再“但/然而/并不意味着”，把成果又否定一部分；
     ② 限定堆叠：一句结论叠两个以上“可能/或许/一定程度上”；
     ③ 扩大局限：把没做过、不归自己管的都塞进“局限”，一条变五条。 */
  const defensive = { praiseThenNegate: [], hedgeStack: [], expandedLimits: [] };
  ss.forEach((s) => {
    if (/(虽然|尽管|诚然|不可否认)/.test(s) && /(但|然而|不过|并不意味着|不能说明|仍有)/.test(s)) {
      defensive.praiseThenNegate.push(s);
    }
    const hs = HEDGES.filter((w) => s.includes(w));
    if (hs.length >= 2) defensive.hedgeStack.push({ sentence: s, hedges: hs });
  });
  const lim = raw.match(/(?:局限|不足|局限性|Limitations?)[^\n]{0,20}\n?([\s\S]{0,2000})/i);
  if (lim) {
    const clauses = lim[1].split(/[。；;\n]+/).map((x) => x.trim()).filter((x) => x.length > 5);
    const items = clauses.filter((x) => /(未|不|无法|缺乏|仅|尚未)/.test(x));
    if (items.length > 3) defensive.expandedLimits = items;
  }
  const dCount = defensive.praiseThenNegate.length + defensive.hedgeStack.length
    + (defensive.expandedLimits.length > 3 ? 1 : 0);

  const status = (jumps.length >= 2 || filler.length + redundant.length >= 5 || hedgeRate > 12 || dCount >= 3)
    ? 'FAIL' : ((jumps.length || filler.length || redundant.length || hedgeRate > 6 || dCount) ? 'WARN' : 'PASS');
  return { status, sentences: ss.length, chars: body.length, filler, hedges, hedgeRate: +hedgeRate.toFixed(1), jumps, redundant, defensive, defensiveCount: dCount };
}
function render(r) {
  const L = ['AI 写作两类硬伤机检：' + r.status];
  L.push('  句数 ' + r.sentences + ' · 字数 ' + r.chars + ' · 模糊限定 ' + r.hedges + '（' + r.hedgeRate + '/千字）');
  if (r.filler.length) {
    L.push('  ✗ 防御性废话 ' + r.filler.length + ' 处：' + r.filler.slice(0, 6).map((x) => x.word).join('、'));
  }
  if (r.redundant.length) {
    L.push('  ✗ 重复/同义扩写 ' + r.redundant.length + ' 处：');
    for (const x of r.redundant.slice(0, 3)) L.push('    · ' + x.a.slice(0, 40) + ' ⇄ ' + x.b.slice(0, 40) + '（' + x.score + '）');
  }
  if (r.jumps.length) {
    L.push('  ✗ 跳跃性结论 ' + r.jumps.length + ' 处：');
    for (const x of r.jumps.slice(0, 5)) L.push('    · [' + x.reason + '] ' + x.sentence.slice(0, 80));
  }
  if (r.defensive) {
    const d = r.defensive;
    if (d.praiseThenNegate.length) L.push('  ✗ 先扬后抑 ' + d.praiseThenNegate.length + ' 处（先夸再“但/并不意味着”）：' + d.praiseThenNegate[0].slice(0, 60));
    if (d.hedgeStack.length) L.push('  ✗ 限定堆叠 ' + d.hedgeStack.length + ' 处：' + d.hedgeStack[0].sentence.slice(0, 60));
    if (d.expandedLimits.length > 3) L.push('  ✗ 扩大局限 ' + d.expandedLimits.length + ' 条（把没做过/不归你管的都算局限）');
  }
  L.push('  ⇒ 三类防御性写作：先扬后抑 / 限定堆叠 / 扩大局限。');
  L.push('  ⇒ 两类硬伤：废话太多（不敢下结论）/ 推理跳跃（缺必要步骤）。');
  L.push('  ⇒ 修法：补“自己的数据 / 文献数据 / 作者见解”三类证据；或人工识别后重写。');
  L.push('  ⇒ 这是启发式机检，命中需人工复核，不能替代语义审稿。');
  return L.join('\n');
}
function selftest() {
  const cleanText = '实验组准确率为 95%[1]。因此，该方法在本数据集上优于基线。';
  const fillerText = '值得注意的是，天气变冷了，人要多穿衣服。众所周知，天冷就要多穿衣服。综上所述，这很重要。事实上，这确实很重要。';
  const jumpText = '该方法具有显著优势。因此，它适用于所有场景。由此可见，这是最佳方案。';
  const cleanNoConnector = '表 2 给出 3 组消融结果，去掉记忆模块后准确率下降 4.2 个百分点。';
  const hedgeText = '该方法可能或许在一定程度上有效。';
  const limitText = '## 局限\n本研究未考虑 A 场景；本研究未考虑 B 场景；无法覆盖 C 场景；不适用于 D 场景；仅覆盖 E 场景；缺乏 F 场景。';
  const checks = [
    ['正控：有证据的“因此”不报跳跃', analyze(cleanText).jumps.length === 0],
    ['必失败：防御性废话被抓', analyze(fillerText).filler.length >= 2],
    ['必失败：无证据强结论被抓', analyze(jumpText).jumps.length >= 2],
    ['正控：纯数据句不误报', analyze(cleanNoConnector).status !== 'FAIL'],
    ['必失败：限定堆叠被抓', analyze(hedgeText).defensive.hedgeStack.length >= 1],
    ['必失败：扩大局限被抓', analyze(limitText).defensive.expandedLimits.length > 3],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('ai-writing-check selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}
function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const f = v('--file');
  if (!f) { console.error('前提层失败：需要 --file <稿>'); return 2; }
  if (!fs.existsSync(f)) { console.error('读不到文件：' + f); return 2; }
  const r = analyze(fs.readFileSync(f, 'utf8'));
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return r.status === 'PASS' ? 0 : 1;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyze, render, selftest };
