#!/usr/bin/env node
/**
 * cfp —— **征稿启事（Call for Papers）解析**（用户缺口表：parse-cfp「要么没做，要么没机检」）。
 *
 * 抽什么（每一段都带**证据行号**与**置信度**）：投稿/摘要/通知/终稿等**各类截止日期** ·
 * **页数上限**（必须与 limit/max/不超过 同句，避免把「补充材料 12 页」当主限）· **双盲要求** ·
 * **模板/排版**（acmart / IEEEtran / llncs / AAAI / ACL / ICLR…）· **投稿系统**（EasyChair / HotCRP / OpenReview / CMT）·
 * **主题范围**（Topics/征稿范围 后的条目）· **场馆名** · **强制声明**（可复现/伦理/数据代码/LLM 声明）。
 *
 * ★ 诚实边界：征稿是自由文本 ⇒ 全部抽取都是**启发式**。回执必须给出：
 *   ① 每个命中项的**行号与原文片段**（人可复核）；② **未找到项清单**（用户必须自己补，不许当成"没有要求"）；
 *   ③ 置信度 `explicit`（同句有明确措辞）/ `inferred`（靠位置或弱措辞）。
 *   **未找到 ≠ 没有要求**；本工具不判"你符不符合"，只把要素摆出来并给出可直接跑的下一步命令。
 *
 * 用法：node bin/cfp.cjs --file <cfp.md|txt> [--json] [--out <file>] · node bin/cfp.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const DATE_RES = [
  { re: new RegExp('((?:19|20)\\d{2})[-/年.]\\s?(\\d{1,2})[-/月.]\\s?(\\d{1,2})日?'), kind: 'iso' },
  { re: new RegExp('((?:' + MONTHS + ')[a-z]*\\.?)\\s+(\\d{1,2}),?\\s+((?:19|20)\\d{2})', 'i'), kind: 'mdy' },
  { re: new RegExp('(\\d{1,2})\\s+((?:' + MONTHS + ')[a-z]*\\.?),?\\s+((?:19|20)\\d{2})', 'i'), kind: 'dmy' },
];
const DATE_KINDS = [
  { key: 'abstract', re: /abstract|摘要/i },
  { key: 'paper', re: /(full )?paper (?:submission|deadline)|submission deadline|paper due|投稿截止|论文提交/i },
  { key: 'notification', re: /notification|acceptance|通知/i },
  { key: 'camera-ready', re: /camera[- ]ready|final version|终稿|定稿/i },
  { key: 'rebuttal', re: /rebuttal|author response|作者回复/i },
  { key: 'deadline', re: /deadline|due|截止/i },
];
const SYSTEMS = /(easychair|hotcrp|openreview(?:\.net)?|microsoft cmt|\bcmt\b|editorial manager|scholarone|softconf|submit\.\w+|投稿系统)/i;
const TEMPLATES = /\b(acmart|acmsmall|acmlarge|IEEEtran|llncs|aaai\d*|acl|iclr\d*|neurips|emnlp|coling|springer|elsevier|lncs|usenix|acm sigchi|overleaf|word template|latex)\b/gi;
const MANDATORY = [
  { key: 'reproducibility', re: /reproducib|artifact|code (?:and|&) data|可复现|复现/i },
  { key: 'ethics', re: /ethic|irb|consent|伦理/i },
  { key: 'data-code', re: /data availability|code availability|数据集(?:公开|可用)/i },
  { key: 'llm', re: /large language model|\bLLM\b|generative AI|生成式|人工智能生成/i },
  { key: 'conflict', re: /conflict of interest|competing interest|利益冲突/i },
];

/** 抽一条日期：返回 y/m/d 与原文 */
function grabDate(s) {
  for (const d of DATE_RES) {
    const m = d.re.exec(s);
    if (!m) continue;
    let y, mo, da;
    if (d.kind === 'iso') { y = +m[1]; mo = +m[2]; da = +m[3]; }
    else if (d.kind === 'mdy') { mo = MONTHS.split('|').indexOf(m[1].slice(0, 3).replace(/^Sept$/, 'Sep')) + 1; da = +m[2]; y = +m[3]; }
    else { da = +m[1]; mo = MONTHS.split('|').indexOf(m[2].slice(0, 3).replace(/^Sept$/, 'Sep')) + 1; y = +m[3]; }
    if (!(mo >= 1 && mo <= 12) || !(da >= 1 && da <= 31) || !(y >= 1990)) continue;
    const pad = (n) => String(n).padStart(2, '0');
    return { value: y + '-' + pad(mo) + '-' + pad(da), raw: m[0] };
  }
  return null;
}

function parse(text) {
  const src = String(text || '');
  if (!src.trim()) return { status: 'SKIP', why: '文本为空 ⇒ 未解析' };
  const lines = src.split('\n').map((x) => x.trim());
  const out = { deadlines: [], pageLimit: null, doubleBlind: null, templates: [], systems: [], topics: [], venue: null, mandatory: [], missing: [], evidence: [] };
  const push = (field, value, line, raw, confidence) => { out.evidence.push({ field, value, line, raw: String(raw || '').slice(0, 120), confidence }); };

  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!L) continue;
    /* 截止日期：同句里有日期 + 日期类型关键词 */
    const hasDate = grabDate(L);
    if (hasDate) {
      const kind = DATE_KINDS.find((k) => k.re.test(L));
      if (kind) { out.deadlines.push({ kind: kind.key, date: hasDate.value, raw: hasDate.raw, line: i + 1, confidence: 'explicit' }); push('deadline:' + kind.key, hasDate.value, i + 1, L, 'explicit'); }
    }
    /* 页数上限：必须在 limit/max/不超过 同句；且**补充材料/附录的页数不算主页数上限**（分开记） */
    const pl = /(?:no more than|maximum of|at most|limit(?:ed)? to|up to|不超过|最多|限)\s*(\d{1,2})\s*(?:pages|pp|页)/i.exec(L);
    if (pl) {
      const isSupp = /supplementary|appendix|附录|补充/i.test(L);
      if (isSupp && !out.supplementaryLimit) {
        out.supplementaryLimit = { pages: +pl[1], line: i + 1, confidence: 'explicit', raw: L.slice(0, 120) };
        push('supplementaryLimit', pl[1] + ' pages', i + 1, L, 'explicit');
      } else if (!isSupp && !out.pageLimit) {
        out.pageLimit = { pages: +pl[1], line: i + 1, confidence: 'explicit', raw: L.slice(0, 120) };
        push('pageLimit', pl[1] + ' pages', i + 1, L, 'explicit');
      }
    }
    /* 双盲 */
    if (!out.doubleBlind && /double[- ]blind|blind review|anonymi[sz]ed|双盲|匿名审稿/i.test(L)) { out.doubleBlind = { required: true, line: i + 1, confidence: 'explicit', raw: L.slice(0, 120) }; push('doubleBlind', 'required', i + 1, L, 'explicit'); }
    if (!out.doubleBlind && /single[- ]blind|not anonymous|无需匿名|单盲/i.test(L)) { out.doubleBlind = { required: false, line: i + 1, confidence: 'explicit', raw: L.slice(0, 120) }; push('doubleBlind', 'not required', i + 1, L, 'explicit'); }
    /* 模板 */
    const t = L.match(TEMPLATES);
    if (t) for (const x of t) { const k = x.toLowerCase(); if (out.templates.indexOf(k) < 0) { out.templates.push(k); push('template', k, i + 1, L, 'explicit'); } }
    /* 投稿系统 */
    const sys = SYSTEMS.exec(L);
    if (sys && !out.systems.length) { out.systems.push(sys[1].toLowerCase()); push('system', sys[1], i + 1, L, 'explicit'); }
    /* 主题范围：标题行之后的条目 */
    if (/topics?|scope|areas of interest|征稿(?:范围|主题)|主题范围/i.test(L) && out.topics.length === 0) {
      for (let j = i + 1; j < Math.min(lines.length, i + 14); j++) {
        const m = /^(?:[-*•·]|\d+[.)])\s*(.{3,120})$/.exec(lines[j]);
        if (m) { out.topics.push(m[1].trim()); push('topic', m[1].trim(), j + 1, lines[j], 'explicit'); }
        else if (lines[j] && !/^(?:[-*•·]|\d+[.)])/.test(lines[j]) && out.topics.length) break;
      }
    }
    /* 强制声明 */
    for (const m of MANDATORY) if (m.re.test(L) && !out.mandatory.some((x) => x.key === m.key)) { out.mandatory.push({ key: m.key, line: i + 1 }); push('mandatory:' + m.key, 'required', i + 1, L, 'inferred'); }
  }
  /* 场馆：第一行或含 Call for Papers 的行 */
  const cfpLine = lines.findIndex((L) => /call for papers|征稿启事|征稿通知/i.test(L));
  out.venue = { text: (cfpLine >= 0 ? lines[cfpLine] : lines.find((L) => L) || '').replace(/^#+\s*/, '').slice(0, 160), line: cfpLine + 1 || 1, confidence: cfpLine >= 0 ? 'explicit' : 'inferred' };
  /* 没找到什么，要如实说 */
  if (!out.deadlines.length) out.missing.push('各类截止日期（投稿/摘要/通知/终稿）');
  if (!out.pageLimit) out.missing.push('页数上限');
  if (!out.doubleBlind) out.missing.push('双盲要求（明确写了 single/double blind 才算）');
  if (!out.templates.length) out.missing.push('模板/排版（LaTeX 类名或 Word 模板）');
  if (!out.systems.length) out.missing.push('投稿系统');
  if (!out.topics.length) out.missing.push('主题范围');
  const looksLikeCfp = out.deadlines.length || out.pageLimit || out.doubleBlind || out.topics.length || cfpLine >= 0;
  if (!looksLikeCfp) return { status: 'SKIP', why: '未识别到征稿要素（不像 CFP）⇒ 未解析（未识别 ≠ 没有要求）', parsed: out };
  return {
    status: out.missing.length ? 'PARTIAL' : 'OK',
    ...out,
    nextCommands: buildNext(out),
    boundary: '**征稿是自由文本，以上全部为启发式抽取**：每项都给了**行号与原文**供人工复核；**未找到项 ≠ 没有要求**（回执单列 missing）。本工具不判"你符不符合"，只把要素摆出来并给出可跑的下一步。',
  };
}

function buildNext(p) {
  const cmds = [];
  if (p.venue && p.venue.text) cmds.push('node bin/studio.cjs plan-submission --venue "' + p.venue.text.slice(0, 60) + '"');
  if (p.pageLimit) cmds.push('node bin/fit-pages.cjs --draft <稿.md> --limit ' + p.pageLimit.pages);
  if (p.doubleBlind && p.doubleBlind.required) cmds.push('node bin/studio.cjs anonymize --draft <稿.md> --blind double   # 双盲：去作者/致谢/家目录/元数据');
  if (p.pageLimit || p.deadlines.length) cmds.push('node bin/studio.cjs preflight   # 投稿前清单');
  return cmds;
}

function render(r) {
  const L = ['# 征稿启事解析（cfp）· 状态 **' + r.status + '**', ''];
  L.push('场馆：' + (r.venue && r.venue.text ? r.venue.text : '（未识别）') + (r.venue ? '  ← 第 ' + r.venue.line + ' 行 · ' + r.venue.confidence : ''));
  L.push('');
  L.push('| 要素 | 值 | 证据行 | 置信 |');
  L.push('|---|---|---|---|');
  for (const d of r.deadlines) L.push('| 截止：' + d.kind + ' | **' + d.date + '**（原文 ' + d.raw + '） | ' + d.line + ' | ' + d.confidence + ' |');
  if (r.pageLimit) L.push('| 页数上限 | **' + r.pageLimit.pages + ' 页** | ' + r.pageLimit.line + ' | ' + r.pageLimit.confidence + ' |');
  if (r.doubleBlind) L.push('| 双盲 | **' + (r.doubleBlind.required ? '要求' : '不要求') + '** | ' + r.doubleBlind.line + ' | ' + r.doubleBlind.confidence + ' |');
  if (r.templates.length) L.push('| 模板/排版 | ' + r.templates.join('、') + ' | — | explicit |');
  if (r.systems.length) L.push('| 投稿系统 | ' + r.systems.join('、') + ' | — | explicit |');
  if (r.mandatory.length) L.push('| 强制声明 | ' + r.mandatory.map((m) => m.key).join('、') + ' | — | inferred |');
  L.push('');
  if (r.topics.length) { L.push('## 主题范围（' + r.topics.length + ' 项）'); L.push(''); for (const t of r.topics) L.push('- ' + t); L.push(''); }
  if (r.missing.length) { L.push('## ★未找到（**必须自己补；未找到 ≠ 没有要求**）'); L.push(''); for (const m of r.missing) L.push('- ' + m); L.push(''); }
  if (r.nextCommands && r.nextCommands.length) { L.push('## 下一步可直接跑'); L.push(''); for (const c of r.nextCommands) L.push('- `' + c + '`'); L.push(''); }
  L.push('> ' + r.boundary);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const CFP = [
    'Call for Papers: The 12th International Conference on Example Systems (ICES 2026)',
    '',
    'Important Dates',
    'Abstract submission deadline: March 3, 2026',
    'Full paper submission deadline: 2026-03-10',
    'Notification of acceptance: May 1, 2026',
    'Camera-ready deadline: June 15, 2026',
    '',
    'Submissions must be no more than 9 pages, excluding references.',
    'Reviewing is double-blind; authors must anonymize their submissions.',
    'Papers should use the acmart LaTeX template (ACM).',
    'Submit via EasyChair.',
    '',
    'Topics of Interest',
    '- Reliable machine learning',
    '- Human-AI collaboration',
    '- Evaluation methodology',
    '',
    'Authors must include a reproducibility statement and an LLM usage disclosure.',
  ].join('\n');

  ck('正控：一份典型 CFP ⇒ 截止日期/页数/双盲/模板/系统/主题/强制声明全部抽出', () => {
    const r = parse(CFP);
    const kinds = r.deadlines.map((d) => d.kind);
    const bad = [];
    if (!kinds.includes('abstract')) bad.push('缺摘要截止');
    if (!kinds.includes('paper')) bad.push('缺全文截止');
    if (!kinds.includes('camera-ready')) bad.push('缺终稿截止');
    if (!r.pageLimit || r.pageLimit.pages !== 9) bad.push('页数上限错：' + JSON.stringify(r.pageLimit));
    if (!r.doubleBlind || !r.doubleBlind.required) bad.push('双盲未识别');
    if (!r.templates.includes('acmart')) bad.push('模板未识别');
    if (!r.systems.includes('easychair')) bad.push('投稿系统未识别');
    if (r.topics.length !== 3) bad.push('主题数 ' + r.topics.length);
    if (!r.mandatory.some((m) => m.key === 'reproducibility')) bad.push('缺可复现声明');
    return bad.length ? bad.join('；') : true;
  });

  ck('★必失败面：**「补充材料 12 页」不得被当成主页数上限**（必须与 limit/max/不超过 同句）', () => {
    const r = parse('# CFP\nSupplementary material may be up to 12 pages.\n\nThe main paper is limited to 8 pages.\n');
    if (!r.pageLimit) return '未取到页数上限';
    return (r.pageLimit.pages === 8) ? true : '取错了页数：' + JSON.stringify(r.pageLimit);
  });

  ck('★必失败面：**非 CFP 文本 ⇒ SKIP**（未识别 ≠ 没有要求），且要留 parsed', () => {
    const r = parse('We study battery degradation. Our model reaches 0.97 accuracy across 30 cells. The end.');
    return (r.status === 'SKIP' && r.parsed) ? true : JSON.stringify({ s: r.status });
  });

  ck('★必失败面：空文本 ⇒ SKIP', () => {
    return (parse('   ').status === 'SKIP') ? true : '应为 SKIP';
  });

  ck('中文征稿：`2026年3月10日` 与 `不超过 8 页` 都要认出', () => {
    const r = parse('征稿启事：某中文会议 2026\n\n投稿截止：2026年3月10日\n\n论文不超过 8 页（含参考文献）。\n\n本次会议采用双盲审稿。');
    const bad = [];
    if (!r.deadlines.length) bad.push('未识别截止日期');
    if (!r.pageLimit || r.pageLimit.pages !== 8) bad.push('页数未识别：' + JSON.stringify(r.pageLimit));
    if (!r.doubleBlind || !r.doubleBlind.required) bad.push('双盲未识别');
    return bad.length ? bad.join('；') : true;
  });

  ck('未找到项要如实列进 missing（不许把"没写"当"没要求"）', () => {
    const r = parse('Call for Papers: ICES 2026\nSubmission deadline: 2026-03-10\n');
    return (r.status === 'PARTIAL' && r.missing.length >= 3 && r.missing.some((m) => /页数/.test(m))) ? true : JSON.stringify(r.missing);
  });

  ck('日期解析：`March 3, 2026` 与 `3 March 2026` 都要出 ISO', () => {
    const a = grabDate('Abstract submission deadline: March 3, 2026');
    const b = grabDate('Notification: 3 March 2026');
    return (a && a.value === '2026-03-03' && b && b.value === '2026-03-03') ? true : JSON.stringify([a, b]);
  });

  ck('单盲不得被误认成双盲', () => {
    const r = parse('# CFP\nReviewing is single-blind; anonymity is not required.\nSubmission deadline: 2026-03-10\n');
    if (!r.doubleBlind) return '未识别单盲';
    return (r.doubleBlind.required === false) ? true : '把单盲当双盲了：' + JSON.stringify(r.doubleBlind);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\ncfp 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const f = val('--file');
  if (!f) { console.error('前提层失败：需要 --file <征稿.md|txt>'); return 2; }
  const p = path.resolve(f);
  if (!fs.existsSync(p)) { console.error('前提层失败：征稿文件不存在 —— ' + p); return 2; }
  const r = parse(fs.readFileSync(p, 'utf8'));
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  const out = val('--out'); const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('解析结果已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('状态：' + r.status + '（截止 ' + r.deadlines.length + ' 项 · 页数 ' + (r.pageLimit ? r.pageLimit.pages : '未找到') + ' · 双盲 ' + (r.doubleBlind ? (r.doubleBlind.required ? '是' : '否') : '未找到') + ' · 未找到 ' + r.missing.length + ' 项）');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parse, render, grabDate, buildNext, main, selftest };
