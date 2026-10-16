#!/usr/bin/env node
/**
 * pdf-meta —— **编译产物 PDF 的元数据实读**（对拍 backlog 项：对手 `scan_anonymization.py` 自己也写着
 * "no compiled PDF ⇒ PDF metadata not checked"，**双方此前都没做**）。
 *
 * 为什么必须读**产物**而不是只看源：正文里的身份能在源码层抹掉，但 **PDF 属性（/Author、XMP dc:creator）
 * 与编译进去的正文文本**仍可能带作者名、邮箱、机构、家目录 —— 双盲投稿时这是直接违规。
 *
 * 判据（三态，绝不把"没读到"当"干净"）：
 *   · `/Author` 非空 ⇒ ERROR（双盲稿的 PDF 属性不应含作者）· `/Title` 含作者名 ⇒ ERROR
 *   · 元数据或**原始字节**里命中邮箱 / ORCID / `github.com/<user>` / 家目录 ⇒ ERROR/WARN
 *   · **找不到 Info 字典或 XMP**（常见于对象流压缩的 PDF）⇒ 记 `metadata-not-found` 并**明说未核对**
 *   · 文件不存在 / 不是 PDF ⇒ SKIP（未检查 ≠ 通过）
 *
 * 诚实边界（写进回执）：本工具**不做文本抽取**，只读元数据字典 + 在字节里扫模式；
 *   正文若被压缩进内容流，其中的身份**本工具读不到** ⇒ 这部分仍需人工/其他工具。
 *
 * 用法：
 *   node bin/pdf-meta.cjs --pdf <file.pdf> [--json] [--blind]
 *   node bin/pdf-meta.cjs --dir <包目录> [--blind]
 *   node bin/pdf-meta.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const NAMES_RE = /\/(Author|Title|Subject|Keywords|Creator|Producer|CreationDate|ModDate)\s*\(([^)]*)\)/g;
const XMP_KEYS = ['dc:creator', 'dc:title', 'pdf:Producer', 'xmp:CreatorTool', 'pdf:Keywords'];

/* ★ v3.12.0：TLD 限已知列表 —— 否则压缩流里的二进制串（实测 `K@48G9-.BYBGNPTUT`）会被当成邮箱 */
const TLD = 'com|org|edu|net|gov|int|mil|io|ai|ac|cn|hk|tw|jp|kr|sg|uk|de|fr|it|es|nl|se|no|fi|dk|pl|ru|br|ca|au|nz|in|ch|at|be|cz|pt|gr|tr|il|za|mx|ar|cl|ie|info|biz|me|dev|app|xyz|top|tech|online|edu\.cn|ac\.cn|org\.cn|com\.cn|gov\.cn|edu\.hk';
const EMAIL_RE = new RegExp('[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\\.)+(?:' + TLD + ')\\b', 'i');
const ORCID_RE = /\b\d{4}-\d{4}-\d{4}-\d{3}[\dX]\b/;
const REPO_RE = /https?:\/\/(?:github|gitlab|gitee)\.com\/[A-Za-z0-9_.\-]+/;
const HOMEPATH_RE = /(?:\/home\/[A-Za-z0-9_.-]+|\/Users\/[A-Za-z0-9_.-]+|[A-Z]:\\Users\\[A-Za-z0-9_.-]+)/;

function isPdf(buf) { return buf.length > 5 && buf.slice(0, 5).toString('latin1') === '%PDF-'; }

/** 读一个 PDF 的元数据与字节命中 */
function readPdf(file, opts) {
  const o = opts || {};
  if (!fs.existsSync(file)) return { status: 'SKIP', why: '文件不存在：' + file };
  const buf = fs.readFileSync(file);
  if (!isPdf(buf)) return { status: 'SKIP', why: '不是 PDF（缺少 %PDF- 头）：' + path.basename(file) };
  const raw = buf.toString('latin1');
  const info = {};
  let m;
  const re = new RegExp(NAMES_RE.source, 'g');
  while ((m = re.exec(raw)) !== null) {
    /* 同名键可能多次出现（增量更新）⇒ 取最后一次，并如实记 */
    info[m[1]] = String(m[2]).trim();
  }
  const xmp = {};
  for (const k of XMP_KEYS) {
    const i = raw.indexOf('<' + k + '>');
    if (i >= 0) {
      const j = raw.indexOf('</' + k + '>', i);
      if (j > i) xmp[k] = raw.slice(i + k.length + 2, j).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  }
  const issues = [];
  const hasAnyMeta = Object.keys(info).length > 0 || Object.keys(xmp).length > 0;
  const blind = o.blind !== false;   /* 默认按双盲稿判定 */
  if (blind && info.Author && info.Author.trim()) issues.push({ level: 'ERROR', check: 'author-in-pdf-properties', msg: 'PDF 属性 /Author 非空（双盲稿不应含作者）：' + info.Author.slice(0, 80) });
  if (xmp['dc:creator'] && xmp['dc:creator'].trim()) issues.push({ level: 'ERROR', check: 'author-in-xmp', msg: 'XMP dc:creator 非空：' + xmp['dc:creator'].slice(0, 80) });
  const scanTargets = { '元数据': [info.Author, info.Title, info.Subject, info.Keywords, xmp['dc:creator'], xmp['dc:title']].filter(Boolean).join(' | '), '原始字节': raw };
  for (const where of Object.keys(scanTargets)) {
    const t = scanTargets[where];
    if (!t) continue;
    /* ★ v3.12.0 **分级**：元数据字典命中＝确定（ERROR）；原始字节命中＝**疑似**（WARN，须人工确认）——
       压缩内容流/字体/噪声都可能撞上模式串（真文件实测过二进制假邮箱）。 */
    const isMeta = (where === '元数据');
    const lv = isMeta ? 'ERROR' : 'WARN';
    const tag = isMeta ? '' : '（疑似：字节扫描命中，可能来自压缩流或噪声，**需人工确认**）';
    if (EMAIL_RE.test(t)) issues.push({ level: lv, check: 'email-in-pdf', msg: '在**' + where + '**命中邮箱：' + (t.match(EMAIL_RE) || [''])[0] + tag });
    if (ORCID_RE.test(t)) issues.push({ level: lv, check: 'orcid-in-pdf', msg: '在**' + where + '**命中 ORCID：' + (t.match(ORCID_RE) || [''])[0] + tag });
    if (REPO_RE.test(t)) issues.push({ level: 'WARN', check: 'repo-url-in-pdf', msg: '在**' + where + '**命中仓库链接（可能暴露身份）：' + (t.match(REPO_RE) || [''])[0] + tag });
    if (HOMEPATH_RE.test(t)) issues.push({ level: 'WARN', check: 'home-path-in-pdf', msg: '在**' + where + '**命中家目录路径：' + (t.match(HOMEPATH_RE) || [''])[0] + tag });
  }
  const notes = [];
  if (!hasAnyMeta) notes.push('**未读到 Info 字典与 XMP**（对象流压缩的 PDF 常见）⇒ 元数据这一项**未核对**，不能算干净');
  if (info.Creator || info.Producer) notes.push('工具链痕迹（通常无害）：Creator=' + (info.Creator || '—') + ' · Producer=' + (info.Producer || '—'));
  const errs = issues.filter((x) => x.level === 'ERROR').length;
  return { status: errs ? 'FAIL' : (hasAnyMeta ? 'PASS' : 'UNCHECKED'), file: path.basename(file), size: buf.length, info, xmp, issues, notes,
    boundary: '本工具只读元数据 + 在字节里扫模式，**不做正文文本抽取** ⇒ 压缩内容流里的身份读不到，那部分需人工或其他工具。' };
}

/** 扫一个包目录里所有 PDF */
function scanDir(dir, opts) {
  const d = path.resolve(dir);
  if (!fs.existsSync(d)) return { status: 'SKIP', why: '目录不存在：' + d, files: [] };
  const out = [];
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else if (/\.pdf$/i.test(e.name)) out.push(readPdf(q, opts));
    }
  })(d);
  if (!out.length) return { status: 'SKIP', why: '目录里没有 PDF ⇒ 未核对（未检查 ≠ 通过）', files: [] };
  const errs = out.filter((x) => x.status === 'FAIL').length;
  const unchecked = out.filter((x) => x.status === 'UNCHECKED').length;
  return { status: errs ? 'FAIL' : 'PASS', files: out, counts: { total: out.length, fail: errs, unchecked }, dir: d };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pdfmeta-'));
  const mk = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'latin1'); return p; };
  const LEAK = '%PDF-1.4\n1 0 obj << /Author (Zhang San) /Creator (Microsoft Word) /Title (SOH prediction) >> endobj\ntrailer << /Info 1 0 R >>\n%%EOF\n';
  const CLEAN = '%PDF-1.4\n1 0 obj << /Creator (Matplotlib v3.11.2, https://matplotlib.org) /Producer (Matplotlib pdf backend v3.11.2) >> endobj\ntrailer << /Info 1 0 R >>\n%%EOF\n';
  const EMAIL = '%PDF-1.4\n1 0 obj << /Creator (LaTeX with hyperref) >> endobj\n% contact: zhangsan@example.edu\n%%EOF\n';
  const NOMETA = '%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n';

  ck('正控：只有工具链痕迹（Matplotlib）⇒ PASS 且给出 Creator/Producer 读数', () => {
    const r = readPdf(mk('clean.pdf', CLEAN), { blind: true });
    return (r.status === 'PASS' && /Matplotlib/.test((r.info.Creator || ''))) ? true : JSON.stringify(r);
  });

  ck('★必失败面：/Author 非空 ⇒ ERROR（双盲稿 PDF 属性不该含作者）', () => {
    const r = readPdf(mk('leak.pdf', LEAK), { blind: true });
    return (r.status === 'FAIL' && r.issues.some((x) => x.check === 'author-in-pdf-properties')) ? true : JSON.stringify(r.issues);
  });

  ck('★必失败面：字节里命中邮箱 ⇒ ERROR（即使元数据里没有）', () => {
    const r = readPdf(mk('email.pdf', EMAIL), { blind: true });
    return (r.status === 'FAIL' && r.issues.some((x) => x.check === 'email-in-pdf')) ? true : JSON.stringify(r.issues);
  });

  ck('★必失败面：**读不到任何元数据 ⇒ UNCHECKED（不是 PASS）**，并说明可能是对象流压缩', () => {
    const r = readPdf(mk('nometa.pdf', NOMETA), { blind: true });
    if (r.status === 'PASS') return '读不到元数据却判 PASS（会把"没核对"当干净）：' + JSON.stringify(r);
    if (r.status !== 'UNCHECKED') return '应判 UNCHECKED，实际 ' + r.status;
    if (!r.notes.some((x) => /未读到 Info 字典/.test(x))) return '未说明未核对原因：' + JSON.stringify(r.notes);
    return true;
  });

  ck('★必失败面（真文件实测得来）：压缩流二进制里的假邮箱（K@48G9-.BYBGNPTUT）**不得**报 ERROR', () => {
    const r = readPdf(mk('noise.pdf', '%PDF-1.4\n1 0 obj << /Producer (OpenPDF 1.4.2) >> endobj\n% K@48G9-.BYBGNPTUT\n%%EOF\n'), { blind: true });
    const errs = r.issues.filter((x) => x.level === 'ERROR');
    return (errs.length === 0) ? true : '假阳性：' + JSON.stringify(errs);
  });

  ck('★必失败面：**字节扫描命中降为 WARN**（元数据命中才是 ERROR）—— 附 isMeta 分级', () => {
    const byteOnly = readPdf(mk('b.pdf', '%PDF-1.4\n1 0 obj << /Producer (X) >> endobj\n% mail: real.author@university.edu\n%%EOF\n'), { blind: true });
    const metaHit = readPdf(mk('m.pdf', '%PDF-1.4\n1 0 obj << /Author (real.author@university.edu) >> endobj\n%%EOF\n'), { blind: true });
    const a = byteOnly.issues.find((x) => x.check === 'email-in-pdf');
    const b = metaHit.issues.find((x) => x.check === 'email-in-pdf');
    if (!a || a.level !== 'WARN') return '字节命中应为 WARN：' + JSON.stringify(byteOnly.issues);
    if (!b || b.level !== 'ERROR') return '元数据命中应为 ERROR：' + JSON.stringify(metaHit.issues);
    return true;
  });

  ck('★必失败面：非 PDF 与不存在的文件 ⇒ SKIP（未检查 ≠ 通过）', () => {
    const notPdf = mk('x.txt', 'hello world');
    const a = readPdf(notPdf, {}); const b = readPdf(path.join(tmp, 'nope.pdf'), {});
    return (a.status === 'SKIP' && b.status === 'SKIP') ? true : JSON.stringify([a.status, b.status]);
  });

  ck('正控：`--blind false` 时 /Author 不再算违规（非双盲稿允许署名）', () => {
    const r = readPdf(mk('leak2.pdf', LEAK), { blind: false });
    return (r.status === 'PASS') ? true : JSON.stringify(r.issues);
  });

  ck('空目录 ⇒ SKIP（没有 PDF 就是没核对）', () => {
    const empty = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'pdfmeta-empty-'));
    const r = scanDir(empty, {});
    return (r.status === 'SKIP') ? true : JSON.stringify(r.status);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\npdf-meta 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const blind = argv.includes('--no-blind') ? false : true;
  const one = val('--pdf'); const dir = val('--dir');
  if (!one && !dir) { console.error('用法：pdf-meta --pdf <file.pdf> | --dir <目录> [--no-blind] [--json] | --selftest'); return 2; }
  if (one) {
    const r = readPdf(path.resolve(one), { blind });
    if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : (r.status === 'PASS' ? 0 : 2); }
    console.log('PDF 元数据实读：' + r.status + '（' + r.file + ' · ' + Math.round(r.size / 1024) + ' KB）');
    console.log('  元数据：' + JSON.stringify(r.info));
    if (Object.keys(r.xmp).length) console.log('  XMP：' + JSON.stringify(r.xmp));
    for (const x of r.issues) console.log('  ' + (x.level === 'ERROR' ? '✘' : '·') + ' [' + x.level + '/' + x.check + '] ' + x.msg);
    for (const n of r.notes) console.log('  · ' + n);
    console.log('  边界：' + r.boundary);
    return r.status === 'FAIL' ? 1 : (r.status === 'PASS' ? 0 : 2);
  }
  const r = scanDir(dir, { blind });
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why); return 2; }
  console.log('PDF 元数据扫描：' + r.status + '（' + r.dir + ' · ' + r.counts.total + ' 个 PDF · 违规 ' + r.counts.fail + ' · 未核对 ' + r.counts.unchecked + '）');
  for (const f of r.files) {
    console.log('  ' + (f.status === 'FAIL' ? '✘' : (f.status === 'PASS' ? '✔' : '?')) + ' ' + f.file + ' ⇒ ' + f.status);
    for (const x of f.issues) console.log('      [' + x.level + '/' + x.check + '] ' + x.msg);
    for (const n of f.notes) console.log('      · ' + n);
  }
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { readPdf, scanDir, isPdf, main, selftest };
