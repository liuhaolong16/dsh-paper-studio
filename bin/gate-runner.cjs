#!/usr/bin/env node
/**
 * paper-studio · 门执行器（gate-runner）
 *
 * 唯一真源：references/pipeline.json 的 gates[].args 模板 —— 本文件不得内联任何脚本名或参数模式。
 * 判定纪律（每条都由一次真实事故换来）：
 *   1. 逐门同时记【退出码】与【stdout 是否为空】；rc≠0 且 stdout 为空 ⇒ verdict = precondition_fail
 *      （前提层失败：脚本崩了/环境缺东西，而不是"检查结果为空"）。
 *   2. 缺输入（占位符没给或文件不存在）⇒ verdict = skipped_missing_input，**绝不折算成 pass**。
 *   3. 跑门前无条件断言脚本与解释器存在（本机有过子进程缺模块目录致命令不存在的先例）。
 *
 * 用法：
 *   node bin/gate-runner.cjs --task "给这篇稿子做投稿前体检" --draft <md> [--docx <docx>] [--anchors <json>] [--manifest <json>] [--contract <json>] [--declaration <json>] [--json]
 *   node bin/gate-runner.cjs --selftest
 *
 * 退出码：0 = 全通过（含 skipped 为 0）· 1 = 有非致命缺口（LOW / skipped / 非 0 但非前提失败）· 2 = 有硬失败或前提层失败
 */
'use strict';

const fs = require('fs');

/* 未解析的 __LOCAL__ 占位符 ⇒ 给**可操作**指引（v3.2.18：此前只有两处命令给了提示，门执行路径只打印占位符） */
const PLACEHOLDER_HINT = '（未解析的本机路径占位符 ⇒ 把 references/local-paths.example.json 复制成 '
  + '~/.dsh/paper-studio/local-paths.json 并填真实路径，或设 DSH_PAPER_LOCAL_PATHS 指向你的表）';
const hintIfLocal = (v) => (String(v == null ? '' : v).indexOf('__LOCAL__') === 0 ? PLACEHOLDER_HINT : '');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const studio = require('./studio.cjs'); // 复用真源读取与路由：禁止第二份实现

const ROOT = path.resolve(__dirname, '..');

/**
 * 过程叙述式安慰语（V2.8 · 吸收 ARIS citation-discipline §Output Discipline）：
 * 「引用已核验 / All DOIs verified / bibliography checked / 无撤回标记」这类话**不是内容**——
 * 核验结论住在工件里，正文只讲事实。本函数供 GUI/T2/报告自查用。
 */
const REASSURANCE_RE = /(已核验|核验完毕|全部核验|引用(已|全部)(检查|核验)|DOI\s*全部有效|全部有效|已确认无误|无撤回标记|all\s+(dois?|citations?|references?)\s+(verified|checked|valid)|citations?\s+verified|bibliography\s+checked|no\s+retraction\s+flags|verified\s+successfully)/i;
function hasReassuranceProse(text) { return REASSURANCE_RE.test(String(text || '')); }

// ── V2.7 工件与哈希（外部吸收：ARIS assurance-contract 的 `audited_input_hashes` + review-tracing 的溯源纪律）──
//   目的：判决可复核的关键是「**它当时吃的是哪些字节**」。稿子后来被改过？重算哈希就能标 STALE。
//   纪律：读不了就返回 null，**绝不编一个哈希**（编哈希比没有哈希更坏：它让 STALE 永远抓不到）。
function sha256OfFile(p) {
  try { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
  catch (e) { return null; }
}

/** 被门实际消费的输入 → { 角色: {path, hash} }。不存在的输入不进表（它本来就没被消费）。 */
function auditInputHashes(inputs) {
  const out = {};
  for (const [role, v] of Object.entries(inputs || {})) {
    if (typeof v !== 'string' || !v) continue;
    const h = sha256OfFile(v);
    if (h === null) continue;
    out[role] = { path: v, hash: h };
  }
  return out;
}

/** 聚合判决 → 短码（给人看、也给机检）。 */
function reasonCodeOf(cls) {
  if (cls.error) return 'has_error';
  if (cls.fail) return 'has_fail';
  if (cls.blocked) return 'has_blocked';
  if (cls.pass) return 'all_gates_pass';
  return 'no_gate_decided';
}

const ARTIFACT_SCHEMA = 'paper_studio_artifact.v1';
const ARTIFACT_REQUIRED = ['schema_version', 'audit_skill', 'task_type', 'tier', 'assurance', 'overall_assurance',
  'verdict', 'reason_code', 'summary', 'gates', 'audited_input_hashes', 'review_independence', 'acceptance_status', 'generated_at'];
const REVIEW_INDEPENDENCE = ['same-family', 'cross-family', 'deterministic'];

/* ★★ v3.2.30 根因：白名单缺 `{package}` ⇒ 模板值 `{package}` 被当**字面量**传给门（门收到一个不存在的路径），
   于是该门在"半残输入"下自带 FAIL。**占位符不在白名单里，等于这个输入永远传不进去。** */
const PLACEHOLDERS = ['{draft}', '{docx}', '{package}', '{anchors}', '{manifest}', '{contract}', '{declaration}', '{report}', '{phrase_bank}'];

function buildArgs(gate, inputs) {
  /* （v3.2.30 曾在此加"声明了却缺 ⇒ 早退为缺输入"，因波及既有夹具 10 条而撤回；
     根因改由**参数模板完整性**修复：占位符白名单 + 各门 args 声明。留此备注以免重犯。） */
  const missing = [];
  const out = [];
  const pushTpl = (tpl) => {
    for (const a of tpl) {
      const m = PLACEHOLDERS.find((ph) => a.includes(ph));
      if (!m) { out.push(a); continue; }
      const v = inputs[m.slice(1, -1)];
      if (!v || !fs.existsSync(v)) { missing.push(m); continue; }
      out.push(a.replace(m, v));
    }
  };
  pushTpl(gate.args || []);
  for (const opt of (gate.optional_args || [])) {
    const key = (opt.placeholder || '').slice(1, -1);
    const v = inputs[key];
    if (v && fs.existsSync(v)) pushTpl(opt.args || []);
  }
  return { argv: out, missing };
}

function interpreterFor(runtime, pipeline) {
  if (runtime === 'node') return process.execPath;
  if (runtime === 'python') {
    const list = ((pipeline.assets || {}).python_exe) || [];
    for (const p of list) if (fs.existsSync(p)) return p;
    return null; // 由调用方报「运行时不可用」
  }
  return null;
}

function runOneGate(gate, inputs, pipeline, opts) {
  const wantOut = !!(opts && opts.capture); // 只有 report 模式才带出正文（正常 --json 保持精简）
  const base = (pipeline.assets && pipeline.assets[gate.rel]) || '';
  const script = base ? path.join(base, gate.entry) : '';
  const rec = {
    id: gate.id,
    label: gate.label,
    scope: gate.scope || 'draft',
    script,
    argv: [],
    rc: null,
    stdout_len: 0,
    stdout_empty: null,
    stderr_head: '',
    verdict: '',
    note: '',
  };
  if (!script || !fs.existsSync(script)) {
    rec.verdict = 'precondition_fail';
    rec.note = '门脚本不存在' + hintIfLocal(script);
    return rec;
  }
  const exe = interpreterFor(gate.runtime, pipeline);
  if (!exe) {
    rec.verdict = 'precondition_fail';
    rec.note = `运行时不可用（${gate.runtime}）；已试 python_exe=${JSON.stringify((pipeline.assets || {}).python_exe || [])}${hintIfLocal(((pipeline.assets || {}).python_exe || [])[0])}`;
    return rec;
  }
  const built = buildArgs(gate, inputs);
  // 判据数据前置检查：门依赖的词库/映射文件缺了 ⇒ 前提层失败（**绝不因为是"空判据"就变绿**）
  const preMissing = [];
  for (const ph of (gate.precondition_files || [])) {
    const key = ph.slice(1, -1);
    const v = inputs[key];
    if (!v || !fs.existsSync(v)) preMissing.push(`${ph}${v ? '=' + v : '（未提供）'}`);
  }
  if (preMissing.length) {
    rec.argv = [exe, script, ...built.argv];
    rec.verdict = 'precondition_fail';
    rec.note = `判据数据缺失：${preMissing.join(', ')} ⇒ 前提层失败（不是"没问题"）`;
    return rec;
  }
  if (built.missing.length) {
    rec.verdict = 'skipped_missing_input';
    rec.note = `缺输入 ${[...new Set(built.missing)].join(', ')} ⇒ 跳过（不算通过）`;
    return rec;
  }
  rec.argv = [exe, script, ...built.argv];
  const r = spawnSync(exe, [script, ...built.argv], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  rec.rc = r.error ? -1 : r.status;
  const so = r.stdout || '';
  rec.stdout_len = so.length;
  rec.stdout_empty = so.trim().length === 0;
  if (wantOut) rec.stdout = so.slice(0, 200000);
  /* ★ v3.2.30：提醒计数**在运行时解析**（`rec.stdout` 只在 capture 模式保留 ⇒ 不能靠它读）。
     门用 `WARN_COUNT=<n>` 自报提醒；这样聚合层既能看见提醒（不遮 FAIL），也不需要改门的退出码语义。 */
  const wm = /WARN_COUNT=(\d+)/.exec(so);
  rec.warns = wm ? Number(wm[1]) : 0;
  rec.stderr_head = (r.stderr || '').split(/\r?\n/).slice(0, 3).join(' | ').slice(0, 300);
  if (r.error) { rec.verdict = 'precondition_fail'; rec.note = 'spawn 失败：' + r.error.code; return rec; }
  // ★ 2026-10-14：**门自报前提层** —— `report_args --json` 的输出里带 `precondition:true` 时，
  //   一律归前提层失败（不是断言失败）。由来：author-material 门在声明缺失/坏 JSON 时以 rc=2 +
  //   **非空 JSON** 输出，旧规则只看「stdout 是否为空」，于是把它读成"断言失败"，report 里出现
  //   「失败 1」却同时打印「无待修项：全部门通过」的自相矛盾 —— 同类事故：假绿/假红都属"判定器骗自己"。
  const selfPre = (() => {
    const t = so.trim();
    if (!t.startsWith('{')) return null;
    try { const j = JSON.parse(t); return (j && j.precondition === true) ? j : null; } catch { return null; }
  })();
  if (selfPre) {
    rec.verdict = 'precondition_fail';
    rec.note = `门自报前提层失败（rc=${r.status}）：${selfPre.summary || '环境/输入不成立'}`;
    return rec;
  }
  if (r.status !== 0 && rec.stdout_empty) {
    rec.verdict = 'precondition_fail';
    rec.note = 'rc≠0 且 stdout 为空 ⇒ 前提层失败（不是"结果为空"）';
    return rec;
  }
  /* ★★ v3.2.30 更正（撤回 v3.2.29 的映射）：门的退出码语义是 **0＝通过 / 1＝存在 FAIL / 2＝参数或文件错误**（见各门 exit_codes
     与该门头部注释）。把 rc=1 读成"提醒"会**把真 FAIL 伪装成提醒**——上一轮就是这么遮住了一个真阻断（根因是参数没传全）。
     提醒改由门自己输出的 `WARN_COUNT=<n>` 承载（见 printTable 与 summarize）。 */
  rec.verdict = r.status === 0 ? 'pass' : (r.status === 2 && rec.stdout_empty ? 'precondition_fail' : 'fail');
  /* （提醒计数改在 runOneGate 里由运行时输出解析 —— `rec.stdout` 只在 capture 模式保留，此处读不到。） */
  rec.note = r.status === 0 ? '通过' + (rec.warns ? `（含 ${rec.warns} 条提醒）` : '') : `退出码 ${r.status}（见 exit_codes 释义）`;
  if (r.status === 0 && String(rec.stdout || '').length > 0 && /FAIL_COUNT=(\d+)/.test(String(rec.stdout || ''))) {
    const fm = /FAIL_COUNT=(\d+)/.exec(String(rec.stdout || ''));
    if (fm && Number(fm[1]) > 0 && r.status === 0) rec.note += '（★ 门自报 FAIL_COUNT>0 却退 0 ⇒ 口径不一致，须查门）';
  }
  return rec;
}

/** 判定类别（V2.6 · 吸收 ARIS assurance-contract）：把 verdict 映射到 6 态类别中的一类。 */
function verdictClassOf(verdict, pipeline) {
  const vt = ((pipeline || {}).gate_meta || {}).verdict_taxonomy || {};
  const hit = (vt.classes || {})[verdict] || (vt.reserved || {})[verdict];
  return hit ? hit.class : null;                      // 未登记的 verdict 返回 null（自检会抓）
}

/** 该判定在给定保证级别下是否阻断投稿（V2.6）：blocked/error/fail 在 submission 下阻断；draft 下只有 fail/error。 */
function blocksSubmission(verdict, assurance, pipeline) {
  const vt = ((pipeline || {}).gate_meta || {}).verdict_taxonomy || {};
  const hit = (vt.classes || {})[verdict] || (vt.reserved || {})[verdict];
  if (!hit) return false;
  if (!hit.submit_blocking) return false;
  if (assurance === 'submission') return true;
  return verdict === 'fail' || verdict === 'precondition_fail';   // draft：只有这两类阻断（向后兼容）
}

/** 保证级别：显式 > 按档位推导 > draft（ARIS 的 precedence 纪律）。 */
function assuranceOf(tier, override, pipeline) {
  if (override) return override;
  const m = ((((pipeline || {}).gate_meta || {}).verdict_taxonomy || {}).assurance || {}).derive_from_tier || {};
  return m[tier] || 'draft';
}

/**
 * 范围声明（V2.10 · 吸收 ARIS experiment-integrity 的「范围不足」反模式）：
 * 原文把「拿 2 个场景的试点说成 comprehensive evaluation / robust / extensive」列为**禁用模式** ⇒
 * 报告的读数**必须自带范围**，否则"通过 8 门"会被读成"全面评估"。
 */
function scopeStatement(results, inputs) {
  const n = (results || []).length;
  const consumed = Object.keys(inputs || {}).filter((k) => typeof inputs[k] === 'string' && inputs[k]);
  const decided = (results || []).filter((g) => g.verdict === 'pass' || g.verdict === 'fail').length;
  return `【范围】本次只覆盖 **${n} 道门**（实际判定 ${decided} · 输入 ${consumed.length} 项：${consumed.join('/') || '无'}）—— **这不是全面评估**；`
    + `范围外的方面未被检验，**不得用本次结果主张 comprehensive / robust / extensive**。`;
}

/**
 * 按龄期警告（V2.13 · 吸收 ARIS output-versioning 的 stale state detection）：
 * 状态/工件超过阈值（默认 24h）时提示「**它可能来自上一个研究方向**」——我的哈希式 STALE 判断「输入的字节变没变」，
 * 这一条补的是「**这份结论还是不是当前这条线**」。
 */
function ageWarning(generatedAt, nowMs, thresholdHours) {
  const th = thresholdHours || 24;
  if (!generatedAt) return null;
  const t = Date.parse(generatedAt);
  if (!Number.isFinite(t)) return null;
  const hours = (nowMs - t) / 3600000;
  if (hours < th) return null;
  return `⚠ 这份工件生成于 ${hours.toFixed(1)} 小时前（>${th}h）—— **它可能来自上一个研究方向**；继续用它之前请确认方向是否已变。`;
}

function summarize(gateResults, assurance, pipeline) {
  const hasPre = gateResults.some((g) => g.verdict === 'precondition_fail');
  const hasFail = gateResults.some((g) => g.verdict === 'fail');
  const hasGap = gateResults.some((g) => g.verdict === 'skipped_missing_input');
  const hasPass = gateResults.some((g) => g.verdict === 'pass');
  const hasNA = gateResults.some((g) => g.verdict === 'skipped_not_applicable');
  const hasWarn = gateResults.some((g) => (g.warns || 0) > 0);   /* v3.2.30：提醒由 WARN_COUNT 承载，不再是 verdict */
  if (hasPre) return 2;
  if (hasFail) return 2;
  // ★ V2.6：blocked（缺输入）在 submission 下与 fail 同权 —— 「应该有却没有」必须阻断，
  //   否则「体裁判错 / 前提没给 ⇒ 门全跳过 ⇒ 退出码 0」就是一条静默假绿通道。
  if (hasGap && blocksSubmission('skipped_missing_input', assurance || 'draft', pipeline)) return 2;
  if (hasGap) return 1;
  /* ★ v3.2.29：**有提醒必须给 1**（不能读成"全绿"）；warn 不阻断（submit_blocking:false ⇒ 作者定夺）。 */
  if (hasWarn) return 1;
  // ★ V1.5：**全不适用 ≠ 全通过**。一个门都没实际判定时给 1（需人工确认体裁是否判错），
  //   否则「体裁判错 ⇒ 所有门都不适用 ⇒ 退出码 0」会变成一条静默的假绿通道。
  if (hasNA && !hasPass) return 1;
  return 0;
}

/** 体裁适用性（V1.5 模型层）：门未声明 applies_to 时用真源缺省 `*`（全体裁适用）。 */
function applicableTo(gate, genreId, pipeline) {
  const def = ((pipeline || {}).gate_meta || {}).applies_to_default || ['*'];
  const at = Array.isArray(gate.applies_to) ? gate.applies_to : def;
  return at.includes('*') || at.includes(genreId);
}

function genreOfDraft(inputs, pipeline, override) {
  if (override) return studio.detectGenre('', pipeline, override);
  if (inputs && inputs.draft && fs.existsSync(inputs.draft)) {
    return studio.detectGenre(fs.readFileSync(inputs.draft, 'utf8'), pipeline, null);
  }
  const d = ((pipeline || {}).genres || {}).default || 'empirical';
  const k = ((((pipeline || {}).genres || {}).kinds) || []).find((x) => x.id === d) || { id: d, label: d };
  return { id: k.id, label: k.label, hits: [], score: 0, reason: '未给源稿 ⇒ 用真源默认体裁' };
}

/** 按体裁跑门：**不适用就不 spawn**（不适用 ≠ 通过 ≠ 失败，单列一个判定）。返回 {genre, results}。 */
function runGates(gates, inputs, pipeline, opts) {
  const o = opts || {};
  const genre = o.genre || genreOfDraft(inputs, pipeline, o.genreOverride);
  const results = [];
  for (const gt of gates) {
    if (!applicableTo(gt, genre.id, pipeline)) {
      results.push({
        id: gt.id, label: gt.label, rc: null, verdict: 'skipped_not_applicable', stdout_empty: null, stdout: '',
        note: `体裁不适用：本门只适用于 [${(gt.applies_to || []).join('/')}]，本稿体裁=${genre.id}`,
      });
      continue;
    }
    const rec = runOneGate(gt, inputs, pipeline, o.capture ? { capture: true } : undefined);
    results.push(rec);
  }
  return { genre, results };
}

function printTable(gateResults, pipeline) {
  console.log('门执行结果（真源：references/pipeline.json）：');
  for (const g of gateResults) {
    const flag = { pass: '通过', fail: '失败', skipped_missing_input: '跳过(缺输入)', skipped_not_applicable: '不适用(体裁)', precondition_fail: '前提层失败' }[g.verdict] || g.verdict;
    const ec = ((pipeline.gates || []).find((x) => x.id === g.id) || {}).exit_codes || {};
    const meaning = (g.verdict === 'pass' || g.verdict === 'fail' || g.verdict === 'warn') && g.rc !== null && ec[String(g.rc)] ? ' · ' + ec[String(g.rc)] : '';
    console.log(`  [${flag}] ${g.id}：${g.label}`);
    console.log(`        rc=${g.rc} · stdout=${g.stdout_len}B${g.stdout_empty ? '（空）' : ''} · ${g.note}${meaning}${g.warns ? ' · **提醒 ' + g.warns + ' 条**（WARN_COUNT，不阻断）' : ''}`);
    if (g.stderr_head) console.log(`        stderr: ${g.stderr_head}`);
  }
  const counts = gateResults.reduce((a, g) => (a[g.verdict] = (a[g.verdict] || 0) + 1, a), {});
  console.log(`\n合计 ${gateResults.length} 门：` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' · '));
  console.log('判据：任一 precondition_fail 或 fail ⇒ 退出码 2；**有提醒（门自报 WARN_COUNT>0）或 skipped_missing_input ⇒ 1**（提醒不阻断；缺输入在 `--assurance submission` 下 ⇒ 2）。');
  console.log('      skipped_not_applicable（体裁不适用）不参与判定，但**全不适用 ⇒ 1** —— 不许读成「全通过」。');
}

// ── 自检（严格：夹具必须返回 true 才算通过；失败返回字符串即失败并附原因）──
function runSelftest() {
  const results = [];
  const check = (name, fn) => {
    try {
      const r = fn();
      const ok = r === true;
      results.push({ name, ok, detail: ok ? '' : (typeof r === 'string' ? r : `返回了 ${typeof r}，必须返回 true`) });
    } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
  };
  const pipeline = studio.readPipeline();
  const fx = (n) => path.join(ROOT, 'bin', 'fixtures', n);

  const fakePipeline = (gates) => ({ assets: { playbook_root: path.join(ROOT, 'bin', 'fixtures') }, gates, task_types: [{ id: 'x', gates: gates.map((g) => g.id) }] });
  const g = (id, entry, runtime = 'node', extra = {}) => Object.assign({ id, label: id, runtime, entry, rel: 'playbook_root', args: [] }, extra);

  check('真源可读（复用 studio 的读取器，无第二份实现）', () => (pipeline.gates.length > 0 ? true : '没有 gates'));

  check('夹具：退出码 0 且打印 ⇒ verdict=pass', () => {
    const p = fakePipeline([g('ok', 'fx-exit0.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    return r.verdict === 'pass' ? true : `verdict=${r.verdict} note=${r.note}`;
  });

  check('必失败夹具：rc≠0 且 stdout 为空 ⇒ precondition_fail（不得读成"结果为空"）', () => {
    const p = fakePipeline([g('silent', 'fx-exit2-silent.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    return (r.verdict === 'precondition_fail' && r.rc === 2 && r.stdout_empty === true) ? true : `verdict=${r.verdict} rc=${r.rc} empty=${r.stdout_empty}`;
  });

  check('夹具：rc≠0 但有输出 ⇒ verdict=fail（不是前提层失败）', () => {
    const p = fakePipeline([g('noisy', 'fx-exit2-noisy.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    return r.verdict === 'fail' ? true : `verdict=${r.verdict} rc=${r.rc} empty=${r.stdout_empty}`;
  });

  // ★ 2026-10-14 新增：**门自报前提层**必须与「有输出 ⇒ fail」区分开。
  //   顺序也要对：先看自报前提层，再看 stdout 是否为空，最后才判 fail。
  check('必失败夹具：门自报前提层（JSON precondition:true 且 rc=2）⇒ precondition_fail（不得读成断言失败）', () => {
    const p = fakePipeline([g('selfpre', 'fx-exit2-selfpre.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    return (r.verdict === 'precondition_fail' && r.rc === 2 && r.stdout_empty === false) ? true : `verdict=${r.verdict} rc=${r.rc} empty=${r.stdout_empty}`;
  });

  check('必失败夹具：缺输入 ⇒ skipped_missing_input（绝不算通过）', () => {
    const p = fakePipeline([g('need', 'fx-exit0.cjs', 'node', { args: ['--draft', '{draft}'], required_placeholders: ['{draft}'] })]);
    const r = runOneGate(p.gates[0], {}, p);
    return (r.verdict === 'skipped_missing_input' && r.rc === null) ? true : `verdict=${r.verdict} rc=${r.rc}`;
  });

  check('必失败夹具：门脚本不存在 ⇒ precondition_fail', () => {
    const p = fakePipeline([g('gone', '__no_such_gate__.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    return r.verdict === 'precondition_fail' ? true : `verdict=${r.verdict}`;
  });

  check('占位符替换：给了存在的文件才注入（不存在不注入且判缺输入）', () => {
    const p = fakePipeline([g('ph', 'fx-exit0.cjs', 'node', { args: ['--draft', '{draft}'] })]);
    const withFile = runOneGate(p.gates[0], { draft: fx('fx-exit0.cjs') }, p);
    const withBad = runOneGate(p.gates[0], { draft: fx('__nope__.md') }, p);
    return (withFile.verdict === 'pass' && withBad.verdict === 'skipped_missing_input') ? true : `withFile=${withFile.verdict} withBad=${withBad.verdict}`;
  });

  // ★ V1.5 四条：体裁适用性模型（不适用 ≠ 通过 ≠ 失败，且不许静默假绿）
  check('体裁不适用 ⇒ skipped_not_applicable 且不 spawn（rc 为 null）', () => {
    const p = { assets: { playbook_root: path.join(ROOT, 'bin', 'fixtures') },
                gate_meta: { applies_to_default: ['*'] },
                gates: [{ id: 'rv', label: 'rv', runtime: 'node', entry: 'fx-exit0.cjs', rel: 'playbook_root', args: [], applies_to: ['review'] }] };
    const out = runGates(p.gates, {}, p, { genre: { id: 'empirical', label: 'e' } });
    const r = out.results[0];
    return (r.verdict === 'skipped_not_applicable' && r.rc === null) ? true : `verdict=${r.verdict} rc=${r.rc}`;
  });
  check('★契约声明 vs 门执行：每个 `limits.*` 键要么被门真的引用，要么在 informational 白名单里登记了原因（防"声明了却没人执行"）', () => {
    const P = studio.readPipeline();
    const info = ((P.contract_limits || {}).informational) || {};
    const gaps = ((P.contract_limits || {}).known_gaps) || {};
    const dir = path.join(ROOT, 'references', 'contracts');
    if (!fs.existsSync(dir)) return true;
    const cands = [];
    try { const r = resolveGateScript({ id: 'journal-contract', entry: '_journal-contract.cjs' }, P); if (r && r.script) cands.push(r.script); } catch (e) {}
    if (P.assets && P.assets.playbook_root) cands.push(path.join(P.assets.playbook_root, '_journal-contract.cjs'));
    let gateSrc = '';
    for (const c of cands) { if (c && fs.existsSync(c)) { gateSrc = fs.readFileSync(c, 'utf8'); break; } }
    if (!gateSrc) return true;   // 门脚本不可得 ⇒ 本锁跳过（不假装通过）
    const bad = []; const known = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let c = null; try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      const lim = c.limits || {};
      const keys = [];
      for (const k of Object.keys(lim)) {
        if (lim[k] && typeof lim[k] === 'object' && !Array.isArray(lim[k])) { for (const sub of Object.keys(lim[k])) keys.push(k + '.' + sub); }
        else keys.push(k);
      }
      for (const key of keys) {
        const leaf = key.split('.').pop();
        /* ★ null/undefined 的限额＝「未设限额」，不是「声明了没执行」 ⇒ 跳过。 */
        const raw = (key.indexOf('.') >= 0) ? ((lim[key.split('.')[0]] || {})[key.split('.').pop()]) : lim[key];
        if (raw === null || raw === undefined) continue;
        const cited = new RegExp('\\b' + leaf + '\\b').test(gateSrc);
        if (cited) continue;
        if (Object.prototype.hasOwnProperty.call(info, leaf)) continue;
        if (Object.prototype.hasOwnProperty.call(gaps, leaf)) { known.push(f + ':' + key); continue; }
        bad.push(f + ':' + key);
      }
    }
    if (bad.length) return '声明了却没有门引用、也不在台账里：' + bad.join(' · ');
    /* 已知缺口不判失败，但**必须可见**（不得静默）。 */
    if (known.length) console.log('    （已知未实现，已登记在 pipeline.json.contract_limits.known_gaps：' + known.join(' · ') + '）');
    return true;
  });
  check('★包卫生·行为对拍：同一脏包，compliance 与契约门 package_hygiene 必须点名**同一批**违规文件', () => {
    const { spawnSync } = require('node:child_process');
    const os2 = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'hyg-'));
    const pkg = path.join(tmp, 'pkg'); fs.mkdirSync(pkg);
    const w = (n, t2) => fs.writeFileSync(path.join(pkg, n), t2 || 'x');
    w('manuscript.md', '# T\n\n## Abstract\n\nBody text.\n');
    w('Cover-Letter.docx');
    w('_契约检查报告-JoES.md');
    w('Highlights-stale-20261015.docx');
    const P = studio.readPipeline();
    const gd = (P.gates || []).find((x) => x.id === 'journal-contract');
    let gate = '';
    try { const r2 = gd ? resolveGateScript(gd, P) : null; if (r2 && r2.script) gate = r2.script; } catch (e) {}
    if (!gate && P.assets && P.assets.playbook_root) gate = path.join(P.assets.playbook_root, '_journal-contract.cjs');
    if (!fs.existsSync(gate)) return '门脚本不可得 ⇒ 本锁跳过（不假装通过）';
    const c = path.join(tmp, 'c.json');
    fs.writeFileSync(c, JSON.stringify({ journal: 'J', article_type: 'review', verified_at: '2026-01-01', verified_from: 'selftest', structure: { package_hygiene: {} }, limits: { abstract_max_words: 500 } }));
    const out1 = String(spawnSync(process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'compliance', pkg, '--json'], { encoding: 'utf8' }).stdout);
    const out2 = String(spawnSync(process.execPath, [gate, '--draft', path.join(pkg, 'manuscript.md'), '--package', pkg, '--contract', c], { encoding: 'utf8' }).stdout);
    const dirty = ['_契约检查报告-JoES.md', 'Highlights-stale-20261015.docx'];
    const clean = 'manuscript.md';
    const bad = [];
    for (const f of dirty) {
      const inMine = out1.indexOf(f) >= 0; const inGate = out2.indexOf(f) >= 0;
      if (!inMine || !inGate) bad.push(f + '(我方=' + inMine + ' 门=' + inGate + ')');
    }
    if (out1.indexOf(clean) >= 0 && /offenders/.test(out1)) { /* manuscript 作为**违规**出现才算错 */
      const m = out1.match(/package_hygiene[\s\S]{0,400}/);
      if (m && m[0].indexOf('manuscript.md') >= 0) bad.push('把干净文件 manuscript.md 误列进违规');
    }
    return bad.length === 0 ? true : ('两边不同判：' + bad.join(' · '));
  });
  check('★ 静态锁：门参数模板里的占位符必须都在执行器白名单里（否则该输入**永远传不进去**）', () => {
    const P = studio.readPipeline();
    const bad = [];
    for (const gt of (P.gates || [])) {
      const tmpl = (gt.args || []).concat((gt.optional_args || []).flatMap((o) => o.args || []));
      for (const a of tmpl) {
        const h = /\{[a-z_]+\}/g; let m;
        while ((m = h.exec(a)) !== null) if (!PLACEHOLDERS.includes(m[0])) bad.push(gt.id + ':' + m[0]);
      }
    }
    return bad.length === 0 ? true : '模板里有白名单外的占位符：' + bad.join(', ');
  });
  check('★ 静态锁：已知需要输入的门必须声明它的输入（本条由 v3.2.30 的「输入没传到门」事故换来）', () => {
    const P = studio.readPipeline();
    const need = { 'journal-contract': '--package', 'compliance-scan': '--package', 'claim-anchor': '--anchors' };
    const bad = [];
    for (const [id, flag] of Object.entries(need)) {
      const gt = (P.gates || []).find((x) => x.id === id);
      if (!gt) { bad.push(id + ':门不存在'); continue; }
      if (!(gt.args || []).includes(flag)) bad.push(id + ' 未声明 ' + flag);
    }
    return bad.length === 0 ? true : bad.join(' · ');
  });
  check('★ 输入路由：参数模板里的 {package} 必须真的传给门（"被 CLI 接受" ≠ "传给了门"）', () => {
    const p = fakePipeline([g('echo', 'fx-echo-args.cjs', 'node', { args: ['--package', '{package}'] })]);
    /* 必须给**真实存在**的路径：buildArgs 对不存在的值按"缺输入"丢弃（这正是 `{package}` 曾被静默丢掉的机制）。 */
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pkg-route-'));   // 本模块没引 os ⇒ 内联 require
    const r = runOneGate(p.gates[0], { package: dir }, p);
    /* 断言读 argv（`rec.stdout` 只在 capture 模式保留，非 capture 时是 undefined —— 首版断言盯错了字段）。 */
    const argv = JSON.stringify(r.argv || []);
    return /--package/.test(argv) && argv.indexOf('pkg-route-') >= 0 ? true : '门收到的参数里没有 --package：' + argv.slice(0, 200);
  });
  check('★ 提醒通道：rc=0 + WARN_COUNT=2 ⇒ verdict=pass 且 warns=2（提醒可见、不阻断）', () => {
    const p = fakePipeline([g('warny', 'fx-warn.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    return (r.verdict === 'pass' && r.warns === 2) ? true : `verdict=${r.verdict} warns=${r.warns}`;
  });
  check('★ 反遮丑：rc=1 + WARN_COUNT=1 ⇒ 必须判 fail（提醒绝不遮住 FAIL）', () => {
    const p = fakePipeline([g('wf', 'fx-warn-but-fail.cjs')]);
    const r = runOneGate(p.gates[0], {}, p);
    const s = summarize([r], 'draft', pipeline);
    return (r.verdict === 'fail' && s === 2) ? true : `verdict=${r.verdict} 汇总=${s}`;
  });
  check('★ 汇总：只有提醒 ⇒ 退出码 1；无提醒全过 ⇒ 0', () => {
    const a = summarize([{ verdict: 'pass', warns: 2 }], 'draft', pipeline);
    const b = summarize([{ verdict: 'pass', warns: 0 }], 'draft', pipeline);
    return (a === 1 && b === 0) ? true : `有提醒=${a}（应 1）· 无提醒=${b}（应 0）`;
  });
  check('必失败：全不适用 ⇒ 退出码 1（不许把「全不适用」读成「全通过」）', () => {
    const s = summarize([{ verdict: 'skipped_not_applicable' }]);
    return s === 1 ? true : `summarize 给了 ${s}（0 就是静默假绿通道）`;
  });
  check('分形：缺输入跳过 ≠ 体裁不适用（两者不得合并计数）', () => {
    const s = summarize([{ verdict: 'skipped_missing_input' }, { verdict: 'skipped_not_applicable' }]);
    const both = ['skipped_missing_input', 'skipped_not_applicable'];
    return (s === 1 && new Set(both).size === 2) ? true : `summarize=${s}`;
  });

  check('退出码汇总：有 precondition_fail ⇒ 2；仅 skipped ⇒ 1；全 pass ⇒ 0', () => {
    const a = summarize([{ verdict: 'pass' }]); const b = summarize([{ verdict: 'skipped_missing_input' }]); const c = summarize([{ verdict: 'precondition_fail' }]);
    return (a === 0 && b === 1 && c === 2) ? true : `pass=${a} skip=${b} pre=${c}`;
  });

  // ★ V2.6 六条（外部吸收：ARIS assurance-contract.md）—— 判定状态机 + 保证级别轴
  check('判定类别：执行器会产出的 5 个 verdict 全部有类别映射（漏一个就报错，绝不默认成无害）', () => {
    const set = ['pass', 'warn', 'fail', 'skipped_missing_input', 'skipped_not_applicable', 'precondition_fail'];
    const bad = set.filter((v) => !verdictClassOf(v, pipeline));
    return bad.length === 0 ? true : `未映射：${bad.join(', ')}`;
  });
  check('判定类别 · 反向控制：未登记的 verdict 必须返回 null（不许悄悄算作 pass）', () => (
    verdictClassOf('no-such-verdict-xyz', pipeline) === null ? true : '未登记判定被映射成了非 null'
  ));
  check('★ 保证级别：缺输入在 submission 下**必须阻断**（退出码 2），draft 下仍是 1（向后兼容）', () => {
    const r = [{ verdict: 'skipped_missing_input' }];
    const a = summarize(r, 'draft', pipeline); const b = summarize(r, 'submission', pipeline);
    return (a === 1 && b === 2) ? true : `draft=${a}（应 1）· submission=${b}（应 2）`;
  });
  check('★ 保证级别：不适用（体裁）在任何级别都不阻断；全不适用仍为 1（不算通过）', () => {
    const na = summarize([{ verdict: 'skipped_not_applicable' }], 'submission', pipeline);
    return na === 1 ? true : `退出码=${na}（应 1：全不适用需人工确认体裁）`;
  });
  check('保证级别：fail / error 在 draft 下本来就阻断（回归，不许被新轴削弱）', () => {
    const f = summarize([{ verdict: 'fail' }], 'draft', pipeline);
    const e = summarize([{ verdict: 'precondition_fail' }], 'draft', pipeline);
    return (f === 2 && e === 2) ? true : `fail=${f} · error=${e}（都应 2）`;
  });
  check('保证级别：显式 override > 按档位推导 > draft（ARIS precedence 纪律）', () => {
    const a = assuranceOf('T2', null, pipeline);       // T2 ⇒ submission
    const b = assuranceOf('T2', 'draft', pipeline);    // 显式压回 draft
    const c = assuranceOf('T1', null, pipeline);       // T1 ⇒ draft
    return (a === 'submission' && b === 'draft' && c === 'draft') ? true : `T2默认=${a} · T2显式draft=${b} · T1默认=${c}`;
  });

  // ★ V2.7 五条（外部吸收：ARIS `audited_input_hashes` + STALE 验证器 + review-tracing 溯源纪律）
  //    造工件的公共夹具：临时目录 + 一份输入 + 一份工件（schema 与 emit 一致）。
  const mkArtifactFixture = () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-art-'));
    const input = path.join(dir, 'draft.md');
    fs.writeFileSync(input, 'v1\n', 'utf8');
    const art = {
      schema_version: ARTIFACT_SCHEMA, audit_skill: 'paper-studio/gate-runner', task_type: 'check', tier: 'T1',
      assurance: 'draft', overall_assurance: 'accepted', verdict: 'PASS', reason_code: 'all_gates_pass', summary: '门 1：pass=1',
      gates: [{ id: 'g', judge_type: 'A', verdict: 'pass', class: 'pass', rc: 0 }],
      audited_input_hashes: { draft: { path: input, hash: sha256OfFile(input) } },
      review_independence: 'deterministic', acceptance_status: 'accepted', generated_at: new Date().toISOString(),
    };
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, JSON.stringify(art), 'utf8');
    return { dir, input, art, file };
  };
  const quiet = (fn) => {                                          // 复核会打印人读报告，自检里静音
    const orig = console.log; console.log = () => {};
    try { return fn(); } finally { console.log = orig; }
  };

  check('★ 工件：改过输入 ⇒ STALE(1)；未改 ⇒ FRESH(0)（本机制的正向控制）', () => {
    const fx = mkArtifactFixture();
    const fresh = quiet(() => artifactMain(['--artifact', fx.file]));
    fs.writeFileSync(fx.input, 'v2 改了数字\n', 'utf8');
    const stale = quiet(() => artifactMain(['--artifact', fx.file]));
    return (fresh === 0 && stale === 1) ? true : `未改=${fresh}（应 0）· 改后=${stale}（应 1）`;
  });
  check('★ 工件 · 反向控制：输入没变时连查两次都必须 FRESH（不得误报 STALE）', () => {
    const fx = mkArtifactFixture();
    const a = quiet(() => artifactMain(['--artifact', fx.file]));
    const b = quiet(() => artifactMain(['--artifact', fx.file]));
    return (a === 0 && b === 0) ? true : `第一次=${a} · 第二次=${b}（都应 0）`;
  });
  check('★ 工件 · 必失败：输入文件被删 ⇒ STALE(1)（读不到不得静默通过）', () => {
    const fx = mkArtifactFixture();
    fs.unlinkSync(fx.input);
    const r = quiet(() => artifactMain(['--artifact', fx.file]));
    return r === 1 ? true : `退出码=${r}（应 1）`;
  });
  check('★ 工件 · 必失败：deterministic 标签 + B 类（质量裁决）门 ⇒ INVALID(1)（语义判决不得由确定性检查代签）', () => {
    const fx = mkArtifactFixture();
    fx.art.gates = [{ id: 'g', judge_type: 'B', verdict: 'pass', class: 'pass', rc: 0 }];
    fs.writeFileSync(fx.file, JSON.stringify(fx.art), 'utf8');
    const r = quiet(() => artifactMain(['--artifact', fx.file]));
    return r === 1 ? true : `退出码=${r}（应 1）`;
  });
  check('★ 工件 · 必失败：缺必备字段 ⇒ INVALID(1)', () => {
    const fx = mkArtifactFixture();
    delete fx.art.audited_input_hashes;
    fs.writeFileSync(fx.file, JSON.stringify(fx.art), 'utf8');
    const r = quiet(() => artifactMain(['--artifact', fx.file]));
    return r === 1 ? true : `退出码=${r}（应 1）`;
  });

  check('真源的门都带 args 模板（防止 runner 硬编码参数）', () => {
    const bad = (pipeline.gates || []).filter((x) => !Array.isArray(x.args)).map((x) => x.id);
    return bad.length === 0 ? true : `缺 args：${bad.join(', ')}`;
  });

  check('真源的 check 链路引用的门 id 都存在', () => {
    const known = new Set((pipeline.gates || []).map((x) => x.id));
    const bad = [];
    for (const t of pipeline.task_types) for (const gid of (t.gates || [])) if (!known.has(gid)) bad.push(`${t.id}:${gid}`);
    return bad.length === 0 ? true : `悬空门 id：${bad.join(', ')}`;
  });

  check('report 解析：claim-anchor 形状的 JSON ⇒ 抽出带行号的项', () => {
    const sample = JSON.stringify({ HIGH: [{ id: 'HIGH-1', stage: 'fabricated-reference', line: 34, why: 'x', key: '1', text: 't' }], LOW: [] });
    const f = parseFindings({ id: 'claim-anchor' }, sample);
    return (f.length === 1 && f[0].line === 34 && f[0].rule === 'fabricated-reference') ? true : JSON.stringify(f);
  });

  check('report 解析：同一条目重复出现 ⇒ 去重计次（8 个引用键不得报成 8 项）', () => {
    const arr = [1, 2, 3].map((k) => ({ line: 34, stage: 's', why: 'w', text: 't', key: String(k) }));
    const d = dedupe(parseFindings({ id: 'g' }, JSON.stringify({ HIGH: arr })));
    return (d.length === 1 && d[0].count === 3 && d[0].keys.length === 3) ? true : JSON.stringify(d);
  });

  // ★ 2026-10-14 新增两条：**字段级判据（没有行号）必须被解析出来**，且不得凭空抓普通 JSON。
  check('report 解析：字段级判据（line:null + rule/why）必须被解析出来，行号如实记 null', () => {
    const sample = JSON.stringify({ gate: 'author-material', ok: false, count: 1, findings: [{ line: null, rule: 'author-material', why: '声明路径不存在', text: 'material_path_or_note' }] });
    const f = parseFindings({ id: 'author-material' }, sample);
    return (f.length === 1 && f[0].line === null && f[0].why === '声明路径不存在') ? true : JSON.stringify(f);
  });

  // 反向控制：普通 JSON（没有 line 键、也没有 why/rule）**不得**被当成发现 —— 否则 report 会凭空空报。
  // ★ V2.2：说明/豁免桶不许被当成待修项（否则「结果」节会冒出上百条假待修项）
  check('report 解析反向控制：INFO / HUMAN_VERIFIED / NEEDS_READ / soft / notes 不得被当成待修项，且必须报出跳过条数', () => {
    const fake = JSON.stringify({
      findings: [{ line: 7, why: '真的问题' }],
      INFO: [{ line: 3, why: '不判为无引用断言' }, { line: 4, why: '同义句' }],
      HUMAN_VERIFIED: [{ line: 5, why: '已人读' }],
      soft: [{ line: 6, why: '只是软提示' }],
      counts: { high: 1, low: 0 },
      verdict: 'P0',
    });
    const got = parseFindings({ id: 'fake' }, fake);
    const lines = got.map((g) => g.line);
    const ok1 = lines.length === 1 && lines[0] === 7;
    const ok2 = got.skippedContext >= 3;
    return (ok1 && ok2) ? true : `待修项=${JSON.stringify(lines)}（应只有 7）· skippedContext=${got.skippedContext}（应 ≥3）`;
  });

  check('report 解析反向控制：普通 JSON 不得被凭空当成待修项', () => {
    const f = parseFindings({ id: 'x' }, JSON.stringify({ a: 1, b: { c: 2, d: 'hello' }, arr: [1, 2, 3] }));
    return f.length === 0 ? true : JSON.stringify(f);
  });

  check('report 解析：文本型输出取行号，取不到必须标 null（不猜行号）', () => {
    const f = parseFindings({ id: 'phrase' }, '第 12 行：过于绝对\n另一条没有行号');
    return (f.length === 2 && f[0].line === 12 && f[1].line === null) ? true : JSON.stringify(f);
  });

  // ★ V2.8 两条（外部吸收：ARIS citation-discipline.md §Output Discipline，其出处 Anthropic Claude Science，Apache-2.0）
  check('★ 输出纪律：正文里的"已核验"式安慰语必须被抓 —— 过程叙述不是内容', () => {
    const bad = ['All DOIs verified', 'no retraction flags', 'bibliography checked', '引用已核验', 'DOI 全部有效'];
    const misses = bad.filter((t) => !hasReassuranceProse(t));
    return misses.length === 0 ? true : `漏抓：${misses.join(' / ')}`;
  });
  check('★ 输出纪律 · 反向控制：真实读数不得被误判成安慰语', () => {
    const ok = ['门统计：通过 8 · 失败 0 · 跳过(缺输入) 1', '全绿只证明该做的检查都做了，不等于稿子质量通过', '输入哈希 3 项'];
    const fps = ok.filter((t) => hasReassuranceProse(t));
    return fps.length === 0 ? true : `误报：${fps.join(' / ')}`;
  });

  // ★ V2.10 范围声明（吸收 ARIS experiment-integrity 的「范围不足」反模式）
  check('★ 范围声明：必须报出「覆盖几道门 / 实际判定几道 / 哪些输入」并显式声明这不是全面评估', () => {
    const s = scopeStatement([{ verdict: 'pass' }, { verdict: 'skipped_not_applicable' }], { draft: 'a.md', docx: 'b.docx' });
    const ok = /只覆盖\s*\*\*2\s*道门\*\*/.test(s) && /实际判定 1/.test(s) && /draft\/docx/.test(s) && /这不是全面评估/.test(s);
    return ok ? true : s;
  });
  check('★ 范围声明 · 反向控制：不得出现**肯定式**越界表述（"本次是全面评估/comprehensive evaluation"）', () => {
    const s = scopeStatement([{ verdict: 'pass' }], { draft: 'a.md' });
    // 首版反向控制写错：它在禁止句「不得主张 comprehensive」里也命中 ⇒ 夹具自己错了。改为只查**肯定式**。
    const asserts = /(本次|该次|此份)[^\n]{0,10}(是|为)[^\n]{0,6}(全面评估|comprehensive)|comprehensive\s+(evaluation|assessment)/i.test(s);
    const hasProhibition = /不得/.test(s);
    return (!asserts && hasProhibition) ? true : `asserts=${asserts} prohibition=${hasProhibition} :: ${s}`;
  });

  // ★ V2.13：按龄期警告（吸收 output-versioning 的 stale state detection）
  check('★ 按龄期警告：超 24h 的工件必须提示「可能来自上一个研究方向」（哈希 STALE 补不了这一条）', () => {
    const w = ageWarning(new Date(Date.now() - 30 * 3600000).toISOString(), Date.now());
    return (w && /上一个研究方向/.test(w)) ? true : String(w);
  });
  check('★ 反控 · 新鲜工件（或没有 generated_at）不得报警', () => {
    const a = ageWarning(new Date(Date.now() - 3600000).toISOString(), Date.now());
    const b = ageWarning(null, Date.now());
    const c = ageWarning('not-a-date', Date.now());
    return (!a && !b && !c) ? true : JSON.stringify({ a, b, c });
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\ngate-runner 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) o[key] = true;
      else { o[key] = next; i++; }
    } else o._.push(a);
  }
  return o;
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.selftest) return runSelftest();
  try {
    const pipeline = studio.readPipeline();
    let typeId = o.type;
    if (!typeId) {
      if (!o.task) { console.error('需要 --task "<任务描述>" 或 --type check|polish|write'); return 2; }
      typeId = studio.routeTask(o.task, pipeline).type.id;
    }
    const type = pipeline.task_types.find((t) => t.id === typeId);
    if (!type) { console.error(`未知任务类型：${typeId}`); return 2; }
    /* ★★ v3.2.30 根因修复：**`--package` 此前被 CLI 接受却从未进入 inputs** ⇒ 凡参数模板写 `{package}` 的门都拿不到它，journal-contract 因此永远跑在无包模式、自带一个 FAIL ⇒ 门执行器报失败而 preflight 直连报通过，两处读数不一致。**参数被接受 ≠ 参数被传给门。** */
const inputs = { draft: o.draft, docx: o.docx, package: o.package || o.pkgdir, anchors: o.anchors, manifest: o.manifest, contract: o.contract, declaration: o.declaration, report: o.report, phrase_bank: (pipeline.assets || {}).phrase_bank };
    const gates = (type.gates || []).map((gid) => (pipeline.gates || []).find((x) => x.id === gid)).filter(Boolean);
    const { genre, results } = runGates(gates, inputs, pipeline, { genreOverride: o.genre || null });
    if (o.json) {
      // V2.6：口径一致 —— 这条路径也必须带保证级别与判定类别（同一术语不许两处各说一套）
      const assurance = assuranceOf(type.tier, o.assurance, pipeline);
      const cls = results.reduce((a, g) => { const c = verdictClassOf(g.verdict, pipeline) || '?'; a[c] = (a[c] || 0) + 1; return a; }, {});
      console.log(JSON.stringify({
        task_type: type.id, tier: type.tier, assurance, verdict_classes: cls,
        overall_assurance: (cls.fail || cls.error || cls.blocked) ? 'blocked' : (results.some((g) => /NEEDS_READ/.test(g.stdout || '')) ? 'provisional' : 'accepted'),
        genre, inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => typeof v === 'string' && v)), gates: results,
      }, null, 2));
    }
    else printTable(results, pipeline);
    return summarize(results, assuranceOf(type.tier, o.assurance, pipeline), pipeline);
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 2;
  }
}

// ── report：把门结果渲染成【带行号的待修项清单】 ────────────────────────────
// 纪律：行号只从**门的输出**里取，不在渲染层猜；取不到行号的项如实标「（无行号）」，
//       前提层失败与「缺输入跳过」单独分区，**不混进「需修改」**里（否则人会去改稿子，
//       而真正的问题是环境或没给输入 —— 2026-10-14 的假发现就是这么来的）。
function lessonIndex(pipeline) {
  const out = {};
  for (const [lid, m] of Object.entries((pipeline.lessons_coverage || {}))) {
    if (typeof m !== 'string') continue;
    for (const hit of (m.match(/gate:[a-z0-9-]+/gi) || [])) {
      const id = hit.slice(5);
      (out[id] = out[id] || []).push(lid);
    }
  }
  return out;
}

/**
 * 「说明桶」——这些键下面放的是**为什么没判它为问题**，不是待修项。
 * 由来（2026-10-14 实测）：claim-anchor 把「不判为无引用断言」「已人读」等说明放在 `INFO` / `HUMAN_VERIFIED` 里，
 * 渲染器把它们当待修项，于是「结果」节一次冒出 **101 项**（全是要人改的假象）。软提示同理（HARD/SOFT 分级门）。
 * 纪律：跳过时必须**报出跳过了多少条**，不许让它们无声消失。
 */
const CONTEXT_KEYS = ['info', 'notes', 'note', 'exempt', 'exemptions', 'human_verified', 'needs_read',
                      'counts', 'summary', 'stats', 'schema', 'generated_at', 'verdict', 'ok', 'soft', 'warnings', 'context'];

function isContextKey(k) { return k && CONTEXT_KEYS.includes(String(k).toLowerCase()); }

/** 数一数被跳过的说明条目（用于在报告里如实报告，而不是静默丢弃）。 */
function countContext(node, key) {
  if (isContextKey(key)) {
    if (Array.isArray(node)) return node.length;
    if (node && typeof node === 'object') return Object.keys(node).length ? 1 : 0;
    return 0;
  }
  if (Array.isArray(node)) return node.reduce((a, n) => a + countContext(n, null), 0);
  if (node && typeof node === 'object') return Object.entries(node).reduce((a, [k, v]) => a + countContext(v, k), 0);
  return 0;
}

function walkJson(node, gateId, sink, key) {
  if (isContextKey(key)) {                                    // 说明桶：整棵子树跳过，但**逐条留痕**
    if (Array.isArray(node) && sink.contextItems) {
      for (const n of node) {
        if (sink.contextItems.length >= 30) break;
        if (n && typeof n === 'object') {
          sink.contextItems.push({ gate: gateId, bucket: String(key),
            line: typeof n.line === 'number' ? n.line : null,
            why: String(n.why || n.reason || n.message || n.text || n.hit || '').slice(0, 140) });
        } else if (n) {
          sink.contextItems.push({ gate: gateId, bucket: String(key), line: null, why: String(n).slice(0, 140) });
        }
      }
    }
    return;
  }
  if (Array.isArray(node)) { for (const n of node) walkJson(n, gateId, sink); return; }
  if (node && typeof node === 'object') {
    // ★ 2026-10-14：**行号不是必需的**。字段级判据（如 author-material 的 `{line:null, rule, why, text}`）
    //   没有行号可给，旧规则（必须有数字 line）会把它们整条丢掉 —— 于是 report 只能打印
    //   「有 N 门判失败但未解析出待修项」。判据改为：**有 line 键**且**说了 why 或 rule** 即算一项，
    //   行号取不到就如实记 null（不猜行号）；同时保护 `line` 字段真的不存在时也不误抓普通对象。
    const hasLineKey = Object.prototype.hasOwnProperty.call(node, 'line') && (typeof node.line === 'number' || node.line === null);
    const says = node.why || node.reason || node.message || node.rule || node.stage || node.check;
    if ((typeof node.line === 'number') || (hasLineKey && says)) {
      sink.push({ gate: gateId, line: typeof node.line === 'number' ? node.line : null,
                  rule: node.stage || node.check || node.rule || node.id || '',
                  why: node.why || node.reason || node.message || '', text: String(node.text || node.snippet || '').slice(0, 200),
                  key: node.key === undefined ? undefined : String(node.key) });
      return; // 一个条目只出一项，不再往里挖
    }
    for (const [k, v] of Object.entries(node)) walkJson(v, gateId, sink, k);
  }
}

const LINE_PATTERNS = [/(?:行|line|L)\s*[:：]?\s*(\d+)/i, /第\s*(\d+)\s*行/, /^\s*(\d+)\s*[:：]/, /:(\d+):/];

function parseFindings(gate, stdout) {
  const out = [];
  out.contextItems = [];
  const so = String(stdout || '');
  const t = so.trim();
  let json = null;
  if (t.startsWith('{') || t.startsWith('[')) { try { json = JSON.parse(t); } catch (e) { json = null; } }
  if (json) {
    walkJson(json, gate.id, out);
    out.skippedContext = countContext(json, null);            // 如实报告跳过多少条说明/豁免
    return out;
  }
  for (const raw of so.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // 装饰行与汇总行不是「待修项」：框线、门标题、扫描/判定/用法这类自我说明必须跳过，
    // 否则 report 会把门自己的表头当成一条待修项（2026-10-14 实测：worknote-leak 报了 4 条噪声）。
    if (/^[═─=*_#\s]+$/.test(line)) continue;
    if (/^(扫描|判定|期望值|用法|文件|门统计)[：:]/.test(line)) continue;
    if (/^.{0,4}══+/.test(line)) continue;
    let ln = null;
    for (const rx of LINE_PATTERNS) { const m = line.match(rx); if (m) { ln = parseInt(m[1], 10); break; } }
    out.push({ gate: gate.id, line: ln, rule: '', why: line.slice(0, 200), text: '', key: undefined });
  }
  return out;
}

function dedupe(findings) {
  const map = new Map();
  for (const f of findings) {
    const k = [f.gate, f.line, f.rule, f.why, f.text].join('|');
    if (map.has(k)) {
      const e = map.get(k);
      if (f.key && !e.keys.includes(f.key)) e.keys.push(f.key);
      e.count = e.keys.length || e.count;
      continue;
    }
    map.set(k, Object.assign({}, f, { keys: f.key ? [f.key] : [], count: f.key ? 1 : undefined }));
  }
  return [...map.values()];
}

function reportMain(argv) {
  const showContext = argv.includes('--show-context');
  const o = parseArgs(argv.filter((a) => a !== '--show-context'));
  try {
    const pipeline = studio.readPipeline();
    let typeId = o.type;
    if (!typeId) {
      if (!o.task) { console.error('report 需要 --task "<任务描述>" 或 --type check|polish|write'); return 2; }
      typeId = studio.routeTask(o.task, pipeline).type.id;
    }
    const type = pipeline.task_types.find((x) => x.id === typeId);
    if (!type) { console.error(`未知任务类型：${typeId}`); return 2; }
    /* ★★ v3.2.30 根因修复：**`--package` 此前被 CLI 接受却从未进入 inputs** ⇒ 凡参数模板写 `{package}` 的门都拿不到它，journal-contract 因此永远跑在无包模式、自带一个 FAIL ⇒ 门执行器报失败而 preflight 直连报通过，两处读数不一致。**参数被接受 ≠ 参数被传给门。** */
const inputs = { draft: o.draft, docx: o.docx, package: o.package || o.pkgdir, anchors: o.anchors, manifest: o.manifest, contract: o.contract, declaration: o.declaration, report: o.report, phrase_bank: (pipeline.assets || {}).phrase_bank };
    const gates = (type.gates || []).map((gid) => (pipeline.gates || []).find((x) => x.id === gid)).filter(Boolean);
    // report 模式：优先让门吐结构化输出（真源里的 report_args，例如 --json）——
    // 结构化能拿到 line 字段；没有 report_args 的门退回解析人读输出（在解析里跳过装饰行）。
    const runList = gates.map((g) => Object.assign({}, g, { args: [...(g.args || []), ...((g.report_args) || [])] }));
    const { genre, results } = runGates(runList, inputs, pipeline, { capture: true, genreOverride: o.genre || null });
    const lessons = lessonIndex(pipeline);

    const blocking = []; const pre = []; const skipped = []; const notApplicable = [];
    for (const g of results) {
      const ls = lessons[g.id] || [];
      if (g.verdict === 'precondition_fail') { pre.push({ gate: g.id, what: g.note, lessons: ls }); continue; }
      if (g.verdict === 'skipped_missing_input') { skipped.push({ gate: g.id, what: g.note, lessons: ls }); continue; }
      if (g.verdict === 'skipped_not_applicable') { notApplicable.push({ gate: g.id, what: g.note, lessons: ls }); continue; }
      if (g.verdict === 'pass') continue;
      const raw = parseFindings(g, g.stdout);
      g.skippedContext = raw.skippedContext || 0;              // 把「跳过了多少条说明」带到报告里
      g.contextItems = raw.contextItems || [];
      for (const f of dedupe(raw)) { f.lessons = ls; blocking.push(f); }
    }
    blocking.sort((a, b) => ((a.line === null ? 1e9 : a.line) - (b.line === null ? 1e9 : b.line)) || a.gate.localeCompare(b.gate));

    // ── V2.3：成品件**自带读数**（不依赖文档库）—— 必须在 payload 之前算好（否则 TDZ：见下）──
    let docxReading = null;
    if (inputs.docx && fs.existsSync(inputs.docx)) {
      try { docxReading = studio.readDocxStructure(inputs.docx); }
      catch (e) { docxReading = { error: String((e && e.message) || e) }; }
    }
    const counts = results.reduce((a, g) => (a[g.verdict] = (a[g.verdict] || 0) + 1, a), {});
    const assurance = assuranceOf(type.tier, o.assurance, pipeline);
    const cls = results.reduce((a, g) => { const c = verdictClassOf(g.verdict, pipeline) || '?'; a[c] = (a[c] || 0) + 1; return a; }, {});
    const hasNeedsRead = results.some((g) => /NEEDS_READ/.test(g.stdout || ''));
    const overallAssurance = (cls.fail || cls.error || cls.blocked) ? 'blocked' : (hasNeedsRead ? 'provisional' : 'accepted');
    const payload = {
      task_type: type.id, tier: type.tier, assurance, overall_assurance: overallAssurance, verdict_classes: cls, genre,
      inputs: Object.fromEntries(Object.entries(inputs).filter(([, v]) => typeof v === 'string' && v)),
      summary: counts, exit: summarize(results, assurance, pipeline), blocking, precondition_fail: pre, skipped, not_applicable: notApplicable, lessons,
      docx_reading: docxReading,
      gates: results.map((g) => ({ id: g.id, verdict: g.verdict, class: verdictClassOf(g.verdict, pipeline), rc: g.rc })),
    };
    // ── V2.7：写工件（输入哈希 + 逐门原始输出摘要）—— 判决可复核的前提是「当时吃的是哪些字节」──
    if (o['emit-artifact']) {
      const dir = o['artifact-dir'] || path.join(inputs.draft ? path.dirname(inputs.draft) : process.cwd(), '.paper-studio');
      try {
        fs.mkdirSync(dir, { recursive: true });
        const art = {
          schema_version: ARTIFACT_SCHEMA,
          audit_skill: 'paper-studio/gate-runner',
          task_type: type.id, tier: type.tier, assurance, overall_assurance: overallAssurance,
          verdict: (cls.error || cls.fail || cls.blocked) ? 'BLOCKED' : (cls.pass ? 'PASS' : 'NOT_APPLICABLE'),
          reason_code: reasonCodeOf(cls),
          summary: `门 ${results.length}：` + Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' · '),
          gates: results.map((g) => ({
            id: g.id, judge_type: studio.judgeTypeOf(g.id, pipeline), verdict: g.verdict, class: verdictClassOf(g.verdict, pipeline), rc: g.rc,
            stdout_sha256: g.stdout ? 'sha256:' + crypto.createHash('sha256').update(g.stdout).digest('hex') : null,
            stdout_head: (g.stdout || '').slice(0, 2000),   // 原始输出留档：判决意外时**先读原始工件**，别急着重跑（review-tracing 纪律）
          })),
          audited_input_hashes: auditInputHashes(inputs),
          review_independence: 'deterministic',
          acceptance_status: overallAssurance === 'accepted' ? 'accepted' : 'provisional',
          generated_at: new Date().toISOString(),
        };
        const f = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${type.id}.artifact.json`);
        fs.writeFileSync(f, JSON.stringify(art, null, 2), 'utf8');
        // ── V2.13：同时写**固定名「最新」副本**（吸收 output-versioning：下游只读固定名，不必知道时间戳；
        //   带时间戳的那份是**永久历史，永不删除**）──
        const latest = path.join(dir, `latest-${type.id}.artifact.json`);
        fs.writeFileSync(latest, JSON.stringify(art, null, 2), 'utf8');
        console.log(`工件已写：${f}`);
        console.log(`  最新副本（下游只读这个固定名）：${latest}`);
        console.log(`  输入哈希 ${Object.keys(art.audited_input_hashes).length} 项 · 复核：node bin/studio.cjs verify --artifact "${f}"`);
      } catch (e) { console.error('工件写入失败：' + String((e && e.message) || e)); }
    }
    if (o.json) { console.log(JSON.stringify(payload, null, 2)); return summarize(results, assurance, pipeline); }

    const base = inputs.draft ? path.basename(inputs.draft) : '（未给源稿）';
    console.log(`待修项清单（真源：references/pipeline.json · 任务类型 ${type.id}/${type.tier} · 体裁 ${genre.id}）`);
    console.log(`稿件：${inputs.draft || '（未给）'}${inputs.docx ? ' · 成品：' + inputs.docx : ''}`);
    console.log(`门统计：通过 ${counts.pass || 0} · 失败 ${counts.fail || 0} · 跳过(缺输入) ${counts.skipped_missing_input || 0} · 不适用(体裁) ${counts.skipped_not_applicable || 0} · 前提层失败 ${counts.precondition_fail || 0}`);
    // ── V2.10：范围声明（吸收 ARIS experiment-integrity 的「范围不足」反模式）──
    console.log(scopeStatement(results, inputs));    // ── V2.6：保证级别轴 + 判定类别 + 聚合结论（外部吸收：ARIS assurance-contract.md，MIT）──
    console.log(`⚡ [档位 ${type.tier} · 保证级别 ${assurance}] 门 ${results.length} · 判定类别 ` + Object.entries(cls).map(([k, v]) => `${k}=${v}`).join(' · '));
    console.log(`【聚合结论】overall_assurance = ${overallAssurance}` + (overallAssurance === 'blocked'
      ? '（存在阻断条件：fail / blocked(缺输入) / error）'
      : overallAssurance === 'provisional'
        ? '（绿了，但含 NEEDS_READ —— 机械全过、语义仍需人读 ⇒ **不得讲成「可投稿 yes」**）'
        : '（绿的每一项都是确定性可判；注意这仍不等于稿子质量通过，质量裁决属 B 类）'));
    if (assurance === 'submission' && (counts.skipped_missing_input || 0) > 0) {
      console.log(`   ⚠ 保证级别=submission：**缺输入的 ${counts.skipped_missing_input} 门按 blocked 处理 ⇒ 阻断**（ARIS 原文：BLOCKED is more dangerous than NOT_APPLICABLE）。`);
    }
    // ── V2.3：把自带的成品件读数打出来（少依赖另一侧运行时）──
    // ── V2.5：认识论澄清（外部吸收：ARIS acceptance-gate.md 的 A/B 门分类）──
    const bGates = results.filter((g) => studio.judgeTypeOf(g.id, pipeline) === 'B');
    console.log(`【认识论】本次 ${results.length} 道门：A 类(客观/执行) ${results.length - bGates.length} · B 类(质量裁决) ${bGates.length}`);
    console.log(bGates.length === 0
      ? '   ⇒ 全为 A 类 ⇒ **全绿只证明「该做的检查都做了、该有的要件都在」，不等于稿子质量通过**；质量裁决属 B 类，须走跨模型 reviewer（停止门＝`score ≥ 6` AND verdict ∈ {ready, almost} 双条件）'
      : `   ⇒ B 类门（${bGates.map((g) => g.id).join(' / ')}）的结论必须来自**跨模型 reviewer**，不得由本地同族判断代签`);
    if (docxReading) {
      if (docxReading.error) console.log(`成品件自带读数失败（不影响门判定，但要查）：${docxReading.error}`);
      else {
        console.log(`成品件自带读数（本插件实现，不经文档库）：顶层表格 ${docxReading.tables} · 内嵌图 ${docxReading.inline_images} · `
                  + `媒体文件 ${docxReading.media_files} · 非空段落 ${docxReading.paragraphs} · 残留标记段落 ${docxReading.leak_paragraphs}`);
      }
    }
    if (blocking.length) {
      console.log(`\n【需修改】按行号排序，共 ${blocking.length} 项`);
      blocking.forEach((f, i) => {
        const loc = f.line === null ? '（无行号）' : `${base}:${f.line}`;
        const cnt = f.count && f.count > 1 ? ` ×${f.count}` : '';
        const tail = f.lessons && f.lessons.length ? `  ← ${f.lessons.join(' / ')}` : '';
        console.log(`  ${String(i + 1).padStart(2, '.')} ${loc}  [${f.gate}${f.rule ? '/' + f.rule : ''}]${cnt}${tail}`);
        if (f.why) console.log(`      ${f.why}`);
        if (f.text) console.log(`      原文：${f.text}`);
      });
    }
    // ── V2.2：按节看哪一节要改（把「行号清单」翻译成「章节清单」）──
    //    纪律：每道门的待修项都必须在章节集里有归属；找不到归属就**明说**，不许悄悄丢掉。
    if (blocking.length) {
      const t = studio.readTemplates();
      const sec = studio.readSections(genre.id, t);
      const bySec = new Map(); const cross = []; const orphan = [];
      for (const f of blocking) {
        const id = studio.primarySectionOf(f.gate, pipeline);
        if (id === null) { orphan.push(f); continue; }
        if (id === '*') { cross.push(f); continue; }             // 跨节门：本就是全文按行分布，不假装归属
        if (!bySec.has(id)) bySec.set(id, { sec: sec.sections.find((x) => x.id === id), items: [] });
        bySec.get(id).items.push(f);
      }
      console.log(`\n【按节看哪一节要改】（章节集 ${sec.set} · 共 ${sec.sections.length} 节 · 归属由真源 primary_section 声明）`);
      for (const s of sec.sections) {
        const hit = bySec.get(s.id);
        if (!hit) { console.log(`  · ${s.label}：无待修项`); continue; }
        console.log(`  ▸ ${s.label}｜相关门：${(s.gates || []).join(' / ')}｜**${hit.items.length} 项**`);
        for (const f of hit.items) {
          const loc = f.line === null ? '（无行号）' : `${base}:${f.line}`;
          console.log(`      ${loc}  [${f.gate}${f.rule ? '/' + f.rule : ''}] ${String(f.why || '').slice(0, 90)}`);
        }
      }
      if (cross.length) {
        console.log(`  ⇄ 跨节（按行号看上面的清单）：${cross.length} 项｜门：${[...new Set(cross.map((c) => c.gate))].join(' / ')}`);
      }
      const ctx = results.reduce((a, g) => a + (g.skippedContext || 0), 0);
      if (ctx) console.log(`  （说明/豁免共 ${ctx} 条：INFO / HUMAN_VERIFIED / 软提示等，**不算待修项**${showContext ? '' : '；要看内容加 `--show-context`'}）`);
      if (showContext) {
        const items = results.flatMap((g) => g.contextItems || []);
        if (items.length) {
          console.log(`\n【说明/豁免原文（--show-context，共 ${ctx} 条，最多列 30）】`);
          for (const c of items.slice(0, 30)) {
            console.log(`  · [${c.gate}/${c.bucket}]${c.line === null ? '' : ' L' + c.line} ${c.why}`);
          }
        }
      }
      if (orphan.length) {
        console.log(`  ⚠ 有 ${orphan.length} 项待修项**没有声明归属**（门：${[...new Set(orphan.map((o) => o.gate))].join(' / ')}）`);
        console.log('    ⇒ 到真源 `gate_meta.primary_section` 里为它声明一个章节（或声明 `*` 表示跨节）—— 不许让待修项无处归属');
      }
    }
    if (pre.length) {
      console.log('\n【前提层失败 —— 环境/输入不成立，**不是稿子的问题**，别照着它改稿】');
      for (const p of pre) console.log(`  - ${p.gate}：${p.what}`);
    }
    if (skipped.length) {
      console.log('\n【跳过（缺输入）—— 补齐输入后重跑；跳过不算通过】');
      for (const s of skipped) console.log(`  - ${s.gate}：${s.what}`);
    }
    if (notApplicable.length) {
      console.log(`\n【不适用（体裁 ${genre.id}）—— 既不算通过也不算失败，只是本门不管这类稿件】`);
      for (const n of notApplicable) console.log(`  - ${n.gate}：${n.what}`);
    }
    const nothingToShow = !blocking.length && !pre.length && !skipped.length;
    if (!blocking.length && !pre.length && !skipped.length && !(counts.pass > 0)) {
      // ★ V1.5 护栏：**全不适用 ≠ 全通过**。一个门都没实际判定时必须显式报错，
      //   否则「体裁判错 ⇒ 所有门都不适用 ⇒ 静默绿」会变成一条假绿通道。
      console.log(`\n  ⚠ 本次**没有任何门实际判定**（通过 ${counts.pass || 0} · 不适用 ${counts.skipped_not_applicable || 0}）——`);
      console.log('    这**不等于通过**。请先确认体裁是否判错：`node bin/studio.cjs genre <稿.md>`（可用 --genre 覆盖）。');
    } else if (nothingToShow && counts.fail > 0) {
      // ★ 2026-10-14：**不许自相矛盾** —— 有门判失败却没解析出待修项时，必须明说"没解析出来"，
      //   绝不能打印「全部门通过」（那正是"判定器骗自己"的形状：失败数 1 + 全通过 同时出现）。
      console.log(`\n  ⚠ 有 ${counts.fail} 门判失败，但**未解析出待修项**（该门可能缺 report_args，或输出格式未被识别）——`);
      console.log('    这**不等于通过**。请直接单跑该门看原始输出（见上面的逐门行）。');
    } else if (nothingToShow) {
      console.log('\n  无待修项：全部门通过。');
    }
    return summarize(results, assurance, pipeline);
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 2;
  }
}

// ── verify：校验工件 schema + **重算输入哈希** ⇒ STALE（V2.7 · ARIS 验证器契约的等价物）──
//   为什么要它：门跑完是「那一刻」的判决。稿子后来改了数字、换了图、补了引用 ⇒ 那份判决作废。
//   没有这一步，人只会看到一份过去的绿报告，却以为它说的是现在的稿子。
function artifactMain(argv) {
  const o = parseArgs(argv);
  if (!o.artifact) { console.error('需要 --artifact <工件.json>'); return 2; }
  let art;
  try { art = JSON.parse(fs.readFileSync(o.artifact, 'utf8')); }
  catch (e) { console.error('工件读不了：' + String((e && e.message) || e)); return 2; }

  const problems = []; const stale = [];
  for (const k of ARTIFACT_REQUIRED) if (!(k in art)) problems.push(`缺字段 ${k}`);
  if (art.schema_version && art.schema_version !== ARTIFACT_SCHEMA) problems.push(`schema_version=${art.schema_version}（期望 ${ARTIFACT_SCHEMA}）`);
  if (!REVIEW_INDEPENDENCE.includes(art.review_independence)) problems.push(`review_independence=${art.review_independence} 非法（应为 ${REVIEW_INDEPENDENCE.join('/')}）`);
  if (art.verdict && !['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'NOT_APPLICABLE'].includes(art.verdict)) problems.push(`verdict=${art.verdict} 不在六态内`);
  const classSet = new Set(['pass', 'fail', 'warn', 'not_applicable', 'blocked', 'error']);
  for (const g of (art.gates || [])) if (!classSet.has(g.class)) problems.push(`门 ${g.id} 的 class=${g.class} 非法`);
  // ★ ARIS 纪律：`deterministic` 只允许用在「进程真能判」的事上 —— 出现 B 类（质量裁决）门时不许标它
  if (art.review_independence === 'deterministic' && (art.gates || []).some((g) => g.judge_type === 'B')) {
    problems.push('review_independence=deterministic 但存在 B 类（质量裁决）门 —— 语义判决不得由确定性检查代签');
  }
  for (const [role, rec] of Object.entries(art.audited_input_hashes || {})) {
    const now = rec && rec.path ? sha256OfFile(rec.path) : null;
    if (now === null) stale.push(`${role} 读不到（${rec && rec.path}）`);
    else if (now !== rec.hash) stale.push(`${role} 哈希已变（${String(rec.hash).slice(7, 19)}… → ${now.slice(7, 19)}…）`);
  }

  const status = problems.length ? 'INVALID' : (stale.length ? 'STALE' : 'FRESH');
  console.log(`工件复核：${status} · ${path.basename(o.artifact)}`);
  console.log(`  判决 ${art.verdict || '?'} · 保证级别 ${art.assurance || '?'}/${art.overall_assurance || '?'} · 独立性 ${art.review_independence || '?'} · 受理状态 ${art.acceptance_status || '?'} · 生成于 ${art.generated_at || '?'}`);
  const aw = ageWarning(art.generated_at, Date.now());
  if (aw) console.log('  ' + aw);
  if (problems.length) { console.log('  ✘ schema/契约问题：'); problems.forEach((p) => console.log('    - ' + p)); }
  if (stale.length) { console.log('  ⚠ STALE —— 工件生成后输入被改过，该判决已过期，必须重跑：'); stale.forEach((s) => console.log('    - ' + s)); }
  if (status === 'FRESH') console.log('  ⇒ 输入与工件一致：该判决对**当前这一版**稿件仍然有效（注意：只证明「判决对应的输入没变」，不等于稿子质量）。');
  return status === 'FRESH' ? 0 : 1;
}

// ⚠ 入口守卫必须放在**文件最后**：它一执行就会调 main()/runSelftest()，
//   而这些函数会用到后面用 `const` 声明的表（如 LINE_PATTERNS）——
//   放中间会踩 TDZ（"Cannot access 'LINE_PATTERNS' before initialization"），
//   2026-10-14 由本文件自检当场抓到。
if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { buildArgs, runOneGate, summarize, interpreterFor, reportMain, parseFindings, dedupe, lessonIndex, runGates, applicableTo, genreOfDraft, verdictClassOf, blocksSubmission, assuranceOf, sha256OfFile, auditInputHashes, artifactMain, hasReassuranceProse, scopeStatement, ageWarning };
