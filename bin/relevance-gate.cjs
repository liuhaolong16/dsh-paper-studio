#!/usr/bin/env node
/**
 * relevance-gate —— **新加引用是否离题的弱机检**（对拍 Task C 的剩余缺口：`refs-verify` 只判"存在/版本/撤稿"，
 * 不判"这条引用跟本文有没有关系"；对手 `check_bibtex.py` 有 relevance 一类判据）。
 *
 * ★ 诚实边界（回执里必须打印，且**只出 WARN 不出 FAIL**）：
 *   本工具用**词面重合**做代理（正文高频实词 vs 条目标题/摘要实词）+ **共引主题连通性**。
 *   词面重合**不等于**相关性：一条正当的旁证引用也可能词面很远（例如借用方法论文献），
 *   所以它只报"**疑似离题，请人工确认**"，并**打印重合数**供人判；`--keywords` 可用于显式声明主题（最强信号）。
 *
 * 三态：条目缺标题且缺摘要 ⇒ `CHECK_SKIPPED`（**未核对 ≠ 通过**）；无正文或无条目 ⇒ `SKIP`。
 *
 * 用法：
 *   node bin/relevance-gate.cjs --draft <稿.md> --bib <refs.bib> [--keywords "a,b,c"] [--min 0.06] [--json]
 *   node bin/relevance-gate.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const STOP = new Set(('the a an and or of to in on for with by as at from that this these those is are was were be been it its their our we they i you he she them his her not no but if then than also such can may might should could would will shall do does did have has had there here which who whom whose what when where why how all any both each few more most other some only own same so too very s t just don now new new using used use based propose proposed method methods result results paper study approach model data show shows shown present presents however moreover thus therefore furthermore additionally we our they their').split(/\s+/));

const words = (s) => (String(s || '').toLowerCase().match(/[a-z][a-z'\-]{2,}|[\u4e00-\u9fa5]{2,}/g) || []).filter((w) => !STOP.has(w));

/** 极简 .bib 解析（支持点号 id、@type{key, 字段 = {..}}） */
function parseBib(text) {
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,/g;
  let m;
  const heads = [];
  while ((m = re.exec(text)) !== null) heads.push({ type: m[1].toLowerCase(), key: m[2], at: m.index, end: re.lastIndex });
  for (let i = 0; i < heads.length; i++) {
    const seg = text.slice(heads[i].at, i + 1 < heads.length ? heads[i + 1].at : text.length);
    const f = {};
    const fre = /(\w+)\s*=\s*\{([^}]*)\}/g;
    let g;
    while ((g = fre.exec(seg)) !== null) f[g[1].toLowerCase()] = g[2].replace(/\s+/g, ' ').trim();
    out.push({ type: heads[i].type, key: heads[i].key, fields: f });
  }
  return out;
}

function analyse(draftText, bibText, opts) {
  const o = opts || {};
  const min = o.min === undefined ? 0.06 : Number(o.min);
  const entries = parseBib(bibText);
  if (!entries.length) return { status: 'SKIP', why: '没有解析到任何 .bib 条目 ⇒ 未核对' };
  const draft = words(draftText);
  const declared = String(o.keywords || '').split(/[,;，；]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (!draft.length && !declared.length) return { status: 'SKIP', why: '正文没有可用实词且未给 --keywords ⇒ 无主题基线，未核对' };
  /* 正文主题词：**频次 ≥2 的实词（上限 400）** + 显式关键词（后者权重 ×3）
     ★ 真跑修正：原先只取 top-40，在 8700 词的长稿上主题面太窄 —— 连全文反复出现的 PRISMA 都进不去，
     导致正当条目命中 0 被误判离题。 */
  const freq = {};
  for (const w of draft) freq[w] = (freq[w] || 0) + 1;
  const theme = new Map();
  Object.keys(freq).filter((w) => freq[w] >= 2).sort((a, b) => freq[b] - freq[a]).slice(0, 400).forEach((w) => theme.set(w, 1));
  for (const k of declared) for (const w of words(k)) theme.set(w, 3);
  const rows = [];
  const rawDraft = String(draftText || '').toLowerCase();
  for (const e of entries) {
    const bag = words((e.fields.title || '') + ' ' + (e.fields.abstract || '') + ' ' + (e.fields.keywords || '')).slice(0, 400);
    if (!e.fields.title && !e.fields.abstract) { rows.push({ key: e.key, status: 'CHECK_SKIPPED', why: '条目无 title 也无 abstract ⇒ 相关性未核对' }); continue; }
    let hit = 0, score = 0;
    const bagSet = new Set(bag);
    for (const w of bagSet) if (theme.has(w)) { hit += 1; score += theme.get(w); }
    const denom = Math.sqrt(Math.max(bagSet.size, 1) * Math.max(theme.size, 1));
    const overlap = Math.round((score / (denom || 1)) * 1000) / 1000;
    /* ★ 真跑修正：**"被正文实际引用"本身就是正当性的强信号** ——
       引用键出现在正文（\cite{key} / [key] / 纯文本 key），或**标题里的专有名词/缩写**出现在正文，即视为正当；
       词面相似度只是代理，不能盖过"作者确实引了它"这一事实。 */
    /* ★ 只认**标题里的专有名词/缩写**（首词之后、首字母大写的词）作为"被引用"证据：
       普通词（robust / highly / structure）在任何长文里都会出现，用它们会误判（实测 plos2024/alphafold2021 被误判）。 */
    const rawTitle = String(e.fields.title || '');
    const properTokens = rawTitle.split(/\s+/).slice(1)
      .map((t) => t.replace(/[^A-Za-z0-9-]/g, ''))
      .filter((t) => /^[A-Z][A-Za-z0-9-]{2,}$/.test(t) && !STOP.has(t.toLowerCase()));
    const properHits = properTokens.filter((t) => rawDraft.indexOf(t.toLowerCase()) >= 0).length;
    const citedInText = !o.noCiteRule && (rawDraft.indexOf(String(e.key).toLowerCase()) >= 0 || properHits >= 1);
    if (citedInText) {
      rows.push({ key: e.key, type: e.type, status: 'CITED_IN_TEXT', overlap, hits: hit, bagSize: bagSet.size, title: (e.fields.title || '').slice(0, 70), why: '正文实际引用了它（键名或标题实词出现）⇒ **按"被引用"判正当**（词面相似度 ' + overlap + ' 仅供参考）' });
      continue;
    }
    rows.push({ key: e.key, type: e.type, status: overlap >= min ? 'OK' : 'OFF_TOPIC_SUSPECT', overlap, hits: hit, bagSize: bagSet.size, title: (e.fields.title || '').slice(0, 70) });
  }
  /* 共引连通性：可疑条目若与其他任一条目有 ≥2 个共同实词 ⇒ 降级为 INFO（说明它属于被引主题簇） */
  const bags = {};
  for (const e of entries) bags[e.key] = new Set(words((e.fields.title || '') + ' ' + (e.fields.abstract || '')));
  for (const r of rows) {
    if (r.status !== 'OFF_TOPIC_SUSPECT') continue;
    let linked = 0;
    for (const k of Object.keys(bags)) {
      if (k === r.key) continue;
      let sh = 0;
      for (const w of bags[r.key]) if (bags[k].has(w)) sh += 1;
      if (sh >= 2) { linked += 1; break; }
    }
    if (linked) { r.status = 'CLUSTERED'; r.why = '词面与正文较远，但与被引簇有共同主题词 ⇒ 可能是正当旁证，**请人工确认**'; }
    else { r.why = '词面与正文主题词重合低（' + r.overlap + ' < ' + min + '），且与其他被引条目无共同主题词 ⇒ **疑似离题，请人工确认**'; }
  }
  const suspects = rows.filter((r) => r.status === 'OFF_TOPIC_SUSPECT').length;
  const skipped = rows.filter((r) => r.status === 'CHECK_SKIPPED').length;
  return {
    status: rows.length ? (skipped === rows.length ? 'SKIP' : (suspects ? 'REVIEW' : 'OK')) : 'SKIP',
    counts: { entries: rows.length, ok: rows.filter((r) => r.status === 'OK').length, clustered: rows.filter((r) => r.status === 'CLUSTERED').length, suspects, skipped },
    themeSize: theme.size, declared: declared.length, min, rows,
    boundary: '**词面重合只是相关性的代理，不等于相关性**：借用方法/背景的正当旁证也可能词面很远 ⇒ 本工具**只报"疑似离题，请人工确认"，不出 FAIL**；'
      + '缺 title 且缺 abstract 的条目记 `CHECK_SKIPPED`（未核对 ≠ 通过）。人读项：这条引用到底有没有支撑正文那句话（判据在"引用了 ≠ 它支撑了"）。',
  };
}

function render(r) {
  const L = ['# 引用相关性弱机检（relevance gate）', ''];
  L.push('状态：**' + r.status + '**（条目 ' + r.counts.entries + ' · 合题 ' + r.counts.ok + ' · 簇内 ' + r.counts.clustered + ' · **疑似离题 ' + r.counts.suspects + '** · 未核对 ' + r.counts.skipped + '）');
  L.push('');
  L.push('主题词 ' + r.themeSize + ' 个（含显式关键词折权）· 阈值 ' + r.min);
  L.push('');
  L.push('| 条目 | 类型 | 判定 | 重合 | 命中 | 标题 |');
  L.push('|---|---|---|---|---|---|');
  for (const x of r.rows.slice().sort((a, b) => (a.overlap === undefined ? 9 : a.overlap) - (b.overlap === undefined ? 9 : b.overlap))) {
    L.push('| ' + x.key + ' | ' + (x.type || '?') + ' | ' + x.status + ' | ' + (x.overlap === undefined ? '—' : x.overlap) + ' | ' + (x.hits === undefined ? '—' : x.hits) + ' | ' + (x.title || '') + ' |');
  }
  L.push('');
  for (const x of r.rows) if (x.why) L.push('- [' + x.status + '] `' + x.key + '`：' + x.why);
  L.push('');
  L.push('> ' + r.boundary);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const BIB = (key, title, abs) => '@article{' + key + ',\n  title = {' + title + '},\n' + (abs ? '  abstract = {' + abs + '},\n' : '') + '}\n';
  const DRAFT = ('# Battery state of health prediction\nThe battery state of health prediction model uses dual protocol validation of capacity degradation. ' +
    'Battery state of health prediction with capacity degradation and dual protocol validation is central to this battery study. ').repeat(3);

  ck('正控：合题条目 ⇒ 不报离题（**被正文实际引用**时判 CITED_IN_TEXT，否则按重合判 OK）', () => {
    const r = analyse(DRAFT, BIB('ok1', 'Battery state of health prediction with capacity degradation', 'battery state of health prediction dual protocol validation capacity'), {});
    const st = r.rows[0].status;
    if (st === 'OFF_TOPIC_SUSPECT') return '合题条目被报离题：' + JSON.stringify(r.rows[0]);
    return (st === 'OK' || st === 'CITED_IN_TEXT') ? true : '未知状态 ' + st;
  });

  ck('★必失败面：完全离题（另一个领域）⇒ OFF_TOPIC_SUSPECT（REVIEW）', () => {
    const r = analyse(DRAFT, BIB('off1', 'Medieval poetry and monastic manuscript illumination in Provence', 'charters, vellum, scriptoria, latin palaeography, illuminated initials'), {});
    return (r.status === 'REVIEW' && r.rows[0].status === 'OFF_TOPIC_SUSPECT') ? true : JSON.stringify(r.rows);
  });

  ck('★必失败面：无 title 无 abstract ⇒ CHECK_SKIPPED（未核对 ≠ 通过）；全都没标题时整体 SKIP', () => {
    const r = analyse(DRAFT, '@misc{anon1,\n  note = {no title here}\n}\n', {});
    if (r.rows[0].status !== 'CHECK_SKIPPED') return '未记 CHECK_SKIPPED：' + JSON.stringify(r.rows);
    return (r.status === 'SKIP') ? true : '全都未核对却判 ' + r.status;
  });

  ck('★必失败面：缺正文且无 --keywords ⇒ SKIP（没有主题基线就谈不上离题）', () => {
    const r = analyse('   ', BIB('x', 'Some title', 'some abstract'), {});
    return (r.status === 'SKIP' && /主题基线/.test(r.why)) ? true : JSON.stringify(r);
  });

  ck('正控：离题但与其他条目同属一簇 ⇒ 降为 CLUSTERED（不是疑似离题）', () => {
    const bib = BIB('off2', 'Medieval poetry and monastic manuscript illumination', 'vellum scriptoria latin palaeography') + BIB('peer', 'Monastic manuscript illumination and medieval poetry', 'vellum scriptoria latin palaeography');
    const r = analyse(DRAFT, bib, {});
    const row = r.rows.find((x) => x.key === 'off2');
    return (row.status === 'CLUSTERED') ? true : JSON.stringify(r.rows);
  });

  ck('显式关键词可作主题基线（--keywords 时正文为空也能判）', () => {
    const r = analyse('', BIB('k1', 'Battery state of health prediction with capacity degradation', ''), { keywords: 'battery state of health, capacity degradation' });
    return (r.status === 'OK' && r.declared > 0) ? true : JSON.stringify(r.rows);
  });

  ck('阈值可覆盖：把 --min 抬到**高于该条实测重合**（相对写法，避免夹具没过阈值）⇒ 合题条目也会被判疑似', () => {
    const bib = BIB('ok2', 'Battery state of health prediction with capacity degradation', 'battery state of health prediction dual protocol validation');
    const a = analyse(DRAFT, bib, {});
    const raised = Math.round((a.rows[0].overlap + 0.05) * 100) / 100;
    const b = analyse(DRAFT, bib, { min: raised, noCiteRule: true });
    return (a.rows[0].status === 'OK' && b.rows[0].status !== 'OK') ? true : JSON.stringify([a.rows[0], b.rows[0], raised]);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nrelevance-gate 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const d = val('--draft'), b = val('--bib');
  if (!b) { console.error('前提层失败：需要 --bib <refs.bib>（可配 --draft <稿.md> 或 --keywords）'); return 2; }
  if (!fs.existsSync(path.resolve(b))) { console.error('前提层失败：.bib 不存在 —— ' + path.resolve(b)); return 2; }
  const draft = d ? (fs.existsSync(path.resolve(d)) ? fs.readFileSync(path.resolve(d), 'utf8') : '') : '';
  if (d && !draft) { console.error('前提层失败：稿件不存在 —— ' + path.resolve(d)); return 2; }
  const r = analyse(draft, fs.readFileSync(path.resolve(b), 'utf8'), { keywords: val('--keywords'), min: val('--min') === '' ? undefined : val('--min') });
  if (r.status === 'SKIP' && r.why) { console.error('SKIP：' + r.why + '（未核对 ≠ 通过）'); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  const out = val('--out'); const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('报告已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('状态：' + r.status + '（条目 ' + r.counts.entries + ' · 疑似离题 ' + r.counts.suspects + ' · 未核对 ' + r.counts.skipped + '）—— **本工具只报拟疑，不出 FAIL**');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyse, render, parseBib, words, main, selftest };
