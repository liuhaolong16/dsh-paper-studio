#!/usr/bin/env node
/**
 * tense-check —— **时态规范机检**（用户文档 `market-parity.md` 缺口表里明写"仍缺"的一项）。
 *
 * 判据（可辩护的窄口径，只查"方法/结果"里**做过的动作**）：
 *   · 方法/结果节里用**现在时**描述**做过的动作**（train/test/evaluate/measure/collect/annotate…）⇒ WARN
 *     —— 惯例是过去时（"we trained …"），现在时读作"每次都这样"或"还没做"。
 *   · **不**把约定俗成的现在时当错：`In this paper we propose/present/describe/introduce …`、
 *     `The results show/indicate …`（结果的一般化陈述）属正常写法 ⇒ **不报**。
 *   · 结论/讨论节里用**过去时**下**一般性断言**（"the method worked" 而非 "the method works"）⇒ INFO 提醒。
 *
 * 诚实边界：本工具只做**动词形态关键词匹配**，不做句法分析 ⇒
 *   · 没有任何方法/结果节 ⇒ **SKIP（未检查，不得当通过）**；
 *   · 报告一律打印**命中原句 + 行号**（人可以复核），并把"本工具不判语义"写在回执里。
 *
 * 用法：
 *   node bin/tense-check.cjs --draft <稿.md> [--json]
 *   node bin/tense-check.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 只查"做过的动作"类动词（procedural）。**刻意不含** propose/present/describe/introduce/show/indicate —— 它们做现在时是惯例。 */
/* 过程动词（做过的动作）。★ v3.11.1：补 PRISMA/综述真实用词 —— 论文 B 的 `## 2. Methods` 用 search/screen/extract/code，
   原先表里没有 ⇒ 该节零命中（覆盖缺口，非论文问题）。 */
const PROC = ['train', 'test', 'evaluate', 'measure', 'collect', 'annotate', 'sample', 'split', 'run', 'perform', 'conduct', 'apply', 'compare', 'analyze', 'analyse', 'compute', 'calibrate', 'validate',
  'search', 'screen', 'extract', 'code', 'assess', 'appraise', 'register', 'identify', 'include', 'exclude', 'find', 'select', 'review', 'chart', 'tabulate'];
const PAST_FORM = (v) => {
  if (/e$/.test(v)) return v + 'd';
  if (/[^aeiou]y$/.test(v)) return v.slice(0, -1) + 'ied';
  return v + 'ed';
};
const IRREG_PAST = { run: 'ran', split: 'split', find: 'found', code: 'coded', review: 'reviewed' };
/* 断言类动词：只用于**结论/讨论节用过去时下一般性断言**的 INFO 提醒（不参与方法节的 WARN 判据） */
const CLAIM = ['work', 'improve', 'outperform', 'achieve', 'succeed'];
const CLAIM_IRREG = { work: 'worked' };

function sectionKind(heading) {
  const h = String(heading || '').toLowerCase();
  if (/(\bmethod|methodolog|materials and methods|\bexperiment|\bresults?\b|evaluation|\bdata and|\bstudy design)/.test(h)) return 'procedural';
  if (/(conclusion|discussion|limitation|future work)/.test(h)) return 'claim';
  return 'other';
}

/** 逐句扫描：返回 {sectionKind, line, sentence, verb, tense} */
function scan(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  const headings = [];                     /* ★ v3.11.0：记录**全部**标题（含零命中的节），SKIP 判据要用它 */
  let kind = 'other', heading = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const h = /^\s*#{1,6}\s*(.+?)\s*$/.exec(raw);
    if (h) { heading = h[1]; kind = sectionKind(heading); headings.push({ heading, kind }); continue; }
    if (!raw.trim() || /^\s*[|>]/.test(raw)) continue;
    const sents = raw.split(/(?<=[.!?])\s+(?=[A-Z])/);
    for (const s of sents) {
      const low = s.toLowerCase();
      for (const v of PROC) {
        const past = IRREG_PAST[v] || PAST_FORM(v);
        /* 现在时：`we <v>` / `<v>s` 主语在句首附近；排除 `to <v>`、`<v>ing`、`<v>ed`、will/can/should <v>` */
        const presRe = new RegExp('(?:^|[^a-z])(?:we|i|this (?:study|paper|work))\\s+' + v + '(?![a-z])', 'i');
        const thirdRe = new RegExp('(?:^|[^a-z])(?:the (?:authors?|study|model|method|system|pipeline))\\s+' + v + 's(?![a-z])', 'i');
        const pastRe = new RegExp('(?:^|[^a-z])(?:we|i)\\s+' + past + '(?![a-z])', 'i');
        const modalRe = new RegExp('(?:will|can|could|should|would|may|might|to)\\s+' + v + '(?![a-z])', 'i');
        if (modalRe.test(low)) continue;
        if (presRe.test(low) || thirdRe.test(low)) out.push({ kind, heading, line: i + 1, sentence: s.trim(), verb: v, tense: 'present' });
        else if (pastRe.test(low)) out.push({ kind, heading, line: i + 1, sentence: s.trim(), verb: v, tense: 'past' });
      }
    }
  }
  /* ★ v3.11.0：断言动词（结论节过去时 ⇒ INFO）单独扫一遍 */
  kind = 'other'; heading = '';
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const h = /^\s*#{1,6}\s*(.+?)\s*$/.exec(raw);
    if (h) { heading = h[1]; kind = sectionKind(heading); continue; }
    if (!raw.trim() || /^\s*[|>]/.test(raw)) continue;
    for (const s of raw.split(/(?<=[.!?])\s+(?=[A-Z])/)) {
      const low = s.toLowerCase();
      for (const v of CLAIM) {
        const past = CLAIM_IRREG[v] || PAST_FORM(v);
        const pastRe = new RegExp('(?:^|[^a-z])' + past + '(?![a-z])', 'i');
        if (pastRe.test(low)) out.push({ kind, heading, line: i + 1, sentence: s.trim(), verb: v, tense: 'past' });
      }
    }
  }
  return { hits: out, headings };
}

function check(text) {
  const sc = scan(text);
  const hits = sc.hits;
  const bySect = {};
  for (const h of hits) { const k = h.heading || '(无标题段)'; bySect[k] = bySect[k] || { kind: h.kind, present: 0, past: 0, samples: [] }; if (h.tense === 'present') bySect[k].present++; else bySect[k].past++; if (bySect[k].samples.length < 3) bySect[k].samples.push(h); }
  /* ★ v3.11.0：SKIP 只看**节是否存在**（此前错按"有无动词命中"判，导致有 `## 2. Methods` 的真稿被误判"没识别到方法节"） */
  const procedural = sc.headings.filter((h) => h.kind === 'procedural').map((h) => h.heading);
  if (!procedural.length) {
    return { status: 'SKIP', verdict: 'no-procedural-section', issues: [], sections: bySect, note: '稿内**没有**方法/结果节 ⇒ **时态未检查**（未检查 ≠ 通过）' };
  }
  const issues = [];
  for (const h of hits) {
    if (h.kind === 'procedural' && h.tense === 'present') {
      issues.push({ level: 'WARN', line: h.line, msg: '方法/结果节用现在时描述做过的动作（`' + h.verb + '`）⇒ 惯例改过去时：' + h.sentence.slice(0, 90) });
    }
    if (h.kind === 'claim' && h.tense === 'past') {
      issues.push({ level: 'INFO', line: h.line, msg: '结论/讨论节用过去时下一般性断言（`' + h.verb + '`）⇒ 一般性结论通常用现在时：' + h.sentence.slice(0, 90) });
    }
  }
  /* 混用：同一节里两种时态都出现且少数派 ≥30% ⇒ 单独提醒 */
  for (const k of procedural) {
    const s = bySect[k]; if (!s) continue; const tot = s.present + s.past;
    if (tot >= 4 && Math.min(s.present, s.past) / tot >= 0.3) issues.push({ level: 'WARN', line: 0, msg: '「' + k + '」节时态混用：过去时 ' + s.past + ' / 现在时 ' + s.present + '（少数派 ≥30%）⇒ 全节统一' });
  }
  /* 节存在但一条动词都没匹配到 ⇒ 明确记 INFO（避免被读成"查过且没问题"） */
  for (const h of procedural) {
    if (!bySect[h]) issues.push({ level: 'INFO', line: 0, msg: '「' + h + '」节未匹配到任何过程动词（本工具只认关键词表，**不等于该节写法正确**）' });
  }
  const warns = issues.filter((x) => x.level === 'WARN').length;
  return { status: warns ? 'FAIL' : 'PASS', issues, sections: bySect, note: '只查"做过的动作"的动词形态；`we propose/present/describe` 与 `the results show` 属惯例现在时，**不报**；本工具不做句法分析，命中原句已逐条打印供复核。' };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };

  ck('正控：方法/结果全用过去时 ⇒ PASS（且不把 `we propose` 当错）', () => {
    const t = '# Method\nWe trained the model on 30 cells and evaluated it on 12 cells.\n\n# Results\nWe measured accuracy in both protocols.\n\n# Introduction\nIn this paper we propose a three-layer taxonomy.\n';
    const r = check(t);
    return (r.status === 'PASS' && !r.issues.length) ? true : JSON.stringify(r.issues);
  });

  ck('★必失败面：方法节用现在时描述做过的动作 ⇒ WARN + 行号 + 原句', () => {
    const t = '# Method\nWe train the model on 30 cells and evaluate it on 12 cells.\n';
    const r = check(t);
    if (r.status !== 'FAIL') return '应 FAIL：' + JSON.stringify(r);
    if (!r.issues.some((x) => /train/.test(x.msg) && x.line === 2)) return '未指出 train（第 2 行）：' + JSON.stringify(r.issues);
    return true;
  });

  ck('★必失败面：`we propose` / `the results show` **不得**被误报（惯例现在时）', () => {
    const t = '# Method\nWe propose a new split and describe the pipeline.\n\n# Results\nThe results show a consistent gain.\n';
    const r = check(t);
    /* 意图是"惯例现在时不得被报成 WARN"；节存在但零过程动词的 INFO 属**正确行为**（本工具只认关键词表） */
    const warns = r.issues.filter((x) => x.level === 'WARN');
    return (warns.length === 0) ? true : '误报：' + JSON.stringify(warns);
  });

  ck('★必失败面：结论节用过去时下一般性断言 ⇒ INFO（且不影响 PASS）', () => {
    const t = '# Method\nWe trained the model.\n\n# Conclusion\nThe method worked well in general.\n';
    const r = check(t);
    if (!r.issues.some((x) => x.level === 'INFO' && /一般性/.test(x.msg))) return '未提示：' + JSON.stringify(r.issues);
    return (r.status === 'PASS') ? true : 'INFO 不该让整体 FAIL：' + r.status;
  });

  ck('★必失败面：**没有任何方法/结果节** ⇒ SKIP（未检查 ≠ 通过）', () => {
    const r = check('# Introduction\nWe introduce the problem.\n\n# Related work\nOthers studied it.\n');
    return (r.status === 'SKIP') ? true : JSON.stringify(r.status);
  });

  ck('稳健：`will train`/`to train`/`training` 不算现在时陈述', () => {
    const t = '# Method\nWe will train the model later. We plan to train more models. Training took two hours.\n';
    const r = check(t);
    return (r.issues.filter((x) => x.level === 'WARN').length === 0) ? true : '误报：' + JSON.stringify(r.issues);
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\ntense-check 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const d = val('--draft');
  if (!d) { console.error('前提层失败：需要 --draft <稿.md>（未核对，不得当通过）'); return 2; }
  const p = path.resolve(d);
  if (!fs.existsSync(p)) { console.error('前提层失败：稿件不存在 —— ' + p); return 2; }
  const r = check(fs.readFileSync(p, 'utf8'));
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return r.status === 'FAIL' ? 1 : (r.status === 'SKIP' ? 2 : 0); }
  console.log('时态规范机检：' + r.status + '（' + path.basename(p) + '）');
  console.log('  ' + r.note);
  for (const k of Object.keys(r.sections)) {
    const s = r.sections[k];
    console.log('  · [' + s.kind + '] ' + k + '：过去时 ' + s.past + ' / 现在时 ' + s.present);
  }
  for (const i of r.issues) console.log('  ' + (i.level === 'WARN' ? '✘' : '·') + ' [' + i.level + ']' + (i.line ? ' L' + i.line : '') + ' ' + i.msg);
  return r.status === 'FAIL' ? 1 : (r.status === 'SKIP' ? 2 : 0);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { scan, check, sectionKind, main, selftest };
