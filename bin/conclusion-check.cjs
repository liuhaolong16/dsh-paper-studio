#!/usr/bin/env node
/**
 * conclusion-check —— SCI 结论“五句话”结构机检
 *
 * 来源：B站《今天组会讲 SCI 的结论怎么写？大家看他学会了吗？》
 *   BV1kVxg6eEhU，1:10；2026-11-02 蒸馏。
 *   视频五句话：
 *   1) 重申研究问题 + 直接给主要结论/判断（不要重复结果数字）；
 *   2) 说明这个结论意味着什么（数字说明了什么，把研究放回领域）；
 *   3) 与别人的结论是什么关系（支持/补充/修正/不一致；不一致要解释为什么）；
 *   4) 交代局限（哪些条件没覆盖、哪些问题还回答不了）；
 *   5) 下一步往哪走（若引言已写，不要重复）。
 *
 * 用法：
 *   node bin/conclusion-check.cjs --file <稿.md|稿.tex> [--json]
 *   node bin/conclusion-check.cjs --selftest
 *
 * 边界：启发式结构检查，不判断科学结论对错；命中项需人工复核。
 */
'use strict';
const fs = require('fs');

function section(raw, names) {
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('(?:^|\\n)(?:#{1,6}\\s*|\\\\section\\*?\\{)\\s*(?:' + esc + ')\\s*\\}?\\s*\\n([\\s\\S]*?)(?=\\n(?:#{1,6}\\s|\\\\section)|$)', 'i');
  const m = raw.match(re);
  return m ? m[1].trim() : '';
}
function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}
function norm(s) { return s.replace(/[^\u4e00-\u9fa5a-zA-Z0-9%]/g, '').toLowerCase(); }
function analyze(raw) {
  const text = String(raw);
  const conclusion = section(text, ['结论', '结语', 'Conclusions?', 'Conclusion']);
  const abstract = section(text, ['摘要', 'Abstract']);
  const body = conclusion || '';
  const moves = {
    question: /(研究问题|本文|本研究|我们|旨在|目标|question|aim|objective)/i.test(body)
      && /(结论|表明|发现|显示|证明|conclude|find|show)/i.test(body),
    meaning: /(意味着|说明了什么|解释|启示|意义|implication|suggest|indicat)/i.test(body)
      && !/^结果表明/.test(body.trim()),
    relation: /(一致|支持|补充|修正|不同|差异|矛盾|相比|compared|consistent|support|extend|refine|challenge|contrary|unlike|previous|prior)/i.test(body),
    limitation: /(局限|不足|限制|未覆盖|尚未|不能|无法|limitation|limitations)/i.test(body),
    future: /(下一步|未来|后续|进一步|展望|future work|next step|further research)/i.test(body),
  };
  const missing = Object.entries(moves).filter(([, v]) => !v).map(([k]) => k);
  const numbers = (body.match(/\b\d+(?:\.\d+)?\s*%?/g) || []).length;
  const sim = (conclusion && abstract) ? jaccard(norm(conclusion), norm(abstract)) : 0;
  const flags = [];
  if (!conclusion) flags.push('未找到“结论/Conclusion”章节');
  if (missing.length) flags.push('缺 ' + missing.join('、'));
  if (numbers > 8) flags.push('结论里数字过多（' + numbers + ' 个），像在重复结果');
  if (sim > 0.65) flags.push('结论与摘要重合度过高（' + sim.toFixed(2) + '），像摘要复读');
  const status = (!conclusion || missing.length >= 2) ? 'FAIL' : ((missing.length || numbers > 8 || sim > 0.65) ? 'WARN' : 'PASS');
  return { status, hasConclusion: !!conclusion, moves, missing, numbers, abstractSimilarity: +sim.toFixed(2), flags };
}
function render(r) {
  const L = ['SCI 结论五句话机检：' + r.status];
  const names = { question: '1 重申问题+判断', meaning: '2 说明意味着什么', relation: '3 与别人结论的关系', limitation: '4 局限', future: '5 下一步' };
  for (const [k, v] of Object.entries(r.moves)) L.push('  ' + (v ? '✓' : '✗') + ' ' + names[k]);
  if (r.flags.length) L.push('  待处理：' + r.flags.join('；'));
  L.push('  ⇒ 视频结构：问题+判断 → 意味着什么 → 与别人关系 → 局限 → 下一步。');
  L.push('  ⇒ 结论不是摘要：不要重复结果数字；不一致要解释原因；引言写过的下一步不要重复。');
  L.push('  ⇒ 启发式结构检查，不判断科学结论对错；命中需人工复核。');
  return L.join('\n');
}
function selftest() {
  const good = `# 摘要\n本文研究 X 对 Y 的影响，发现显著正相关。\n# 结论\n本文研究 X 对 Y 的影响，结论是 X 显著提升 Y。这一结果意味着 X 是 Y 的关键驱动因素，把研究放回领域看，它支持了 A 的发现并补充了 B 的机制。本研究未覆盖 C 条件，尚不能回答 D 问题。下一步应进一步检验 E。`;
  const missing = `# 结论\n本文研究 X，结论是 X 有效。`;
  const copy = `# 摘要\n本文研究 X 对 Y 的影响，发现显著正相关，样本 100 例，p<0.05。\n# 结论\n本文研究 X 对 Y 的影响，发现显著正相关，样本 100 例，p<0.05。`;
  const numbers = `# 结论\n本文研究 X，结论是 X 有效。结果分别为 1、2、3、4、5、6、7、8、9。`;
  const checks = [
    ['正控：五句话齐全 ⇒ PASS', analyze(good).status === 'PASS'],
    ['必失败：缺关系/局限/下一步 ⇒ FAIL', analyze(missing).status === 'FAIL'],
    ['必失败：结论复读摘要被抓', analyze(copy).abstractSimilarity > 0.65],
    ['必失败：结论堆数字被抓', analyze(numbers).numbers > 8],
    ['必失败：无结论章节被抓', analyze('# 引言\n只有引言。').status === 'FAIL'],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('conclusion-check selftest: ' + ok + '/' + checks.length + ' 通过');
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
