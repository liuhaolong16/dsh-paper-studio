#!/usr/bin/env node
/**
 * refs-verify —— 引用核验门（**Task C 对拍产物**）：离线结构检查 + 在线元数据比对 + 撤稿检出。
 *
 * 由来与证据（`run/bakeoff/task-c-citations/`）：
 *   · 对手 `lifecycle-skills/skills/verify-citations/scripts/check_bibtex.py`（1855 行）检查面**远宽于我**（Crossref/DataCite/arXiv/DBLP/S2 五源 +
 *     TITLE/AUTHOR/YEAR_MISMATCH + DUPLICATE_* + MALFORMED_* + IMPLAUSIBLE_YEAR + CANONICAL_INSTANCE + RELEVANCE）⇒ 吸收其**判定分类**；
 *   · **但实测它整批中止**：Semantic Scholar 返回 429 时它退 1、**一条判定都没出**。本工具的取舍是 **fail-soft**：
 *     单一来源失败 ⇒ 该条记 `CHECK_SKIPPED`（明确"没核对"）**并继续**，绝不因此中止整批。
 *   · 我方原有缺陷（本轮修）：伪造 DOI 在 OpenAlex 是 **404**，此前被当成"取数失败"（与网络故障同形）⇒ 现在**三态**：`RESOLVED` / `NOT_FOUND` / `CHECK_SKIPPED`。
 *
 * 用法：
 *   node bin/refs-verify.cjs --bib refs.bib [--json] [--no-net]
 *   node bin/refs-verify.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DOI_RE = /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/;
const ARXIV_RE = /^(\d{4}\.\d{4,5}|[a-z-]+(\.[A-Z]{2})?\/\d{7})(v\d+)?$/;

/** 极简 BibTeX 解析（够用即可）：返回 [{key, type, fields, raw}]，并保留**重复 key**（不覆盖） */
function parseBib(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const out = [];
  const re = /@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const fields = {};
    const body = m[3];
    const fr = /(\w+)\s*=\s*\{([\s\S]*?)\}\s*,?/g;
    let f;
    while ((f = fr.exec(body)) !== null) fields[f[1].toLowerCase()] = f[2].replace(/\s+/g, ' ').trim();
    out.push({ key: (m[2] || '').trim(), type: (m[1] || '').toLowerCase(), fields, raw: m[0] });
  }
  return out;
}

const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
/** 词元 Jaccard 相似度（纯函数，用于标题比对；不自造语义判断） */
function similarity(a, b) {
  const A = new Set(normTitle(a).split(' ').filter(Boolean));
  const B = new Set(normTitle(b).split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return Math.round((inter / (A.size + B.size - inter)) * 100) / 100;
}

/** 离线结构检查（无网可跑） */
function offlineChecks(entries, opts) {
  const o = opts || {};
  const nowYear = o.nowYear || new Date().getFullYear();
  const findings = [];
  const seenKey = {}, seenDoi = {}, seenTitle = {};
  for (const e of entries) {
    const doi = (e.fields.doi || '').trim();
    const arxiv = (e.fields.eprint || e.fields.arxiv || '').trim();
    if (seenKey[e.key]) findings.push({ level: 'ERROR', check: 'DUPLICATE_KEY', key: e.key, msg: '键重复：' + e.key });
    seenKey[e.key] = true;
    if (doi) {
      if (seenDoi[doi]) findings.push({ level: 'ERROR', check: 'DUPLICATE_DOI', key: e.key, msg: 'DOI 重复：' + doi + '（另一条为 ' + seenDoi[doi] + '）' });
      seenDoi[doi] = e.key;
      if (!DOI_RE.test(doi)) findings.push({ level: 'ERROR', check: 'MALFORMED_DOI', key: e.key, msg: 'DOI 形状不合法：' + doi });
    }
    if (arxiv && !ARXIV_RE.test(arxiv)) findings.push({ level: 'ERROR', check: 'MALFORMED_ARXIV_ID', key: e.key, msg: 'arXiv id 形状不合法：' + arxiv });
    const nt = normTitle(e.fields.title);
    if (nt) {
      if (seenTitle[nt]) findings.push({ level: 'ERROR', check: 'DUPLICATE_TITLE', key: e.key, msg: '标题重复（归一后相同）：' + e.key + ' 与 ' + seenTitle[nt] });
      seenTitle[nt] = e.key;
    }
    const missing = ['title', 'author', 'year'].filter((f) => !e.fields[f]);
    if (missing.length) findings.push({ level: 'WARN', check: 'MISSING_FIELDS', key: e.key, msg: '缺字段：' + missing.join('/') });
    if (!doi && !arxiv) findings.push({ level: 'WARN', check: 'MISSING_DOI', key: e.key, msg: '既无 DOI 也无 arXiv id ⇒ 无法核验（不是通过）' });
    const y = Number(e.fields.year);
    if (e.fields.year && (!Number.isFinite(y) || y < 1600 || y > nowYear + 1)) {
      findings.push({ level: 'WARN', check: 'IMPLAUSIBLE_YEAR', key: e.key, msg: '年份不可信：' + e.fields.year });
    }
  }
  return findings;
}

/** Semantic Scholar 取数（免 key · 本机实测可达）：返回 {kind:'ok'|'not_found'|'error', via} */
function fetchSemanticScholar(doi) {
  const { spawnSync } = require('child_process');
  const url = 'https://api.semanticscholar.org/graph/v1/paper/DOI:' + encodeURIComponent(doi) + '?fields=title,year,citationCount,publicationTypes';
  /* ★ v3.17.0 实测：S2 会 429 限流（对手整批中止正是这个原因）⇒ 429 时**退避重试一次** */
  const once = () => {
    const r = spawnSync('curl', ['-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', '25', '-H', 'User-Agent: paper-studio/3.16.0 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return { code: '000', body: '' };
    const out = String(r.stdout || '');
    return { code: (out.match(/\n(\d{3})$/) || [])[1], body: out.replace(/\n\d{3}$/, '') };
  };
  let res = once();
  if (res.code === '429') { const wait = 2000; const t0 = Date.now(); while (Date.now() - t0 < wait) { /* 退避 */ } res = once(); res.retried = true; }
  if (res.code === '404') return { kind: 'not_found', via: 'semanticscholar', reason: 'HTTP 404' };
  if (res.code !== '200') return { kind: 'error', via: 'semanticscholar', reason: 'HTTP ' + res.code + (res.retried ? '（已重试一次）' : '') };
  try {
    const j = JSON.parse(res.body);
    return { kind: 'ok', via: 'semanticscholar', title: j.title, year: j.year, citations: j.citationCount || 0, type: (j.publicationTypes || [])[0] || null, is_retracted: false };
  } catch (e) { return { kind: 'error', via: 'semanticscholar', reason: 'JSON 解析失败' }; }
}

/** DataCite 取数（免 key · 本机实测可达；DOI 不在 DataCite 时返回 404 —— 这不等于"伪造"，故标记为 not_in_source） */
function fetchDataCite(doi) {
  const { spawnSync } = require('child_process');
  const url = 'https://api.datacite.org/dois/' + encodeURIComponent(doi);
  const r = spawnSync('curl', ['-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', '25', '-H', 'User-Agent: paper-studio/3.16.0 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return { kind: 'error', via: 'datacite', reason: 'curl 失败' };
  const out = String(r.stdout || '');
  const code = (out.match(/\n(\d{3})$/) || [])[1];
  const body = out.replace(/\n\d{3}$/, '');
  if (code === '404') return { kind: 'not_in_source', via: 'datacite', reason: 'HTTP 404（DataCite 未收录）' };
  if (code !== '200') return { kind: 'error', via: 'datacite', reason: 'HTTP ' + code };
  try {
    const j = JSON.parse(body);
    const a = (j.data && j.data.attributes) || {};
    const yr = a.publicationYear || (a.dates || []).map((d) => parseInt(d.date, 10)).find((x) => x > 1900);
    return { kind: 'ok', via: 'datacite', title: (a.titles && a.titles[0] && a.titles[0].title) || null, year: yr || null, citations: a.citationCount || 0, type: (a.types && a.types.resourceTypeGeneral) || null, is_retracted: false };
  } catch (e) { return { kind: 'error', via: 'datacite', reason: 'JSON 解析失败' }; }
}

/**
 * ★ v3.17.0 多源回落：OpenAlex → Semantic Scholar → DataCite。
 * 纪律（对拍换来的）：**单一来源失败不拖垮整批**；且要能区分三件事 ——
 *   · 三源都说 404 ⇒ not_found（疑似伪造）· 全失败 ⇒ error（未核对）· 某源不收录 ⇒ 继续下一源
 */
function fetchWithFallback(doi, opts) {
  const o = opts || {};
  const chain = o.chain || [fetchOpenAlex, fetchSemanticScholar, fetchDataCite];
  const tried = [];
  let notFound = 0, neutral = 0;
  for (const fn of chain) {
    let r;
    try { r = fn(doi); } catch (e) { r = { kind: 'error', reason: String((e && e.message) || e) , via: (fn && fn.name) || '?' }; }
    tried.push((r && r.via) || (fn && fn.name) || '?');
    if (r && r.kind === 'ok') { r.via = r.via || 'unknown'; r.tried = tried; return r; }
    if (r && r.kind === 'not_found') { notFound += 1; continue; }   /* 一个源说不存在 ≠ 全都说不存在 */
    if (r && r.kind === 'not_in_source') { neutral += 1; continue; } /* 该源未收录此 DOI：中性，不算失败也不算不存在 */
  }
  /* 有一源明确 404、其余只是"未收录"（中性）⇒ 视为 not_found（疑似伪造）；
     全都没给出 404（都是失败/未收录）⇒ error（未核对，不中止整批） */
  if (notFound >= 1 && notFound + neutral === tried.length) return { kind: 'not_found', via: tried[0], tried };
  return { kind: 'error', reason: '所有来源均未取到（' + tried.join(' → ') + '；其中 404 ' + notFound + ' 个）', tried };
}

/** 按标题找同名的其他版本（OpenAlex）。返回 [{id,doi,title,year,type,citations}]；失败返回 null（fail-soft） */
function fetchTitleMatches(title, opts) {
  const o = opts || {};
  if (o.injectedTitleMatches) return o.injectedTitleMatches(title);
  const { spawnSync } = require('child_process');
  const q = encodeURIComponent(String(title || '').slice(0, 180));
  const url = 'https://api.openalex.org/works?search=' + q + '&per-page=5&select=id,doi,title,publication_year,type,cited_by_count';
  const r = spawnSync('curl', ['-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', '25', '-H', 'User-Agent: paper-studio/3.13.0 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const out = String(r.stdout || '');
  const code = (out.match(/\n(\d{3})$/) || [])[1];
  if (code !== '200') return null;
  try {
    const j = JSON.parse(out.replace(/\n\d{3}$/, ''));
    return (j.results || []).map((w) => ({ id: w.id, doi: w.doi, title: w.title, year: w.publication_year, type: w.type, citations: w.cited_by_count || 0 }));
  } catch (e) { return null; }
}

/** 版本核验：当前条目解析到的 instance vs 同名其他 instance */
function canonicalCheck(entry, rec, matches, opts) {
  const o = opts || {};
  const minRatio = o.minRatio || 2, minGap = o.minGap || 10;
  const findings = [];
  if (matches === null || matches === undefined) return [{ level: 'INFO', check: 'CHECK_SKIPPED', key: entry.key, msg: '标题检索失败 ⇒ **版本核验未完成**（未核对 ≠ 通过）' }];
  const cur = rec || {};
  const curId = cur.id || null;
  const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
  const base = normTitle(cur.title || entry.fields.title);
  const higher = [];
  for (const m of matches) {
    if (curId && m.id === curId) continue;
    if (!base || normTitle(m.title) !== base) continue;      /* 只比**同名**，避免把"相关但不同"的作品当版本 */
    const curCit = cur.citations || 0;
    const formal = /^(article|review)$/i.test(String(m.type || ''));
    const curInformal = /^(preprint|report|dissertation|book-chapter)$/i.test(String(cur.type || ''));
    if ((m.citations >= Math.max(curCit * minRatio, curCit + minGap)) || (formal && curInformal)) {
      higher.push(m);
    }
  }
  /* ★ v3.13.0：**先证过程真的跑了** —— 查过但没有替代实例时也要留痕，否则读者分不清「查了没问题」与「没跑」 */
  if (!higher.length && matches.length) {
    findings.push({ level: 'INFO', check: 'CANONICAL_OK', key: entry.key, msg: '版本核验已执行：同名命中 ' + matches.length + ' 条，其中无更权威实例（当前条目即最优）' });
  }
  if (higher.length) {
    const list = higher.slice(0, 3).map((m) => (m.year || '?') + ' · ' + (m.type || '?') + ' · 引用 ' + (m.citations || 0) + ' · ' + String(m.doi || m.id || '')).join(' ｜ ');
    findings.push({ level: 'WARN', check: 'CANONICAL_INSTANCE', key: entry.key, msg: '同名作品存在**另一实例**（本领域通常引正式版）：当前 = ' + (cur.year || '?') + ' · ' + (cur.type || '?') + ' · 引用 ' + (cur.citations || 0) + ' ⇒ 可选：' + list + '（**只提醒，不自动改**）' });
  }
  return findings;
}

/** 元数据比对：把索引记录与条目逐字段比（索引值为准，条目值错则报） */
function compareMetadata(entry, rec) {
  const f = [];
  if (!rec) return [{ level: 'INFO', check: 'CHECK_SKIPPED', key: entry.key, msg: '索引无记录 ⇒ 该项未核对（不是通过）' }];
  const yEntry = Number(entry.fields.year), yIdx = Number(rec.year);
  if (Number.isFinite(yEntry) && Number.isFinite(yIdx) && yEntry !== yIdx) {
    f.push({ level: 'ERROR', check: 'YEAR_MISMATCH', key: entry.key, msg: '年份不符：条目 ' + yEntry + ' vs 索引 ' + yIdx });
  }
  /* ★ 索引标题的撤稿/关切前缀要在比对前剥掉（真撤稿论文的正常条目不该被算成标题不符） */
  const stripMark = (s) => String(s || '').replace(/^\s*(RETRACTED|Retracted|RETRACTION|Expression of Concern|EXPRESSION OF CONCERN)\s*:?\s*/i, '');
  const sim = similarity(entry.fields.title, stripMark(rec.title));
  if (entry.fields.title && stripMark(rec.title) && sim < 0.6) {
    f.push({ level: 'ERROR', check: 'TITLE_MISMATCH', key: entry.key, msg: '标题不符（相似度 ' + sim + '）：条目「' + String(entry.fields.title).slice(0, 40) + '…」 vs 索引「' + String(rec.title).slice(0, 40) + '…」' });
  } else if (sim > 0 && sim < 0.85) {
    f.push({ level: 'WARN', check: 'TITLE_PARTIAL_MATCH', key: entry.key, msg: '标题部分相符（相似度 ' + sim + '）' });
  }
  if (rec.is_retracted) f.push({ level: 'ERROR', check: 'RETRACTED', key: entry.key, msg: '该文献已被撤稿（索引标记 retracted）' });
  return f;
}

/** 主核验：fail-soft —— 单条取数失败只记 CHECK_SKIPPED，不中止整批 */
function verify(entries, opts) {
  const o = opts || {};
  const offline = offlineChecks(entries, o);
  if (o.noNet || typeof o.fetchRecord !== 'function') {
    return { entries: entries.map((e) => ({ key: e.key, status: 'CHECK_SKIPPED', reason: o.noNet ? '按 --no-net 跳过在线核验' : '未注入取数函数' })), findings: offline, note: '离线模式：只跑了结构检查（在线核验未做 ⇒ 不是通过）' };
  }
  const rows = [];
  const findings = offline.slice();
  for (const e of entries) {
    const doi = (e.fields.doi || '').trim();
    if (!doi || !DOI_RE.test(doi)) { rows.push({ key: e.key, status: 'CHECK_SKIPPED', reason: '无合法 DOI ⇒ 未做在线核验' }); continue; }
    let r;
    try { r = o.fetchRecord(doi); } catch (err) { r = { kind: 'error', reason: String((err && err.message) || err) }; }
    if (!r || r.kind === 'error') {
      rows.push({ key: e.key, status: 'CHECK_SKIPPED', reason: '取数失败（视为未核对，不中止整批）：' + ((r && r.reason) || '未知') });
      findings.push({ level: 'INFO', check: 'CHECK_SKIPPED', key: e.key, msg: '在线核验未完成 ⇒ 该条未核对' });
      continue;
    }
    if (r.kind === 'not_found') {
      rows.push({ key: e.key, status: 'NOT_FOUND', reason: '索引 404：DOI 不存在（疑似伪造）' });
      findings.push({ level: 'ERROR', check: 'UNRESOLVED', key: e.key, msg: 'DOI 在索引中不存在（404）：' + doi });
      continue;
    }
    rows.push({ key: e.key, status: 'RESOLVED', index_title: r.title, index_year: r.year, is_retracted: !!r.is_retracted, via: r.via || 'injected', tried: r.tried || null });
    for (const x of compareMetadata(e, r)) findings.push(x);
    /* ★ v3.13.0 版本核验（默认关，`--canonical` 开）：同名的**其他实例**（预印本 vs 正式版 / 报告 vs 论文） */
    if (o.canonical && e.fields.title) {
      const matches = typeof o.fetchTitleMatches === 'function' ? o.fetchTitleMatches(e.fields.title) : null;
      for (const x of canonicalCheck(e, r, matches, o)) findings.push(x);
    }
  }
  const nErr = findings.filter((x) => x.level === 'ERROR').length;
  /* ★ v3.17.0 来源分布：让"这次到底靠哪个源查到的"可见（单一来源失败不影响整批） */
  const viaCounts = {};
  for (const r of rows) if (r.via) viaCounts[r.via] = (viaCounts[r.via] || 0) + 1;
  return { entries: rows, findings, summary: { entries: entries.length, resolved: rows.filter((r) => r.status === 'RESOLVED').length, not_found: rows.filter((r) => r.status === 'NOT_FOUND').length, skipped: rows.filter((r) => r.status === 'CHECK_SKIPPED').length, errors: nErr, warns: findings.filter((x) => x.level === 'WARN').length, sources: viaCounts }, status: nErr ? 'FAIL' : 'PASS' };
}

/** 默认在线取数（OpenAlex；用 curl，404 与取数失败分三态） */
function fetchOpenAlex(doi) {
  const { spawnSync } = require('child_process');
  const url = 'https://api.openalex.org/works/doi:' + encodeURIComponent(doi) + '?select=id,doi,title,publication_year,is_retracted,cited_by_count';
  const r = spawnSync('curl', ['-sS', '-o', '-', '-w', '\n%{http_code}', '--max-time', '25', '-H', 'User-Agent: paper-studio/3.6.0 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) return { kind: 'error', via: 'openalex', reason: 'curl 退出码 ' + r.status };
  const out = String(r.stdout || '');
  const code = (out.match(/\n(\d{3})$/) || [])[1];
  const body = out.replace(/\n\d{3}$/, '');
  if (code === '404') return { kind: 'not_found', via: 'openalex' };
  if (code !== '200') return { kind: 'error', via: 'openalex', reason: 'HTTP ' + code };
  try { const j = JSON.parse(body); return { kind: 'ok', via: 'openalex', title: j.title, year: j.publication_year, is_retracted: !!j.is_retracted, citations: j.cited_by_count }; }
  catch (e) { return { kind: 'error', via: 'openalex', reason: '返回体不是 JSON（HTTP ' + code + '）' }; }
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const BIB = (key, doi, title, year) => '@article{' + key + ',\n  title = {' + title + '},\n  author = {A B},\n  year = {' + year + '},\n  doi = {' + doi + '}\n}';

  ck('解析：能取出 key/type/fields，且**重复 key 不覆盖**（否则查不出 DUPLICATE_KEY）', () => {
    const e = parseBib(BIB('k1', '10.1/aa', 'T', 2020) + '\n\n' + BIB('k1', '10.1/bb', 'T2', 2021));
    return (e.length === 2 && e[0].key === 'k1' && e[1].fields.doi === '10.1/bb') ? true : JSON.stringify(e);
  });

  ck('离线：重复 DOI / 重复标题 / 非法 DOI / 不可信年份 都能报', () => {
    const e = parseBib(BIB('a', '10.1/aa', 'Same Title', 2020) + '\n\n' + BIB('b', '10.1/aa', 'Same Title', 2020) + '\n\n' + BIB('c', 'not-a-doi', 'X', 2999));
    const f = offlineChecks(e, { nowYear: 2026 });
    const kinds = f.map((x) => x.check);
    for (const want of ['DUPLICATE_DOI', 'DUPLICATE_TITLE', 'MALFORMED_DOI', 'IMPLAUSIBLE_YEAR']) {
      if (kinds.indexOf(want) < 0) return '缺 ' + want + '：' + JSON.stringify(kinds);
    }
    return true;
  });

  ck('★必失败面：伪造 DOI（索引 404）⇒ 必须判 NOT_FOUND 且报 UNRESOLVED（不许与"取数失败"同形）', () => {
    const e = parseBib(BIB('fake', '10.9999/j.fake.2026.00001', 'Nonexistent', 2026));
    const r = verify(e, { fetchRecord: () => ({ kind: 'not_found' }) });
    return (r.entries[0].status === 'NOT_FOUND' && r.findings.some((x) => x.check === 'UNRESOLVED') && r.status === 'FAIL') ? true : JSON.stringify(r);
  });

  ck('★必失败面：年份不符 ⇒ YEAR_MISMATCH（ERROR）', () => {
    const e = parseBib(BIB('w', '10.1136/bmj.n71', 'The PRISMA 2020 statement', 2019));
    const r = verify(e, { fetchRecord: () => ({ kind: 'ok', title: 'The PRISMA 2020 statement', year: 2021, is_retracted: false }) });
    return (r.findings.some((x) => x.check === 'YEAR_MISMATCH' && x.level === 'ERROR')) ? true : JSON.stringify(r.findings);
  });

  ck('★必失败面：撤稿文献 ⇒ RETRACTED（ERROR）', () => {
    const e = parseBib(BIB('ret', '10.1016/S0140-6736(97)11096-0', 'Ileal-lymphoid-nodular hyperplasia', 1998));
    const r = verify(e, { fetchRecord: () => ({ kind: 'ok', title: 'RETRACTED: Ileal-lymphoid-nodular hyperplasia', year: 1998, is_retracted: true }) });
    return (r.findings.some((x) => x.check === 'RETRACTED')) ? true : JSON.stringify(r.findings);
  });

  ck('★必失败面（吸收其教训）：**单一来源取数失败不得中止整批** —— 其余条目仍须有判定', () => {
    const e = parseBib(BIB('ok1', '10.1136/bmj.n71', 'The PRISMA 2020 statement', 2021) + '\n\n' + BIB('err1', '10.1234/xx', 'Whatever', 2020));
    const r = verify(e, { fetchRecord: (doi) => (doi === '10.1136/bmj.n71' ? { kind: 'ok', title: 'The PRISMA 2020 statement', year: 2021 } : { kind: 'error', reason: 'HTTP 429' } ) });
    const okRow = r.entries.find((x) => x.key === 'ok1');
    const errRow = r.entries.find((x) => x.key === 'err1');
    return (okRow.status === 'RESOLVED' && errRow.status === 'CHECK_SKIPPED' && /429/.test(errRow.reason)) ? true : JSON.stringify(r.entries);
  });

  ck('未注入取数函数 ⇒ 全部记 CHECK_SKIPPED（离线不等于通过）', () => {
    const e = parseBib(BIB('a', '10.1234/aa', 'T', 2020));
    const r = verify(e, {});
    return (r.entries[0].status === 'CHECK_SKIPPED') ? true : JSON.stringify(r);
  });

  ck('v3.13.0·canonical·★必失败面：同名作品存在**引用更高的正式版** ⇒ 必须报 CANONICAL_INSTANCE（附替代项与引用数）', () => {
    const e = parseBib(BIB('p', '10.1234/aa', 'Highly accurate protein structure prediction with AlphaFold', 2021));
    const r = verify(e, {
      canonical: true, fetchRecord: () => ({ kind: 'ok', id: 'W1', title: 'Highly accurate protein structure prediction with AlphaFold', year: 2021, type: 'preprint', citations: 5 }),
      fetchTitleMatches: () => [
        { id: 'W1', title: 'Highly accurate protein structure prediction with AlphaFold', year: 2021, type: 'preprint', citations: 5 },
        { id: 'W2', doi: '10.1038/s41586-021-03819-2', title: 'Highly accurate protein structure prediction with AlphaFold', year: 2021, type: 'article', citations: 30000 },
      ],
    });
    const hit = r.findings.find((x) => x.check === 'CANONICAL_INSTANCE');
    if (!hit) return '未报版本问题：' + JSON.stringify(r.findings);
    if (!/30000/.test(hit.msg)) return '未列出替代项引用数：' + hit.msg;
    if (!/只提醒，不自动改/.test(hit.msg)) return '未声明只提醒：' + hit.msg;
    return true;
  });

  ck('v3.13.0·canonical·反面对照：只有**同一个**实例时不报（不误报）', () => {
    const e = parseBib(BIB('q', '10.1234/bb', 'A study of something specific', 2020));
    const r = verify(e, {
      canonical: true, fetchRecord: () => ({ kind: 'ok', id: 'W9', title: 'A study of something specific', year: 2020, type: 'article', citations: 100 }),
      fetchTitleMatches: () => [{ id: 'W9', title: 'A study of something specific', year: 2020, type: 'article', citations: 100 }],
    });
    return r.findings.some((x) => x.check === 'CANONICAL_INSTANCE') ? '误报：' + JSON.stringify(r.findings) : true;
  });

  ck('v3.13.0·canonical·★必失败面：标题检索失败 ⇒ 记 CHECK_SKIPPED（未核对 ≠ 通过）', () => {
    const e = parseBib(BIB('s', '10.1234/cc', 'Some title here', 2021));
    const r = verify(e, { canonical: true, fetchRecord: () => ({ kind: 'ok', id: 'W1', title: 'Some title here', year: 2021 }), fetchTitleMatches: () => null });
    return r.findings.some((x) => x.check === 'CHECK_SKIPPED') ? true : JSON.stringify(r.findings);
  });

  ck('v3.13.0·canonical·过程可见：查过但无替代实例 ⇒ 必须留 CANONICAL_OK（先证过程真跑了）', () => {
    const e = parseBib(BIB('t', '10.1234/dd', 'A very specific study title here', 2021));
    const r = verify(e, {
      canonical: true, fetchRecord: () => ({ kind: 'ok', id: 'W1', title: 'A very specific study title here', year: 2021, type: 'article', citations: 50 }),
      fetchTitleMatches: () => [{ id: 'W1', title: 'A very specific study title here', year: 2021, type: 'article', citations: 50 }],
    });
    return r.findings.some((x) => x.check === 'CANONICAL_OK') ? true : JSON.stringify(r.findings);
  });

  /* ★ v3.17.0 多源回落（对拍换来的纪律：单一来源失败不拖垮整批；且要分清 404 与失败） */
  const mk = (kind, via, extra) => () => Object.assign({ kind, via }, extra || {});

  ck('v3.17.0·回落·★必失败面：**主源失败但备源成功** ⇒ 仍判 ok 且标出来源（不中止整批）', () => {
    const r = fetchWithFallback('10.1/x', { chain: [mk('error', 'openalex'), mk('ok', 'semanticscholar', { title: 'T', year: 2021 })] });
    return (r.kind === 'ok' && r.via === 'semanticscholar' && r.tried.join(',') === 'openalex,semanticscholar') ? true : JSON.stringify(r);
  });

  ck('v3.17.0·回落·★必失败面：**某源 not_found 但另一源 ok** ⇒ 判 ok（一个源说不存在 ≠ 全都说不存在）', () => {
    const r = fetchWithFallback('10.1/y', { chain: [mk('not_found', 'openalex'), mk('ok', 'datacite', { title: 'T', year: 2020 })] });
    return (r.kind === 'ok' && r.via === 'datacite') ? true : JSON.stringify(r);
  });

  ck('v3.17.0·回落·★必失败面：**全部来源 404** ⇒ not_found（疑似伪造），而不是 error', () => {
    const r = fetchWithFallback('10.1/z', { chain: [mk('not_found', 'openalex'), mk('not_found', 'semanticscholar'), mk('not_found', 'datacite')] });
    return (r.kind === 'not_found') ? true : JSON.stringify(r);
  });

  ck('v3.17.0·回落·★必失败面：**全部失败** ⇒ error（未核对），绝不能当通过', () => {
    const r = fetchWithFallback('10.1/w', { chain: [mk('error', 'openalex'), mk('error', 'semanticscholar')] });
    if (r.kind !== 'error') return '应为 error：' + JSON.stringify(r);
    const e = parseBib(BIB('m', '10.1234/zz', 'Some title', 2021));
    const v = verify(e, { fetchRecord: () => r });
    return (v.entries[0].status === 'CHECK_SKIPPED') ? true : '未被记为未核对：' + JSON.stringify(v.entries[0]);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nrefs-verify 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const bib = val('--bib');
  if (!bib || !fs.existsSync(bib)) { console.error('前提层失败：需要 --bib <存在的 .bib 文件>（未核对，不得当通过）'); return 2; }
  const entries = parseBib(fs.readFileSync(bib, 'utf8'));
  if (!entries.length) { console.error('解析出 0 条条目 ⇒ 未核对（不是通过）'); return 2; }
  const noNet = argv.includes('--no-net');
  const canonical = argv.includes('--canonical');
  /* 可跳过某个来源（实践中确有需要：某源慢/被限流）；也让"回落真的会发生"可以被**实测**验证 */
  const skip = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--skip-source' && argv[i + 1]) skip.push(argv[++i]);
  const SOURCES = [['openalex', fetchOpenAlex], ['semanticscholar', fetchSemanticScholar], ['datacite', fetchDataCite]];
  const chain = SOURCES.filter(([n]) => skip.indexOf(n) < 0).map(([, f]) => f);
  if (!chain.length) { console.error('前提层失败：--skip-source 跳过了全部来源 ⇒ 无法核验（未核对 ≠ 通过）'); return 2; }
  const r = verify(entries, { noNet, canonical, fetchRecord: noNet ? null : (doi) => fetchWithFallback(doi, { chain }), fetchTitleMatches: noNet ? null : fetchTitleMatches, nowYear: new Date().getFullYear() });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 2 : 0; }
  console.log('引用核验（' + entries.length + ' 条' + (noNet ? ' · 离线' : ' · 在线多源 ' + chain.map((f) => f.name.replace(/^fetch/, '')).join(' → ')) + '）：' + r.status);
  for (const e of r.entries) console.log('  ' + e.key.padEnd(20) + e.status + (e.via ? '（via ' + e.via + '）' : '') + (e.reason ? '（' + e.reason + '）' : '') + (e.is_retracted ? ' · 已撤稿' : ''));
  for (const f of r.findings) console.log('  [' + f.level + '/' + f.check + '] ' + (f.key ? f.key + '：' : '') + f.msg);
  if (r.summary) console.log('  合计：解析 ' + r.summary.resolved + ' · 不存在 ' + r.summary.not_found + ' · 未核对 ' + r.summary.skipped + ' · ERROR ' + r.summary.errors + ' · WARN ' + r.summary.warns + (r.summary.sources && Object.keys(r.summary.sources).length ? ' · 来源 ' + JSON.stringify(r.summary.sources) : ''));
  return r.status === 'FAIL' ? 2 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseBib, offlineChecks, compareMetadata, verify, fetchOpenAlex, fetchSemanticScholar, fetchDataCite, fetchWithFallback, similarity, normTitle, main, selftest };
