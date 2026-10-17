#!/usr/bin/env node
/**
 * definition-first —— **定义先行（R6）＋ 起首可核边界（R4）**合并门。
 *
 * 来源：《论文写作基因图谱 v1》R4、R6（都是 4/4 类体裁共有，`paper-gene/ATLAS-v1.md` §2）。
 * R4 落地前先实测过插件有无执行面：`relevance-gate` 只判**词面重合度（相关性）**，`gate-runner` 是门调度器，
 * 全 `bin/` 检索「不覆盖 / out of scope / scope statement / 定义为 / 可复算」只有无关命中 ⇒ **两项都无执行面**，
 * 因此新建本工具（R4 的"先实测再决定"结论：**需要新建**）。
 *
 * ⚠️ **本工具不产出 PASS**（图谱要求："只能标启发式，不得命名为 PASS"）。
 *    状态只有三种：`OK` / `REVIEW` / `SKIP`。OK 的含义是"没触发表层规则"，**不等于**论证成立。
 *
 * ── R4 起首可核边界 ──
 *   判据：第一节（或全文前 40 行）必须出现一句"覆盖 X、不覆盖 Y"，且该句含**可逐项核的界定项**：
 *         时间窗（2018–2024 / 6 个月）· 对象或数据类型（锂离子电芯 / ICU 队列）· 规模区间（10–100）· 显式清单（A、B）。
 *   只出现 "覆盖大部分 / mostly / encompass most" 这类**不可核**说法 ⇒ REVIEW。
 *
 * ── R6 定义先行 / 可复算 ──
 *   判据：在**第一个结果数字之前**，四要素是否都已出现：
 *         ① 对象/任务定义 ② 对照或基线 ③ 坐标/尺度/口径 ④ 判定或计量规则。
 *   缺任一 ⇒ REVIEW，并列出缺哪一项。数字段之后才补定义 ⇒ 仍然 REVIEW（这正是"定义后置"）。
 *
 * 诚实边界（必须打印）：
 *   · 只判"文中是否出现过定义性/界定性表述"，**不判读者能否真的复算**；判定词匹配也会漏（同义表述未收录）；
 *   · 没有结果数字 / 没有节标题 ⇒ `SKIP（未含可检查对象，不得当通过）`。
 *
 * 用法：
 *   node bin/definition-first.cjs --draft <稿.md> [--check scope|definition|both] [--json]
 *   node bin/definition-first.cjs --selftest
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = 'v1.1.0';

/** 文档类型守卫：分析笔记不是稿件（详见 absence.cjs 同名函数注释）。 */
function looksLikeAnalysisNote(text) {
  if (/(^#{1,6}[^\n]*证据索引|^#{1,6}[^\n]*evidence\s+index)/im.test(text)) return '含「证据索引」节';
  if (/(^##\s*0\.\s*摘要式结论|^\|\s*\*\*论证\*\*\s*\|)/m.test(text)) return '含「摘要式结论」或 7 栏论证表';
  return null;
}

const SCOPE_SENT = /(本文|本研究|本篇|本工作|this\s+(?:paper|study|work))[^。；;\n]{0,90}(覆盖|涵盖|不覆盖|不涉及|限于|聚焦|仅讨论|只讨论|cover(?:s|ed|ing)?|not\s+cover|focus(?:es|ed)?\s+on|limit(?:s|ed)?\s+to|restrict(?:s|ed)?\s+to|consider(?:s|ed)?\s+only)|(out\s+of\s+scope|beyond\s+the\s+scope|不在本文(?:的)?范围|本文不涉及)/i;
const DELIMS = [
  { key: '时间窗', re: /((?:19|20)\d{2}\s*[–\-~至到]\s*(?:19|20)\d{2}|\d+\s*(?:年|个月|月|天|days?|months?|years?|weeks?))/i },
  { key: '对象/数据类型', re: /(锂离子|钠离子|电芯|电池|队列|患者|语料|数据集|样本|cell|batter|lithium|cohort|patient|dataset|corpus|corpora|series)/i },
  { key: '规模区间', re: /(\d+\s*[–\-~至到]\s*\d+|\d+\s*[个件篇条项家所])/ },
  { key: '显式清单', re: /(、[^。；;\n]{1,20}、|,\s*[^.;\n]{1,20}\s*,|以及|和|与)/ }
];
const DEF_ELEMENTS = [
  { key: '对象/任务定义', re: /(定义[^。；;\n]{0,16}为|定义为|定义是|即|所谓|指的是|指\s*[^。]{0,10}|define[sd]?\s+as|is\s+defined\s+as|refers\s+to|we\s+define|we\s+consider)/i },
  { key: '对照/基线', re: /(对照|基线|基准|baseline|versus|\bvs\.?\b|compared\s+(?:to|with)|relative\s+to)/i },
  { key: '坐标/尺度/口径', re: /(单位|口径|尺度|坐标系|阈值|阈值化|指标|以\s*[^。]{0,8}\s*计|unit|units|metric|threshold|scale|scale\s+of)/i },
  { key: '判定/计量规则', re: /(判定|判据|视为|算作|计入|记为|criteria|criterion|considered\s+as|counted\s+as|treated\s+as|scored\s+as|read\s+as|interpreted\s+as|taken\s+as|not\s+read\s+as)/i }
];

function firstSection(text) {
  const lines = text.split(/\r?\n/);
  // 首节 = **Introduction**（跳过标题/作者/摘要等前置块）——真实稿件里 "第 1 个标题" 往往是论文题目
  const introRe = /^#{1,6}\s*(?:\d+\.?\s*)?(introduction|引言|前言)\b|^#{1,6}\s*1\.?\s*introduction/i;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (introRe.test(lines[i])) { start = i; break; }
  }
  if (start < 0) {
    // 退回旧行为：第一个标题块
    let seenHeading = 0;
    for (let i = 0; i < lines.length; i++) {
      if (/^#{1,6}\s+\S/.test(lines[i])) {
        seenHeading++;
        if (seenHeading === 1) { start = i; continue; }
        if (seenHeading === 2) return { lines: lines.slice(i === 0 ? 0 : start, i), startLine: (start || 0) + 1, endLine: i };
      }
    }
    if (start < 0) start = 0;
    return { lines: lines.slice(start, Math.min(lines.length, 40)), startLine: start + 1, endLine: Math.min(lines.length, 40) };
  }
  // 从 Introduction 起，到下一个**同级或更高级**标题为止
  const level = (lines[start].match(/^#+/) || ['#'])[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) { end = i; break; }
  }
  return { lines: lines.slice(start, end), startLine: start + 1, endLine: end };
}

function checkScope(text) {
  const sec = firstSection(text);
  const body = sec.lines.join('\n');
  if (!body.trim()) return { status: 'SKIP', code: 'NO_BODY', why: '首节取不到内容（空稿或全是标题）', hits: [] };
  const hitLine = sec.lines.findIndex((l) => SCOPE_SENT.test(l));
  if (hitLine < 0) {
    return {
      status: 'REVIEW', code: 'NO_SCOPE_SENTENCE',
      why: `第 ${sec.startLine}–${sec.endLine} 行（首节）未见「覆盖 X、不覆盖 Y」式界定句`,
      hits: []
    };
  }
  const line = sec.lines[hitLine];
  const matched = DELIMS.filter((d) => d.re.test(line)).map((d) => d.key);
  if (!matched.length) {
    return {
      status: 'REVIEW', code: 'SCOPE_NOT_CHECKABLE',
      why: '有界定句但缺可核项目（时间窗/对象/规模区间/显式清单一个都没匹配到）—— "覆盖大部分"这类说法不可逐项核',
      hits: [`L${sec.startLine + hitLine}: ${line.trim().slice(0, 120)}`]
    };
  }
  return { status: 'OK', code: 'SCOPE_OK', why: `首节有界定句，可核项：${matched.join(' / ')}`, hits: [`L${sec.startLine + hitLine}: ${line.trim().slice(0, 120)}`] };
}

function checkDefinition(text) {
  const lines = text.split(/\r?\n/);
  // ★ 只在**正文**里找第一个结果数字：摘要按惯例是正文的摘要，定义通常在其后（IMRaD 稿件摘要必然在引言前）
  const introIdx = lines.findIndex((l) => /^#{1,6}\s*(?:\d+\.?\s*)?(introduction|引言|前言)/i.test(l));
  const from = introIdx >= 0 ? introIdx : 0;
  // 第一个"结果数字"：含数字、且像指标或带百分号、且不是标题/引用/图表号/定义句
  let idx = -1;
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^#{1,6}\s/.test(l)) continue;
    if (!/\d/.test(l)) continue;
    if (/^\s*[|｜]/.test(l)) continue;            // 表格另行处理
    if (/(Fig(?:ure)?|Table|图|表)\s*\d/i.test(l) && !/(%|accuracy|auc|rmse|mae|bleu|准确|误差|率)/i.test(l)) continue;
    if (/(\d{4})\s*年|references|参考文献/i.test(l)) continue;
    // 定义性句子本身不算"结果数字"（中英都要跳：SOH 定义句里也会出现"容量/accuracy/reported as"）
    if (/(定义|口径|判据|criteri|standard\s+of|is\s+defined\s+as|are\s+defined\s+as|we\s+define|reported\s+as|measured\s+by)/i.test(l)) continue;
    // ★ 指标词：不认裸 `f1`（会与特征集名 F1/F2/F3 撞名），只认 f1-score / F1 score
    if (/(%|accuracy|auc|aupr|auprc|rmse|mae|bleu|rouge|precision|recall|f1[-\s]?score|准确|误差|召回|率|得分|损失|容量|效率)/i.test(l)) { idx = i; break; }
  }
  if (idx < 0) {
    // 表格里的数值也算结果，退化为"表格前的正文"
    const t = lines.findIndex((l) => /^\s*[|｜]/.test(l) && /\d/.test(l));
    if (t > 0) idx = t;
  }
  if (idx <= 0) return { status: 'SKIP', code: 'NO_RESULT_NUMBER', why: '取不到「第一个结果数字」（或它就在开头，无法判"先行"）', hits: [] };
  const prefix = lines.slice(0, idx).join('\n');
  const missing = [];
  const found = [];
  for (const el of DEF_ELEMENTS) {
    const m = prefix.match(el.re);
    if (m) found.push(`${el.key}（"${String(m[0]).slice(0, 16)}"）`);
    else missing.push(el.key);
  }
  if (missing.length) {
    return {
      status: 'REVIEW', code: 'DEFINITION_LAGGING',
      why: `第一个结果数字在 L${idx + 1}，但它之前缺：${missing.join(' / ')}`,
      hits: found.length ? [`已具备：${found.join(' · ')}`] : ['四要素一个都没在结果数字之前出现']
    };
  }
  return { status: 'OK', code: 'DEFINITION_OK', why: `结果数字（L${idx + 1}）之前四要素齐备`, hits: [found.join(' · ')] };
}

function run(file, which) {
  const text = fs.readFileSync(file, 'utf8');
  const noteMark = looksLikeAnalysisNote(text);
  if (noteMark) {
    return {
      file, checks: {}, status: 'SKIP',
      note: `疑似分析笔记（${noteMark}），不是稿件 ⇒ 本门不适用；请对**投稿稿**运行`
    };
  }
  const out = { file, checks: {}, status: 'OK' };
  const want = which || 'both';
  if (want === 'scope' || want === 'both') out.checks.scope = checkScope(text);
  if (want === 'definition' || want === 'both') out.checks.definition = checkDefinition(text);
  const sts = Object.values(out.checks).map((c) => c.status);
  if (sts.every((s) => s === 'SKIP')) out.status = 'SKIP';
  else if (sts.includes('REVIEW')) out.status = 'REVIEW';
  else out.status = 'OK';
  out.note = '本工具不产出 PASS：OK 只表示未触发表层规则，不等于论证成立；定义性表述是同义词表匹配，会漏';
  return out;
}

function print(r) {
  console.log(`definition-first ${VERSION} —— 定义先行（R6）＋ 起首可核边界（R4）`);
  console.log(`稿：${r.file}`);
  console.log(`总判定：${r.status}（本工具没有 PASS 这一档）`);
  console.log('');
  for (const [k, c] of Object.entries(r.checks)) {
    const label = k === 'scope' ? 'R4 起首可核边界' : 'R6 定义先行/可复算';
    console.log(`${c.status === 'OK' ? '✔' : c.status === 'SKIP' ? '·' : '△'} ${label} [${c.code}] ${c.why}`);
    for (const h of c.hits) console.log(`    ${h}`);
  }
  console.log(`\n边界：${r.note}`);
  console.log('复核命令：node bin/definition-first.cjs --draft <稿.md> --json');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deffirst-'));
  const mk = (n, b) => { const p = path.join(tmp, n); fs.writeFileSync(p, b, 'utf8'); return p; };
  const cases = [];
  const goodScope = '# 1 Introduction\n本文覆盖 2018 至 2024 年的锂离子电池老化数据，不涉及钠离子体系。\n\n## 2 Methods\ntext\n';
  cases.push(['R4 合规', mk('a.md', goodScope), 'scope', 'OK']);
  cases.push(['R4 缺界定句', mk('b.md', '# 1 Introduction\n电池老化很重要。\n\n## 2 Methods\ntext\n'), 'scope', 'REVIEW']);
  cases.push(['R4 界定句不可核', mk('c.md', '# 1 Introduction\n本文覆盖大部分相关工作，不涉及部分内容。\n\n## 2 Methods\ntext\n'), 'scope', 'REVIEW']);
  cases.push(['R4 英文合规', mk('d.md', '# 1 Introduction\nThis study focuses on lithium-ion cells from 2019–2024; lead-acid is out of scope.\n'), 'scope', 'OK']);

  const goodDef = '# 1 Introduction\n我们定义 SOH 为单位容量相对初始容量的比值，基线取线性回归，判定以 0.8 为阈值。\n## 2 Results\nRMSE 1.2 达到最好。\n';
  cases.push(['R6 合规', mk('e.md', goodDef), 'definition', 'OK']);
  cases.push(['R6 定义后置', mk('f.md', '# 1 Introduction\n电池老化很重要。\n## 2 Results\nRMSE 1.2 达到最好。\n## 3 Discussion\n我们定义 SOH 为容量比值。\n'), 'definition', 'REVIEW']);
  cases.push(['R6 负控（无结果数字）', mk('g.md', '# 1 Introduction\n本文讨论电池老化。\n'), 'definition', 'SKIP']);
  cases.push(['R4 负控（空稿）', mk('h.md', ''), 'scope', 'SKIP']);

  let ok = 0;
  for (const [name, file, which, want] of cases) {
    const r = run(file, which);
    const got = r.checks[which].status;
    if (got === want) { ok++; console.log(`  ✔ ${name}: ${got}`); }
    else { console.log(`  ✘ ${name}: 期望 ${want}，实得 ${got}（${r.checks[which].code}）`); }
  }
  // 必失败臂：把合规样例的界定句删掉，必须翻 REVIEW
  const armed = mk('i1.md', goodScope);
  const stripped = mk('i2.md', '# 1 Introduction\n2018 至 2024 年的锂离子电池老化数据很重要。\n\n## 2 Methods\ntext\n');
  const armOk = run(armed, 'scope').checks.scope.status === 'OK' && run(stripped, 'scope').checks.scope.status === 'REVIEW';
  if (armOk) { ok++; console.log('  ✔ 必失败臂：删掉界定句后 R4 由 OK 翻 REVIEW'); }
  else { console.log(`  ✘ 必失败臂失灵（armed=${run(armed, 'scope').checks.scope.status} stripped=${run(stripped, 'scope').checks.scope.status}）`); }

  // 无 PASS 闸：确认状态里不存在 PASS
  const noPass = ['OK', 'REVIEW', 'SKIP'].every((s) => ['OK', 'REVIEW', 'SKIP'].includes(s));
  const observed = new Set();
  for (const [, file, which] of cases) observed.add(run(file, which).checks[which].status);
  const passSeen = [...observed].some((s) => s === 'PASS');
  if (noPass && !passSeen) { ok++; console.log('  ✔ 无 PASS 档：状态集合内不含 PASS'); }
  else { console.log('  ✘ 出现了 PASS 档'); }

  // 文档类型守卫：分析笔记 ⇒ SKIP（status 级判定，因为 checks 为空）
  const noteFile = mk('n.md', '# 某篇结论\n\n本文覆盖大部分内容。\n\n## 9. 证据索引\n| P1 §2 ‖ quote |\n');
  if (run(noteFile, 'scope').status === 'SKIP') { ok++; console.log('  ✔ 负控（分析笔记）：SKIP，不硬报'); }
  else { console.log('  ✘ 分析笔记未被守卫拦下'); }

  const total = cases.length + 3;
  console.log(`\ndefinition-first 自检：${ok}/${total} 通过`);
  process.exit(ok === total ? 0 : 1);
}

const argv = process.argv.slice(2);
if (argv.includes('--selftest')) selftest();
else {
  const i = argv.indexOf('--draft');
  const file = i >= 0 ? argv[i + 1] : null;
  if (!file || !fs.existsSync(file)) {
    console.log('用法：node bin/definition-first.cjs --draft <稿.md> [--check scope|definition|both] [--json]  |  --selftest');
    process.exit(2);
  }
  const ci = argv.indexOf('--check');
  const which = ci >= 0 ? argv[ci + 1] : 'both';
  const r = run(file, which);
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else print(r);
  process.exit(0);   // 本工具不设失败退出码：REVIEW 是"要人看"，不是"机器判定不合格"
}
