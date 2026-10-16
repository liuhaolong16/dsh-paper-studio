#!/usr/bin/env node
/**
 * fit-pages —— **页数预算机检与削减方案**（用户缺口表：fit-page-limit「要么没做，要么没机检」）。
 *
 * 与对手 `lifecycle-skills/skills/fit-page-limit` 的关系（A 路径）：其 SKILL 的 guardrail 吸收为**硬规则**——
 *   **绝不为凑页数删证据**（结果、数字、图表引用、引用标记一律**受保护**）。代码自写。
 *
 * 判据（可辩护的窄口径）：
 *   · 逐节词数 → 页数估算：`页 = 词数 / --density + 图数 × 图页 + 表数 × 表页`（**估算口径必须打印，可用参数覆盖**）；
 *   · 超限 ⇒ 报超出页数，并给**削减候选**（按"可删性"排序）：移入附录 / 压缩措辞 / 删并高度重复段；
 *   · **受保护内容（含数字、引用标记、图表引用、结论性断言的段落）绝不列入"删除"候选**，只允许"压缩措辞（保数字与引用）"；
 *   · 未超限 ⇒ 报剩余空间，并给**可选补强位**（不硬凑）；
 *   · 缺 `--limit` ⇒ 前提层失败（没有预算就谈不上"超"）；空稿 ⇒ SKIP。**估算口径与启发式一律如实标注。**
 *
 * 用法：
 *   node bin/fit-pages.cjs --draft <稿.md> --limit <页数> [--density 500] [--fig 0.35] [--table 0.3] [--json]
 *   node bin/fit-pages.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CUTTABLE = [                       /* 节标题关键词 → 可删性档（3 最高） */
  { re: /(references|bibliograph|参考文献|引用文献)/i, score: 0, kind: 'refs', why: '参考文献：**只可收紧样式/缩写刊名，不得删条目**（引用即证据）' },
  { re: /(related work|background|literature review|extended|prior work|相关工作|研究背景|文献综述)/i, score: 3, why: '背景/相关工作：可压可移附录' },
  { re: /(introduction|引言|前言)/i, score: 2, why: '引言：可压（保研究缺口与贡献句）' },
  { re: /(method|methodolog|approach|材料与方法|方法)/i, score: 1, why: '方法：可压不可删（可移细节入附录）' },
  { re: /(result|finding|结果)/i, score: 0, why: '结果：**证据**，只能压缩措辞' },
  { re: /(discussion|limitation|结论|conclusion)/i, score: 0, why: '讨论/结论：**断言**，只能压缩措辞' },
];
const PROTECT = [                        /* 受保护信号：命中即不得列为"删除"候选 */
  { re: /\d/, why: '含数字' },
  { re: /\[\d+(?:\s*[-,–]\s*\d+)*\]/, why: '含引用标记' },
  { re: /\\(?:cite|ref)\b/, why: '含 LaTeX 引用' },
  { re: /(?:\bFig(?:ure)?\.?|\bTable\b|\b表\s*\d|\b图\s*\d)/i, why: '含图表引用' },
  { re: /(we (?:show|find|demonstrate|propose|conclude)|本(?:文|研究)(?:表明|发现|提出)|因此|综上)/i, why: '含结论性断言' },
];
const FILLER = [                         /* 冗余措辞信号（压缩候选的依据词） */
  { re: /(it is (?:important|worth) (?:to )?not(?:e|ing)|值得注意的是)/i, why: '套话开头' },
  { re: /(in order to|为了|从而|进而)/i, why: '冗词连接' },
  { re: /(a (?:large|growing) (?:number|body) of|越来越多的)/i, why: '模糊量词' },
  { re: /(as (?:we )?(?:can )?see (?:from|in)|由.{0,6}可见)/i, why: '冗余指引' },
];

const words = (s) => (String(s || '').match(/[\u4e00-\u9fa5]|[A-Za-z][A-Za-z'\-]*/g) || []).length;

/** 切节（含前言段归到「(题前)」） */
function sections(text) {
  const out = [];
  let cur = { title: '(题前)', body: [] };
  for (const line of String(text || '').split('\n')) {
    const h = /^\s*#{1,6}\s*(.+?)\s*$/.exec(line);
    if (h) { out.push(cur); cur = { title: h[1], body: [] }; continue; }
    cur.body.push(line);
  }
  out.push(cur);
  return out.filter((s) => s.body.join('\n').trim() || s.title !== '(题前)');
}

function paragraphs(body) {
  return body.join('\n').split(/\n\s*\n+/).map((p) => p.trim()).filter((p) => p && !/^\|/.test(p) && !/^!\[/.test(p));
}

const ngramOverlap = (a, b) => {
  const tok = (s) => new Set((String(s).toLowerCase().match(/[a-z\u4e00-\u9fa5]{3,}/g) || []));
  const A = tok(a), B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return Math.round((inter / Math.min(A.size, B.size)) * 100) / 100;
};

function analyse(text, opts) {
  const o = opts || {};
  const density = Number(o.density) || 500;
  const figPage = o.figPage === undefined ? 0.35 : Number(o.figPage);
  const tablePage = o.tablePage === undefined ? 0.3 : Number(o.tablePage);
  const limit = Number(o.limit);
  if (!(limit > 0)) return { status: 'SKIP', why: '缺 --limit（没有页数预算就无法判"超没超"）' };
  const src = String(text || '');
  if (!src.trim()) return { status: 'SKIP', why: '稿子为空 ⇒ 未核算' };
  const figs = (src.match(/!\[[^\]]*\]\(/g) || []).length + (src.match(/^\s*(?:\*\*)?(?:Fig(?:ure)?)\.?\s*\d+/gim) || []).length;
  const tables = (src.match(/^\s*\|.*\|\s*$/gm) || []).length ? (src.match(/^\s*(?:\*\*)?(?:Table)\s*\d+/gim) || []).length || Math.ceil((src.match(/^\s*\|.*\|\s*$/gm) || []).length / 4) : 0;
  const secs = sections(src).map((s) => {
    const paras = paragraphs(s.body);
    const w = words(s.body.join('\n'));
    const cls = CUTTABLE.find((c) => c.re.test(s.title)) || { score: 1, kind: 'other', why: '未归类（按中性处理）' };
    const protectedParas = paras.filter((p) => PROTECT.some((r) => r.re.test(p)));
    const fillerHits = [];
    for (const p of paras) for (const f of FILLER) if (f.re.test(p)) fillerHits.push({ why: f.why, sample: p.slice(0, 60) });
    const dup = [];
    for (let i = 0; i < paras.length; i++) for (let j = i + 1; j < paras.length; j++) {
      const ov = ngramOverlap(paras[i], paras[j]);
      if (ov >= 0.5) dup.push({ a: i + 1, b: j + 1, overlap: ov, sample: paras[i].slice(0, 50) });
    }
    return { title: s.title, words: w, paras: paras.length, pages: Math.round((w / density) * 100) / 100, cutScore: cls.score, cutKind: cls.kind, cutWhy: cls.why, protected: protectedParas.length, filler: fillerHits, dup };
  });
  const wordPages = secs.reduce((a, s) => a + s.words, 0) / density;
  const figPages = figs * figPage, tablePages = tables * tablePage;
  const used = Math.round((wordPages + figPages + tablePages) * 100) / 100;
  const over = Math.round((used - limit) * 100) / 100;
  const plan = [];
  if (over > 0) {
    const ranked = secs.slice().sort((a, b) => (b.cutScore - a.cutScore) || (b.words - a.words));
    for (const s of ranked) {
      if (s.words < 60) continue;
      if (s.cutKind === 'refs') {
        plan.push({ kind: '收紧参考文献样式（缩写刊名 / 单行距；**不删条目**）', section: s.title, save: Math.round((s.words * 0.15 / density) * 100) / 100, why: s.cutWhy });
        continue;
      }
      if (s.cutScore >= 2) plan.push({ kind: '移入附录 / 大幅压缩', section: s.title, save: Math.round((s.words * 0.5 / density) * 100) / 100, why: s.cutWhy + '（省约一半篇幅）' });
      else if (s.cutScore === 1) plan.push({ kind: '压缩措辞（保数字与引用）', section: s.title, save: Math.round((s.words * 0.25 / density) * 100) / 100, why: s.cutWhy + '（省约四分之一）' });
      else plan.push({ kind: '**只压缩措辞，不得删内容**', section: s.title, save: Math.round((s.words * 0.12 / density) * 100) / 100, why: s.cutWhy + '（受保护内容：数字/引用/图表引用）' });
      if (s.dup.length) plan.push({ kind: '删并重复段', section: s.title, save: Math.round((s.dup[0].overlap * s.words * 0.2 / density) * 100) / 100, why: '第 ' + s.dup[0].a + ' 与 ' + s.dup[0].b + ' 段重合度 ' + s.dup[0].overlap });
    }
    if (figs > 0) plan.push({ kind: '图缩排 / 并板', section: '(全稿)', save: Math.round((figs * figPage * 0.3) * 100) / 100, why: '图 ' + figs + ' 张，单栏并排或缩排可省约 30% 图占版面' });
  } else {
    for (const s of secs.slice().sort((a, b) => (a.cutScore - b.cutScore) || (a.words - b.words))) {
      if (s.cutScore <= 1 && s.words > 0) plan.push({ kind: '可选补强（不硬凑）', section: s.title, save: 0, why: '剩余 ' + Math.abs(over) + ' 页：优先补证据强度（结果细节/局限讨论），而非铺陈背景' });
      if (plan.length >= 3) break;
    }
  }
  /* ③ 只保留可省 ≥0.15 页的动作（低阈值动作噪声大，且不如"移附录"有效）；被省略的数量如实报出 */
  const before = plan.length;
  const kept = plan.filter((x) => (x.save || 0) >= 0.15 || /补强/.test(x.kind));
  const planOmitted = before - kept.length;
  const totalSave = Math.round(kept.reduce((a, x) => a + (x.save || 0), 0) * 100) / 100;
  plan.length = 0; for (const x of kept) plan.push(x);
  return {
    status: over > 0 ? 'FAIL' : 'PASS', limit, used, over,
    breakdown: { words: secs.reduce((a, s) => a + s.words, 0), wordPages: Math.round(wordPages * 100) / 100, figs, figPages: Math.round(figPages * 100) / 100, tables, tablePages: Math.round(tablePages * 100) / 100 },
    density, figPage, tablePage, sections: secs, plan, totalSave, planOmitted,
    note: '页数 = 词数/' + density + ' + 图×' + figPage + ' + 表×' + tablePage + '（**估算口径**，与真实排版有差；可用 --density/--fig/--table 覆盖）。削减候选的"可删性"是**启发式**，且受保护段落（含数字/引用/图表引用/结论断言）**只允许压缩措辞、不得删除**。人读项：哪一段真的可删仍由作者判断。',
  };
}

function render(r) {
  const L = [];
  L.push('# 页数预算核算 · ' + (r.status === 'FAIL' ? '**超出 ' + r.over + ' 页**' : '**剩余 ' + (-r.over) + ' 页**'));
  L.push('');
  L.push('| 项 | 值 |'); L.push('|---|---|');
  L.push('| 页数上限 | ' + r.limit + ' |');
  L.push('| 估算用量 | **' + r.used + '** |');
  L.push('| 词数 / 词页 | ' + r.breakdown.words + ' / ' + r.breakdown.wordPages + ' |');
  L.push('| 图数 / 图页 | ' + r.breakdown.figs + ' / ' + r.breakdown.figPages + ' |');
  L.push('| 表数 / 表页 | ' + r.breakdown.tables + ' / ' + r.breakdown.tablePages + ' |');
  L.push('');
  L.push('## 逐节（按可删性排序）');
  L.push('');
  L.push('| 节 | 词数 | 估算页 | 段数 | 受保护段 | 可删性 | 依据 |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of r.sections.slice().sort((a, b) => b.cutScore - a.cutScore || b.words - a.words)) {
    L.push('| ' + s.title + ' | ' + s.words + ' | ' + s.pages + ' | ' + s.paras + ' | ' + s.protected + ' | ' + s.cutScore + '/3 | ' + s.cutWhy + ' |');
  }
  L.push('');
  L.push('## 削减/补强方案（预计共省 ' + r.totalSave + ' 页' + (r.planOmitted ? ' · 另有 ' + r.planOmitted + ' 项可省 <0.15 页的动作已省略' : '') + '）');
  L.push('');
  L.push('| 动作 | 节 | 可省页 | 依据 |'); L.push('|---|---|---|---|');
  for (const p of r.plan) L.push('| ' + p.kind + ' | ' + p.section + ' | ' + (p.save || '—') + ' | ' + p.why + ' |');
  L.push('');
  for (const s of r.sections) {
    if (s.filler.length) { L.push('- 「' + s.title + '」冗余措辞命中 ' + s.filler.length + ' 处：' + s.filler.slice(0, 2).map((f) => f.why).join('、')); }
  }
  L.push('');
  L.push('> ' + r.note);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  /* ★ 夹具按**阈值**设计（第 3 次同族教训）：Results 要足够长，其「只压缩措辞」（省 12%）才 ≥0.15 页（≈625 词 @500 词/页） */
  const LONG = '# Introduction\n' + ('Academic writing tools are widely used and many problems remain unresolved in practice. '.repeat(20))
    + '\n\n# Results\n' + ('We measured accuracy of 0.973 in protocol A and 0.951 in protocol B [12], with a mean error of 0.4 percentage points across 30 cells and 12 holdout conditions. '.repeat(40))
    + '\n\n# Related work\n' + ('Prior studies examined citation hallucination without measuring policy effects at all. '.repeat(20));
  ck('正控：超限 ⇒ FAIL 且给出超额页数与削减候选', () => {
    /* ★ 前提修正：LONG 约 500 词 ≈ 1.03 页 ⇒ limit 必须小于它才谈得上超限（原设 2 根本不超，是夹具错） */
    const r = analyse(LONG, { limit: 0.5, density: 500 });
    return (r.status === 'FAIL' && r.over > 0 && r.plan.length > 0) ? true : JSON.stringify({ s: r.status, o: r.over, p: r.plan.length });
  });
  ck('★必失败面：**结果节（含数字/引用）不得被列为"删除"候选**（只允许压缩措辞）', () => {
    const r = analyse(LONG, { limit: 0.5, density: 500 });
    const resultsActions = r.plan.filter((p) => /Results/.test(p.section));
    if (!resultsActions.length) return '结果节未出现在方案里（应给"只压缩措辞"）';
    return resultsActions.every((p) => /不得删内容|压缩措辞/.test(p.kind)) ? true : '结果节被当成可删：' + JSON.stringify(resultsActions);
  });
  ck('正控：未超限 ⇒ PASS 且给"可选补强"而非削减', () => {
    const r = analyse(LONG, { limit: 50, density: 500 });
    return (r.status === 'PASS' && r.plan.every((p) => /补强/.test(p.kind))) ? true : JSON.stringify(r.plan.map((p) => p.kind));
  });
  ck('★必失败面：缺 --limit ⇒ SKIP（没有预算就谈不上超没超）', () => {
    const r = analyse(LONG, {});
    return (r.status === 'SKIP' && /--limit/.test(r.why)) ? true : JSON.stringify(r);
  });
  ck('★必失败面：空稿 ⇒ SKIP（未核算）', () => {
    const r = analyse('   ', { limit: 10 });
    return (r.status === 'SKIP') ? true : JSON.stringify(r.status);
  });
  ck('重复段可被识别：两段高度重合 ⇒ 出"删并重复段"候选', () => {
    /* ★ 前提修正：原夹具只约 30 词（0.06 页）⇒ 不可能超限；加长到确有 1 页以上（两句高重合的段落各重复 12 次） */
    const s1 = 'The dual protocol validation confirms that the chronological split prevents information leakage into training data. ';
    const s2 = 'The dual protocol validation confirms that the chronological split prevents information leakage into training procedures. ';
    const dup = s1.repeat(20) + '\n\n' + s2.repeat(20);   /* 放大到「删并重复段」可省 ≥0.15 页 */
    const r = analyse('# Methods\n' + dup + '\n', { limit: 0.5, density: 500 });
    return r.plan.some((p) => /删并重复段/.test(p.kind)) ? true : JSON.stringify(r.plan);
  });
  ck('估算口径可覆盖：--density 变小 ⇒ 估算页数变大（线性）', () => {
    const a = analyse(LONG, { limit: 99, density: 500 }), b = analyse(LONG, { limit: 99, density: 250 });
    return Math.abs(b.breakdown.wordPages - a.breakdown.wordPages * 2) < 0.05 ? true : JSON.stringify([a.breakdown.wordPages, b.breakdown.wordPages]);
  });

  ck('v3.14.0·真稿抓出：**参考文献不得**被建议「压缩措辞省 25%」，只能是收紧样式且不删条目', () => {
    const r = analyse('# References\n' + ('Author, A. A very long citation entry with many words in it. Journal of Something, 12(3), 45-67. '.repeat(60)) + '\n\n# Introduction\n' + ('Background filler words repeated many times to exceed the budget amply. '.repeat(60)), { limit: 0.5 });
    const refActions = r.plan.filter((p) => /References/.test(p.section));
    if (!refActions.length) return '参考文献未出现在方案里';
    return refActions.every((p) => /收紧参考文献样式/.test(p.kind) && /不删条目/.test(p.kind)) ? true : '参考文献被当可压缩措辞：' + JSON.stringify(refActions);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nfit-pages 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const d = val('--draft');
  if (!d) { console.error('前提层失败：需要 --draft <稿.md> --limit <页数>'); return 2; }
  const p = path.resolve(d);
  if (!fs.existsSync(p)) { console.error('前提层失败：稿件不存在 —— ' + p); return 2; }
  const r = analyse(fs.readFileSync(p, 'utf8'), { limit: val('--limit'), density: val('--density'), figPage: val('--fig') === '' ? undefined : val('--fig'), tablePage: val('--table') === '' ? undefined : val('--table') });
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why + '（未核算 ≠ 通过）'); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : 0; }
  const out = val('--out');
  const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('核算已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('判定：' + r.status + '（上限 ' + r.limit + ' 页 · 估算 ' + r.used + ' 页 · ' + (r.over > 0 ? '超 ' + r.over : '余 ' + (-r.over)) + ' 页 · 方案共省 ' + r.totalSave + ' 页）');
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyse, render, sections, words, ngramOverlap, main, selftest };
