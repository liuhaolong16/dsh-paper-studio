#!/usr/bin/env node
/**
 * polish losscheck —— **跨语言丢信息检测器**（中→英/英→中）
 *
 * 起因：三判盲评说我方「丢失数据」，而 `polish rewrite --fidelity` 在我方产出上 **0 处可改**
 * ⇒ 我方弱点**不在机械层面**（AI 味 0、名词化 3.9%），而在**译文本身丢了原文的信息**。
 * 那就必须有一个**对着原文查产出**的检测器，而不是对着产出做美化。
 *
 * 检四类**可核查信息**（不做语义判断，只做出现/缺失）：
 *   1. **数字**：原文的数字记号（含 30、27%、1.5、2020）必须都出现在产出里；
 *   2. **引用标记**：`[12]` / `\cite{…}` 的多重集合必须一致（少一个就是丢引用）；
 *   3. **对冲/限量词**：原文有 `一定程度上/可能/较为/相对/通常/往往/约/部分`，产出必须有**至少同等数量**的英文对冲词
 *      （largely / mostly / generally / relatively / somewhat / may / might / could / approximately / partly / likely）；
 *   4. **专有名词/缩写**：原文的全大写缩写（SOH、NASA、BMS）必须原样出现在产出里。
 *
 * ★ 边界：只查"在不在"，**不查"对不对"**；同义改写（e.g. `a large number of` ↔ `many`）不算丢失。
 * ★ 三态：PASS / WARN（信息可能被弱化）/ FAIL（确有信息缺失）—— **WARN 不等于通过**。
 *
 * 用法：
 *   node bin/polish.cjs losscheck --src <原文> --out <产出> [--json]
 *   node bin/polish.cjs losscheck --selftest
 */
'use strict';

const HEDGE_ZH = /(一定程度上|可能|或许|大约|近似|部分|似乎|倾向于|往往|通常|较为|相对|比较|约)/g;
const HEDGE_EN = /\b(largely|mostly|generally|relatively|somewhat|presumably|possibly|likely|may|might|could|roughly|approximately|about|nearly|partly|partially|arguably|reportedly|tend|tends|often|usually)\b/gi;

const numbersOf = (s) => (String(s).match(/\d+(?:\.\d+)?%?/g) || []);
const citesOf = (s) => {
  const a = String(s).match(/\[\d+(?:[,\-–]\d+)*\]/g) || [];
  const b = String(s).match(/\\cite[a-z]*\{[^}]+\}/g) || [];
  return a.concat(b).map((x) => x.replace(/\s+/g, ''));
};
const acrOf = (s) => Array.from(new Set(String(s).match(/\b[A-Z]{2,6}\b/g) || []));
const hedgesIn = (s, re) => (String(s).match(re) || []).length;
/* ★ v3.32.0 **超参数级**保真：`key=value` 必须成对存活。
   起因：Task A' 里 academic 那家把 `n_estimators=300, max_depth=4, learning_rate=0.08, subsample=0.9,
   colsample_bytree=0.9, random_state=0` 整批删掉。只查"数字在不在"能抓到这一种，
   但抓不到更隐蔽的两种：① 数字还在却挂错键（300 被写成 max_depth=300）；② 键还在值被改（0.08 → 0.1）。 */
const PARAM_RE = /`?\b([A-Za-z_][A-Za-z0-9_]{1,30})\s*=\s*(-?\d+(?:\.\d+)?)`?/g;
function paramsOf(s) {
  const m = new Map();
  let x; PARAM_RE.lastIndex = 0;
  while ((x = PARAM_RE.exec(String(s)))) {
    const k = x[1].toLowerCase(); const v = x[2];
    if (!m.has(k)) m.set(k, new Set());
    m.get(k).add(v);
  }
  return m;
}


/** ★ 真稿抓出的坑：原文头部有元数据行（`# contestant:` / `<!-- … -->` / 日期行），
    翻译本不该带它们，但按"数字缺失"会被误报 ⇒ 抽取前先剥元数据行。 */
function stripMeta(s) {
  return String(s).split('\n').filter((L) => {
    if (/^\s*#/.test(L)) return false;           // markdown 标题/自曝头
    if (/^\s*<!--/.test(L)) return false;        // HTML 注释
    if (/^\s*(date|source|contestant|task|input)\s*[:：]/i.test(L)) return false;
    if (/^\s*---+\s*$/.test(L)) return false;    // front-matter 分隔线
    return true;
  }).join('\n');
}
/** 参考文献区：从 `References / Bibliography / Works cited / 参考文献` 标题起到下一个同级或更高级标题（或 EOF）。
 *  起因（2026-10-17 实测）：中文初稿 + 英文投稿稿，英文稿**重排了文献表** ⇒ 按字符串比，文献编号、arXiv 号、
 *  文献来源缩写必然"缺失"⇒ 报 FAIL。那不是丢信息，是**换了排列**。⇒ 跨语言对比时默认排除文献区。 */
function stripRefs(s) {
  const lines = String(s).split('\n');
  let start = -1, level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s*(?:\d+\.?\s*)?(references?|bibliography|works\s+cited|参考文献|引用文献)\s*$/i);
    if (m) { start = i; level = m[1].length; break; }
  }
  if (start < 0) return String(s);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return lines.slice(0, start).concat(lines.slice(end)).join('\n');
}
/** 工作稿元信息（**不是正文**）：进度条（`████ 100%`）、待办勾选框、`>` 中文批注/说明块、内部文件名（`02-选题.md`）。
 *  起因（2026-10-17 实测）：中文初稿自带「结构 ████ 100%」「[ ] Cover Letter（可参考 Ultron v1.6）」「页码 4765–4774 未一手核实」
 *  这类工作稿附属区，英文投稿稿本来就不该包含它们 ⇒ 报"丢信息"是**判错了对象**。 */
function stripDraftMeta(s) {
  return String(s).split('\n').filter((L) => {
    if (/^\s*>/.test(L)) return false;                       // 工作稿批注/说明块（中文初稿以 > 标中文批注）
    if (/█/.test(L)) return false;                           // 进度条行
    if (/^\s*(?:[-*]\s*)?\[[ xX]\]/.test(L)) return false;   // 待办勾选框
    if (/\b\d{2}-[^\s|]+\.(?:md|json|csv|py)\b/.test(L)) return false;  // 内部文件名引用
    if (/^\s*(?:[-*]\s*)?(?:★|⚠|✔|✘)/.test(L)) return false;            // 工作稿自检/核验记录（SHA256、figkit 自检等）
    return true;
  }).join('\n');
}
function losscheck(srcRaw, outRaw, opts) {
  const o = opts || {};
  let s0 = srcRaw, o0 = outRaw;
  if (o.skipRefs) { s0 = stripRefs(s0); o0 = stripRefs(o0); }
  if (o.skipDraftMeta) { s0 = stripDraftMeta(s0); }
  const src = stripMeta(s0), out = stripMeta(o0);
  const problems = [];
  const notes = [];
  if (o.skipRefs) notes.push({ rule: 'refs-skipped', detail: '已排除参考文献区（文献重排时按字符串比必然误报，不等于丢信息）' });
  if (o.skipDraftMeta) notes.push({ rule: 'draftmeta-skipped', detail: '已排除工作稿元信息（进度条/待办/批注/内部文件名）——它们不是正文' });
  /* 1. 数字 */
  const srcN = numbersOf(src), outN = numbersOf(out);
  const outSet = new Set(outN);
  const missingN = srcN.filter((n) => !outSet.has(n));
  if (missingN.length) problems.push({ rule: 'number-missing', detail: '原文的数字在产出里找不到：' + Array.from(new Set(missingN)).join(', ') });
  /* 2. 引用 */
  const srcC = citesOf(src), outC = citesOf(out);
  const outCSet = new Set(outC);
  const missingC = srcC.filter((c) => !outCSet.has(c));
  if (missingC.length) problems.push({ rule: 'citation-missing', detail: '原文的引用标记缺失：' + Array.from(new Set(missingC)).join(' ') });
  /* 2b. 超参数（key=value 成对保真） */
  const srcP = paramsOf(src), outP = paramsOf(out);
  const outVals = new Set(); for (const vs of outP.values()) for (const v of vs) outVals.add(v);
  /* ★ 判据修正（同一个"量错对象"家族）：要在**产出全文的数字**里找值，
     而不是只在产出的 key=value 集合里找 —— 否则「We grew 300 trees」这种
     把值写成散文的情况会被误判成"值也没了"（本该是 WARN 的键丢失）。 */
  const outNums = new Set(numbersOf(out));
  const paramMissing = []; const paramChanged = []; const paramKeyLost = [];
  for (const [k, vs] of srcP) {
    if (!outP.has(k)) {
      const keptAll = Array.from(vs).every((v) => outNums.has(v));
      if (keptAll) paramKeyLost.push(k + '=' + Array.from(vs).join('|'));
      else paramMissing.push(k + '=' + Array.from(vs).join('|'));
      continue;
    }
    const ov = outP.get(k);
    const okv = Array.from(vs).some((v) => ov.has(v));
    if (!okv) paramChanged.push(k + '：原文 ' + Array.from(vs).join('|') + ' → 产出 ' + Array.from(ov).join('|'));
  }
  if (paramMissing.length) problems.push({ rule: 'param-missing', detail: '超参数整项缺失（值也没了）：' + paramMissing.join(' , ') });
  if (paramChanged.length) problems.push({ rule: 'param-value-changed', detail: '超参数键还在但值被改（复现性受损）：' + paramChanged.join(' ; ') });
  if (paramKeyLost.length) notes.push({ rule: 'param-key-lost', detail: '数值仍在但键名没了（写成散文了，读者可能对不上超参数）：' + paramKeyLost.join(' , ') });
  /* 3. 对冲词（数量守恒） */
  const hz = hedgesIn(src, HEDGE_ZH), he = hedgesIn(out, HEDGE_EN);
  if (hz > 0 && he < hz) notes.push({ rule: 'hedge-weakened', detail: '原文对冲词 ' + hz + ' 处，产出仅 ' + he + ' 处 ⇒ 不确定性被弱化（这是"改原意"，不是"润色"）' });
  /* 4. 缩写 */
  const srcA = acrOf(src), outUp = String(out).toUpperCase();
  const missingA = srcA.filter((a) => !outUp.includes(a));
  if (missingA.length) problems.push({ rule: 'acronym-missing', detail: '原文缩写缺失：' + missingA.join(', ') });
  if (!srcN.length) notes.push({ rule: 'no-numbers', detail: '原文没有数字 ⇒ 该项未核对（≠ 通过）' });

  const WARN_RULES = ['hedge-weakened', 'param-key-lost'];
  const status = problems.length ? 'FAIL' : (notes.some((x) => WARN_RULES.includes(x.rule)) ? 'WARN' : 'PASS');
  return { status, problems, notes, counts: { numbers: srcN.length, cites: srcC.length, hedgesZh: hz, hedgesEn: he, acronyms: srcA.length } };
}

function render(r) {
  const lines = [];
  lines.push('跨语言丢信息检测：' + r.status + (r.status === 'WARN' ? '（信息可能被弱化 —— WARN **不等于**通过）' : '') + (r.status === 'FAIL' ? '（确有信息缺失）' : ''));
  lines.push('  计数：原文数字 ' + r.counts.numbers + ' · 引用 ' + r.counts.cites + ' · 对冲词 ' + r.counts.hedgesZh + '（产出 ' + r.counts.hedgesEn + '）· 缩写 ' + r.counts.acronyms);
  for (const p of r.problems) lines.push('  ✘ [' + p.rule + '] ' + p.detail);
  for (const n of r.notes) lines.push('  · [' + n.rule + '] ' + n.detail);
  lines.push('  边界：只查"在不在"，不查"对不对"；同义改写不算丢失。');
  return lines.join('\n');
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const src = '我们回顾了30篇文献，发现效率提升较为一致，但在是否引入错误上存在分歧[12]。一定程度上，结果依赖于核查强度。SOH 估计需要更多证据。';

  ck('正控：数字/引用/缩写/对冲词都在 ⇒ PASS', () => {
    const out = 'We reviewed 30 studies and found largely consistent efficiency gains, but disagreement on error introduction [12]. Results relatively depend on checking intensity. SOH estimation needs more evidence.';
    const r = losscheck(src, out);
    return (r.status === 'PASS') ? true : JSON.stringify(r);
  });
  ck('★必失败面：漏掉引用 [12] ⇒ FAIL（citation-missing）', () => {
    const out = 'We reviewed 30 studies. SOH estimation needs more evidence.';
    const r = losscheck(src, out);
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'citation-missing')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：漏掉数字 30 ⇒ FAIL（number-missing）', () => {
    const out = 'We reviewed many studies [12]. SOH needs evidence.';
    const r = losscheck(src, out);
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'number-missing')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：对冲词被删尽 ⇒ **WARN 而不是 PASS**（WARN ≠ 通过）', () => {
    const out = 'We reviewed 30 studies and found consistent gains, with disagreement on errors [12]. Results depend on checking. SOH needs evidence.';
    const r = losscheck(src, out);
    return (r.status === 'WARN' && r.notes.some((n) => n.rule === 'hedge-weakened')) ? true : JSON.stringify(r);
  });
  ck('缩写遗失 ⇒ FAIL（acronym-missing）', () => {
    const out = 'We reviewed 30 studies [12]. State estimation needs evidence.';
    const r = losscheck(src, out);
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'acronym-missing')) ? true : JSON.stringify(r);
  });

  ck('★ v3.32.0 超参数成对保真：值还在但键没了 ⇒ WARN（不等于通过）', () => {
    const r = losscheck('Set `n_estimators=300` and `max_depth=4`.', 'We grew 300 trees to a depth of 4.');
    return (r.status === 'WARN' && r.notes.some((n) => n.rule === 'param-key-lost')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：超参数键还在但值被改 ⇒ FAIL（param-value-changed）', () => {
    const r = losscheck('Set `n_estimators=300`.', 'Set `n_estimators=200`.');
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'param-value-changed')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：超参数整项删除 ⇒ FAIL（param-missing）', () => {
    const r = losscheck('Set `n_estimators=300` and `max_depth=4`.', 'Set the hyper-parameters by hand.');
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'param-missing')) ? true : JSON.stringify(r);
  });
  /* ── v3.46.0：参考文献区排除（跨语言/文献重排的必然误报） ── */
  const srcZhRefs = '# 正文\n结果是 0.874。\n\n## 参考文献\n[1] 张三. 某文. arXiv:1603.02754. 2020.\n';
  const outEnRefs = '# Body\nThe result is 0.874.\n\n## References\n[1] Zhang S. Some paper. arXiv:1603.02754. 2020.\n';
  ck('文献区排除：文献编号/arXiv 号在产出里"换了位置" ⇒ 不再报 missing', () => {
    const r = losscheck(srcZhRefs, outEnRefs, { skipRefs: true });
    const still = r.problems.some((p) => p.rule === 'number-missing');
    return (!still && r.notes.some((n) => n.rule === 'refs-skipped')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：正文数字真丢时，排除文献区**也必须**照样抓到', () => {
    const src = '# 正文\n结果是 0.874，误差 1.2%。\n\n## 参考文献\n[1] 某文 2020.\n';
    const out = '# Body\nThe result is 0.874.\n\n## References\n[1] Some paper 2020.\n';
    const r = losscheck(src, out, { skipRefs: true });
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'number-missing' && /1\.2/.test(p.detail))) ? true : JSON.stringify(r);
  });
  /* ── 工作稿元信息排除 ── */
  const srcWork = '# 正文\n结果是 0.874。\n\n结构 ██████████ 100% 全节齐备\n- [ ] Cover Letter（参考 Ultron v1.6）\n> 注：页码 4765–4774 未一手核实\n依据 `02-选题.md`\n';
  const outClean = '# Body\nThe result is 0.874.\n';
  ck('工作稿元信息排除：进度条/待办/批注/内部文件名里的数字不再报 missing', () => {
    const r = losscheck(srcWork, outClean, { skipDraftMeta: true });
    const still = r.problems.some((p) => p.rule === 'number-missing');
    return (!still && r.notes.some((n) => n.rule === 'draftmeta-skipped')) ? true : JSON.stringify(r);
  });
  ck('★必失败面：排除工作稿元信息后，正文数字真丢仍要 FAIL', () => {
    const src = '# 正文\n精度 93.0%。\n\n结构 ████ 100%\n';
    const out = '# Body\nAccuracy looks good.\n';
    const r = losscheck(src, out, { skipDraftMeta: true });
    return (r.status === 'FAIL' && r.problems.some((p) => p.rule === 'number-missing' && /93/.test(p.detail))) ? true : JSON.stringify(r);
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nlosscheck 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

module.exports = { losscheck, render, selftest, numbersOf, citesOf, acrOf };

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest());
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const fs = require('fs');
  const s = v('--src'), o = v('--out');
  if (!s || !o || !fs.existsSync(s) || !fs.existsSync(o)) { console.error('前提层失败：需要 --src <原文> --out <产出>'); process.exit(2); }
  const r = losscheck(fs.readFileSync(s, 'utf8'), fs.readFileSync(o, 'utf8'));
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
