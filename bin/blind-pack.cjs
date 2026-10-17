#!/usr/bin/env node
/**
 * blind-pack —— **盲评打包器**：把多份产出**去标识**成 A/B/C/D，并生成给独立判者的评分提示。
 *
 * 起因（用户质问「我们的有他们好吗」）：`polish-metrics` 只能给**代理指标**；
 * 语言质量的真判断需要**独立判者**，而 Task A 当时的人读项是 **agent 自评、非盲评** ⇒ 缺测量装置。
 *
 * 本工具做三件事（判者仍是另一个模型/人，本工具不判）：
 *   ① 读入 N 份产出，**按内容哈希排序分配代号**（A/B/C/D…），代号与原文件的映射**单独写 mapping.json**；
 *   ② 生成 `blind-bundle.txt`：只含代号 + 正文（**不含任何来源名、不含文件名**），给判者看；
 *   ③ 生成 `blind-rubric.md`：四维评分标准（准确性/自然度/学术语气/信息密度，各 1–5 分）+ 强制 JSON 输出格式。
 *
 * ★ 纪律：
 *   · 判者拿到的 bundle **不得**含来源信息；mapping 只在**判完之后**用于回表。
 *   · 判完必须**交叉核对代理指标**（`polish-metrics`）：两者矛盾时如实记矛盾，不挑好听的。
 *   · 单判者 + 单样本 ⇒ 结论只到"方向性"，**不得**写成"市面最好"。
 *
 * 用法：
 *   node bin/blind-pack.cjs --dir <产出目录> --out <输出目录>
 *   node bin/blind-pack.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODES = 'ABCDEFGHIJKL'.split('');

/* ★ v3.30.0：**只发正文**。三判盲评里我方被判「语气/密度」扣分，一部分来自把改动账本、
   自检读数、Prompt used 这类**元信息块**贴在正文后面 —— 判者会把它们当正文噪声
   （判者 3 甚至把中文账本误读成内容缺失）。⇒ 评分面只保留正文，元信息物理隔离。
   规则：从**第一个非元信息标题**之后开始，到**下一个元信息标题**为止。 */
const META_HEAD = /^\s*#{1,6}\s*(改动账本|change\s*ledger|change\s*log|ledger|notes?|自检读数|prompt\s*used|their\s*own\s*gates|说明|备注)/i;
function bodyOnly(text) {
  const lines = String(text).split('\n');
  let start = -1; let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const isHead = /^\s*#{1,6}\s+/.test(lines[i]);
    if (start < 0) { if (isHead && !META_HEAD.test(lines[i])) start = i + 1; continue; }
    if (isHead && META_HEAD.test(lines[i])) { end = i; break; }
  }
  if (start < 0) return String(text).trim();
  return lines.slice(start, end).join('\n').trim();
}

function pack(files, outDir, opts) {
  const onlyBody = !!(opts && opts.onlyBody);
  if (!Array.isArray(files) || !files.length) return { ok: false, why: '没有输入文件' };
  const stems = files.map((f) => path.basename(f).replace(/\.(md|txt)$/i, ''));
  /* ★ 真数据抓出的漏洞：产出文件**正文自带来源头**（如 `# contestant: **lifecycle-skills**…`），
     只去文件名 ⇒ 盲评不盲。规则：**整行删除**任何提到来源 stem 的行（不碰正文散文）。 */
  const scrub = (text) => String(text).split('\n').filter((L) => {
    const low = L.toLowerCase();
    if (/^\s*#\s*contestant\b/i.test(L)) return false;
    if (/^\s*#\s*(?:参赛者|来源|source)\b/i.test(L)) return false;
    /* ★ 第二轮实测又抓到：正文里出现「我方」「ours」也算自曝（如「见 REPORT 中 ours 行的实跑读数」） */
    if (/\bours\b/i.test(L) || /我方/.test(L)) return false;
    return !stems.some((s) => s.length >= 4 && low.includes(s.toLowerCase()));
  }).join('\n');
  const entries = files.map((f) => {
    const raw = fs.readFileSync(f, 'utf8');
    const text = onlyBody ? bodyOnly(scrub(raw)) : scrub(raw);
    const h = crypto.createHash('sha1').update(path.basename(f) + '\n' + text).digest('hex');
    return { file: f, base: path.basename(f), text, h, scrubbedLines: raw.split('\n').length - text.split('\n').length };
  });
  /* 按哈希排序 ⇒ 代号分配与"谁是谁"无关（避免按文件名/字母序泄露） */
  entries.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const mapping = entries.map((e, i) => ({ code: CODES[i], source: e.base, sha1: e.h.slice(0, 12), chars: e.text.length, scrubbedLines: e.scrubbedLines }));
  fs.mkdirSync(outDir, { recursive: true });
  const bundle = entries.map((e, i) => '===== 版本 ' + CODES[i] + ' =====\n' + e.text.trim() + '\n').join('\n');
  const rubric = [
    '# 盲评评分标准（判者用）',
    '',
    '你面前是同**一个任务**（把一段中文/粗糙英文改写成可投稿的学术英文）的若干份改写产出，**来源被隐去**。',
    '请只按下面四维打 1–5 分（整数），不要猜作者，不要因为长度给分。',
    '',
    '| 维度 | 1 分 | 3 分 | 5 分 |',
    '|---|---|---|---|',
    '| 准确性 | 改动了原意或丢了信息 | 基本忠实，个别措辞走样 | 完全忠实，且更精确 |',
    '| 自然度 | 明显机翻/中式英语 | 通顺但偶有生硬 | 母语级流畅 |',
    '| 学术语气 | 口语化或夸张 | 尚可但不够克制 | 克制、精确、无 AI 腔 |',
    '| 信息密度 | 灌水/重复 | 正常 | 句句有信息，无冗余 |',
    '',
    '**必须只输出一个 JSON 对象**（不要解释、不要 markdown 围栏）：',
    '{"scores":{"A":{"accuracy":0,"naturalness":0,"tone":0,"density":0},"B":{...}},"best":"A","why":"一句话（不超过 40 字）"}',
    '',
    '> 注：这是**盲评**，你看不到来源；请**不要**依据文件顺序或长度做判断。',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'blind-bundle.txt'), bundle, 'utf8');
  fs.writeFileSync(path.join(outDir, 'blind-rubric.md'), rubric, 'utf8');
  fs.writeFileSync(path.join(outDir, 'mapping.json'), JSON.stringify({ createdAt: new Date().toISOString(), mapping }, null, 2), 'utf8');
  return { ok: true, outDir, codes: mapping.map((m) => m.code), bundleChars: bundle.length, mapping };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const tmp = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'blind-'));
  const w = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'utf8'); return p; };
  const files = [w('ours.en.md', 'We ran 30 cells. The gain is 27%.'), w('lifecycle-skills.en.md', 'Thirty cells were evaluated and a twenty-seven percent gain was observed.'), w('academic-research-skills.en.md', 'A gain of 27% is reported over 30 cells.')];

  ck('正控：三份产出 ⇒ 分配 A/B/C 且 bundle 里**不含来源名**', () => {
    const r = pack(files, path.join(tmp, 'out1'));
    const b = fs.readFileSync(path.join(tmp, 'out1', 'blind-bundle.txt'), 'utf8');
    const leak = ['ours', 'lifecycle', 'academic'];
    return (r.ok && r.codes.length === 3 && !leak.some((x) => b.toLowerCase().includes(x))) ? true : JSON.stringify({ codes: r.codes, leak: leak.filter((x) => b.toLowerCase().includes(x)) });
  });

  ck('★必失败面：**bundle 里不得出现任何原文文件名**（防判者猜来源）', () => {
    const r = pack(files, path.join(tmp, 'out2'));
    const b = fs.readFileSync(path.join(tmp, 'out2', 'blind-bundle.txt'), 'utf8');
    return (!/\.md/.test(b)) ? true : 'bundle 含 .md 文件名';
  });

  ck('代号由**内容哈希**决定：换文件名不改变代号（防按名字排序泄露）', () => {
    const a = pack([w('x1.md', 'Alpha text here.'), w('x2.md', 'Beta text here.')], path.join(tmp, 'out3'));
    const b = pack([w('y1.md', 'Alpha text here.'), w('y2.md', 'Beta text here.')], path.join(tmp, 'out4'));
    const aMap = a.mapping.map((m) => m.code).join('');
    const bMap = b.mapping.map((m) => m.code).join('');
    return (aMap === 'AB' && bMap === 'AB' && a.mapping[0].source.startsWith('x') && b.mapping[0].source.startsWith('y')) ? true : JSON.stringify({ aMap, bMap });
  });

  ck('★必失败面：空输入 ⇒ 不产出（ok=false），不得生成空 bundle', () => {
    return (pack([], path.join(tmp, 'out5')).ok === false) ? true : '空输入应 ok=false';
  });

  ck('rubric 必须要求只输出 JSON 且给出四维（判者可机读）', () => {
    pack(files, path.join(tmp, 'out6'));
    const r = fs.readFileSync(path.join(tmp, 'out6', 'blind-rubric.md'), 'utf8');
    return (/只输出一个 JSON/.test(r) && /accuracy/.test(r) && /naturalness/.test(r) && /tone/.test(r) && /density/.test(r)) ? true : 'rubric 缺要素';
  });

  ck('★必失败面（真数据形状）：**正文自带 `# contestant:` 头必须被整行删除**，bundle 不得含来源 stem', () => {
    const f1 = w('lifecycle-skills.en.md', '# contestant: **lifecycle-skills**（Apache-2.0）\n\nThe gain is 27% over 30 cells.\n');
    const f2 = w('ours.en.md', '# contestant: **ours**（我方）\n\nWe ran 30 cells and saw a 27% gain.\n');
    const out = path.join(tmp, 'out7');
    const r = pack([f1, f2], out);
    const b = fs.readFileSync(path.join(out, 'blind-bundle.txt'), 'utf8');
    const bad = ['lifecycle-skills', 'contestant', 'ours'].filter((x) => b.toLowerCase().includes(x));
    const cjkBad = /我方/.test(b);
    const kept = /27%/.test(b) && /30 cells/.test(b);
    return (r.ok && bad.length === 0 && !cjkBad && kept) ? true : JSON.stringify({ bad, cjkBad, kept });
  });

  ck('★ v3.30.0 只发正文：元信息块（改动账本/自检读数/Notes）必须被挡在评分面外', () => {
    const f1 = w('p1.md', '## 译文\n\nThe gain is 27 percent over 30 cells [12].\n\n## 改动账本（kind · reason）\n\n| kind | reason |\n|---|---|\n| 去套话 | 删开头 |\n\n## 自检读数（我方工具）\n\nstylecheck 通过。\n');
    const out = path.join(tmp, 'out8');
    const r = pack([f1], out, { onlyBody: true });
    const b = fs.readFileSync(path.join(out, 'blind-bundle.txt'), 'utf8');
    const meta = ['改动账本', '自检读数', 'stylecheck'].filter((x) => b.includes(x));
    const kept = /27 percent/.test(b) && /30 cells/.test(b) && /\[12\]/.test(b);
    return (r.ok && meta.length === 0 && kept) ? true : JSON.stringify({ meta, kept });
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nblind-pack 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const dir = val('--dir');
  if (!dir || !fs.existsSync(dir)) { console.error('前提层失败：需要 --dir <含产出的目录>'); return 2; }
  const files = fs.readdirSync(dir).filter((f) => /\.(md|txt)$/i.test(f)).map((f) => path.join(dir, f));
  if (!files.length) { console.error('前提层失败：目录里没有 .md/.txt 产出'); return 2; }
  const out = path.resolve(val('--out') || path.join(dir, 'blind'));
  const r = pack(files, out, { onlyBody: argv.includes('--only-body') });
  if (!r.ok) { console.error('失败：' + r.why); return 2; }
  console.log('已打包 ' + r.codes.length + ' 份产出 ⇒ ' + out);
  console.log('   blind-bundle.txt（给判者，不含来源）· blind-rubric.md（四维 1–5 分 + JSON 输出）· mapping.json（判完再回表）');
  console.log('   下一步：把 bundle 与 rubric 交给**独立判者**（另一个模型或人），拿到 JSON 后再回表对照代理指标。');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { pack, bodyOnly, selftest, main, CODES };
