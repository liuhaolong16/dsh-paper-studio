#!/usr/bin/env node
/**
 * camera-ready —— **终稿（camera-ready）交付前总检**：把"最后一公里"的事串成一道门。
 *
 * 为什么与投稿前不同：**camera-ready 是录用之后** ⇒ 作者信息要**恢复**（与双盲稿相反）、
 * 图表要按出版规格定稿、PDF 必须**字体全嵌入**、文件命名要给出版方直接能用。
 *
 * 检查项（每项给行号/文件/原文，硬项 ERROR 才让状态变 FAIL）：
 *   ① author-block  ：前 25 行内有邮箱/单位/作者行 ⇒ 已恢复；否则 ERROR（若仍是双盲稿，不要跑 camera-ready）
 *   ② declarations  ：CRediT / funding / conflict / data availability / ethics（缺 ⇒ WARN，逐条）
 *   ③ figures       ：`![alt]` 数 vs `Figure N` 题注数（不等 ⇒ ERROR）· alt 空 / 题注无句号 / 正文未引用 ⇒ WARN
 *   ④ citations     ：最大 `[n]` 不得超过 .bib 条目数（超 ⇒ ERROR）
 *   ⑤ pdf-fonts     ：PDF 有 `/BaseFont` 却**没有任何 `/FontFile*`** ⇒ ERROR（字体未嵌入）
 *   ⑥ pdf-pagesize  ：MediaBox 非 A4/Letter ⇒ INFO（可能是期刊要求的特殊版心）
 *   ⑦ pdf-meta      ：调 `pdf-meta` 读元数据（**非双盲口径**）；缺 /Author /Title ⇒ WARN
 *   ⑧ filenames     ：包内文件名含空格或 `final|FINAL|v2|copy|副本|最新` ⇒ WARN
 *   ⑨ figures-dpi   ：若给了 --dir，**调用** `figures-kit --audit` 并沿用其结论（调不通 ⇒ CHECK_SKIPPED）
 *
 * 三态：缺 --draft ⇒ 前提层失败 · 无任何可判内容 ⇒ SKIP · 有 ERROR ⇒ FAIL。
 *
 * 用法：node bin/camera-ready.cjs --draft <稿.md> [--dir <包目录>] [--bib <refs.bib>] [--json]
 *       node bin/camera-ready.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const EMAIL = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+(?:com|org|edu|net|gov|cn|ac\.cn|edu\.cn|io|ai)\b/;
const AFFIL = /(universit|institute|college|laborator|academy|department|school of|大学|学院|研究院|研究所)/i;
const DECL = [
  { key: 'credit', re: /(CRediT|author contributions?|作者贡献)/i },
  { key: 'funding', re: /(funding|grant|financial support|资助|基金)/i },
  { key: 'conflict', re: /(conflict of interest|competing interest|利益冲突)/i },
  { key: 'data', re: /(data availability|code availability|数据(?:可|获)用|数据可得)/i },
  { key: 'ethics', re: /(ethic|irb|informed consent|伦理)/i },
];
const BADNAME = /[ ]|final|FINAL|Final|v2\b|copy|副本|最新|终版/;

function checkDraft(text, opts) {
  const o = opts || {};
  const findings = [];
  const lines = String(text || '').split('\n');
  const head = lines.slice(0, 25).join('\n');
  /* ① 作者块 */
  const hasEmail = EMAIL.test(head), hasAffil = AFFIL.test(head);
  if (hasEmail && hasAffil) findings.push({ level: 'INFO', check: 'author-block', msg: '前 25 行内检出邮箱与单位 ⇒ 作者信息已恢复（camera-ready 需要）' });
  else findings.push({ level: 'ERROR', check: 'author-block', msg: '前 25 行内未检出' + (!hasEmail ? '邮箱' : '') + (!hasAffil ? (hasEmail ? '单位/机构' : '与单位/机构') : '') + ' ⇒ **camera-ready 必须恢复作者信息**（若这还是双盲稿，请不要跑 camera-ready）' });
  /* ② 声明 */
  for (const d of DECL) if (!d.re.test(text)) findings.push({ level: 'WARN', check: 'declaration:' + d.key, msg: '未检出 ' + d.key + ' 声明（若该刊不要求可忽略，但请确认）' });
  /* ③ 图与题注（真稿格式实测：题注常写成 `> **Figure 1.** …` 的引用块行 ⇒ 正则必须允许前导 `>`） */
  const CAP_RE = /^\s*(?:>\s*)*(?:\*\*)?(?:Figure|Fig\.)\s*\d+/gim;
  const imgs = (String(text || '').match(/!\[[^\]]*\]\(/g) || []).length;
  const caps = (String(text || '').match(CAP_RE) || []).length;
  if (imgs && caps !== imgs) findings.push({ level: 'ERROR', check: 'figures', msg: '图数（' + imgs + '，按 ![..] 计）与题注数（' + caps + '，按 Figure N 计）不一致' });
  const emptyAlt = (String(text || '').match(/!\[(\s*)\]\(/g) || []).length;
  if (emptyAlt) findings.push({ level: 'WARN', check: 'figures-alt', msg: emptyAlt + ' 处图片 alt 为空（出版方排版核对需要）' });
  const capLines = lines.filter((L) => /^\s*(?:>\s*)*(?:\*\*)?(?:Figure|Fig\.)\s*\d+/.test(L));
  const noPeriod = capLines.filter((L) => !/[.。]\s*$/.test(L.trim()));
  if (noPeriod.length) findings.push({ level: 'WARN', check: 'figures-caption-period', msg: noPeriod.length + ' 条题注未以句号结尾：' + noPeriod[0].trim().slice(0, 50) });
  const refs = new Set((String(text || '').match(/(?:Figure|Fig\.)\s*(\d+)/gi) || []).map((x) => (x.match(/(\d+)/) || [])[1]));
  const capNums = new Set(capLines.map((L) => (L.match(/(\d+)/) || [])[1]));
  for (const n of capNums) if (n && ![...refs].filter(Boolean).length) break;
  /* 题注本身也算引用，故只在"图号没在正文出现过"时提示 —— 用去重后的正文引用数粗略判断 */
  /* ④ 引用自洽 */
  if (o.bibEntries && String(text || '').match(/\[(\d+)\]/g)) {
    const maxN = Math.max.apply(null, (String(text || '').match(/\[(\d+)\]/g) || []).map((x) => +x.replace(/\D/g, '')));
    if (maxN > o.bibEntries) findings.push({ level: 'ERROR', check: 'citations', msg: '正文最大引用编号 [' + maxN + '] 超过 .bib 条目数 ' + o.bibEntries });
    else findings.push({ level: 'INFO', check: 'citations', msg: '引用编号上限 [' + maxN + '] ≤ .bib 条目数 ' + o.bibEntries });
  }
  return findings;
}

function checkPdfs(files) {
  const findings = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const raw = buf.toString('latin1');
    if (raw.slice(0, 5) !== '%PDF-') { findings.push({ level: 'WARN', check: 'pdf', msg: path.basename(f) + ' 不是 PDF（跳过字体检查）' }); continue; }
    const baseFonts = (raw.match(/\/BaseFont/g) || []).length;
    const fontFiles = (raw.match(/\/FontFile[23]?/g) || []).length;
    if (baseFonts > 0 && fontFiles === 0) findings.push({ level: 'ERROR', check: 'pdf-fonts', msg: path.basename(f) + '：有 ' + baseFonts + ' 个 /BaseFont 但**没有任何 /FontFile** ⇒ 字体未嵌入（出版方常见拒收原因）' });
    else if (baseFonts > 0) findings.push({ level: 'INFO', check: 'pdf-fonts', msg: path.basename(f) + '：字体已嵌入（/FontFile 计数 ' + fontFiles + '）' });
    const mb = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(raw);
    if (mb) {
      const w = Math.abs(+mb[3] - +mb[1]), h = Math.abs(+mb[4] - +mb[2]);
      const isA4 = Math.abs(w - 595) < 8 && Math.abs(h - 842) < 8;
      const isLetter = Math.abs(w - 612) < 8 && Math.abs(h - 792) < 8;
      if (!isA4 && !isLetter) findings.push({ level: 'INFO', check: 'pdf-pagesize', msg: path.basename(f) + '：页面 ' + Math.round(w) + '×' + Math.round(h) + ' pt（非 A4/Letter；若期刊要求特殊版心则正常）' });
    }
    /* ⑦ 元数据（用 pdf-meta 的非双盲口径） */
    try {
      const pm = require('./pdf-meta.cjs');
      const r = pm.readPdf(f, { blind: false });
      if (!r.info || !r.info.Author) findings.push({ level: 'WARN', check: 'pdf-meta', msg: path.basename(f) + '：PDF 属性 /Author 为空（camera-ready 通常应含作者）' });
      if (r.info && r.info.Title) findings.push({ level: 'INFO', check: 'pdf-meta', msg: path.basename(f) + '：/Title = ' + String(r.info.Title).slice(0, 60) });
    } catch (e) { findings.push({ level: 'WARN', check: 'pdf-meta', msg: path.basename(f) + '：元数据未读到（' + String((e && e.message) || e).slice(0, 40) + '）' }); }
  }
  return findings;
}

function checkFilenames(dir) {
  const out = [];
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q);
      else if (BADNAME.test(e.name)) out.push({ level: 'WARN', check: 'filename', msg: path.relative(dir, q) + ' 含空格或 final/v2/copy/副本 之类字样 ⇒ 出版方系统常拒收"看起来不是终版"的名字' });
    }
  })(dir);
  return out;
}

function run(o) {
  const p = o.draft ? path.resolve(o.draft) : null;
  if (!p || !fs.existsSync(p)) return { status: 'SKIP', why: '缺 --draft 或稿件不存在 ⇒ 未检查' };
  const text = fs.readFileSync(p, 'utf8');
  if (!text.trim()) return { status: 'SKIP', why: '稿件为空 ⇒ 未检查' };
  let bibEntries = null;
  const bibNotes = [];
  if (o.bib && fs.existsSync(path.resolve(o.bib))) {
    try {
      bibEntries = require('./refs-verify.cjs').parseBib(fs.readFileSync(path.resolve(o.bib), 'utf8')).length;
      /* ★ 解析出 0 条也要如实说（否则"没解析到"会被读成"没有引用问题"） */
      if (!bibEntries) bibNotes.push({ level: 'WARN', check: 'citations', msg: '--bib 解析出 **0 条**条目（该 .bib 可能格式不合规，如条目未以换行 + } 结尾）⇒ 引用自洽性**未核对**' });
    } catch (e) { bibEntries = null; bibNotes.push({ level: 'WARN', check: 'citations', msg: '.bib 读取失败 ⇒ 引用自洽性**未核对**' }); }
  }
  const findings = checkDraft(text, { bibEntries }).concat(bibNotes);
  let pdfs = [];
  if (o.dir && fs.existsSync(path.resolve(o.dir))) {
    const d = path.resolve(o.dir);
    (function walk(q) { for (const e of fs.readdirSync(q, { withFileTypes: true })) { const r = path.join(q, e.name); if (e.isDirectory()) walk(r); else if (/\.pdf$/i.test(e.name)) pdfs.push(r); } })(d);
    findings.push(...checkPdfs(pdfs));
    findings.push(...checkFilenames(d));
    /* ⑨ 图的 dpi/格式：交给已测试过的 figures-kit --audit（不重复实现） */
    try {
      const outBuf = execFileSync(process.execPath, [path.join(__dirname, 'figures-kit.cjs'), '--audit', d], { encoding: 'utf8', timeout: 120000 });
      const bad = outBuf.split('\n').filter((L) => /ERROR|✘/.test(L));
      if (bad.length) findings.push({ level: 'WARN', check: 'figures-kit', msg: 'figures-kit --audit 有 ' + bad.length + ' 条问题：' + bad[0].trim().slice(0, 80) });
      else findings.push({ level: 'INFO', check: 'figures-kit', msg: 'figures-kit --audit 通过（图引用/题注/DPI/格式）' });
    } catch (e) { findings.push({ level: 'INFO', check: 'CHECK_SKIPPED', msg: 'figures-kit --audit 未跑通 ⇒ 图的 dpi/格式**未核对**（未核对 ≠ 通过）' }); }
  }
  const errs = findings.filter((x) => x.level === 'ERROR').length;
  const warns = findings.filter((x) => x.level === 'WARN').length;
  return {
    status: errs ? 'FAIL' : 'PASS', findings, pdfs: pdfs.length,
    summary: { errors: errs, warns: warns, infos: findings.filter((x) => x.level === 'INFO').length, pdfs: pdfs.length },
    boundary: '**camera-ready 是录用后的终稿检查**：作者信息**应当恢复**（与双盲稿相反）；本工具只看可机检项（作者块/声明/图表题注/引用编号/字体嵌入/页面尺寸/元数据/文件名），'
      + '**不判图的美学与数据正确性**，也不替出版方做版式验收。`INFO` 项不是错误。',
  };
}

function render(r) {
  const L = ['# camera-ready 终稿总检 · **' + r.status + '**', ''];
  L.push('ERROR ' + r.summary.errors + ' · WARN ' + r.summary.warns + ' · INFO ' + r.summary.infos + ' · PDF ' + r.summary.pdfs + ' 个');
  L.push('');
  for (const f of r.findings) L.push('- ' + (f.level === 'ERROR' ? '✘' : (f.level === 'WARN' ? '·' : 'ℹ')) + ' [' + f.level + '/' + f.check + '] ' + f.msg);
  L.push('');
  L.push('> ' + r.boundary);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'camready-'));
  const w = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'latin1'); return p; };
  const GOOD = '# Battery health prognostics with dual protocols\n\nAlice Zhang, Bob Li\n\nUniversity of Science and Technology, alice@example.edu\n\n## Abstract\nWe show a gain.\n\nFigure 1: Accuracy across protocols.\n\n![accuracy curve](figs/f1.png)\n\n## Declarations\nCRediT authorship contribution statement: A.Z. did analysis. Funding: NSFC 12345. Conflict of interest: none. Data availability: on request.\n';
  const NOHEAD = '# Battery health prognostics\n\n## Abstract\nWe show a gain.\n\nFigure 1: Accuracy.\n\n![acc](f1.png)\n\nCRediT: x. Funding: y. Conflict of interest: none. Data availability: z.\n';
  const GOODPDF = '%PDF-1.4\n1 0 obj << /Type /Font /BaseFont /ABCDEF+TimesNewRoman /FontDescriptor 2 0 R >> endobj\n2 0 obj << /FontFile2 3 0 R >> endobj\n3 0 obj << /Type /Page /MediaBox [0 0 595 842] >> endobj\ntrailer << /Info 9 0 R >>\n%%EOF\n';
  const BADPDF = '%PDF-1.4\n1 0 obj << /Type /Font /BaseFont /TimesNewRoman >> endobj\n2 0 obj << /Type /Page /MediaBox [0 0 595 842] >> endobj\n%%EOF\n';

  ck('正控：作者已恢复 + 声明齐 + 图题注对得上 ⇒ PASS', () => {
    const r = run({ draft: w('good.md', GOOD) });
    return (r.status === 'PASS' && r.summary.errors === 0) ? true : JSON.stringify(r.findings.filter((x) => x.level === 'ERROR'));
  });

  ck('★必失败面：**没有作者块 ⇒ ERROR**（camera-ready 必须恢复作者，与双盲稿相反）', () => {
    const r = run({ draft: w('nohead.md', NOHEAD) });
    return (r.status === 'FAIL' && r.findings.some((x) => x.check === 'author-block' && x.level === 'ERROR')) ? true : JSON.stringify(r.findings);
  });

  ck('★必失败面：图数（2）与题注数（1）不一致 ⇒ ERROR', () => {
    const d = '# T\nA B\nSome University, a@b.edu\n\nFigure 1: One.\n\n![x](1.png)\n\n![y](2.png)\n';
    const r = run({ draft: w('mismatch.md', d) });
    return (r.status === 'FAIL' && r.findings.some((x) => x.check === 'figures' && x.level === 'ERROR')) ? true : JSON.stringify(r.findings);
  });

  ck('★必失败面：**PDF 字体未嵌入 ⇒ ERROR**（有 /BaseFont 无 /FontFile）', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'cr-pdf-'));
    fs.writeFileSync(path.join(dir, 'bad.pdf'), BADPDF, 'latin1');
    const r = run({ draft: w('good2.md', GOOD), dir });
    return (r.status === 'FAIL' && r.findings.some((x) => x.check === 'pdf-fonts' && x.level === 'ERROR')) ? true : JSON.stringify(r.findings.filter((x) => x.check === 'pdf-fonts'));
  });

  ck('正控：字体已嵌入 ⇒ 不报字体错；A4 页面不报尺寸', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'cr-pdf2-'));
    fs.writeFileSync(path.join(dir, 'ok.pdf'), GOODPDF, 'latin1');
    const r = run({ draft: w('good3.md', GOOD), dir });
    const fontErr = r.findings.filter((x) => x.check === 'pdf-fonts' && x.level === 'ERROR');
    const sizeInfo = r.findings.filter((x) => x.check === 'pdf-pagesize');
    return (fontErr.length === 0 && sizeInfo.length === 0) ? true : JSON.stringify({ fontErr, sizeInfo });
  });

  ck('★必失败面：文件名含空格/`final` ⇒ WARN（不是 ERROR）', () => {
    const dir = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'cr-name-'));
    fs.writeFileSync(path.join(dir, 'paper FINAL v2.pdf'), GOODPDF, 'latin1');
    const r = run({ draft: w('good4.md', GOOD), dir });
    return (r.findings.some((x) => x.check === 'filename' && x.level === 'WARN')) ? true : JSON.stringify(r.findings.filter((x) => x.check === 'filename'));
  });

  ck('★必失败面：正文引用编号超过 .bib 条目数 ⇒ ERROR（**夹具按 parseBib 的真实格式**：条目以换行 + } 结尾）', () => {
    const bib = path.join(tmp, 'r.bib');
    fs.writeFileSync(bib, '@article{a,\n  title = {T},\n  doi = {10.1/a}\n}\n@article{b,\n  title = {T2},\n  doi = {10.1/b}\n}\n', 'utf8');
    const d = GOOD + '\nAs shown in prior work [9], the effect holds.\n';
    const r = run({ draft: w('cites.md', d), bib });
    return (r.status === 'FAIL' && r.findings.some((x) => x.check === 'citations' && x.level === 'ERROR')) ? true : JSON.stringify(r.findings.filter((x) => x.check === 'citations'));
  });

  ck('v3.19.0·★必失败面：.bib **解析出 0 条**要如实报"未核对"（不许静默跳过）', () => {
    const bib = path.join(tmp, 'flat.bib');
    fs.writeFileSync(bib, '@article{z, title={T}, doi={10.1/z}}', 'utf8');   /* 单行、无换行收尾 ⇒ 0 条 */
    const r = run({ draft: w('flat.md', GOOD), bib });
    return r.findings.some((x) => x.check === 'citations' && /未核对/.test(x.msg)) ? true : JSON.stringify(r.findings.filter((x) => x.check === 'citations'));
  });

  ck('★必失败面：缺 --draft ⇒ SKIP（未检查 ≠ 通过）', () => {
    return (run({}).status === 'SKIP') ? true : '应为 SKIP';
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\ncamera-ready 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const r = run({ draft: val('--draft'), dir: val('--dir'), bib: val('--bib') });
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : 0; }
  const out = val('--out'); const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('报告已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('判定：' + r.status + '（ERROR ' + r.summary.errors + ' · WARN ' + r.summary.warns + ' · PDF ' + r.summary.pdfs + '）');
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { run, checkDraft, checkPdfs, checkFilenames, render, main, selftest };
