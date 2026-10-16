#!/usr/bin/env node
/**
 * license-scan —— 许可污染扫描：我们仓库的文本 × **受限源**（AGPL / CC-BY-NC / 无许可）的文本，做长片段重合比对。
 *
 * 目的（把"吸收思想"与"复制分发"分开）：版权保护**表达**不保护**思想** ⇒
 *   · 读懂方法后用**自己的表达**重写 = 我们的，可自由许可；
 *   · 若我们文件里存在与受限源**成段相同的措辞**（哪怕改了词、换了序、翻译过）＝ 演绎作品 ⇒ 受限许可跟着走。
 * 本工具只做一件事：**把"成段相同"从人眼判断变成机器判据**（命中即列出双方位置并 FAIL）。
 *
 * ★ 边界（必须如实说）：词级 n-gram 只能抓**逐字/近似逐字**；**抓不到**改写（换词、调序、翻译）。
 *   所以它是**地板线**（拦住最危险的那类），不是免罪符 —— 人审仍不可省。
 *
 * 用法：
 *   node bin/license-scan.cjs --scan "<第三方扫描件目录>" [--min-gram 13] [--json]
 *   node bin/license-scan.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const SKIP_DIR = /(^|\\)(\.git|node_modules|\.dsh-project-memory|run|third_party|dist|__pycache__)(\\|$)/;
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.cjs', '.mjs', '.js', '.py', '.yml', '.yaml', '.csv', '.tsv', '.html', '.tex', '.r', '.ipynb']);
/* 受限源判定（保守：白名单之外一律受限）。
   ★ v3.2.93 修：不能只按缩写匹配 —— 实测源文件里写的是 `Creative Commons Attribution 4.0`（词面），
   按 `CC-BY` 缩写匹配会把 CC-BY 误判成受限源（真跑时 `auto-empirical-research-skills` 就被误列进受限集合）。 */
const PERMISSIVE = /(\bMIT\b|Apache License|\bBSD\b|木兰|Mulan|\bISC\b)/i;
const CCBY_ANY = /(Creative Commons Attribution|CC[ -]?BY\b)/i;
const NC_ANY = /(NonCommercial|Non-Commercial|noncommercial|BY-NC|NC 4\.0)/i;
const COPYLEFT_ANY = /(AFFERO|Affero|AGPL|GNU GENERAL PUBLIC|GPL-?[23])/i;
/** ★ v3.2.93b：**先判受限（NC/传染性优先）**，再用**词边界**判宽松。
    此前顺序相反且 `ISC` 无词边界 ⇒ AGPL 正文里的 `miscellaneous` 命中 ISC，把 AGPL 源误判成宽松，
    结果是"受限源集合里缺了最该在的那两个"⇒ 扫描照样 PASS（**通过的检查其实没检查**）。 */
function isRestrictedByLicense(text) {
  const t = String(text || '');
  if (NC_ANY.test(t) || COPYLEFT_ANY.test(t)) return true;        // 非商业 / 传染性 ⇒ 一律受限（压倒其它字样）
  if (PERMISSIVE.test(t)) return false;
  if (CCBY_ANY.test(t)) return false;                             // 到这里已排除 NC ⇒ 是普通 CC-BY，可搬（须署名）
  return true;                                                    // 无许可或未识别 ⇒ 保守判受限
}

function walk(dir, out, maxFiles, depth) {
  if (out.length >= maxFiles || depth > 10) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (out.length >= maxFiles) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.test(p + path.sep)) walk(p, out, maxFiles, depth + 1); }
    else if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

function normTokens(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')                       // 代码块整体折叠（避免把别人的代码判成我们的散文重合）
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** 生成 n-gram 指纹 → 首次出现位置（纯函数，可夹具） */
function shingles(tokens, n) {
  const map = new Map();
  for (let i = 0; i + n <= tokens.length; i += 1) {
    const g = tokens.slice(i, i + n).join(' ');
    const h = crypto.createHash('sha1').update(g).digest('hex').slice(0, 16);
    if (!map.has(h)) map.set(h, { gram: g, idx: i });
  }
  return map;
}

function corpusShingles(files, n, perFileCap) {
  const all = new Map();
  const perFile = {};
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
    if (txt.length > perFileCap) txt = txt.slice(0, perFileCap);
    const m = shingles(normTokens(txt), n);
    perFile[f] = m.size;
    for (const [h, v] of m) if (!all.has(h)) all.set(h, { gram: v.gram, file: f, idx: v.idx });
  }
  return { all, perFile };
}

/** 主扫描：ours × restricted ⇒ 重合片段（含双方位置） */
function scan(scanDir, opts) {
  const o = opts || {};
  const n = Number(o.minGram) > 3 ? Number(o.minGram) : 13;
  const maxFiles = Number(o.maxFiles) > 0 ? Number(o.maxFiles) : 4000;
  const perFileCap = Number(o.perFileCap) > 0 ? Number(o.perFileCap) : 400000;
  if (!scanDir || !fs.existsSync(scanDir)) {
    return { status: 'SKIP', reason: '未提供存在的第三方扫描件目录 ⇒ 无法对照（**不得当通过**）', hits: [] };
  }
  /* 受限源 = 扫描件根下**非宽松许可**的目录（宽松白名单：MIT/Apache/BSD/木兰/CC-BY(非NC)） */
  const sources = [];
  for (const e of fs.readdirSync(scanDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const licenseText = (() => {
      for (const c of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']) {
        const p = path.join(scanDir, e.name, c);
        if (fs.existsSync(p)) { try { return fs.readFileSync(p, 'utf8').slice(0, 1500) + ' ' + e.name; } catch (x) { return e.name; } }
      }
      return e.name;                                       // 无 LICENSE ⇒ 默认保留全部权利（受限）
    })();
    if (!isRestrictedByLicense(licenseText)) continue;      // 宽松/CC-BY 源不进受限集合（它们可搬，只需声明或署名）
    sources.push({ name: e.name, dir: path.join(scanDir, e.name) });
  }
  /* ★ v3.2.91b 前提下限：给定期望受限源（--expect a,b）时，缺件必须 FAIL ——
     防的正是"许可判定写错 ⇒ 最该在的受限源没进集合 ⇒ 扫描照样报 PASS"那次真实假通过。 */
  const expect = (o.expect || []).filter(Boolean);
  const missing = expect.filter((e) => !sources.some((s) => s.name === e || s.name.indexOf(e) >= 0));
  if (missing.length) {
    return { status: 'FAIL', reason: '前提不成立：期望的受限源未进集合 ⇒ ' + missing.join('/', '') + '（许可判定可能出错 = 扫描没覆盖到它）', restricted_sources: sources.map((s) => s.name), hits: [], hit_count: 0, min_gram: n };
  }

  if (!sources.length) return { status: 'SKIP', reason: '扫描件里没有识别到受限源目录 ⇒ 本扫描无对照物（不是通过）', hits: [] };
  /* ★ v3.2.93：ours 语料可显式给出（夹具密闭）；默认扫仓库但**排除工具自身**——
     否则本文件里内嵌的夹具字符串会被当成"我方文本"，产生自匹配假阳性（实测踩到）。 */
  let ourFiles = [];
  if (Array.isArray(o.ours) && o.ours.length) ourFiles = o.ours.slice();
  else {
    walk(o.oursDir || ROOT, ourFiles, maxFiles, 0);
    ourFiles = ourFiles.filter((f) => path.basename(f) !== 'license-scan.cjs');
  }
  const ours = corpusShingles(ourFiles, n, perFileCap);
  const hits = [];
  for (const src of sources) {
    const files = [];
    walk(src.dir, files, maxFiles, 0);
    const theirs = corpusShingles(files, n, perFileCap);
    for (const [h, v] of theirs.all) {
      const mine = ours.all.get(h);
      if (!mine) continue;
      hits.push({ source: src.name, gram: v.gram, our_file: path.relative(ROOT, mine.file), their_file: path.relative(src.dir, v.file), our_gram_at: mine.idx, their_gram_at: v.idx });
      if (hits.length >= 200) break;
    }
  }
  return {
    status: hits.length ? 'FAIL' : 'PASS',
    min_gram: n, restricted_sources: sources.map((s) => s.name),
    our_files: ourFiles.length, our_shingles: ours.all.size,
    hits, hit_count: hits.length,
    note: '★ 词级 n-gram 只能抓逐字/近似逐字；**改写、换词、调序、翻译抓不到** ⇒ 地板线而非免罪符。命中即必须改写成自己的表达，或按原许可声明/署名分发。',
  };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'lic-'));

  ck('shingles：同一段文本必须产生同一个指纹集合（可复现）', () => {
    const a = shingles(normTokens('alpha beta gamma delta epsilon zeta'), 3);
    const b = shingles(normTokens('alpha beta gamma delta epsilon zeta'), 3);
    if (a.size !== b.size) return '大小不同';
    for (const k of a.keys()) if (!b.has(k)) return '指纹不一致';
    return a.size === 4 ? true : 'n-gram 数应为 4：' + a.size;
  });

  ck('★作用：受限源与我们文件逐字相同 ⇒ 必须命中并给出双方位置', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'bad-source'));
    fs.writeFileSync(path.join(d, 'bad-source', 'LICENSE'), 'Creative Commons Attribution-NonCommercial 4.0', 'utf8');
    const sent = 'this paragraph is copied verbatim from a restricted source and must be caught by the scanner now';
    fs.writeFileSync(path.join(d, 'bad-source', 'SKILL.md'), '# x\n\n' + sent + '\n', 'utf8');
    const od = tmp();
    const mine = path.join(od, 'ours.md');
    fs.writeFileSync(mine, sent + '\n', 'utf8');
    const r = scan(d, { minGram: 8, ours: [mine] });
    fs.rmSync(od, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
    if (r.status !== 'FAIL') return '应 FAIL，实得 ' + r.status;
    const h = r.hits[0];
    return (h && /ours\.md$/.test(h.our_file) && h.their_file.indexOf('SKILL.md') >= 0) ? true : '命中位置不对：' + JSON.stringify(h);
  });

  ck('★边界（必须如实）：把我们自己的散文改词后不该被误判', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'bad-source'));
    fs.writeFileSync(path.join(d, 'bad-source', 'LICENSE'), 'Attribution-NonCommercial', 'utf8');
    fs.writeFileSync(path.join(d, 'bad-source', 'SKILL.md'), 'the quick brown fox jumps over the lazy dog while everyone watches quietly today', 'utf8');
    const od = tmp();
    const mine = path.join(od, 'ours-paraphrase.md');
    fs.writeFileSync(mine, 'our own wording about a swift auburn animal leaping above an indolent canine as onlookers keep silent', 'utf8');
    const r = scan(d, { minGram: 8, ours: [mine] });
    fs.rmSync(od, { recursive: true, force: true });
    fs.rmSync(d, { recursive: true, force: true });
    return r.status === 'PASS' ? true : ('不应命中，实得 ' + r.status + ' ' + JSON.stringify(r.hits.slice(0, 2)));
  });

  ck('宽松源不进受限集合：MIT / Apache / CC-BY / 木兰宽松目录必须被跳过', () => {
    const d = tmp();
    for (const [name, lic] of [['mit-src', 'MIT License'], ['apache-src', 'Apache License Version 2.0'], ['ccby-src', 'Creative Commons Attribution 4.0'], ['ccby-word-src', 'You are free to Share and Adapt under Creative Commons Attribution 4.0 International'], ['mulan-src', '木兰宽松许可证，第2版']]) {
      fs.mkdirSync(path.join(d, name));
      fs.writeFileSync(path.join(d, name, 'LICENSE'), lic, 'utf8');
    }
    const r = scan(d, {});
    fs.rmSync(d, { recursive: true, force: true });
    return r.status === 'SKIP' ? true : ('宽松源应全被跳过 ⇒ SKIP，实得 ' + r.status + ' ' + JSON.stringify(r.restricted_sources));
  });

  ck('★必失败面：CC-BY-NC 与 AGPL 必须判为受限（不许被"Creative Commons"字样放过）', () => {
    const cc = isRestrictedByLicense('Creative Commons Attribution-NonCommercial 4.0 International');
    const ag = isRestrictedByLicense('GNU AFFERO GENERAL PUBLIC LICENSE Version 3');
    const ncNolang = isRestrictedByLicense('This work is licensed under a Creative Commons Attribution-NonCommercial-ShareAlike 4.0 License');
    const by = isRestrictedByLicense('Creative Commons Attribution 4.0 International');
    const mit = isRestrictedByLicense('MIT License');
    if (!cc) return 'CC-BY-NC 被判成宽松';
    if (!ag) return 'AGPL 被判成宽松';
    if (!ncNolang) return 'BY-NC-SA 被判成宽松';
    if (by) return 'CC-BY 被判成受限（误判，v3.2.93 修过）';
    if (mit) return 'MIT 被判成受限';
    return true;
  });

  ck('★必失败面：期望的受限源没进集合 ⇒ 必须 FAIL（防"许可判定写错却照样 PASS"）', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'only-mit'));
    fs.writeFileSync(path.join(d, 'only-mit', 'LICENSE'), 'MIT License', 'utf8');
    const r = scan(d, { expect: ['agpl-repo'] });
    fs.rmSync(d, { recursive: true, force: true });
    return (r.status === 'FAIL' && /前提不成立/.test(String(r.reason))) ? true : ('应 FAIL+前提不成立：' + JSON.stringify(r).slice(0, 200));
  });

  ck('★必失败面：AGPL 正文含 miscellaneous 也必须判受限（无词边界会误判为宽松）', () => {
    const agpl = 'GNU AFFERO GENERAL PUBLIC LICENSE Version 3 ... various miscellaneous provisions ...';
    return isRestrictedByLicense(agpl) ? true : 'AGPL 被判成宽松（ISC 子串又命中了？）';
  });

  ck('★必失败面：扫描件目录不存在 ⇒ SKIP 并写明原因（绝不当通过）', () => {
    const r = scan('Z:/no/such/dir', {});
    return (r.status === 'SKIP' && /不得当通过/.test(r.reason)) ? true : '应为 SKIP+HINT：' + JSON.stringify(r);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nlicense-scan 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const scanDir = val('--scan') || process.env.PS_LICENSE_SCAN_DIR || 'E:\\DeepSeek\\third_party\\scan-20261017';
  const exp = (val('--expect') || process.env.PS_LICENSE_EXPECT || 'paperdebugger,academic-research-skills').split(',').map((s) => s.trim()).filter(Boolean);
  const r = scan(scanDir, { minGram: Number(val('--min-gram')) || 13, expect: exp });
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : 0; }
  console.log('许可污染扫描（min-gram ' + r.min_gram + '）：' + r.status + (r.restricted_sources ? ' · 受限源 ' + r.restricted_sources.length + ' 个（' + r.restricted_sources.join('/') + '）' : ''));
  if (r.status === 'SKIP') { console.log('  跳过原因：' + r.reason); return 0; }
  console.log('  我方文本 ' + r.our_files + ' 文件 · 指纹 ' + r.our_shingles + ' 条 · 命中 ' + r.hit_count);
  for (const h of r.hits.slice(0, 10)) console.log('  ✘ [' + h.source + '] 我方 ' + h.our_file + ' ↔ 对方 ' + h.their_file + '：' + h.gram.slice(0, 70));
  if (r.hit_count > 10) console.log('  …另有 ' + (r.hit_count - 10) + ' 条');
  console.log('  ' + (r.note || ''));
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scan, shingles, normTokens, corpusShingles, walk, isRestrictedByLicense, main, selftest };
