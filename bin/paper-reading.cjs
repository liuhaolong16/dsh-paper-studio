#!/usr/bin/env node
/**
 * paper-reading —— 单篇文献精读工作单
 *
 * 来源：B站《大模型无效读文献》（BV1mJ4w6HE2B，约 3 分钟）
 *   核心：直接让模型“总结文献”只会压缩摘要/引言；有效读法是按
 *   “问题—动机—差异—方法—示例—数据—指标—结论—证据—边界—启发—追问”逐项读。
 *
 * 本工具**不调用模型、不判断论文对错**：它只从原文抽候选句、检查结构、
 * 生成一份必须由人填“我的判断”的工作单。这样既保留视频的结构，
 * 又不把“AI 已读”伪装成结论。
 *
 * 用法：
 *   node bin/paper-reading.cjs --prompt
 *   node bin/paper-reading.cjs --file <paper.md|txt|tex> [--out <工作单.md|.html>] [--json] [--strict]
 *   node bin/paper-reading.cjs --selftest
 *
 * 退出码：0=已生成工作单（缺项也照常生成） 1=--strict 且有缺项 2=前提层失败
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CHECKPOINTS = [
  { id: 'question', label: '研究问题', hint: '它到底要回答什么？不是“研究了 SOH”，而是“在什么条件下、对什么对象、回答什么”。',
    rx: /(研究问题|问题|本文(?:要|试图)?回答|我们(?:要|试图)?回答|aim|research question|objective|本文研究)/i },
  { id: 'motivation', label: '动机', hint: '为什么这个问题值得做？现有做法卡在哪？', 
    rx: /(背景|动机|为什么|重要性|然而|但是|现有|挑战|motivation|why|gap)/i },
  { id: 'gap', label: '与已有工作的差异', hint: '和最近的已有工作比，它真正多做了什么？不要写“首次”。',
    rx: /(已有|现有|先前|不足|尚未|很少|however|prior|existing|limited|unlike|in contrast|相比)/i },
  { id: 'method', label: '方法核心', hint: '一句话说清方法；再给一个最小示例，而不是复述模块名。',
    rx: /(方法|模型|算法|框架|流程|method|approach|model|framework|pipeline)/i },
  { id: 'example', label: '最小示例', hint: '用一个最小输入/最小步骤把方法跑一遍。',
    rx: /(例如|示例|举例|步骤|流程|example|walkthrough|for instance)/i },
  { id: 'data', label: '数据与样本', hint: '用了什么数据、多少样本、怎么划分？',
    rx: /(数据集|数据|样本|电池|语料|dataset|sample|corpus|split)/i },
  { id: 'metric', label: '指标与基线', hint: '指标是什么、基线是什么、比较是否公平？',
    rx: /(指标|评价|基线|对照|R²|MAE|RMSE|accuracy|metric|baseline|control)/i },
  { id: 'finding', label: '主要发现', hint: '作者主张什么？先写主张，不要先写数字。',
    rx: /(结果|发现|表明|显示|结论|result|find|show|suggest)/i },
  { id: 'evidence', label: '证据对应', hint: '每个主张对应哪张图/哪张表/哪段原文？找不到就写“原文未说明”。',
    rx: /(图\s*\d|表\s*\d|fig(?:ure)?\s*\d|table\s*\d|证据|evidence|support)/i },
  { id: 'boundary', label: '边界与局限', hint: '在什么条件下不成立？作者没覆盖什么？',
    rx: /(局限|边界|不成立|未覆盖|不能|limitation|boundary|scope|caveat)/i },
  { id: 'insight', label: '可迁移启发', hint: '对我自己的研究，能搬走的是什么？给 3 条，按可执行性排序。',
    rx: /(启发|启示|意义|影响|implication|insight|lesson|takeaway)/i },
  { id: 'next', label: '待追问', hint: '读完这篇，我还应该追问哪 3 个问题？',
    rx: /(未来|下一步|后续|待回答|开放问题|future|next step|open question|further)/i },
  { id: 'judgment', label: '我的判断', hint: '用 5 句话写自己的判断，不许复述摘要。',
    rx: /(我认为|我的判断|值得|可信|不足|however|I think|in my view)/i },
];

const READING_PROMPT = [
  '你是我的文献精读助手。请阅读我上传的论文，不要只做摘要复述。',
  '按下面结构输出，每一项都要标注依据（页码/章节/图表编号）；找不到依据就写“原文未说明”，不要猜。',
  '',
  '1. 这篇论文解决什么问题？为什么这个问题重要？',
  '2. 作者的方法核心是什么？用一句话说清；再给一个最小示例。',
  '3. 关键模块有哪些？数据怎么流？',
  '4. 用了什么数据、什么基线、什么指标？实验设置是否公平？',
  '5. 每个主要结论对应哪张图/哪张表/哪段证据？',
  '6. 哪些结论是作者验证过的，哪些是推断？',
  '7. 这篇论文的边界与局限是什么？在什么条件下不成立？',
  '8. 与最接近的已有工作相比，真正的差异是什么？',
  '9. 对我当前的研究方向有什么可迁移的启发？给 3 条，按可执行性排序。',
  '10. 如果我要复现，最小步骤是什么？最可能失败的地方在哪？',
  '11. 读完这篇，我还应该追问哪 3 个问题？',
  '',
  '最后用 5 句话写一个“我自己的判断”，不要复述摘要。',
  '',
  '纪律：',
  '- 不许把摘要里的主张当成证据；每个“证据”必须能指到图/表/页。',
  '- 不许编造数字、引用、实验设置；找不到就写“原文未说明”。',
  '- 把“作者说的”“作者证明的”“我认为的”分开写。',
].join('\n');

const SECTION_NAMES = {
  abstract: ['摘要', 'Abstract'],
  intro: ['引言', 'Introduction', '背景', 'Background'],
  method: ['方法', 'Methods', 'Method', 'Methodology', '材料与方法'],
  results: ['结果', 'Results', '实验', 'Experiments'],
  discussion: ['讨论', 'Discussion'],
  conclusion: ['结论', 'Conclusions', 'Conclusion', '结语'],
  references: ['参考文献', 'References'],
};

function section(raw, names) {
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('(?:^|\\n)(?:#{1,6}\\s*|\\\\section\\*?\\{)\\s*(?:\\d+(?:\\.\\d+)*\\s*|[一二三四五六七八九十]+[、.]\\s*)?(?:' + esc + ')\\s*\\}?\\s*\\n([\\s\\S]*?)(?=\\n(?:#{1,6}\\s|\\\\section)|$)', 'i');
  const m = raw.match(re);
  return m ? m[1].trim() : '';
}
function abstractOf(raw) {
  const m = String(raw).match(/\*\*摘要[：:]\*\*\s*([\s\S]*?)(?=\n\*\*关键词|\n\n\*\*Abstract|\n---)/);
  return m ? m[1].trim() : '';
}
function allSections(raw) {
  const out = {};
  for (const [k, names] of Object.entries(SECTION_NAMES)) out[k] = section(raw, names);
  out.abstract = out.abstract || abstractOf(raw);
  return out;
}
function lineAt(raw, idx) {
  return raw.slice(0, Math.max(0, idx)).split(/\r?\n/).length;
}
function clip(s, n = 220) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?])\s*|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}
function findEvidence(raw, rx, max = 2) {
  const hits = [];
  const seen = new Set();
  for (const s of sentences(raw)) {
    if (!rx.test(s) || seen.has(s)) continue;
    seen.add(s);
    const idx = raw.indexOf(s);
    hits.push({ line: idx >= 0 ? lineAt(raw, idx) : null, text: clip(s) });
    if (hits.length >= max) break;
  }
  return hits;
}
function titleOf(raw) {
  const m = raw.match(/^\s*#\s+(.+)$/m) || raw.match(/\\title\{([^}]+)\}/);
  return m ? m[1].trim() : '（未找到标题）';
}
function analyze(raw, source = '') {
  const text = String(raw || '');
  const sections = allSections(text);
  const checklist = CHECKPOINTS.map((c) => {
    const evidence = findEvidence(text, c.rx);
    return {
      id: c.id,
      label: c.label,
      hint: c.hint,
      status: c.id === 'judgment' ? 'human' : (evidence.length ? 'candidate' : 'missing'),
      evidence,
    };
  });
  const missing = checklist.filter((c) => c.status === 'missing').map((c) => c.id);
  const flags = [];
  if (missing.length) flags.push('缺 ' + missing.length + ' 项候选：' + missing.join('、') + '（不是论文一定没有，可能只是没写在这些词里）');
  if (!sections.method && !sections.results) flags.push('未识别到方法/结果章节：工作单仍可用，但候选句可能来自全文');
  return {
    status: 'WORKSHEET',
    source,
    title: titleOf(text),
    chars: text.replace(/\s/g, '').length,
    sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v ? v.length : 0])),
    checklist,
    missing,
    flags,
  };
}
function renderMarkdown(r) {
  const L = [];
  L.push('# 单篇精读工作单：' + r.title);
  L.push('');
  L.push('> 由 `paper-reading` 生成。它只抽候选原文、检查结构；**“我的判断”必须由人填**，工具不代替阅读。');
  L.push('');
  L.push('## 0. 原文信息');
  L.push('');
  L.push('- 来源：`' + (r.source || '（stdin）') + '`');
  L.push('- 字符数（去空白）：' + r.chars);
  L.push('- 已识别章节：' + Object.entries(r.sections).filter(([, n]) => n).map(([k, n]) => k + '(' + n + ')').join('、') || '（未识别）');
  if (r.flags.length) L.push('- 提示：' + r.flags.join('；'));
  L.push('');
  for (let i = 0; i < r.checklist.length; i += 1) {
    const c = r.checklist[i];
    L.push('## ' + (i + 1) + '. ' + c.label);
    L.push('');
    L.push('**要问的**：' + c.hint);
    L.push('');
    L.push('**状态**：' + (c.status === 'candidate' ? '原文有候选句（需人工核对）' : c.status === 'human' ? '必填：由你写，工具不代填' : '原文未定位（可能确实没写，也可能只是没用这些词）'));
    if (c.evidence.length) {
      L.push('');
      L.push('**候选原文**：');
      for (const e of c.evidence) L.push('> ' + (e.line ? 'L' + e.line + '：' : '') + e.text);
    }
    L.push('');
    L.push('**我的判断（待填）**：');
    L.push('');
    L.push('```text');
    L.push('（写你的判断；引用证据请标页码/图号/表号）');
    L.push('```');
    L.push('');
  }
  L.push('## 收尾：5 句话判断');
  L.push('');
  L.push('```text');
  L.push('1. 它解决的问题是……');
  L.push('2. 它的方法核心是……');
  L.push('3. 最关键的证据是……');
  L.push('4. 我不信/存疑的是……');
  L.push('5. 对我自己的工作，我要改的是……');
  L.push('```');
  L.push('');
  return L.join('\n');
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderHtml(r) {
  const cards = r.checklist.map((c, i) => `
  <section class="card">
    <h2>${i + 1}. ${esc(c.label)} <small>${c.status === 'candidate' ? '有候选' : c.status === 'human' ? '必填' : '原文未定位'}</small></h2>
    <p class="hint">${esc(c.hint)}</p>
    ${c.evidence.map((e) => `<blockquote>${e.line ? `L${e.line}：` : ''}${esc(e.text)}</blockquote>`).join('')}
    <label>我的判断<textarea placeholder="写你的判断；引用证据请标页码/图号/表号"></textarea></label>
  </section>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>单篇精读：${esc(r.title)}</title>
<style>
body{margin:0;background:#f9f8f6;color:#1c1c1c;font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
main{max-width:920px;margin:0 auto;padding:32px 20px 64px}
h1{font:600 26px/1.3 Georgia,serif;margin:0 0 8px}
.meta{color:#666;font-size:13px;margin-bottom:24px}
.card{background:#fff;border:1px solid #ddd;border-radius:0;padding:18px 20px;margin:14px 0}
h2{font:600 17px/1.4 Georgia,serif;margin:0 0 8px}
h2 small{font:400 12px/1 sans-serif;color:#888;margin-left:8px}
.hint{color:#555;margin:0 0 10px}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid #999;background:#fafafa;color:#333;font-size:14px}
label{display:block;margin-top:12px;font-size:13px;color:#555}
textarea{display:block;width:100%;min-height:76px;margin-top:6px;border:1px solid #bbb;background:#fff;padding:8px;font:14px/1.5 inherit;box-sizing:border-box}
footer{color:#777;font-size:12px;margin-top:28px}
</style></head><body><main>
<h1>单篇精读：${esc(r.title)}</h1>
<div class="meta">${esc(r.source || '')} · ${r.chars} 字符 · 由 paper-reading 生成；只抽候选，不代替阅读</div>
${r.flags.length ? `<p class="meta">${esc(r.flags.join('；'))}</p>` : ''}
${cards}
<footer>每条“我的判断”必须由人填；找不到证据就写“原文未说明”。</footer>
</main></body></html>`;
}
function selftest() {
  const good = `# 温度对电池 SOH 的影响
## 摘要
本文研究跨温度 SOH 估计的边界，发现同温 R²=0.874，跨温失效。
## 1 引言
现有工作多在固定温度下报告精度，然而跨温度迁移很少被回答。本文要回答：特征在什么位置停止迁移。
## 2 方法
我们使用 XGBoost 和 SHAP，按温度留一验证。例如，留出 43 ℃，用 4 和 24 ℃ 训练。
## 3 结果
结果表明，跨温 R² 为负。图 2 给出 R² 对比，表 2 给出全部数值。基线是同温模型。
## 4 讨论
局限是温度与倍率混杂，不能分离；未来应补同温变倍率实验。对 BMS 的启发是不要直接搬模型。
## 5 结论
跨温边界成立；下一步要验证域适应。
`;
  const thin = '# 一篇只有摘要的稿子\n本文研究某问题，结果很好。';
  const a = analyze(good, 'good.md');
  const b = analyze(thin, 'thin.md');
  const md = renderMarkdown(a);
  const html = renderHtml(a);
  const checks = [
    ['prompt 含“原文未说明”', READING_PROMPT.includes('原文未说明')],
    ['prompt 含 11 个问题', (READING_PROMPT.match(/^\d+\./gm) || []).length === 11],
    ['正控：好稿 13 项都有候选', a.checklist.length === 13 && a.missing.length === 0],
    ['必失败：薄稿缺项被标出', b.missing.length >= 5],
    ['工作单含“我的判断（待填）”', md.includes('我的判断（待填）')],
    ['HTML 含 textarea 与转义', html.includes('<textarea') && html.includes('&lt;') === false],
    ['结构：13 个工作项', a.checklist.length === 13],
  ];
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('paper-reading selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}
function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--prompt')) { console.log(READING_PROMPT); return 0; }
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const f = v('--file');
  if (!f) { console.error('前提层失败：需要 --file <paper.md|txt|tex> 或 --prompt'); return 2; }
  if (!fs.existsSync(f)) { console.error('读不到文件：' + f); return 2; }
  const raw = fs.readFileSync(f, 'utf8');
  if (!raw.trim()) { console.error('空文件：' + f); return 2; }
  const r = analyze(raw, f);
  const out = v('--out');
  if (out) {
    const html = out.toLowerCase().endsWith('.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html ? renderHtml(r) : renderMarkdown(r), 'utf8');
    if (!argv.includes('--json')) console.log('已生成' + (html ? ' HTML ' : '工作单 ') + out + '；缺项 ' + r.missing.length + ' 个，需人工填判断');
  }
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else if (!out) console.log(renderMarkdown(r));
  if (argv.includes('--strict') && r.missing.length) return 1;
  return 0;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { analyze, renderMarkdown, renderHtml, selftest, READING_PROMPT, CHECKPOINTS };
