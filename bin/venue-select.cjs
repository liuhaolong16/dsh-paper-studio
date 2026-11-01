#!/usr/bin/env node
/**
 * venue-select —— AI Agent 方向候选期刊筛选（LetPub 公开页，含中科院分区）
 *
 * 用法：
 *   node bin/venue-select.cjs [--tiers 2,3] [--journals "刊名1,刊名2"] [--json]
 *   node bin/venue-select.cjs --selftest
 *
 * 数据源：letpub.com.cn 期刊查询页（公开 HTML，2025-2026 数据）；只读取公开页面，
 * 不登录、不绕付费墙。分区字段为页面展示的「中科院 SCI 期刊分区」，以页面当日为准；
 * 本工具不保证录用率/审稿周期，匹配理由来自 references/venue-candidates.json 的人工判断。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const CAND = path.join(__dirname, '..', 'references', 'venue-candidates.json');

function postForm(url, form, timeoutMs) {
  const body = Object.entries(form).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 paper-studio-venue/1.0',
        'Referer': 'https://www.letpub.com.cn/index.php?page=journalapp&view=search',
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('HTTP ' + res.statusCode));
        resolve(data);
      });
    });
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function strip(s) { return String(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(); }

/** 从 LetPub 搜索结果页解析一行期刊；返回 null 表示没匹配到。 */
function parseResult(html, name) {
  const m = html.match(/<table[^>]*class="table_yjfx"[^>]*>([\s\S]*?)<\/table>/i);
  if (!m) return null;
  const rows = [...m[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((x) => x[1]);
  for (const r of rows) {
    const rawCells = [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((x) => x[1]);
    const cells = rawCells.map((c) => strip(c));
    if (!cells.length) continue;
    if (!/^\d{4}-\d{3}[\dX]$/i.test(cells[0])) continue;
    const tier = (cells.find((c) => /^\d区$/.test(c)) || '').trim();
    const ifCell = cells.find((c) => /IF[:：]\s*[\d.]+/.test(c)) || '';
    const ifMatch = ifCell.match(/IF[:：]\s*([\d.]+)/);
    const anchor = (rawCells[1] || '').match(/<a[^>]*>([\s\S]*?)<\/a>/i);
    return {
      name: anchor ? strip(anchor[1]) : cells[1],
      issn: cells[0],
      tier: tier || '未标',
      impact_factor: ifMatch ? Number(ifMatch[1]) : null,
      category: cells.find((c) => /大类[:：]/.test(c)) || '',
      indexed: cells.find((c) => /^SCI/.test(c)) || '',
      raw: cells,
    };
  }
  return null;
}

function loadCandidates() {
  const j = JSON.parse(fs.readFileSync(CAND, 'utf8'));
  return j.candidates || [];
}

async function queryOne(name) {
  const html = await postForm('https://www.letpub.com.cn/index.php?page=journalapp&view=search',
    { searchname: name, view: 'search' });
  return parseResult(html, name);
}

function render(rows, meta) {
  const L = ['AI Agent 候选期刊（LetPub 公开页 · ' + meta.date + '）'];
  L.push('  分区字段=页面展示的中科院 SCI 分区；IF 为页面显示值；录用率/审稿周期未采集。');
  L.push('');
  L.push('| 期刊 | ISSN | 中科院分区 | IF | 匹配理由 |');
  L.push('|---|---|---|---|---|');
  for (const r of rows) L.push('| ' + r.name + ' | ' + r.issn + ' | ' + r.tier + ' | ' + (r.impact_factor == null ? '—' : r.impact_factor) + ' | ' + (r.fit || '') + ' |');
  if (meta.missing && meta.missing.length) L.push('\n未匹配：' + meta.missing.join('；'));
  L.push('\n⇒ 这是选刊参考，不是录用承诺；投稿前以期刊官网/分区表最新版复核。');
  return L.join('\n');
}

function selftest() {
  const html = '<table class="table_yjfx"><tr><td>ISSN</td><td>刊名</td></tr>' +
    '<tr><td>1041-4347</td><td>IEEE TRANSACTIONS ON KNOWLEDGE AND DATA ENGINEERING</td>' +
    '<td>IF: 11.6 h-index: 148</td><td>2区</td><td>大类：计算机科学 小类：人工智能</td><td>SCI SCIE</td></tr></table>';
  const r = parseResult(html, 'x');
  const checks = [
    ['解析 ISSN', r && r.issn === '1041-4347'],
    ['解析分区', r && r.tier === '2区'],
    ['解析 IF', r && r.impact_factor === 11.6],
    ['无表返回 null', parseResult('<html></html>', 'x') === null],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('venue-select selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const tiers = (v('--tiers') || '2,3').split(',').map((s) => s.trim() + '区');
  const listed = v('--journals');
  const all = loadCandidates();
  const picks = listed
    ? listed.split(',').map((n) => ({ name: n.trim(), fit: '' }))
    : all.filter((c) => tiers.includes(c.tier) || !c.tier);
  const rows = []; const missing = [];
  for (const c of picks) {
    try {
      const r = await queryOne(c.name);
      if (!r) { missing.push(c.name); continue; }
      rows.push(Object.assign({}, r, { fit: c.fit || '' }));
    } catch (e) {
      missing.push(c.name + '（' + ((e && e.message) || e) + '）');
    }
    await new Promise((res) => setTimeout(res, 800));
  }
  const out = { date: new Date().toISOString().slice(0, 10), rows, missing };
  if (argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else console.log(render(rows, out));
  return rows.length ? 0 : 2;
}

if (require.main === module) main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
module.exports = { parseResult, queryOne, render, selftest, loadCandidates };
