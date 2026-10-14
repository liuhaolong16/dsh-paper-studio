#!/usr/bin/env node
/**
 * runstate — 多阶段运行的「完成 vs 受理」状态机（V2.12 · 外部吸收 ARIS `resumable-runs.md`，MIT）
 *
 * ★ 一句话（原文）：**恢复不是"重开会话"，而是 resolve FORWARD 到「可信的进度」真正落地的地方。**
 *   要做到这点，必须把**执行**与**受理**拆开：
 *
 *   | status     | 含义                                   | 谁能写                        | 类别 |
 *   |------------|----------------------------------------|-------------------------------|------|
 *   | pending    | 未开始                                 | start                         | —    |
 *   | running    | 进行中                                 | set                           | —    |
 *   | failed     | 执行者出错                             | set                           | —    |
 *   | done       | 执行者写完了工件                        | set                           | **执行完备性 —— 同族自报是安全的** |
 *   | **accepted** | **跨模型 reviewer 或确定性验证器给了正面判定** | **只有 accept**（须带 verdict_id + reviewer，且该阶段已经是 done） | **质量/正确性 —— 必须跨模型或确定性** |
 *   | skipped    | 该阶段不适用于本次运行（配置决定）       | set                           | 终态 |
 *
 * ★ **resume 走到第一个非终态（{accepted, skipped} 之外）**，**绝不是"第一个非 done"** ⇒
 *   一个被执行者自认 done、但在跨模型审计前崩掉的阶段，**恢复时会被重新验证，绝不静默跳过**。
 *   这就是 `acceptance-gate` 落到多阶段：**运行可以 DRIVE 自己的恢复，但不能 ACQUIT 某个阶段。**
 *
 * ★ `accept` 单独一条路径：**缺 `verdict_id` 或 `reviewer` 直接拒**（不能"记不清谁批的"就算批过）；
 *   `verdict_id` 必须是**可查的凭据**（thread/trace id，或验证器报告的 path+sha），不是一个标签。
 *   reviewer 看起来是执行者同族（`claude*` 等）⇒ **大声警告**（自审嫌疑）。
 *   **确定性验证器是合法陪审团**（原话：a process is not a model family）⇒ 记成 `deterministic:<脚本>`。
 *
 * ★ 单写者 + 原子写（temp + rename）：并发恢复者不会把状态文件写坏。
 *
 * 用法：node bin/runstate.cjs <start|set|accept|gate|resume|status> <root> <run_id> [...]
 * 退出码：0 成功 · 1 被拒（缺凭据/阶段不存在/非法跃迁） · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TERMINAL = ['accepted', 'skipped'];
const SETTABLE = ['running', 'done', 'failed', 'skipped'];
const SAME_FAMILY = /^(claude|anthropic|gpt-?5|deepseek|solar|jarvis|self)/i;   // 自审嫌疑（可扩展）

function stateFile(root, runId) { return path.join(root, '.paper-studio', `run-${runId}.json`); }

function readState(root, runId) {
  const f = stateFile(root, runId);
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

/** 原子写：先写临时文件再 rename（并发恢复者不会读到半截 JSON）。 */
function writeState(root, runId, st) {
  const f = stateFile(root, runId);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, f);
  return f;
}

function startRun(root, runId, phases) {
  if (!Array.isArray(phases) || !phases.length) throw new Error('前提层失败：phases 必须是非空数组');
  if (fs.existsSync(stateFile(root, runId))) throw new Error(`run ${runId} 已存在（单写者；要重来请换 run_id）`);
  const st = {
    run_id: runId, root,
    phases: phases.map((name) => ({ name, status: 'pending', artifact: null, verdict_id: null, reviewer: null, updated_at: null })),
    gates: [], created_at: new Date().toISOString(),
  };
  writeState(root, runId, st);
  return st;
}

function phaseOf(st, name) {
  const p = st.phases.find((x) => x.name === name);
  if (!p) throw new Error(`阶段不存在：${name}（本 run 的阶段：${st.phases.map((x) => x.name).join('/')}）`);
  return p;
}

/** 执行者路径：只许写 running/done/failed/skipped —— **永远不能写 accepted**。 */
function setStatus(root, runId, name, status, artifact) {
  const st = readState(root, runId);
  if (!st) throw new Error(`run 不存在：${runId}`);
  if (!SETTABLE.includes(status)) throw new Error(`set 只接受 ${SETTABLE.join('|')}；accepted 必须走 accept（带凭据）`);
  const p = phaseOf(st, name);
  p.status = status; p.artifact = artifact || p.artifact; p.updated_at = new Date().toISOString();
  writeState(root, runId, st);
  return p;
}

/**
 * 受理路径（唯一能写 accepted 的入口）：**必须**有 verdict_id + reviewer；阶段必须已 done。
 * 返回 { phase, warning }：reviewer 像同族时 warning 非空（自审嫌疑，照写但大声告警）。
 */
function accept(root, runId, name, verdictId, reviewer) {
  const st = readState(root, runId);
  if (!st) throw new Error(`run 不存在：${runId}`);
  if (!verdictId || !String(verdictId).trim()) throw new Error('拒收：缺 verdict_id（受理必须留可查凭据，不能"记不清谁批的"）');
  if (!reviewer || !String(reviewer).trim()) throw new Error('拒收：缺 reviewer（谁受理的必须记录）');
  const p = phaseOf(st, name);
  if (p.status !== 'done') throw new Error(`拒收：阶段 ${name} 当前是 ${p.status}，只有 done 才能被受理（先 set done）`);
  p.status = 'accepted'; p.verdict_id = verdictId; p.reviewer = reviewer; p.updated_at = new Date().toISOString();
  writeState(root, runId, st);
  const warning = (!/^deterministic:/i.test(reviewer) && SAME_FAMILY.test(reviewer))
    ? `⚠ 自审嫌疑：reviewer="${reviewer}" 看起来与执行者同族 ⇒ 这次受理不算跨模型裁决（本条已写入状态文件）` : null;
  return { phase: p, warning };
}

function recordGate(root, runId, gate, verdict, reasons) {
  const st = readState(root, runId);
  if (!st) throw new Error(`run 不存在：${runId}`);
  if (!['PASS', 'BLOCKED'].includes(verdict)) throw new Error('门判定只能是 PASS 或 BLOCKED（门不替代逐阶段受理记录）');
  st.gates.push({ gate, verdict, reasons: reasons || [], at: new Date().toISOString() });
  writeState(root, runId, st);
  return st.gates[st.gates.length - 1];
}

/** 恢复点：**第一个非终态**（非 accepted/skipped）的阶段名，或 null（全终态＝跑完）。 */
function resumePoint(root, runId) {
  const st = readState(root, runId);
  if (!st) throw new Error(`run 不存在：${runId}`);
  const p = st.phases.find((x) => !TERMINAL.includes(x.status));
  return p ? p.name : null;
}

/** 摘要（给人看 + 机检）：哪些阶段是 done-但未受理（结构性可见的未了受理义务）。 */
function summarize(root, runId) {
  const st = readState(root, runId);
  if (!st) throw new Error(`run 不存在：${runId}`);
  const doneUnaccepted = st.phases.filter((x) => x.status === 'done').map((x) => x.name);
  return {
    run_id: st.run_id, phases: st.phases.map((x) => `${x.name}:${x.status}`),
    done_but_unaccepted: doneUnaccepted, resume: resumePoint(root, runId), gates: st.gates.length,
  };
}

function runSelftest() {
  const results = [];
  const os = require('os');
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ps-run-'));
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };

  check('★ 正控 · 「done 但未受理」必须成为恢复点（恢复不是回到"第一个非 done"，而是回到未受理处）', () => {
    const r = mk(); startRun(r, 'x', ['W1', 'W2', 'W3']);
    setStatus(r, 'x', 'W1', 'done', 'W1.md');
    return resumePoint(r, 'x') === 'W1' ? true : `resume=${resumePoint(r, 'x')}（应 W1：执行者自认 done，但没人受理过）`;
  });
  check('★ 反控 · accepted 与 skipped 是终态 ⇒ 恢复点跳过它们', () => {
    const r = mk(); startRun(r, 'y', ['W1', 'W2', 'W3']);
    setStatus(r, 'y', 'W1', 'done', 'a'); accept(r, 'y', 'W1', 'codex:019e', 'codex-gpt-6-astra');
    setStatus(r, 'y', 'W2', 'skipped');
    return resumePoint(r, 'y') === 'W3' ? true : `resume=${resumePoint(r, 'y')}`;
  });
  check('★ 反控 · 全终态 ⇒ 恢复点为 null（跑完了）', () => {
    const r = mk(); startRun(r, 'z', ['W1']);
    setStatus(r, 'z', 'W1', 'done'); accept(r, 'z', 'W1', 'v1', 'deterministic:verify.py');
    return resumePoint(r, 'z') === null ? true : 'resume 非 null';
  });
  check('★ 必失败 · accept 缺 verdict_id 或 reviewer ⇒ 拒收，且状态不变（不能"记不清谁批的"就算批过）', () => {
    const r = mk(); startRun(r, 'a', ['W1']); setStatus(r, 'a', 'W1', 'done');
    let e1 = ''; let e2 = '';
    try { accept(r, 'a', 'W1', '', 'codex-gpt-6-astra'); } catch (e) { e1 = e.message; }
    try { accept(r, 'a', 'W1', 'v1', ''); } catch (e) { e2 = e.message; }
    const st = summarize(r, 'a');
    return (/缺 verdict_id/.test(e1) && /缺 reviewer/.test(e2) && st.phases[0] === 'W1:done') ? true : `${e1} / ${e2} / ${st.phases[0]}`;
  });
  check('★ 必失败 · 未 done 的阶段不得被受理（不许跳过执行直接受理）', () => {
    const r = mk(); startRun(r, 'b', ['W1']);
    try { accept(r, 'b', 'W1', 'v1', 'codex-gpt-6-astra'); return '未拒收'; } catch (e) { return /只有 done/.test(e.message) ? true : e.message; }
  });
  check('★ 正控 · 同族 reviewer ⇒ 受理仍写入，但必须**返回警告**（自审嫌疑）', () => {
    const r = mk(); startRun(r, 'c', ['W1']); setStatus(r, 'c', 'W1', 'done');
    const a = accept(r, 'c', 'W1', 'v1', 'claude-opus');
    const b = (() => { const r2 = mk(); startRun(r2, 'c', ['W1']); setStatus(r2, 'c', 'W1', 'done'); return accept(r2, 'c', 'W1', 'v1', 'deterministic:verify.py'); })();
    return (a.warning && !b.warning) ? true : `同族 warning=${a.warning} · 确定性 warning=${b.warning}`;
  });
  check('★ 必失败 · set 不许写 accepted（唯一入口是 accept）', () => {
    const r = mk(); startRun(r, 'd', ['W1']);
    try { setStatus(r, 'd', 'W1', 'accepted'); return '竟然允许了'; } catch (e) { return /必须走 accept/.test(e.message) ? true : e.message; }
  });
  check('★ 正控 · done-但未受理在摘要里**结构性可见**（未了的受理义务不会被藏起来）', () => {
    const r = mk(); startRun(r, 'e', ['W1', 'W2']); setStatus(r, 'e', 'W1', 'done'); setStatus(r, 'e', 'W2', 'done');
    const s = summarize(r, 'e');
    return (s.done_but_unaccepted.length === 2 && s.resume === 'W1') ? true : JSON.stringify(s);
  });
  check('反控 · 门判定只许 PASS/BLOCKED（门不替代逐阶段受理）', () => {
    const r = mk(); startRun(r, 'f', ['W1']);
    try { recordGate(r, 'f', 'g1', 'accepted'); return '竟然允许了'; } catch (e) { return /只能 PASS\|BLOCKED|PASS 或 BLOCKED/.test(e.message) ? true : e.message; }
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\nrunstate 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const [cmd, root, runId, ...rest] = argv.filter((a) => !a.startsWith('--'));
  const opt = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  if (!cmd || !root || !runId) { console.error('用法：runstate.cjs <start|set|accept|gate|resume|status> <root> <run_id> [参数]'); return 2; }
  try {
    if (cmd === 'start') {
      const st = startRun(root, runId, String(opt('--phases') || '').split(',').filter(Boolean));
      console.log(`已建 run ${st.run_id}：${st.phases.map((p) => p.name).join(' → ')}`); return 0;
    }
    if (cmd === 'set') {
      const p = setStatus(root, runId, rest[0], rest[1], opt('--artifact'));
      console.log(`${p.name} → ${p.status}${p.artifact ? '（工件 ' + p.artifact + '）' : ''}`); return 0;
    }
    if (cmd === 'accept') {
      const { phase, warning } = accept(root, runId, rest[0], opt('--verdict-id'), opt('--reviewer'));
      console.log(`${phase.name} → accepted（verdict_id=${phase.verdict_id} · reviewer=${phase.reviewer}）`);
      if (warning) console.log(warning);
      return 0;
    }
    if (cmd === 'gate') {
      const g = recordGate(root, runId, rest[0], rest[1], String(opt('--reasons') || '').split(';').filter(Boolean));
      console.log(`门 ${g.gate} → ${g.verdict}${g.reasons.length ? '（' + g.reasons.join('；') + '）' : ''}`); return 0;
    }
    if (cmd === 'resume') {
      const s = summarize(root, runId);
      console.log(s.resume ? `恢复点：**${s.resume}**（向前推进到第一个"非终态"，不是"第一个非 done"）` : '全部阶段已终态（accepted/skipped）⇒ 没有恢复点，本次运行已完成');
      console.log(`  阶段：${s.phases.join(' · ')}`);
      if (s.done_but_unaccepted.length) console.log(`  ⚠ done-但-未受理：${s.done_but_unaccepted.join('/')} —— 这些阶段会在恢复时**被重新验证**，绝不静默跳过`);
      return 0;
    }
    if (cmd === 'status') { console.log(JSON.stringify(summarize(root, runId), null, 2)); return 0; }
    console.error(`未知子命令：${cmd}`); return 2;
  } catch (e) {
    console.error(`错误：${String((e && e.message) || e)}`);
    return /^拒收/.test(String(e.message)) ? 1 : 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { startRun, setStatus, accept, recordGate, resumePoint, summarize, readState, TERMINAL, SETTABLE, main };
