#!/usr/bin/env node
/**
 * misflag —— **误判风险画像 + 具体化缺口清单**（★ 不是 AI 概率，不是"降 AI 率"）
 *
 * ★★ 定位（读代码前先读这段）：
 *   本工具**不预测 AI 概率**，也**不提供"降低检测分数"的改写**。
 *   它做的是：找出文本里**"缺乏作者特有内容"的位置**，并**要求作者补上只有他才知道的东西**
 *   （实验条件、样本量、失败模式、取舍理由、具体数值）。
 *
 *   为什么这样做：
 *   ① 检测器是黑箱（GPTZero 2023 秋起已转深度学习架构，阈值不公开）⇒ 对着分数调是追影子；
 *   ② 已证检测器系统性误判非母语写作（Liang et al. 2023, arXiv:2304.02819）⇒
 *      "像 AI"与"像非母语严谨写作"特征重叠，抹特征会连作者的表达一起抹掉；
 *   ③ 真正能长期站住的是**内容里有可核查的、只有作者才有的东西** ——
 *      这同时也是审稿人要看的东西。**补内容 ≠ 伪装。**
 *
 * 输出三层：
 *   A. 风险带（低/中/高）+ 依据（句长均匀度 / 模板密度 / 具体性密度）
 *   B. **具体化缺口清单**：逐段指出"这段没有任何数字/引用/条件"，并给出**该补什么**的问句
 *   C. 边界声明（每次必印）
 *
 * 用法：node bin/misflag.cjs --file <稿> [--json] | --selftest
 */
'use strict';
const fs = require('fs');

const TEMPLATE = [
  /it is worth noting/gi, /plays? a (?:crucial|vital|key|important) role/gi, /in order to/gi,
  /due to the fact that/gi, /furthermore/gi, /moreover/gi, /additionally/gi, /in summary/gi,
  /overall,/gi, /it should be noted/gi, /a growing number of/gi, /has attracted (?:much|increasing) attention/gi,
  /随着[^，。]{0,12}(?:的)?(?:快速)?发展/g, /值得注意的是/g, /综上所述/g, /总而言之/g,
  /具有(?:重要|深远)的?(?:理论|现实|实践)?意义/g, /在一定程度上/g, /越来越多的(?:学者|研究者)/g,
  /(?:广泛|深入)(?:地)?(?:关注|研究|探讨)/g, /取得了(?:一定|显著)的?(?:成果|进展)/g,
];

const sentences = (t) => String(t).split(/(?<=[.!?。！？])\s+|\n{2,}/).map((x) => x.trim()).filter((x) => x.length > 1);
const words = (t) => (String(t).match(/[A-Za-z]+(?:['-][A-Za-z]+)*|\d+(?:\.\d+)?|[\u4e00-\u9fff]/g) || []).length;
const paragraphs = (t) => String(t).split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x.length > 40);

function analyse(text) {
  const raw = String(text || '');
  const S = sentences(raw);
  const W = words(raw);
  if (!W) return { status: 'SKIP', why: '空文本 ⇒ 未核对（≠ 通过）' };
  const lens = S.map((s) => words(s));
  const avg = lens.reduce((a, b) => a + b, 0) / (lens.length || 1);
  const sd = Math.sqrt(lens.reduce((a, b) => a + (b - avg) ** 2, 0) / (lens.length || 1));

  let templateHits = [];
  for (const re of TEMPLATE) {
    re.lastIndex = 0;
    const m = raw.match(re);
    if (m) templateHits.push(...m.map((x) => x.trim()));
  }
  const tplPer100 = (templateHits.length / W) * 100;

  const numbers = (raw.match(/\d+(?:\.\d+)?%?/g) || []).length;
  const cites = (raw.match(/\[\d+(?:[,\-–]\d+)*\]|\\cite[a-z]*\{/g) || []).length;
  const units = (raw.match(/\d\s*(?:%|℃|mV|V|A|mAh|kW|Hz|mm|cm|km|kg|h|min|s\b|pages?\b)/g) || []).length;
  const acronyms = (raw.match(/\b[A-Z]{2,6}\b/g) || []).length;
  const spec = numbers + cites + units + acronyms;
  const specPer100 = (spec / W) * 100;

  const reasons = [];
  let score = 0;
  if (tplPer100 >= 3) { score += 2; reasons.push('模板/套话密度 ' + tplPer100.toFixed(1) + ' 处/百字（偏高）'); }
  else if (tplPer100 >= 1.5) { score += 1; reasons.push('模板/套话密度 ' + tplPer100.toFixed(1) + ' 处/百字（略高）'); }
  if (sd < 3) { score += 2; reasons.push('句长波动 SD=' + sd.toFixed(1) + '（过于均匀：人写作通常参差）'); }
  else if (sd < 4.5) { score += 1; reasons.push('句长波动 SD=' + sd.toFixed(1) + '（偏均匀）'); }
  if (specPer100 < 2) { score += 2; reasons.push('具体性密度 ' + specPer100.toFixed(1) + ' 个/百字（数字/引用/单位/缩写太少 ⇒ 断言偏泛化）'); }
  else if (specPer100 < 4) { score += 1; reasons.push('具体性密度 ' + specPer100.toFixed(1) + ' 个/百字（偏低）'); }
  const band = score >= 4 ? '高' : (score >= 2 ? '中' : '低');

  /* B. 具体化缺口：逐段找"零数字零引用零单位"的段，给出该补什么 */
  const asks = [];
  paragraphs(raw).forEach((p, i) => {
    const pw = words(p);
    const pspec = (p.match(/\d+(?:\.\d+)?%?/g) || []).length + (p.match(/\[\d+(?:[,\-–]\d+)*\]/g) || []).length
      + (p.match(/\d\s*(?:%|℃|mV|V|A|mAh|kW|Hz|mm|cm|km|kg)/g) || []).length;
    if (pw >= 40 && pspec === 0) {
      asks.push({ para: i + 1, words: pw, ask: '这段（约 ' + pw + ' 词）没有任何数字/引用/单位 ⇒ 请补：具体实验条件或样本量 · 关键数值或区间 · 失败模式或例外 · 你的取舍理由' });
    } else if (pw >= 40 && pspec / pw * 100 < 1) {
      asks.push({ para: i + 1, words: pw, ask: '这段具体性偏低（' + pspec + ' 个具体物 / ' + pw + ' 词）⇒ 可补一处数值或一条引用' });
    }
  });

  return {
    status: 'OK', band, score, reasons,
    metrics: { words: W, sentences: S.length, avgLen: Math.round(avg * 10) / 10, lenSD: Math.round(sd * 10) / 10, templateHits: templateHits.length, templatePer100: Math.round(tplPer100 * 10) / 10, specificityPer100: Math.round(specPer100 * 10) / 10, numbers, cites, units, acronyms },
    templateSamples: Array.from(new Set(templateHits)).slice(0, 8),
    asks,
    boundary: '这不是 AI 概率；本工具不做"降 AI 率"改写。检测器是黑箱且已证会误判非母语写作。',
  };
}

function render(r) {
  if (r.status === 'SKIP') return '误判风险画像：SKIP —— ' + r.why;
  const L = [];
  L.push('误判风险画像：' + r.band + '（score ' + r.score + '）—— **这不是 AI 概率**');
  L.push('  读数：' + r.metrics.words + ' 词 · ' + r.metrics.sentences + ' 句 · 句长均值 ' + r.metrics.avgLen + ' · SD ' + r.metrics.lenSD + ' · 模板 ' + r.metrics.templateHits + '（' + r.metrics.templatePer100 + '/百字）· 具体性 ' + r.metrics.specificityPer100 + '/百字');
  for (const x of r.reasons) L.push('  · ' + x);
  if (r.templateSamples.length) L.push('  模板命中示例：' + r.templateSamples.join(' / '));
  if (r.asks.length) {
    L.push('  ⇒ **具体化缺口（要你补，不是要你改词）**：');
    for (const a of r.asks) L.push('     · 第 ' + a.para + ' 段：' + a.ask);
  } else L.push('  ⇒ 没有发现"零具体物"的段落（未发现 ≠ 写得好；论证有效性仍属人读项）');
  L.push('  边界：' + r.boundary);
  return L.join('\n');
}

function selftest() {
  const cases = [];
  const ck = (name, fn) => { let r; try { r = fn(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ name, ok: r === true, d: r === true ? '' : String(r) }); };
  const vague = 'It is worth noting that artificial intelligence plays a crucial role in modern research. Furthermore, a growing number of studies have attracted much attention in this field. In summary, this area has important theoretical and practical significance, and future work should explore it more deeply.';
  const concrete = 'We cycled 30 NMC cells at 1C from 100% to 20% state of charge at 25 °C, and stopped a run when capacity fell below 1.8 Ah [12]. Three of the 30 runs ended early because the coolant loop tripped; those are reported separately. The gain over the baseline was 27% at 300 trees and 4% at 60 trees, so we fixed n_estimators=300.';
  ck('★套话密集 + 无具体物 ⇒ 风险带「高」且给出缺口问句', () => {
    const r = analyse(vague);
    return (r.band === '高' && r.asks.length >= 1 && r.metrics.templateHits >= 3) ? true : JSON.stringify(r.metrics) + ' band=' + r.band + ' asks=' + r.asks.length;
  });
  ck('正控：具体（数字/单位/引用/失败模式齐）⇒ 风险带「低」', () => {
    const r = analyse(concrete);
    return (r.band === '低') ? true : 'band=' + r.band + ' spec=' + r.metrics.specificityPer100 + ' sd=' + r.metrics.lenSD + ' tpl=' + r.metrics.templateHits;
  });
  ck('★必失败面：空文本 ⇒ SKIP（未核对 ≠ 通过）', () => {
    const r = analyse('   ');
    return (r.status === 'SKIP' && /未核对/.test(r.why)) ? true : JSON.stringify(r);
  });
  ck('中文模板命中（综上所述/值得注意的是）要被算进模板密度', () => {
    const zh = '随着人工智能技术的快速发展，AI 辅助写作已经受到越来越多的学者的广泛关注。值得注意的是，目前研究仍较少。综上所述，该问题具有重要的理论意义。';
    const r = analyse(zh);
    return (r.metrics.templateHits >= 3) ? true : JSON.stringify(r.metrics);
  });
  ck('★必失败面：回执必须自证「这不是 AI 概率」（防误用成"降 AI 率"）', () => {
    const out = render(analyse(vague));
    return (/这不是 AI 概率/.test(out) && /不做"降 AI 率"改写/.test(out)) ? true : out.slice(0, 120);
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nmisflag 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const i = argv.indexOf('--file'); const f = i >= 0 ? argv[i + 1] : '';
  if (!f || !fs.existsSync(f)) { console.error('前提层失败：需要 --file <稿>'); return 2; }
  const r = analyse(fs.readFileSync(f, 'utf8'));
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyse, render, selftest, TEMPLATE };
