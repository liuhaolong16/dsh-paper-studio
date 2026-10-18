#!/usr/bin/env node
/**
 * abstract-strength —— **摘要强度 ≤ 正文限定**门（图谱 R1）。
 *
 * 来源：《论文写作基因图谱 v1》R1（4/4 类体裁共有，`paper-gene/ATLAS-v1.md` §2）。
 * 真实形态（读 10 份单篇结论时反复见到）：
 *   · Dropout 摘要的 record 无同类限定，正文才有"不用先验知识/不用说话人身份"；
 *   · Transformer 摘要 `generalizes well` 只覆盖一个任务族一种语言（正文才有范围）；
 *   · 学位论文摘要用 "significant/strong"，正文才给"单只 R²≥0.9856、合并 0.9737"。
 *
 * 判据（启发式，只做三档，**不产出 PASS**）：
 *   1. 取摘要段（`## Abstract` / `**Abstract**` / `## 摘要`）。
 *   2. 在摘要里找**强度词**：superlative/absolute（state-of-the-art、first、best、dramatically…）、
 *      效应（outperform、surpass、significantly better、prove、guarantee…）、范围（always、never、universal…）。
 *   3. 对每个含强度词的摘要句，取它的实词（≥4 字母、在正文出现过），到正文里找**同时含该实词与限定语**的句子
 *      （限定语：only、under、at N、in our setting、on this dataset、limited to、except、respectively、
 *       to the best of our knowledge、when…）。
 *      · 找到 ⇒ 该句判 OK（强度有正文限定支撑）
 *      · 找不到 ⇒ 该句判 REVIEW（列出摘要原句 + 提示去正文补限定）
 *   4. 摘要里没有强度词 ⇒ 整份 OK；没有摘要段 ⇒ **SKIP（未核对，不得当通过）**。
 *
 * 诚实边界（必须打印）：
 *   · 这是**表层词匹配**：找到限定语不等于限定真的覆盖了那句主张（语义要人读）；
 *   · 找不到限定语也**不等于**摘要一定过强（可能正文用了别的说法）；
 *   · 中英混排、改写、同义替换都会漏。**REVIEW 是人读清单，不是判死**。
 *
 * 用法：
 *   node bin/abstract-strength.cjs --draft <稿.md> [--json]
 *   node bin/abstract-strength.cjs --selftest
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'v1.0.0';

/** 分析笔记不是稿件（与 absence / number-consistency / definition-first 同一守卫）。 */
function looksLikeAnalysisNote(text) {
  if (/(^#{1,6}[^\n]*证据索引|^#{1,6}[^\n]*evidence\s+index)/im.test(text)) return '含「证据索引」节';
  if (/(^##\s*0\.\s*摘要式结论|^\|\s*\*\*论证\*\*\s*\|)/m.test(text)) return '含「摘要式结论」或 7 栏论证表';
  return null;
}

const STRONG = [
  { kind: '绝对/最强', re: /\b(state[- ]of[- ]the[- ]art|best|first|novel|unprecedented|revolutionary|breakthrough|optimal|perfect|guarantee[sd]?)\b/i },
  { kind: '效应', re: /\b(outperform(?:s|ed|ing)?|surpass(?:es|ed|ing)?|significantly\s+(?:better|higher|lower|improv\w*)|dramatically|substantially\s+(?:better|higher|lower)|superior(?:\s+to)?|prove[sd]?|demonstrate[sd]?\s+(?:superiority|that))\b/i },
  { kind: '范围', re: /\b(always|never|in\s+all\s+cases|universally|unconditionally|across\s+all|任何情况下|一律|完全避免)\b/i },
  { kind: '中文强度', re: /(显著优于|大幅(?:提升|提高|降低)|最优|首次|完全避免|彻底解决|保证|证明了|远超)/ },
];

/** 正文里的限定语（限定强度、范围、条件）。 */
const QUALIFIER = /(\bonly\b|\bunder\b|\bat\s+-?\d|\bin\s+our\s+setting|\bon\s+(?:this|the)\s+(?:dataset|subset)|\blimited\s+to|\bexcept\b|\brespectively\b|to\s+the\s+best\s+of\s+our\s+knowledge|\bwhen\s+\w+|\bfor\s+(?:\d+|two|three)\s+of\b|\bwithin\b|\bup\s+to\b|\bat\s+most\b|仅|在.*条件下|限于|例外|分别)/i;

/** PDF 抽取文本会把一句拆成多行：上一行不以句末标点结尾时，把下一行接回去。 */
function reflow(buf) {
  return String(buf).split('\n').reduce((acc, line) => {
    const l = line.trim();
    if (!l) return acc;
    if (!acc) return l;
    return /[.!?。！？:：]$/.test(acc) ? acc + '\n' + l : acc + ' ' + l;
  }, '');
}

function splitSentences(par) {
  return String(par)
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}


function extractAbstract(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s*(?:\d+\.?\s*)?(abstract|摘要)\s*$/i);
    if (m) { start = i + 1; level = m[1].length; break; }
    if (/^\*\*\s*(abstract|摘要)\s*[:：]?\s*\*\*[:：]?\s*/i.test(lines[i])) {
      return { text: lines[i].replace(/^\*\*\s*(abstract|摘要)\s*[:：]?\s*\*\*[:：]?\s*/i, ''), startLine: i + 1 };
    }
  }
  if (start < 0) {
    // PDF 抽取文本的常见形态：一行以 `Abstract` / `摘要` 开头（可能后接 — 或 : 再接正文）
    let plain = -1;
    let firstRest = '';
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*(?:abstract|ABSTRACT|Abstract|摘要)\s*[:：—–\-]?\s*(.*)$/);
      if (m) { plain = i; firstRest = m[1] || ''; break; }
    }
    if (plain < 0) return null;
    const CAP = 1600;                       // 摘要长度上限（字符）
    const HARD = 2600;                      // 超过则判边界不可靠
    let buf = firstRest;
    let end = plain + 1;
    let headingHit = false;
    for (let i = plain + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/^(\d+\.?\s+[A-Z]|[IVX]+\.\s+[A-Z]|index\s*terms|key\s*words|keywords|关键词)/i.test(l)) { end = i; headingHit = true; break; }
      if (buf.length + l.length > CAP) { end = i; break; }
      buf += '\n' + l;
      end = i + 1;
    }
    if (buf.length > HARD) {
      return { text: buf, startLine: plain + 2, endLine: end, unreliable: `抽到 ${buf.length} 字符，超过硬上限 ${HARD}` };
    }
    return {
      text: reflow(buf).trim(), startLine: plain + 2, endLine: end,
      note: headingHit ? '' : `摘要按 ${CAP} 字符上限截取（未命中终止标题），边界可能不准 —— 结果只作提示`
    };
  }
  const out = [];
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (m && m[1].length <= level) { end = i; break; }
    out.push(lines[i]);
  }
  return { text: out.join('\n').trim(), startLine: start + 1, endLine: end };
}

/** 实词：≥4 字符、非停用、非纯数字。 */
const EN_STOP = new Set(('this that these those with from into than then they their there here which while whose where when what have has had been being were was are is the and for our its can may might will would could should not all any but also such more most less least very only over under about after before during between within without across among each both some many much other another same different using used use show shows shown report reports reported based present presents presented propose proposes proposed method methods approach approaches model models result results study paper work data set sets new two three four five first second third').split(/\s+/));

function contentWords(sentence) {
  const words = String(sentence).toLowerCase().match(/[a-z][a-z\-]{3,}/g) || [];
  const seen = new Set();
  return words.filter((w) => {
    if (EN_STOP.has(w)) return false;
    if (seen.has(w)) return false;
    seen.add(w);
    return true;
  });
}

function run(file) {
  const text = fs.readFileSync(file, 'utf8');
  const noteMark = looksLikeAnalysisNote(text);
  if (noteMark) {
    return { status: 'SKIP', file, items: [], note: `疑似分析笔记（${noteMark}），不是稿件 ⇒ 本门不适用；请对**投稿稿**运行` };
  }
  const abs = extractAbstract(text);
  if (!abs || !abs.text.trim()) {
    return { status: 'SKIP', file, items: [], note: '没找到摘要段（`## Abstract` / `**Abstract**` / `## 摘要`）⇒ 无可核对象，不得当通过' };
  }

  const absSentences = splitSentences(abs.text);
  // 边界守卫：硬上限之外的抽取一律判未核对；软上限内的截取照常分析但在 note 里声明边界可能不准
  if (abs.unreliable) {
    return { status: 'SKIP', file, items: [], note: `摘要边界不可靠（${abs.unreliable}）⇒ 本门在这份稿上未核对，不得当通过` };
  }

  // 正文 = 摘要**之后**的部分（不能把摘要本身算作"正文有交代"，那是自证）
  const bodyFrom = abs.endLine != null ? abs.endLine : abs.startLine;
  const bodyText = text.split(/\r?\n/).slice(bodyFrom).join('\n');
  const bodySentences = splitSentences(bodyText);

  const items = [];
  for (const sent of absSentences) {
    const hits = STRONG.map((s) => ({ kind: s.kind, m: sent.match(s.re) })).filter((x) => x.m);
    if (!hits.length) continue;
    const words = contentWords(sent);
    // 正文里同时含该句实词与限定语的句子
    const support = bodySentences.filter((bs) => {
      if (!QUALIFIER.test(bs)) return false;
      const low = bs.toLowerCase();
      // 至少两个实词重合才算「同一主张」——只重合一个词（如 across）会把无关句子当成支撑
      const overlap = words.filter((w) => low.includes(w)).length;
      return overlap >= 2;
    });
    items.push({
      sentence: sent.slice(0, 220),
      kinds: [...new Set(hits.map((h) => h.kind))],
      markers: [...new Set(hits.map((h) => h.m[0]))],
      keywords: words.slice(0, 6),
      ok: support.length > 0,
      support: support.slice(0, 1).map((s) => s.slice(0, 200)),
    });
  }

  const strongSentences = splitSentences(abs.text).filter((s) => STRONG.some((x) => x.re.test(s))).length;
  if (!items.length) {
    return {
      status: 'OK', file, items: [],
      note: `摘要 ${splitSentences(abs.text).length} 句里没有强度词 ⇒ 未触发规则（OK 只表示没触发表层规则，不等于论证成立）`
    };
  }
  const passed = items.filter((i) => i.ok).length;
  const status = passed === items.length ? 'OK' : 'REVIEW';
  return {
    status, file, items,
    note: (abs.note ? abs.note + '；' : '') +
      `抽到 ${items.length} 句带强度词（共 ${strongSentences} 句）· 其中 ${passed} 句在正文找到限定语；` +
      '**这是表层词匹配**：找到限定语不等于限定真覆盖了该主张，找不到也不等于摘要一定过强 —— REVIEW 是人读清单'
  };
}

function print(r) {
  console.log(`abstract-strength ${VERSION} —— 摘要强度 ≤ 正文限定门（来源：基因图谱 R1）`);
  console.log(`稿：${r.file}`);
  if (r.status === 'SKIP') { console.log(`\nSKIP：${r.note}`); return; }
  const bad = r.items.filter((i) => !i.ok);
  console.log(`带强度词的摘要句 ${r.items.length} 句 · 正文找到限定 ${r.items.length - bad.length} 句 · 缺限定 ${bad.length} 句 ⇒ ${r.status}（本工具没有 PASS 这一档）`);
  console.log('');
  for (const i of r.items) {
    if (i.ok) {
      console.log(`✔ [有正文限定] ${i.markers.join('/')}（${i.kinds.join('·')}）`);
      console.log(`    摘要：${i.sentence}`);
      console.log(`    正文：${i.support[0]}`);
    } else {
      console.log(`△ [摘要强·正文未见限定] ${i.markers.join('/')}（${i.kinds.join('·')}）`);
      console.log(`    摘要：${i.sentence}`);
      console.log(`    去正文找含「${i.keywords.slice(0, 3).join(' / ')}」的句子并补范围/条件`);
    }
  }
  console.log(`\n边界：${r.note}`);
  console.log('复核命令：node bin/abstract-strength.cjs --draft <稿.md> --json');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absstr-'));
  const mk = (n, b) => { const p = path.join(tmp, n); fs.writeFileSync(p, b, 'utf8'); return p; };

  const withLimit = mk('a.md', [
    '# Title', '', '## Abstract', '',
    'Our method significantly outperforms all baselines on the benchmark.', '',
    '## 1. Introduction', '',
    'We evaluate on the benchmark. The method outperforms baselines only under 4 °C.', ''
  ].join('\n'));
  const noLimit = mk('b.md', [
    '# Title', '', '## Abstract', '',
    'Our method significantly outperforms all baselines on the benchmark.', '',
    '## 1. Introduction', '',
    'We evaluate on the benchmark and report accuracy.', ''
  ].join('\n'));
  const noStrong = mk('c.md', [
    '# Title', '', '## Abstract', '',
    'We study how features transfer across temperature.', '',
    '## 1. Introduction', '', 'Body.', ''
  ].join('\n'));
  const noAbstract = mk('d.md', '# Title\n\n## 1. Introduction\n\nBody only.\n');
  const note = mk('e.md', '# 某篇结论\n\n摘要里写了 significantly 但正文没有限定。\n\n## 9. 证据索引\n| P1 §2 ‖ q |\n');
  const boldAbs = mk('f.md', '# T\n\n**Abstract:** We achieve the best accuracy, significantly better than prior work.\n\n## 1 Intro\n\nOn this dataset only, accuracy is best.\n');

  const cases = [
    ['摘要强 + 正文有「only under 4 °C」限定 ⇒ OK', withLimit, 'OK'],
    ['摘要强 + 正文无任何限定 ⇒ REVIEW', noLimit, 'REVIEW'],
    ['摘要无强度词 ⇒ OK（未触发）', noStrong, 'OK'],
    ['负控（无摘要段）⇒ SKIP', noAbstract, 'SKIP'],
    ['负控（分析笔记）⇒ SKIP', note, 'SKIP'],
    ['**Abstract:** 行内形式 + 正文限定 ⇒ OK', boldAbs, 'OK'],
  ];

  let ok = 0;
  for (const [name, file, want] of cases) {
    const r = run(file);
    // 判定必须严格为 true：用真值判断时空数组/空字符串会把失败读成通过
    if (r.status === want === true) { ok++; console.log(`  ✔ ${name}: ${r.status}`); }
    else { console.log(`  ✘ ${name}: 期望 ${want}，实得 ${r.status}`); }
  }

  // 必失败臂：同一稿，把正文那句限定语删掉，必须由 OK 翻 REVIEW
  const armOn = mk('g1.md', [
    '# T', '', '## Abstract', '', 'We significantly improve accuracy on the benchmark.', '',
    '## 1 Intro', '', 'On this dataset only, accuracy improves on the benchmark.', ''
  ].join('\n'));
  const armOff = mk('g2.md', [
    '# T', '', '## Abstract', '', 'We significantly improve accuracy on the benchmark.', '',
    '## 1 Intro', '', 'Accuracy improves on the benchmark.', ''
  ].join('\n'));
  const a1 = run(armOn).status, a2 = run(armOff).status;
  if (a1 === 'OK' && a2 === 'REVIEW') { ok++; console.log('  ✔ 必失败臂：删掉正文限定语后由 OK 翻 REVIEW'); }
  else { console.log(`  ✘ 必失败臂失灵（with=${a1} without=${a2}）`); }

  const total = cases.length + 1;
  console.log(`\nabstract-strength 自检：${ok}/${total} 通过`);
  process.exit(ok === total ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else {
  const i = argv.indexOf('--draft');
  const file = i >= 0 ? argv[i + 1] : null;
  if (!file || !fs.existsSync(file)) {
    console.log('用法：node bin/abstract-strength.cjs --draft <稿.md> [--json]  |  --selftest');
    process.exit(2);
  }
  const r = run(file);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
  process.exit(r.status === 'REVIEW' ? 0 : 0);   // 恒 0：REVIEW 是要人读，不是机器判死
}
