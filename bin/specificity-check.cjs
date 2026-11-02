#!/usr/bin/env node
/**
 * specificity-check —— 写作具体化预检（**不是 AI 检测规避工具**）
 *
 * 背景：知网 AIGC 报告是字符级标红，不能从报告反推模型；插件政策
 * `no_ai_detection_evasion: true` 明确禁止做“降 AI 率”工具。
 *
 * 本工具只做一件事：找出“长句 / 模板句 / 无证据”的泛化段，提示把
 * 论述具体化（加实验细节、对比对象、数字、引用、拆句）。它不预测
 * 知网分数，也不提供同义词替换/洗稿/规避检测的功能。
 *
 * 用法：
 *   node bin/specificity-check.cjs --file <稿.md|txt|tex> [--out <报告.md>] [--max 0.20] [--json] [--strict]
 *   node bin/specificity-check.cjs --prompt
 *   node bin/specificity-check.cjs --selftest
 *
 * 退出码：0=完成（未超阈值） 1=--strict 且超阈值 2=前提层失败
 */
'use strict';
const fs = require('fs');
const path = require('path');

const TEMPLATES = [
  '综上所述', '值得注意的是', '本文旨在', '不难发现', '显而易见',
  '不仅', '而且', '随着', '前者', '后者', '一方面', '另一方面',
  '不是', '而是', '我们认为', '本文认为', '可以看出', '由此可见',
];

const SECTION_RISK = [
  /摘要|abstract/i,
  /范围|计量|scope|metric/i,
  /讨论|discussion/i,
  /局限|limitation|boundary/i,
  /结论|conclusion/i,
];

const EVIDENCE_RX = /[0-9０-９]|图\s*\d|表\s*\d|\[\s*\d/;

const REWRITE_PROMPT = [
  '请对我给的正文做“具体化”编辑，不要做同义词替换，也不要编造数据。',
  '逐段标出三类段落：',
  '1) 平均句长>45字或单句>70字；',
  '2) 含两个以上模板句（综上所述/值得注意的是/本文旨在/不是…而是…/不仅…而且…/随着…的发展/前者…后者…）；',
  '3) 整段没有数字、没有[n]引用、没有图/表号。',
  '对命中≥2条的段落，按下面顺序改：',
  'a. 补一个实验细节（样本数/温度/阈值/失败记录）；',
  'b. 补一个具体对比对象（作者+年份+他们做了什么）；',
  'c. 拆长句；d. 删模板连接词。',
  '找不到的细节标“待补”，不要用形容词或同义词充数。',
].join('\n');

function stripFrontMatter(raw) {
  return String(raw || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
}

function stripAuthorTable(raw) {
  const m = String(raw).match(/^\s*#\s+/m);
  return m ? raw.slice(m.index) : raw;
}

function stripReferences(raw) {
  const lines = String(raw).split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    if (/^\s*#{0,6}\s*参考文献\s*$/.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

function cleanInline(s) {
  return String(s || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`[^`]*`/g, '')
    .replace(/[*_~#>]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function paragraphs(raw) {
  const text = stripReferences(stripAuthorTable(stripFrontMatter(raw)));
  const out = [];
  let heading = '';
  let buf = [];
  const flush = () => {
    const b = buf.join('\n').trim();
    buf = [];
    if (!b) return;
    if (/^\*\*(?:Cross-Temperature|Keywords|Key words)/i.test(b)) return;
    const textOnly = cleanInline(b);
    if (textOnly.length < 20) return;
    out.push({ heading, text: textOnly });
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6}\s+/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?])\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sectionRisk(heading) {
  return SECTION_RISK.some((rx) => rx.test(heading || ''));
}

function analyze(raw, source = '') {
  const ps = paragraphs(raw);
  const rows = [];
  for (let i = 0; i < ps.length; i += 1) {
    const t = ps[i].text;
    const ss = sentences(t);
    const lens = ss.map((s) => s.length);
    const avg = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : t.length;
    const mx = lens.length ? Math.max(...lens) : t.length;
    const flags = [];
    if (mx > 70 || avg > 45) flags.push('长句');
    const tpl = TEMPLATES.filter((w) => t.includes(w));
    if (tpl.length >= 2) flags.push('模板句');
    if (!EVIDENCE_RX.test(t)) flags.push('无证据');
    const sec = sectionRisk(ps[i].heading);
    const risk = flags.length >= 2 || (sec && flags.length >= 1);
    rows.push({
      i: i + 1,
      heading: ps[i].heading || '—',
      chars: t.length,
      sentences: ss.length,
      avg: Math.round(avg * 10) / 10,
      max: mx,
      flags,
      templateHits: tpl,
      sectionRisk: sec,
      risk,
      preview: t.slice(0, 72),
    });
  }
  const total = rows.reduce((a, r) => a + r.chars, 0);
  const riskChars = rows.filter((r) => r.risk).reduce((a, r) => a + r.chars, 0);
  return {
    status: 'SPECIFICITY',
    source,
    totalChars: total,
    genericChars: riskChars,
    genericRatio: total ? riskChars / total : 0,
    riskyCount: rows.filter((r) => r.risk).length,
    paragraphs: rows.length,
    rows,
  };
}

function pct(x) {
  return (x * 100).toFixed(1) + '%';
}

function renderMarkdown(r, maxRatio = 0.20) {
  const L = [];
  L.push('# 写作具体化预检（不是知网预测）');
  L.push('');
  L.push('> 本工具检查“长句 / 模板句 / 无证据”的泛化段，帮助把论述写具体；**不做 AI 检测规避，不预测知网分数，不提供同义词洗稿**。');
  L.push('');
  L.push('- 输入：`' + (r.source || '（stdin）') + '`');
  L.push('- 正文总字符（不含参考文献/作者表）：**' + r.totalChars + '**');
  L.push('- 泛化段字符：**' + r.genericChars + '**');
  L.push('- 泛化段占比：**' + pct(r.genericRatio) + '**（只用于排序改写优先级）');
  L.push('- 泛化段：**' + r.riskyCount + ' / ' + r.paragraphs + '**');
  L.push('- 阈值：' + pct(maxRatio) + '；' + (r.genericRatio <= maxRatio ? '低于阈值（不等于能过检测）' : '高于阈值，先改泛化段'));
  L.push('');
  L.push('## 泛化段（按字符数降序）');
  L.push('');
  L.push('| # | 章节 | 字符 | 句数 | 平均句长 | 最长句 | 命中 | 开头 |');
  L.push('|---:|---|---:|---:|---:|---:|---|---|');
  const risky = r.rows.filter((x) => x.risk).sort((a, b) => b.chars - a.chars);
  for (const x of risky) {
    L.push('| ' + x.i + ' | ' + x.heading + ' | ' + x.chars + ' | ' + x.sentences + ' | ' + x.avg + ' | ' + x.max + ' | ' + (x.flags.join('、') || '—') + ' | ' + x.preview + '… |');
  }
  L.push('');
  L.push('## 改写顺序');
  L.push('');
  L.push('1. 先改摘要/范围/讨论/局限/结论里的泛化段；');
  L.push('2. 每段补一个实验细节、一个具体对比对象；');
  L.push('3. 拆长句、删模板连接词；');
  L.push('4. 找不到的细节标“待补”，不要编。');
  L.push('');
  L.push('## 边界');
  L.push('');
  L.push('- 知网 AIGC 报告是字符级标红，本工具不能复刻；');
  L.push('- 期刊不要求 AIGC 时，不要主动交 AIGC 报告；');
  L.push('- 不要 PS 报告，不要用同义词替换冒充改写。');
  L.push('');
  return L.join('\n');
}

function selftest() {
  const good = `# 好稿
## 1 方法
我们按温度留一验证：4 ℃ 11 只、24 ℃ 11 只、43 ℃ 4 只。XGBoost 参数固定，10 个种子取均值。
## 2 结果
24 ℃ 同温 R²=0.874；留出 43 ℃ 时 R²=−8.00。图 2 给出全部数值。
## 3 结论
在 26 只电池上边界成立：跨温 R² 为负，不能把同温精度直接写进跨温规格[6]。
`;
  const bad = `# 坏稿
## 摘要
本文旨在研究电池健康状态估计问题，随着新能源汽车的发展，该问题日益重要。本文不仅分析了温度的影响，而且提出了新的框架，值得注意的是，该方法具有重要意义。
## 1 范围
本文只覆盖三个温度，不覆盖其他化学体系，也不覆盖新的循环实验，其他内容都不在本文范围内。
## 5 结论
第一，本文提出了边界；第二，本文提出了方法；第三，本文提出了未来方向。综上所述，本文具有重要价值。
`;
  const scope = `# 范围
本文只覆盖三个温度，不覆盖其他化学体系，也不覆盖新的循环实验，其他内容都不在本文范围内。
`;
  const concl = `# 结论
第一，本文提出了边界；第二，本文提出了方法；第三，本文提出了未来方向。综上所述，本文具有重要价值。
`;
  const withRefs = good + '\n## 参考文献\n[1] 某作者. 某文[J]. 某刊, 2020.\n';
  const a = analyze(good, 'good.md');
  const b = analyze(bad, 'bad.md');
  const c = analyze(scope, 'scope.md');
  const d = analyze(concl, 'concl.md');
  const e = analyze(withRefs, 'refs.md');
  const checks = [
    ['正控：好稿泛化占比 ≤10%', a.genericRatio <= 0.10],
    ['必失败：坏稿泛化占比 ≥30%', b.genericRatio >= 0.30],
    ['坏稿命中长句/模板句/无证据', b.rows.some((r) => r.flags.length >= 2)],
    ['范围段被识别', c.rows.some((r) => r.risk)],
    ['结论段被识别', d.rows.some((r) => r.risk)],
    ['参考文献不计入总字符', e.totalChars === a.totalChars],
    ['报告写明“不是知网预测”', renderMarkdown(a).includes('不是知网预测')],
    ['报告写明“不做 AI 检测规避”', renderMarkdown(a).includes('不做 AI 检测规避')],
  ];
  let ok = 0;
  for (const [n, p] of checks) {
    console.log((p ? 'PASS ' : 'FAIL ') + n);
    if (p) ok += 1;
  }
  console.log('specificity-check selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--prompt')) { console.log(REWRITE_PROMPT); return 0; }
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const f = v('--file');
  if (!f) { console.error('前提层失败：需要 --file <稿.md|txt|tex> 或 --prompt'); return 2; }
  if (!fs.existsSync(f)) { console.error('读不到文件：' + f); return 2; }
  const raw = fs.readFileSync(f, 'utf8');
  if (!raw.trim()) { console.error('空文件：' + f); return 2; }
  const max = v('--max') ? Number(v('--max')) : 0.20;
  if (!Number.isFinite(max) || max <= 0 || max > 1) { console.error('--max 需在 (0,1] 之间'); return 2; }
  const r = analyze(raw, f);
  const out = v('--out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderMarkdown(r, max), 'utf8');
    if (!argv.includes('--json')) console.log('已生成具体化预检 ' + out + '；泛化占比 ' + pct(r.genericRatio));
  }
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (!out) console.log(renderMarkdown(r, max));
  if (argv.includes('--strict') && r.genericRatio > max) return 1;
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyze, renderMarkdown, selftest, REWRITE_PROMPT, TEMPLATES };
