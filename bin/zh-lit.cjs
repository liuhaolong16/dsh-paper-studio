#!/usr/bin/env node
/**
 * zh-lit —— 中文文献检索（OpenAlex 中文题录通道）
 *
 * 用法：
 *   node bin/zh-lit.cjs --query "人工智能 智能体" [--limit 10] [--year-from 2020] [--json]
 *   node bin/zh-lit.cjs --selftest
 *
 * 边界：只检索 OpenAlex 收录的**中文语种**作品（题录/摘要，CC0 元数据），
 * 不是 CNKI/万方/维普全文库；覆盖不全，不能当“中文综述已完成”。
 * 合规：只走公开 API，不绕登录/付费墙，不下载盗版全文。
 */
'use strict';
const https = require('https');

function apiUrl(q, limit, yearFrom) {
  const base = 'https://api.openalex.org/works?search=' + encodeURIComponent(q) +
    '&filter=language:zh,type:article' + (yearFrom ? ',publication_year:>' + (Number(yearFrom) - 1) : '') +
    '&per-page=' + Math.min(50, Math.max(1, Number(limit) || 10)) +
    '&select=id,doi,title,publication_year,primary_location,abstract_inverted_index,authorships,cited_by_count';
  return base;
}
function getJson(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'paper-studio-zh-lit/1.0' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode + ': ' + body.slice(0, 200)));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
function abstractOf(inv) {
  if (!inv) return '';
  const slots = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) slots[p] = w;
  return slots.filter(Boolean).join(' ');
}
function normalize(j) {
  const rows = ((j && j.results) || []).map((w) => {
    const src = (w.primary_location && w.primary_location.source) || {};
    return {
      title: w.title || '(无题名)',
      year: w.publication_year || '',
      venue: src.display_name || '',
      doi: w.doi || '',
      id: w.id || '',
      authors: ((w.authorships || []).slice(0, 3).map((a) => (a.author && a.author.display_name) || '').filter(Boolean)),
      abstract: abstractOf(w.abstract_inverted_index).slice(0, 400),
    };
  });
  return { count: (j && j.meta && j.meta.count) || rows.length, rows };
}
function render(r) {
  const L = ['中文文献（OpenAlex language:zh）：命中 ' + r.count + ' 条，显示 ' + r.rows.length + ' 条'];
  for (const x of r.rows) {
    L.push('- [' + x.year + '] ' + x.title);
    if (x.venue) L.push('  刊/来源：' + x.venue + (x.doi ? ' · DOI: ' + x.doi : ''));
    if (x.abstract) L.push('  摘要：' + x.abstract.replace(/\s+/g, ' ').slice(0, 180) + '…');
  }
  L.push('  ⇒ 这是 OpenAlex 中文题录，不是 CNKI/万方/维普全文库；覆盖不全，需再用机构库补。');
  return L.join('\n');
}
function selftest() {
  const fixture = {
    meta: { count: 2 },
    results: [
      { id: 'W1', doi: 'https://doi.org/10.1/x', title: '人工智能代理的记忆机制', publication_year: 2024,
        primary_location: { source: { display_name: '计算机学报' } },
        abstract_inverted_index: { '记忆': [0], '机制': [1] }, authorships: [] },
      { id: 'W2', doi: null, title: '多智能体系统综述', publication_year: 2023,
        primary_location: { source: { display_name: '软件学报' } }, abstract_inverted_index: null, authorships: [] },
    ],
  };
  const r = normalize(fixture);
  const checks = [
    ['解析中文题名', r.rows[0].title.includes('人工智能')],
    ['解析 DOI 与来源', r.rows[0].doi.includes('doi.org') && r.rows[0].venue === '计算机学报'],
    ['摘要倒排还原', r.rows[0].abstract.includes('记忆') && r.rows[0].abstract.includes('机制')],
    ['无摘要不崩', r.rows[1].abstract === ''],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('zh-lit selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}
async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const q = v('--query');
  if (!q) { console.error('前提层失败：需要 --query "<中文关键词>"'); return 2; }
  try {
    const j = await getJson(apiUrl(q, v('--limit'), v('--year-from')));
    const r = normalize(j);
    console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
    return 0;
  } catch (e) {
    console.error('检索失败：' + ((e && e.message) || e));
    return 2;
  }
}
if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
module.exports = { apiUrl, normalize, render, selftest, abstractOf };
