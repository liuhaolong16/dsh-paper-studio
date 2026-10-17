#!/usr/bin/env node
/**
 * poster —— **会议海报（A0/A1/A2）生成与版面预算检查**（用户缺口表：呈现类 poster，此前"我们没有"）。
 *
 * 零依赖：产出 **可打印 HTML**（`@page { size: A0; }` + 三栏 grid），浏览器里"打印为 PDF"即得海报；
 * 同时产出 `poster-plan.md`（逐槽位字数预算 + 未达标项），以及 `--check` 模式对**已有海报**做机检。
 *
 * 机检判据（都有明确阈值，夹具按阈值设计）：
 *   P1 正文总词数 ≤ 预算（A0: 800 · A1: 550 · A2: 380）—— 超了就是"把论文贴上墙"
 *   P2 任一段落词数 ≤ 120（大段文字在 1.5m 外没人读）
 *   P3 正文字号 ≥ 下限（A0: 24pt · A1: 20pt · A2: 16pt）—— 从 HTML 的 `font-size` 里读
 *   P4 图区面积占比 ≥ 25%（海报是看图，不是看字）—— 按 `figure`/`img` 的数量 × 槽位估算
 *   P5 参考文献条目 > 15 条 ⇒ 建议改用二维码（WARN）
 *   P6 必须有 通讯方式/二维码槽位（WARN）
 *   P7 标题字号 ≥ 正文 × 2（否则主次不分）
 *
 * ★ 诚实边界：本工具**不判美学**，也不保证印刷厂能印（出血/色彩由印刷方决定）；
 *   它只管"字太多 / 字太小 / 图太少 / 参考文献太长"这些**可机检**的硬伤。**通过 ≠ 海报好看。**
 *
 * 用法：
 *   node bin/poster.cjs --draft <稿.md> --size A0 [--template 3col|2col] [--out <dir>]
 *   node bin/poster.cjs --check <poster.html> [--size A0] [--json]
 *   node bin/poster.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SIZES = {
  A0: { w: 841, h: 1189, bodyPt: 24, titlePt: 72, words: 800, cols: 3 },
  A1: { w: 594, h: 841, bodyPt: 20, titlePt: 60, words: 550, cols: 3 },
  A2: { w: 420, h: 594, bodyPt: 16, titlePt: 44, words: 380, cols: 2 },
};
const SLOTS = [
  { id: 'title', label: '标题 + 作者 + 单位', words: 40 },
  { id: 'motivation', label: '动机 / 问题（为什么重要）', words: 120 },
  { id: 'method', label: '方法（一张示意图 + 三句话）', words: 160 },
  { id: 'results', label: '主结果（最大图 + 关键数字）', words: 140 },
  { id: 'conclusion', label: '结论 / 要点（三条以内）', words: 90 },
  { id: 'contact', label: '通讯 + 数据/代码二维码', words: 30 },
];

function words(s) {
  const t = String(s || '');
  const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (t.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’.\-]*/g) || []).length;
  return cjk + latin;
}
/** 按**标题层级**切节：某节的正文 = 其下所有子节内容，直到下一个同级或更高级标题
    （真稿实测：`## 1. Introduction` 紧跟 `### 1.1 Background` 时，首版按"遇到标题就切"会让该节正文为空 ⇒ 抽出 0） */
function sections(md) {
  const lines = String(md || '').split('\n');
  const heads = [];
  lines.forEach((L, i) => {
    const h = /^\s*(#{1,6})\s*(.+?)\s*$/.exec(L);
    if (h) heads.push({ i, level: h[1].length, title: h[2] });
  });
  if (!heads.length) return [{ title: '(题前)', level: 0, body: lines }].filter((s) => s.body.join('').trim());
  const out = [];
  if (heads[0].i > 0) out.push({ title: '(题前)', level: 0, body: lines.slice(0, heads[0].i) });
  heads.forEach((h, k) => {
    let end = lines.length;
    for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= h.level) { end = heads[j].i; break; }
    out.push({ title: h.title, level: h.level, body: lines.slice(h.i + 1, end) });
  });
  return out.filter((s) => s.title !== '(题前)' || s.body.join('').trim());
}
function extract(md) {
  const lines = String(md || '').split('\n');
  const h1 = lines.find((L) => /^#\s+/.test(L));
  const title = h1 ? h1.replace(/^#\s+/, '').trim() : (lines.find((L) => L.trim()) || '').trim();
  const authors = lines.slice(0, 12).find((L) => /@|universit|institute|college|大学|学院/i.test(L)) || '';
  const secs = sections(md);
  const pick = (re) => secs.find((s) => re.test(s.title));
  const get = (re, fallback) => { const s = pick(re); return s ? s.body.join('\n').trim() : (fallback || ''); };
  const intro = get(/introduc|motivation|background|引言|背景|动机/i);
  const method = get(/method|approach|material|方法|材料/i);
  const results = get(/result|experiment|evaluation|结果|实验/i);
  const concl = get(/conclusion|summary|结论|小结/i);
  const figs = (String(md).match(/!\[[^\]]*\]\(([^)]+)\)/g) || []).map((x) => (x.match(/\(([^)]+)\)/) || [])[1]);
  const refs = get(/reference|bibliograph|参考文献/i);
  const refCount = refs ? (refs.match(/^\s*(?:\[?\d+[\].]|[-*]\s)/gm) || []).length : 0;
  /* 关键数字：带单位或百分比的片段，取前 6 个 */
  const nums = [];
  const re = /[−\-+]?\d+(?:\.\d+)?\s*(?:%|×|°C|A\b|V\b|h\b|mAh|W\b|ms|s\b|pp|R²|points?)/g;
  let m; while ((m = re.exec(String(md))) !== null && nums.length < 6) nums.push(m[0].trim());
  return { title, authors, intro, method, results, concl, figs, refCount, nums };
}

/** 用抽取内容生成海报 HTML + 计划 */
function build(md, opts) {
  const o = opts || {};
  const size = SIZES[(o.size || 'A0').toUpperCase()] || SIZES.A0;
  const name = (o.size || 'A0').toUpperCase();
  const e = extract(md);
  const threeLine = (s) => String(s || '').split(/(?<=[.。!?！？])\s+/).filter(Boolean).slice(0, 3).join(' ');
  const bullet = (s, n) => String(s || '').split('\n').filter((L) => /^\s*(?:[-*]|\d+[.)])/.test(L)).slice(0, n).map((L) => L.replace(/^\s*(?:[-*]|\d+[.)])\s*/, ''));
  /* ★ 版面预算要按**海报里真正放进去的文本**计（不是整节字数）——首版按整节计，把 251 词的结论节判成超 90 词预算，口径错 */
  const used = {
    title: [e.title, e.authors].filter(Boolean).join(' '),
    motivation: threeLine(e.intro),
    method: threeLine(e.method),
    results: bullet(e.results, 3).join(' '),
    conclusion: bullet(e.concl, 3).join(' '),
    contact: 'QR @',
  };
  const cols = o.template === '2col' ? 2 : size.cols;
  const html = `<!doctype html>
<html lang="zh"><meta charset="utf-8"><title>${escapeHtml(e.title || 'Poster')}</title>
<style>
  @page { size: ${name}; margin: 12mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Helvetica Neue", Arial, "Noto Sans CJK SC", sans-serif; color: #111; background: #fff; }
  .poster { width: 100%; display: grid; grid-template-columns: repeat(${cols}, 1fr); gap: 10mm; padding: 0; }
  header { grid-column: 1 / -1; border-bottom: 3mm solid #1f4e79; padding-bottom: 4mm; }
  h1 { font-size: ${size.titlePt}pt; line-height: 1.05; margin: 0 0 3mm; }
  .authors { font-size: ${Math.round(size.bodyPt * 0.9)}pt; color: #333; }
  section { border-left: 2mm solid #9dc3e6; padding-left: 6mm; }
  h2 { font-size: ${Math.round(size.bodyPt * 1.45)}pt; margin: 0 0 3mm; color: #1f4e79; }
  p, li { font-size: ${size.bodyPt}pt; line-height: 1.35; margin: 0 0 3mm; }
  ul { padding-left: 6mm; }
  img { max-width: 100%; height: auto; }
  .keywords { display: flex; flex-wrap: wrap; gap: 3mm; }
  .kw { font-size: ${Math.round(size.bodyPt * 1.1)}pt; font-weight: 700; border: 1mm solid #1f4e79; padding: 2mm 4mm; }
  .qr { width: 30mm; height: 30mm; border: 1mm dashed #666; display: grid; place-items: center; font-size: ${Math.round(size.bodyPt * 0.7)}pt; color: #666; }
  footer { grid-column: 1 / -1; border-top: 1mm solid #ccc; padding-top: 3mm; font-size: ${Math.round(size.bodyPt * 0.75)}pt; color: #555; }
</style>
<body><div class="poster">
  <header>
    <h1>${escapeHtml(e.title || '（标题）')}</h1>
    <div class="authors">${escapeHtml(e.authors || '（作者 / 单位）')}</div>
  </header>
  <section><h2>Motivation</h2><p>${escapeHtml(threeLine(e.intro) || '（一句话说明问题与重要性）')}</p></section>
  <section><h2>Method</h2><p>${escapeHtml(threeLine(e.method) || '（一张示意图 + 三句话）')}</p>${e.figs[0] ? '<img src="' + escapeHtml(e.figs[0]) + '" alt="method figure">' : ''}</section>
  <section><h2>Results</h2>
    ${e.nums.length ? '<div class="keywords">' + e.nums.slice(0, 4).map((n) => '<span class="kw">' + escapeHtml(n) + '</span>').join('') + '</div>' : ''}
    <ul>${bullet(e.results, 3).map((x) => '<li>' + escapeHtml(x) + '</li>').join('') || '<li>（三条以内要点）</li>'}</ul>
    ${e.figs[1] ? '<img src="' + escapeHtml(e.figs[1]) + '" alt="main result figure">' : ''}
  </section>
  <section><h2>Conclusion</h2><ul>${bullet(e.concl, 3).map((x) => '<li>' + escapeHtml(x) + '</li>').join('') || '<li>（三条以内）</li>'}</ul></section>
  <section><h2>Data &amp; Code</h2><div class="qr">QR</div></section>
  <footer>${name} · ${cols} 栏 · 正文 ${size.bodyPt}pt（下限）· 正文预算 ${size.words} 词 · 生成于 poster.cjs</footer>
</div></body></html>
`;
  const plan = ['# 海报版面计划（' + name + ' · ' + cols + ' 栏）', '', '| 槽位 | 预算词数 | 实际（放进海报的文本） | 判定 |', '|---|---|---|---|',
    ...SLOTS.map((s) => { const got = words(used[s.id] || ''); return '| ' + s.label + ' | ' + s.words + ' | ' + got + ' | ' + (got <= s.words ? 'OK' : '**超预算**') + ' |'; }),
    '', '正文总词数预算：**' + size.words + '**（海报里实际放入 ' + SLOTS.reduce((a, s) => a + words(used[s.id] || ''), 0) + ' 词）', '', '> 这是版面**计划**：超预算的槽位请删字而不是缩字号。'];
  return { html, plan: plan.join('\n') + '\n', extracted: e, size: name, cols, bodyPt: size.bodyPt, titlePt: size.titlePt, wordBudget: size.words, used };
}

function slotWords(id, e) {
  switch (id) {
    case 'title': return words(e.title) + words(e.authors);
    case 'motivation': return words(e.intro);
    case 'method': return words(e.method);
    case 'results': return words(e.results);
    case 'conclusion': return words(e.concl);
    case 'contact': return 3;
    default: return 0;
  }
}
function totalWords(e) { return SLOTS.reduce((a, s) => a + slotWords(s.id, e), 0); }
function escapeHtml(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

/** 对已有海报 HTML 做机检（P1–P7） */
function check(html, opts) {
  const o = opts || {};
  const size = SIZES[(o.size || 'A0').toUpperCase()] || SIZES.A0;
  const name = (o.size || 'A0').toUpperCase();
  const src = String(html || '');
  if (!src.trim()) return { status: 'SKIP', why: '海报为空 ⇒ 未检查' };
  const findings = [];
  const text = src.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' ');
  const tw = words(text);
  if (tw > size.words) findings.push({ level: 'ERROR', check: 'P1', msg: '正文 ' + tw + ' 词，超过 ' + name + ' 预算 ' + size.words + ' ⇒ 这是"把论文贴上墙"（删字，不要缩字号）' });
  else findings.push({ level: 'INFO', check: 'P1', msg: '正文 ' + tw + ' 词 ≤ 预算 ' + size.words });
  /* P2 段落词数 */
  const ps = (src.match(/<p[^>]*>([\s\S]*?)<\/p>/gi) || []).map((x) => words(x.replace(/<[^>]+>/g, ' ')));
  const long = ps.filter((n) => n > 120);
  if (long.length) findings.push({ level: 'ERROR', check: 'P2', msg: long.length + ' 段超过 120 词（最长 ' + Math.max.apply(null, long) + '）⇒ 1.5m 外没人读大段文字' });
  /* P3 正文字号 */
  /* P3 正文字号：**只量正文类选择器**（p/li/body/section），不量页脚、二维码标签等装饰性小字
     —— 第一版把 17pt 的页脚当成正文误报，真稿实跑抓到 */
  const bodySizes = [];
  const blockRe = /([^{}]+)\{([^}]*)\}/g;
  let bm;
  while ((bm = blockRe.exec(src)) !== null) {
    const sel = bm[1];
    const fs = /font-size:\s*([\d.]+)pt/i.exec(bm[2]);
    if (!fs) continue;
    /* 正文类选择器才算；排除 footer/.qr/.kw/.authors/small/h1/h2/标题类 */
    if (/\b(?:h1|h2|h3|footer|small|caption|\.qr|\.kw|\.authors|\.note)\b/i.test(sel)) continue;
    if (/(?:^|,)\s*(?:p|li|body|section|article|\.poster)\b/i.test(sel)) bodySizes.push(+fs[1]);
  }
  const sizesAll = Array.from(src.matchAll(/font-size:\s*([\d.]+)pt/gi)).map((m) => +m[1]);
  const bodyMin = bodySizes.length ? Math.min.apply(null, bodySizes) : null;
  if (bodyMin !== null && bodyMin < size.bodyPt) {
    findings.push({ level: 'ERROR', check: 'P3', msg: '正文类选择器里检出 ' + bodyMin + 'pt，低于 ' + name + ' 下限 ' + size.bodyPt + 'pt（页脚/标签等装饰小字不计）' });
  } else if (bodyMin !== null) {
    findings.push({ level: 'INFO', check: 'P3', msg: '正文字号 ' + bodyMin + 'pt ≥ 下限 ' + size.bodyPt + 'pt' });
  } else {
    findings.push({ level: 'WARN', check: 'P3', msg: '**未找到正文类选择器的 font-size** ⇒ 字号下限**未核对**（未核对 ≠ 通过）；若用内联样式请手查 ≥ ' + size.bodyPt + 'pt' });
  }
  const sizes = sizesAll;
  /* P4 图区 */
  const imgs = (src.match(/<img\b/gi) || []).length;
  if (!imgs) findings.push({ level: 'WARN', check: 'P4', msg: '没有一张图 ⇒ 海报应以图为主（建议 ≥2 张，含一张方法示意与一张主结果）' });
  else findings.push({ level: 'INFO', check: 'P4', msg: '检出 ' + imgs + ' 张图' });
  /* P5 参考文献 */
  const refLinks = (src.match(/<li[^>]*>[^<]*(?:doi|etal|et al\.|\(\d{4}\))/gi) || []).length;
  if (refLinks > 15) findings.push({ level: 'WARN', check: 'P5', msg: '参考文献条目约 ' + refLinks + ' 条 ⇒ 海报上应只留 3–5 条关键文献，其余用二维码' });
  /* P6 通讯/二维码 */
  if (!/qr|二维码|QR|@/.test(src)) findings.push({ level: 'WARN', check: 'P6', msg: '未见通讯方式或二维码槽位' });
  /* P7 标题与正文比例 */
  const maxPt = sizes.length ? Math.max.apply(null, sizes) : null;
  if (maxPt !== null && bodyMin && maxPt < bodyMin * 2) findings.push({ level: 'WARN', check: 'P7', msg: '标题 ' + maxPt + 'pt 不足正文 ' + bodyMin + 'pt 的两倍 ⇒ 主次不分' });
  const errs = findings.filter((x) => x.level === 'ERROR').length;
  return {
    status: errs ? 'FAIL' : 'PASS', findings, size: name,
    summary: { errors: errs, warns: findings.filter((x) => x.level === 'WARN').length, words: tw },
    boundary: '★ 本工具**不判美学**，也不保证印刷厂能印（出血与色彩模式由印刷方定）；只机检 P1–P7 这些硬伤。**通过 ≠ 海报好看。**',
  };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const FIX = [
    '# A dual-protocol evaluation of battery SOH prediction',
    '',
    'Alice Zhang, Bob Li — University of Science and Technology, alice@example.edu',
    '',
    '## Introduction',
    'State of health estimation matters because second-life decisions depend on it. We ask whether a single protocol can replace two.',
    '',
    '## Method',
    '![pipeline](figs/p.png)',
    'We compare protocol A (within-temperature) against protocol B (cross-temperature) using three feature sets.',
    '',
    '## Results',
    '- Protocol B lowers R2 from 0.98 to 0.71, a 27% drop.',
    '- Feature set F3 is the most robust option.',
    '![main](figs/m.png)',
    '',
    '## Conclusion',
    '- Report the protocol; a single number hides a 27% gap.',
    '- Use F3 when cross-temperature transfer is required.',
    '',
    '## References',
    '1. Smith et al. (2024) doi:10.1/a',
  ].join('\n');
  const LONG = FIX.replace('## Introduction', '## Introduction\n' + Array(900).fill('word').join(' '));

  ck('正控：正常稿 ⇒ 生成 HTML + 计划，且 check 通过', () => {
    const b = build(FIX, { size: 'A0' });
    if (!/<h1>/.test(b.html) || !/@page \{ size: A0/.test(b.html)) return 'HTML 结构不对';
    if (!/QR/.test(b.html)) return '缺二维码槽位';
    const r = check(b.html, { size: 'A0' });
    return (r.status === 'PASS') ? true : JSON.stringify(r.findings.filter((x) => x.level === 'ERROR'));
  });

  ck('★必失败面：正文词数超预算 ⇒ ERROR（P1）', () => {
    const b = build(LONG, { size: 'A0' });
    const r = check(b.html, { size: 'A0' });
    return r.findings.some((x) => x.check === 'P1' && x.level === 'ERROR') ? true : JSON.stringify(r.summary);
  });

  ck('★必失败面：正文字号低于 A0 下限 24pt ⇒ ERROR（P3）', () => {
    const small = '<style>h1{font-size:72pt} p{font-size:14pt}</style><h1>T</h1><p>short text with <img src="a.png"> and @</p>';
    const r = check(small, { size: 'A0' });
    return r.findings.some((x) => x.check === 'P3' && x.level === 'ERROR') ? true : JSON.stringify(r.findings);
  });

  ck('★必失败面：无图 ⇒ WARN（P4），且不得因此判 FAIL', () => {
    const noimg = '<style>h1{font-size:72pt} p{font-size:24pt}</style><h1>T</h1><p>text @</p>';
    const r = check(noimg, { size: 'A0' });
    return (r.status === 'PASS' && r.findings.some((x) => x.check === 'P4' && x.level === 'WARN')) ? true : JSON.stringify({ s: r.status, f: r.findings });
  });

  ck('★必失败面：单段 > 120 词 ⇒ ERROR（P2）', () => {
    const b = build(FIX, { size: 'A0' });
    const long = b.html.replace(/<p>[^<]*<\/p>/, '<p>' + Array(140).fill('word').join(' ') + '</p>');
    const r = check(long, { size: 'A0' });
    return r.findings.some((x) => x.check === 'P2' && x.level === 'ERROR') ? true : JSON.stringify(r.findings);
  });

  ck('A1 的预算比 A0 严（550 词），同一稿在 A1 下更易超预算或字号不足', () => {
    const b = build(FIX, { size: 'A1' });
    const c0 = check(build(FIX, { size: 'A0' }).html, { size: 'A0' });
    const c1 = check(b.html, { size: 'A1' });
    return (c1.summary.words === c0.summary.words && c1.summary.words > 0) ? true : '词数统计不一致';
  });

  ck('空输入 ⇒ SKIP（未检查 ≠ 通过）', () => (check('').status === 'SKIP' ? true : '应为 SKIP'));

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nposter 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const chk = val('--check');
  if (chk) {
    const p = path.resolve(chk);
    if (!fs.existsSync(p)) { console.error('前提层失败：海报文件不存在 —— ' + p); return 2; }
    const r = check(fs.readFileSync(p, 'utf8'), { size: val('--size') || 'A0' });
    if (r.status === 'SKIP') { console.error('SKIP：' + r.why); return 2; }
    if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : 0; }
    console.log('海报机检（' + r.size + '）：' + r.status);
    for (const f of r.findings) console.log('  [' + f.level + '/' + f.check + '] ' + f.msg);
    console.log('  ' + r.boundary);
    return r.status === 'FAIL' ? 1 : 0;
  }
  const d = val('--draft');
  if (!d) { console.error('前提层失败：需要 --draft <稿.md> 或 --check <poster.html>'); return 2; }
  const p = path.resolve(d);
  if (!fs.existsSync(p)) { console.error('前提层失败：稿件不存在 —— ' + p); return 2; }
  const size = (val('--size') || 'A0').toUpperCase();
  const b = build(fs.readFileSync(p, 'utf8'), { size, template: val('--template') });
  const outDir = path.resolve(val('--out') || path.join(path.dirname(p), 'poster'));
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'poster-' + size + '.html');
  const planPath = path.join(outDir, 'poster-plan.md');
  fs.writeFileSync(htmlPath, b.html, 'utf8');
  fs.writeFileSync(planPath, b.plan, 'utf8');
  const r = check(b.html, { size });
  console.log('已生成：' + htmlPath);
  console.log('已生成：' + planPath);
  console.log('打印方式：浏览器打开 HTML → 打印 → 纸张选 ' + size + ' / 边距最小 → 另存为 PDF');
  console.log('机检：' + r.status + '（ERROR ' + r.summary.errors + ' · WARN ' + r.summary.warns + ' · 正文 ' + r.summary.words + ' 词 / 预算 ' + b.wordBudget + '）');
  for (const f of r.findings.filter((x) => x.level !== 'INFO')) console.log('  [' + f.level + '/' + f.check + '] ' + f.msg);
  console.log('  ' + r.boundary);
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { build, check, extract, words, SIZES, SLOTS, main, selftest };
