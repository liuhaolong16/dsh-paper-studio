#!/usr/bin/env node
/**
 * disclose —— **AI 使用披露 + 过程证据打包**（投稿合规件，不是"规避工具"）
 *
 * 为什么需要它：多数期刊/机构要求**披露生成式 AI 的使用范围**（语言润色 vs 生成研究内容），
 * 而"检查过不了"的另一半风险是"**没声明**"。本工具做两件机械活：
 *   ① 扫稿子**有没有** AI 使用声明（有/无/像有但不完整）；
 *   ② 生成一段**不夸大**的声明 + 一份**过程证据清单**（逐项检查文件是否存在，缺就写"未准备"）。
 *
 * ★ 边界（回执必印）：
 *   · 声明口径**以目标期刊/机构的现行规定为准**，本工具只给模板与检查，**不替代**其要求；
 *   · **不写"未使用 AI"** 除非事实如此；也**不帮隐瞒**；
 *   · 证据清单**只检查存在性**，不判断证据是否充分（那是审稿/调查环节的事）。
 *
 * 用法：
 *   node bin/disclose.cjs --check --draft <稿>
 *   node bin/disclose.cjs --draft <稿> [--journal JOES|RIPP|PLOS|generic] [--tools "模型名"] [--scope "语言润色"] [--evidence a.jsonl,b.md] [--out <文件>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* 声明"像不像已有"：标题 / 行首加粗标签 / 标准声明句 —— 三类同等强（证据型判据，不靠单一格式） */
const HEAD = /^#{1,6}\s*(?:[Aa][Ii]\s*(?:使用|use|usage|assistance|声明|disclosure)|人工智能使用|生成式)/m;
const BOLD = /^\s*\*\*[^*]{0,60}(?:AI|人工智能|generative|LLM)[^*]{0,60}\*\*/m;
const SENT = /(?:AI|人工智能|大语言模型|LLM|ChatGPT|generative)[^.\n]{0,80}(?:润色|语言编辑|language edit|proofread|校对|翻译|translate|辅助)/i;
const NEGATION_EXEMPT = /(?:未使用|没有使用|not used|no AI)/i;

function detectDisclosure(text) {
  const t = String(text || '');
  const hits = [];
  if (HEAD.test(t)) hits.push('heading');
  if (BOLD.test(t)) hits.push('bold-label');
  if (SENT.test(t)) hits.push('standard-sentence');
  return { found: hits.length > 0, kinds: hits, mentionsNoAI: NEGATION_EXEMPT.test(t) };
}

const TEMPLATES = {
  JOES: (tools, scope) => '**AI 使用声明.** 在本研究准备过程中，我们使用了' + tools + '，**仅用于**' + scope + '。该工具**未用于**生成研究假设、实验设计、数据分析或结果解释；所有数据采集、计算与结论均由作者完成，并由作者对全文内容负责。',
  RIPP: (tools, scope) => '**AI 使用声明.** 作者使用了' + tools + '进行' + scope + '。AI 工具**未参与**文献筛选判断、数据提取或结论形成；稿件的学术内容与准确性由作者承担全部责任。',
  PLOS: (tools, scope) => '**AI 使用声明.** During preparation, ' + tools + ' was used for ' + scope + '. The tool was not used to generate research data, analyses, or conclusions; the authors are responsible for all content.',
  generic: (tools, scope) => '**AI 使用声明.** 作者在' + scope + '环节使用了' + tools + '。AI **未参与**研究设计、数据处理与结论形成；作者对全文负责，并可按要求提供修订过程记录。',
};

function evidence(list, baseDir) {
  return (list || []).map((p) => {
    const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
    const ok = fs.existsSync(abs);
    return { path: p, exists: ok, size: ok ? fs.statSync(abs).size : 0 };
  });
}

function render(res) {
  const L = [];
  L.push(res.title);
  L.push('');
  L.push(res.statement);
  L.push('');
  L.push('**过程证据清单**（只查存在性；缺项请补齐后再投）：');
  if (!res.evidence.length) L.push('- 未提供证据路径（**未核对 ≠ 已备齐**）');
  for (const e of res.evidence) L.push('- ' + (e.exists ? '✔' : '✘ 未准备') + ' `' + e.path + '`' + (e.exists ? '（' + e.size + ' B）' : ''));
  L.push('');
  L.push('> 边界：声明口径**以目标期刊/机构现行规定为准**；证据清单只查存在性，不判断是否充分；若实际**未使用** AI，请据实写明，不要套用本模板。');
  return L.join('\n');
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const withDisc = '## 正文\n\nBlah.\n\n**AI 使用声明.** 我们使用某模型仅进行语言润色，未参与研究与结论。\n';
  const noDisc = '## 正文\n\nWe trained XGBoost and reported 30 cells [12]. No disclosure section here at all.\n';
  ck('--check 正控：稿内有 AI 使用声明（行首加粗标签式）⇒ 检出', () => {
    const d = detectDisclosure(withDisc);
    return (d.found && d.kinds.includes('bold-label')) ? true : JSON.stringify(d);
  });
  ck('★必失败面：稿内没有声明 ⇒ 必须报"缺失"（不能默认为合规）', () => {
    const d = detectDisclosure(noDisc);
    return (d.found === false) ? true : JSON.stringify(d);
  });
  ck('生成件必须含：工具名 + 范围 + "未参与研究/结论" + 作者负责', () => {
    const s = TEMPLATES.generic('某模型', '语言润色');
    return (/某模型/.test(s) && /语言润色/.test(s) && /未参与/.test(s) && /作者/.test(s)) ? true : s;
  });
  ck('★必失败面：证据文件不存在 ⇒ 报"未准备"，不得报"已备"', () => {
    const ev = evidence(['definitely-not-here-12345.jsonl'], process.cwd());
    const out = render({ title: 't', statement: 's', evidence: ev });
    return (!ev[0].exists && /未准备/.test(out)) ? true : JSON.stringify(ev);
  });
  ck('正控：证据文件存在 ⇒ 报 ✔ 与字节数（用本工具自身当夹具，避免造假文件）', () => {
    const ev = evidence([__filename], process.cwd());
    const out = render({ title: 't', statement: 's', evidence: ev });
    return (ev[0].exists && /✔/.test(out) && /B）/.test(out)) ? true : JSON.stringify(ev);
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\ndisclose 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const draft = v('--draft');
  if (!draft || !fs.existsSync(draft)) { console.error('前提层失败：需要 --draft <稿>'); return 2; }
  const text = fs.readFileSync(draft, 'utf8');
  if (argv.includes('--check')) {
    const d = detectDisclosure(text);
    console.log('AI 使用声明检查：' + (d.found ? '✔ 已有（' + d.kinds.join(',') + '）' : '✘ **未发现**') + (d.mentionsNoAI ? ' · 文本中出现"未使用 AI"表述（据实即可）' : ''));
    if (!d.found) console.log('  ⇒ 多数期刊要求披露；可用本工具 `--draft <稿> --journal <刊> --out <文件>` 生成，**再按期刊原话核对**。');
    return d.found ? 0 : 1;
  }
  const j = (v('--journal') || 'generic').toUpperCase();
  const tools = v('--tools') || '（请填写具体模型与版本）';
  const scope = v('--scope') || '语言润色与表达修订';
  const ev = evidence((v('--evidence') || '').split(',').map((s) => s.trim()).filter(Boolean), path.dirname(draft));
  const res = { title: '## AI 使用声明（' + j + '）', statement: (TEMPLATES[j] || TEMPLATES.generic)(tools, scope), evidence: ev };
  const out = render(res);
  const of = v('--out');
  if (of) { fs.writeFileSync(of, out + '\n', 'utf8'); console.log('已写出：' + of); }
  console.log(out);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { detectDisclosure, render, evidence, selftest, TEMPLATES };
