#!/usr/bin/env node
/**
 * stylecheck — 写作质量机械检查（V2.9 · 外部吸收 ARIS `writing-principles.md`，MIT）
 *
 * 立场（沿用本仓纪律）：**只做可机检的那部分，语义判断留给跨模型 reviewer**。
 *   HARD（阻断级）：**低信息开头**（"In recent years…" / "Large language models have achieved…"）
 *     —— 原文判词：「这类开场**携带的信息量太少**，无法帮审稿人判断本文的具体贡献」。
 *   SOFT / INFO（只报，不改稿）：低信息填充词 · 过度 hedging · 模糊词（无数字配对的 performance/improves/large/fast）
 *     · 术语混用（model/network/architecture 三名并用）· **贡献句缺失**（一句话贡献测试）
 *     · **摘要无定量结果**（五句公式要求至少一个量化结果）· 贡献条数不等于 2–4。
 *
 * 为什么值得机械化：审稿人的阅读顺序是 **标题 → 摘要 → 引言 → 图（尤其图 1）→ 其余**，
 * 而「大约一半的力气该花在摘要/引言/图上」—— 这些位置的低级缺陷**代价最大、又最容易机检**。
 *
 * 用法：node bin/stylecheck.cjs --draft <稿.md> [--json] [--selftest]
 * 退出码：0 = 无 HARD · 1 = 有 HARD（低信息开头）· 2 = 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const FORBIDDEN_OPENING = /^(in recent years|recently,?\s+(deep|machine)\s+learning|large language models have|deep learning has|neural networks have|with the rapid development|近年来|随着(深度|机器)学习|众所周知)/i;
const FILLERS = /\b(actually|very|really|quite|basically|essentially)\b|(?<![A-Za-z])(Importantly|Notably),|It is worth noting that|值得注意的是|众所周知/gi;
const HEDGES = /\b(may|might|potentially|could)\b/gi;
const VAGUE = /\b(performance|improves?|improvement|large|fast|good results?|robust)\b/gi;
const TERMS = { model: /\bmodels?\b/gi, network: /\bnetworks?\b/gi, architecture: /\barchitectures?\b/gi };
// ★ 2026-10-14：首版把动词限定为 prove|show|demonstrate|… ⇒ 真稿里「We **quantify** where…」被误判成"贡献句缺失"。
//   贡献句的机检是**存在性检查**（有没有一句"我们做了什么"），不是质量检查 ⇒ 放宽为「第一人称 + 任意动作动词」。
const CONTRIB = /(\bwe\s+(?!are\b|were\b|have\b|has\b|had\b|can\b|could\b|may\b|might\b|do\b|did\b|also\b|therefore\b|thus\b|however\b)[a-z]+)|(本文(提出|证明|发现|给出|建立|量化))|(我们(提出|证明|发现|给出|量化))/i;

/** ★ 词表对外导出：出厂审查（`audit.cjs`）用它做**真集合比对**，而不是在文件文本里搜词（那会把注释也算进去）。 */
const WORD_LISTS = { FORBIDDEN_OPENING, FILLERS, HEDGES, VAGUE, CONTRIB };

/** 取某一节正文（从 `#/## <name>` 到下一个同级或更高级标题）。取不到返回 null。 */
function section(text, name) {
  const lines = text.split(/\r?\n/);
  const re = new RegExp('^#{1,3}\\s*' + name + '\\s*$', 'i');
  let start = -1; let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i].trim())) { start = i + 1; level = (lines[i].match(/^#+/) || ['#'])[0].length; break; }
  }
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) break;
    out.push(lines[i]);
  }
  return { body: out.join('\n'), startLine: start + 1 };
}

function firstParagraph(text) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s || s.startsWith('#') || s.startsWith('>') || s.startsWith('---')) continue;
    return { text: s, line: i + 1 };
  }
  return null;
}

function countAll(text, re) { const m = String(text).match(re); return m ? m.length : 0; }

/** 主检查。返回 { hard:[], soft:[], info:[] }。 */
function check(text) {
  const hard = []; const soft = []; const info = [];
  const abs = section(text, 'Abstract') || section(text, '摘要');
  const intro = section(text, 'Introduction') || section(text, '引言') || section(text, '1. Introduction');
  const absBody = abs ? abs.body : '';
  const introBody = intro ? intro.body : '';

  // HARD ①：低信息开头（摘要或正文首段）
  for (const [where, target] of [['摘要', absBody], ['正文首段', text]]) {
    if (!target) continue;
    const fp = firstParagraph(target);
    if (fp && FORBIDDEN_OPENING.test(fp.text)) {
      hard.push({ rule: 'low-info-opening', where, line: (where === '摘要' && abs ? abs.startLine - 1 : fp.line), text: fp.text.slice(0, 120) });
    }
  }

  // SOFT：低信息填充词
  const fr = [];
  text.split(/\r?\n/).forEach((ln, i) => { const m = ln.match(FILLERS); if (m) fr.push({ line: i + 1, hits: m }); });
  if (fr.length) soft.push({ rule: 'filler-words', count: fr.reduce((a, x) => a + x.hits.length, 0), samples: fr.slice(0, 5) });

  // SOFT：过度 hedging（只统计，不判对错 —— 有真实不确定时该用）
  const hc = countAll(text, HEDGES);
  if (hc > 0) soft.push({ rule: 'hedging', count: hc, note: 'may/might/potentially/could —— 原文：过度 hedging 读起来像自我怀疑而非严谨；**仅当不确定是真实的**才保留' });

  // SOFT：模糊词（无数字配对）
  const vv = [];
  text.split(/\r?\n/).forEach((ln, i) => { if (VAGUE.test(ln) && !/\d/.test(ln)) { vv.push({ line: i + 1, text: ln.trim().slice(0, 100) }); } VAGUE.lastIndex = 0; });
  if (vv.length) soft.push({ rule: 'vague-terms-without-numbers', count: vv.length, samples: vv.slice(0, 4), note: '原文对照表：performance→accuracy/F1/latency · improves→increases by X% · large→1B parameters · fast→3x faster' });

  // INFO：术语混用
  const tc = {}; for (const [k, re] of Object.entries(TERMS)) tc[k] = countAll(text, re);
  if (tc.model && tc.network && tc.architecture) info.push({ rule: 'terminology-mixing', counts: tc, note: '同一个概念别换名（model / network / architecture 三名并用）；选一个并保持稳定' });

  // SOFT：一句话贡献（摘要或引言里必须能找到贡献句）
  const hasContrib = CONTRIB.test(absBody) || CONTRIB.test(introBody);
  if (!hasContrib) soft.push({ rule: 'one-sentence-contribution-missing', note: '原文：**写不出一句话贡献，说明框架还没收敛**；可写形式如「We prove that X converges under Y」/「We show A improves B by 15% on C」/「We identify failure D and propose mechanism E」' });

  // SOFT：摘要缺定量结果
  if (absBody) {
    if (!/\d/.test(absBody)) soft.push({ rule: 'abstract-without-quantitative-result', note: '五句公式第 5 句＝**读者该记住的数字/结果**；摘要里至少要有一个显式量化结果' });
  } else info.push({ rule: 'abstract-not-found', note: '没找到 `## Abstract`（或 `## 摘要`）小节 ⇒ 该项跳过，不当成通过' });

  // INFO：贡献条数（★ 如实统计**整节** bullet/编号行并标注含子列表 ——
  //   首版想"只数第一段连续块"，但真实文档的列表项常是「bullet 行 + 下一行说明」，启发式不成立 ⇒ 不假装精度）
  if (introBody) {
    const n = introBody.split(/\r?\n/).filter((l) => /^\s*([-*]|\d+\.)\s+\S/.test(l)).length;
    info.push({ rule: 'contribution-bullets', count: n, note: '**按整节统计（含子列表，如 RQ 清单）**，仅供参考；贡献本身建议 **2–4 条**、具体且可否证、每条 1–2 行（"We study problem X" 这类无法被同意/反对/质疑的不算）' });
  }
  return { hard, soft, info };
}

function render(r, file) {
  console.log(`写作质量机械检查（真源：ARIS writing-principles.md · 机械部分）`);
  console.log(`稿件：${file}`);
  console.log(`HARD ${r.hard.length} · SOFT ${r.soft.length} · INFO ${r.info.length}`);
  for (const h of r.hard) console.log(`  ✘ [HARD/${h.rule}] ${h.where} L${h.line}：${h.text}`);
  for (const s of r.soft) console.log(`  · [SOFT/${s.rule}]${s.count !== undefined ? ' ×' + s.count : ''}${s.note ? ' —— ' + s.note : ''}`);
  for (const i of r.info) console.log(`  · [INFO/${i.rule}]${i.count !== undefined ? ' ' + i.count : ''}${i.note ? ' —— ' + i.note : ''}`);
  console.log('  判据：**只有"低信息开头"是 HARD**；其余是提示（原文：过度 hedging/模糊词在"不确定真实存在"时是合法的）—— 语义判断留给跨模型 reviewer。');
}

function runSelftest() {
  const results = [];
  const check_ = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };
  const bad = `# Title

## Abstract

In recent years, deep learning has achieved remarkable success. We do a lot of good results.

## Introduction

We study problem X. performance is very good.
`;
  const clean = `# Title

## Abstract

We prove that the sampler converges linearly under bounded variance. Unlike prior work we bound the constant explicitly. Our analysis reduces the update to a two-term recurrence. We validate on three datasets and observe agreement to 2.1%. Compared with the baseline we reduce error by 15%.

## Introduction

Sampling is the bottleneck. Prior work assumes bounded gradients, which fails at scale. We relax that assumption.

- We prove linear convergence without bounded gradients.
- We reduce error by 15% on three datasets.
`;
  // 贡献句"存在性"检查的正控：**通篇没有第一人称动作句**（新语义下 "We study X" 已算存在 ⇒ 不能用它做正控）
  const noContrib = `# Title

## Abstract

This work explores a phenomenon and reports observations from a dataset. Results are discussed.

## Introduction

The problem is introduced. Prior work is summarized.
`;
  check_('正控 · 低信息开头必须判 HARD', () => {
    const r = check(bad);
    return r.hard.length >= 1 && r.hard[0].rule === 'low-info-opening' ? true : JSON.stringify(r.hard);
  });
  check_('正控 · 填充词/模糊词/摘要无数字都要报出来（贡献句另有专门正控）', () => {
    const r = check(bad);
    const rules = r.soft.map((x) => x.rule);
    const need = ['filler-words', 'vague-terms-without-numbers', 'abstract-without-quantitative-result'];
    const miss = need.filter((n) => !rules.includes(n));
    return miss.length === 0 ? true : `漏报：${miss.join(' / ')}（实报 ${rules.join(',')}）`;
  });
  check_('正控 · 通篇没有第一人称动作句 ⇒ 必须报"贡献句缺失"（存在性检查的真实正控）', () => {
    const r = check(noContrib);
    return r.soft.some((x) => x.rule === 'one-sentence-contribution-missing') ? true : JSON.stringify(r.soft.map((x) => x.rule));
  });
  check_('★ 反控 · 干净稿不得报 HARD、不得误报贡献句缺失/摘要无数字', () => {
    const r = check(clean);
    const rules = r.soft.map((x) => x.rule);
    const bad2 = (r.hard.length ? 'HARD ' + JSON.stringify(r.hard) : '') + (rules.includes('one-sentence-contribution-missing') ? ' 误报贡献句缺失' : '') + (rules.includes('abstract-without-quantitative-result') ? ' 误报摘要无数字' : '');
    return bad2 === '' ? true : bad2;
  });
  check_('边界 · 没有 Abstract 小节时必须报 INFO（不许当成通过）', () => {
    const r = check('# T\n\n## Introduction\n\nWe prove X.\n');
    return r.info.some((i) => i.rule === 'abstract-not-found') ? true : JSON.stringify(r.info);
  });
  check_('★ 反控（真实误报转来的夹具）· "We quantify where…" 这类非白名单动词不得被判"贡献句缺失" —— 真稿实测踩到', () => {
    const r = check(`# T

## Abstract

We quantify where early-cycle features stop transferring. We assembled a verified subset of 26 cells.

## Introduction

Background here.
`);
    const rules = r.soft.map((x) => x.rule);
    return rules.includes('one-sentence-contribution-missing') ? '仍然误报' : true;
  });
  check_('★ 反控（真实误报转来的夹具）· bullet 计数按整节如实统计（3 + 2 = 5），并**标注含子列表**（不假装"只数第一个块"）', () => {
    const r = check(`# T

## Abstract

We prove X under Y with a bound of 2.1%.

## Introduction

Text.

- c1

- c2

- c3

Then prose.

1. RQ1 what?
2. RQ2 what?
`);
    const it = r.info.find((i) => i.rule === 'contribution-bullets');
    return it && it.count === 5 && /含子列表/.test(it.note) ? true : `count=${it && it.count} note=${it && it.note}`;
  });
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\nstylecheck 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const i = argv.indexOf('--draft');
  const file = i > -1 ? argv[i + 1] : null;
  if (!file || !fs.existsSync(file)) { console.error('前提层失败：需要 --draft <存在的稿.md>'); return 2; }
  const text = fs.readFileSync(file, 'utf8');
  const r = check(text);
  if (argv.includes('--json')) console.log(JSON.stringify({ file, hard: r.hard, soft: r.soft, info: r.info, exit: r.hard.length ? 1 : 0 }, null, 2));
  else render(r, file);
  return r.hard.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { check, section, firstParagraph, FORBIDDEN_OPENING, WORD_LISTS, main };
