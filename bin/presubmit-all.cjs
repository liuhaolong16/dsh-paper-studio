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
  if (kind === 'absence') {
    if (/⇒\s*SKIP/.test(t)) return 'SKIP';                       // 未含缺席断言 / 分析笔记 ⇒ 未核对
    const m = t.match(/PASS (\d+) · WARN (\d+) · FAIL (\d+)/);
    if (m) { if (+m[3]) return 'FAIL'; if (+m[2]) return 'WARN'; return 'PASS'; }
    return 'SKIP';
  }
  if (kind === 'numcon') {
    if (/⇒\s*FAIL/.test(t)) return 'FAIL';
    if (/⇒\s*WARN/.test(t)) return 'WARN';
    if (/⇒\s*PASS/.test(t)) return 'PASS';
    return 'SKIP';
  }
  if (kind === 'deffirst') {
    if (/总判定：REVIEW/.test(t)) return 'WARN';                  // 启发式，要人看，不判死
    if (/总判定：OK/.test(t)) return 'PASS';
    return 'SKIP';
  }
  if (kind === 'absstr') {
    if (/⇒ REVIEW/.test(t)) return 'WARN';                       // 摘要强、正文未见限定：人读清单
    if (/⇒ OK/.test(t)) return 'PASS';
    return 'SKIP';                                               // 无摘要段 / 分析笔记 ⇒ 未核对
  }
  if (kind === 'tense') {
    if (/\[WARN\]/.test(t)) return 'WARN';                       // 做过的动作用现在时
    if (/\[INFO\]/.test(t)) return 'PASS';                       // 只出 INFO ⇒ 未触发
    return 'SKIP';
  }
  if (kind === 'paralogic') {
    if (/状态：\**ISSUES/.test(t)) return 'WARN';                 // 启发式弱机检：硬提示也只是提醒
    if (/状态：\**REVIEW/.test(t)) return 'WARN';
    if (/状态：\**OK/.test(t)) return 'PASS';
    return 'SKIP';                                               // SKIP／无可判段落
  }
  return 'SKIP';
}

const TIP = {
  disclose: '用 `disclose --draft <稿> --journal <刊> --tools <模型> --out <文件>` 生成，再按期刊原话核对',
  misflag: '看具体化缺口清单，按段落角色补内容（⚠ 声明段/说明段不用补数字）',
  plagself: '--corpus 只放**已发表/已投出**的作品；重合来自自引就补引用，来自转述不够就改结构',
  presubmit: '按第 1 关报告补回丢失的数字/引用/超参数，别靠换同义词',
  camera: '按 ERROR 项逐条修；WARN 项确认该刊是否要求',
  absence: '每个"无/没有/从未"句都要标档：〔缺席=未做〕/〔缺席=未报; 位置=…〕/〔缺席=未见; 检索=a*|b; 范围=p.x–y〕；未标注一律不过',
  numcon: '同指标出现两个不同值 ⇒ 在正文写一句同时交代两处（或统一）；单位要一致（0.86 与 86% 不是一回事）',
  deffirst: '**启发式**：R4 补一句「覆盖 X、不覆盖 Y」且含可核项；R6 把对象/对照/口径/判定四要素移到第一个结果数字之前。报 REVIEW 只是要人读，不等于稿子错',
  absstr: '**启发式**：摘要里的 strength 词（outperform/significantly/best/always…）都要在正文找到带范围/条件的句子；找不到就把范围补进正文，或把摘要降调',
  tense: '方法/结果节里**做过的动作**用过去时（we trained …）；`we propose/present` 与 `the results show` 属惯例现在时，不报',
  paralogic: '**启发式弱机检**：段过长就拆、段首断言要带支撑（数字/引用/图表/因果）、相邻段至少共享一个词；它不判断论证是否成立',
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
  /* ── 图谱反查带来的三个内容级门（v3.39–3.42 落地，v3.43.0 接入本出口）── */
  const ab = run('absence.cjs', ['--draft', draft]);
  items.push({ name: '缺席断言三档（未做/未报/未见）', tip: TIP.absence, status: statusFrom(ab, 'absence'), detail: (ab.split('\n').find((l) => /⇒|未含缺席断言|分析笔记/.test(l)) || '').trim().slice(0, 160) });
  const nc = run('number-consistency.cjs', ['--draft', draft]);
  items.push({ name: '承重数字一致·单位·表内列和', tip: TIP.numcon, status: statusFrom(nc, 'numcon'), detail: (nc.split('\n').find((l) => /⇒|无重复指标/.test(l)) || '').trim().slice(0, 160) });
  const df = run('definition-first.cjs', ['--draft', draft]);
  items.push({ name: '起首边界＋定义先行（启发式·需人读）', tip: TIP.deffirst, status: statusFrom(df, 'deffirst'), detail: (df.split('\n').filter((l) => /^[✔△·] /.test(l)).map((l) => l.trim()).join(' · ') || '').slice(0, 160) });
  const asg = run('abstract-strength.cjs', ['--draft', draft]);
  items.push({ name: '摘要强度≤正文限定（启发式·需人读）', tip: TIP.absstr, status: statusFrom(asg, 'absstr'), detail: (asg.split('\n').find((l) => /带强度词的摘要句|没找到摘要段/.test(l)) || '').trim().slice(0, 160) });
  /* ── v3.45.0 再补两项：此前它们只能单独跑 ── */
  const tc = run('tense-check.cjs', ['--draft', draft]);
  items.push({ name: '时态规范（做过的动作用过去时）', tip: TIP.tense, status: statusFrom(tc, 'tense'), detail: (tc.split('\n').filter((l) => /\[WARN\]|\[INFO\]/.test(l)).slice(0, 2).map((l) => l.trim()).join(' · ') || '未触发').slice(0, 160) });
  const pl = run('paragraph-logic.cjs', ['--draft', draft]);
  items.push({ name: '段落表层逻辑（启发式·需人读）', tip: TIP.paralogic, status: statusFrom(pl, 'paralogic'), detail: (pl.split('\n').find((l) => /^状态：/.test(l)) || '').trim().slice(0, 160) });
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
