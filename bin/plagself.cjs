#!/usr/bin/env node
/**
 * plagself —— **自我重复 / 字面重合预检**（新稿 vs 你自己的旧稿集合）
 *
 * 为什么做这个：Crossref Similarity Check（iThenticate）会**把新稿与你自己已发表/已存档的全文比对**
 * （官方文档：会员全文经 Crossref metadata 的 full-text URL 被抓进 iThenticate 库，>78,000,000 篇）。
 * ⇒ **"和自己旧作重复"是查重最常见的意外高分，而作者最不设防。**
 *
 * 本工具**只做一件事**：找出新稿里**连续 n 单位**与语料库重合的片段，报位置与总量。
 *
 * ★★ 边界（写死在回执里，别被当成"查重结果"）：
 *   ① 这是**字面重合的估计**，**不是任何查重系统的判定**（各系统语料、切词、去重规则、阈值都不同）；
 *   ② 语料库只有**你给的那个目录** —— 不包含期刊库、网页、学位论文库 ⇒ **低估是必然的**；
 *   ③ 常见门槛：期刊多要求总重复率 ≤10–15%、学位论文 ≤5–10%，**但以你目标单位的规定为准**；
 *   ④ **语料若含本稿旧版/草稿（单源近乎全同）⇒ 会显式标注"这不是查重读数"**，因为自比自必然 100%；
 *   ⑤ 本工具**不提供**"降重/洗稿"建议 —— 重合要么来自**自引未标**、要么来自**转述不够**，
 *      正确的修法是**补引用 + 真正改写（改结构不是改词）**，不是替换同义词。
 *
 * 用法：
 *   node bin/plagself.cjs --new <新稿.md> --corpus <旧稿目录> [--n 12] [--json]
 *   node bin/plagself.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CJK = /[\u4e00-\u9fff]/;

/** 归一化：去代码块/公式/引用标记/markdown 记号/参考文献节，只留"会被查重系统看见的字" */
function norm(text) {
  let t = String(text).replace(/\r\n/g, '\n');
  /* 去掉参考文献节之后的内容（各系统通常可配置排除，但保守起见先排除并报出） */
  const refIdx = t.search(/\n#{1,6}\s*(references|bibliography|参考文献)\b/i);
  let excludedTailChars = 0;
  if (refIdx > -1) { excludedTailChars = t.length - refIdx; t = t.slice(0, refIdx); }
  t = t.replace(/```[\s\S]*?```/g, ' ')          // 代码块
       .replace(/\$\$[\s\S]*?\$\$/g, ' ')      // 公式块
       .replace(/\$[^$\n]{1,200}\$/g, ' ')      // 行内公式
       .replace(/\\[a-zA-Z]+\{[^}]*\}/g, ' ')   // LaTeX 命令
       .replace(/\[\d+(?:[,\-–]\d+)*\]/g, ' ')  // 引用标记
       .replace(/<!--[\s\S]*?-->/g, ' ')        // HTML 注释
       .replace(/^\s*\|.*$/gm, ' ')             // 表格行
       .replace(/[#>*_`~\-]{1,}/g, ' ');        // markdown 记号
  return { text: t, excludedTailChars };
}

/** 切词：中文按字符、英文按词；返回 token 数组（数字也是 token） */
function tokens(text) {
  const out = [];
  const re = /[\u4e00-\u9fff]|[A-Za-z]+(?:['-][A-Za-z]+)*|\d+(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text))) out.push(m[0].toLowerCase());
  return out;
}

/** n-gram 集合（返回 Map: gram -> 首次出现位置） */
function grams(tok, n) {
  const m = new Map();
  for (let i = 0; i + n <= tok.length; i += 1) {
    const g = tok.slice(i, i + n).join('\u0001');
    if (!m.has(g)) m.set(g, i);
  }
  return m;
}

function readCorpus(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.git)$/.test(e.name)) walk(p); continue; }
      if (/\.(md|txt|tex)$/i.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  return files;
}

function check(newText, corpusTexts, opts) {
  const o = opts || {};
  const n = Number(o.n || 0) || (CJK.test(newText) ? 12 : 8);
  const nw = norm(newText);
  const newTok = tokens(nw.text);
  if (!newTok.length) return { status: 'SKIP', why: '新稿归一化后为空（没内容可比）', n };
  const corpusGrams = new Map();               // gram -> {file, idx}
  for (const { file, text } of corpusTexts) {
    const ct = tokens(norm(text).text);
    const g = grams(ct, n);
    for (const [k, idx] of g) if (!corpusGrams.has(k)) corpusGrams.set(k, { file: path.basename(file), idx });
  }
  if (!corpusGrams.size) return { status: 'SKIP', n, why: '语料库为空或无有效 n-gram ⇒ **未核对，不等于通过**', corpusFiles: 0 };

  /* 扫描新稿，合并连续命中的 n-gram 成"最大重合段" */
  const hits = [];
  let cur = null;
  for (let i = 0; i + n <= newTok.length; i += 1) {
    const g = newTok.slice(i, i + n).join('\u0001');
    const hit = corpusGrams.get(g);
    if (hit) {
      /* ★ 合并条件必须比较"上一个 n-gram 的起点 + 1"，而不是它的 end ——
         用 end 比较会让每个 n-gram 各自成段（真数据：41 词的整段被拆成 34 个 8 词段）。 */
      if (cur && cur.last === i - 1) { cur.last = i; cur.end = i + n; cur.srcs.add(hit.file); }
      else { if (cur) hits.push(cur); cur = { start: i, end: i + n, last: i, srcs: new Set([hit.file]) }; }
    }
  }
  if (cur) hits.push(cur);
  const overlapped = hits.reduce((a, h) => a + (h.end - h.start), 0);
  const longest = hits.reduce((a, h) => Math.max(a, h.end - h.start), 0);
  const ratio = overlapped / newTok.length;
  const runs = hits.map((h) => ({ from: h.start, len: h.end - h.start, srcs: Array.from(h.srcs).slice(0, 3), sample: newTok.slice(h.start, Math.min(h.end, h.start + 24)).join(' ') }));
  const bySource = new Map(); for (const h of hits) for (const s of h.srcs) bySource.set(s, (bySource.get(s) || 0) + (h.end - h.start));
  const longestRun = runs.sort((a, b) => b.len - a.len)[0] || null;
  /* 阈值：单段 ≥ 2n（连续过长）或总占比 ≥ 3% ⇒ WARN；总占比 ≥ 8% 或单段 ≥ 4n ⇒ FAIL
     —— 这些**只是我们自己的保守刻度**，不对应任何系统 */
  let status = 'PASS';
  if (ratio >= 0.08 || longest >= 4 * n) status = 'FAIL';
  else if (ratio >= 0.03 || longest >= 2 * n) status = 'WARN';
  /* ★ 真稿抓到的'假读数'：语料目录里装了本稿的旧版/草稿 ⇒ 自比自 100%。
     这种情况**不是查重结果**，必须在结论里显式推翻它，否则用户会以为自己抄袭了自己。 */
  const selfDraft = Array.from(bySource.entries()).filter(([, v]) => v / newTok.length >= 0.8).map(([k]) => k);
  const statusEff = selfDraft.length ? 'WARN' : status;
  return { status: statusEff, rawStatus: status, selfDraft, n, unit: CJK.test(newText) ? '字符' : '词', tokens: newTok.length, overlapped, longest, ratio: Math.round(ratio * 1000) / 10, runs: runs.sort((a, b) => b.len - a.len).slice(0, 8), corpusFiles: corpusTexts.length, refsExcluded: nw.excludedTailChars > 0 };
}

function render(r) {
  const L = [];
  if (r.status === 'SKIP') { L.push('自我重复预检：SKIP —— ' + r.why); return L.join('\n'); }
  L.push('自我重复预检：' + r.status + '（**这是字面重合估计，不是任何查重系统的判定**）');
  L.push('  n=' + r.n + r.unit + ' · 新稿 ' + r.tokens + ' token · 重合 ' + r.overlapped + '（' + r.ratio + '%） · 最长连续 ' + r.longest + r.unit + ' · 语料 ' + r.corpusFiles + ' 篇' + (r.refsExcluded ? ' · 已排除参考文献节' : ''));
  for (const x of r.runs) L.push('  · ' + x.len + r.unit + ' @' + x.from + ' ← ' + x.srcs.join(',') + ' | ' + x.sample.slice(0, 90));
  const bySrc = new Map(); for (const x of r.runs) for (const s of x.srcs) bySrc.set(s, (bySrc.get(s) || 0) + x.len);
  if (r.selfDraft && r.selfDraft.length) {
    L.push('  ⇒ **★这不是查重读数**：语料里有一篇与本研究稿几乎全同（≥80%）⇒ ' + r.selfDraft.join(',') + ' 极可能是**本稿的旧版/草稿**。请把 --corpus 指向**已发表作品**集合再跑；当前数字不代表查重结果。');
  }
  if (bySrc.size) L.push('  按来源：' + Array.from(bySrc.entries()).sort((a, b) => b[1] - a[1]).map(([s, v]) => s + ' ' + v + r.unit).join(' · ') + '（**样板句/机构名/投稿信常造成这类重合，删或改写即可**）');
  L.push('  ⇒ 门槛参考：期刊多要求 ≤10–15%、学位论文 ≤5–10%（**以你目标单位为准**）；语料库只含你给的目录 ⇒ **低估是必然的**。');
  if (r.status !== 'PASS') L.push('  ⇒ 修法：**补引用（自引要标）+ 真正改写（改结构不是换同义词）**；本工具不给"洗稿"建议。');
  return L.join('\n');
}

function selftest() {
  const cases = [];
  const ck = (name, fn) => { let r; try { r = fn(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ name, ok: r === true, d: r === true ? '' : String(r) }); };
  const para = 'Public aging datasets make it possible to compare state of health prediction methods under controlled operating conditions and the analysis in this paper is built on the NASA battery aging dataset';
  ck('★必失败面：整段照抄自己的旧稿 ⇒ FAIL（并报出最长连续段）', () => {
    const r = check(para, [{ file: 'old.md', text: para }], { n: 8 });
    /* ★ 口径修正：单源近全同（本稿旧版/草稿）会被降级为 WARN 并带 selfDraft ——
       所以这里断言的是"**原始读数仍是 FAIL**，且**被显式标注**"，不是"最终状态 FAIL"。 */
    return (r.rawStatus === 'FAIL' && r.longest >= 24 && r.selfDraft.length === 1) ? true : JSON.stringify(r);
  });
  ck('正控：完全改写（结构与词都换）⇒ PASS', () => {
    const r = check('We re-analysed cells from a public battery aging archive; comparisons were made under fixed test conditions.', [{ file: 'old.md', text: para }], { n: 8 });
    return (r.status === 'PASS') ? true : JSON.stringify(r);
  });
  ck('★中文按字符切：连续 15 字相同 ⇒ 检出（n=12）', () => {
    const zh = '本研究以公开的老化数据集为基础在受控工况下比较健康状态预测方法的效果';
    const r = check('我们采用该数据集，' + zh + '，并给出结果。', [{ file: 'old-zh.md', text: zh }], { n: 12 });
    return (r.status !== 'PASS' && r.longest >= 24) ? true : JSON.stringify(r);
  });
  ck('★必失败面：语料库为空 ⇒ SKIP（**未核对 ≠ 通过**）', () => {
    const r = check(para, [], { n: 8 });
    return (r.status === 'SKIP' && /未核对/.test(r.why)) ? true : JSON.stringify(r);
  });
  ck('归一化：markdown/公式/引用标记/参考文献节 不该造成假重合', () => {
    const withNoise = '# 标题\n\nWe use `x=1` in $E=mc^2$ [12].\n\n## References\n\n' + para;
    const r = check(withNoise, [{ file: 'old.md', text: 'Completely different vocabulary appears in this unrelated archived paragraph about batteries and thermals.' }], { n: 8 });
    return (r.status === 'PASS' && r.refsExcluded === true) ? true : JSON.stringify(r);
  });
  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nplagself 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const nf = v('--new'); const dir = v('--corpus');
  if (!nf || !dir || !fs.existsSync(nf) || !fs.existsSync(dir)) { console.error('前提层失败：需要 --new <新稿> --corpus <旧稿目录>'); return 2; }
  const corpus = readCorpus(dir)
    /* ★ 真用才发现的坑：语料目录若包含**新稿自己**，会得到 100% 自匹配（毫无意义的 FAIL）
       ⇒ 按解析后的绝对路径剔除新稿本身，并在回执里报出剔除了几个。 */
    .filter((f) => path.resolve(f) !== path.resolve(nf))
    .map((f) => ({ file: f, text: fs.readFileSync(f, 'utf8') }));
  const r = check(fs.readFileSync(nf, 'utf8'), corpus, { n: v('--n') });
  if (r.status !== 'SKIP') console.log('  （已剔除新稿自身；实际参与比对的语料 ' + r.corpusFiles + ' 篇）');
  console.log(argv.includes('--json') ? JSON.stringify(r, null, 2) : render(r));
  return r.status === 'FAIL' ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { check, render, selftest, norm, tokens, readCorpus };
