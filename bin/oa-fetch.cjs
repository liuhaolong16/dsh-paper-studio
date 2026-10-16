#!/usr/bin/env node
/**
 * oa-fetch —— OpenAlex / Unpaywall 取数层（**吸收自 SkillHub `academic-research` 的两个真缺口**）。
 *
 * 吸收来源与边界（详见 `references/skillhub-comparison.md`）：
 *   · ① **Unpaywall 兜底 OA-PDF 直链** —— 他们有、我们没有 ⇒ 补上。
 *   · ② **24h 磁盘缓存**（md5(url+params) 为键）—— 他们有、我们没有 ⇒ 补上（落 `run/.cache/oa/`，不用 `/tmp`）。
 *   · ③ 他们**硬编码他人邮箱** `topanga@ludwitt.com` 作礼貌池 —— **不学**：我方邮箱只从环境变量取，缺则**不带 mailto** 并明说。
 *   · 他们的失败态是"返回空/None（取不到与没有不分）" —— **不学**：本工具一律 **PASS / SKIP / FAIL 三态**，缺输入记 SKIP。
 *
 * 用法：
 *   node bin/oa-fetch.cjs --doi 10.1038/s41586-021-03819-2 [--json] [--no-cache]
 *   node bin/oa-fetch.cjs --pdf 10.1038/s41586-021-03819-2        # 只解析 OA PDF 直链
 *   node bin/oa-fetch.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, 'run', '.cache', 'oa');
const TTL_MS = 24 * 60 * 60 * 1000;

/** 我方联系方式：只从环境变量取（★不硬编码他人邮箱——这是吸收时明确不学的做法） */
function contactEmail(env) {
  const e = env || process.env;
  return String(e.PAPER_STUDIO_CONTACT_EMAIL || e.OPENALEX_MAILTO || '').trim();
}

/** 重建 OpenAlex 倒排索引摘要（他们也有此做法；我方 studio.cjs 早已实现，这里做成可复用纯函数） */
function rebuildAbstract(inv) {
  if (!inv || typeof inv !== 'object' || !Object.keys(inv).length) return null;   // ★ 空索引 ⇒ null，绝不返回空串假装"有摘要"
  let max = -1;
  for (const k of Object.keys(inv)) {
    const arr = Array.isArray(inv[k]) ? inv[k] : [];
    for (const p of arr) if (Number.isFinite(p) && p > max) max = p;
  }
  if (max < 0) return null;
  const words = new Array(max + 1).fill('');
  for (const k of Object.keys(inv)) for (const p of (Array.isArray(inv[k]) ? inv[k] : [])) if (Number.isFinite(p) && p >= 0 && p <= max) words[p] = k;
  const s = words.join(' ').replace(/\s+/g, ' ').trim();
  return s || null;
}

const cacheKeyOf = (url, params) => crypto.createHash('md5').update(url + JSON.stringify(params || {})).digest('hex');

/**
 * 取 JSON（带 24h 磁盘缓存）。opts.fetchJson 可注入（夹具用，离线）。
 * 返回 { status: 'PASS'|'SKIP', data, from_cache, reason }
 */
function oaGet(url, params, opts) {
  const o = opts || {};
  const key = cacheKeyOf(url, params);
  const file = path.join(o.cacheDir || CACHE_DIR, key + '.json');
  if (!o.noCache) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < (o.ttlMs || TTL_MS)) {
        return { status: 'PASS', data: JSON.parse(fs.readFileSync(file, 'utf8')), from_cache: true };
      }
    } catch (e) { /* 无缓存或损坏 ⇒ 继续取 */ }
  }
  if (typeof o.fetchJson !== 'function') return { status: 'SKIP', data: null, from_cache: false, reason: '未提供取数函数（离线/未注入）⇒ 未核对' };
  let data;
  try { data = o.fetchJson(url, params); } catch (e) { return { status: 'SKIP', data: null, from_cache: false, reason: '取数失败：' + String((e && e.message) || e) }; }
  if (!data || typeof data !== 'object') return { status: 'SKIP', data: null, from_cache: false, reason: '返回体不是对象（未核对）' };
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data), 'utf8'); } catch (e) { /* 缓存写失败不影响结果 */ }
  return { status: 'PASS', data, from_cache: false };
}

/** 组 OpenAlex work URL（礼貌池：有邮箱才带 mailto，且**只带自己的**） */
function workUrl(doi, email) {
  const clean = String(doi || '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  const sel = 'select=id,doi,title,publication_year,cited_by_count,open_access,best_oa_location,abstract_inverted_index,is_retracted,type';
  return 'https://api.openalex.org/works/doi:' + encodeURIComponent(clean) + '?' + sel + (email ? '&mailto=' + encodeURIComponent(email) : '');
}

/** Unpaywall：拿 OA PDF 直链。**无邮箱 ⇒ SKIP**（Unpaywall 要求 who-is-calling；我们不冒用他人身份） */
function unpaywall(doi, opts) {
  const o = opts || {};
  const email = o.email !== undefined ? o.email : contactEmail(o.env);
  const clean = String(doi || '').trim().replace(/^https?:\/\/doi\.org\//i, '');
  if (!clean) return { status: 'SKIP', reason: '未给 DOI ⇒ 未核对', url: null };
  if (!email) return { status: 'SKIP', reason: '未配置联系邮箱（PAPER_STUDIO_CONTACT_EMAIL / OPENALEX_MAILTO）⇒ Unpaywall 需要 who-is-calling，本工具不冒用他人邮箱 ⇒ SKIP（不是通过）', url: null };
  const url = 'https://api.unpaywall.org/v2/' + encodeURIComponent(clean) + '?email=' + encodeURIComponent(email);
  const r = oaGet(url, {}, o);
  if (r.status !== 'PASS') return { status: r.status, reason: r.reason, url: null };
  const best = (r.data && r.data.best_oa_location) || {};
  return { status: 'PASS', url: best.url_for_pdf || best.url || null, from_cache: r.from_cache, is_oa: !!(r.data && r.data.is_oa), license: (r.data && r.data.license) || null };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'oaf-'));

  ck('摘要重建：倒排索引能还原原句；**空索引必须返回 null**（不许用空串假装有摘要）', () => {
    const inv = { 'Hello': [0], 'world': [1], 'again': [2] };
    if (rebuildAbstract(inv) !== 'Hello world again') return '还原错：' + rebuildAbstract(inv);
    if (rebuildAbstract({}) !== null) return '空索引应返回 null';
    if (rebuildAbstract(null) !== null) return 'null 索引应返回 null';
    return true;
  });

  ck('礼貌池：**只从环境变量取邮箱**，缺失则为空（绝不硬编码他人邮箱）', () => {
    if (contactEmail({}) !== '') return '无环境变量应为空';
    if (contactEmail({ OPENALEX_MAILTO: ' me@example.org ' }) !== 'me@example.org') return '应去空白';
    if (/ludwitt|topanga/i.test(JSON.stringify([contactEmail({}), workUrl('10.1/x', contactEmail({}))]))) return '出现了他人邮箱痕迹';
    return true;
  });

  ck('缓存：第二次读取命中缓存，且**回执标明来自缓存**（不伪装成刚取到）', () => {
    const d = tmp(); let calls = 0;
    const fetchJson = () => { calls += 1; return { ok: 1, n: calls }; };
    const a = oaGet('https://x.test/a', { q: 1 }, { cacheDir: d, fetchJson });
    const b = oaGet('https://x.test/a', { q: 1 }, { cacheDir: d, fetchJson });
    fs.rmSync(d, { recursive: true, force: true });
    if (a.from_cache !== false || b.from_cache !== true) return JSON.stringify([a.from_cache, b.from_cache]);
    return calls === 1 ? true : ('第二次不应再取数，实际调用 ' + calls + ' 次');
  });

  ck('缓存：--no-cache 必须绕过缓存重新取数', () => {
    const d = tmp(); let calls = 0;
    const fetchJson = () => { calls += 1; return { n: calls }; };
    oaGet('https://x.test/b', {}, { cacheDir: d, fetchJson });
    const c = oaGet('https://x.test/b', {}, { cacheDir: d, fetchJson, noCache: true });
    fs.rmSync(d, { recursive: true, force: true });
    return (calls === 2 && c.from_cache === false) ? true : JSON.stringify({ calls: calls, from_cache: c.from_cache });
  });

  ck('★Unpaywall 必失败面：未配置邮箱 ⇒ SKIP 并写明原因（不得当通过、不得冒用他人身份）', () => {
    const r = unpaywall('10.1038/x', { email: '', env: {} });
    return (r.status === 'SKIP' && /who-is-calling/.test(r.reason) && r.url === null) ? true : JSON.stringify(r);
  });

  ck('★必失败面：未注入取数函数 ⇒ SKIP（离线不等于通过）', () => {
    const d = tmp();
    const r = oaGet('https://x.test/c', {}, { cacheDir: d });
    fs.rmSync(d, { recursive: true, force: true });
    return (r.status === 'SKIP' && /未提供取数函数/.test(r.reason)) ? true : JSON.stringify(r);
  });

  ck('★必失败面：返回体不是对象 ⇒ SKIP', () => {
    const d = tmp();
    const r = oaGet('https://x.test/d', {}, { cacheDir: d, fetchJson: () => null });
    fs.rmSync(d, { recursive: true, force: true });
    return (r.status === 'SKIP' && r.data === null) ? true : JSON.stringify(r);
  });

  ck('Unpaywall 正控：注入取数后取到 OA PDF 直链', () => {
    const d = tmp();
    const r = unpaywall('10.1/ok', { email: 'me@example.org', cacheDir: d, fetchJson: () => ({ is_oa: true, best_oa_location: { url_for_pdf: 'https://repo.example/x.pdf' } }) });
    fs.rmSync(d, { recursive: true, force: true });
    return (r.status === 'PASS' && r.url === 'https://repo.example/x.pdf' && r.is_oa === true) ? true : JSON.stringify(r);
  });

  ck('URL 组装：DOI 前缀被剥掉，且**无邮箱时不出现 mailto**', () => {
    const a = workUrl('https://doi.org/10.1/abc', '');
    const b = workUrl('10.1/abc', 'me@example.org');
    if (/mailto/.test(a)) return '无邮箱不该带 mailto：' + a;
    if (!/doi:10\.1%2Fabc/.test(a)) return 'DOI 未正确编码：' + a;
    return /mailto=me%40example\.org/.test(b) ? true : ('带邮箱时应出现 mailto：' + b);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\noa-fetch 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const doi = val('--doi') || val('--pdf');
  const json = argv.includes('--json');
  const email = contactEmail();
  if (!doi) {
    const r = { status: 'SKIP', reason: '未给 --doi / --pdf ⇒ 未核对' };
    console.log(json ? JSON.stringify(r, null, 2) : ('状态：SKIP（' + r.reason + '）'));
    return 2;
  }
  if (argv.includes('--pdf')) {
    const r = unpaywall(doi, { noCache: argv.includes('--no-cache') });
    if (json) { console.log(JSON.stringify(r, null, 2)); return r.status === 'PASS' ? 0 : 2; }
    console.log('OA PDF 解析：' + r.status + (r.url ? ' ⇒ ' + r.url : '') + (r.reason ? '（' + r.reason + '）' : '') + (r.from_cache ? ' · 来自缓存' : ''));
    return r.status === 'PASS' ? 0 : 2;
  }
  const url = workUrl(doi, email);
  const r = oaGet(url, {}, { noCache: argv.includes('--no-cache'), fetchJson: (u) => JSON.parse(require('child_process').execFileSync('curl', ['-sS', '--max-time', '30', u], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) });
  if (r.status !== 'PASS') { console.log(json ? JSON.stringify(r, null, 2) : ('状态：' + r.status + '（' + r.reason + '）')); return 2; }
  const w = r.data || {};
  const out = {
    status: 'PASS', from_cache: r.from_cache, polite_pool: !!email,
    doi: String(w.doi || '').replace('https://doi.org/', ''), title: w.title, year: w.publication_year,
    citations: w.cited_by_count, is_oa: !!(w.open_access && w.open_access.is_oa), is_retracted: !!w.is_retracted,
    oa_url: (w.best_oa_location && (w.best_oa_location.url_for_pdf || w.best_oa_location.url)) || (w.open_access && w.open_access.oa_url) || null,
    abstract: rebuildAbstract(w.abstract_inverted_index),
  };
  if (json) { console.log(JSON.stringify(out, null, 2)); return 0; }
  console.log('OpenAlex：' + out.title + '（' + out.year + '）· 引用 ' + out.citations + ' · OA=' + out.is_oa + ' · 撤稿=' + out.is_retracted + (out.from_cache ? ' · 来自缓存' : ''));
  if (!email) console.log('  提示：未配置联系邮箱 ⇒ 本次未使用礼貌池（建议设 PAPER_STUDIO_CONTACT_EMAIL，用自己的邮箱）');
  if (out.abstract) console.log('  摘要：' + out.abstract.slice(0, 200) + '…');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { oaGet, unpaywall, rebuildAbstract, workUrl, contactEmail, cacheKeyOf, main, selftest, CACHE_DIR };
