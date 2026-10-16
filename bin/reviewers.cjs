#!/usr/bin/env node
/**
 * reviewers —— 审稿人侧模拟（聚合）与问答演练评分（吸收自 lifecycle-skills 的 simulate-reviewers / rehearse-qa，Apache-2.0）
 *
 * ★ 吸收说明：**规则与流程**吸收自第三方技能包 `lifecycle-skills`（Apache-2.0）：
 *   · simulate-reviewers：评审面板按会议族校准（harshness）· 四维打分（新颖性/严谨性/可复现性/清晰度）·
 *     **置信加权均值** · 分歧/champion/detractor 标记 · 拖后腿维度 · 决策风险带（likely-reject / borderline-reject /
 *     borderline-accept / likely-accept）· **「borderline 且无 champion ⇒ 向下判」** 规则 · 未采纳的严谨性缺陷在
 *     harshness 高时把总分压到 borderline-reject
 *   · rehearse-qa：按 Q&A 槽位算能问几问 · 答题计时目标（answer-first）· 逐答评分（超时/未答/对冲开头/填充词密度/
 *     是否把答案埋在 yes-no 之后）· 退出码语义 0=ready / 1=需再练 / 2=输入不合法
 *   **实现为本仓自有 Node 纯函数 + 夹具，未复制其任何代码**；许可与来源见 references/external-adoptions.md。
 *
 * 用法：
 *   node bin/reviewers.cjs aggregate <scores.json> [--json]
 *   node bin/reviewers.cjs grade <transcript.md> --target <秒> --max <秒> [--lang zh|en] [--json]
 *   node bin/reviewers.cjs --selftest
 */
'use strict';
const fs = require('fs');

const DIMS = ['novelty', 'soundness', 'reproducibility', 'clarity'];
const DIM_ZH = { novelty: '新颖性', soundness: '严谨性', reproducibility: '可复现性', clarity: '清晰度' };
const BANDS = ['likely-reject', 'borderline-reject', 'borderline-accept', 'likely-accept'];
const BAND_ZH = { 'likely-reject': '很可能被拒', 'borderline-reject': '边缘偏拒', 'borderline-accept': '边缘偏收', 'likely-accept': '很可能被收' };

function fail(msg, code) { const e = new Error(msg); e.code = code || 'REVIEWERS_PRECONDITION'; return e; }
const isNum = (x) => typeof x === 'number' && isFinite(x);

/** 聚合评审：置信加权均值 + 标记 + 拖后腿维度 + 风险带（含"borderline 无 champion 向下判"） */
function aggregate(input) {
  const d = input || {};
  const rs = Array.isArray(d.reviewers) ? d.reviewers : null;
  if (!rs || rs.length === 0) throw fail('前提层失败：scores.json 里必须至少有 1 位审稿人（reviewers 为空）', 'NO_REVIEWERS');
  const scale = d.scale || {};
  const min = isNum(scale.min) ? scale.min : 1;
  const max = isNum(scale.max) ? scale.max : 10;
  const borderlineMax = isNum(scale.borderline_max) ? scale.borderline_max : Math.round((min + max) / 2);
  const acceptFrom = isNum(scale.accept_from) ? scale.accept_from : (borderlineMax + 1);
  const problems = [];
  for (const r of rs) {
    const id = r && r.id ? String(r.id) : '（无 id）';
    if (!r || !isNum(r.overall)) problems.push(id + '：缺 overall（必须数字）');
    else if (r.overall < min || r.overall > max) problems.push(id + '：overall=' + r.overall + ' 超出量表 [' + min + ',' + max + ']');
    if (r && r.confidence != null && !isNum(r.confidence)) problems.push(id + '：confidence 非数字');
    if (r && r.dimensions) { for (const k of Object.keys(r.dimensions)) { if (!isNum(r.dimensions[k])) problems.push(id + '：维度 ' + k + ' 非数字'); } }
  }
  if (problems.length) throw fail('前提层失败：scores.json 不合法 ⇒ ' + problems.join(' · ') + '（**不合法一律拒，不许当通过**）', 'BAD_INPUT');

  const conf = rs.map((r) => (isNum(r.confidence) && r.confidence > 0) ? r.confidence : 1);
  const sumW = conf.reduce((a, b) => a + b, 0);
  const weighted = rs.reduce((a, r, i) => a + r.overall * conf[i], 0) / sumW;
  const mean = rs.reduce((a, r) => a + r.overall, 0) / rs.length;
  const dims = {};
  for (const k of DIMS) {
    const vals = rs.map((r) => (r.dimensions && isNum(r.dimensions[k])) ? r.dimensions[k] : null).filter((x) => x !== null);
    dims[k] = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null;
  }
  const present = DIMS.filter((k) => dims[k] !== null);
  present.sort((a, b) => dims[a] - dims[b]);
  const drag = present.length ? present[0] : null;
  const spread = Math.max.apply(null, rs.map((r) => r.overall)) - Math.min.apply(null, rs.map((r) => r.overall));
  const champions = rs.filter((r) => r.overall >= acceptFrom).map((r) => r.id || '?');
  const detractors = rs.filter((r) => r.overall <= borderlineMax - 1).map((r) => r.id || '?');
  const harsh = rs.filter((r) => isNum(r.harshness) && r.harshness >= 4);
  const unaddressedSoundness = rs.filter((r) => r.soundness_unaddressed === true);

  let band;
  if (weighted <= borderlineMax - 1) band = 'likely-reject';
  else if (weighted <= borderlineMax) band = 'borderline-reject';
  else if (weighted < acceptFrom) band = 'borderline-accept';
  else band = 'likely-accept';
  const reasons = [];
  if (band === 'borderline-accept' && champions.length === 0) { band = 'borderline-reject'; reasons.push('**borderline 且无 champion ⇒ 向下判**（吸收自上游规则）'); }
  if (unaddressedSoundness.length && harsh.length) {
    if (BANDS.indexOf(band) > BANDS.indexOf('borderline-reject')) { band = 'borderline-reject'; }
    reasons.push('严谨性缺陷未采纳（' + unaddressedSoundness.map((r) => r.id || '?').join('/') + '）且存在 harshness≥4 的审稿人 ⇒ 总分被压到"边缘偏拒"（吸收自上游校准规则）');
  }
  if (spread >= 2) reasons.push('评审分歧大（极差 ' + spread + ' 分）⇒ 更像"champion + detractor"结构，回复要同时安抚两类人');
  if (detractors.length) reasons.push('dragging 评审：' + detractors.join('/'));
  if (!champions.length) reasons.push('**无 champion**：需要一个审稿人明确支持才容易过会');
  if (drag) reasons.push('拖后腿维度：' + DIM_ZH[drag] + '（均值 ' + dims[drag] + '）⇒ 优先进修该维度');

  const fix = [];
  if (drag) fix.push({ band: 'fix-now', what: '补强' + DIM_ZH[drag] + '（加对照/消融、补统计功效、补数据与代码可得性、改段落结构）' });
  if (unaddressedSoundness.length) fix.push({ band: 'fix-now', what: '把"未采纳的严谨性缺陷"转成显式声明（限制、敏感性分析、或删掉该主张）' });
  if (!champions.length) fix.push({ band: 'rebuttal-defensible', what: '给最强的那个审稿人一条"可引用的支持点"（逐条回应其关切 + 补一处最能加分的证据）' });
  if (band === 'likely-reject') fix.push({ band: 'structural', what: '结构性不足：考虑换目标刊/轨道（少量补充难以挽回）' });

  return {
    reviewers: rs.length, weighted_score: Math.round(weighted * 100) / 100, mean_score: Math.round(mean * 100) / 100,
    scale: { min, max, borderline_max: borderlineMax, accept_from: acceptFrom },
    dimension_means: dims, drag_dimension: drag,
    spread, champions, detractors, harsh_reviewers: harsh.length,
    decision_risk: band, decision_risk_zh: BAND_ZH[band], reasons, fix_list: fix,
    note: '★ 这是**咨询性**读数：它帮助你在还能改的时候发现问题，**不预测结果**，也不替代真实评审。',
  };
}

/* ── 问答演练评分（rehearse-qa 的 grade_answers 内核）── */
const HEDGE_ZH = ['呃', '嗯', '这个', '那个', '其实', '应该说', '我觉得', '我认为', '大概', '可能吧', '不好说', '怎么说呢'];
const HEDGE_EN = ['well', 'i think', 'i guess', 'kind of', 'sort of', 'we believe', 'it seems', 'maybe', 'probably'];
const FILLER_ZH = ['呃', '嗯', '那个', '就是', '然后就是', '反正', '也就是说', '对吧'];
const FILLER_EN = ['you know', 'like', 'basically', 'actually', 'sort of', 'i mean', 'right?'];
const YESNO_ZH = /[？?]$|^(是不是|有没有|能不能|是否|可否|有没有可能)/;
const ANSWER_ZH = /^(是|不是|对|不对|有|没有|能|不能|可以|不可以|会|不会|部分|一半|取决于)/;
const ANSWER_EN = /^(yes|no|partly|partially|not exactly|it depends|correct|incorrect)/i;

/** 解析转录：成对的 Q/A（也认 问/答 与加粗标记）——注意注释里不能出现会提前闭合块注释的字符序列 */
function parseTranscript(text) {
  const lines = String(text || '').split(/\r?\n/);
  const pairs = []; let cur = null;
  const isQ = (l) => /^\s*(\*\*|##\s*)?(Q|问|问题)\s*[:：*]?/i.test(l) || /^\s*(\*\*|##\s*)?Q\d+\b/i.test(l);
  const isA = (l) => /^\s*(\*\*|##\s*)?(A|答|回答|答案)\s*[:：*]?/i.test(l) || /^\s*(\*\*|##\s*)?A\d+\b/i.test(l);
  for (const l of lines) {
    if (isQ(l) && !isA(l)) { cur = { q: l.replace(/^\s*(\*\*|##\s*)?(Q|问|问题)\s*\d*\s*[:：*]*\s*/i, '').trim(), a: '' }; pairs.push(cur); }
    else if (isA(l) && cur) cur.a += (cur.a ? ' ' : '') + l.replace(/^\s*(\*\*|##\s*)?(A|答|回答|答案)\s*\d*\s*[:：*]*\s*/i, '').trim();
    else if (cur && l.trim()) cur.a += (cur.a ? ' ' : '') + l.trim();
  }
  return pairs;
}

const countUnits = (s, lang) => lang === 'en'
  ? (String(s).match(/[A-Za-z][A-Za-z'\-]*/g) || []).length
  : (String(s).match(/[\u4e00-\u9fa5]|[A-Za-z][A-Za-z'\-]*/g) || []).length;

function gradeAnswers(text, opts) {
  const o = opts || {};
  const target = Number(o.target), maxS = Number(o.max);
  if (!(target > 0) || !(maxS > 0) || maxS < target) throw fail('前提层失败：grade 需要 --target <秒> 与 --max <秒>（且 max ≥ target）——目标不明确就没法判"超时"', 'NO_TARGET');
  const lang = o.lang === 'en' ? 'en' : 'zh';
  const cfg = o.budgetCfg || { speech_rate: { zh: [180, 220], en: [120, 150] } };
  const rate = (cfg.speech_rate || {})[lang] || [180, 220];
  const perSec = rate[0] / 60;                                  // 保守低端：说得慢也算长
  const pairs = parseTranscript(text);
  if (!pairs.length) throw fail('前提层失败：转录里没解析到 Q/A 对（用 `Q:` / `A:` 或 `问：` / `答：` 成对写）', 'NO_PAIRS');
  const hedgeList = lang === 'zh' ? HEDGE_ZH : HEDGE_EN;
  const fillerList = lang === 'zh' ? FILLER_ZH : FILLER_EN;
  const rows = pairs.map((p, i) => {
    const units = countUnits(p.a, lang);
    const sec = units > 0 ? Math.round(units / perSec) : 0;
    const lower = p.a.toLowerCase();
    const firstWords = p.a.slice(0, 30);
    const findings = [];
    if (units === 0) findings.push({ level: 'RISK', check: 'unanswered', msg: '这问没答（空）' });
    if (sec > maxS) findings.push({ level: 'RISK', check: 'over_max', msg: '约 ' + sec + ' 秒 > 上限 ' + maxS + ' 秒（' + units + ' 单位）⇒ 砍到一句主张 + 一个证据' });
    else if (sec > target) findings.push({ level: 'WARN', check: 'over_target', msg: '约 ' + sec + ' 秒 > 目标 ' + target + ' 秒（上限内，但偏长）' });
    if (sec > 0 && sec < Math.floor(target / 3)) findings.push({ level: 'INFO', check: 'too_short', msg: '约 ' + sec + ' 秒，明显短于目标 ' + target + ' 秒 ⇒ 确认是否答到点上（也可能只是回答得干脆）' });
    if (hedgeList.some((h) => lower.startsWith(h) || firstWords.toLowerCase().startsWith(h))) findings.push({ level: 'WARN', check: 'hedge_opener', msg: '开头是对冲词 ⇒ 改成"先给结论"' });
    const fillerHits = fillerList.reduce((a, f) => a + (lower.split(f).length - 1), 0);
    const density = units > 0 ? Math.round((fillerHits / units) * 1000) / 10 : 0;
    if (density > 3) findings.push({ level: 'WARN', check: 'filler', msg: '填充词密度 ' + density + '%（' + fillerHits + ' 处）⇒ 超过 3% 要练' });
    const isYesNo = YESNO_ZH.test(p.q) || /^(is|are|do|does|did|can|could|will|would|have|has|should)\b/i.test(p.q.trim());
    if (isYesNo) {
      const ok = lang === 'zh' ? ANSWER_ZH.test(p.a.trim()) : ANSWER_EN.test(p.a.trim());
      if (units > 0 && !ok) findings.push({ level: 'RISK', check: 'buried_answer', msg: '这是是否问句，但答案没以"是/否/部分"开头 ⇒ 先给是/否，再给理由' });
    }
    const risks = findings.filter((f) => f.level === 'RISK').length;
    return { no: i + 1, question: p.q.slice(0, 80), units, est_seconds: sec, findings, risks };
  });
  const risky = rows.filter((r) => r.risks > 0);
  return {
    lang, target_seconds: target, max_seconds: maxS, answers: rows.length,
    total_est_seconds: rows.reduce((a, r) => a + r.est_seconds, 0),
    needs_redrill: risky.map((r) => r.no),
    ready: risky.length === 0,
    rows,
    note: '★ 判据只看**能与不能机检**的东西（计时/是否答/开头/填充/是否埋答案）；内容对不对、诚实不诚实要人来判。上游纪律：**一条答案要连续两次站得住才算练成**。',
  };
}

/* ─────────────────────────── selftest ─────────────────────────── */
function selftest() {
  const cases = [];
  const ck = (name, fn) => { let r; try { r = fn(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); };

  ck('aggregate·置信加权：高置信审稿人权重更大（与算术均值必须不同）', () => {
    const r = aggregate({ scale: { min: 1, max: 10, borderline_max: 5 }, reviewers: [
      { id: 'R1', confidence: 5, overall: 8 }, { id: 'R2', confidence: 1, overall: 2 }] });
    const w = (8 * 5 + 2 * 1) / 6;
    if (Math.abs(r.weighted_score - Math.round(w * 100) / 100) > 0.001) return '加权均值算错：' + r.weighted_score + ' 期望 ' + w;
    if (Math.abs(r.mean_score - 5) > 0.001) return '算术均值应为 5：' + r.mean_score;
    if (r.weighted_score === r.mean_score) return '加权与算术居然相同 ⇒ 没加权';
    return true;
  });

  ck('aggregate·★borderline 且无 champion ⇒ 向下判（吸收的上游规则）', () => {
    const r = aggregate({ scale: { min: 1, max: 10, borderline_max: 5, accept_from: 6 }, reviewers: [
      { id: 'R1', confidence: 3, overall: 5.5, dimensions: { soundness: 3 } }, { id: 'R2', confidence: 3, overall: 5.5, dimensions: { soundness: 4 } }] });
    if (r.decision_risk !== 'borderline-reject') return '应向下判为 borderline-reject：' + r.decision_risk;
    if (!r.reasons.some((x) => /无 champion/.test(x))) return '未说明 champion 规则';
    return true;
  });

  ck('aggregate·正控：有 champion 且分数够 ⇒ likely-accept（不误伤）', () => {
    const r = aggregate({ scale: { min: 1, max: 10, borderline_max: 5, accept_from: 6 }, reviewers: [
      { id: 'R1', confidence: 4, overall: 8, dimensions: { novelty: 4, soundness: 4 } },
      { id: 'R2', confidence: 3, overall: 7, dimensions: { novelty: 4, soundness: 4 } }] });
    return r.decision_risk === 'likely-accept' ? true : '应为 likely-accept：' + r.decision_risk + ' ' + JSON.stringify(r.reasons);
  });

  ck('aggregate·拖后腿维度按均值最小者判定（不接受"挑一个"）', () => {
    const r = aggregate({ reviewers: [
      { id: 'R1', confidence: 1, overall: 5, dimensions: { novelty: 4, soundness: 2, reproducibility: 3, clarity: 5 } },
      { id: 'R2', confidence: 1, overall: 5, dimensions: { novelty: 4, soundness: 2.5, reproducibility: 3, clarity: 5 } }] });
    return r.drag_dimension === 'soundness' ? true : '拖后腿维度应 soundness：' + r.drag_dimension + ' ' + JSON.stringify(r.dimension_means);
  });

  ck('aggregate·★必失败面：量表越界 / 空审稿人 / 非数字 overall 一律拒（不许当通过）', () => {
    const bad1 = (() => { try { aggregate({ reviewers: [] }); return ''; } catch (e) { return e.code; } })();
    const bad2 = (() => { try { aggregate({ scale: { min: 1, max: 10 }, reviewers: [{ id: 'R1', overall: 99 }] }); return ''; } catch (e) { return e.code; } })();
    const bad3 = (() => { try { aggregate({ reviewers: [{ id: 'R1', overall: 'high' }] }); return ''; } catch (e) { return e.code; } })();
    if (bad1 !== 'NO_REVIEWERS') return '空 reviewers 未拒：' + bad1;
    if (bad2 !== 'BAD_INPUT') return '越界未拒：' + bad2;
    if (bad3 !== 'BAD_INPUT') return '非数字未拒：' + bad3;
    return true;
  });

  ck('grade·计时：中文按 180 字/分算，超上限判 RISK、超目标判 WARN', () => {
    const zh = '字'.repeat(180);   // 180 字 ⇒ 60 秒
    const t = 'Q: 你的方法好在哪？\nA: ' + zh + '\n\nQ: 有没有做过对照？\nA: 有。我们做了三个基线。';
    const r = gradeAnswers(t, { target: 45, max: 75, lang: 'zh' });
    if (r.rows[0].est_seconds !== 60) return '180 字应算 60 秒：' + r.rows[0].est_seconds;
    if (!r.rows[0].findings.some((f) => f.check === 'over_target')) return '60 秒 > 目标 45 应 WARN';
    const t2 = 'Q: 一句话结论？\nA: ' + '字'.repeat(300);
    const r2 = gradeAnswers(t2, { target: 45, max: 75, lang: 'zh' });
    if (!r2.rows[0].findings.some((f) => f.check === 'over_max' && f.level === 'RISK')) return '300 字（100 秒）应判 over_max RISK';
    return true;
  });

  ck('grade·★必失败面：对冲开头 / 是否问句埋答案 / 空答 三类必须各自报出', () => {
    const t = ['Q: 这个方法的局限是什么？', 'A: 呃，我觉得大概是样本量的问题，可能吧。',
      '', 'Q: 复现包有吗？', 'A: 我们详细讨论了数据可得性的多个方面以及未来的计划。',
      '', 'Q: 你如何保证公平比较？', 'A:'].join('\n');
    const r = gradeAnswers(t, { target: 45, max: 75, lang: 'zh' });
    const checks = new Set(); r.rows.forEach((x) => x.findings.forEach((f) => checks.add(f.check)));
    for (const need of ['hedge_opener', 'buried_answer', 'unanswered']) if (!checks.has(need)) return '未报出 ' + need + '（实得 ' + [...checks].join(',') + '）';
    if (r.ready !== false || r.needs_redrill.length === 0) return 'rready 应为 false 且有需再练项';
    return true;
  });

  ck('grade·正控：干脆的"是+一句证据"必须判 ready（不误伤）', () => {
    const t = ['Q: 复现包有吗？', 'A: 有。代码与数据都在补充材料 S3，一行命令可复现主图。',
      '', 'Q: 与基线比如何？', 'A: 是。三个基线全面占优，主表第 2 列是差值。'].join('\n');
    const r = gradeAnswers(t, { target: 45, max: 75, lang: 'zh' });
    return r.ready ? true : ('仍有风险：' + JSON.stringify(r.rows.map((x) => x.findings)));
  });

  ck('grade·★必失败面：不给 --target/--max ⇒ 前提层失败（没有目标就判不了超时）', () => {
    let code = '';
    try { gradeAnswers('Q: a\nA: 是。', {}); } catch (e) { code = e.code; }
    if (code !== 'NO_TARGET') return '未按前提层失败：' + code;
    let c2 = '';
    try { gradeAnswers('既没有问号行也没有 Q 标记的一段话。', { target: 45, max: 75 }); } catch (e) { c2 = e.code; }
    if (c2 !== 'NO_PAIRS') return '非 Q/A 文本未拒：' + c2;
    return true;
  });

  ck('端到端：aggregate + grade 串跑，读数自带"咨询性/非预测"声明', () => {
    const a = aggregate({ reviewers: [{ id: 'R1', confidence: 3, overall: 6, dimensions: { novelty: 3, soundness: 3, reproducibility: 2, clarity: 4 } }] });
    const g = gradeAnswers('Q: 复现包有吗？\nA: 有。在补充材料 S3。', { target: 45, max: 75, lang: 'zh' });
    if (!/不预测结果/.test(a.note)) return 'aggregate 缺"非预测"声明';
    if (!g.ready) return '干脆答案竟不 ready';
    return true;
  });

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.ok ? '' : '  ← ' + c.detail));
  console.log('\nreviewers 自检：' + (cases.length - failed.length) + '/' + cases.length + ' 通过');
  return failed.length ? 1 : 0;
}

function main(argv, ctx) {
  const o = ctx || {};
  if (argv.includes('--selftest')) return selftest();
  const sub = argv[0] || ''; const rest = argv.slice(1);
  const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
  const json = rest.includes('--json');
  try {
    if (sub === 'aggregate') {
      const f = rest.find((a) => !a.startsWith('--') && a !== flag('--json'));
      if (!f || !fs.existsSync(f)) { console.error('前提层失败：aggregate 需要存在的 scores.json（收到 ' + (f || '空') + '）'); return 2; }
      const r = aggregate(JSON.parse(fs.readFileSync(f, 'utf8')));
      if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log('聚合评审（' + r.reviewers + ' 位 · 量表 ' + r.scale.min + '–' + r.scale.max + '）：置信加权 ' + r.weighted_score + ' · 算术均值 ' + r.mean_score);
      console.log('决策风险带：**' + r.decision_risk + '（' + r.decision_risk_zh + '）**' + (r.champions.length ? ' · champion: ' + r.champions.join('/') : ' · **无 champion**'));
      console.log('拖后腿维度：' + (r.drag_dimension ? DIM_ZH[r.drag_dimension] + '（' + r.dimension_means[r.drag_dimension] + '）' : '—') + ' · 分歧极差 ' + r.spread);
      for (const x of r.reasons) console.log('  - ' + x);
      console.log('修法清单：'); for (const x of r.fix_list) console.log('  [' + x.band + '] ' + x.what);
      console.log('  ' + r.note);
      return 0;
    }
    if (sub === 'grade') {
      const f = rest.find((a) => !a.startsWith('--') && a !== flag('--target') && a !== flag('--max') && a !== flag('--lang'));
      if (!f || !fs.existsSync(f)) { console.error('前提层失败：grade 需要存在的转录文件（收到 ' + (f || '空') + '）'); return 2; }
      const cfg = (o.pipeline && o.pipeline.forms && o.pipeline.forms.budget) || null;
      const r = gradeAnswers(fs.readFileSync(f, 'utf8'), { target: flag('--target'), max: flag('--max'), lang: flag('--lang') || 'zh', budgetCfg: cfg });
      if (json) { console.log(JSON.stringify(r, null, 2)); return r.ready ? 0 : 1; }
      console.log('问答演练评分（' + r.answers + ' 答 · 目标 ' + r.target_seconds + ' 秒 / 上限 ' + r.max_seconds + ' 秒 · 总计时 ' + r.total_est_seconds + ' 秒）');
      for (const x of r.rows) {
        console.log('  ' + String(x.no).padStart(2) + '. ' + x.est_seconds + ' 秒 · ' + (x.risks ? '✘ ' + x.risks + ' 项风险' : '✓') + '  ' + x.question);
        for (const fd of x.findings) console.log('      ' + (fd.level === 'RISK' ? '✘' : '·') + ' [' + fd.check + '] ' + fd.msg);
      }
      console.log(r.ready ? '  判定：ready（可以上台）' : '  判定：需再练 ' + r.needs_redrill.join('/') + '（上游纪律：一条答案连续两次站得住才算练成）');
      console.log('  ' + r.note);
      return r.ready ? 0 : 1;
    }
    console.error('用法：reviewers aggregate <scores.json> | reviewers grade <transcript.md> --target <秒> --max <秒> | reviewers --selftest');
    return 2;
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { aggregate, gradeAnswers, parseTranscript, countUnits, main, selftest, DIMS, BANDS };
