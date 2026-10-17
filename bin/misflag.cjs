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

/** ★ 段落角色：决定"该补什么"——统一一句"补具体物"没有指导价值。
    用关键词打分（各角色互斥取最高），拿不准就归 'other'（仍会列出，只给通用建议）。 */
const ROLE_RULES = [
  /* ★ 真稿逼出来的两条：声明段与设计说明段**天然没有数字**，把它们当"缺陷"是误报。
     真数据里论文 A 的 6 个"零具体物"段落中，至少 4 段是这类。 */
  ['declaration', /\b(no ai (?:tool|system)|ai[- ]assisted|ethic|data availability|competing interest|consent|declaration)\b/i, /(声明|利益冲突|数据可用|伦理|未使用)/],
  ['rationale', /\b(framework|deliberately|design (?:choice|rationale)|scope|exclud\w+|criterion|constraint|conceptual)\b/i, /(框架|有意|范围|不测|判据|约束)/],
  ['limitation', /\b(limitation|limited|caveat|future work|shortcoming|remains? (?:unclear|open))\b/i, /(局限|不足|未来工作|有待)/],
  ['method', /\b(we (?:used|use|trained|collected|measured|ran|set|fixed)|dataset|procedure|protocol|hyper-?parameter|parameter)\b/i, /(方法|实验|数据集|参数|流程)/],
  ['result', /\b(results?|we (?:found|observed|obtained|report)|achiev|outperform|improv\w+|reduc\w+)\b/i, /(结果|我们发现|提升|下降|优于)/],
  ['background', /\b(has (?:been|become)|over the past|in recent years|plays? a|widely)\b/i, /(近年来|随着|广泛|重要性)/],
];
function classifyPara(p) {
  let best = 'other'; let bestScore = 0;
  for (const [role, reEn, reZh] of ROLE_RULES) {
    const s = ((p.match(reEn) || []).length) + ((p.match(reZh) || []).length) * 2;
    if (s > bestScore) { bestScore = s; best = role; }
  }
  return best;
}
const ROLE_ASK = {
  limitation: '补**具体**的失败模式或例外（哪一组/哪种工况失效、差多少），而不是"有一定局限"',
  method: '补**实验条件与样本量**（温度/倍率/截止电压/单元数/重复次数），或**超参数与选取理由**',
  result: '补**关键数值与区间**（提升多少 %、标准差、p 值或效应量），并指出对照基线',
  background: '补**一条具体文献或一个具体事实**（谁在什么条件下报告了什么），或**删掉这句泛化陈述**',
  declaration: '**这类段落通常不该塞数字** ⇒ 只需确认：声明是否完整（工具名/范围/未参与内容）、是否有伦理或数据可用性要求被漏掉；按刊要求补一句"不适用"即可',
  rationale: '**这类段落也不该塞数字** ⇒ 若怕审稿人问"凭什么这样定"，补**一条方法学依据或标准编号**，或写清"依据是 X，代价是 Y"的取舍',
  other: '补一处作者特有的事实：数值 / 条件 / 取舍理由 / 一条支撑文献',
};

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
    if (pw >= 40 && (pspec === 0 || pspec / pw * 100 < 1)) {
      /* ★ 角色感知：同一个"补具体物"对方法段/局限段/背景段的含义完全不同，
         统一话术等于没指导。锚点取首 18 词，作者才能定位到那一段。 */
      const role = classifyPara(p);
      const anchor = p.replace(/\s+/g, ' ').split(' ').slice(0, 18).join(' ');
      asks.push({ para: i + 1, words: pw, spec: pspec, role, anchor, ask: ROLE_ASK[role] || ROLE_ASK.other });
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
    for (const a of r.asks) L.push('     · 第 ' + a.para + ' 段（' + a.words + ' 词 · 角色 ' + a.role + '）：' + a.ask + '\n       锚点：' + a.anchor + '…');
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
  ck('★角色识别：方法段/局限段/结果段/背景段各归其位（提示才对得上段）', () => {
    const m = classifyPara('We trained the model on 30 cells with n_estimators=300 under a fixed protocol.');
    const l = classifyPara('A limitation of this work is that future work should extend it to low temperature.');
    const r2 = classifyPara('Results show we obtained a 27% improvement over the baseline in all runs.');
    const b = classifyPara('Over the past decade this topic has become widely studied and plays a key role.');
    return (m === 'method' && l === 'limitation' && r2 === 'result' && b === 'background') ? true : [m, l, r2, b].join(',');
  });
  ck('★必失败面：零具体物段落必须进清单且带锚点（锚点为空 = 作者找不到那段）', () => {
    const r = analyse('Over the past decade battery health prediction has become widely studied and plays a key role in industry applications everywhere, and many groups have proposed pipelines that combine signal processing with machine learning models of varying complexity and ambition across a wide range of conditions. ');
    return (r.asks.length >= 1 && r.asks[0].anchor.split(' ').length >= 8 && /补/.test(r.asks[0].ask)) ? true : JSON.stringify(r.asks);
  });
  ck('★必失败面：AI 声明段/设计说明段零数字是**正常**的，不得建议塞数字', () => {
    const decl = analyse('During the preparation of this work the author used DeepSeek (an AI-assisted technology) in order to draft and polish the language of this manuscript, and the author reviewed and edited the content as needed and takes full responsibility for the final text as published. No generative tool produced any result, number, or conclusion reported here, and the author confirms that all analyses were performed with the deposited scripts.');
    const rat = analyse('This study uses a conceptual framework, not a theoretical one, and the distinction is worth stating explicitly because reviewers often assume that a conceptual framework must be validated against measured variables, which this design deliberately excludes in order to keep the scope of the claim identical to the scope of the evidence actually collected.');
    const bads = [decl, rat].filter((r) => (r.asks || []).some((a) => /补\*\*实验条件与样本量\*\*/.test(a.ask)));
    return (bads.length === 0 && (decl.asks || []).length + (rat.asks || []).length >= 0) ? true : JSON.stringify(bads.map((r) => r.asks));
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
