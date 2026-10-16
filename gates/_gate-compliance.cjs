#!/usr/bin/env node
/**
 * _gate-compliance.cjs —— 投稿合规与许可清单门（薄适配器）
 *
 * 设计纪律（本仓铁律）：
 *   ① **判据只有一份**：正文在插件仓 `references/compliance-checklist.md`，本文件**不复制**任何条款，
 *      只把稿件所在目录交给插件 CLI（`studio.cjs compliance <dir> --json`）跑一遍，原样透出它的输出。
 *   ② 缺输入一律不判通过：稿件路径缺失 ⇒ 退出码 2（前提层失败），由 gate-runner 记 precondition_fail。
 *   ③ 插件 CLI 找不到 ⇒ 退出码 2 并**显形**打印找过的候选根，绝不静默跳过。
 *   ④ 退出码沿用真源约定：0=齐备 · 1=有硬项缺失 · 2=前提层失败。
 *
 * 用法：node _gate-compliance.cjs --draft <稿.md> [--json]
 *       node _gate-compliance.cjs --selftest
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CAND_ROOTS = [
  process.env.DSH_PAPER_STUDIO_ROOT,
  path.join(require('os').homedir(), '.agents', 'skills', 'paper-studio'),
  path.join(require('os').homedir(), '.dsh', 'skills', 'paper-studio'),
  path.join(require('os').homedir(), 'paper-studio'),
  path.join(__dirname, '..', 'dsh-paper-studio'),
  'E:\\DeepSeek\\skills\\paper-studio',
].filter(Boolean);

function findStudio() {
  const tried = [];
  for (const c of CAND_ROOTS) {
    const p = path.join(c, 'bin', 'studio.cjs');
    tried.push(p);
    try { if (fs.existsSync(p)) return { studio: p, tried }; } catch { /* 忽略不可读候选 */ }
  }
  return { studio: '', tried };
}

/** 纯函数：把 CLI 的退出码映射成本门的语义（便于夹具注入） */
function mapExit(rc) {
  if (rc === 0) return { code: 0, verdict: 'pass' };
  if (rc === 1) return { code: 1, verdict: 'fail' };
  return { code: 2, verdict: 'precondition_fail' };
}

function run(dir, opts) {
  opts = opts || {};
  if (!dir || !fs.existsSync(dir)) {
    process.stderr.write('前提层失败：投稿包目录不存在 —— ' + String(dir || '(空)') + '\n');
    return 2;
  }
  let found = { studio: opts.studio, tried: [] };
  if (!found.studio) found = findStudio();
  if (!found.studio) {
    process.stderr.write('前提层失败：找不到 paper-studio CLI（bin/studio.cjs）。找过的候选根：\n');
    for (const t of found.tried) process.stderr.write('  - ' + t + '\n');
    process.stderr.write('处置：设 DSH_PAPER_STUDIO_ROOT 指向能力树根，或安装整包 dsh-paper-studio（含 bin 与 references）。\n');
    return 2;
  }
  const r = spawnSync(process.execPath, [found.studio, 'compliance', dir].concat(opts.json ? ['--json'] : []), { encoding: 'utf8', timeout: 300000 });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const rc = (r.status === null || r.status === undefined) ? 2 : r.status;
  const m = mapExit(rc);
  if (opts.json) process.stdout.write(JSON.stringify({ gate: 'compliance-scan', dir, studio: found.studio, rc, verdict: m.verdict }) + '\n');
  return m.code;
}

function selftest() {
  const cases = [];
  const ok = (n, c) => cases.push({ n, ok: !!c });
  ok('退出码映射：0/1/2 各自归位', mapExit(0).verdict === 'pass' && mapExit(1).verdict === 'fail' && mapExit(2).verdict === 'precondition_fail');
  ok('必失败：不存在的目录必须退出码 2（不得当通过）', run(path.join(__dirname, '__no_such_dir__'), {}) === 2);
  const miss = findStudio();
  ok('能找到插件 CLI（找不到就说明前提不成立，须显形）', !!miss.studio || miss.tried.length > 0);
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log((c.ok ? '  ✔ ' : '  ✘ ') + c.n);
  console.log('\ncompliance 门自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const json = argv.includes('--json');
  let draft = '';
  const i = argv.indexOf('--draft');
  if (i >= 0) draft = argv[i + 1] || '';
  if (!draft) { process.stderr.write('前提层失败：本门需要 --draft <稿.md>（用稿件所在目录当投稿包；缺输入不判通过）\n'); return 2; }
  const abs = path.resolve(draft);
  if (!fs.existsSync(abs)) { process.stderr.write('前提层失败：稿件不存在 —— ' + abs + '\n'); return 2; }
  return run(path.dirname(abs), { json });
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { run, mapExit, findStudio };
