#!/usr/bin/env node
/**
 * absence —— **缺席断言三档门（未做／未报／未见）**。
 *
 * 来源：《论文写作基因图谱 v1》R2（4/4 类体裁共有的约束，`paper-gene/ATLAS-v1.md` §2）。
 * 这条是图谱里"实测犯错最多"的一族：把"没搜到"写成"没有"、把"没报"写成"没做"。
 * 真实事故：一份结论断言"类别不平衡处理全未提"，而原文 p.3 明写 balanced training sets；
 * 另一份断言"train/test/split 零命中"，实际 `trained`/`Training` 全在 —— 根因是**检索词未覆盖词形变化**。
 *
 * 判据（窄口径，只管"作者有没有把档位说出来"）：
 *   1. 扫描稿件里的**缺席断言句**（中文：无／没有／从未／未／不存在／缺乏／零；英文：no … found/reported/observed 等）；
 *   2. 每句必须带**紧邻的机器可检标注**：〔缺席=未做〕／〔缺席=未报; 位置=p.7 表2〕／〔缺席=未见; 检索=ablat*|ablation; 范围=p.1–18〕；
 *   3. 档位规则：
 *      · 未见 ⇒ 必须给 `检索=` 与 `范围=`；且检索词必须**覆盖词形变化**（含 `*` 通配或 `|` 备选），否则 WARN（词表可能漏词形）；
 *      · 未报 ⇒ 必须给 `位置=`（在哪提到但没进表/没给数）；
 *      · 未做 ⇒ 无需附加（可选 `依据=`）；
 *   4. **未标注 = FAIL（待标注）**，不是 WARN —— 因为"没填档"等于这句话不可复核。
 *
 * 诚实边界（必须打印在回执里）：
 *   · 本工具只做**句式关键词匹配**，不判语义：它不判断这句"无 X"说得对不对，只判断**作者有没有给可复核的口径**；
 *   · 稿件里**没有任何缺席断言** ⇒ `SKIP（未含缺席断言，不得当通过）`；
 *   · 代码块（``` 围栏）内的内容不扫 —— 那是示例/补丁，不是论述。
 *
 * 用法：
 *   node bin/absence.cjs --draft <稿.md> [--json]
 *   node bin/absence.cjs --selftest
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'v1.1.0';

/**
 * 文档类型守卫：**分析笔记不是稿件**。
 * 实证（2026-10-17 反向验证）：拿本工具扫 paper-gene 的 10 份单篇结论（分析笔记），
 * 会成片报 FAIL —— 因为它们本来就是"描述别人稿件里没有什么"的文本。
 * ⇒ 命中「证据索引」节或「摘要式结论 / 7 栏论证表」标记时，直接 SKIP 并说明，**不许硬报**。
 */
function looksLikeAnalysisNote(text) {
  if (/(^#{1,6}[^\n]*证据索引|^#{1,6}[^\n]*evidence\s+index)/im.test(text)) return '含「证据索引」节';
  if (/(^##\s*0\.\s*摘要式结论|^\|\s*\*\*论证\*\*\s*\|)/m.test(text)) return '含「摘要式结论」或 7 栏论证表';
  return null;
}

// ── 缺席断言识别（宁窄勿宽：只抓"断言不存在"，不抓普通否定） ──
const ZH_PATTERNS = [
  /(?:全文|全篇|正文|表中|图|附录|文中)?.{0,12}(?:没有|没有任何|未|从未|均未|皆无|不存在|缺乏|缺\s*少)/,
  /(?:无)\s*(?:相应|任何|独立|相关|专门|明确|显式)?\s*(?:章节|节|表|图|数据|说明|讨论|定义|披露|声明)/,
  /(?:零|0)\s*(?:命中|出现|次)/
];
const EN_PATTERNS = [
  /\bno\s+[\w\-]{2,}(?:\s+[\w\-]{2,}){0,4}\s+(?:was|were|is|are)?\s*(?:found|reported|observed|provided|given|available)\b/i,
  /\bnot\s+(?:reported|observed|measured|discussed|provided|available)\b/i,
  /\b(?:absent|missing)\s+(?:from|in)\b/i,
  /\bnone\s+of\b/i,
  /\bzero\s+(?:hits?|occurrences?|matches?)\b/i
];

// 标注块：〔缺席=未见; 检索=...; 范围=...〕  （也接受半角 [] 与全角＝）
const ANNO_RE = /[〔\[［]\s*缺席\s*[=＝]\s*(未做|未报|未见)\s*([^〕\]］]*)[〕\]］]/g;
const TIER = { '未做': 'NOT_DONE', '未报': 'NOT_REPORTED', '未见': 'NOT_SEEN' };

function splitFields(tail) {
  const out = {};
  for (const seg of String(tail).split(/[;；]/)) {
    const m = seg.match(/^\s*([^=＝:：]{1,8})\s*[=＝:：]\s*(.+?)\s*$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

function scan(text) {
  const lines = text.split(/\r?\n/);
  const hits = [];
  const skipped = { fence: 0, table: 0, quote: 0, mention: 0 };
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) { inFence = !inFence; skipped.fence++; return; }
    if (inFence) { skipped.fence++; return; }
    if (!line.trim()) return;
    // 表格行：格内文字是数据登记，不是论述句
    if (/^\s*\|/.test(line)) { skipped.table++; return; }
    // 引用块：那是别人的话（或我引用的原文），不是本人的缺席断言
    if (/^\s*>/.test(line)) { skipped.quote++; return; }
    // 抹掉行内代码与引号内容：`train`、"未报告" 属「提及」而非「断言」
    const original = line;
    const stripped = original
      .replace(/`[^`]*`/g, ' ')
      .replace(/"[^"]{0,80}"/g, ' ')
      .replace(/“[^”]{0,80}”/g, ' ')
      .replace(/「[^」]{0,80}」/g, ' ')
      .replace(/『[^』]{0,80}』/g, ' ');
    if (stripped !== original && !ZH_PATTERNS.some((re) => re.test(stripped)) && !EN_PATTERNS.some((re) => re.test(stripped))) {
      skipped.mention++; return;
    }
    const zh = ZH_PATTERNS.some((re) => re.test(stripped));
    const en = EN_PATTERNS.some((re) => re.test(stripped));
    if (!zh && !en) return;
    // 同句/相邻行的标注
    const zone = [lines[i - 1] || '', line, lines[i + 1] || ''].join('\n');
    const annos = [...zone.matchAll(ANNO_RE)].map((m) => ({ tier: m[1], fields: splitFields(m[2]) }));
    hits.push({ line: i + 1, text: line.trim().slice(0, 160), annos });
  });
  return { hits, skipped };
}

function judge(hit) {
  if (!hit.annos.length) {
    return { level: 'FAIL', code: 'UNANNOTATED', reason: '缺席断言未标档位（未做/未报/未见），该句不可复核' };
  }
  const a = hit.annos[0];
  const f = a.fields;
  const has = (k) => Boolean(f[k] && f[k].trim());
  if (a.tier === '未见') {
    if (!has('检索') || !has('范围')) {
      return { level: 'FAIL', code: 'NOT_SEEN_INCOMPLETE', reason: '「未见」必须同时给 检索=词表 与 范围=被检文本范围' };
    }
    const terms = f['检索'];
    const wordformOk = /[|｜]/.test(terms) || /[*＊]/.test(terms);
    if (!wordformOk) {
      return { level: 'WARN', code: 'WORDFORM_UNCOVERED', reason: '检索词未见通配或备选（`*` 或 `|`）⇒ 可能漏词形（trained/Training 抓不到 train）' };
    }
    return { level: 'PASS', code: 'NOT_SEEN_OK', reason: `未见＋检索词表（${terms.slice(0, 40)}）＋范围（${f['范围'].slice(0, 30)}）` };
  }
  if (a.tier === '未报') {
    if (!has('位置')) return { level: 'FAIL', code: 'NOT_REPORTED_NO_LOC', reason: '「未报」必须给 位置=（在哪提到但没进表/没给数）' };
    return { level: 'PASS', code: 'NOT_REPORTED_OK', reason: `未报＋位置（${f['位置'].slice(0, 40)}）` };
  }
  return { level: 'PASS', code: 'NOT_DONE_OK', reason: '未做（作者自述/实验记录可支持）' };
}

function run(file) {
  const text = fs.readFileSync(file, 'utf8');
  const noteMark = looksLikeAnalysisNote(text);
  if (noteMark) {
    return {
      status: 'SKIP', file, total: 0, hits: [], skipped: null,
      note: `疑似分析笔记（${noteMark}），不是稿件 ⇒ 本门不适用。权威用法：扫**投稿稿**；分析笔记里的"无/没有"是在描述别人的稿件。`
    };
  }
  const { hits: raw, skipped } = scan(text);
  const hits = raw.map((h) => ({ ...h, ...judge(h) }));
  if (!hits.length) {
    return { status: 'SKIP', file, total: 0, hits, skipped, note: '未含缺席断言，不得当通过（本工具未检查到对象）' };
  }
  const fail = hits.filter((h) => h.level === 'FAIL').length;
  const warn = hits.filter((h) => h.level === 'WARN').length;
  return {
    status: fail ? 'FAIL' : warn ? 'WARN' : 'PASS',
    file, total: hits.length, pass: hits.filter((h) => h.level === 'PASS').length, warn, fail, hits, skipped,
    note: '本工具只判「档位与口径是否给了」，不判这句「无 X」说得对不对'
  };
}

function print(r) {
  console.log(`absence ${VERSION} —— 缺席断言三档门（来源：基因图谱 R2）`);
  console.log(`稿：${r.file}`);
  if (r.status === 'SKIP') {
    console.log(`\n${r.status}：未含缺席断言（扫描到 0 句）`);
    console.log(`  ${r.note}`);
    return;
  }
  console.log(`\n缺席断言 ${r.total} 句：PASS ${r.pass} · WARN ${r.warn} · FAIL ${r.fail}   ⇒ ${r.status}`);
  if (r.skipped) { const s = r.skipped; console.log('跳过：表格行 ' + s.table + ' · 引用块 ' + s.quote + ' · 代码块 ' + s.fence + ' · 仅提及（引号内）' + s.mention); }
  console.log('');
  for (const h of r.hits) {
    const mark = h.level === 'PASS' ? '✔' : h.level === 'WARN' ? '△' : '✘';
    console.log(`${mark} L${h.line} [${h.code}] ${h.reason}`);
    console.log(`    「${h.text}」`);
  }
  console.log(`\n边界：${r.note}`);
  console.log('复核命令：node bin/absence.cjs --draft <稿.md> --json');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'absence-'));
  const mk = (name, body) => { const p = path.join(tmp, name); fs.writeFileSync(p, body, 'utf8'); return p; };
  const cases = [];

  // 1 正例：未见 + 检索词带备选 + 范围
  cases.push(['未见合规', mk('a.md', '本文未设消融。 〔缺席=未见; 检索=ablat*|ablation; 范围=p.1–18〕'), 'PASS']);
  // 2 必失败臂①：未见缺检索与范围
  cases.push(['未见缺口径', mk('b.md', '正文没有给出误差棒。 〔缺席=未见〕'), 'FAIL']);
  // 3 必失败臂②：完全未标注
  cases.push(['未标注', mk('c.md', '全文没有任何局限性讨论。'), 'FAIL']);
  // 4 词形风险：检索词无通配无备选
  cases.push(['词形未覆盖', mk('d.md', '未见 train/test 划分。〔缺席=未见; 检索=train; 范围=p.1–5〕'), 'WARN']);
  // 5 未报需位置
  cases.push(['未报合规', mk('e.md', '未报告置信区间。〔缺席=未报; 位置=p.7 表 2〕'), 'PASS']);
  cases.push(['未报缺位置', mk('f.md', '未报告置信区间。〔缺席=未报〕'), 'FAIL']);
  // 6 未做
  cases.push(['未做', mk('g.md', '未做外部验证。〔缺席=未做〕'), 'PASS']);
  // 7 负控：无缺席断言 ⇒ SKIP（不得当通过）
  cases.push(['负控（无缺席）', mk('h.md', '本文提出一种方法，并在三个数据集上验证。'), 'SKIP']);
  // 8 负控：代码块内不扫
  cases.push(['负控（代码块）', mk('i.md', '示例：\n```\nfinds no match\n```\n正文其余正常。'), 'SKIP']);
  // 9 英文缺席断言 + 未标注
  cases.push(['英文未标注', mk('j.md', 'No ablation was reported in the paper.'), 'FAIL']);
  // 10 文档类型守卫：分析笔记 ⇒ SKIP（不许硬报）
  cases.push(['负控（分析笔记）', mk('k.md', '# 某篇结论\n\n全文没有任何 Limitations 节。\n\n## 9. 证据索引\n| P1 §2 ‖ quote |\n'), 'SKIP']);

  let ok = 0;
  for (const [name, file, want] of cases) {
    const r = run(file);
    const got = r.status;
    if (got === want) { ok++; console.log(`  ✔ ${name}: ${got}`); }
    else { console.log(`  ✘ ${name}: 期望 ${want}，实得 ${got}`); }
  }
  // 必失败臂元自检：确认「去掉标注后同一句必须翻红」
  const armed = mk('k.md', '未见消融。〔缺席=未见; 检索=ablat*; 范围=p.1–18〕');
  const stripped = mk('k2.md', '未见消融。');
  const armOk = run(armed).status === 'PASS' && run(stripped).status === 'FAIL';
  if (armOk) { ok++; console.log('  ✔ 必失败臂：去掉标注后同一句由 PASS 翻 FAIL'); }
  else { console.log('  ✘ 必失败臂失灵：去标注未翻红'); }

  const total = cases.length + 1;
  console.log(`\nabsence 自检：${ok}/${total} 通过`);
  process.exit(ok === total ? 0 : 1);
}

// ── CLI ──
const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else {
  const i = argv.indexOf('--draft');
  const file = i >= 0 ? argv[i + 1] : null;
  if (!file || !fs.existsSync(file)) {
    console.log('用法：node bin/absence.cjs --draft <稿.md> [--json]  |  --selftest');
    process.exit(2);
  }
  const r = run(file);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
  process.exit(r.status === 'FAIL' ? 1 : 0);
}
