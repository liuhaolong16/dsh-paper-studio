#!/usr/bin/env node
/**
 * presubmit-all —— **一条命令跑完投稿前全部机检**（把 5 个工具收成一个出口）
 *
 * 为什么需要：到了投稿这一步，要跑 5 件事（保真/查重/误判/声明/终稿），
 * 记 5 条命令、逐个读读数，本身就是出错源。本工具只做一件事：
 * **按顺序跑、汇总成一张表、给一个总结论**，并且**未核对项绝不冒充通过**。
 *
 * ★ 三态纪律：每条只有 PASS / WARN / FAIL / SKIP；**SKIP = 未核对 ≠ 通过**。
 * ★ 总结论：任一 FAIL ⇒ FAIL；否则任一 WARN ⇒ WARN；否则任一 SKIP ⇒ 未完全核对；
 *   全 PASS ⇒ PASS。**exit code：FAIL=1，其余=0**（WARN/SKIP 不阻断，但会显式列出）。
 *
 * 用法：
 *   node bin/presubmit-all.cjs --draft <稿> [--src <中英原文>] [--corpus <旧稿目录>] [--pkg <投稿包目录>] [--json]
 *   node bin/presubmit-all.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('node:child_process');

/** 总结论（纯函数，便于自检） */
function verdictOf(items) {
  if (items.some((x) => x.status === 'FAIL')) return 'FAIL';
  if (items.some((x) => x.status === 'WARN')) return 'WARN';
  if (items.some((x) => x.status === 'SKIP')) return '未完全核对';
  return 'PASS';
}

/** 从子工具的 stdout 里判状态：**只认它自己打印的判定词，不猜** */
function statusFrom(out, kind) {
  const t = String(out || '');
  if (kind === 'disclose') {
    if (/✔ 已有/.test(t)) return 'PASS';
    if (/✘ \*\*未发现\*\*|未发现/.test(t)) return 'WARN';   // 缺声明是"待补"，不是"稿件坏了"
    return 'SKIP';
  }
  if (kind === 'misflag') {
    if (/画像：SKIP/.test(t)) return 'SKIP';
    if (/画像：高/.test(t)) return 'WARN';                    // 风险高 = 提示，不是判死
    if (/画像：(低|中)/.test(t)) return 'PASS';
    return 'SKIP';
  }
  if (kind === 'plagself') {
    if (/预检：SKIP/.test(t)) return 'SKIP';
    if (/预检：FAIL/.test(t)) return 'FAIL';
    if (/预检：WARN/.test(t)) return 'WARN';
    if (/预检：PASS/.test(t)) return 'PASS';
    return 'SKIP';
  }
  if (kind === 'presubmit') {
    if (/放行/.test(t)) return /WARN/.test(t) ? 'WARN' : 'PASS';
    if (/不放行|FAIL/.test(t)) return 'FAIL';
    return 'SKIP';
  }
  if (kind === 'camera') {
    if (/判定：PASS/.test(t)) return /WARN\s*[1-9]/.test(t) ? 'WARN' : 'PASS';
    if (/判定：FAIL/.test(t)) return 'FAIL';
    return 'SKIP';
  }
  return 'SKIP';
}

const TIP = {
  disclose: '用 `disclose --draft <稿> --journal <刊> --tools <模型> --out <文件>` 生成，再按期刊原话核对',
  misflag: '看具体化缺口清单，按段落角色补内容（⚠ 声明段/说明段不用补数字）',
  plagself: '--corpus 只放**已发表/已投出**的作品；重合来自自引就补引用，来自转述不够就改结构',
  presubmit: '按第 1 关报告补回丢失的数字/引用/超参数，别靠换同义词',
  camera: '按 ERROR 项逐条修；WARN 项确认该刊是否要求',
};

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const draft = v('--draft');
  if (!draft || !fs.existsSync(draft)) { console.error('前提层失败：需要 --draft <稿>'); return 2; }
  const src = v('--src'); const corpus = v('--corpus'); const pkg = v('--pkg');
  const bin = __dirname;
  const run = (file, args) => {
    try { return execFileSync(process.execPath, [path.join(bin, file), ...args], { encoding: 'utf8', timeout: 900000 }); }
    catch (e) { return ((e.stdout || '') + (e.stderr || '')); }
  };
  const items = [];
  /* 顺序按"先查内容、再查合规、最后查包" */
  if (src && fs.existsSync(src)) {
    const out = run('polish.cjs', ['presubmit', '--src', src, '--out', draft]);
    items.push({ name: '保真出口（丢信息/LaTeX/指标/交付面）', tip: TIP.presubmit, status: statusFrom(out, 'presubmit'), detail: (out.split('\n').filter((l) => /^\s+[1-4]\)/.test(l)).map((l) => l.trim()).join(' · ') || '').slice(0, 160) });
  } else items.push({ name: '保真出口', status: 'SKIP', detail: '未给 --src（没有原文可比）' });
  if (corpus && fs.existsSync(corpus)) {
    const out = run('plagself.cjs', ['--new', draft, '--corpus', corpus]);
    items.push({ name: '查重预检（字面重合）', tip: TIP.plagself, status: statusFrom(out, 'plagself'), detail: (out.split('\n').find((l) => /n=\d+/.test(l)) || '').trim().slice(0, 160) });
  } else items.push({ name: '查重预检', status: 'SKIP', detail: '未给 --corpus（只放已发表作品）' });
  const mi = run('misflag.cjs', ['--file', draft]);
  items.push({ name: '误判风险画像（非 AI 概率）', tip: TIP.misflag, status: statusFrom(mi, 'misflag'), detail: (mi.split('\n').find((l) => /画像：/.test(l)) || '').trim().slice(0, 160) });
  const di = run('disclose.cjs', ['--check', '--draft', draft]);
  items.push({ name: 'AI 使用声明', tip: TIP.disclose, status: statusFrom(di, 'disclose'), detail: (di.split('\n')[0] || '').trim().slice(0, 160) });
  if (pkg && fs.existsSync(pkg)) {
    const out = run('camera-ready.cjs', ['--pkg', pkg, '--draft', draft]);
    items.push({ name: '终稿门（包级）', tip: TIP.camera, status: statusFrom(out, 'camera'), detail: (out.split('\n').find((l) => /ERROR \d+ · WARN/.test(l)) || '').trim().slice(0, 160) });
  } else items.push({ name: '终稿门', status: 'SKIP', detail: '未给 --pkg' });

  const overall = verdictOf(items);
  if (argv.includes('--json')) { console.log(JSON.stringify({ overall, items }, null, 2)); return overall === 'FAIL' ? 1 : 0; }
  console.log('投稿前自检 · 总表（' + path.basename(draft) + '）');
  for (const it of items) {
    console.log('  ' + (it.status === 'PASS' ? '✔' : it.status === 'WARN' ? '▲' : it.status === 'FAIL' ? '✘' : '·') + ' ' + it.status.padEnd(4) + ' ' + it.name + (it.detail ? '  — ' + it.detail : ''));
  }
  console.log('\n  总结论：**' + overall + '**' + (overall === 'PASS' ? '' : '（' + (overall === 'FAIL' ? '有硬失败项，改完再投' : overall === 'WARN' ? '无硬失败，但有需要你确认的项' : '有未核对项 —— **未核对 ≠ 通过**') + '）'));
  /* ★ 未给参数的 SKIP 不该印"怎么修"的提示（那是误导）——直接把它缺什么说清楚 */
  for (const it of items) {
    if (it.status === 'SKIP') { if (/^未给/.test(it.detail || '')) console.log('    · ' + it.name + ' ⇒ 未核对：' + it.detail + '（**未核对 ≠ 通过**）'); continue; }
    if (it.status === 'WARN' || it.status === 'FAIL') console.log('    · ' + it.name + ' ⇒ ' + (it.tip || '见对应工具回执'));
  }
  return overall === 'FAIL' ? 1 : 0;
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  ck('★必失败面：任一 FAIL ⇒ 总结论 FAIL（不许被 WARN/SKIP 稀释）', () => {
    const v = verdictOf([{ status: 'PASS' }, { status: 'FAIL' }, { status: 'SKIP' }]);
    return v === 'FAIL' ? true : v;
  });
  ck('★必失败面：只有 SKIP ⇒ 总结论"未完全核对"，**不是 PASS**', () => {
    const v = verdictOf([{ status: 'SKIP' }, { status: 'SKIP' }]);
    return v === '未完全核对' ? true : v;
  });
  ck('WARN 优先于 SKIP，但不得变成 FAIL', () => {
    const v = verdictOf([{ status: 'PASS' }, { status: 'WARN' }, { status: 'SKIP' }]);
    return v === 'WARN' ? true : v;
  });
  ck('正控：全 PASS ⇒ PASS', () => {
    const v = verdictOf([{ status: 'PASS' }, { status: 'PASS' }]);
    return v === 'PASS' ? true : v;
  });
  ck('★状态提取只认子工具自己打印的判定词（缺声明=WARN，不是 FAIL）', () => {
    const a = statusFrom('AI 使用声明检查：✘ **未发现**', 'disclose');
    const b = statusFrom('自我重复预检：FAIL（…）', 'plagself');
    const c = statusFrom('误判风险画像：SKIP —— 空文本', 'misflag');
    return (a === 'WARN' && b === 'FAIL' && c === 'SKIP') ? true : [a, b, c].join(',');
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\npresubmit-all 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { verdictOf, statusFrom, selftest };
