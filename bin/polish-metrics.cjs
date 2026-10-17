#!/usr/bin/env node
/**
 * polish-metrics —— **润色质量的可测量代理**（不是"好不好看"，是"能不能量"）。
 *
 * 起因（2026-10-17 · 用户质问"我们的有他们好吗，而且我们真的有吗"）：
 *   Task A 真对拍只测了 4 个**机检维度**（不变量/AI味/可追溯/具体性），**没有测润色质量**；
 *   语言自然度当时是 **agent 自评、非盲评**。⇒ 判断"谁润得好"缺测量装置。
 *   本工具把可机检的语言代理固化下来，让"两版稿"可以**用同一把尺子量**、可复跑、可对比。
 *
 * 六项代理（都有明确阈值；**代理 ≠ 质量**，见文末边界）：
 *   M1 平均句长        阈值 12–28 词（<12 太碎 · >28 长句过多）
 *   M2 句长变异 SD     阈值 ≥3（全是同长句 ⇒ 读起来板）· 但 >18 说明"有一句长得离谱"
 *   M3 被动语态密度    阈值 ≤3%（每 100 词）
 *   M4 名词化密度      阈值 ≤4%（-tion/-ment/-ness/-ity/-ance/-ence 每 100 词）
 *   M5 AI 味短语       阈值 0（it is worth noting / in summary / plays a crucial role / delve into / leverage…）
 *   M6 词汇变异 TTR    阈值 ≥0.55（太低 ⇒ 重复用词）
 *
 * 用法：
 *   node bin/polish-metrics.cjs --file a.md [--vs b.md] [--json]
 *   node bin/polish-metrics.cjs --dir <目录>          # 目录内所有 .md 排名
 *   node bin/polish-metrics.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const AI = /\b(it is worth noting|in summary|with the rapid development|plays a (?:crucial|vital|key) role|delve(?:s|d)? into|leverage(?:s|d)?|a comprehensive understanding|notably)\b/gi;
const PASSIVE = /\b(?:is|are|was|were|be|been|being)\s+(?:\w+ly\s+)?\w+(?:ed|en)\b/gi;
const NOMINAL = /\b\w+(?:tion|sion|ment|ness|ity|ance|ence|ency|ancy)\b/gi;

function words(s) { return (String(s).match(/[A-Za-z0-9][A-Za-z0-9'’.\-]*/g) || []); }
function analyse(text) {
  const t = String(text || '');
  const w = words(t);
  const n = w.length || 1;
  const sents = t.split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x.length > 3);
  const lens = sents.map((s) => words(s).length);
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0;
  const sd = lens.length ? Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length) : 0;
  const passive = (t.match(PASSIVE) || []).length;
  const nominal = (t.match(NOMINAL) || []).length;
  const ai = (t.match(AI) || []).length;
  const ttr = new Set(w.map((x) => x.toLowerCase())).size / n;
  const per100 = (x) => Math.round((x / n) * 1000) / 10;
  const m = {
    words: n, sentences: sents.length,
    avgLen: Math.round(mean * 10) / 10, lenSD: Math.round(sd * 10) / 10,
    passive, passivePct: per100(passive), nominal, nominalPct: per100(nominal),
    aiPhrases: ai, ttr: Math.round(ttr * 1000) / 1000, longest: lens.length ? Math.max.apply(null, lens) : 0,
  };
  const flags = [];
  if (m.sentences === 0) flags.push({ level: 'SKIP', id: 'M1', msg: '未切出句子 ⇒ 指标未核' });
  else if (m.avgLen < 12) flags.push({ level: 'WARN', id: 'M1', msg: '平均句长 ' + m.avgLen + ' 词 < 12 ⇒ 句子太碎' });
  else if (m.avgLen > 28) flags.push({ level: 'WARN', id: 'M1', msg: '平均句长 ' + m.avgLen + ' 词 > 28 ⇒ 长句过多' });
  if (m.sentences > 2 && m.lenSD < 3) flags.push({ level: 'WARN', id: 'M2', msg: '句长变异 SD=' + m.lenSD + ' < 3 ⇒ 节奏板' });
  if (m.lenSD > 18) flags.push({ level: 'WARN', id: 'M2', msg: '句长变异 SD=' + m.lenSD + ' > 18 ⇒ 有一句长得离谱（最长 ' + m.longest + ' 词）' });
  if (m.passivePct > 3) flags.push({ level: 'WARN', id: 'M3', msg: '被动密度 ' + m.passivePct + '% > 3%' });
  if (m.nominalPct > 4) flags.push({ level: 'WARN', id: 'M4', msg: '名词化密度 ' + m.nominalPct + '% > 4% ⇒ 名词堆叠、动词被埋' });
  if (m.aiPhrases > 0) flags.push({ level: 'WARN', id: 'M5', msg: 'AI 味短语 ' + m.aiPhrases + ' 处' });
  if (m.ttr < 0.55) flags.push({ level: 'WARN', id: 'M6', msg: '词汇变异 TTR=' + m.ttr + ' < 0.55 ⇒ 用词重复' });
  return { metrics: m, flags, status: flags.some((f) => f.level === 'WARN') ? 'REVIEW' : 'OK' };
}

const ROW = (a) => [a.words, a.sentences, a.avgLen, a.lenSD, a.passivePct, a.nominalPct, a.aiPhrases, a.ttr, a.longest];

function render(list) {
  const L = ['| 稿件 | 词数 | 句数 | 平均句长 | 句长SD | 被动% | 名词化% | AI味 | TTR | 最长句 |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const x of list) { const m = x.metrics; L.push('| ' + x.name + ' | ' + m.words + ' | ' + m.sentences + ' | ' + m.avgLen + ' | ' + m.lenSD + ' | ' + m.passivePct + ' | ' + m.nominalPct + ' | ' + m.aiPhrases + ' | ' + m.ttr + ' | ' + m.longest + ' |'); }
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  /* ★夹具必须落在阈值区间内（又一次教训）：平均 12–28 词 · SD 3–18 · 名词化 ≤4% · 无 AI 味 */
  const GOOD = 'We ran thirty cells at one degree Celsius and repeated every run five times to make sure the gain was not a fluke. The gain reaches twenty-seven percent. Choosing fewer inputs cut the error roughly in half, which surprised us and changed how we frame the whole protocol.';
  const NOMIN = 'The implementation of the optimization of the configuration of the evaluation of the estimation of the degradation of the capacity is performed by the utilization of the accumulation of the information.';
  const AI = 'It is worth noting that this plays a crucial role. In summary, we delve into the results.';
  const PASS = 'The model was trained by us and the results are evaluated by experts and the data are normalized by the preprocessing pipeline.';

  ck('正控：短平快文本 ⇒ OK（不误报）', () => (analyse(GOOD).status === 'OK' ? true : JSON.stringify(analyse(GOOD).flags)));
  ck('★名词化堆叠 ⇒ M4 WARN（>4%）', () => analyse(NOMIN).flags.some((f) => f.id === 'M4') ? true : JSON.stringify(analyse(NOMIN).metrics));
  ck('★AI 味短语 ⇒ M5 WARN（阈值 0）', () => analyse(AI).flags.some((f) => f.id === 'M5') ? true : JSON.stringify(analyse(AI).metrics));
  ck('★被动密度高 ⇒ M3 WARN（>3%）', () => analyse(PASS).flags.some((f) => f.id === 'M3') ? true : JSON.stringify(analyse(PASS).metrics));
  ck('★长句过多 ⇒ M1 WARN（平均 >28 词）', () => {
    const long = Array(40).fill('word').join(' ') + '. '; const t = long + long;
    return analyse(t).flags.some((f) => f.id === 'M1') ? true : JSON.stringify(analyse(t).metrics);
  });
  ck('★句长全相同 ⇒ M2 WARN（SD<3，节奏板）', () => {
    const t = Array(6).fill('One two three four five six seven eight.').join(' ');
    return analyse(t).flags.some((f) => f.id === 'M2') ? true : JSON.stringify(analyse(t).metrics);
  });
  ck('空稿 ⇒ 不崩，标 SKIP（未核）', () => (analyse('').flags.some((f) => f.level === 'SKIP') ? true : JSON.stringify(analyse(''))));

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\npolish-metrics 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const list = [];
  const one = val('--file');
  if (one) {
    const p = path.resolve(one);
    if (!fs.existsSync(p)) { console.error('前提层失败：文件不存在 —— ' + p); return 2; }
    list.push(Object.assign({ name: path.basename(p) }, analyse(fs.readFileSync(p, 'utf8'))));
    const vs = val('--vs');
    if (vs && fs.existsSync(path.resolve(vs))) list.push(Object.assign({ name: path.basename(vs) }, analyse(fs.readFileSync(path.resolve(vs), 'utf8'))));
  }
  const dir = val('--dir');
  if (dir) {
    const d = path.resolve(dir);
    if (!fs.existsSync(d)) { console.error('前提层失败：目录不存在 —— ' + d); return 2; }
    for (const f of fs.readdirSync(d).filter((x) => /\.(md|tex|txt)$/i.test(x)).sort()) {
      list.push(Object.assign({ name: f }, analyse(fs.readFileSync(path.join(d, f), 'utf8'))));
    }
  }
  if (!list.length) { console.error('前提层失败：需要 --file <稿> [--vs <另一稿>] 或 --dir <目录>'); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(list, null, 2)); return 0; }
  console.log(render(list));
  for (const x of list) for (const f of x.flags) console.log('  [' + f.level + '/' + f.id + '] ' + x.name + '：' + f.msg);
  console.log('\n> **代理指标 ≠ 润色质量**：这六项只抓"可机检的坏习惯"（长句/名词化/被动/AI 味/重复），');
  console.log('>  **不代表读起来更好**；真正的质量判断需要**盲评**（独立判者，非本 agent）。');
  console.log('>  本轮补这条工具的直接原因：Task A 的"语言自然度"当时是 agent 自评、非盲评。');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { analyse, render, words, main, selftest, AI, PASSIVE, NOMINAL };
