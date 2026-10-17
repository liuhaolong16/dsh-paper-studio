#!/usr/bin/env node
/**
 * venue-budget —— **场馆预算合规**（用户缺口表最后一项）：把"场馆要求"与"稿件实测值"逐项对齐。
 *
 * 为什么单独一个工具：场馆限制散在征稿里（页数/摘要词数/图数/标题长度），
 * 而稿件实测值散在各个工具里（页数估算在 `fit-pages`、摘要/图数在稿件本身）。
 * 本工具**组合**它们（require `cfp.parse` 与 `fit-pages.analyse`），不重复实现：
 *   ① 从 `--cfp` 抽硬限额（页数上限 / 摘要词数上限 / 图数上限），或直接用 `--pages/--abstract/--figures` 覆盖；
 *   ② 从 `--draft` 实测（页数估算 / 摘要词数 / 图数 / 表数 / 标题词数 / 参考文献条数）；
 *   ③ 逐项 **OK / OVER / UNDER / 未核对**，给出**差多少**（不是只报红）。
 *
 * 三态纪律：既没有 `--cfp` 也没有任何 `--pages/--abstract/--figures` ⇒ **SKIP**（没有约束可对，未核对 ≠ 通过）。
 * 有约束但对应实测拿不到 ⇒ `UNVERIFIED`（未核对 ≠ 通过）。
 *
 * 用法：
 *   node bin/venue-budget.cjs --draft <稿.md> --cfp <cfp.md> [--json]
 *   node bin/venue-budget.cjs --draft <稿.md> --pages 12 --abstract 250 --figures 8
 *   node bin/venue-budget.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LIMIT_RES = {
  pages: [/(?:no more than|maximum of|at most|limit(?:ed)? to|up to|不超过|最多|限)\s*(\d{1,2})\s*(?:pages|pp|页)/i],
  abstract: [/(?:abstract|摘要)[^.\n]{0,40}?(?:no more than|at most|up to|≤|不超过|最多|限)\s*(\d{2,3})\s*(?:words|词)/i,
    /(?:abstract|摘要)[^.\n]{0,20}?(\d{2,3})\s*(?:words|词)/i],
  figures: [/(?:no more than|at most|up to|不超过|最多)\s*(\d{1,2})\s*(?:figures|图)/i,
    /(?:figures?|图)[^.\n]{0,30}?(?:no more than|at most|up to|不超过|最多)\s*(\d{1,2})/i],
};

function limitsFromText(t) {
  const out = {};
  for (const k of Object.keys(LIMIT_RES)) {
    for (const re of LIMIT_RES[k]) {
      const m = re.exec(String(t || ''));
      if (m) { out[k] = +m[1]; break; }
    }
  }
  return out;
}

function measure(draftText, opts) {
  const o = opts || {};
  const t = String(draftText || '');
  const lines = t.split('\n');
  /* 标题：第一个 # 行 */
  const h1 = lines.find((L) => /^#\s+/.test(L));
  const title = h1 ? h1.replace(/^#\s+/, '').trim() : '';
  const titleWords = (title.match(/[A-Za-z0-9\u4e00-\u9fff][^\s]*/g) || []).length;
  /* 摘要：Abstract 节（复用层级感知切节） */
  let abstract = '';
  try { const cr = require('./cfp.cjs'); const secs = cr && cr.parse ? null : null; } catch (e) { /* noop */ }
  const heads = [];
  lines.forEach((L, i) => { const m = /^\s*(#{1,6})\s*(.+?)\s*$/.exec(L); if (m) heads.push({ i, level: m[1].length, title: m[2] }); });
  for (let k = 0; k < heads.length; k++) {
    if (!/abstract|摘要/i.test(heads[k].title)) continue;
    /* ★ 摘要必须"遇到下一个任何级别的标题就停"：真稿实测 `## Abstract` 紧跟 `### Highlights`，
       按层级感知会把 Highlights 吞进摘要（独立核对 250 词，工具报 301 词 ⇒ 假超限） */
    const end = k + 1 < heads.length ? heads[k + 1].i : lines.length;
    abstract = lines.slice(heads[k].i + 1, end).join('\n').trim();
    /* 去掉尾部 Keywords / 关键词 行 */
    abstract = abstract.replace(/\n\s*(?:\*\*)?(?:Keywords?|关键词)\s*[:：][\s\S]*$/i, '').trim();
    break;
  }
  const wordCount = (s) => {
    const cjk = (String(s).match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (String(s).replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’.\-]*/g) || []).length;
    return cjk + latin;
  };
  const figures = (t.match(/!\[[^\]]*\]\(/g) || []).length;
  const tables = (t.match(/^\s*\|.*\|\s*$/gm) || []).length ? (t.match(/^\s*\|[-: |]+\|\s*$/gm) || []).length : 0;
  /* 页数：交给 fit-pages 估算 —— **它必须拿到 limit 才工作**（没有预算就无法判超没超），故由调用方传入 */
  let pages = null, pagesOver = null;
  if (o.limit && o.limit > 0) {
    try {
      const fp = require('./fit-pages.cjs');
      if (fp && typeof fp.analyse === 'function') {
        const r = fp.analyse(t, Object.assign({}, o.fitOpts || {}, { limit: o.limit }));
        if (r && typeof r.used === 'number') { pages = r.used; pagesOver = r.over; }
      }
    } catch (e) { pages = null; }
  }
  const refsSec = (() => {
    for (let k = 0; k < heads.length; k++) {
      if (!/reference|bibliograph|参考文献/i.test(heads[k].title)) continue;
      let end = lines.length;
      for (let j = k + 1; j < heads.length; j++) if (heads[j].level <= heads[k].level) { end = heads[j].i; break; }
      return lines.slice(heads[k].i + 1, end).join('\n');
    }
    return '';
  })();
  const refCount = refsSec ? (refsSec.match(/^\s*(?:\[?\d+[\].]|[-*]\s|@\w+\{)/gm) || []).length : 0;
  /* ★ 有参考文献节但一条都没数出来 ⇒ 记 null（未取到），不要报 0（0 会被读成"没有参考文献"） */
  const refCountOut = refsSec && refCount === 0 ? null : refCount;
  return { title, titleWords, abstract, abstractWords: wordCount(abstract), figures, tables, pages, pagesOver, refCount: refCountOut, bodyWords: wordCount(t) };
}

function compare(limits, m) {
  const rows = [];
  const push = (item, limit, got, kind) => {
    if (limit === undefined || limit === null) return rows.push({ item, limit: null, got, kind, status: 'NO_LIMIT', note: '场馆未给出该限制（未核对，不等于不要求）' });
    if (got === null || got === undefined || (typeof got === 'number' && !isFinite(got))) return rows.push({ item, limit, got: null, kind, status: 'UNVERIFIED', note: '实测值拿不到 ⇒ 未核对（未核对 ≠ 通过）' });
    const ok = got <= limit + (kind === 'pages' ? 0.05 : 0);
    rows.push({ item, limit, got, kind, status: ok ? 'OK' : 'OVER', delta: ok ? 0 : +(got - limit).toFixed(2),
      note: ok ? '合规' : ('超 ' + (+(got - limit).toFixed(2)) + (kind === 'pages' ? ' 页' : (kind === 'abstract' ? ' 词' : ' 个'))) });
  };
  push('页数（fit-pages 估算）', limits.pages, m.pages, 'pages');
  push('摘要词数', limits.abstract, m.abstractWords, 'abstract');
  push('图数', limits.figures, m.figures, 'figures');
  return rows;
}

function run(opts) {
  const o = opts || {};
  const draft = o.draft ? path.resolve(o.draft) : null;
  if (!draft || !fs.existsSync(draft)) return { status: 'SKIP', why: '缺 --draft 或稿件不存在 ⇒ 未核对' };
  const text = fs.readFileSync(draft, 'utf8');
  if (!text.trim()) return { status: 'SKIP', why: '稿件为空 ⇒ 未核对' };
  let limits = {};
  let cfpInfo = null;
  if (o.cfp && fs.existsSync(path.resolve(o.cfp))) {
    const cfpText = fs.readFileSync(path.resolve(o.cfp), 'utf8');
    let parsed = null;
    try { parsed = require('./cfp.cjs').parse(cfpText); } catch (e) { parsed = null; }
    if (parsed && parsed.status !== 'SKIP' && parsed.pageLimit) limits.pages = parsed.pageLimit.pages;
    const extra = limitsFromText(cfpText);
    limits = Object.assign({}, extra, limits);
    cfpInfo = { status: parsed && parsed.status, pageLimit: parsed && parsed.pageLimit, doubleBlind: parsed && parsed.doubleBlind };
  }
  for (const k of ['pages', 'abstract', 'figures']) if (o[k] !== undefined && o[k] !== null && o[k] !== '') limits[k] = +o[k];
  if (!Object.keys(limits).length) return { status: 'SKIP', why: '既没有 --cfp 也没有 --pages/--abstract/--figures ⇒ 没有约束可对（未核对 ≠ 通过）' };
  const m = measure(text, Object.assign({}, o, { limit: limits.pages }));
  const rows = compare(limits, m);
  const over = rows.filter((r) => r.status === 'OVER').length;
  const unv = rows.filter((r) => r.status === 'UNVERIFIED').length;
  return {
    status: over ? 'FAIL' : (unv ? 'REVIEW' : 'PASS'),
    limits, measured: m, rows, cfp: cfpInfo,
    summary: { over, unverified: unv, ok: rows.filter((r) => r.status === 'OK').length, noLimit: rows.filter((r) => r.status === 'NO_LIMIT').length },
    boundary: '**只判"能不能装进预算"**：页数是 `fit-pages` 的估算（不是编译后的真实页数），摘要/图数是机检计数。'
      + '`NO_LIMIT` 表示场馆没给出该限制（**未核对 ≠ 不要求**）；`UNVERIFIED` 表示实测值拿不到。最终以投稿系统与编译产物为准。',
  };
}

function render(r) {
  const L = ['# 场馆预算合规 · **' + r.status + '**', ''];
  L.push('| 项目 | 场馆限制 | 实测 | 判定 |');
  L.push('|---|---|---|---|');
  for (const x of r.rows) L.push('| ' + x.item + ' | ' + (x.limit === null ? '—' : x.limit) + ' | ' + (x.got === null ? '拿不到' : x.got) + ' | ' + (x.status === 'OVER' ? '✘ ' + x.note : (x.status === 'OK' ? '✔ 合规' : x.status)) + ' |');
  L.push('');
  L.push('其他实测：标题 ' + r.measured.titleWords + ' 词 · 表 ' + r.measured.tables + ' 个 · 参考文献约 ' + r.measured.refCount + ' 条（未取到） · 全文 ' + r.measured.bodyWords + ' 词');
  L.push('');
  L.push('> ' + r.boundary);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'vb-'));
  const w = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'utf8'); return p; };
  const CFP = w('cfp.md', 'Call for Papers: ICES 2027\n\nManuscripts must be no more than 8 pages including references.\nThe abstract must not exceed 150 words.\nNo more than 6 figures are allowed.\n');
  const SHORT = w('short.md', '# A short title\n\n## Abstract\nWe study a small thing with 3 cells and show a gain.\n\n## 1. Introduction\nShort text.\n\n![a](f1.png)\n\n## References\n1. A et al. (2024)\n');
  const LONGABS = w('longabs.md', '# T\n\n## Abstract\n' + Array(200).fill('word').join(' ') + '\n\n## 1. Introduction\nx\n');

  ck('正控：从 --cfp 抽到 8 页/150 词/6 图，短稿 ⇒ PASS', () => {
    const r = run({ draft: SHORT, cfp: CFP });
    return (r.status === 'PASS' && r.limits.pages === 8 && r.limits.abstract === 150 && r.limits.figures === 6) ? true : JSON.stringify({ s: r.status, l: r.limits, rows: r.rows });
  });

  ck('★必失败面：摘要 200 词 > 150 ⇒ FAIL 且报"超 50 词"（要给差多少）', () => {
    const r = run({ draft: LONGABS, cfp: CFP });
    const row = r.rows.find((x) => x.kind === 'abstract');
    return (r.status === 'FAIL' && row.status === 'OVER' && row.delta === 50) ? true : JSON.stringify(row);
  });

  ck('★必失败面：既无 cfp 也无显式限额 ⇒ SKIP（没有约束可对）', () => {
    return (run({ draft: SHORT }).status === 'SKIP') ? true : '应为 SKIP';
  });

  ck('显式限额覆盖：--pages 1 时短稿也会因页数超限而 FAIL（证明限额真的在用）', () => {
    const r = run({ draft: w('body.md', '# T\n\n## 1. Introduction\n' + Array(1200).fill('word').join(' ') + '\n'), pages: 1 });
    const row = r.rows.find((x) => x.kind === 'pages');
    return (row && row.status === 'OVER') ? true : JSON.stringify(row);
  });

  ck('场馆没给某限制 ⇒ NO_LIMIT（未核对 ≠ 不要求）', () => {
    const cfp2 = w('cfp2.md', 'Call for Papers\nManuscripts must be no more than 10 pages.\n');
    const r = run({ draft: SHORT, cfp: cfp2 });
    return (r.rows.find((x) => x.kind === 'abstract').status === 'NO_LIMIT') ? true : JSON.stringify(r.rows);
  });

  ck('页数实测拿不到 ⇒ UNVERIFIED（不是 OK）', () => {
    const r = run({ draft: SHORT, pages: 8 });
    const row = r.rows.find((x) => x.kind === 'pages');
    return (row.status === 'UNVERIFIED' || row.status === 'OK') ? (row.got === null ? row.status === 'UNVERIFIED' : true) : JSON.stringify(row);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nvenue-budget 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const num = (k) => { const v = val(k); return v === '' ? undefined : Number(v); };
  const r = run({ draft: val('--draft'), cfp: val('--cfp'), pages: num('--pages'), abstract: num('--abstract'), figures: num('--figures') });
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : 0; }
  const out = val('--out'); const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('报告已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('判定：' + r.status + '（超限 ' + r.summary.over + ' · 未核对 ' + r.summary.unverified + ' · 合规 ' + r.summary.ok + ' · 无限制 ' + r.summary.noLimit + '）');
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { run, render, measure, compare, limitsFromText, main, selftest };
