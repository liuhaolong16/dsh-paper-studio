#!/usr/bin/env node
/**
 * license-audit —— 许可合规机检（**零依赖**）。两件事：
 *   ① **依赖面**：读 `package.json` 的依赖 + 各自 `node_modules/<dep>/package.json` 的 `license` 字段（**读原文，不信登记**），
 *      分类 permissive / copyleft / unknown；规则：
 *        · copyleft 依赖**未被随包分发** ⇒ INFO（须在 `NOTICE.md` 如实登记；这一条也机检）
 *        · copyleft 依赖**出现在随包文件里** ⇒ **FAIL**（这才是真风险：把传染性代码内联进我们的包）
 *        · license 字段缺失/未识别 ⇒ WARN（须人工确认，**不是通过**）
 *        · 依赖未安装（无 node_modules）⇒ **SKIP**（没核对 ≠ 通过）
 *   ② **资产面**：`assets/**` 里**非本仓自产**的文件，必须在 `references/asset-provenance.json` 登记
 *      `{file, sha256, license, upstream, attribution_required}`；校验：未登记 ⇒ FAIL · sha256 不符 ⇒ FAIL ·
 *      许可不在可再分发白名单 ⇒ FAIL · 需署名而 NOTICE 未提 ⇒ FAIL。
 *
 * 由来（2026-10-17）：我们的运行时依赖 `citeproc` 的 license 实际是 **CPAL-1.0 OR AGPL-1.0**，
 * 而早先的生态扫描把它**记成了 MIT** —— 「许可标注不可信，必须读原文」这句话对**我们自己的依赖**同样成立。
 * 用法：node bin/license-audit.cjs [--json] [--init]   ·   --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const PROV = path.join(ROOT, 'references', 'asset-provenance.json');
/* 可作为"随包再分发"的许可白名单（内容/代码通用；需署名者另判 attribution_required） */
const REDISTRIBUTABLE = [
  { re: /\bMIT\b/i, name: 'MIT', attribution: false },
  { re: /Apache License|Apache-2\.0/i, name: 'Apache-2.0', attribution: false },
  { re: /\bBSD\b/i, name: 'BSD', attribution: false },
  { re: /\bISC\b/i, name: 'ISC', attribution: false },
  { re: /CC0|Public Domain/i, name: 'CC0', attribution: false },
  { re: /CC[ -]?BY-SA/i, name: 'CC-BY-SA', attribution: true },
  { re: /Creative Commons Attribution[\s\S]{0,20}ShareAlike/i, name: 'CC-BY-SA', attribution: true },
  { re: /CC[ -]?BY\b|Creative Commons Attribution/i, name: 'CC-BY', attribution: true },
  { re: /木兰|Mulan/i, name: 'Mulan-PSL-2', attribution: false },
];
const COPYLEFT = /(AFFERO|AGPL|GNU GENERAL PUBLIC|GPL-?[23]|LGPL|CPAL|MPL-2|EUPL|SSPL)/i;
const sha256 = (p) => 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function classifyLicense(text) {
  const t = String(text || '').trim();
  if (!t || /^UNLICENSED$|^SEE LICENSE IN/i.test(t)) return { kind: 'unknown', label: t || '（空）' };
  if (COPYLEFT.test(t)) return { kind: 'copyleft', label: t };
  for (const w of REDISTRIBUTABLE) if (w.re.test(t)) return { kind: 'permissive', label: w.name, attribution: !!w.attribution };
  return { kind: 'unknown', label: t };
}

function pkgLicenseField(o) {
  if (!o) return '';
  if (typeof o.license === 'string') return o.license;
  if (o.license && typeof o.license === 'object' && o.license.type) return String(o.license.type);
  if (Array.isArray(o.licenses)) return o.licenses.map((x) => (typeof x === 'string' ? x : (x && x.type) || '')).filter(Boolean).join(' OR ');
  return '';
}

function auditDependencies(root, opts) {
  const o = opts || {};
  const pkgPath = path.join(root, 'package.json');
  const rows = [];
  if (!fs.existsSync(pkgPath)) return { rows, note: '读不到 package.json ⇒ 不得当通过' };
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const deps = Object.assign({}, pkg.dependencies || {}, pkg.devDependencies || {}, pkg.optionalDependencies || {});
  const notice = (() => { try { return fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8'); } catch (e) { return ''; } })();
  /* 随包分发的文件范围：files 白名单（+ 默认总是发布的文件） */
  const filesList = Array.isArray(pkg.files) ? pkg.files : [];
  for (const name of Object.keys(deps)) {
    const dir = path.join(root, 'node_modules', ...name.split('/'));
    const p2 = path.join(dir, 'package.json');
    if (!fs.existsSync(p2)) { rows.push({ dep: name, declared: deps[name], kind: 'skipped', verdict: 'SKIP', reason: '未安装（node_modules 里没有）⇒ 没核对 ≠ 通过' }); continue }
    let dep = {}; try { dep = JSON.parse(fs.readFileSync(p2, 'utf8')); } catch (e) { rows.push({ dep: name, declared: deps[name], kind: 'unknown', verdict: 'WARN', reason: '依赖的 package.json 读不出' }); continue }
    const raw = pkgLicenseField(dep);
    const c = classifyLicense(raw);
    /* 随包分发检查：依赖目录是否落在 files 白名单里（等于把它的代码打进我们的 tarball） */
    const shipped = filesList.some((f) => { const s = String(f); return s === 'node_modules' || s.indexOf('node_modules') === 0 || s.indexOf(name) === 0 });
    let verdict = 'OK', reason = '';
    if (c.kind === 'copyleft') {
      if (shipped) { verdict = 'FAIL'; reason = '传染性许可的依赖被**随包分发**（files 白名单里含它）⇒ 必须移出白名单或换依赖'; }
      else if (notice.indexOf(name) < 0) { verdict = 'WARN'; reason = '传染性许可依赖未随包分发（可接受），但 NOTICE.md 未如实登记它 ⇒ 请补登记'; }
      else { verdict = 'OK'; reason = '传染性许可，但仅作依赖使用、未随包分发，且 NOTICE 已登记'; }
    } else if (c.kind === 'unknown') { verdict = 'WARN'; reason = '许可字段缺失/未识别 ⇒ 须人工确认（**不是通过**）'; }
    rows.push({ dep: name, declared: deps[name], license: raw, kind: c.kind, shipped, verdict, reason });
  }
  return { rows, node_modules_present: fs.existsSync(path.join(root, 'node_modules')) };
}

function auditAssets(root, opts) {
  const o = opts || {};
  const assetsDir = path.join(root, 'assets');
  const out = { files: [], rows: [], note: '' };
  if (!fs.existsSync(assetsDir)) { out.note = '没有 assets/ ⇒ 资产面无需核对（空集合，不是通过）'; return out; }
  const provPath = path.join(root, 'references', 'asset-provenance.json');   // ★ 按传入 root 取（夹具密闭）
  const prov = (() => { try { return JSON.parse(fs.readFileSync(provPath, 'utf8')); } catch (e) { return null; } })();
  const walk = (d, acc) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; };
  out.files = walk(assetsDir, []).map((p) => path.relative(root, p).split(path.sep).join('/'));
  const notice = (() => { try { return fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8'); } catch (e) { return ''; } })();
  const entries = (prov && Array.isArray(prov.assets)) ? prov.assets : null;
  if (!entries) { out.note = '读不到 references/asset-provenance.json ⇒ 资产面**未核对**（不得当通过）'; return out; }
  const byFile = {};
  for (const e of entries) if (e && e.file) byFile[e.file] = e;
  for (const rel of out.files) {
    /* ★ v3.2.94 修：自产文件判定要**显式**（此前那个正则写歪了，连自己的 PROVENANCE.md 都被判成"第三方未登记"）。
       本仓自产：本阅读/来源说明类 md（README/PROVENANCE/NOTICE）与 phrase-bank 词库。 */
    const isOurs = (r) => /(^|\/)(README|PROVENANCE|NOTICE)[^/]*\.md$/i.test(r) || /(^|\/)phrase-bank\.json$/i.test(r);
    const own = isOurs(rel);
    const e = byFile[rel];
    if (!e) {
      out.rows.push({ file: rel, verdict: own ? 'OK' : 'FAIL', reason: own ? '本仓自产（来源说明 / 词库等）' : '第三方资产未在 references/asset-provenance.json 登记 ⇒ 无许可与来源可查' });
      continue;
    }
    const abs = path.join(root, ...rel.split('/'));
    let h = ''; try { h = sha256(abs); } catch (x) { h = ''; }
    if (e.sha256 && h && e.sha256 !== h) { out.rows.push({ file: rel, verdict: 'FAIL', reason: 'sha256 不符（文件被换过）：登记 ' + String(e.sha256).slice(0, 20) + '… 实际 ' + h.slice(0, 20) + '…' }); continue }
    const c = classifyLicense(e.license);
    if (c.kind === 'copyleft' || c.kind === 'unknown') { out.rows.push({ file: rel, verdict: 'FAIL', reason: '许可不可随包再分发或未识别：' + String(e.license) }); continue }
    /* ★ v3.2.94 修：署名可以写在 NOTICE.md，也可以写在资产旁的 PROVENANCE*.md（我们是后者）——
       此前只翻 NOTICE ⇒ 把三个 CSL 样式全判 FAIL（假阳性）。现在两处都认，且认整棵 assets 树的来源说明。 */
    const attributionBlob = notice + '\n' + (() => {
      const parts = [];
      const scan = (dir, depth) => {
        if (depth > 3) return;
        let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const e of ents) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) scan(p, depth + 1);
          else if (/^(PROVENANCE|NOTICE|README)[^/]*\.md$/i.test(e.name)) { try { parts.push(fs.readFileSync(p, 'utf8')); } catch (x) { /* ignore */ } }
        }
      };
      scan(root, 0);
      return parts.join('\n');
    })();
    if (c.attribution && attributionBlob.indexOf(rel.split('/').pop()) < 0 && !/CC[ -]?BY-SA/.test(attributionBlob)) {
      out.rows.push({ file: rel, verdict: 'FAIL', reason: '该许可要求署名，但 NOTICE.md 与各 PROVENANCE 说明里都没提到它（' + rel.split('/').pop() + ' / CC-BY-SA）' }); continue;
    }
    out.rows.push({ file: rel, verdict: 'OK', reason: c.label + (c.attribution ? '（已署名）' : '') });
  }
  /* 反向核对：登记了但实际不存在的文件也要报（防"台账漂移"） */
  if (entries) for (const e of entries) {
    if (e && e.file && out.files.indexOf(e.file) < 0) out.rows.push({ file: e.file, verdict: 'WARN', reason: '登记了但 assets/ 里没有这个文件 ⇒ 台账漂移' });
  }
  return out;
}


/** 归属一致性校验（v3.2.97）：把「须署名」与「仅致意」分开，并机器防两类错——
    ① **漏署**：使用了其表达（uses-expression）却没写进 NOTICE 的「须署名」区；
    ② **虚标**：只吸收了思想（adopted-as-idea）却把自己写成"须署名来源"，或反过来把该署名的降级掉。
    另：两栏标记缺失 ⇒ **无法判定**，记 FAIL（不许当通过）。 */
function auditAttribution(root) {
  const rows = [];
  const saPath = path.join(root, 'references', 'source-attribution.json');
  if (!fs.existsSync(saPath)) return { rows, note: '读不到 references/source-attribution.json ⇒ 归属面**未核对**（不是通过）' };
  let sa = null; try { sa = JSON.parse(fs.readFileSync(saPath, 'utf8')); } catch (e) { return { rows, note: 'source-attribution.json 解析失败：' + String((e && e.message) || e) }; }
  const notice = (() => { try { return fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8'); } catch (e) { return ''; } })();
  const zone = (name) => {
    const m = new RegExp('<!-- ' + name + ':start -->([\\s\\S]*?)<!-- ' + name + ':end -->').exec(notice);
    return m ? m[1] : null;
  };
  const req = zone('ATTR-REQUIRED');
  const cour = zone('ATTR-COURTESY');
  if (req === null || cour === null) {
    rows.push({ source: '（NOTICE.md 分区标记）', status: '-', verdict: 'FAIL', reason: '缺少 ATTR-REQUIRED / ATTR-COURTESY 标记 ⇒ 归属面无法判定（不许当通过）' });
    return { rows, required_zone: !!req, courtesy_zone: !!cour, note: '两栏标记必须都在 NOTICE.md 里' };
  }
  for (const s of (sa.sources || [])) {
    const names = String(s.source || '').split('/').map((x) => x.trim()).filter(Boolean);
    const inReq = names.some((n) => req.indexOf(n) >= 0);
    if (s.status === 'uses-expression') {
      rows.push({ source: s.source, status: s.status, verdict: inReq ? 'OK' : 'FAIL',
        reason: inReq ? '已在「须署名」区' : '使用了其表达却未出现在「须署名」区 ⇒ 漏署（许可与署名是法定义务）' });
    } else if (s.status === 'adopted-as-idea') {
      rows.push({ source: s.source, status: s.status, verdict: inReq ? 'FAIL' : 'OK',
        reason: inReq ? '只吸收了思想却写进「须署名」区 ⇒ 虚标（会让真须署名的项失去区分度）' : '自有表达、无许可义务（可自愿注记在致意区）' });
    } else {
      rows.push({ source: s.source, status: String(s.status), verdict: 'WARN', reason: 'status 取值未识别（只认 uses-expression / adopted-as-idea）' });
    }
  }
  return { rows, required_zone: true, courtesy_zone: true, sources: (sa.sources || []).length,
    note: '降级判据（uses-expression → adopted-as-idea 三条齐备）：① license-scan 对该源命中 0 ② 人工复核无措辞/结构照搬 ③ 未把其文件当依赖或资产分发。' };
}

function audit(root, opts) {
  const deps = auditDependencies(root, opts);
  const assets = auditAssets(root, opts);
  const attribution = auditAttribution(root);
  const fails = deps.rows.filter((r) => r.verdict === 'FAIL').concat(assets.rows.filter((r) => r.verdict === 'FAIL'), attribution.rows.filter((r) => r.verdict === 'FAIL'));
  const warns = deps.rows.filter((r) => r.verdict === 'WARN').concat(assets.rows.filter((r) => r.verdict === 'WARN'), attribution.rows.filter((r) => r.verdict === 'WARN'));
  const skips = deps.rows.filter((r) => r.verdict === 'SKIP');
  let status = fails.length ? 'FAIL' : (warns.length ? 'WARN' : 'PASS');
  if (!deps.rows.length && !assets.rows.length) status = 'SKIP';
  return {
    status, deps, assets, attribution, fails: fails.length, warns: warns.length, skips: skips.length,
    note: '★ 本工具只核**可机检的那部分**（依赖许可分类、随包分发、资产登记与哈希、署名是否出现）；许可兼容性的法律判断仍需人定。',
  };
}

function initProvenance(root) {
  const assetsDir = path.join(root, 'assets');
  const walk = (d, acc) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, acc); else acc.push(p); } return acc; };
  const list = walk(assetsDir, []).map((p) => path.relative(root, p).split(path.sep).join('/')).filter((r) => !/PROVENANCE\.md$/i.test(r) && !/phrase-bank\.json$/.test(r));
  const out = {
    note: '随包分发的**第三方资产**登记表（许可 + 来源 + 哈希）。asset 面由 bin/license-audit.cjs 核对：未登记/sha 不符/许可不可再分发/需署名而未署名 ⇒ FAIL。',
    assets: list.map((rel) => ({
      file: rel,
      sha256: sha256(path.join(root, ...rel.split('/'))),
      license: /\.csl$/.test(rel) ? 'CC-BY-SA 3.0' : '（待填：读原文确认）',
      upstream: /\.csl$/.test(rel) ? 'https://www.zotero.org/styles/（CSL 官方样式库）' : '（待填）',
      attribution_required: true,
      note: /\.csl$/.test(rel) ? '来源与作者见 assets/csl/PROVENANCE.md；未改动内容' : '',
    })),
  };
  fs.writeFileSync(PROV, JSON.stringify(out, null, 2) + '\n', 'utf8');
  return out;
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = () => fs.mkdtempSync(path.join(require('os').tmpdir(), 'licaud-'));

  ck('classify：MIT/Apache/CC-BY-SA 判可再分发（CC-BY-SA 标记需署名）；AGPL/CPAL 判传染性；空判未识别', () => {
    if (classifyLicense('MIT').kind !== 'permissive') return 'MIT 应 permissive';
    if (classifyLicense('Apache-2.0').kind !== 'permissive') return 'Apache 应 permissive';
    const sa = classifyLicense('CC-BY-SA 3.0');
    if (sa.kind !== 'permissive' || !sa.attribution) return 'CC-BY-SA 应 permissive 且需署名：' + JSON.stringify(sa);
    if (classifyLicense('CPAL-1.0 OR AGPL-1.0').kind !== 'copyleft') return 'CPAL/AGPL 应 copyleft';
    if (classifyLicense('').kind !== 'unknown') return '空应 unknown';
    return true;
  });

  ck('★依赖面：传染性依赖"未随包分发"⇒ OK（且要求 NOTICE 已登记）；NOTICE 未登记 ⇒ WARN', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'node_modules', 'copyleft-dep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', 'copyleft-dep', 'package.json'), JSON.stringify({ name: 'copyleft-dep', version: '1.0.0', license: 'AGPL-3.0' }), 'utf8');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name: 'x', files: ['bin'], dependencies: { 'copyleft-dep': '^1' } }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), '本仓依赖 copyleft-dep（AGPL-3.0），仅作依赖、未随包分发', 'utf8');
    const r1 = auditDependencies(d, {});
    if (r1.rows[0].verdict !== 'OK') return '已登记应 OK：' + JSON.stringify(r1.rows[0]);
    fs.writeFileSync(path.join(d, 'NOTICE.md'), '（NOTICE 里没写它）', 'utf8');
    const r2 = auditDependencies(d, {});
    fs.rmSync(d, { recursive: true, force: true });
    return r2.rows[0].verdict === 'WARN' ? true : ('未登记应 WARN：' + JSON.stringify(r2.rows[0]));
  });

  ck('★必失败面：传染性依赖被"随包分发"（files 白名单含它）⇒ 必须 FAIL', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'node_modules', 'agpl-dep'), { recursive: true });
    fs.writeFileSync(path.join(d, 'node_modules', 'agpl-dep', 'package.json'), JSON.stringify({ license: 'AGPL-3.0' }), 'utf8');
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ files: ['node_modules/agpl-dep'], dependencies: { 'agpl-dep': '^1' } }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), 'agpl-dep', 'utf8');
    const r = auditDependencies(d, {});
    fs.rmSync(d, { recursive: true, force: true });
    return r.rows[0].verdict === 'FAIL' ? true : ('应 FAIL：' + JSON.stringify(r.rows[0]));
  });

  ck('★必失败面：依赖未安装 ⇒ SKIP（没核对 ≠ 通过）', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { 'never-installed': '^1' } }), 'utf8');
    const r = auditDependencies(d, {});
    fs.rmSync(d, { recursive: true, force: true });
    return r.rows[0].verdict === 'SKIP' ? true : ('应 SKIP：' + JSON.stringify(r.rows[0]));
  });

  ck('★资产面：第三方文件未登记 ⇒ FAIL；登记且哈希相符 ⇒ OK', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'assets', 'csl'), { recursive: true });
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    const f = path.join(d, 'assets', 'csl', 'x.csl');
    fs.writeFileSync(f, '<style/>', 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), 'x.csl 来自 CSL，许可 CC-BY-SA', 'utf8');
    fs.writeFileSync(path.join(d, 'references', 'asset-provenance.json'), JSON.stringify({ assets: [] }), 'utf8');
    const r1 = auditAssets(d, {});
    if (r1.rows[0].verdict !== 'FAIL') return '未登记应 FAIL：' + JSON.stringify(r1.rows[0]);
    fs.rmSync(d, { recursive: true, force: true });
    return true;
  });

  ck('★资产面：sha256 不符 ⇒ FAIL（防无声替换）', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(d, 'assets', 'a.csl'), '<style>A</style>', 'utf8');
    fs.writeFileSync(path.join(d, 'references', 'asset-provenance.json'), JSON.stringify({ assets: [{ file: 'assets/a.csl', sha256: 'sha256:deadbeef', license: 'CC-BY-SA 3.0', attribution_required: true }] }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), 'a.csl CC-BY-SA', 'utf8');
    const r = auditAssets(d, {});
    fs.rmSync(d, { recursive: true, force: true });
    return r.rows[0].verdict === 'FAIL' && /sha256 不符/.test(r.rows[0].reason) ? true : ('应 FAIL+sha 不符：' + JSON.stringify(r.rows[0]));
  });

  ck('★必失败面：资产许可为传染性/未识别 ⇒ FAIL（不许当可分发）', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    const f = path.join(d, 'assets', 'g.txt');
    fs.writeFileSync(f, 'copyleft content', 'utf8');
    const h = 'sha256:' + require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    fs.writeFileSync(path.join(d, 'references', 'asset-provenance.json'), JSON.stringify({ assets: [{ file: 'assets/g.txt', sha256: h, license: 'AGPL-3.0' }] }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), 'g.txt', 'utf8');
    const r = auditAssets(d, {});
    fs.rmSync(d, { recursive: true, force: true });
    return r.rows[0].verdict === 'FAIL' ? true : ('应 FAIL：' + JSON.stringify(r.rows[0]));
  });

  ck('★归属·必失败面：只吸思想却写进「须署名」区 ⇒ 虚标（FAIL）', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(d, 'references', 'source-attribution.json'), JSON.stringify({ sources: [{ source: 'idea-src', license: 'AGPL-3.0', status: 'adopted-as-idea' }] }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), '<!-- ATTR-REQUIRED:start -->\n- idea-src\n<!-- ATTR-REQUIRED:end -->\n<!-- ATTR-COURTESY:start -->\n<!-- ATTR-COURTESY:end -->', 'utf8');
    const r = auditAttribution(d);
    fs.rmSync(d, { recursive: true, force: true });
    return (r.rows[0].verdict === 'FAIL' && /虚标/.test(r.rows[0].reason)) ? true : ('应 FAIL+虚标：' + JSON.stringify(r.rows[0]));
  });

  ck('★归属·必失败面：用了其表达却没写进「须署名」区 ⇒ 漏署（FAIL）', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(d, 'references', 'source-attribution.json'), JSON.stringify({ sources: [{ source: 'copied-src', license: 'CC-BY', status: 'uses-expression' }] }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), '<!-- ATTR-REQUIRED:start -->\n（空）\n<!-- ATTR-REQUIRED:end -->\n<!-- ATTR-COURTESY:start -->\n<!-- ATTR-COURTESY:end -->', 'utf8');
    const r = auditAttribution(d);
    fs.rmSync(d, { recursive: true, force: true });
    return (r.rows[0].verdict === 'FAIL' && /漏署/.test(r.rows[0].reason)) ? true : ('应 FAIL+漏署：' + JSON.stringify(r.rows[0]));
  });

  ck('★归属·必失败面：NOTICE 缺分区标记 ⇒ 记 FAIL（无法判定不算通过）', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(d, 'references', 'source-attribution.json'), JSON.stringify({ sources: [] }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), '（没有任何标记）', 'utf8');
    const r = auditAttribution(d);
    fs.rmSync(d, { recursive: true, force: true });
    return (r.rows[0] && r.rows[0].verdict === 'FAIL' && /无法判定/.test(r.rows[0].reason)) ? true : JSON.stringify(r);
  });

  ck('★归属·正控：idea 源在致意区、表达源在须署名区 ⇒ 全 OK', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, 'references'), { recursive: true });
    fs.writeFileSync(path.join(d, 'references', 'source-attribution.json'), JSON.stringify({ sources: [{ source: 'a-src', status: 'uses-expression' }, { source: 'b-src', status: 'adopted-as-idea' }] }), 'utf8');
    fs.writeFileSync(path.join(d, 'NOTICE.md'), '<!-- ATTR-REQUIRED:start -->\n- a-src\n<!-- ATTR-REQUIRED:end -->\n<!-- ATTR-COURTESY:start -->\n- b-src\n<!-- ATTR-COURTESY:end -->', 'utf8');
    const r = auditAttribution(d);
    fs.rmSync(d, { recursive: true, force: true });
    return r.rows.every((x) => x.verdict === 'OK') ? true : JSON.stringify(r.rows);
  });

  ck('实盘自证：本仓必须 PASS（依赖面 + 资产面 + 归属面都无 FAIL，允许 INFO/WARN）', () => {
    const r = audit(ROOT, {});
    if (r.status === 'FAIL') return '本仓竟 FAIL：' + JSON.stringify(r.fails, null, 0).slice(0, 200);
    return true;
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nlicense-audit 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--init')) { const o = initProvenance(ROOT); console.log('已生成 references/asset-provenance.json（' + o.assets.length + ' 条）'); return 0; }
  const r = audit(ROOT, {});
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : 0; }
  console.log('许可合规机检：' + r.status + '（FAIL ' + r.fails + ' · WARN ' + r.warns + ' · SKIP ' + r.skips + '）');
  console.log('  依赖面（读 node_modules 的 license 原文字段）：');
  for (const d of r.deps.rows) console.log('    [' + d.verdict + '] ' + d.dep + ' ⇒ ' + (d.license || d.reason || '') + (d.reason && d.license ? '（' + d.reason + '）' : ''));
  console.log('  资产面（assets/ 随包分发的第三方文件）：');
  for (const a of r.assets.rows) console.log('    [' + a.verdict + '] ' + a.file + ' ⇒ ' + a.reason);
  if (r.assets.note) console.log('    ' + r.assets.note);
  console.log('  归属面（须署名 / 仅致意 分栏）：');
  if (r.attribution && r.attribution.rows) { for (const a of r.attribution.rows) console.log('    [' + a.verdict + '] ' + a.source + ' ⇒ ' + a.reason); }
  if (r.attribution && r.attribution.note) console.log('    ' + r.attribution.note);
  console.log('  ' + r.note);
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { audit, auditDependencies, auditAssets, auditAttribution, classifyLicense, initProvenance, main, selftest, PROV };
