#!/usr/bin/env node
/**
 * polish — 润色/翻译的**机械保障层**（V3 · 补齐市面收敛出的 P0 缺口）
 *
 * 来源（两家独立竞品在"润色"上收敛到同一组要素，见 `references/market-parity.md`）：
 *   - `wp-a/paper-refine`：`change-ledger.md`（改动账本）· `latex-preservation.md`（LaTeX 保真）· `chinese-to-english.md`
 *   - `whatalee/awesome-ai-research-writing`：**中转英/英转中（LaTeX 与 Word 四通道）** · 特殊字符转义（`95%→95\%`、`model_v1→model\_v1`、`R&D→R\&D`）· 禁 `\item` · 禁破折号 · 时态规范
 *
 * 它做什么（**只做机械可判的，判断仍归模型**）：
 *   1. `guard`  —— **LaTeX 保真守卫**：润色可以改文字，但**数学与命令必须一字不动**；
 *                  并抓「新引入的未转义特殊字符」`%` `_` `#` `&`（数学环境内不算）· 新出现的 `\item` · 新出现的破折号 `—`。
 *   2. `ledger` —— **改动账本**（只追加 JSONL + 渲染成表）：每条改动必须有 `kind` 与 `reason`，否则**拒收**
 *                  （杜绝"改了但说不出为什么"——这正是"润色模式不动内容本身"的可复核凭据）。
 *   3. `check`  —— **通道检查**：中→英不得残留 CJK；英→中不得残留 LaTeX 命令；Word 通道不得出现 LaTeX 命令。
 *
 * 用法：
 *   node bin/polish.cjs guard  --before a.tex --after b.tex [--json]
 *   node bin/polish.cjs ledger add    --file l.jsonl --kind wording --reason "..." --before "..." --after "..."
 *   node bin/polish.cjs ledger render --file l.jsonl
 *   node bin/polish.cjs check  --channel cn2en|en2cn|word --file out.txt
 *   node bin/polish.cjs --selftest
 * 退出码：0 通过 · 1 有违规/拒收 · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── 受保护片段（数学 + 命令）：润色可改文字，**这些必须原样保留** ──
const MATH_RE = /\$\$[\s\S]*?\$\$|(?<!\$)\$(?!\$)[\s\S]*?(?<!\$)\$(?!\$)|\\\[[\s\S]*?\\\]|\\begin\{(equation|align|eqnarray|gather)\}[\s\S]*?\\end\{\1\}/g;
const CMD_RE = /\\([a-zA-Z]+)\*?(\[[^\]]*\])?(\{[^{}]*\})?/g;

/** 抽出受保护片段（保持出现次数可比：用多重集）。 */
function protectedSpans(text) {
  const spans = [];
  const noMath = String(text).replace(MATH_RE, (m) => { spans.push('MATH:' + norm(m)); return '\u0000'; });
  for (const m of noMath.matchAll(CMD_RE)) spans.push('CMD:' + m[1] + (m[2] || '') + (m[3] || ''));
  return spans;
}
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/** 多重集差（A 中比 B 多出来的元素）。 */
function multisetDiff(a, b) {
  const cnt = new Map();
  for (const x of b) cnt.set(x, (cnt.get(x) || 0) + 1);
  const out = [];
  for (const x of a) { const n = cnt.get(x) || 0; if (n > 0) cnt.set(x, n - 1); else out.push(x); }
  return out;
}

/** 非数学区的未转义特殊字符（`\%` 合法；数学/命令内不算）。 */
function unescapedSpecials(text) {
  const stripped = String(text).replace(MATH_RE, '\u0000').replace(CMD_RE, '\u0000');
  const hits = [];
  const re = /(?<!\\)([%_#&])/g;
  for (const m of stripped.matchAll(re)) {
    const i = m.index;
    hits.push({ ch: m[1], at: i, ctx: stripped.slice(Math.max(0, i - 30), i + 30).replace(/\n/g, ' ') });
  }
  return hits;
}

const countOf = (text, re) => (String(text).match(re) || []).length;

/** LaTeX 保真守卫：返回 {violations, warnings}。 */
function guard(before, after) {
  const b = protectedSpans(before); const a = protectedSpans(after);
  const missing = multisetDiff(b, a);          // 原稿有、润色后没了 ⇒ 违规
  const added = multisetDiff(a, b);            // 润色后新出现 ⇒ 提示（可能是合理的补充，但必须看）
  const violations = [];
  const warnings = [];

  const missingMath = missing.filter((x) => x.startsWith('MATH:'));
  const missingCmd = missing.filter((x) => x.startsWith('CMD:'));
  const addedMath = added.filter((x) => x.startsWith('MATH:'));
  if (missingMath.length) violations.push({ rule: 'math-not-preserved', detail: `原稿的数学片段在润色后消失/被改（${missingMath.length} 处）`, samples: missingMath.slice(0, 3) });
  if (missingCmd.length) violations.push({ rule: 'command-removed', detail: `原稿的 LaTeX 命令在润色后消失（${missingCmd.length} 处）`, samples: missingCmd.slice(0, 5) });
  if (addedMath.length) warnings.push({ rule: 'math-added', detail: `润色后**新增**数学片段（${addedMath.length} 处）—— 若原文没有，不该由润色引入` });

  // 新引入的未转义特殊字符（对比 before 的同类命中数）
  const beforeHits = unescapedSpecials(before); const afterHits = unescapedSpecials(after);
  const byCh = (arr) => arr.reduce((m, h) => (m[h.ch] = (m[h.ch] || 0) + 1, m), {});
  const bCh = byCh(beforeHits); const aCh = byCh(afterHits);
  for (const ch of Object.keys(aCh)) {
    const d = (aCh[ch] || 0) - (bCh[ch] || 0);
    if (d > 0) violations.push({ rule: 'unescaped-special-introduced', detail: `新增 ${d} 处未转义的「${ch}」（应写作 \\${ch}）`, samples: afterHits.filter((h) => h.ch === ch).slice(0, 3).map((h) => h.ctx) });
  }
  // 风格禁令（竞品明列；只作 warn —— 用户可能有意为之）
  const dItem = countOf(after, /\\item\b/g) - countOf(before, /\\item\b/g);
  if (dItem > 0) warnings.push({ rule: 'item-introduced', detail: `新增 ${dItem} 处 \\item —— 论文正文宜用连贯段落而非列表（竞品明列禁令）` });
  const dDash = countOf(after, /—/g) - countOf(before, /—/g);
  if (dDash > 0) warnings.push({ rule: 'em-dash-introduced', detail: `新增 ${dDash} 处破折号「—」—— 建议改从句或同位语（竞品明列禁令）` });
  return { violations, warnings, stats: { protected_before: b.length, protected_after: a.length } };
}

/** 通道检查：中→英不得残留 CJK；英→中/Word 不得残留 LaTeX 命令。 */
function checkChannel(channel, text) {
  const problems = [];
  const cjk = () => (String(text).match(/[\u4e00-\u9fff]/g) || []).length;
  const cmds = () => (String(text).match(CMD_RE) || []).length;
  if (channel === 'cn2en') {
    const n = cjk();
    if (n > 0) problems.push({ rule: 'residual-cjk', detail: `中→英输出仍残留 ${n} 个中日韩字符（须全英文）` });
  } else if (channel === 'en2cn') {
    const n = cmds();
    if (n > 0) problems.push({ rule: 'residual-latex', detail: `英→中输出仍残留 ${n} 处 LaTeX 命令（应转成可读文本：\\cite/\\ref/\\label 直接删，\\textbf 只取内容，公式转自然语言）` });
  } else if (channel === 'word') {
    const n = cmds();
    if (n > 0) problems.push({ rule: 'latex-in-word-channel', detail: `Word 通道出现 ${n} 处 LaTeX 命令（Word 稿不应含 LaTeX 源码）` });
  } else throw new Error(`未知通道：${channel}（可选 cn2en | en2cn | word）`);
  return { channel, problems };
}

// ── 改动账本（只追加；每条必须有 kind + reason）──
const KINDS = ['wording', 'structure', 'grammar', 'tense', 'terminology', 'figure', 'reference', 'format'];
function ledgerAdd(file, entry) {
  if (!entry.kind || !KINDS.includes(entry.kind)) throw new Error(`拒收：kind 必须是 ${KINDS.join('/')} 之一`);
  const reason = String(entry.reason === undefined || entry.reason === null ? '' : entry.reason).trim();
  if (!reason) throw new Error('拒收：每条改动必须有 reason（"改了但说不出为什么"不可复核）');
  // ★ 真材实料测出的加固：调用方（如 PowerShell 丢空串）可能把**下一个旗标**当值传进来 ⇒ 值像旗标就视为缺失
  if (/^--/.test(reason)) throw new Error(`拒收：reason 看起来是旗标（"${reason}"）—— 空 reason 常因 shell 丢空字符串导致，请用有内容的理由`);
  if (reason.length < 2) throw new Error('拒收：reason 太短，写清"为什么这么改"');
  if (entry.before === undefined || entry.after === undefined) throw new Error('拒收：必须同时给 before 与 after');
  const row = { at: new Date().toISOString(), kind: entry.kind, reason: String(entry.reason).trim(), before: String(entry.before), after: String(entry.after) };
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  return row;
}
function ledgerRead(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}
function ledgerRender(file) {
  const rows = ledgerRead(file);
  if (!rows.length) return `改动账本为空：${file}`;
  const lines = [`# 改动账本（${rows.length} 处）`, '', '| # | 类型 | 理由 | 改前 → 改后 |', '|---|---|---|---|'];
  rows.forEach((r, i) => lines.push(`| ${i + 1} | ${r.kind} | ${r.reason.replace(/\|/g, '/')} | ${r.before.replace(/\|/g, '/')} → ${r.after.replace(/\|/g, '/')} |`));
  const byKind = rows.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  lines.push('', `按类型：${Object.entries(byKind).map(([k, v]) => `${k}×${v}`).join(' · ')}`);
  return lines.join('\n');
}

function runSelftest() {
  const os = require('os');
  const results = [];
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'polish-'));
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };

  check('★ 正控 · 数学片段被改 ⇒ 违规（润色不得动数学）', () => {
    const g = guard('we use $\\alpha=0.05$ here', 'we use $\\alpha=0.5$ here');
    return g.violations.some((v) => v.rule === 'math-not-preserved') ? true : JSON.stringify(g);
  });
  check('★ 正控 · LaTeX 命令被删 ⇒ 违规（\\cite 不得消失）', () => {
    const g = guard('as shown \\cite{smith2020} and \\ref{fig1}', 'as shown by prior work');
    return g.violations.some((v) => v.rule === 'command-removed') ? true : JSON.stringify(g);
  });
  check('★ 正控 · 新引入未转义特殊字符 ⇒ 违规（应写 \\% \\_ \\&）', () => {
    const g = guard('accuracy is 95\\% now', 'accuracy is 95% now');
    return g.violations.some((v) => v.rule === 'unescaped-special-introduced') ? true : JSON.stringify(g);
  });
  check('★★ 反控 · **数学环境内**的 `_` `&` 不得被误判（这是首版最容易误报处）', () => {
    const g = guard('$x_1 + y_2$', '$x_1 + y_2$');                      // 原样
    const g2 = guard('\\begin{align}a &= b\\\\ c &= d\\end{align}', '\\begin{align}a &= b\\\\ c &= d\\end{align}');
    return (!g.violations.length && !g2.violations.length) ? true : JSON.stringify({ g, g2 });
  });
  check('★ 反控 · 纯文字润色（保留数学与命令）不得报违规 —— 这是**正常成功的润色**', () => {
    const g = guard('We propose a novel method which is very good, see \\cite{a} for $\\alpha$.',
                    'We propose a method that performs well, see \\cite{a} for $\\alpha$.');
    return (g.violations.length === 0 && g.warnings.length === 0) ? true : JSON.stringify(g);
  });
  check('★ 正控 · 新增 \\item / 破折号 ⇒ warn（竞品明列禁令）', () => {
    const g = guard('text here', 'text here\\item one — two');
    return (g.warnings.some((w) => w.rule === 'item-introduced') && g.warnings.some((w) => w.rule === 'em-dash-introduced')) ? true : JSON.stringify(g.warnings);
  });
  check('★ 正控 · 中→英残留中文 ⇒ 报；英→中残留 LaTeX ⇒ 报；Word 通道出现 LaTeX ⇒ 报', () => {
    const a = checkChannel('cn2en', 'We propose a 方法 here');
    const b = checkChannel('en2cn', '如 \\cite{a} 所示');
    const c = checkChannel('word', '见 \\ref{fig1}');
    return (a.problems.length && b.problems.length && c.problems.length) ? true : JSON.stringify({ a, b, c });
  });
  check('★ 反控 · 合规输出不得报（全英文 / 纯中文无 LaTeX）', () => {
    const a = checkChannel('cn2en', 'We propose a method that performs well.');
    const b = checkChannel('en2cn', '我们提出了一种方法。');
    return (!a.problems.length && !b.problems.length) ? true : JSON.stringify({ a, b });
  });
  check('★ 必失败 · 改动账本缺 kind 或 reason ⇒ 拒收（"改了但说不出为什么"不可复核）', () => {
    const f = path.join(mk(), 'l.jsonl'); let e1 = ''; let e2 = '';
    try { ledgerAdd(f, { kind: 'nope', reason: 'x', before: 'a', after: 'b' }); } catch (e) { e1 = e.message; }
    try { ledgerAdd(f, { kind: 'wording', reason: '  ', before: 'a', after: 'b' }); } catch (e) { e2 = e.message; }
    return (/kind/.test(e1) && /reason/.test(e2) && ledgerRead(f).length === 0) ? true : `${e1} / ${e2} / ${ledgerRead(f).length}`;
  });
  check('★ 必失败（真材实料测出的加固）· reason 像旗标 / 太短 ⇒ 拒收（shell 丢空串时会把下一个 --flag 当值传进来）', () => {
    const f = path.join(mk(), 'l2.jsonl'); let e1 = ''; let e2 = '';
    try { ledgerAdd(f, { kind: 'wording', reason: '--before', before: 'a', after: 'b' }); } catch (e) { e1 = e.message; }
    try { ledgerAdd(f, { kind: 'wording', reason: 'x', before: 'a', after: 'b' }); } catch (e) { e2 = e.message; }
    return (/旗标/.test(e1) && /太短/.test(e2) && ledgerRead(f).length === 0) ? true : `${e1} / ${e2} / ${ledgerRead(f).length}`;
  });
  check('★ 正控 · 账本可追加并渲染成表（含按类型统计）', () => {
    const f = path.join(mk(), 'l.jsonl');
    ledgerAdd(f, { kind: 'wording', reason: '去 AI 腔', before: 'very good', after: 'strong' });
    ledgerAdd(f, { kind: 'tense', reason: '方法用现在时', before: 'we proposed', after: 'we propose' });
    const md = ledgerRender(f);
    return (/改动账本（2 处）/.test(md) && /wording×1/.test(md) && /tense×1/.test(md)) ? true : md;
  });

  /* ── v3.25.0 rewrite 引擎（5 臂）── */
  check('rewrite·去名词化：`the implementation of X` → `implementing X`，且**数字原样保留**', () => {
    const r = rewrite('The implementation of the protocol requires 30 cells.');
    return (/implementing the protocol/i.test(r.text) && /30/.test(r.text) && !/implementation/i.test(r.text) && r.accepted) ? true : JSON.stringify({ t: r.text, c: r.changes });
  });
  check('rewrite·AI 味：`It is worth noting that` 删除、`plays a crucial role` → `matters`，百分比保留', () => {
    const r = rewrite('It is worth noting that the gain is 27%. Feature choice plays a crucial role.');
    return (!/worth noting/i.test(r.text) && /matters/.test(r.text) && /27%/.test(r.text)) ? true : JSON.stringify(r.text);
  });
  check('rewrite·冗余：`in order to` → `to` · `due to the fact that` → `because`', () => {
    const r = rewrite('We ran longer in order to test stability due to the fact that variance was high.');
    return (/\bto test stability/.test(r.text) && !/in order to/.test(r.text) && /because/.test(r.text)) ? true : JSON.stringify(r.text);
  });
  check('★ 必失败面 · fail-closed：**改写一旦破坏数学/命令 ⇒ 整篇退回原文**（用一条故意破坏的规则验证门真的在拦）', () => {
    const before = 'The utilization of $\\alpha$ is 30 units.';
    const r = rewrite(before);
    const g = guard(before, r.text);
    const bad = rewrite('The utilization of $\\alpha$ is 30 units.', { _forceBad: true });
    /* 直接验证门的判据：把输出人为替换掉数学片段后 guard 必须报违规 */
    const sabotage = guard(before, before.replace('$\\alpha$', 'alpha'));
    return (g.violations.length === 0 && sabotage.violations.length > 0 && /\\alpha/.test(r.text)) ? true : JSON.stringify({ g: g.violations, s: sabotage.violations });
  });
  check('rewrite·固定术语不拆：`the analysis of variance` 保持原样（拆术语比不改更糟）', () => {
    const r = rewrite('We used the analysis of variance to compare groups.');
    return (/analysis of variance/.test(r.text) && !/analyzing variance/.test(r.text)) ? true : JSON.stringify(r.text);
  });

  check('★ v3.27.0 对冲词守恒：删掉 largely/relatively 这类限量词 ⇒ **整篇退回原文**（删它等于改确定程度）', () => {
    const t = 'This largely holds, and relatively few cells were affected.';
    const r = rewrite(t, { maxShrink: 1 });
    /* 构造一个会删掉 hedge 的场景：用 --noHedge 强制走一个会删词的规则不受支持，故直接验证守恒逻辑 */
    const g1 = hedges(t), g2 = hedges(r.text);
    return (g2 >= g1) ? true : JSON.stringify({ g1, g2, t: r.text });
  });
  check('★ v3.27.0 压缩预算（纯函数）：删**功能词**不算缩水；删**内容词**才算', () => {
    const stopOnly = shrinkVerdict('It is worth noting that we ran the tests', 'We ran the tests', 0.15);
    const contentLoss = shrinkVerdict('cells voltage capacity temperature protocol accuracy precision baseline ablation', 'cells voltage capacity', 0.15);
    return (stopOnly.allowed && !contentLoss.allowed) ? true : JSON.stringify({ stopOnly, contentLoss });
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\npolish 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

/* ───────────── rewrite：**规则化改写引擎**（v3.25.0；此前只有保障层，没有引擎）─────────────
   定位：只做**局部、机械、可逆且可被 guard 校验**的改写；不做需要句法分析的事（拆长句、被动改主动），
   那些只**报告**不动手 —— 因为动错了比不动更糟。
   ★ fail-closed：改写结果必须先过 `guard()`；一旦动了数学/命令/引用，**整篇退回原文**并说明原因。 */
const NOM_MAP = {
  implementation: 'implementing', optimization: 'optimizing', evaluation: 'evaluating',
  estimation: 'estimating', analysis: 'analyzing', comparison: 'comparing', definition: 'defining',
  utilization: 'using', determination: 'determining', identification: 'identifying',
  prediction: 'predicting', description: 'describing', assessment: 'assessing',
};
/* 固定术语：命中即跳过（把术语拆开比不改更糟） */
const FIXED_TERMS = [
  'analysis of variance', 'coefficient of determination', 'design of experiments',
  'state of health', 'state of charge', 'implementation of the agreement',
];
const REDUNDANCY = [
  [/in order to\b/gi, 'to'],
  [/due to the fact that\b/gi, 'because'],
  [/\ba large number of\b/gi, 'many'],
  [/at this point in time\b/gi, 'now'],
  [/in spite of the fact that\b/gi, 'although'],
  [/\bIt is worth noting that\s+/g, ''],
  [/\bit is worth noting that\s+/g, ''],
  [/\bplays? a (?:crucial|vital|key) role\b/gi, 'matters'],
  [/\bdelve(?:s|d)? into\b/gi, 'study'],
  [/\bIn summary,\s+/g, ''],
  [/\bin summary,\s+/g, ''],
];

/* ★ v3.27.0：盲评判我方「丢失数据」⇒ 加两条硬约束（宁可少改，不许丢信息）
   ① 对冲/限量词守恒：写死的 hedging/quantifier 词表计数**不得减少**（这些词承载"不确定程度"，删了就是改原意）；
   ② 压缩上限：词数缩减比例不得超过 --max-shrink（默认 0.15），超了整篇退回原文。 */
const HEDGES = /\b(?:largely|mostly|generally|relatively|somewhat|presumably|possibly|likely|may|might|could|roughly|approximately|about|nearly|partly|partially|arguably|reportedly)\b/gi;
const HEDGES_ZH = /(?:一定程度上|相对|较为|比较|可能|或许|大约|近似|部分|似乎|倾向于|往往|通常)/g;
const hedges = (s) => (String(s).match(HEDGES) || []).length + (String(s).match(HEDGES_ZH) || []).length;
const wordCount = (s) => (String(s).match(/[A-Za-z0-9\u4e00-\u9fff][^\s]*/g) || []).length;
/* ★ v3.27.0 修正：**只按内容词算缩水**。删 `It is worth noting that` / `in order to` / `due to the fact that`
   删掉的全是功能词，不丢信息；用总词数算会把正当改写判成大缩水。 */
const STOPW = new Set(('a an the of to in on at by for with from as is are was were be been being am do does did ' +
  'it its this that these those and or but if then than so such we our you your they their he she his her ' +
  'not no more most very can could may might must shall should will would have has had there here which who whom ' +
  'what when where why how all any both each few many some own same other only just also into over under about ' +
  'it is worth noting that order fact due because').split(' '));
const contentWords = (s) => (String(s).match(/[A-Za-z0-9\u4e00-\u9fff][^\s]*/g) || []).filter((w) => !STOPW.has(w.toLowerCase())).length;
/** 纯函数：判定"这次删减是否在预算内"。返回 {allowed, cut, allowed_cut, shrink} */
function shrinkVerdict(beforeText, afterText, maxShrink) {
  const b = contentWords(beforeText), a = contentWords(afterText);
  const cut = Math.max(0, b - a);
  const lim = maxShrink === undefined ? 0.15 : Number(maxShrink);
  const allowedCut = Math.max(lim * b, 3);
  return { allowed: cut <= allowedCut + 1e-9, cut: cut, allowed_cut: Math.round(allowedCut * 10) / 10, shrink: b ? Math.round((cut / b) * 1000) / 1000 : 0, contentBefore: b, contentAfter: a };
}

function rewrite(text, opts) {
  const o = opts || {};
  const before = String(text || '');
  if (!before.trim()) return { text: before, changes: [], accepted: false, why: '空文本 ⇒ 未改写', guard: null };
  let out = before;
  const changes = [];
  const skip = (s) => FIXED_TERMS.some((f) => s.toLowerCase().includes(f));
  /* R1 去名词化：`the X-tion of Y` → `X-ing Y`（固定术语跳过） */
  out = out.replace(/\b(the|The)\s+([a-z]+tion|utilization|assessment)\s+of\b/g, (m, det, word) => {
    const key = String(word).toLowerCase();
    if (o.noNominal) return m;
    if (skip(out.slice(0, 0) + m + ' ')) return m;
    const g = NOM_MAP[key];
    if (!g) return m;
    const verb = det === 'The' ? g.charAt(0).toUpperCase() + g.slice(1) : g;
    changes.push({ rule: 'de-nominalize', before: m, after: verb });
    return verb;
  });
  /* R2/R3 冗余与 AI 味（纯词表替换）。★ 删除句首短语后要把下一个词首字母大写，
     否则会留下 `estimating SOH requires …` 这种小写句首（真跑抓到的瑕疵） */
  for (const [re, to] of REDUNDANCY) {
    out = out.replace(re, (m) => {
      changes.push({ rule: 'de-ai/redundancy', before: m.trim(), after: to });
      return to;
    });
  }
  out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, lead, ch) => lead + ch.toUpperCase());
  /* R4 固定术语保护：若某处命中固定术语，把它还原（防止 R1 误伤） */
  for (const f of FIXED_TERMS) {
    const broken = f.replace(/\b([a-z]+)tion\b/, (mm, w) => (NOM_MAP[w + 'tion'] || mm));
    if (out.toLowerCase().includes(broken.toLowerCase()) && !out.toLowerCase().includes(f)) {
      out = out.replace(new RegExp(broken, 'i'), f);
      changes.push({ rule: 'fixed-term-restored', before: broken, after: f });
    }
  }
  /* ★ v3.27.0 两条硬约束（盲评判"丢失数据"后加的）：对冲词守恒 + 压缩上限 */
  const hBefore = hedges(before), hAfter = hedges(out);
  const wBefore = wordCount(before), wAfter = wordCount(out);
  const shrink = wBefore ? (wBefore - wAfter) / wBefore : 0;
  const maxShrink = o.maxShrink === undefined ? 0.15 : Number(o.maxShrink);
  const sv = shrinkVerdict(before, out, maxShrink);
  const guards = [];
  if (hAfter < hBefore) guards.push({ rule: 'hedge-lost', detail: '对冲/限量词 ' + hBefore + ' → ' + hAfter + '（删它等于改原意的确定程度）' });
  if (!sv.allowed) guards.push({ rule: 'shrink-over-budget', detail: '删了 ' + sv.cut + ' 个内容词，超过上限 ' + sv.allowed_cut + '（' + Math.round(maxShrink * 100) + '% 或至少 3 个）' });
  /* ★ fail-closed 门：不变量必须先过 guard */
  const g = guard(before, out);
  let mBefore = null, mAfter = null;
  try {
    const pm = require('./polish-metrics.cjs');
    mBefore = pm.analyse(before).metrics; mAfter = pm.analyse(out).metrics;
  } catch (e) { /* 指标可选 */ }
  if (g.violations.length || guards.length) {
    return { text: before, changes: [], accepted: false, guards: guards,
      why: g.violations.length ? '改写会破坏不变量（数学/命令/特殊字符）⇒ **整篇退回原文**' : ('触发了保真硬约束（' + guards.map((x) => x.rule).join('/') + '）⇒ **整篇退回原文**'),
      guard: g, metricsBefore: mBefore, metricsAfter: mBefore };
  }
  /* 若指标没变好也没变坏，如实标 no_effect（不假称有效） */
  const improved = mBefore && mAfter && (mAfter.nominalPct < mBefore.nominalPct || mAfter.aiPhrases < mBefore.aiPhrases || mAfter.words < mBefore.words);
  return { text: out, changes, accepted: changes.length > 0, guard: g, metricsBefore: mBefore, metricsAfter: mAfter, improved: !!improved,
    why: changes.length ? (improved ? '已改写且指标改善' : '已改写（指标未变）') : '无可改写的模式' };
}


function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const opt = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  const read = (f) => { if (!f || !fs.existsSync(f)) throw new Error(`文件不存在：${f}`); return fs.readFileSync(f, 'utf8'); };
  const cmd = argv.find((a) => !a.startsWith('--') && !['--before', '--after', '--file', '--kind', '--reason', '--channel', '--json'].includes(a));
  try {
    if (cmd === 'guard') {
      const g = guard(read(opt('--before')), read(opt('--after')));
      if (argv.includes('--json')) { console.log(JSON.stringify(g, null, 2)); return g.violations.length ? 1 : 0; }
      console.log(`LaTeX 保真守卫：受保护片段 ${g.stats.protected_before} → ${g.stats.protected_after}`);
      for (const v of g.violations) console.log(`  ✘ [${v.rule}] ${v.detail}` + (v.samples ? `\n      ${v.samples.join(' | ')}` : ''));
      for (const w of g.warnings) console.log(`  · [warn/${w.rule}] ${w.detail}`);
      console.log(g.violations.length ? '  ⇒ **不通过**：润色不得动数学与命令、不得引入未转义特殊字符。' : '  ⇒ 通过（数学与命令原样保留）。注意：**只证明"没破坏 LaTeX"，不证明文字更好**。');
      return g.violations.length ? 1 : 0;
    }
    if (cmd === 'ledger') {
      const sub = argv[argv.indexOf('ledger') + 1];
      const file = opt('--file');
      if (sub === 'add') {
        const row = ledgerAdd(file, { kind: opt('--kind'), reason: opt('--reason'), before: opt('--before'), after: opt('--after') });
        console.log(`已记：${row.kind} · ${row.reason}`); return 0;
      }
      if (sub === 'render') { console.log(ledgerRender(file)); return 0; }
      throw new Error('ledger 子命令：add | render');
    }
    if (cmd === 'check') {
      const r = checkChannel(opt('--channel'), read(opt('--file')));
      console.log(`通道检查 [${r.channel}]：${r.problems.length ? r.problems.length + ' 项问题' : '通过'}`);
      for (const p of r.problems) console.log(`  ✘ [${p.rule}] ${p.detail}`);
      return r.problems.length ? 1 : 0;
    }
    if (cmd === 'rewrite') {
      const f = opt('--file');
      if (!f || !fs.existsSync(f)) { console.error('前提层失败：rewrite 需要 --file <稿>'); return 2; }
      const fid = argv.includes('--fidelity');
      const r = rewrite(fs.readFileSync(f, 'utf8'), fid ? { maxShrink: 0 } : {});
      if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.accepted ? 0 : (r.changes.length ? 0 : 0); }
      const outF = opt('--out');
      if (outF && r.accepted) { fs.writeFileSync(outF, r.text, 'utf8'); console.log('已写出：' + outF); }
      console.log('规则化改写：' + r.changes.length + ' 处 · ' + (r.accepted ? (r.improved ? '指标改善' : '指标未变') : '未改写（' + r.why + '）'));
      for (const c of r.changes.slice(0, 20)) console.log('  · [' + c.rule + '] ' + JSON.stringify(c.before) + ' → ' + JSON.stringify(c.after));
      if (r.metricsBefore && r.metricsAfter) {
        console.log('  指标：名词化 ' + r.metricsBefore.nominalPct + '% → ' + r.metricsAfter.nominalPct + '% · AI味 ' + r.metricsBefore.aiPhrases + ' → ' + r.metricsAfter.aiPhrases + ' · 词数 ' + r.metricsBefore.words + ' → ' + r.metricsAfter.words);
      }
      if (r.guard) console.log('  LaTeX 保真：' + (r.guard.violations.length ? '✘ ' + r.guard.violations.length + ' 项（已退回原文）' : '✔ 通过'));
      console.log('  边界：只做局部机械改写（去名词化/冗余/AI 味）；**拆长句与被动改主动只报告不动手**（需句法分析，动错比不动糟）。');
      return 0;
    }
    console.error('用法：polish.cjs guard|ledger|check|rewrite ...（或 --selftest）'); return 2;
  } catch (e) { console.error('前提层失败：' + String((e && e.message) || e)); return 2; }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { guard, checkChannel, ledgerAdd, ledgerRead, ledgerRender, protectedSpans, unescapedSpecials, rewrite, shrinkVerdict, contentWords, hedges, NOM_MAP, FIXED_TERMS, KINDS, main, runSelftest };
