#!/usr/bin/env node
/**
 * ai-prescreen —— 投稿前“先过 AI 审稿人”工作流门
 *
 * 来源：B站《现在发论文 要首先得到AI的认可》（BV1FCxe6AE4N，2026-11-02 蒸馏）
 *   视频流程（4 步）：
 *   1) 让 AI 当审稿人，把“能审出来的大问题”先改一遍；
 *   2) 用严格约束的提示词标出“AI 痕迹概率高”的句子（空话套话/无逻辑/跳跃写作），
 *      但**只标不改**——这些句子由作者自己改；
 *   3) 让 AI 整体润色，输出三版：改好的 / 带标注的 / 所有改动汇总；
 *   4) 根据修改记录生成 **AI 使用披露**（现在投稿只要用过 AI 就要求披露）。
 *
 * 本工具不计算“AI 率数字”（视频明确说不是一个具体 AI 率数字），只做：
 *   - 复用 ai-writing-check 的两类硬伤机检；
 *   - 检查稿内是否已有 AI 披露段；
 *   - 输出 4 步提示词模板（--prompts）。
 *
 * 用法：
 *   node bin/ai-prescreen.cjs --file <稿.md> [--json] [--prompts]
 *   node bin/ai-prescreen.cjs --selftest
 */
'use strict';
const fs = require('fs');
const aw = require('./ai-writing-check.cjs');

const DISCLOSURE = /(AI\s*(使用)?披露|AI\s*disclosure|生成式人工智能|生成式\s*AI|AI-assisted|AI\s*辅助|使用\s*AI|大模型辅助)/i;

const PROMPTS = `## 第 1 步：AI 当审稿人（只挑大问题）
你是《目标期刊》的资深审稿人。请只从“会被拒稿”的角度审这篇稿：
1) 贡献是否成立、是否足够新；2) 证据链是否支持结论；
3) 基线/对照是否公平；4) 可复现信息是否齐全；5) 伦理与 AI 披露是否合规。
逐条输出：问题 → 证据位置（行号/段落）→ 为什么致命 → 最小修改建议。不要重写全文。

## 第 2 步：标 AI 痕迹（只标不改）
只做标注，不要改写。找出以下句子并给出行号、原句、原因、建议（不要代写）：
- 空话套话：值得注意的是/众所周知/综上所述/显而易见等；
- 无逻辑：因果连接词前后没有证据；
- 跳跃写作：从背景直接跳到结论，缺必要推理步骤；
- 重复扩写：相邻句同义反复。
严格约束：不确定的不要标；每条必须引用原句；不得编造行号。

## 第 3 步：整体润色（输出三版）
在保持数据、引用、结论不变的前提下润色。输出：
A. 干净修订版；
B. 带修改标注的版本（标出每处改动与理由）；
C. 所有改动的汇总清单（原句 → 新句 → 理由）。
不得新增数据、引用或结论；不得删除限定条件。

## 附：防御性写作检查（视频原提示词，逐字）
${aw.DEFENSIVE_PROMPT}

## 第 4 步：生成 AI 使用披露
根据上面的修改记录，生成一段可直接放进论文的 AI 使用披露，必须包含：
工具/模型名称、用途（润色/翻译/代码/绘图等）、使用范围（哪些章节）、
人工复核方式、作者对全文内容负责的声明。
不要写“AI 参与了研究设计/数据分析/结论”除非确实发生。`;

function analyze(text) {
  const a = aw.analyze(text);
  const hasDisclosure = DISCLOSURE.test(String(text));
  const flags = [];
  if (a.filler.length) flags.push('空话套话 ' + a.filler.length + ' 处');
  if (a.redundant.length) flags.push('重复扩写 ' + a.redundant.length + ' 处');
  if (a.jumps.length) flags.push('跳跃/无证据结论 ' + a.jumps.length + ' 处');
  if (a.defensive && a.defensive.fuzzyDisclaimer.length) flags.push('模糊免责 ' + a.defensive.fuzzyDisclaimer.length + ' 处');
  if (!hasDisclosure) flags.push('缺 AI 使用披露');
  const status = a.status === 'FAIL' ? 'FAIL' : ((a.status === 'WARN' || !hasDisclosure) ? 'WARN' : 'PASS');
  return { status, hasDisclosure, flags, base: a };
}
function render(r) {
  const L = ['投稿前 AI 预审：' + r.status];
  L.push('  AI 披露：' + (r.hasDisclosure ? '已存在' : '未检测到'));
  if (r.flags.length) L.push('  待处理：' + r.flags.join('；'));
  L.push('  机检明细：');
  L.push(aw.render(r.base).split('\n').map((x) => '    ' + x).join('\n'));
  L.push('  ⇒ 视频流程：AI 审稿 → 标 AI 痕迹（只标不改）→ 三版润色 → 生成 AI 披露。');
  L.push('  ⇒ 用 --prompts 打印四步提示词；不计算“AI 率数字”，也不替代真实审稿。');
  return L.join('\n');
}
function selftest() {
  const good = '实验组准确率为 95%[1]。因此，该方法在本数据集上优于基线。\n\nAI 使用披露：本文使用大语言模型进行语言润色，作者对全文负责。';
  const bad = '值得注意的是，天气变冷了。因此，这很重要。';
  const goodR = analyze(good);
  const badR = analyze(bad);
  const checks = [
    ['正控：有证据+有披露 ⇒ PASS', goodR.status === 'PASS' && goodR.hasDisclosure],
    ['必失败：缺披露被抓', badR.hasDisclosure === false],
    ['必失败：废话/跳跃被抓', badR.flags.some((x) => x.includes('空话')) || badR.flags.some((x) => x.includes('跳跃'))],
    ['四步提示词齐全', ['第 1 步', '第 2 步', '第 3 步', '第 4 步'].every((x) => PROMPTS.includes(x))],
    ['原视频提示词已嵌入（含“模糊免责”）', PROMPTS.includes(aw.DEFENSIVE_PROMPT) && PROMPTS.includes('模糊免责')],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('ai-prescreen selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}
function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--prompts')) { console.log(PROMPTS); return 0; }
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const f = v('--file');
  if (!f) { console.error('前提层失败：需要 --file <稿>'); return 2; }
  if (!fs.existsSync(f)) { console.error('读不到文件：' + f); return 2; }
  const r = analyze(fs.readFileSync(f, 'utf8'));
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return r.status === 'PASS' ? 0 : 1;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyze, render, selftest, PROMPTS };
