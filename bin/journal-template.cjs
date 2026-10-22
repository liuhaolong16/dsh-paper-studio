#!/usr/bin/env node
'use strict';

/**
 * 期刊模板知识库 · 调度与机检（journal-template）
 *
 * 规则（用户 2026-10-22 明确要求）：
 *   1) 投指定期刊 ⇒ 严格按知识库里该刊模板；字号 / 字体 / 页边距 / 颜色一项不能错。
 *   2) 没指定期刊 ⇒ 用通用模板（generic）。
 *   3) 指定了但知识库没有该刊 ⇒ 必须先去收集模板并入知识库，**不得直接套通用模板**。
 *
 * 用法：
 *   node bin/journal-template.cjs --list
 *   node bin/journal-template.cjs --resolve --journal "Journal of Energy Storage" [--format docx|latex]
 *   node bin/journal-template.cjs --check <稿.docx> --journal <id>
 *   node bin/journal-template.cjs --check-tex <稿.tex> --journal <id>
 *   node bin/journal-template.cjs --selftest
 *
 * 退出码：0 = 通过；1 = 格式不符 / 缺模板；2 = 用法或前提层错误。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const KB = path.join(ROOT, 'templates');
const INDEX = path.join(KB, 'index.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadIndex() {
  if (!fs.existsSync(INDEX)) throw new Error('知识库索引不存在：' + INDEX);
  return readJson(INDEX);
}

function specPathOf(entry) {
  return path.join(ROOT, entry.path);
}

function loadSpec(entry) {
  return readJson(specPathOf(entry));
}

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[\s_]+/g, ' ').trim();
}

function resolveJournal(index, query) {
  const q = normalize(query);
  if (!q) return null;
  const all = index.templates || [];
  const exact = all.find((e) => normalize(e.id) === q || normalize(e.journal) === q);
  if (exact) return exact;
  const alias = all.find((e) => (e.aliases || []).some((a) => normalize(a) === q));
  if (alias) return alias;
  return all.find((e) => normalize(e.journal).includes(q) || normalize(e.id).includes(q)
    || (e.aliases || []).some((a) => normalize(a).includes(q))) || null;
}

// ---------- docx 读数（独立 ZIP 实现，不依赖 python） ----------

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 ZIP/OOXML：找不到 EOCD');
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    out.push({ name, method, csize, lho });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function zipRead(buf, entry) {
  const nameLen = buf.readUInt16LE(entry.lho + 26);
  const extraLen = buf.readUInt16LE(entry.lho + 28);
  const start = entry.lho + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + entry.csize);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

function attr(xml, name) {
  const m = xml.match(new RegExp(name + '="([^"]*)"'));
  return m ? m[1] : null;
}

function twipsToCm(tw) {
  return Number(tw) / 566.929133858;
}

function docxFacts(file) {
  const buf = fs.readFileSync(file);
  const entries = zipEntries(buf);
  const docEntry = entries.find((e) => e.name === 'word/document.xml');
  const styleEntry = entries.find((e) => e.name === 'word/styles.xml');
  if (!docEntry) throw new Error('包里没有 word/document.xml（不是 .docx）');
  const doc = zipRead(buf, docEntry).toString('utf8');
  const styles = styleEntry ? zipRead(buf, styleEntry).toString('utf8') : '';

  const pgSz = (doc.match(/<w:pgSz\b[^>]*>/) || [''])[0];
  const pgMar = (doc.match(/<w:pgMar\b[^>]*>/) || [''])[0];
  const widthTw = attr(pgSz, 'w:w');
  const heightTw = attr(pgSz, 'w:h');

  const defaults = (styles.match(/<w:docDefaults>[\s\S]*?<\/w:docDefaults>/) || [''])[0];
  const defRpr = (defaults.match(/<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/) || [''])[0];
  const defFonts = (defRpr.match(/<w:rFonts\b[^>]*>/) || [''])[0];
  const defSz = (defRpr.match(/<w:sz\b[^>]*>/) || [''])[0];
  const normal = (styles.match(/<w:style\b[^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/) || [''])[0];
  const normalRpr = (normal.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
  const normalFonts = (normalRpr.match(/<w:rFonts\b[^>]*>/) || [''])[0];
  const normalSz = (normalRpr.match(/<w:sz\b[^>]*>/) || [''])[0];
  const normalSpacing = (normal.match(/<w:spacing\b[^>]*>/) || [''])[0];

  const colors = [];
  for (const m of doc.matchAll(/<w:color\b[^>]*w:val="([^"]+)"/g)) colors.push(m[1].toUpperCase());
  for (const m of styles.matchAll(/<w:color\b[^>]*w:val="([^"]+)"/g)) colors.push(m[1].toUpperCase());

  const sizeHalf = attr(normalSz || defSz, 'w:val');
  const line = attr(normalSpacing, 'w:line');

  return {
    page: widthTw && heightTw ? { width_cm: twipsToCm(widthTw), height_cm: twipsToCm(heightTw) } : null,
    margins_cm: pgMar ? {
      top: twipsToCm(attr(pgMar, 'w:top')),
      bottom: twipsToCm(attr(pgMar, 'w:bottom')),
      left: twipsToCm(attr(pgMar, 'w:left')),
      right: twipsToCm(attr(pgMar, 'w:right')),
    } : null,
    default_font: {
      ascii: attr(normalFonts || defFonts, 'w:ascii'),
      eastAsia: attr(normalFonts || defFonts, 'w:eastAsia'),
      size_pt: sizeHalf ? Number(sizeHalf) / 2 : null,
    },
    line_spacing: line ? Number(line) / 240 : null,
    colors: Array.from(new Set(colors)),
  };
}

// ---------- 比对（纯函数，供 selftest 直接测） ----------

const EPS = { cm: 0.06, pt: 0.15, line: 0.05 };

function compareDocx(facts, spec) {
  const d = spec.docx || {};
  const issues = [];
  const push = (code, field, expected, actual) => issues.push({ code, field, expected, actual });

  if (d.page && facts.page) {
    for (const key of ['width_cm', 'height_cm']) {
      if (Math.abs(facts.page[key] - d.page[key]) > EPS.cm) push('E_PAGE', key, d.page[key], facts.page[key]);
    }
  } else if (d.page && !facts.page) {
    push('E_PAGE_UNKNOWN', 'page', d.page.size || '(spec)', null);
  }

  if (d.margins_cm && facts.margins_cm) {
    for (const key of ['top', 'bottom', 'left', 'right']) {
      if (Math.abs(facts.margins_cm[key] - d.margins_cm[key]) > EPS.cm) {
        push('E_MARGIN', key, d.margins_cm[key], Number(facts.margins_cm[key].toFixed(3)));
      }
    }
  }

  const df = d.default_font || {};
  const ff = facts.default_font || {};
  if (df.ascii && ff.ascii && df.ascii.toLowerCase() !== String(ff.ascii).toLowerCase()) {
    push('E_FONT_ASCII', 'default_font.ascii', df.ascii, ff.ascii);
  }
  if (df.eastAsia && ff.eastAsia && df.eastAsia !== ff.eastAsia) {
    push('E_FONT_EASTASIA', 'default_font.eastAsia', df.eastAsia, ff.eastAsia);
  }
  if (df.size_pt && ff.size_pt && Math.abs(ff.size_pt - df.size_pt) > EPS.pt) {
    push('E_FONT_SIZE', 'default_font.size_pt', df.size_pt, ff.size_pt);
  }

  if (d.line_spacing && facts.line_spacing && Math.abs(facts.line_spacing - d.line_spacing) > EPS.line) {
    push('E_LINE_SPACING', 'line_spacing', d.line_spacing, facts.line_spacing);
  }

  const allowed = new Set(['000000', 'AUTO']);
  if (spec.colors && spec.colors.text) allowed.add(String(spec.colors.text).replace('#', '').toUpperCase());
  for (const color of (spec.colors && spec.colors.allowed) || []) allowed.add(String(color).replace('#', '').toUpperCase());
  for (const color of facts.colors || []) {
    const value = String(color).toUpperCase();
    if (value === 'AUTO') continue;
    if (!allowed.has(value)) push('E_COLOR', 'w:color', '#000000', '#' + value);
  }

  return issues;
}

// ---------- tex 读数 ----------

function texFacts(file) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/);
  if (!m) return null;
  return { cls: m[2].trim(), options: (m[1] || '').split(',').map((s) => s.trim()).filter(Boolean) };
}

function compareTex(facts, spec) {
  const t = spec.latex || {};
  const issues = [];
  if (!facts) return [{ code: 'E_TEX_NO_DOCCLASS', field: 'documentclass', expected: t.class, actual: null }];
  if (t.class && facts.cls !== t.class) issues.push({ code: 'E_TEX_CLASS', field: 'class', expected: t.class, actual: facts.cls });
  for (const opt of t.required_options || []) {
    if (!facts.options.includes(opt)) issues.push({ code: 'E_TEX_OPTION', field: 'options', expected: opt, actual: facts.options.join(',') });
  }
  for (const prefix of t.required_option_prefixes || []) {
    if (!facts.options.some((o) => o.startsWith(prefix))) {
      issues.push({ code: 'E_TEX_OPTION_PREFIX', field: 'options', expected: prefix + '*', actual: facts.options.join(',') });
    }
  }
  return issues;
}

// ---------- CLI ----------

function printList(index) {
  console.log('期刊模板知识库（templates/）');
  for (const e of index.templates || []) {
    console.log(`  ${e.id.padEnd(22)} ${String(e.kind).padEnd(12)} ${String(e.status).padEnd(18)} ${e.journal}`);
  }
  console.log(`  generic = ${index.generic}`);
}

function cmdResolve(index, journal, format) {
  const entry = resolveJournal(index, journal);
  if (!entry) {
    console.log(JSON.stringify({
      ok: false, code: 'NO_TEMPLATE', journal,
      guidance: '知识库没有该刊模板：先去期刊官网 Guide for Authors / Templates 页下载官方模板，存入 templates/<id>/files/，补 spec.json 并登记 index.json，再写稿。不得直接套通用模板。'
    }, null, 2));
    return 1;
  }
  const spec = loadSpec(entry);
  if (format === 'docx' && !spec.docx) {
    const what = spec.latex ? 'LaTeX 类模板' : (spec.kind === 'guidelines' ? '格式指南（guidelines）' : '非 Word 模板');
    console.log(JSON.stringify({
      ok: false, code: 'NO_DOCX_TEMPLATE', journal: entry.journal, id: entry.id, kind: entry.kind,
      guidance: `该刊目前只有${what}；Word 投稿需先收集该刊 Word 模板并入知识库（不得套用其它格式或通用模板）。`
    }, null, 2));
    return 1;
  }
  console.log(JSON.stringify({ ok: true, entry, spec }, null, 2));
  return 0;
}

function cmdCheck(index, docx, journal) {
  const entry = resolveJournal(index, journal);
  if (!entry) {
    console.log(`缺模板：${journal} 不在知识库 ⇒ 先收集再写（NO_TEMPLATE）`);
    return 1;
  }
  const spec = loadSpec(entry);
  if (!spec.docx) {
    console.log(`该刊只登记了 LaTeX 类模板（${spec.kind}）⇒ 不能按 Word 检查，需先收集 Word 模板（NO_DOCX_TEMPLATE）`);
    return 1;
  }
  if (!fs.existsSync(docx)) {
    console.log(`前提层失败：文件不存在 ${docx}`);
    return 2;
  }
  const issues = compareDocx(docxFacts(docx), spec);
  if (issues.length === 0) {
    console.log(`通过：${docx} 符合 ${entry.journal}（${entry.id}）`);
    return 0;
  }
  console.log(`未通过：${docx} vs ${entry.journal}（${issues.length} 项）`);
  for (const i of issues) console.log(`  [${i.code}] ${i.field}: 期望 ${i.expected}，实际 ${i.actual}`);
  return 1;
}

function cmdCheckTex(index, tex, journal) {
  const entry = resolveJournal(index, journal);
  if (!entry) {
    console.log(`缺模板：${journal} 不在知识库 ⇒ 先收集再写（NO_TEMPLATE）`);
    return 1;
  }
  const spec = loadSpec(entry);
  if (!spec.latex) {
    console.log(`该刊没有登记 LaTeX 类模板（kind=${spec.kind}）⇒ 不能按 LaTeX 检查`);
    return 1;
  }
  if (!fs.existsSync(tex)) {
    console.log(`前提层失败：文件不存在 ${tex}`);
    return 2;
  }
  const issues = compareTex(texFacts(tex), spec);
  if (issues.length === 0) {
    console.log(`通过：${tex} 符合 ${entry.journal}（${entry.id}）`);
    return 0;
  }
  console.log(`未通过：${tex} vs ${entry.journal}（${issues.length} 项）`);
  for (const i of issues) console.log(`  [${i.code}] ${i.field}: 期望 ${i.expected}，实际 ${i.actual}`);
  return 1;
}

// ---------- selftest ----------

function selftest() {
  const results = [];
  const check = (name, ok, detail) => results.push({ name, ok, detail });

  const genericSpec = {
    docx: {
      page: { width_cm: 21, height_cm: 29.7 },
      margins_cm: { top: 2.54, bottom: 2.54, left: 3.17, right: 3.17 },
      default_font: { ascii: 'Times New Roman', eastAsia: '宋体', size_pt: 12 },
      line_spacing: 1.5,
    },
    colors: { text: '#000000' },
  };
  const good = {
    page: { width_cm: 21.0, height_cm: 29.7 },
    margins_cm: { top: 2.54, bottom: 2.54, left: 3.17, right: 3.17 },
    default_font: { ascii: 'Times New Roman', eastAsia: '宋体', size_pt: 12 },
    line_spacing: 1.5,
    colors: ['000000', 'AUTO'],
  };
  check('good docx facts must pass', compareDocx(good, genericSpec).length === 0, compareDocx(good, genericSpec));

  const bad = JSON.parse(JSON.stringify(good));
  bad.margins_cm.left = 2.5; bad.default_font.size_pt = 10.5; bad.default_font.ascii = 'Arial'; bad.colors = ['FF0000'];
  const badIssues = compareDocx(bad, genericSpec).map((i) => i.code);
  for (const code of ['E_MARGIN', 'E_FONT_SIZE', 'E_FONT_ASCII', 'E_COLOR']) {
    check(`bad facts must hit ${code}`, badIssues.includes(code), badIssues);
  }

  const texGood = { cls: 'elsarticle', options: ['a4paper', '10pt'] };
  const texSpec = { latex: { class: 'elsarticle', required_options: ['a4paper', '10pt'] } };
  check('good tex must pass', compareTex(texGood, texSpec).length === 0, compareTex(texGood, texSpec));
  const texBad = { cls: 'article', options: ['12pt'] };
  const texCodes = compareTex(texBad, texSpec).map((i) => i.code);
  check('bad tex must hit class+option', texCodes.includes('E_TEX_CLASS') && texCodes.includes('E_TEX_OPTION'), texCodes);

  const tmpIndex = { generic: 'generic', templates: [
    { id: 'generic', journal: '通用', aliases: ['default'], kind: 'docx-template', status: 'fallback', path: 'templates/generic/spec.json' },
    { id: 'elsevier-elsarticle', journal: 'Elsevier 期刊', aliases: ['Elsevier'], kind: 'latex-class', status: 'verified', path: 'templates/elsevier-elsarticle/spec.json' },
  ] };
  check('resolve alias', resolveJournal(tmpIndex, 'elsevier') !== null && resolveJournal(tmpIndex, 'elsevier').id === 'elsevier-elsarticle', null);
  check('resolve unknown returns null', resolveJournal(tmpIndex, '不存在的期刊') === null, null);

  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.detail)}`);
    if (!r.ok) failed += 1;
  }
  console.log(`\nselftest: ${results.length - failed}/${results.length} 通过`);
  return failed === 0 ? 0 : 1;
}

function cmdScaffold(index, journal, out) {
  const entry = resolveJournal(index, journal);
  if (!entry) {
    console.log(`缺模板：${journal} 不在知识库 ⇒ 先收集再写（NO_TEMPLATE）`);
    return 1;
  }
  if (!out) {
    console.log('用法：--scaffold --journal <名> --out <输出文件>');
    return 2;
  }
  const spec = loadSpec(entry);
  const rel = (spec.docx && spec.docx.template_file) || (spec.latex && spec.latex.template) || null;
  if (!rel) {
    console.log(`该条目没有可复制的模板文件（id=${entry.id}, kind=${spec.kind}）⇒ NO_TEMPLATE_FILE`);
    return 1;
  }
  const src = path.resolve(path.dirname(specPathOf(entry)), rel);
  if (!fs.existsSync(src)) {
    console.log(`前提层失败：模板文件不存在 ${rel}`);
    return 2;
  }
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.copyFileSync(src, out);
  console.log(`已按 ${entry.journal}（${entry.id}）模板生成：${out}`);
  console.log(`模板原件：${rel}（${fs.statSync(out).size} bytes）`);
  return 0;
}

function main(argv) {
  const args = argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
  };
  try {
    if (args.includes('--selftest')) { process.exitCode = selftest(); return; }
    const index = loadIndex();
    if (args.includes('--list')) { printList(index); return; }
    const journal = opt('--journal') || (args.includes('--resolve') ? args.find((a, i) => i > 0 && !a.startsWith('--') && args[i - 1] === '--resolve') : null);
    if (args.includes('--resolve')) {
      if (!journal) { console.log('用法：--resolve --journal <刊名或 id> [--format docx|latex]'); process.exitCode = 2; return; }
      process.exitCode = cmdResolve(index, journal, opt('--format'));
      return;
    }
    if (args.includes('--scaffold')) {
      const out = opt('--out');
      if (!journal) { console.log('用法：--scaffold --journal <名> --out <输出文件>'); process.exitCode = 2; return; }
      process.exitCode = cmdScaffold(index, journal, out);
      return;
    }
    if (args.includes('--check')) {
      const file = args[args.indexOf('--check') + 1];
      if (!file || file.startsWith('--') || !journal) { console.log('用法：--check <稿.docx> --journal <刊名或 id>'); process.exitCode = 2; return; }
      process.exitCode = cmdCheck(index, file, journal);
      return;
    }
    if (args.includes('--check-tex')) {
      const file = args[args.indexOf('--check-tex') + 1];
      if (!file || file.startsWith('--') || !journal) { console.log('用法：--check-tex <稿.tex> --journal <刊名或 id>'); process.exitCode = 2; return; }
      process.exitCode = cmdCheckTex(index, file, journal);
      return;
    }
    console.log('用法：--list | --resolve --journal <名> [--format docx|latex] | --scaffold --journal <名> --out <文件> | --check <docx> --journal <名> | --check-tex <tex> --journal <名> | --selftest');
    process.exitCode = 2;
  } catch (e) {
    console.error('失败：' + e.message);
    process.exitCode = 2;
  }
}

if (require.main === module) main(process.argv);
module.exports = { resolveJournal, compareDocx, compareTex, docxFacts, texFacts, loadIndex };
