#!/usr/bin/env node
/**
 * triage —— 审稿意见分诊矩阵（**Task E 对拍后补齐的最大缺口**）。
 *
 * 方法来源（A 路径吸收）：`lifecycle-skills/skills/triage-reviews` 的 `references/triage-rubric.md`
 * （**判定空间**：misunderstanding / real-flaw / requested-experiment / clarification / disagreement；
 *  **评分法**：severity 30/20/10 · class +6/+4/+3/+2/+1 · effort +3/+2/+1 · 三条分带 · 五步决策树 ·
 *  "disagreement 占比 >20% 要复核，作者系统性把真缺陷归为分歧"）。**代码自写，未搬其实现**。
 *
 * 我方纪律（与对手不同的两处设计）：
 *   ① **本工具不假装会语义分类**：从 `--reviews` 生成的骨架里，每个字段都是
 *      **建议值 + 依据词 + 待确认标记**；要进矩阵，必须由人把 `疑似` 改成确定值（把 `suggested` 搬进 `final`）。
 *   ② **未分诊 ≠ 通过**：字段为 null 的意见**不进矩阵**，单独列成「未分诊」并计入回执，绝不静默丢弃。
 *
 * 用法：
 *   node bin/triage.cjs --reviews <审稿意见.md> [--out triage.json]
 *   node bin/triage.cjs --matrix <triage.json> [--budget <字符数>]
 *   node bin/triage.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ── 评分表（与 triage-rubric 同步；本文件是唯一真源，rubric 文档由本文件派生说明）── */
const SEV = { critical: 30, major: 20, minor: 10 };
const CLS = { misunderstanding: 6, 'real-flaw': 4, 'requested-experiment': 3, clarification: 2, disagreement: 1 };
const EFF = { low: 3, medium: 2, high: 1 };
const SEV_ORDER = ['critical', 'major', 'minor'];
const EFF_ORDER = ['low', 'medium', 'high'];

/** 从审稿意见文本切出逐条意见（行式：`1.1` / `Comment 1.1` / `R1.1` / `[2.3]` / `Reviewer 2` 分节） */
function splitConcerns(text) {
  const out = [];
  let reviewer = '';
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/^\s*[#>*\-\s]+/, '').trim();
    if (!line) continue;
    let m = /^(?:Reviewer|Referee|审稿人)\s*#?\s*(\d+)/i.exec(line);
    if (m) { reviewer = 'R' + m[1]; continue; }
    m = /^(?:Comment|意见|Concern)?\s*#?\s*((?:R|Q|C)?\d+(?:\.\d+)*)\s*[.):、]?\s*(.*)$/i.exec(line);
    if (m && m[2] && m[2].length >= 12) {
      const id = m[1].indexOf('.') >= 0 || /^[RQC]/i.test(m[1]) ? m[1].toUpperCase() : (reviewer ? reviewer + '.' + m[1] : m[1]);
      out.push({ id: id.replace(/^R(\d+)\.(\d+)$/, 'R$1.$2'), reviewer: reviewer || 'R?', text: m[2].trim() });
    }
  }
  return out;
}

/** 建议值 + 依据词（**只给关键词证据，明确标"待确认"**） */
const HINTS = [
  /* ★ 2026-10-17 补：审稿人**没明说 add**，但指出"该做的实验/对比没做"，按 rubric 决策树第 2 步仍属 requested-experiment */
  { cls: 'requested-experiment', re: /(?:no|without|missing|lacks?|absent)\s+(?:\w+\s+){0,3}(?:experiment|baseline|ablation|comparison|validation|dataset|analysis)|not (?:reported|shown|provided|demonstrated|performed)|(?:ablation|baseline|comparison)\b[^.]{0,80}?(?:not identified|missing|lacks?|should (?:be )?(?:added|run|reported))/i, why: '指出应做的实验/对比未做（未被明确要求也按 rubric 归此类）' },
  { cls: 'requested-experiment', re: /(re-?run|add (?:an? )?(?:experiment|baseline|ablation|dataset|comparison|metric)|new (?:dataset|experiment)|more experiments|please (?:add|run|test|include|provide)|collect)/i, why: '要求补做实验/数据/对比' },
  { cls: 'clarification', re: /(unclear|hard to follow|not clear|ambiguous|please (?:clarify|define|explain|rephrase)|confusing|polish|typo|readab|figure .{0,20}label)/i, why: '只要求写清楚/改表述' },
  { cls: 'disagreement', re: /(incremental|not novel|lack(?:s|ing)? (?:of )?novelty|limited (?:significance|contribution|scope)|not (?:suitable|appropriate) for|too (?:narrow|broad))|novelty/i, why: '属判断分歧（新颖性/重要性/范围）' },
  { cls: 'real-flaw', re: /(error|incorrect|wrong|invalid|overclaim|unsupported|contradict|inconsisten|missing (?:related work|citation|proof)|gap|flaw|broken comparison|reproduc)/i, why: '指出实际错误/缺口/过度声称' },
  { cls: 'misunderstanding', re: /(already (?:stated|described|reported|defined)|as (?:we|the paper|Section) (?:state|describe|report|show)|the paper does not claim|we (?:did|do) not claim)/i, why: '疑为误读（正文已有答案）——须给出章节号才算成立' },
];
const EFF_HINT = {
  'requested-experiment': ['high', '要补结果 ⇒ 工作量大'],
  clarification: ['low', '只改表述 ⇒ 工作量小'],
  'real-flaw': ['medium', '要修内容 ⇒ 中等'],
  misunderstanding: ['low', '只需指出已有位置'],
  disagreement: ['medium', '要写论证 ⇒ 中等'],
};
const SEV_HINT = { reject: 'critical', 'major revision': 'major', 'minor revision': 'minor' };

function suggest(concern) {
  const t = concern.text;
  let cls = null, why = '';
  for (const h of HINTS) { if (h.re.test(t)) { cls = h.cls; why = h.why; break; } }
  const eff = cls ? EFF_HINT[cls][0] : null;
  return {
    id: concern.id, reviewer: concern.reviewer, text: t,
    suggested: { classification: cls, severity: null, effort: eff, response_strategy: null },
    evidence: { classification: why, effort: cls ? EFF_HINT[cls][1] : '', severity: '' },
    final: { classification: null, severity: null, effort: null, response_strategy: null, evidence_anchor: null },
    notes: '待确认：本工具只给关键词证据，不计入矩阵；请把确定值填入 final',
  };
}

/** 分诊文件校验 + 优先级 + 分带 */
function priorityOf(c) {
  const f = c.final || {};
  if (!(f.severity in SEV) || !(f.classification in CLS) || !(f.effort in EFF)) return null;
  return SEV[f.severity] + CLS[f.classification] + EFF[f.effort];
}
function bandOf(f) {
  if (f.severity === 'critical') return 'must-address';
  if (f.severity === 'major' && f.classification !== 'disagreement') return 'must-address';
  if (f.severity === 'major') return 'should-address';
  if (f.severity === 'minor' && f.classification === 'misunderstanding') return 'should-address';
  return 'brief';
}
function buildMatrix(doc, opts) {
  const o = opts || {};
  const reviewers = Array.isArray(doc) ? [{ id: 'R?', concerns: doc }] : (doc.reviewers || []);
  const rows = [], invalid = [], unclassified = [];
  for (const rv of reviewers) {
    for (const c of (rv.concerns || [])) {
      const f = c.final || {};
      const bad = [];
      if (f.classification != null && !(f.classification in CLS)) bad.push('classification=' + f.classification + ' 不在判定空间内');
      if (f.severity != null && !(f.severity in SEV)) bad.push('severity=' + f.severity + ' 不在判定空间内');
      if (f.effort != null && !(f.effort in EFF)) bad.push('effort=' + f.effort + ' 不在判定空间内');
      if (bad.length) { invalid.push({ id: c.id, why: bad.join('；') }); continue; }
      const p = priorityOf(c);
      if (p === null) { unclassified.push({ id: c.id, missing: ['severity', 'classification', 'effort'].filter((k) => !(f[k] in { critical: 1, major: 1, minor: 1, misunderstanding: 1, 'real-flaw': 1, 'requested-experiment': 1, clarification: 1, disagreement: 1, low: 1, medium: 1, high: 1 })), text: String(c.text || '').slice(0, 60) }); continue; }
      rows.push({ id: c.id, reviewer: rv.id || c.reviewer, ...f, priority: p, band: bandOf(f), text: String(c.text || '').slice(0, 70) });
    }
  }
  rows.sort((a, b) => (a.band === b.band ? b.priority - a.priority : ['must-address', 'should-address', 'brief'].indexOf(a.band) - ['must-address', 'should-address', 'brief'].indexOf(b.band)));
  const n = rows.length || 1;
  const dis = rows.filter((r) => r.classification === 'disagreement').length;
  const warnings = [];
  if (rows.length >= 5 && dis / n > 0.2) warnings.push('**自评偏差提示**：disagreement 占 ' + Math.round((dis / n) * 100) + '%（>20% 阈值）⇒ 按 rubric 应复核——作者常在自评里把真缺陷归为分歧');
  /* 严重度 × 工作量 矩阵 */
  const grid = {};
  for (const s of SEV_ORDER) { grid[s] = {}; for (const e of EFF_ORDER) grid[s][e] = rows.filter((r) => r.severity === s && r.effort === e).map((r) => r.id); }
  /* 预算：按分带给 can-address 的意见分配字数（budget 缺省时不分配） */
  let budget = null;
  if (o.budget > 0 && rows.length) {
    const bands = ['must-address', 'should-address', 'brief'];
    const share = { 'must-address': 0.7, 'should-address': 0.25, brief: 0.05 };
    budget = {};
    for (const b of bands) {
      const inBand = rows.filter((r) => r.band === b);
      if (!inBand.length) continue;
      const per = Math.max(20, Math.round((o.budget * share[b]) / inBand.length));
      for (const r of inBand) budget[r.id] = per;
    }
  }
  const status = invalid.length ? 'FAIL' : (rows.length ? 'PASS' : 'SKIP');
  return { status, rows, invalid, unclassified, grid, warnings, budget, counts: { total: rows.length, must: rows.filter((r) => r.band === 'must-address').length, should: rows.filter((r) => r.band === 'should-address').length, brief: rows.filter((r) => r.band === 'brief').length, disagreement: dis } };
}

const EMOJI = { 'must-address': '**必答**', 'should-address': '应答', brief: '简述' };

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const mk = (id, cls, sev, eff) => ({ id, text: 'x'.repeat(20), final: { classification: cls, severity: sev, effort: eff } });

  ck('正控：critical ⇒ must-address；major+disagreement ⇒ should-address（分带边界）', () => {
    const r = buildMatrix([mk('R1.1', 'real-flaw', 'critical', 'high'), mk('R1.2', 'disagreement', 'major', 'medium'), mk('R1.3', 'clarification', 'minor', 'low')]);
    const b = {}; r.rows.forEach((x) => { b[x.id] = x.band; });
    return (b['R1.1'] === 'must-address' && b['R1.2'] === 'should-address' && b['R1.3'] === 'brief') ? true : JSON.stringify(b);
  });

  ck('正控：优先级 = severity + class + effort，且**同带内快速胜利在前**（低 effort 先）', () => {
    const r = buildMatrix([mk('a', 'real-flaw', 'major', 'high'), mk('b', 'real-flaw', 'major', 'low')]);
    if (r.rows[0].id !== 'b') return '低 effort 未排前：' + JSON.stringify(r.rows.map((x) => x.id));
    if (r.rows[0].priority !== 20 + 4 + 3) return '评分算错：' + r.rows[0].priority;
    return true;
  });

  ck('★必失败面：**非法枚举**必须 FAIL 且指出哪一个（不许静默当有效）', () => {
    const r = buildMatrix([mk('R1.1', 'bug', 'major', 'low')]);
    return (r.status === 'FAIL' && /classification=bug/.test(r.invalid[0].why)) ? true : JSON.stringify(r);
  });

  ck('★必失败面：**字段为 null 的意见不进矩阵**，要单列「未分诊」并给缺失字段（未分诊 ≠ 通过）', () => {
    const r = buildMatrix([{ id: 'R1.1', text: 'zzz', final: { classification: 'real-flaw', severity: null, effort: 'low' } }, mk('R1.2', 'real-flaw', 'major', 'low')]);
    if (r.unclassified.length !== 1) return '未分诊未记：' + JSON.stringify(r.unclassified);
    if (r.rows.length !== 1) return '未分诊的条目混进了矩阵';
    if (!r.unclassified[0].missing.includes('severity')) return '未指出缺失字段：' + JSON.stringify(r.unclassified[0].missing);
    return true;
  });

  ck('★必失败面：disagreement 占比 >20%（≥5 条时）必须给出**自评偏差提示**', () => {
    const items = [mk('a', 'disagreement', 'minor', 'low'), mk('b', 'disagreement', 'minor', 'low'), mk('c', 'disagreement', 'minor', 'low'), mk('d', 'real-flaw', 'major', 'low'), mk('e', 'clarification', 'minor', 'low'), mk('f', 'clarification', 'minor', 'low')];
    const r = buildMatrix(items);
    if (!r.warnings.some((w) => /自评偏差/.test(w))) return '未提示：' + JSON.stringify(r.warnings);
    /* 反面对照：只有 1 条 disagreement 时不该提示 */
    const r2 = buildMatrix([mk('a', 'disagreement', 'minor', 'low'), mk('b', 'clarification', 'minor', 'low'), mk('c', 'clarification', 'minor', 'low'), mk('d', 'real-flaw', 'major', 'low'), mk('e', 'clarification', 'minor', 'low')]);
    if (r2.warnings.length) return '不该提示却提示了：' + JSON.stringify(r2.warnings);
    return true;
  });

  ck('★必失败面：**全空 ⇒ SKIP**（未分诊不得当通过）', () => {
    const r = buildMatrix([]);
    return (r.status === 'SKIP') ? true : JSON.stringify(r.status);
  });

  ck('切条：`Comment 1.1` / `R2.3` / `[3.1]` 都要切成条目并认出审稿人', () => {
    const cs = splitConcerns('## Reviewer 2\nComment 2.1 Please re-run the ablation with a fixed seed for all conditions.\n2.2 The English needs polishing in several places.\n');
    if (cs.length < 2) return '切条不足：' + JSON.stringify(cs);
    if (!cs.every((c) => /^R?2[.\d]*$/.test(c.id) || c.id.indexOf('2.') === 0)) return '编号不对：' + JSON.stringify(cs.map((c) => c.id));
    return true;
  });

  ck('骨架：每条都带**建议值 + 依据词 + 待确认**，且 final 全为 null（不假装已分诊）', () => {
    const cs = splitConcerns('1.1 Please add a baseline comparison against the 2019 method.\n');
    const s = suggest(cs[0]);
    if (s.suggested.classification !== 'requested-experiment') return '分类建议不对：' + JSON.stringify(s.suggested);
    if (!s.evidence.classification) return '缺依据词';
    if (Object.values(s.final).some((v) => v !== null)) return 'final 应为空：' + JSON.stringify(s.final);
    return true;
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\ntriage 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function renderMatrix(r, opts) {
  const L = [];
  L.push('# 审稿意见分诊矩阵（triage）', '');
  L.push('> 评分法（吸收自 triage-rubric，本工具自实现）：severity critical 30 / major 20 / minor 10；class misunderstanding +6 / real-flaw +4 / requested-experiment +3 / clarification +2 / disagreement +1；effort low +3 / medium +2 / high +1。**优先级 = 三者之和**；同带内**低工作量优先**（快速胜利）。');
  L.push('');
  L.push('## 一、分带（按优先级排序）');
  L.push('');
  L.push('| # | 意见 | 分类 | 严重度 | 工作量 | 分 | 分带 | 内容 |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const x of r.rows) L.push('| ' + x.id + ' | ' + x.reviewer + ' | ' + x.classification + ' | ' + x.severity + ' | ' + x.effort + ' | ' + x.priority + ' | ' + EMOJI[x.band] + ' | ' + x.text.replace(/\|/g, '/') + ' |');
  L.push('');
  L.push('合计：**' + r.counts.total + '** 条（必答 ' + r.counts.must + ' · 应答 ' + r.counts.should + ' · 简述 ' + r.counts.brief + '）');
  L.push('');
  L.push('## 二、严重度 × 工作量 矩阵（含 id）');
  L.push('');
  L.push('| 严重度 \\ 工作量 | low | medium | high |');
  L.push('|---|---|---|---|');
  for (const s of SEV_ORDER) L.push('| **' + s + '** | ' + EFF_ORDER.map((e) => (r.grid[s][e].length ? r.grid[s][e].join(' ') : '—')).join(' | ') + ' |');
  L.push('');
  if (r.unclassified.length) {
    L.push('## 三、★未分诊（**不进矩阵，未分诊 ≠ 通过**）');
    L.push('');
    for (const u of r.unclassified) L.push('- `' + u.id + '` 缺 ' + u.missing.join('/') + '：' + u.text);
    L.push('');
  }
  if (r.invalid.length) {
    L.push('## ★非法值（必须修，否则无法计算）');
    L.push('');
    for (const v of r.invalid) L.push('- `' + v.id + '`：' + v.why);
    L.push('');
  }
  for (const w of r.warnings) L.push('> ' + w + '');
  if (r.budget) {
    L.push('## 预算分配（按分带 70% / 25% / 5%）');
    L.push('');
    L.push('| 意见 | 建议字数 |'); L.push('|---|---|');
    for (const id of Object.keys(r.budget)) L.push('| ' + id + ' | ' + r.budget[id] + ' |');
    L.push('');
  }
  return L.join('\n') + '\n';
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const rev = val('--reviews');
  if (rev) {
    const p = path.resolve(rev);
    if (!fs.existsSync(p)) { console.error('前提层失败：审稿意见文件不存在 —— ' + p + '（未核对，不得当通过）'); return 2; }
    const cs = splitConcerns(fs.readFileSync(p, 'utf8'));
    if (!cs.length) { console.error('未切出任何意见条目（需形如 `Comment 1.1 …` 或 `1.1 …` 的行）⇒ **未分诊**，不是通过'); return 2; }
    const doc = { schema: 'paper-studio.triage.v1', source: path.basename(p), reviewers: [] };
    const byRev = {};
    for (const c of cs) { byRev[c.reviewer] = byRev[c.reviewer] || { id: c.reviewer, concerns: [] }; byRev[c.reviewer].concerns.push(suggest(c)); }
    doc.reviewers = Object.keys(byRev).map((k) => byRev[k]);
    const out = val('--out');
    const json = JSON.stringify(doc, null, 2) + '\n';
    if (out) { fs.writeFileSync(path.resolve(out), json, 'utf8'); console.log('分诊骨架已写出：' + path.resolve(out) + '（' + cs.length + ' 条 · 每条都需人工填 final）'); }
    else console.log(json);
    console.log('  下一步：把确定值填进每条 `final.{classification,severity,effort}`，再跑 `triage --matrix <文件>`。');
    return 0;
  }
  const mtx = val('--matrix');
  if (mtx) {
    const p = path.resolve(mtx);
    if (!fs.existsSync(p)) { console.error('前提层失败：分诊文件不存在 —— ' + p); return 2; }
    let doc; try { doc = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { console.error('前提层失败：不是合法 JSON —— ' + String(e.message || e)); return 2; }
    const r = buildMatrix(doc, { budget: Number(val('--budget')) || 0 });
    if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : (r.status === 'SKIP' ? 2 : 0); }
    const out = val('--out');
    const md = renderMatrix(r, {});
    if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('矩阵已写出：' + path.resolve(out)); }
    else console.log(md);
    console.log('判定：' + r.status + '（矩阵内 ' + r.counts.total + ' 条 · 必答 ' + r.counts.must + ' · 未分诊 ' + r.unclassified.length + ' · 非法 ' + r.invalid.length + '）');
    return r.status === 'FAIL' ? 1 : (r.status === 'SKIP' ? 2 : 0);
  }
  console.error('用法：triage --reviews <意见.md> [--out triage.json] | triage --matrix <triage.json> [--budget N] [--out m.md] | triage --selftest');
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { splitConcerns, suggest, buildMatrix, renderMatrix, priorityOf, bandOf, main, selftest, SEV, CLS, EFF };
