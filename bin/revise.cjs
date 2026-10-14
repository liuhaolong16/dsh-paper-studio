#!/usr/bin/env node
/**
 * revise — 审稿回复（rebuttal）与去 AI 味（V3 · 补齐 P1 缺口）
 *
 * 为什么（见 `references/market-parity.md` §2）：
 *   - **审稿回复是市面全生命周期里的一整段**（awesome-ai-research-writing 明确含「审稿回复」），**我方此前完全缺**；
 *   - **去 AI 味**是两家竞品都有的词表能力（我方 stylecheck 只有填充词/模糊词，没有 AI 味词表）。
 *
 * 设计原则（与全仓一致）：**只做机械可判的，措辞与论证仍归模型**。
 *   - `rebuttal`：把审稿意见**结构化成逐条骨架**（每条 4 段），并机检：**覆盖**（每条都回应了吗）·
 *     **空话禁令**（"we will consider / we agree" 无动作、"due to space limitations" 当借口）·
 *     **不可兑现的承诺**（说要做实验但没给"已做/已补"或"为何不做"）· **对抗性措辞**。
 *   - `aitone`：AI 味词表 + 句式，逐条给行号与替换建议；**只报不改**（density 只作 advisory）。
 *
 * 用法：
 *   node bin/revise.cjs rebuttal --comments <意见.md> [--responses <回应.md>] [--json]
 *   node bin/revise.cjs aitone  --file <稿.md> [--json]
 *   node bin/revise.cjs --selftest
 * 退出码：0 通过（无硬问题）· 1 有硬问题（缺覆盖/空话/对抗） · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── 审稿意见解析 ──
// ★ 纯数字分支必须**带标点**才算编号（否则正文里 "2020 was…" 会被误当编号）；
//   且标记数 ≥1 就走编号路径（首版要求 ≥2 ⇒ **只有一条意见时**会把 "R1." 前缀留在正文里，夹具抓到）。
const MARKER = /^\s*(?:#{1,4}\s*)?(?:\*{0,2})(R\d+|Reviewer\s*\d+|Comment\s*\d+|第\s*\d+\s*条|\d+[.)、])[.)、]?\s*/i;
const read = (f) => fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');

/** 解析成 [{id, text}]：先用编号标记切；标记不足 2 个则退回"空行分段"。 */
function parsePoints(text) {
  const lines = String(text).split(/\r?\n/);
  const hits = [];
  lines.forEach((ln, i) => { const m = ln.match(MARKER); if (m) hits.push({ idx: i, id: m[1].replace(/[.)、]$/, '').trim(), line: i + 1 }); });
  if (hits.length >= 1) {
    const out = [];
    for (let k = 0; k < hits.length; k++) {
      const start = hits[k].idx;
      const end = k + 1 < hits.length ? hits[k + 1].idx : lines.length;
      const body = lines.slice(start, end).join('\n').replace(MARKER, '').trim();
      if (body.length >= 10) out.push({ id: hits[k].id || `#${k + 1}`, line: hits[k].line, text: body });
    }
    return out;
  }
  // 退回：空行分段（每段 ≥20 字符）
  return String(text).split(/\r?\n\s*\r?\n/).map((s) => s.trim()).filter((s) => s.length >= 20)
    .map((s, i) => ({ id: `#${i + 1}`, line: null, text: s }));
}

// ── 空话与坏措辞（机检）──
const EMPTY_PROMISES = [
  { re: /\bwe will (further )?(consider|explore|investigate|look into)\b/i, why: '「我们会考虑/进一步研究」没有动作与时限 ⇒ 评审最反感的一类回应' },
  { re: /\bwe (fully )?agree (with the reviewer|that)\b(?![\s\S]{0,120}\b(we (have |now )?(added|revised|clarified|included)|in the revised))\b/i, why: '「我们同意」但后面没有**具体改动** ⇒ 空认同' },
  { re: /\bdue to (the )?(space|length) (limitations?|constraints?)\b/i, why: '「版面所限」当借口 ⇒ 要么给出实际取舍理由，要么承认这是取舍' },
  { re: /\b(in )?future work\b(?![\s\S]{0,80}\b(specif|concret|we will (add|run)))/i, why: '「留待未来工作」若没有具体内容 ⇒ 视为回避' },
  { re: /\bwe believe (our|the) (method|approach|results?) (is|are) (superior|better|correct)\b/i, why: '「我们相信我们更好」是防御式断言，不构成回应' },
];
const DEFENSIVE = /\b(the reviewer is (wrong|mistaken)|clearly (mis)?understood|we must (point out|emphasize) that the reviewer)\b/i;
const UNFULFILLABLE = /\bwe will (run|conduct|perform)\b[\s\S]{0,60}\b(additional|further|new)\b[\s\S]{0,40}\b(experiments?|evaluation|ablation)\b/i;
const FULFILLED = /\b(we (have |now )?(run|conducted|performed|added)|in the revised manuscript|new (table|figure|section))\b/i;

/** 逐条体检回应：返回 {points:[…], problems:[…]}。 */
function auditRebuttal(comments, responses) {
  const points = parsePoints(comments);
  const resp = responses ? parsePoints(responses) : [];
  const problems = [];
  const out = points.map((p, i) => {
    const r = resp[i] ? resp[i].text : null;
    const issues = [];
    if (!r) issues.push({ rule: 'missing-response', why: '这一条**完全没有回应**（覆盖是硬要求）' });
    else {
      for (const e of EMPTY_PROMISES) if (e.re.test(r)) issues.push({ rule: 'empty-promise', why: e.why, sample: r.slice(0, 120) });
      if (DEFENSIVE.test(r)) issues.push({ rule: 'defensive-tone', why: '对抗性措辞（"审稿人错了"）⇒ 改为"我们理解您的关切是…，我们的做法/证据是…"', sample: r.slice(0, 120) });
      if (UNFULFILLABLE.test(r) && !FULFILLED.test(r)) issues.push({ rule: 'promise-without-delivery', why: '承诺要做实验但没写"已做/已补进稿中"，也没写"为何不做" ⇒ 要么兑现要么说明取舍', sample: r.slice(0, 120) });
    }
    return { id: p.id, comment: p.text.slice(0, 160), response: r ? r.slice(0, 160) : null, issues };
  });
  // ★ 真材实料测出的修正：**所有硬问题都必须汇总进 problems**（上面已声明 problems，这里只 push，别再声明）——
  //   首版只把 missing-response / count-mismatch 放进去 ⇒ 列出了 2 条 ✘ 却报"硬问题 0 / 通过"、
  //   退出码还是 0（自相矛盾）。汇总口径与退出码必须同源。
  for (const x of out) for (const it of x.issues) problems.push({ point: x.id, ...it });
  if (resp.length && resp.length !== points.length) problems.push({ point: '-', rule: 'count-mismatch', why: `意见 ${points.length} 条 vs 回应 ${resp.length} 条 —— 数量不一致时**配对不可信**，请逐条核对编号` });
  return { points: out, problems, n_comments: points.length, n_responses: resp.length };
}

/** 生成逐条 4 段骨架（给人照着填；不替人写）。 */
function rebuttalSkeleton(comments) {
  const points = parsePoints(comments);
  const lines = [
    '# 审稿回复（逐条）',
    '',
    '## 开场（3 句以内，不空谢）',
    '- 感谢 + **一句总览**（这次改了什么、新增了什么证据）。',
    '- 若某条无法满足：**直接说明取舍理由**（比含糊更好）。',
    '',
  ];
  points.forEach((p, i) => {
    lines.push(`## ${p.id} · 审稿意见${i + 1}`, '', `> ${p.text.split(/\r?\n/).join('\n> ')}`, '',
      '**① 我们理解的问题是**：（用一句话复述对方的关切，别辩）',
      '**② 我们的做法/结论是**：（能改的写改动；不能改的写理由）',
      '**③ 新增的证据是**：（新实验/新表/新引用 —— 写清在第几节/第几张表）',
      '**④ 稿中位置**：（`§X.Y` / Table N / Fig. N / 行号）', '');
  });
  lines.push('## 自查（提交前逐条过）',
    '- [ ] 每条意见都有回应（编号一一对应）',
    '- [ ] 没有"我们会考虑/未来工作"式空话 —— 要么给动作，要么给取舍理由',
    '- [ ] 承诺的实验要么已做并写进稿中，要么说明为何不做',
    '- [ ] 没有对抗性措辞；不同意的部分用证据说话',
    '- [ ] 每条都写了**稿中位置**（评审能直接去核对）');
  return lines.join('\n');
}

// ── AI 味词表（机械可判的记号；只报不改）──
const AI_MARKERS = [
  { re: /\bdelve[sd]? (into|in)\b/i, better: 'examine / analyze / study' },
  { re: /\bpivotal\b/i, better: 'important / critical（或直接给理由）' },
  { re: /\bleverag(e|ing|es)\b/i, better: 'use / build on' },
  { re: /\brealm of\b/i, better: 'field / area' },
  { re: /\bunderscore[sd]?\b/i, better: 'show / support / highlight' },
  { re: /\bshowcas(e|es|ing)\b/i, better: 'demonstrate / present' },
  { re: /\ba testament to\b/i, better: 'evidence of / shows' },
  // ★ 重复性审查裁定（2026-10-14 · 完整）—— 以下三项**已由 `stylecheck.cjs` 覆盖**，从本表删除（单一所有者）：
  //   ① `in recent years`（stylecheck: FORBIDDEN_OPENING＝低信息化开头，HARD）
  //   ② `it is worth noting that`（stylecheck: FILLERS）
  //   ③ `众所周知`（stylecheck: FILLERS / FORBIDDEN_OPENING）
  //   分工：**词级/开头归 stylecheck，句式级 AI 腔归本表**。别再把这它们加回来（`audit.cjs` ② 会抓）。
  // （此处曾有一条 `in (the )?(recent|modern)` 记号 —— 2026-10-14 重复性审查后**已删除**，见下方裁定注释）
  { re: /\bnot only\b[^.]{0,80}\bbut also\b/i, better: '拆成两句（该句式常被用来凑对称）' },
  // ★ 去重（2026-10-14 出厂审查的裁定）：`in recent years` / `it is worth noting that` / `众所周知` / `robust`
  //   已由 `stylecheck.cjs` 的词表覆盖（它判"低信息化开头 / 填充词 / 模糊词"，本表判"AI 味营销腔"）
  //   ⇒ 从本表**删除**，避免同一句被两套规则各点一次。分工写死在此：
  //   **stylecheck = 词级与开头；aitone = 句式级 AI 腔**。别再把词级判断加回本表（`audit.cjs` ② 会抓）。
  { re: /\bplays? a (crucial|vital|key|significant) role\b/i, better: '说清它做什么、影响多大' },
  { re: /\b(comprehensive|holistic) (framework|solution|understanding)\b/i, better: '给出覆盖范围与实测数字' },
  { re: /\bstate[- ]of[- ]the[- ]art\b/i, better: '给具体方法与指标（SOTA 属事实断言，须可核）' },
  { re: /\bseamless(ly)?\b/i, better: '删（或写清延迟/开销）' },
  { re: /\bgame[- ]chang(er|ing)\b/i, better: '删（论文里不用营销词）' },
  { re: /\bin conclusion,?\b/i, better: '删（正文里不需要"总之"）' },
  { re: /\bmoreover,|furthermore,|additionally,/i, better: '多数可删；需要转折时用具体连接词' },
  { re: /\b首先\b|\b其次\b|\b最后\b/, better: '中文写作少用序数词分段（改成逻辑连接）' },
  { re: /毫无疑问/, better: '删（要么给引用，要么直接陈述）' },
  { re: /具有重要意义|具有重要价值/, better: '说清"对谁、有多大"影响' },
];
const ZH_WORD = /[\u4e00-\u9fff]/;

/** 扫 AI 味：逐行逐记号，返回命中与密度。 */
function aiTone(text) {
  const lines = String(text).split(/\r?\n/);
  const hits = [];
  lines.forEach((ln, i) => {
    for (const m of AI_MARKERS) {
      const mm = ln.match(m.re);
      if (mm) hits.push({ line: i + 1, marker: mm[0], better: m.better, ctx: ln.trim().slice(0, 110) });
    }
  });
  const words = (String(text).match(/[A-Za-z]+|[\u4e00-\u9fff]/g) || []).length;
  const density = words ? +(1000 * hits.length / words).toFixed(2) : 0;
  return { hits, words, density_per_1000: density, advisory: density > 8 ? '密度偏高（>8/千字）⇒ 建议逐条替换' : '密度正常范围' };
}

// ── 篇幅预算：**复用真源访问器**（`studio.readSections`），本文件不再解析模板结构 ──
function loadSections(genre) {
  // eslint-disable-next-line global-require
  const studio = require('./studio.cjs');
  const { set, sections } = studio.readSections(genre);
  return { set, sections: Array.isArray(sections) ? sections : [] };
}

/**
 * 解析真源里的「篇幅」串 —— 形如 `150–250 词` / `全文 20–25%` / `3–5 条` / `12–20 词 / 20–35 字`。
 * ★ 解析不出来就**明说解析不了**（不猜、不假装有预算）。
 */
function parseBudget(s) {
  const t = String(s || '');
  const pct = t.match(/全文\s*(\d+)\s*[–\-~至]\s*(\d+)\s*%/);
  if (pct) return { kind: 'percent', min: +pct[1], max: +pct[2], raw: t };
  const w = t.match(/(\d+)\s*[–\-~至]\s*(\d+)\s*词/);
  if (w) return { kind: 'words', min: +w[1], max: +w[2], raw: t };
  const c = t.match(/(\d+)\s*[–\-~至]\s*(\d+)\s*字/);
  if (c) return { kind: 'chars', min: +c[1], max: +c[2], raw: t };
  const n = t.match(/(\d+)\s*[–\-~至]\s*(\d+)\s*条/);
  if (n) return { kind: 'items', min: +n[1], max: +n[2], raw: t };
  return { kind: null, raw: t };
}

const countWords = (s) => (String(s).match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
const countZh = (s) => (String(s).match(/[\u4e00-\u9fff]/g) || []).length;

/** 把稿子按 markdown 标题切成节（返回 [{title, level, body, line}]）。 */
function splitSections(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  let cur = null;
  lines.forEach((ln, i) => {
    const m = ln.match(/^(#{1,4})\s+(.*)$/);
    if (m) { if (cur) out.push(cur); cur = { title: m[2].trim(), level: m[1].length, body: [], line: i + 1 }; }
    else if (cur) cur.body.push(ln);
  });
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, body: s.body.join('\n') }));
}

/**
 * 深度词数：**父节包含其后代子节**。
 * ★ 真稿实测踩到：`## 1. Introduction` 后紧跟 `### 1.1 …` ⇒ 父节自身正文为空 ⇒ 报表显示 "0 词"、
 *   预算比对完全失效。正确语义是「从本节标题到下一个**同级或更高级**标题之间的全部文字」。
 */
function wordsDeep(sections, i) {
  const me = sections[i];
  let n = countWords(me.body);
  for (let k = i + 1; k < sections.length; k++) {
    if (sections[k].level <= me.level) break;
    n += countWords(sections[k].body);
  }
  return n;
}
function zhDeep(sections, i) {
  const me = sections[i];
  let n = countZh(me.body);
  for (let k = i + 1; k < sections.length; k++) {
    if (sections[k].level <= me.level) break;
    n += countZh(sections[k].body);
  }
  return n;
}
const normTitle = (s) => String(s || '').toLowerCase().replace(/^[\d.\s、]+/, '').replace(/[^a-z\u4e00-\u9fff]+/g, '');
/** 把稿子里的节与真源节骨架配对（标题包含/被包含，取最长匹配）。 */
function matchSection(draftTitle, skeletonSections) {
  const n = normTitle(draftTitle);
  if (!n) return null;
  let best = null;
  for (const sk of skeletonSections) {
    const cand = [sk.label, sk.id].filter(Boolean).map(normTitle);   // 真源字段名是 label/id（不是 name/title）
    for (const c of cand) {
      if (!c) continue;
      if (n === c || n.includes(c) || c.includes(n)) { if (!best || c.length > best.len) best = { sk, len: c.length }; }
    }
  }
  return best ? best.sk : null;
}

/** 近似重复句：同一份稿里两句 token 高度重合（≥0.8）。 */
function duplicateSentences(text, threshold) {
  const th = threshold || 0.8;
  const sents = String(text).split(/(?<=[.!?。！？])\s+/).map((s) => s.trim()).filter((s) => countWords(s) >= 8);
  const toks = (s) => new Set(s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((x) => x.length > 2));
  const pairs = [];
  const T = sents.map(toks);
  for (let i = 0; i < sents.length; i++) for (let j = i + 1; j < sents.length; j++) {
    const a = T[i]; const b = T[j];
    if (!a.size || !b.size) continue;
    let inter = 0; for (const x of a) if (b.has(x)) inter++;
    const jac = inter / (a.size + b.size - inter);
    if (jac >= th) pairs.push({ a: sents[i].slice(0, 120), b: sents[j].slice(0, 120), similarity: +jac.toFixed(2) });
  }
  return pairs;
}

/** 缩写/扩写：与真源预算比对 + 候选删减（AI 味/填充/重复句）。 */
function budgetReport(file, genre) {
  const text = read(file);
  const totalWords = countWords(text);
  const { set, sections } = loadSections(genre);
  if (!sections.length) throw new Error('真源里没有可用的章节骨架（genre 可能写错）');
  const draft = splitSections(text);
  const rows = [];
  // ★ 只对**配对到骨架的节**做预算比对；若其后代也配对到（少见），跳过后代避免重复计数（父已含子）。
  let matchedAncestorLevel = null;
  for (let i = 0; i < draft.length; i++) {
    const d = draft[i];
    if (matchedAncestorLevel !== null && d.level > matchedAncestorLevel) continue;
    const sk = matchSection(d.title, sections);
    if (!sk) { matchedAncestorLevel = null; continue; }
    matchedAncestorLevel = d.level;
    const w = wordsDeep(draft, i);
    const b = parseBudget(sk.budget_words);
    let verdict = '未配对预算';
    let target = null;
    if (b.kind === 'words') { target = `${b.min}–${b.max} 词`; verdict = w > b.max ? '超预算' : (w < b.min ? '低于预算' : '达标'); }
    else if (b.kind === 'percent') { const pct = totalWords ? 100 * w / totalWords : 0; target = `${b.min}–${b.max}% 全文`; verdict = pct > b.max ? '超预算' : (pct < b.min ? '低于预算' : '达标'); }
    else if (b.kind === 'chars') { const z = zhDeep(draft, i); target = `${b.min}–${b.max} 字`; verdict = z > b.max ? '超预算' : (z < b.min ? '低于预算' : '达标'); }
    rows.push({ section: d.title, words: w, budget_raw: b.raw || null, target, verdict, must_answer: sk.must_answer || null, line: d.line });
  }
  const over = rows.filter((r) => r.verdict === '超预算');
  const under = rows.filter((r) => r.verdict === '低于预算');
  const cuts = [];
  if (over.length) {
    // 候选删减：AI 味行 + 重复句（都只在**超预算**时给出，避免无谓打扰）
    const ai = aiTone(text).hits;
    const dup = duplicateSentences(text);
    for (const h of ai.slice(0, 20)) cuts.push({ line: h.line, why: `AI 味「${h.marker}」→ ${h.better}`, text: h.ctx });
    for (const p of dup.slice(0, 10)) cuts.push({ line: null, why: `与另一句近似重复（相似度 ${p.similarity}）—— 可合并或删一句`, text: p.a + '  ⇄  ' + p.b });
  }
  return { file, genre_set: set, total_words: totalWords, rows, over, under, cuts, note: '超额才给删减候选（AI 味/重复句）；低于预算时给出该节「必答」问题作为**补内容方向**，不代写。' };
}

/**
 * Reviewer 视角整体通读：**机械证据清单 + 通读问题**。
 * ★ 立场：这里**只给证据与问题**，**不代替人判质量** —— 每个问题都标明"机械证据"或"需人读"。
 */
function readthroughReport(file, genre) {
  const text = read(file);
  // 复用 stylecheck 的机械判据（不另写一套）
  // eslint-disable-next-line global-require
  const sc = require('./stylecheck.cjs');
  const r = sc.check(text);
  const draft = splitSections(text);
  const titles = draft.map((d) => normTitle(d.title));
  // ★ 大小写与空格都要容错：`normTitle` 会把 "Related Work" 归一成 "relatedwork"（去空格、转小写）
  //   ⇒ 首版用 /related work/ 无 i 无 \s* ⇒ 明明有 Related Work 节却报缺件（自检抓到）
  const has = (re) => titles.some((t) => re.test(t)) || re.test(text);
  const figures = (text.match(/\b(Fig(ure)?s?\.?\s*\d+|图\s*\d+)/g) || []).length;
  const tables = (text.match(/\b(Tables?\.?\s*\d+|表\s*\d+)/g) || []).length;
  const cites = (text.match(/\[[\d,\-\s]+\]|\\cite\{|\(\w+,\s*\d{4}\)/g) || []).length;
  const { sections } = loadSections(genre);
  const QUESTIONS = [
    ['这篇在解决什么、新在哪？', /What|contribution|we (propose|show|prove|introduce|quantify)|我们(提出|证明|量化)/i.test(text) ? '机械证据：找到第一人称贡献句' : '机械证据：**未找到**贡献句 ⇒ 需人读确认框架是否收敛'],
    ['摘要是否独立可读、含量化结果？', (r.soft.some((x) => x.rule === 'abstract-without-quantitative-result') ? '机械证据：摘要缺显式量化结果' : '机械证据：摘要含数字') + '；可读性与否需人读'],
    ['方法是否被别人可复现？', '需人读（复现性含超参、数据切分、代码可得性；机械层只能查声明是否齐）'],
    ['证据是否支撑每条主张？', '机械证据：引用锚点门 + claim-anchor（另有专门）；**支撑度需人读**'],
    ['与最相关工作比较了吗？', /related\s*work|相关工作/i.test(text) ? '机械证据：有 Related Work 节' : '机械证据：**未见** Related Work 节（若放在引言里，需人读确认是否讲清区别）'],
    ['局限性和失败模式说了吗？', has(/limitation|局限|threats?\s*to\s*validity/i) ? '机械证据：找到局限性表述' : '机械证据：**未见**局限性表述 ⇒ 常见退回项'],
    ['图表是否自足（只看图表能懂）？', `机械证据：图 ${figures} 处 / 表 ${tables} 处引用；**图注自足性需人读**`],
    ['引用可信吗（是否可核）？', `机械证据：引用标记约 ${cites} 处；核验状态见 artifacts 与 claim-anchor 门`],
    ['有没有过度声称？', '机械证据：夸大词/绝对化另有过声称门；**语义需人读**'],
    ['写作是否清楚（句子级）？', `机械证据：stylecheck HARD ${r.hard.length} / SOFT ${r.soft.length}；**可读性需人读**`],
  ];
  const missing = [];
  if (!has(/abstract|摘要/i)) missing.push('缺少 Abstract/摘要 节');
  if (!has(/limitation|局限|threats?\s*to\s*validity/i)) missing.push('未见局限性表述（常见退回项）');
  if (!has(/declaration|声明|competing\s*interest|credit/i)) missing.push('未见声明四件套（竞争利益/CRediT/资助/AI 使用）—— 投稿硬项另有专门');
  if (!has(/related\s*work|相关工作/i)) missing.push('未见「相关工作」节 —— 若本稿把相关工作放在引言里，请确认引言中明确写了"如何区别于已有工作"（不一定是缺件，但必须能回答）');
  return { file, genre_set: sections.length ? 'ok' : '', sections: draft.map((d) => ({ title: d.title, words: countWords(d.body), matched: !!matchSection(d.title, sections) })), inventory: { figures, tables, cites, stylecheck_hard: r.hard.length, stylecheck_soft: r.soft.length }, questions: QUESTIONS.map(([q, ev]) => ({ question: q, evidence: ev })), missing_structural: missing, note: '**这是通读协议，不是质量判决**：机械项给证据，"需人读"的必须人来判（对应 acceptance-gate：机器只能 DRIVE）。' };
}

function runSelftest() {
  const os = require('os');
  const results = [];
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'revise-'));
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };
  const COMMENTS = 'R1. The ablation is missing a negative control.\nR2. Please clarify the dataset split.\nR3. The claim about causality is too strong.';
  const GOOD = 'R1. We agree and have added a negative-control row (Table 4). See §5.2.\nR2. We have clarified the split in §3.1 (now explicit).\nR3. We have softened the wording to association and added a limitation sentence in §7.';

  check('★ 正控 · 意见解析：3 条编号意见被正确切分（带行号）', () => {
    const p = parsePoints(COMMENTS);
    return (p.length === 3 && p[0].id === 'R1' && /negative control/.test(p[0].text)) ? true : JSON.stringify(p);
  });
  check('★ 正控 · 无编号时退回空行分段（不因格式不同就判 0 条）', () => {
    const t = 'The ablation is missing a negative control, please add one.\n\nPlease clarify the dataset split used for training.\n';
    const p = parsePoints(t);
    return p.length === 2 ? true : JSON.stringify(p);
  });
  check('★★ 正控 · 覆盖检查：少一条回应必须报 missing-response（覆盖是硬要求）', () => {
    const a = auditRebuttal(COMMENTS, 'R1. We have added it.\nR2. We have clarified it.');
    return a.problems.some((x) => x.rule === 'missing-response') ? true : JSON.stringify(a.problems);
  });
  check('★ 正控 · 空话禁令：三种空话各报一类', () => {
    const r = 'R1. We will consider this in future work.\nR2. We fully agree with the reviewer.\nR3. Due to space limitations we cannot add it.';
    const a = auditRebuttal(COMMENTS, r);
    const rules = a.points.flatMap((p) => p.issues.map((i) => i.rule));
    return (rules.includes('empty-promise')) ? true : JSON.stringify(rules);
  });
  check('★ 正控 · 对抗性措辞与「承诺未兑现」各自报', () => {
    const r = 'R1. The reviewer is wrong about the ablation.\nR2. We will run additional experiments in the revision.\nR3. We believe our method is superior.';
    const a = auditRebuttal(COMMENTS, r);
    const rules = a.points.flatMap((p) => p.issues.map((i) => i.rule));
    return (rules.includes('defensive-tone') && rules.includes('promise-without-delivery')) ? true : JSON.stringify(rules);
  });
  check('★★ 反控 · 一份**合格**的回应不得报任何硬问题（否则工具会被噪声废掉）', () => {
    const a = auditRebuttal(COMMENTS, GOOD);
    return a.problems.length === 0 ? true : JSON.stringify(a.problems);
  });
  check('★ 反控 · 数量不一致要提示"配对不可信"（比静默错配好）', () => {
    const a = auditRebuttal(COMMENTS, 'R1. We have added it.');
    return (a.problems.some((x) => x.rule === 'missing-response') && a.n_responses === 1) ? true : JSON.stringify(a);
  });
  check('★★ 正控（真材实料测出）· 硬问题必须**汇总进 problems**（否则会出现"列出 ✘ 却说通过、退出码 0"的自相矛盾）', () => {
    const r = 'R1. The reviewer is wrong.\nR2. We will consider it.\nR3. We have clarified it.';
    const a = auditRebuttal(COMMENTS, r);
    return a.problems.length >= 2 ? true : JSON.stringify(a.problems);
  });
  check('★ 反控 · 编号后的标点要被吃掉（正文不得残留孤立的 "."）', () => {
    const p = parsePoints('R1. The ablation is missing a control.');
    return (p.length === 1 && /^The ablation/.test(p[0].text)) ? true : JSON.stringify(p);
  });
  check('★ 正控 · 骨架：每条 4 段 + 自查清单（不替人写正文）', () => {
    const s = rebuttalSkeleton(COMMENTS);
    const ok = (s.match(/① 我们理解的问题是/g) || []).length === 3 && /稿中位置/.test(s) && /没有"我们会考虑/.test(s);
    return ok ? true : s.slice(0, 300);
  });
  check('★ 正控 · AI 味：英文记号与中文记号都能抓，且给替换建议', () => {
    const r = aiTone('We delve into a pivotal realm. Moreover, 毫无疑问 this is important.');
    const markers = r.hits.map((h) => h.marker.toLowerCase());
    return (markers.some((m) => /delve/.test(m)) && markers.some((m) => /毫无疑问/.test(m)) && r.hits.every((h) => h.better)) ? true : JSON.stringify(r.hits);
  });
  check('★ 反控 · 正常学术句子不得被 AI 味误报（"we use X" / "the method improves accuracy by 3%"）', () => {
    const r = aiTone('We use XGBoost. The method improves accuracy by 3% on the test split. Table 2 reports the ablation.');
    return r.hits.length === 0 ? true : JSON.stringify(r.hits);
  });
  check('★ 反控 · 密度只作 advisory，不当硬门（真实稿上不得因密度报警就判失败）', () => {
    const r = aiTone('We delve into it. '.repeat(3));
    return (typeof r.density_per_1000 === 'number' && /密度/.test(r.advisory)) ? true : JSON.stringify(r);
  });

  check('★ 正控 · 预算解析四种形态；**解析不出来就明说解析不了**（不猜）', () => {
    const a = parseBudget('150–250 词 / 250–400 字');
    const b = parseBudget('全文 20–25%');
    const c = parseBudget('3–5 条 · 每条 ≤85 字符');
    const d = parseBudget('看情况');
    return (a.kind === 'words' && a.min === 150 && a.max === 250 && b.kind === 'percent' && c.kind === 'items' && d.kind === null) ? true : JSON.stringify({ a, b, c, d });
  });
  check('★ 正控 · 缩写：超预算的节必须给出**删减候选**（AI 味行 + 近似重复句）', () => {
    const d = mk(); const f = path.join(d, 'over.md');
    const filler = 'Moreover, it is worth noting that we delve into a pivotal realm. '.repeat(30);
    fs.writeFileSync(f, `## Abstract\n\nWe prove X with 2.1% gain.\n\n## Introduction\n\n${filler}\nThe method reduces error by 15% on three datasets and we report all metrics.\nThe method reduces error by 15% on three datasets and we report every metric.\n`, 'utf8');
    const r = budgetReport(f, 'research');
    return (r.over.length >= 1 && r.cuts.length >= 1 && r.cuts.some((c) => /AI 味|近似重复/.test(c.why))) ? true : JSON.stringify({ over: r.over, cuts: r.cuts.slice(0, 2) });
  });
  check('★ 正控 · 扩写：低于预算的节要给出该节「必答」问题作为补内容方向（不代写）', () => {
    const d = mk(); const f = path.join(d, 'under.md');
    fs.writeFileSync(f, '## Abstract\n\nShort.\n\n## Method\n\nWe use X.\n', 'utf8');
    const r = budgetReport(f, 'research');
    return (r.under.length >= 1 && r.under.every((x) => Array.isArray(x.must_answer))) ? true : JSON.stringify(r.under);
  });
  check('★ 正控 · 小节与大节都能配对到真源骨架（按 id 与中文 label 双路匹配）', () => {
    const d = mk(); const f = path.join(d, 'match.md');
    fs.writeFileSync(f, '## Abstract\n\nWe prove X.\n\n## 方法\n\nWe use X.\n', 'utf8');
    const r = budgetReport(f, 'research');
    return r.rows.length === 2 ? true : JSON.stringify(r.rows);
  });
  check('★★ 正控 · 通读：缺 Abstract / 局限性 / 声明 / 相关工作 ⇒ 逐项报缺件', () => {
    const d = mk(); const f = path.join(d, 'thin.md');
    fs.writeFileSync(f, '# Title\n\nWe prove X. See [1] and [2].\n', 'utf8');
    const r = readthroughReport(f, 'research');
    return r.missing_structural.length >= 3 ? true : JSON.stringify(r.missing_structural);
  });
  check('★★ 反控 · 通读：齐全的稿不得误报缺件；且**每个问题都必须标明"机械证据"或"需人读"**（不假装机检能判质量）', () => {
    const d = mk(); const f = path.join(d, 'full.md');
    fs.writeFileSync(f, `# Title\n\n## Abstract\n\nWe prove X with a 2.1% gain.\n\n## Introduction\n\nWe propose Y and quantify Z.\n\n## Related Work\n\nPrior work differs.\n\n## Method\n\nWe use X and report hyperparameters.\n\n## Limitations\n\nOur study is limited to three cells.\n\n## Declarations\n\nCompeting interests: none. CRediT: all authors. AI use: none for analysis.\n`, 'utf8');
    const r = readthroughReport(f, 'research');
    const allMarked = r.questions.every((q) => /机械证据|需人读/.test(q.evidence));
    return (r.missing_structural.length === 0 && allMarked) ? true : JSON.stringify({ missing: r.missing_structural, q: r.questions.map((x) => x.evidence) });
  });
  check('★★ 正控（真稿实测踩到）· 深度聚合：有子节的大节必须**含其后代词数**，不得显示 0 词', () => {
    const d = mk(); const f = path.join(d, 'deep.md');
    fs.writeFileSync(f, '## Introduction\n\n### 1.1 Background\n\n' + 'word '.repeat(120) + '\n\n### 1.2 Gap\n\n' + 'word '.repeat(80) + '\n\n## Method\n\n' + 'word '.repeat(60) + '\n', 'utf8');
    const r = budgetReport(f, 'research');
    const intro = r.rows.find((x) => /Introduction/i.test(x.section));
    return (intro && intro.words >= 200 && r.rows.length === 2) ? true : JSON.stringify(r.rows);
  });
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\nrevise 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const opt = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  const cmd = argv.find((a) => !a.startsWith('--') && !['--comments', '--responses', '--file', '--json'].includes(a));
  try {
    if (cmd === 'rebuttal') {
      const cfile = opt('--comments'); if (!cfile || !fs.existsSync(cfile)) throw new Error('需要 --comments <存在的意见文件>');
      const rfile = opt('--responses');
      if (rfile) {
        if (!fs.existsSync(rfile)) throw new Error(`回应文件不存在：${rfile}`);
        const a = auditRebuttal(read(cfile), read(rfile));
        if (argv.includes('--json')) { console.log(JSON.stringify(a, null, 2)); return a.problems.length ? 1 : 0; }
        console.log(`审稿回复体检：意见 ${a.n_comments} 条 · 回应 ${a.n_responses} 条 · 硬问题 ${a.problems.length}`);
        for (const p of a.points) for (const it of p.issues) console.log(`  ✘ [${p.id}][${it.rule}] ${it.why}` + (it.sample ? `\n      ${it.sample}` : ''));
        console.log(a.problems.length ? '  ⇒ **不通过**：覆盖 / 空话 / 承诺 / 语气 四类里至少一类不合格。' : '  ⇒ 通过（覆盖完整、无空话、无未兑现承诺、无对抗措辞）。注意：**只证明"该回应的都回应了"，不证明论证有说服力**。');
        return a.problems.length ? 1 : 0;
      }
      console.log(rebuttalSkeleton(read(cfile)));
      return 0;
    }
    if (cmd === 'aitone') {
      const f = opt('--file'); if (!f || !fs.existsSync(f)) throw new Error('需要 --file <存在的稿子>');
      const r = aiTone(read(f));
      if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log(`去 AI 味：${f}`);
      console.log(`  命中 ${r.hits.length} 处 · 词数 ${r.words} · 密度 ${r.density_per_1000}/千字 ⇒ ${r.advisory}`);
      for (const h of r.hits.slice(0, 40)) console.log(`  · L${h.line} 「${h.marker}」 → ${h.better}`);
      if (r.hits.length > 40) console.log(`  （还有 ${r.hits.length - 40} 处，未逐条列出）`);
      console.log('  判据：**只报不改**（density 作 advisory，不当硬门）—— 措辞取舍仍归人/模型。');
      return 0;
    }
    if (cmd === 'budget') {
      const f = opt('--file'); if (!f || !fs.existsSync(f)) throw new Error('需要 --file <存在的稿子>');
      const r = budgetReport(f, opt('--genre'));
      if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log(`缩写/扩写：${r.file}（体裁集 ${r.genre_set} · 全文 ${r.total_words} 词）`);
      for (const x of r.rows) console.log(`  ${x.verdict === '达标' ? '✔' : x.verdict === '超预算' ? '✘' : '·'} ${x.section}：${x.words} 词 · 预算 ${x.target || '（未解析：' + (x.budget_raw || '无') + '）'} ⇒ ${x.verdict}`);
      if (r.over.length) { console.log(`  超预算 ${r.over.length} 节 ⇒ 删减候选 ${r.cuts.length} 条：`); for (const c of r.cuts.slice(0, 12)) console.log(`    · ${c.line ? 'L' + c.line + ' ' : ''}${c.why}\n        ${String(c.text).slice(0, 110)}`); }
      if (r.under.length) { console.log(`  低于预算 ${r.under.length} 节 ⇒ 补内容方向（该节「必答」，不代写）：`); for (const u of r.under) { console.log(`    · ${u.section}`); for (const q of (u.must_answer || [])) console.log(`        - ${q}`); } }
      console.log(`  ${r.note}`);
      return 0;
    }
    if (cmd === 'readthrough') {
      const f = opt('--file'); if (!f || !fs.existsSync(f)) throw new Error('需要 --file <存在的稿子>');
      const r = readthroughReport(f, opt('--genre'));
      if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log(`Reviewer 视角整体通读：${r.file}`);
      console.log(`  证据清单：图 ${r.inventory.figures} · 表 ${r.inventory.tables} · 引用标记 ${r.inventory.cites} · stylecheck HARD ${r.inventory.stylecheck_hard}/SOFT ${r.inventory.stylecheck_soft}`);
      console.log(`  节：${r.sections.map((s) => `${s.title}(${s.words}词${s.matched ? '' : '·未配对'})`).join(' · ')}`);
      if (r.missing_structural.length) { console.log(`  ✘ 结构性缺件 ${r.missing_structural.length} 项：`); for (const m of r.missing_structural) console.log(`    - ${m}`); }
      console.log('  通读问题（机械证据 / 需人读）：');
      r.questions.forEach((q, i) => console.log(`    ${i + 1}. ${q.question}\n       → ${q.evidence}`));
      console.log(`  ${r.note}`);
      return 0;
    }
    console.error('用法：revise.cjs rebuttal|aitone|budget|readthrough …（或 --selftest）'); return 2;
  } catch (e) { console.error('前提层失败：' + String((e && e.message) || e)); return 2; }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parsePoints, auditRebuttal, rebuttalSkeleton, aiTone, AI_MARKERS, EMPTY_PROMISES, parseBudget, budgetReport, readthroughReport, splitSections, matchSection, duplicateSentences, main };
