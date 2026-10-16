#!/usr/bin/env node
/**
 * _journal-contract.cjs — 期刊投稿契约检查器（无依赖 Node）
 *
 * 与 _contract-check.cjs 的分工：
 *   · _contract-check.cjs   —— 写作层：参考文献条目格式（APA）、强断言用语的证据在场性
 *   · _journal-contract.cjs —— 投稿层：目标刊官方 Guide 里写死的量（字数 / 摘要 / Highlights / 图·表数 /
 *                              附录归类 / 引用编号顺序 / 声明位置）
 *
 * 设计原则（与第 14 道门同源）：
 *   1. 只检查「契约 JSON 里写明的量」；契约本身是官方页面的原文摘录，带 verified_at 与 URL。
 *   2. 每条检查输出「实测值 / 限制值 / 判定」，不输出「看起来没问题」。
 *   3. 缺输入（无 draft / 无 contract / 找不到节）一律 FAIL 并说明原因，绝不当成通过。
 *   4. 「理想值」措辞（Ideally...）记 WARN，硬性措辞（required / maximum）记 FAIL —— 措辞强度决定门限强度。
 *
 * 用法：
 *   node _journal-contract.cjs --draft <稿.md> --contract _refs/journal-contract-joes.json
 *   node _journal-contract.cjs --draft <稿.md> --contract <契约.json> --json
 *
 *   node _journal-contract.cjs --draft <稿.md> --contract <契约.json> --package <投稿包目录>
 *   node _journal-contract.cjs --selftest [--json]
 *   node _journal-contract.cjs --draft <稿> --contract <契约> [--package <目录>] --report <报告.md>
 *
 * 契约可声明 `limits.figure_spec`（图件规格）：`allowed_formats` · `min_dpi` · `dpi_required` ·
 *   `min_width_mm` / `max_width_mm` · `min_file_kb` / `max_file_kb`。
 *   **图件按头部读真实值**（PNG pHYs / JPEG JFIF 密度 / EPS 边界盒 / SVG 属性 / GIF/BMP 像素），
 * 契约可声明 `structure.figure_table_xref: { require_contiguous, orphan_level }`（图表编号 ↔ 正文引用双向一致性）；
 * 契约可声明 `structure.package_hygiene: { forbid_patterns, allow_patterns, required_globs }`（投稿包卫生：内部产物/临时/陈旧文件 + 必备件）；
 *   读不出分辨率 ⇒ 记"核不了"，`dpi_required: true` 时判失败——**没有检查不等于合规**。
 *
 * ★ --report：把本次判定按行落成 **Markdown 检查表**（`| 检查 | 实测/依据 | 判定 | 证据 |`）。
 *   为什么要它：本项目的"投稿前检查表"此前是**手抄**读数，已经出过手抄与真实不一致的漂移；
 *   报告由机器生成 ⇒ 与运行同一份数据，不会飘。**报告里每行都带实测值与证据来源**，
 *   并显式列出未核实项 / human_only / 契约来源等级（二手口径会写"待官网重核"）。
 *
 * ★ 单文件 vs 包级（2026-10-16 修的真实假阴性）：
 *   Highlights / CRediT / AI 声明这类**包级要件**在多数刊里是**独立文件**或**系统字段**。
 *   只给 --draft 时，若它们不在稿内，本门会报「未找到」——那是**扫描范围错，不是稿件缺件**
 *   （实测：A 稿 Highlights.md/.docx/.txt 都在，门却报缺）。给 --package <目录> 后本门在该目录
 *   （深度 ≤2）内找文件与文本作为证据，并在 detail 里写明证据来自哪；未给时会**显式打警告**。
 *
 * 退出码：0 全部通过 / 1 存在 FAIL / 2 参数或文件错误（含 --selftest 失败）
 */
'use strict';
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  if (name === 'json') return true;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? def : v;
}

const draftPath = arg('draft');
const contractPath = arg('contract');
const asJson = !!arg('json', false);
const pkgDir = arg('package');
const reportPath = arg('report');

/* ── 自检（--selftest）：本门此前**没有**自检，属"门覆盖"缺口；夹具在临时目录内自建，不联网 ── */
if (process.argv.includes('--selftest')) {
  const { execFileSync } = require('child_process');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-selftest-'));
  const r = [];
  const add = (name, ok, why) => r.push({ name, ok: !!ok, why: ok ? '' : String(why) });
  const run = (args) => {
    try { return { code: 0, out: execFileSync(process.execPath, [__filename, ...args], { encoding: 'utf8' }) }; }
    catch (e) { return { code: (e.status === undefined || e.status === null) ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  const runJson = (args) => {
    const o = run(args);
    const i = o.out.indexOf('{');
    let j = null;
    try { j = i >= 0 ? JSON.parse(o.out.slice(i)) : null; } catch (e) { j = null; }
    return { code: o.code, j, out: o.out };
  };
  const draft = path.join(tmp, 'draft.md');
  fs.writeFileSync(draft, '# T\n\n## Abstract\n\nOnly a few words here.\n\n## Introduction\n\nBody text follows.\n');
  fs.writeFileSync(path.join(tmp, 'Highlights.md'), '- first point\n- second point\n');
  fs.writeFileSync(path.join(tmp, 'CRediT-statement.md'), '## CRediT\n\nConceptualization: A. B.\n');
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-selftest-todo-'));
  fs.writeFileSync(path.join(tmp2, 'manuscript.md'), '# T\n\n## Abstract\n\nOnly a few words here.\n');
  fs.writeFileSync(path.join(tmp2, 'checklist.md'), '- [ ] Declarations 其余三项（利益冲突 / 作者贡献（CRediT） / 致谢）\n- [ ] Generative AI 声明：待填\n');
  const c1 = path.join(tmp, 'c1.json');
  fs.writeFileSync(c1, JSON.stringify({ journal: 'Selftest J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u',
    limits: { abstract_max_words: 50, highlights: { required: true, min: 2, max: 3, max_chars_each: 85 } }, structure: { credit_required: true } }));
  const cNoDate = path.join(tmp, 'c-nodate.json');
  fs.writeFileSync(cNoDate, JSON.stringify({ journal: 'Selftest J', publisher: 'P', limits: { abstract_max_words: 50 } }));
  const cTight = path.join(tmp, 'c-tight.json');
  fs.writeFileSync(cTight, JSON.stringify({ journal: 'Selftest J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u', limits: { abstract_max_words: 2 } }));
  const cBroken = path.join(tmp, 'c-broken.json');
  fs.writeFileSync(cBroken, '{ this is not json');
  const noArgs = run([]);
  add('缺输入必须退出码 2（不得当了通过）', noArgs.code === 2, '实得 ' + noArgs.code);
  const noDate = run(['--draft', draft, '--contract', cNoDate]);
  add('契约缺取证日期必须退出码 2', noDate.code === 2, '实得 ' + noDate.code + ' / ' + noDate.out.slice(0, 80));
  const broken = run(['--draft', draft, '--contract', cBroken]);
  add('契约 JSON 坏了必须退出码 2 且不抛栈', broken.code === 2 && !/at Object|at Module/.test(broken.out), '实得 code=' + broken.code);
  const single = runJson(['--draft', draft, '--contract', c1, '--json']);
  add('单文件模式：包级要件在独立文件里 ⇒ 本门判 FAIL（这正是要修的假阴性本体）',
    !!(single.j && single.j.failed >= 2 && single.j.results.some(x => x.id === 'highlights_present' && !x.ok)),
    '实得 ' + JSON.stringify(single.j && { failed: single.j.failed }) + ' code=' + single.code);
  const pk = runJson(['--draft', draft, '--contract', c1, '--package', tmp, '--json']);
  const hOk = pk.j && pk.j.results.find(x => x.id === 'highlights_present');
  const cOk = pk.j && pk.j.results.find(x => x.id === 'credit_present');
  add('包级模式：Highlights 与 CRediT 在独立文件 ⇒ 两项必须判通过且写明证据来源',
    pk.code === 0 && !!hOk && hOk.ok === true && /package/.test(String(hOk.evidence) + hOk.detail) && !!cOk && cOk.ok === true,
    '实得 code=' + pk.code + ' · ' + JSON.stringify(hOk && { ok: hOk.ok, d: hOk.detail }));
  const tight = runJson(['--draft', draft, '--contract', cTight, '--json']);
  const abs = tight.j && tight.j.results.find(x => x.id === 'abstract_max_words');
  add('必失败面：摘要超限必须判 FAIL 并给出实测与上限', !!(abs && abs.ok === false && /实测 .* 上限/.test(abs.detail)), '实得 ' + JSON.stringify(abs));
  const todo = runJson(['--draft', path.join(tmp2, 'manuscript.md'), '--contract', c1, '--package', tmp2, '--json']);
  const todoC = todo.j && todo.j.results.find(x => x.id === 'credit_present');
  add('必失败面：包里只有检查表待办行提到 CRediT ⇒ 必须仍判 FAIL（关键词不等于声明，防假阳性）',
    !!(todoC && todoC.ok === false), '实得 ' + JSON.stringify(todoC && { ok: todoC.ok, d: todoC.detail }));
  const cRich = path.join(tmp, 'c-rich.json');
  fs.writeFileSync(cRich, JSON.stringify({ journal: 'Selftest J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u',
    limits: { title_max_chars: 20, heading_levels_max: 2, abstract_no_citations: true, short_title_required: true },
    structure: { figures_separate_files: true, funding_in_manuscript: false },
    checkable_ids: ['title_max_chars', 'heading_levels_max', 'abstract_no_citations', 'short_title', 'figures_not_embedded', 'funding_not_in_manuscript', 'checkable_ids_covered'] }));
  const richDraft = path.join(tmp, 'rich.md');
  fs.writeFileSync(richDraft, '# A very long title that clearly exceeds twenty characters\n\nShort title: ST\n\n## Abstract\n\nNo cites [12] here.\n\n#### Deep heading\n\nWe were funded by grant 42.\n\n![Fig 1](fig1.tif)\n');
  const rich = runJson(['--draft', richDraft, '--contract', cRich, '--json']);
  const byId = {};
  for (const x of (rich.j && rich.j.results) || []) byId[x.id] = x;
  add('新检查·必失败面：标题超限 / 摘要含引用 / 深标题 / 缺短标题行 / 内嵌图 / 正文资助 六项都必须判 FAIL',
    !!(byId.title_max_chars && !byId.title_max_chars.ok && byId.abstract_no_citations && !byId.abstract_no_citations.ok
      && byId.heading_levels_max && !byId.heading_levels_max.ok && byId.short_title && byId.short_title.ok
      && byId.figures_not_embedded && !byId.figures_not_embedded.ok && byId.funding_not_in_manuscript && !byId.funding_not_in_manuscript.ok),
    '实得 ' + JSON.stringify(Object.keys(byId).map((k) => k + '=' + (byId[k].ok ? 'ok' : 'FAIL'))));
  const cNeg = path.join(tmp, 'c-neg.json');
  fs.writeFileSync(cNeg, JSON.stringify({ journal: 'Selftest J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u',
    limits: { abstract_max_words: 50 }, structure: { funding_in_manuscript: false } }));
  const negDraft = path.join(tmp, 'neg.md');
  fs.writeFileSync(negDraft, '# T\n\n## Abstract\n\nOnly a few words here.\n\nThis research did not receive any specific grant from funding agencies.\n');
  const negR = runJson(['--draft', negDraft, '--contract', cNeg, '--json']);
  const negF = negR.j && negR.j.results.find((x) => x.id === 'funding_not_in_manuscript');
  add('新检查·分级：正文只有"无资助"陈述 ⇒ 记 WARN 而非 FAIL（避免把否定句当资助披露）',
    !!(negF && negF.level === 'WARN' && negF.ok === false), '实得 ' + JSON.stringify(negF && { level: negF.level, ok: negF.ok }));
  const cCn = path.join(tmp, 'c-cn.json');
  fs.writeFileSync(cCn, JSON.stringify({ journal: '中文样例刊', publisher: '样例', verified_at: '2026-10-16', verified_from: 'sample',
    limits: { abstract_target_chars: 300, count_mode: 'cjk', title_max_chars: 20, heading_max_chars: 15, keywords_min: 5, keywords_max: 8, abstract_required_terms: ['目的', '方法', '结果', '结论'] },
    structure: { section_aliases: { abstract: ['摘要'], keywords: ['关键词'] } } }));
  const cnOk = path.join(tmp, 'cn-ok.md');
  fs.writeFileSync(cnOk, '# 锂电池健康状态预测方法\n\n## 摘要\n\n目的：预测电池健康状态。方法：提出一种跨温度模型。结果：误差明显下降。结论：方法有效。\n\n**关键词：** 锂电池；健康状态；预测；跨温度；机器学习\n');
  const cnR = runJson(['--draft', cnOk, '--contract', cCn, '--json']);
  const cnById = {}; for (const x of (cnR.j && cnR.j.results) || []) cnById[x.id] = x;
  add('中文·正控：按「字」计数的摘要 + 中文节名别名（## 摘要 / 关键词）+ 必备要素齐 ⇒ 三项都必须通过',
    !!(cnById.abstract_chars && cnById.abstract_chars.ok && cnById.abstract_required_terms && cnById.abstract_required_terms.ok && cnById.keywords_count && cnById.keywords_count.ok),
    '实得 ' + JSON.stringify(Object.keys(cnById).map((k) => k + '=' + (cnById[k].ok ? 'ok' : 'FAIL') + (cnById[k].ok ? '' : '(' + cnById[k].detail.slice(0, 40) + ')'))));
  /* 对照证明两套口径确实不同：同一份中文稿，words 模式只数出个位数"词"，cjk 模式数出几十"字" */
  const cWords = path.join(tmp, 'c-words.json');
  fs.writeFileSync(cWords, JSON.stringify({ journal: '中文样例刊', publisher: '样例', verified_at: '2026-10-16', verified_from: 'sample',
    limits: { abstract_max_words: 50 }, structure: { section_aliases: { abstract: ['摘要'] } } }));
  const wR = runJson(['--draft', cnOk, '--contract', cWords, '--json']);
  const wDet = (wR.j && (wR.j.results.find((x) => x.id === 'abstract_max_words') || {}).detail) || '';
  const cnChars = Number((/(\d+)\s*字/.exec(cnById.abstract_chars ? cnById.abstract_chars.detail : '') || [])[1] || 0);
  const wWords = Number((/(\d+)\s*词/.exec(wDet) || [])[1] || 999);
  add('中文·计数口径对照：同一份中文摘要，words 模式数出个位数"词"、cjk 模式数出几十"字"（证明两套口径都在按预期工作）',
    !!(cnChars >= 20 && wWords <= 5),
    '实得 cjk=' + cnChars + ' 字 · words=' + wWords + ' 词（words 明细：' + wDet.slice(0, 60) + '）');
  const cnBad = path.join(tmp, 'cn-bad.md');
  fs.writeFileSync(cnBad, '# 这是一个明显超过二十个汉字的超长中文题名用于触发题名上限检查\n\n## 摘要\n\n' + '本研究围绕电池健康状态预测展开讨论并提出方法并给出结果。'.repeat(14) + '\n\n**关键词：** 电池；预测\n\n## 这是一个超过十五个汉字的各级标题用来触发标题字数上限\n\n正文。\n');
  const cnR2 = runJson(['--draft', cnBad, '--contract', cCn, '--json']);
  const b2 = {}; for (const x of (cnR2.j && cnR2.j.results) || []) b2[x.id] = x;
  add('中文·必失败面：题名超 20 字 / 摘要超硬上限 / 缺要素 / 关键词不足 / 标题超 15 字 —— 五条都必须 FAIL',
    !!(b2.title_max_chars && !b2.title_max_chars.ok && b2.abstract_chars && !b2.abstract_chars.ok && b2.abstract_required_terms && !b2.abstract_required_terms.ok
      && b2.keywords_count && !b2.keywords_count.ok && b2.heading_max_chars && !b2.heading_max_chars.ok),
    '实得 ' + JSON.stringify(Object.keys(b2).map((k) => k + '=' + (b2[k].ok ? 'ok' : 'FAIL'))));
  const cTerms = path.join(tmp, 'c-terms.json');
  fs.writeFileSync(cTerms, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 50 }, structure: { required_terms_present: ['基金项目', '作者简介', '通信作者'] } }));
  const tOk = path.join(tmp, 't-ok.md');
  fs.writeFileSync(tOk, '# T\n\n## Abstract\n\nA few words.\n\n基金项目：国家自然科学基金（12345678）\n作者简介：张三（1990—），男，硕士。\n通信作者：李四，教授。\n');
  const tR = runJson(['--draft', tOk, '--contract', cTerms, '--json']);
  const t1 = tR.j && tR.j.results.find((x) => x.id === 'required_terms_present');
  add('新检查·正控：必备著录项齐 ⇒ 通过', !!(t1 && t1.ok === true), '实得 ' + JSON.stringify(t1 && { ok: t1.ok, d: t1.detail }));
  const tR2 = runJson(['--draft', draft, '--contract', cTerms, '--json']);
  const t2 = tR2.j && tR2.j.results.find((x) => x.id === 'required_terms_present');
  add('新检查·必失败：缺著录项必须 FAIL 并列出缺哪些', !!(t2 && t2.ok === false && /缺必备著录项/.test(t2.detail)), '实得 ' + JSON.stringify(t2 && { ok: t2.ok, d: t2.detail }));
  const kwDraft = path.join(tmp, 'kw.md');
  fs.writeFileSync(kwDraft, '# T\n\n## Abstract\n\nA few words.\n\n**Keywords:** battery; SoH\n');
  const cKw = path.join(tmp, 'c-kw.json');
  fs.writeFileSync(cKw, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 50 }, structure: { keywords_required: true } }));
  const kwR = runJson(['--draft', kwDraft, '--contract', cKw, '--json']);
  const kwIt = kwR.j && kwR.j.results.find((x) => x.id === 'keywords_present');
  add('回归锁：没有 section_aliases 的（英文）契约必须仍能认 **Keywords**（默认值是正则片段，不得被转义）',
    !!(kwIt && kwIt.ok === true), '实得 ' + JSON.stringify(kwIt && { ok: kwIt.ok, d: kwIt.detail }));
  const cCnLong = path.join(tmp, 'c-cn-long.json');
  fs.writeFileSync(cCnLong, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { count_mode: 'cjk', manuscript_max_chars: 200, abstract_max_words: 50 } }));
  const cCnLongW = path.join(tmp, 'c-cn-long-words.json');
  fs.writeFileSync(cCnLongW, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { manuscript_max_words: 200, abstract_max_words: 50 } }));
  const longCn = path.join(tmp, 'long-cn.md');
  fs.writeFileSync(longCn, '# 题名\n\n## 摘要\n\nA few words.\n\n## 1 引言\n\n' + '这是用于测试正文上限的中文段落内容。'.repeat(30) + '\n');
  const lrCjk = runJson(['--draft', longCn, '--contract', cCnLong, '--json']);
  const lrWords = runJson(['--draft', longCn, '--contract', cCnLongW, '--json']);
  const iCjk = lrCjk.j && lrCjk.j.results.find((x) => x.id === 'manuscript_max_words');
  const iWords = lrWords.j && lrWords.j.results.find((x) => x.id === 'manuscript_max_words');
  add('正文上限·必失败面（中文）：cjk 口径下超 200 字必须 FAIL，而同一稿在 words 口径下会被放过（证明此前"等于没检"）',
    !!(iCjk && iCjk.ok === false && iWords && iWords.ok === true),
    '实得 cjk=' + JSON.stringify(iCjk && { ok: iCjk.ok, d: iCjk.detail.slice(0, 50) }) + ' · words=' + JSON.stringify(iWords && { ok: iWords.ok, d: iWords.detail.slice(0, 50) }));
  const cSec = path.join(tmp, 'c-sec.json');
  fs.writeFileSync(cSec, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 50 },
    structure: { required_sections: [{ name: 'Data Availability', aliases: ['Data Availability', '数据可用性'] }, { name: 'CRediT', aliases: ['CRediT', 'Author contributions'] }] } }));
  const secOk = path.join(tmp, 'sec-ok.md');
  fs.writeFileSync(secOk, '# T\n\n## Abstract\n\nA few words.\n\n## Data Availability\n\nData are on Zenodo.\n\n## CRediT\n\nConceptualization: A.\n');
  const sR = runJson(['--draft', secOk, '--contract', cSec, '--json']);
  const s1 = sR.j && sR.j.results.find((x) => x.id === 'required_sections');
  add('新检查·正控：契约要求的节都在（英文标题行）⇒ 通过', !!(s1 && s1.ok === true), '实得 ' + JSON.stringify(s1 && { ok: s1.ok, d: s1.detail }));
  const secCn = path.join(tmp, 'sec-cn.md');
  fs.writeFileSync(secCn, '# T\n\n## 摘要\n\nA few words.\n\n## 数据可用性\n\n数据见仓库。\n\n## 作者贡献\n\n概念化：张三。\n');
  const sR2 = runJson(['--draft', secCn, '--contract', cSec, '--json']);
  const s2 = sR2.j && sR2.j.results.find((x) => x.id === 'required_sections');
  add('新检查·必失败面：缺 1 个节必须 FAIL 并列出缺哪个（中文稿只命中别名之一）', !!(s2 && s2.ok === false && /缺 1\/2/.test(s2.detail)), '实得 ' + JSON.stringify(s2 && { ok: s2.ok, d: s2.detail }));
  const secTodo = path.join(tmp, 'sec-todo.md');
  fs.writeFileSync(secTodo, '# T\n\n## Abstract\n\nA few words.\n\n- [ ] Data Availability：待填\n- [ ] CRediT：待填\n');
  const sR3 = runJson(['--draft', secTodo, '--contract', cSec, '--json']);
  const s3 = sR3.j && sR3.j.results.find((x) => x.id === 'required_sections');
  add('新检查·必失败面：只有待办行提到这些节名 ⇒ 必须仍判 FAIL（关键词≠节在场）', !!(s3 && s3.ok === false), '实得 ' + JSON.stringify(s3 && { ok: s3.ok, d: s3.detail }));
  const cRe = path.join(tmp, 'c-recheck.json');
  fs.writeFileSync(cRe, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u', needs_official_recheck: true,
    provenance_level: 'archived-secondary', limits: { abstract_max_words: 50 } }));
  const rR = runJson(['--draft', draft, '--contract', cRe, '--json']);
  const r1 = rR.j && rR.j.results.find((x) => x.id === 'contract_recheck_required');
  add('新检查·必失败面（WARN 级）：契约标了 needs_official_recheck ⇒ 必须显形提醒，不得静默通过', !!(r1 && r1.ok === false && /尚未经官网重核/.test(r1.detail)), '实得 ' + JSON.stringify(r1 && { level: r1.level, ok: r1.ok }));
  const pkgDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-selftest-pkg-'));
  fs.writeFileSync(path.join(pkgDir2, 'Data-Availability-statement.md'), '## 数据可用性\n\n数据见 Zenodo.\n');
  const cSecPkg = path.join(tmp, 'c-sec-pkg.json');
  fs.writeFileSync(cSecPkg, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 50 }, structure: { required_sections: [{ name: 'Data Availability', aliases: ['Data Availability', '数据可用性'] }] } }));
  const secPkgDraft = path.join(tmp, 'sec-pkg.md');
  fs.writeFileSync(secPkgDraft, '# T\n\n## Abstract\n\nA few words.\n');
  const spR = runJson(['--draft', secPkgDraft, '--contract', cSecPkg, '--package', pkgDir2, '--json']);
  const sp1 = spR.j && spR.j.results.find((x) => x.id === 'required_sections');
  add('新检查·文件名证据支路（此支路此前无夹具，导致真跑崩而自检全绿）：--package 下靠**独立文件名**命中即算在场',
    !!(sp1 && sp1.ok === true && /package:/.test(sp1.detail)), '实得 ' + JSON.stringify(sp1 && { ok: sp1.ok, d: sp1.detail }));
  const cLine = path.join(tmp, 'c-line.json');
  fs.writeFileSync(cLine, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 50 }, structure: { required_sections: [{ name: '中图分类号', evidence: 'line' }] } }));
  const lineOk = path.join(tmp, 'line-ok.md');
  fs.writeFileSync(lineOk, '# 题名\n\n## 摘要\n\nA few words.\n\n中图分类号：TM912　文献标志码：A\n');
  const lR = runJson(['--draft', lineOk, '--contract', cLine, '--json']);
  const l1 = lR.j && lR.j.results.find((x) => x.id === 'required_sections');
  add('新检查·证据强度：evidence=line 时普通行（中文刊"中图分类号：…"）必须算在场', !!(l1 && l1.ok === true), '实得 ' + JSON.stringify(l1 && { ok: l1.ok, d: l1.detail }));
  const lineTodo = path.join(tmp, 'line-todo.md');
  fs.writeFileSync(lineTodo, '# 题名\n\n## 摘要\n\nA few words.\n\n- [ ] 中图分类号：待填\n');
  const lR2 = runJson(['--draft', lineTodo, '--contract', cLine, '--json']);
  const l2 = lR2.j && lR2.j.results.find((x) => x.id === 'required_sections');
  add('新检查·必失败面：evidence=line 也不许待办行冒充（"- [ ] 中图分类号：待填" ⇒ 仍判缺）', !!(l2 && l2.ok === false), '实得 ' + JSON.stringify(l2 && { ok: l2.ok, d: l2.detail }));
  const repPath = path.join(tmp, 'report.md');
  const repDraft = path.join(tmp, 'rep.md');
  fs.writeFileSync(repDraft, '# T\n\n## Abstract\n\nOnly a few words here.\n');
  const rp = runJson(['--draft', repDraft, '--contract', c1, '--package', tmp, '--report', repPath, '--json']);
  let repTxt = '';
  try { repTxt = fs.readFileSync(repPath, 'utf8'); } catch (e) { repTxt = ''; }
  add('新能力·--report：必须生成 Markdown 检查表（表头 + 每行带实测/判定/证据 + 结论行）',
    !!(repTxt && /^# 契约检查报告/m.test(repTxt) && /\| 检查 \| 实测/.test(repTxt) && /结论：通过/.test(repTxt) && /highlights_present/.test(repTxt)),
    '实得长度 ' + repTxt.length + ' · 头 60 字：' + repTxt.slice(0, 60));
  /* ★ v3.2.42：**扁平写法的图件规格**（PLOS 契约的写法：figure_format / figure_dpi / figure_width_px…）
     —— 这批键此前**整块被跳过**（门只读 limits.figure_spec）⇒ 由「声明 vs 执行」锁抓出，本轮关掉。
     夹具自建 PNG（不依赖其它夹具作用域里的读图器辅助）。 */
  {
    const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'flat-fig-'));
    const png = (w, h, ppu) => {
      const b = Buffer.alloc(45);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8); b.write('IHDR', 12, 'latin1');
      b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
      b[24] = 8; b[25] = 2; b[26] = 0; b[27] = 0; b[28] = 0;
      b.write('pHYs', 33, 'latin1'); b.writeUInt32BE(ppu, 37); b.writeUInt32BE(ppu, 41);
      b[29] = 0; b[30] = 0; b[31] = 0; b[32] = 0;
      return b;
    };
    const d = path.join(tmpF, 'd.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody cites [1].\n\n**Figure 1.** three words only\n');
    const pkgA = path.join(tmpF, 'pkA'); fs.mkdirSync(pkgA);
    fs.writeFileSync(path.join(pkgA, 'manuscript.md'), '# T\n\n## Abstract\n\nBody.\n');
    fs.writeFileSync(path.join(pkgA, 'fig1.png'), png(1200, 900, 11811));   // 300 dpi png
    const cFmt = path.join(tmpF, 'fmt.json');
    fs.writeFileSync(cFmt, JSON.stringify({ journal: 'J', article_type: 'research_article', verified_at: '2026-01-01', verified_from: 'selftest', limits: { abstract_max_words: 300, figure_format: ['TIFF', 'EPS'] } }));
    const rFmt = runJson(['--draft', d, '--package', pkgA, '--contract', cFmt, '--json']);
    const rowFmt = rFmt.j && rFmt.j.results.find((x) => x.id === 'figure_spec');
    add('v3.2.42·扁平图件规格：figure_format=[TIFF,EPS] + 包内 png ⇒ FAIL（此前整块被跳过 ⇒ 等于没人管）',
      !!(rowFmt && rowFmt.ok === false && /png/.test(String(rowFmt.detail || ''))));
    /* ★ 正控的写法要注意：门按**魔数**判格式（内容优先于扩展名）—— 首版我写了个名为 .tif、
       内容却是 PNG 字节的文件，门判 png ⇒ 合理地 FAIL（**是夹具错了，不是功能错**）。
       这里改用「契约允许 PNG + 真 PNG 文件」来做正控。 */
    const cFmtOk = path.join(tmpF, 'fmt-ok.json');
    fs.writeFileSync(cFmtOk, JSON.stringify({ journal: 'J', article_type: 'research_article', verified_at: '2026-01-01', verified_from: 'selftest', limits: { abstract_max_words: 300, figure_format: ['PNG'] } }));
    const rOk = runJson(['--draft', d, '--package', pkgA, '--contract', cFmtOk, '--json']);
    const rowOk = rOk.j && rOk.j.results.find((x) => x.id === 'figure_spec');
    add('v3.2.42·扁平图件规格·正控：契约允许 PNG + 真 PNG ⇒ 通过（防"一律红"）', !!(rowOk && rowOk.ok === true));
    const cDpi = path.join(tmpF, 'dpi.json');
    fs.writeFileSync(cDpi, JSON.stringify({ journal: 'J', article_type: 'research_article', verified_at: '2026-01-01', verified_from: 'selftest', limits: { abstract_max_words: 300, figure_format: ['PNG'], figure_dpi: { min: 300, max: 600 }, figure_width_px: { min: 100, max: 800 } } }));
    const rDpi = runJson(['--draft', d, '--package', pkgA, '--contract', cDpi, '--json']);
    const rowDpi = rDpi.j && rDpi.j.results.find((x) => x.id === 'figure_spec');
    add('v3.2.42·dpi 上限与 px 上下限：1200 px 宽 + 300 dpi ⇒ 宽度超上限被判（此前只支持 min_dpi 与 mm）',
      !!(rowDpi && rowDpi.ok === false && /最大 800 px/.test(String(rowDpi.detail || ''))));
    const cSi = path.join(tmpF, 'si.json');
    fs.writeFileSync(cSi, JSON.stringify({ journal: 'J', article_type: 'research_article', verified_at: '2026-01-01', verified_from: 'selftest', limits: { abstract_max_words: 300, si_file_max_mb: 0.000001, figure_caption_max_words: 2 } }));
    fs.writeFileSync(path.join(pkgA, 'Supplementary-Table-S1.md'), 'x'.repeat(200));
    const rSi = runJson(['--draft', d, '--package', pkgA, '--contract', cSi, '--json']);
    const rowSi = rSi.j && rSi.j.results.find((x) => x.id === 'si_file_max_mb');
    const rowCap = rSi.j && rSi.j.results.find((x) => x.id === 'figure_caption_max_words');
    add('v3.2.42·补充材料体积上限：超限 ⇒ FAIL（新的可执行判据）', !!(rowSi && rowSi.ok === false));
    add('v3.2.42·图注词数上限：图注 3 词 > 上限 2 ⇒ FAIL（新的可执行判据）', !!(rowCap && rowCap.ok === false));
  }
  /* ★ v3.2.38：分体裁上限 + Highlights 独立文件 —— 这两条此前**声明了却没人执行**。 */
  {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-type-'));
    const dA = path.join(tmpA, 'd.md');
    fs.writeFileSync(dA, '# T\n\n## Abstract\n\n' + 'word '.repeat(80) + '\n');
    const cRevTight = path.join(tmpA, 'rev-tight.json');
    fs.writeFileSync(cRevTight, JSON.stringify({ journal: 'J', article_type: 'review', verified_at: '2026-01-01', verified_from: 'selftest', limits: { review_max_words: 20, manuscript_max_words: 6000 } }));
    const rr = runJson(['--draft', dA, '--contract', cRevTight, '--json']);
    const rowW = rr.j && rr.j.results.find((x) => x.id === 'manuscript_max_words');
    const rowSrc = rr.j && rr.j.results.find((x) => x.id === 'word_cap_source');
    add('v3.2.38·分体裁上限：article_type=review ⇒ 用 review_max_words 判（首版只读通用上限 ⇒ 综述上限没人管），且**上限来源要写在明细里**',
      !!(rowW && rowW.ok === false && rowSrc && /review_max_words/.test(String(rowSrc.detail || ''))));
    const cRevLoose = path.join(tmpA, 'rev-loose.json');
    fs.writeFileSync(cRevLoose, JSON.stringify({ journal: 'J', article_type: 'review', verified_at: '2026-01-01', verified_from: 'selftest', limits: { review_max_words: 5000, manuscript_max_words: 6000 } }));
    const r2 = runJson(['--draft', dA, '--contract', cRevLoose, '--json']);
    const rowW2 = r2.j && r2.j.results.find((x) => x.id === 'manuscript_max_words');
    add('v3.2.38·分体裁上限·正控：上限放宽后同一稿通过（防"一律红"）', !!(rowW2 && rowW2.ok === true));
    const cNoType = path.join(tmpA, 'notype.json');
    fs.writeFileSync(cNoType, JSON.stringify({ journal: 'J', verified_at: '2026-01-01', verified_from: 'selftest', limits: { review_max_words: 20, abstract_max_words: 200 } }));
    const r3 = runJson(['--draft', dA, '--contract', cNoType, '--json']);
    const rowU = r3.j && r3.j.results.find((x) => x.id === 'article_type_cap_unapplied');
    add('v3.2.38·声明了分体裁上限但缺 article_type ⇒ WARN 显形（不得静默忽略声明）', !!(rowU && rowU.ok === false));
    const cTyped = path.join(tmpA, 'typed.json');
    fs.writeFileSync(cTyped, JSON.stringify({ journal: 'J', article_type: 'full_length_research', verified_at: '2026-01-01', verified_from: 'selftest', limits: { review_max_words: 20, manuscript_max_words: 6000 } }));
    const r4 = runJson(['--draft', dA, '--contract', cTyped, '--json']);
    add('v3.2.38·分体裁上限·反控：article_type 明确且无专属上限 ⇒ **不得**报 unapplied（多体裁契约声明别的体裁是正常的）',
      !(r4.j && r4.j.results.some((x) => x.id === 'article_type_cap_unapplied')));
    const pkgNoHl = path.join(tmpA, 'pkg-nohl'); fs.mkdirSync(pkgNoHl);
    fs.writeFileSync(path.join(pkgNoHl, 'manuscript.md'), '# T\n\n## Abstract\n\nBody.\n');
    const cHl = path.join(tmpA, 'hl.json');
    fs.writeFileSync(cHl, JSON.stringify({ journal: 'J', article_type: 'review', verified_at: '2026-01-01', verified_from: 'selftest', limits: { abstract_max_words: 300, highlights: { separate_editable_file: true, filename_must_contain: 'highlights' } } }));
    const r5 = runJson(['--draft', path.join(pkgNoHl, 'manuscript.md'), '--package', pkgNoHl, '--contract', cHl, '--json']);
    const rowH = r5.j && r5.j.results.find((x) => x.id === 'highlights_separate_file');
    add('v3.2.38·Highlights 独立文件：包内没有含 highlights 的文件 ⇒ FAIL（契约声明了却没人管的两条之一）', !!(rowH && rowH.ok === false));
    fs.writeFileSync(path.join(pkgNoHl, 'Highlights-JoES.docx'), 'x');
    const r6 = runJson(['--draft', path.join(pkgNoHl, 'manuscript.md'), '--package', pkgNoHl, '--contract', cHl, '--json']);
    const rowH2 = r6.j && r6.j.results.find((x) => x.id === 'highlights_separate_file');
    add('v3.2.38·Highlights 独立文件·正控：包内有 Highlights-JoES.docx ⇒ 通过', !!(rowH2 && rowH2.ok === true));
  }
  add('新能力·--report：二手来源契约必须在报告里写"待官网重核"（来源等级随报告走）',
    !(function () {
      const cRe2 = path.join(tmp, 'c-re2.json');
      fs.writeFileSync(cRe2, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u', needs_official_recheck: true, provenance_level: 'archived-secondary', limits: { abstract_max_words: 50 } }));
      const rp2 = path.join(tmp, 'report2.md');
      runJson(['--draft', repDraft, '--contract', cRe2, '--report', rp2, '--json']);
      let x = ''; try { x = fs.readFileSync(rp2, 'utf8'); } catch (e) { x = ''; }
      return /待官网重核|needs_official_recheck/.test(x);
    })() ? true : '报告里没有写待重核', '—');
  const cOrder = path.join(tmp, 'c-order.json');
  fs.writeFileSync(cOrder, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 50 }, checkable_ids: ['abstract_max_words', 'package_dir', 'checkable_ids_covered'] }));
  const oR = runJson(['--draft', draft, '--contract', cOrder, '--package', tmp, '--json']);
  const o1 = oR.j && oR.j.results.find((x) => x.id === 'checkable_ids_covered');
  add('顺序锁：带 --package 时，对账必须看得见 package_dir（此前对账跑在它之前 ⇒ 假报未执行）',
    !!(o1 && o1.ok === true), '实得 ' + JSON.stringify(o1 && { ok: o1.ok, d: o1.detail }));
  const cWriteOrder = path.join(tmp, 'c-writing-order.json');
  fs.writeFileSync(cWriteOrder, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 80 },
    structure: { writing_order: ['题目', '作者', '摘要', '关键词', '中图分类号', '文献标志码', '参考文献'] } }));
  const woOk = path.join(tmp, 'wo-ok.md');
  fs.writeFileSync(woOk, '# 题目：一种方法\n\n作者：张三\n\n**摘要：** 本文……\n\n**关键词：** 一；二；三\n\n中图分类号：TM912\n\n文献标志码：A\n\n## 参考文献\n\n[1] 张三. 题名[J]. 刊, 2024.\n');
  const woR1 = runJson(['--draft', woOk, '--contract', cWriteOrder, '--json']);
  const w1 = (woR1.j || { results: [] }).results.find((x) => x.id === 'writing_order');
  const woCtx = (R) => `exit=${R.code} ｜ 输出头=${JSON.stringify(String(R.out).slice(0, 80))}`;
  add('新检查·书写顺序正控：前置项次序正确 ⇒ 通过', !!(w1 && w1.ok === true), '实得 ' + JSON.stringify(w1 && { ok: w1.ok, d: w1.detail && w1.detail.slice(0, 90) }) + ' ｜ ' + woCtx(woR1));
  const woBad = path.join(tmp, 'wo-bad.md');
  fs.writeFileSync(woBad, '# 题目：一种方法\n\n作者：张三\n\n**摘要：** 本文……\n\n**关键词：** 一；二；三\n\n## 参考文献\n\n[1] 张三. 题名[J]. 刊, 2024.\n\n中图分类号：TM912\n\n文献标志码：A\n');
  const w2 = (runJson(['--draft', woBad, '--contract', cWriteOrder, '--json']).j || { results: [] }).results.find((x) => x.id === 'writing_order');
  add('新检查·必失败面：中图分类号/文献标志码跑到参考文献之后 ⇒ 必须报倒置并给行号',
    !!(w2 && w2.ok === false && /倒置/.test(w2.detail) && /L\d+/.test(w2.detail)), '实得 ' + JSON.stringify(w2 && { ok: w2.ok, d: w2.detail && w2.detail.slice(0, 120) }));
  const woFew = path.join(tmp, 'wo-few.md');
  fs.writeFileSync(woFew, '# 题目：一种方法\n\n**摘要：** 本文……\n');
  const w3 = (runJson(['--draft', woFew, '--contract', cWriteOrder, '--json']).j || { results: [] }).results.find((x) => x.id === 'writing_order');
  add('新检查·必失败面：标记太少（核不了顺序）⇒ 不得静默通过',
    !!(w3 && w3.ok === false && /标记太少|只找到/.test(w3.detail)), '实得 ' + JSON.stringify(w3 && { ok: w3.ok, d: w3.detail && w3.detail.slice(0, 100) }));
  const woFooter = path.join(tmp, 'wo-footer.md');
  fs.writeFileSync(woFooter, '# 题目：一种方法\n\n作者：张三\n\n**摘要：** 本文……\n\n**关键词：** 一；二；三\n\n中图分类号：TM912　文献标志码：A\n\n基金项目：国家级（123）\n作者简介：张三（1990—），男，硕士。\n通信作者：李四，教授。\n\n## 参考文献\n\n[1] 张三. 题名[J]. 刊, 2024.\n');
  const w4R = runJson(['--draft', woFooter, '--contract', cWriteOrder, '--json']);
  const w4 = w4R.j && w4R.j.results.find((x) => x.id === 'writing_order');
  add('新检查·假阳性锁：页脚「作者简介：…」不得被当成前置项「作者」（标记后须冒号或行尾）',
    !!(w4 && w4.ok === true), '实得 ' + JSON.stringify(w4 && { ok: w4.ok, d: w4.detail && w4.detail.slice(0, 120) }) + ' ｜ exit=' + w4R.code);
  const fsSpec = path.join(tmp, 'figdir');
  fs.mkdirSync(fsSpec, { recursive: true });
  const pngHeader = (w, h, ppu) => {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ihdr = Buffer.alloc(25);
    ihdr.writeUInt32BE(13, 0); ihdr.write('IHDR', 4, 'latin1');
    ihdr.writeUInt32BE(w, 8); ihdr.writeUInt32BE(h, 12); ihdr[16] = 8; ihdr[17] = 6; ihdr[20] = 0; ihdr[21] = 0; ihdr[22] = 0;
    const phys = ppu ? (() => { const b = Buffer.alloc(21); b.writeUInt32BE(9, 0); b.write('pHYs', 4, 'latin1'); b.writeUInt32BE(ppu, 8); b.writeUInt32BE(ppu, 12); b[16] = 1; return b; })() : Buffer.alloc(0);
    const iend = Buffer.alloc(12); iend.write('IEND', 4, 'latin1');
    return Buffer.concat([sig, ihdr, phys, iend]);
  };
  const jpegHeader = (w, h, dpi) => {
    const sof = Buffer.alloc(2 + 2 + 1 + 1 + 2 + 2);
    sof[0] = 0xFF; sof[1] = 0xC0; sof.writeUInt16BE(sof.length - 2, 2); sof[4] = 8; sof.writeUInt16BE(h, 5); sof.writeUInt16BE(w, 7);
    const app0 = Buffer.alloc(18); app0[0] = 0xFF; app0[1] = 0xE0; app0.writeUInt16BE(16, 2); app0.write('JFIF\u0000', 4, 'latin1');
    app0[11] = 1; app0.writeUInt16BE(dpi, 12); app0.writeUInt16BE(dpi, 14);
    return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, sof]);
  };
  fs.writeFileSync(path.join(fsSpec, 'ok-300dpi.png'), pngHeader(1200, 900, 11811));
  fs.writeFileSync(path.join(fsSpec, 'low-72dpi.png'), pngHeader(1200, 900, 2835));
  fs.writeFileSync(path.join(fsSpec, 'no-dpi.png'), pngHeader(1200, 900, 0));
  fs.writeFileSync(path.join(fsSpec, 'photo-300dpi.jpg'), jpegHeader(1000, 800, 300));
  fs.writeFileSync(path.join(fsSpec, 'bmp-disallowed.bmp'), Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(30)]));
  const cFig = path.join(tmp, 'c-fig.json');
  fs.writeFileSync(cFig, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 80, figure_spec: { allowed_formats: ['png', 'jpg', 'eps'], min_dpi: 300, dpi_required: true, min_width_mm: 80, max_width_mm: 190 } } }));
  const fDraft = path.join(tmp, 'fig-draft.md');
  fs.writeFileSync(fDraft, '# T\n\n## Abstract\n\nA few words.\n');
  const fPkg = fs.mkdtempSync(path.join(os.tmpdir(), 'jc-fig-'));
  fs.copyFileSync(path.join(fsSpec, 'ok-300dpi.png'), path.join(fPkg, 'ok-300dpi.png'));
  const fR1 = runJson(['--draft', fDraft, '--contract', cFig, '--package', fPkg, '--json']);
  const f1 = fR1.j && fR1.j.results.find((x) => x.id === 'figure_spec');
  add('新检查·图件规格正控：1200px @300dpi（宽≈101.6mm）⇒ 通过（按头部读真实分辨率）', !!(f1 && f1.ok === true), '实得 ' + JSON.stringify(f1 && { ok: f1.ok, l: f1.level, d: f1.detail && f1.detail.slice(0, 120) }));
  fs.copyFileSync(path.join(fsSpec, 'low-72dpi.png'), path.join(fPkg, 'low-72dpi.png'));
  const fR2 = runJson(['--draft', fDraft, '--contract', cFig, '--package', fPkg, '--json']);
  const f2 = fR2.j && fR2.j.results.find((x) => x.id === 'figure_spec');
  add('新检查·必失败面：72 dpi 必须被抓（低于 300）且给文件名与实测值', !!(f2 && f2.ok === false && /72dpi|72 dpi/.test(f2.detail) && /low-72dpi\.png/.test(f2.detail)), '实得 ' + JSON.stringify(f2 && { ok: f2.ok, d: f2.detail && f2.detail.slice(0, 150) }));
  fs.copyFileSync(path.join(fsSpec, 'no-dpi.png'), path.join(fPkg, 'no-dpi.png'));
  const fR3 = runJson(['--draft', fDraft, '--contract', cFig, '--package', fPkg, '--json']);
  const f3 = fR3.j && fR3.j.results.find((x) => x.id === 'figure_spec');
  add('新检查·必失败面：dpi_required 时"未标注分辨率"必须判失败（核不了 ≠ 通过）', !!(f3 && f3.ok === false && /未标注物理分辨率/.test(f3.detail)), '实得 ' + JSON.stringify(f3 && { ok: f3.ok, l: f3.level, d: f3.detail && f3.detail.slice(0, 150) }));
  fs.copyFileSync(path.join(fsSpec, 'bmp-disallowed.bmp'), path.join(fPkg, 'bmp-disallowed.bmp'));
  const fR4 = runJson(['--draft', fDraft, '--contract', cFig, '--package', fPkg, '--json']);
  const f4 = fR4.j && fR4.j.results.find((x) => x.id === 'figure_spec');
  add('新检查·必失败面：不允许的格式（bmp）必须被抓', !!(f4 && f4.ok === false && /不在允许列表/.test(f4.detail)), '实得 ' + JSON.stringify(f4 && { ok: f4.ok, d: f4.detail && f4.detail.slice(0, 150) }));
  const cDecl = path.join(tmp, 'c-decl.json');
  fs.writeFileSync(cDecl, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 80 },
    structure: {
      required_sections: [
        { name: 'CRediT', aliases: ['CRediT', 'Author contributions'] },
        { name: 'Declaration of Competing Interest', aliases: ['competing interest', 'conflict of interest'],
          patterns: ['declare[sd]? (?:that )?(?:the authors?|he|she|they) (?:has|have) no', 'no known competing financial interests'] },
        { name: 'Funding', aliases: ['Funding'], patterns: ['did not receive any specific (?:grant|funding)', 'received no (?:external )?funding'] },
      ] } }));
  const declLabel = path.join(tmp, 'decl-label.md');
  fs.writeFileSync(declLabel, '# T\n\n## Abstract\n\nA few words.\n\n**Data availability.** Data are public.\n\n**Declaration of competing interest.** The author declares that he has no known competing financial interests.\n\n**CRediT authorship contribution statement.** **A.B.:** Conceptualization, Writing – original draft.\n\nThis research did not receive any specific grant from funding agencies in the public, commercial, or not-for-profit sectors.\n');
  const dR = runJson(['--draft', declLabel, '--contract', cDecl, '--json']);
  const d1 = dR.j && dR.j.results.find((x) => x.id === 'required_sections');
  add('★更正锁：**行首加粗标签 + 标准声明句**必须被认作声明在场（此前只认标题行 ⇒ 真实稿件被判"缺声明"）',
    !!(d1 && d1.ok === true), '实得 ' + JSON.stringify(d1 && { ok: d1.ok, d: d1.detail && d1.detail.slice(0, 170) }));
  const declTodo = path.join(tmp, 'decl-todo.md');
  fs.writeFileSync(declTodo, '# T\n\n## Abstract\n\nA few words.\n\n- [ ] **CRediT authorship contribution statement.** 待填\n- [ ] Declaration of competing interest: 待填\n- [ ] Funding: 待填\n');
  const dR2 = runJson(['--draft', declTodo, '--contract', cDecl, '--json']);
  const d2 = dR2.j && dR2.j.results.find((x) => x.id === 'required_sections');
  add('必失败面：待办行即使写了同名字样也必须仍判缺（放宽证据强度不得放过待办）',
    !!(d2 && d2.ok === false), '实得 ' + JSON.stringify(d2 && { ok: d2.ok, d: d2.detail && d2.detail.slice(0, 140) }));
  const cXref = path.join(tmp, 'c-xref.json');
  fs.writeFileSync(cXref, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 80 }, structure: { figure_table_xref: { require_contiguous: true, orphan_level: 'WARN' } } }));
  const xOk = path.join(tmp, 'xref-ok.md');
  fs.writeFileSync(xOk, '# T\n\n## Abstract\n\nA few words.\n\nAs shown in Figure 1 and Table 1, the trend holds.\nFigure 2 gives the second view.\n\n**Figure 1.** First figure caption.\n\n**Figure 2.** Second figure caption.\n\n**Table 1.** Only table caption.\n');
  const xR1 = runJson(['--draft', xOk, '--contract', cXref, '--json']);
  const x1 = xR1.j && xR1.j.results.find((r) => r.id === 'figure_table_xref');
  add('新检查·图表交叉引用正控：声明与引用一致 ⇒ 通过', !!(x1 && x1.ok === true && x1.level === 'PASS'),
    '实得 ' + JSON.stringify(x1 && { ok: x1.ok, l: x1.level, d: x1.detail && x1.detail.slice(0, 150) }));
  const xDang = path.join(tmp, 'xref-dangling.md');
  fs.writeFileSync(xDang, '# T\n\n## Abstract\n\nA few words.\n\nSee Table 3 for details.\n\n**Figure 1.** Cap.\n\n**Table 1.** Cap.\n');
  const xR2 = runJson(['--draft', xDang, '--contract', cXref, '--json']);
  const x2 = xR2.j && xR2.j.results.find((r) => r.id === 'figure_table_xref');
  add('新检查·必失败面：正文引用了不存在的表（Table 3）必须 FAIL 并点名', !!(x2 && x2.ok === false && /不存在的图表：表 3/.test(x2.detail)),
    '实得 ' + JSON.stringify(x2 && { ok: x2.ok, d: x2.detail && x2.detail.slice(0, 170) }));
  const xGap = path.join(tmp, 'xref-gap.md');
  fs.writeFileSync(xGap, '# T\n\n## Abstract\n\nA few words.\n\nFigure 1 and Figure 3 are discussed.\n\n**Figure 1.** Cap.\n\n**Figure 3.** Cap.\n');
  const xR3 = runJson(['--draft', xGap, '--contract', cXref, '--json']);
  const x3 = xR3.j && xR3.j.results.find((r) => r.id === 'figure_table_xref');
  add('新检查·必失败面：编号跳号（有图 1、图 3 无图 2）必须 FAIL', !!(x3 && x3.ok === false && /跳号：图 2/.test(x3.detail)),
    '实得 ' + JSON.stringify(x3 && { ok: x3.ok, d: x3.detail && x3.detail.slice(0, 170) }));
  const xOrph = path.join(tmp, 'xref-orphan.md');
  fs.writeFileSync(xOrph, '# T\n\n## Abstract\n\nA few words.\n\nFigure 1 only.\n\n**Figure 1.** Cap.\n\n**Figure 2.** This one is never cited.\n');
  const xR4 = runJson(['--draft', xOrph, '--contract', cXref, '--json']);
  const x4 = xR4.j && xR4.j.results.find((r) => r.id === 'figure_table_xref');
  add('新检查·孤儿（声明但正文从不引用）按契约记 WARN，不误判为 FAIL', !!(x4 && x4.level === 'WARN' && /未被正文引用/.test(x4.detail)),
    '实得 ' + JSON.stringify(x4 && { l: x4.level, d: x4.detail && x4.detail.slice(0, 170) }));
  const xQuote = path.join(tmp, 'xref-quote-caption.md');
  fs.writeFileSync(xQuote, '# T\n\n## Abstract\n\nA few words.\n\nAs shown in Figure 1, the trend holds.\n\n![Figure 1](figures/fig1.png)\n\n> **Figure 1.** Reference-discharge SOH trajectories for the cells, grouped by ambient temperature.\n');
  const xR5 = runJson(['--draft', xQuote, '--contract', cXref, '--json']);
  const x5 = xR5.j && xR5.j.results.find((r) => r.id === 'figure_table_xref');
  add('★假阳性锁：引用块形态的图题（> **Figure 1.** ...）必须被认作图题在场（首版认不出 ⇒ 把内嵌的图全判成引用了不存在的图）',
    !!(x5 && x5.ok === true && x5.level === 'PASS' && /图\[1\]/.test(x5.detail)),
    '实得 ' + JSON.stringify(x5 && { ok: x5.ok, l: x5.level, d: x5.detail && x5.detail.slice(0, 170) }));
  const hClean = fs.mkdtempSync(path.join(os.tmpdir(), 'hyg-clean-'));
  fs.writeFileSync(path.join(hClean, 'manuscript.md'), '# T\n\n## Abstract\n\nA few words.\n');
  fs.writeFileSync(path.join(hClean, 'Cover-Letter.docx'), 'x');
  fs.writeFileSync(path.join(hClean, 'Figures-1.tif'), 'x');
  const cHyg = path.join(tmp, 'c-hyg.json');
  fs.writeFileSync(cHyg, JSON.stringify({ journal: '样例', publisher: 'P', verified_at: '2026-10-16', verified_from: 'u',
    limits: { abstract_max_words: 80 }, structure: { package_hygiene: { required_globs: ['Cover-Letter.*', 'Figures-*.tif'] } } }));
  const hR1 = runJson(['--draft', path.join(hClean, 'manuscript.md'), '--contract', cHyg, '--package', hClean, '--json']);
  const h1 = hR1.j && hR1.j.results.find((x) => x.id === 'package_hygiene');
  add('新检查·投稿包卫生正控：无内部产物且必备件齐备 ⇒ 通过', !!(h1 && h1.ok === true), '实得 ' + JSON.stringify(h1 && { ok: h1.ok, d: h1.detail && h1.detail.slice(0, 150) }));
  fs.writeFileSync(path.join(hClean, '_契约检查报告-x.md'), 'internal');
  const hR2 = runJson(['--draft', path.join(hClean, 'manuscript.md'), '--contract', cHyg, '--package', hClean, '--json']);
  const h2 = hR2.j && hR2.j.results.find((x) => x.id === 'package_hygiene');
  add('新检查·必失败面：内部产物（_契约检查报告）打进投稿包必须 FAIL 并点名', !!(h2 && h2.ok === false && /_契约检查报告-x\.md/.test(h2.detail)),
    '实得 ' + JSON.stringify(h2 && { ok: h2.ok, d: h2.detail && h2.detail.slice(0, 180) }));
  fs.writeFileSync(path.join(hClean, 'Highlights-stale-20261015.docx'), 'old');
  const hR3 = runJson(['--draft', path.join(hClean, 'manuscript.md'), '--contract', cHyg, '--package', hClean, '--json']);
  const h3 = hR3.j && hR3.j.results.find((x) => x.id === 'package_hygiene');
  add('新检查·必失败面：陈旧/旧版文件（*-stale-*）必须 FAIL（上传错文件的高危来源）', !!(h3 && h3.ok === false && /stale/.test(h3.detail)),
    '实得 ' + JSON.stringify(h3 && { ok: h3.ok, d: h3.detail && h3.detail.slice(0, 180) }));
  const hMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'hyg-miss-'));
  fs.writeFileSync(path.join(hMissing, 'manuscript.md'), '# T\n\n## Abstract\n\nA few words.\n');
  const hR4 = runJson(['--draft', path.join(hMissing, 'manuscript.md'), '--contract', cHyg, '--package', hMissing, '--json']);
  const h4 = hR4.j && hR4.j.results.find((x) => x.id === 'package_hygiene');
  add('新检查·必失败面：契约声明的必备件缺失必须 FAIL 并列出缺失项', !!(h4 && h4.ok === false && /缺必备件/.test(h4.detail) && /Cover-Letter/.test(h4.detail)),
    '实得 ' + JSON.stringify(h4 && { ok: h4.ok, d: h4.detail && h4.detail.slice(0, 180) }));
  const hFp = fs.mkdtempSync(path.join(os.tmpdir(), 'hyg-fp-draft-'));
  fs.writeFileSync(path.join(hFp, 'draft.md'), '# T\n\n## Abstract\n\nA few words.\n');
  fs.writeFileSync(path.join(hFp, 'Highlights.docx'), 'x');
  fs.writeFileSync(path.join(hFp, 'Cover-Letter.docx'), 'x');   // 满足 cHyg 的 required_globs，让本夹具只检验陈旧规则
  fs.writeFileSync(path.join(hFp, 'Figures-1.tif'), 'x');
  const hR6 = runJson(['--draft', path.join(hFp, 'draft.md'), '--contract', cHyg, '--package', hFp, '--json']);
  const h6 = hR6.j && hR6.j.results.find((x) => x.id === 'package_hygiene');
  add('★假阳性锁：正常命名的 draft.md 不得被判成陈旧文件（首版把 draft 当陈旧标记 ⇒ 正常名字被误报）',
    !!(h6 && h6.ok === true), '实得 ' + JSON.stringify(h6 && { ok: h6.ok, d: h6.detail && h6.detail.slice(0, 150) }));
  const cUncovered = path.join(tmp, 'c-uncovered.json');
  fs.writeFileSync(cUncovered, JSON.stringify({ journal: 'Selftest J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u',
    limits: { abstract_max_words: 50 }, checkable_ids: ['abstract_max_words', 'this_check_does_not_exist'] }));
  const unc = runJson(['--draft', draft, '--contract', cUncovered, '--json']);
  const cov = unc.j && unc.j.results.find((x) => x.id === 'checkable_ids_covered');
  add('新检查·必失败面：契约声明了本门没执行的检查 ⇒ 必须 FAIL（登记过≠可机检）',
    !!(cov && cov.ok === false && /没执行/.test(cov.detail)), '实得 ' + JSON.stringify(cov && { ok: cov.ok, d: cov.detail }));
  const cCovered = path.join(tmp, 'c-covered.json');
  fs.writeFileSync(cCovered, JSON.stringify({ journal: 'Selftest J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u',
    limits: { abstract_max_words: 50 }, checkable_ids: ['abstract_max_words'] }));
  const covd = runJson(['--draft', draft, '--contract', cCovered, '--json']);
  const cov2 = covd.j && covd.j.results.find((x) => x.id === 'checkable_ids_covered');
  add('新检查·正控：声明项全部已执行 ⇒ 判通过', !!(cov2 && cov2.ok === true), '实得 ' + JSON.stringify(cov2 && { ok: cov2.ok, d: cov2.detail }));
  const noDir = runJson(['--draft', draft, '--contract', c1, '--package', path.join(tmp, 'no-such-dir'), '--json']);
  add('必失败面：--package 目录不存在必须 FAIL（取不到 ≠ 通过）',
    !!(noDir.code === 1 && noDir.j && noDir.j.results.some(x => x.id === 'package_dir' && !x.ok)), '实得 code=' + noDir.code);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* 清理失败不影响判定 */ }
  const passed = r.filter(x => x.ok).length;
  if (process.argv.includes('--json')) console.log(JSON.stringify({ selftest: 'journal-contract', passed, total: r.length, results: r }, null, 2));
  else { for (const x of r) console.log((x.ok ? '  ✓' : '  ✗') + ' ' + x.name + (x.ok ? '' : '  <- ' + x.why)); console.log('\n  自检：' + passed + '/' + r.length + ' 通过'); }
  process.exit(passed === r.length ? 0 : 1);
}

if (!draftPath || !contractPath) {
  console.error('用法: node _journal-contract.cjs --draft <稿.md> --contract <契约.json> [--json]');
  process.exit(2);
}
for (const p of [draftPath, contractPath]) {
  if (!fs.existsSync(p)) { console.error('找不到文件: ' + p); process.exit(2); }
}

const raw = fs.readFileSync(draftPath, 'utf8');
let contract = null;
try { contract = JSON.parse(fs.readFileSync(contractPath, 'utf8')); }
catch (e) { console.error('契约 JSON 不可解析（不得当了通过）: ' + contractPath + ' —— ' + String((e && e.message) || e)); process.exit(2); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(String(contract.verified_at || '')) || !String(contract.verified_from || '').trim()) {
  console.error('契约缺取证信息（verified_at 需 YYYY-MM-DD、verified_from 不得为空）: ' + contractPath);
  process.exit(2);
}
const text = raw.replace(/\r\n?/g, '\n');
const noMeta = text.replace(/<!--[\s\S]*?-->/g, '\n');

/* 节名别名（CN 契约）：把 `摘要/关键词/致谢/参考文献` 等中文节名并入查找正则；
   没有别名的旧契约行为完全不变（默认只认英文节名）。 */
const ALIAS = (contract.structure && contract.structure.section_aliases) || contract.section_aliases || {};
/* dfltRe 是**正则片段**（如 'Key\\s*words?'），原样使用；契约传来的别名按字面量转义。
   ★ 首版把 dflt 也转义了 ⇒ 'Key\\s*words?' 变成 'Key\\\\s\\*words\\?' ⇒ 关键词检查永远匹配不到
     （对账项只查"跑没跑"、不查"过没过"，所以没拦住 —— 由我自己比对上轮计数才发现）。 */
const aliasAlt = (key, dfltRe) => {
  const extra = Array.isArray(ALIAS[key]) ? ALIAS[key] : (ALIAS[key] ? [ALIAS[key]] : []);
  const parts = [dfltRe].concat(extra.map((x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return '(?:' + parts.join('|') + ')';
};
const secStart = (key, dflt) => new RegExp('^##+\\s*' + aliasAlt(key, dflt), 'm');
const secEnd = () => /^##+\s|^\*\*\s*(?:Key\s*words?|关键词)/m;

function section(startRe, endRe) {
  const s = noMeta.search(startRe);
  if (s < 0) return null;
  const rest = noMeta.slice(s);
  const body = rest.slice(rest.indexOf('\n') + 1);
  if (!endRe) return body;
  const e = body.search(endRe);
  return e < 0 ? body : body.slice(0, e);
}
const countWords = s => !s ? 0 : s.split(/\s+/).filter(t => /[A-Za-z0-9]/.test(t)).length;
/* 保守口径：按空白分词全部计入（Word 会把 "=" "→" 这类独立符号也算一个词）。
   判定用保守口径，同时把两个数都打印出来，避免「口径不同 → 余量虚高」。 */
const countWordsConservative = s => !s ? 0 : s.split(/\s+/).filter(t => t.length > 0).length;
/* ★ v3.2.9 中文支持：CN 契约里"摘要 ≤N 字"是按**汉字字数**算的，按空白分词会把整段中文数成 1 个词。
   cjk 口径 = 汉字/标点按 1 计 + 英文单词按 1 计（与中文刊编辑部的"字数"习惯一致，且把中英混排都算上）。 */
const countCjk = (s) => {
  if (!s) return 0;
  const han = (s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const latin = (s.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'\-]*/g) || []).length;
  return han + latin;
};
const COUNTERS = { words: countWordsConservative, cjk: countCjk };
const counterFor = (mode) => COUNTERS[mode] || countWordsConservative;
const unitOf = (mode) => (mode === 'cjk' ? '字' : '词');

/* ★ 同族修正（CN 支持）：正文/参考文献/附录的分界也必须走**别名**——
   否则中文稿的「## 参考文献」不被识别，参考文献会被算进正文（字数虚高、条目检查不跑）。 */
const refsIdx = noMeta.search(secStart('references', 'References'));
const appIdx = noMeta.search(secStart('appendix', 'Appendix'));
const bodyEnd = [refsIdx, appIdx].filter(i => i >= 0).sort((a, b) => a - b)[0];
const body = bodyEnd === undefined ? noMeta : noMeta.slice(0, bodyEnd);

/* ── 包级证据扫描（--package） ── */
const pkg = { dir: pkgDir || '', exists: false, files: [], texts: [], unreadable: [] };
if (pkgDir) {
  try { pkg.exists = fs.existsSync(pkgDir) && fs.statSync(pkgDir).isDirectory(); } catch (e) { pkg.exists = false; }
  if (pkg.exists) {
    const walk = (d, depth) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { pkg.unreadable.push(String((e && e.message) || e)); return; }
      for (const e of ents) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (depth < 2) walk(full, depth + 1); continue; }
        pkg.files.push(path.relative(pkgDir, full));
        if (/\.(md|txt|json|csv|tex)$/i.test(e.name)) {
          try { pkg.texts.push(fs.readFileSync(full, 'utf8')); } catch (err) { pkg.unreadable.push(e.name); }
        }
      }
    };
    walk(pkgDir, 0);
  }
}
const pkgText = pkg.texts.join('\n');
/* ★ 声明级证据（2026-10-16 自查出的**假阳性**风险）：包里某处出现关键词 ≠ 有该声明 ——
   A 稿的 CRediT 关键词其实来自它自己检查表里的待办行（[ ] Declarations 其余三项）。
   ⇒ 声明只认两种证据：①独立文件名命中；②**标题行**命中（且该行不得是待办/疑问行）。 */
const TODO_ISH = /\[\s*\]|\[x\]|TODO|待填|待补|待核|未填|未写|缺|\?|？|待办/i;
/* ★ v3.2.20 更正（此前是**假阴性**）：声明段的证据强度原先只认 Markdown 标题行（`## CRediT`），
   但大量真实稿件把声明写成**行首加粗/斜体标签**（`**CRediT authorship contribution statement.** 张三：…`）
   —— 这不是"待办"，是**真实声明**，却被判成"缺声明"。现改为三种**同等强**的证据，且仍排除待办行：
     ① 标题行 `## X`  ② 行首加粗/斜体标签 `**X**`／`*X*`／`__X__`  ③ 由调用方给出的**标准声明句** patterns（见 required_sections）。 */
const LABEL_LINE = /^\s{0,3}(?:#{1,4}\s*|\*\*[^*\n]{2,90}\*\*\s*[:.．]?|__[^_\n]{2,90}__\s*[:.．]?|\*[^*\n]{2,90}\*\s*[:.．]?)/;
const declLineIn = (text, kwRe, patterns) => {
  const pats = (patterns || []).map((p) => (p instanceof RegExp ? p : new RegExp(p, 'i')));
  for (const line of String(text || '').split('\n')) {
    if (TODO_ISH.test(line)) continue;                    // 待办行不算声明
    if (/^\s{0,3}#{1,4}\s*/.test(line) || LABEL_LINE.test(line)) {
      if (kwRe.test(line)) return line.trim();
    }
    /* 标准声明句：只认**行首**（去掉项目符号/加粗等标记后）的整句形态，避免正文里"提到"就算 */
    const bare = line.replace(/^\s*(?:[#>*_\-]+\s*)+/, '');
    for (const pr of pats) { if (pr.test(bare)) return line.trim(); }
  }
  return '';
};
const pkgFileHit = (re) => pkg.files.find((f) => re.test(path.basename(f))) || '';
const pkgHasText = (re) => re.test(pkgText);
const ev = (inDraft, inPkg, what) => (inDraft ? '稿件内' : '') + (inPkg ? (inDraft ? ' + ' : '') + 'package:' + what : '') || '未找到';

const results = [];
const check = (id, level, ok, detail, evidence) => results.push({ id, level, ok, detail, evidence: evidence || '' });

const L = contract.limits || {};
const S = contract.structure || {};

/* C1 摘要词数 */
const absSec = section(secStart('abstract', 'Abstract'), secEnd());
if (L.abstract_max_words) {
  const w = countWordsConservative(absSec), wAlnum = countWords(absSec);
  check('abstract_max_words', 'FAIL', absSec !== null && w <= L.abstract_max_words,
    absSec === null ? '未找到摘要节（## Abstract 或契约别名）'
      : `实测 ${w} 词（保守口径）／${wAlnum} 词（仅字母数字） / 上限 ${L.abstract_max_words} 词（余量 ${L.abstract_max_words - w}）`);
}
/* C1b 摘要字数（中文刊口径：按"字"计；300 字左右 ⇒ 目标 300、硬上限 = target×1.1） */
if (L.abstract_target_chars || L.abstract_max_chars) {
  const mode = L.count_mode || 'cjk';
  const cnt = counterFor(mode);
  const n = cnt(absSec);
  const target = L.abstract_target_chars || null;
  const hard = L.abstract_max_chars || (target ? Math.round(target * 1.1) : null);
  const over = hard !== null && n > hard;
  const overTarget = target !== null && n > target && !over;
  check('abstract_chars', over ? 'FAIL' : 'WARN', absSec !== null && !over,
    absSec === null ? '未找到摘要节（## Abstract 或契约别名）'
      : `实测 ${n} ${unitOf(mode)}${target ? ' / 目标 ' + target : ''}${hard !== null ? ' / 硬上限 ' + hard : ''}${over ? '（超硬上限 ' + (n - hard) + '）' : (overTarget ? '（略超目标，官方措辞为"左右"，记提醒）' : '（合规）')}`);
}
/* C1c 摘要必备要素（中文刊常见：须含 [目的][方法][结果][结论]） */
if (Array.isArray(L.abstract_required_terms) && L.abstract_required_terms.length) {
  const miss = absSec === null ? L.abstract_required_terms.slice() : L.abstract_required_terms.filter((k) => absSec.indexOf(k) < 0);
  check('abstract_required_terms', 'FAIL', absSec !== null && miss.length === 0,
    absSec === null ? '未找到摘要节，无法核对必备要素' : (miss.length === 0 ? `摘要含全部必备要素（${L.abstract_required_terms.join('、')}）` : `摘要缺必备要素：${miss.join('、')}`));
}

/* C2 Highlights：在场、条数、每条字符数 */
/* ★ v3.2.42：`highlights_required`（PLOS 的**扁平布尔**写法）是 `limits.highlights.required` 的别名。
   此前只认后者 ⇒ 该键声明了却没人执行（由「声明 vs 执行」锁抓出）。 */
const HL = Object.assign({}, L.highlights || {});
if (HL.required === undefined && typeof L.highlights_required === 'boolean') HL.required = L.highlights_required;
if (HL.required) {
  const hl = section(/^##+\s*Highlights\b/m, /^##+\s/m);
  const hlFile = pkg.exists ? pkgFileHit(/^highlights?[._-]?.*\.(md|txt|docx?|pdf)$/i) : '';
  if (hl === null && hlFile) {
    check('highlights_present', 'FAIL', true, '稿件内无 Highlights 节，但投稿包内有独立文件（该刊 Highlights 本就是独立文件）⇒ 判通过（证据：package:' + hlFile + '）', 'package:' + hlFile);
  } else if (hl === null) {
    check('highlights_present', 'FAIL', false, '契约要求 Highlights，但稿件中无该节' + (pkg.exists ? '、投稿包内也没有 Highlights 文件' : '（**未给 --package，包级要件可能被误报**）'));
  } else {
    const bullets = hl.split('\n').map(s => s.trim()).filter(s => /^[-*]\s+/.test(s)).map(s => s.replace(/^[-*]\s+/, ''));
    const over = bullets.filter(b => b.length > (HL.max_chars_each || 85));
    check('highlights_count', 'FAIL', bullets.length >= (HL.min || 3) && bullets.length <= (HL.max || 5),
      `实测 ${bullets.length} 条 / 要求 ${HL.min || 3}–${HL.max || 5} 条`);
    check('highlights_chars', 'FAIL', bullets.length > 0 && over.length === 0,
      bullets.length === 0 ? '未解析到 bullet 行'
        : `逐条字符数 ${bullets.map(b => b.length).join(', ')} / 每条上限 ${HL.max_chars_each || 85}（超限 ${over.length} 条）`);
  }
}

/* ★ v3.2.38：**分体裁上限**解析放在块外**（首版放在 if 内 ⇒ 块作用域，块外引用直接 ReferenceError；
   教训：要跨块复用的绑定必须声明在共同祖先作用域）。解析顺序：`<article_type>_max_words` → 通用 → chars 上限。 */
const typeCapKey = (contract.article_type ? String(contract.article_type) + '_max_words' : '');
const typeCap = typeCapKey && typeof L[typeCapKey] === 'number' ? L[typeCapKey] : null;
const capSource = typeCap !== null ? (typeCapKey + '（按 article_type=' + contract.article_type + '）') : 'manuscript_max_words（通用上限）';
/* ★ 同一条教训的第二次：凡「块内算、块外要读」的绑定，一律声明在共同祖先作用域。 */
const cap = typeCap !== null ? typeCap : (L.manuscript_max_chars || L.manuscript_max_words);
const capUnit = L.manuscript_max_chars ? unitOf(L.count_mode || 'words') : '词';

/* C3 正文词数 */
if (L.manuscript_max_words || L.manuscript_max_chars || typeCap !== null) {
  /* ★ 与摘要同一个坑（同族漏网）：中文刊的"全文 ≤N 字"若仍按空白分词，会数成个位数 ⇒ 等于没检 */
  const mode = L.count_mode || 'words';
  const cnt = counterFor(mode);
  const w = cnt(body);
  check('manuscript_max_words', 'FAIL', w <= cap,
    `实测 ${w} ${capUnit}（口径 ${mode === 'cjk' ? '汉字字数+英文词' : '空白分词'}；去元数据、去参考文献与附录） / 上限 ${cap} ${capUnit}（余量 ${cap - w}）`);
}

  /* ★ v3.2.38：把**本次适用的上限与来源**单列一行（恒过，但读的时候不必猜「6000 是哪来的」）。
     注：这一行必须留在 C3 的 `if` **内部**（首版插到 `}` 之后又补了一个 `}` ⇒ 提前闭合块、语法错）。 */
  check('word_cap_source', 'WARN', true, '本次适用的正文上限：' + cap + ' ' + capUnit + ' · 来源：' + capSource);

/* ★ v3.2.38：若契约声明了**分体裁**上限但当前 article_type 用不上它，必须显形（不得静默忽略声明）。 */
/* ★ v3.2.38 收窄（首版是假警报）：**多体裁契约声明别的体裁上限是正常的** —— 当前体裁没有专属上限时用通用上限本来就对。
   只有「声明了分体裁上限、但 `article_type` 缺失 ⇒ 不知道哪条适用」才是真信号。 */
if (!typeCap && !contract.article_type) {
  const declaredTypeCaps = Object.keys(L).filter((k) => /_(?:max|min)_(words|chars)$/.test(k));
  if (declaredTypeCaps.length) {
    check('article_type_cap_unapplied', 'WARN', false,
      '契约声明了分体裁上限 ' + declaredTypeCaps.join(' / ') + '，但 article_type=' + String(contract.article_type || '(未声明)') + ' ⇒ **本次用的是通用上限，分体裁上限未被应用**（要么补 article_type，要么把该声明标为 informational）');
  }
}

/* C4 图与表数量（官方措辞为 Ideally ⇒ WARN） */
if (L.figures_tables_min || L.figures_tables_max) {
  // 图表计数：三种图注约定都认（标题式 / 加粗式 / **引用式图注**），另认标准 Markdown 图片行
  //   ① ## Figure 1  ② **Figure 1**  ③ > **Figure 1.**  ④ ![Figure 1](figures/fig1*.png)
  // （教训：正文改成引用式图注 + Markdown 图片后，本计数器曾把 4 张图数成 0 —— 约定变更必须同步所有读取方）
  const figRe = /^(?:#{2,4}\s*Figure\s+\d+|>\s*\*\*Figure\s+\d+|\*\*Figure\s+\d+|!\[[^\]]*Figure\s+\d+)/gm;
  const figs = new Set((noMeta.match(figRe) || []).map(s => (s.match(/\d+/) || [''])[0]));
  const tabs = new Set((noMeta.match(/^#{2,4}\s*Table\s+\d+|^\*\*Table\s+\d+/gm) || []).map(s => (s.match(/\d+/) || [''])[0]));
  const n = figs.size + tabs.size;
  const lo = L.figures_tables_min || 0, hi = L.figures_tables_max || 99;
  check('figures_tables_range', 'WARN', n >= lo && n <= hi,
    `实测 ${figs.size} 图 + ${tabs.size} 表 = ${n} / 建议 ${lo}–${hi}（官方为 Ideally 措辞，故记 WARN）`);
}

/* ★ v3.2.38：**Highlights 必须是独立可编辑文件且文件名含指定词**（契约 `limits.highlights.separate_editable_file`
   + `filename_must_contain`）。此前这两个键**没有任何门在管** —— 声明了却不执行，正是「声明-执行」缺口。 */
if (L.highlights && (L.highlights.separate_editable_file === true || L.highlights.filename_must_contain)) {
  const need = String(L.highlights.filename_must_contain || 'highlights').toLowerCase();
  if (!pkg.exists) {
    check('highlights_separate_file', 'WARN', false, '未给 --package ⇒ **未检查**（未检查 ≠ 通过）：本刊要求 Highlights 作为独立可编辑文件，文件名需含 `' + need + '`');
  } else {
    const names = (pkg.files || []).map((f) => path.basename(String(f)));
    const hit = names.filter((n) => n.toLowerCase().indexOf(need) >= 0);
    check('highlights_separate_file', 'FAIL', hit.length > 0,
      hit.length ? ('包内命中：' + hit.join(' / ')) : ('包内没有文件名含 `' + need + '` 的可编辑文件 ⇒ 本刊要求独立 Highlights 文件（如 Highlights.docx）'));
  }
}

/* C5 附录归类：契约要求 Supplementary 只放替代格式时，出现 Supplementary 节即 FAIL */
if (S.supplementary_only_alternate_formats) {
  const sup = /^##+\s*Supplementary\b/m.test(noMeta);
  check('appendix_not_supplementary', 'FAIL', !sup,
    sup ? '存在 ## Supplementary 节；该刊要求复现细节与附加结果放 Appendix，Supplementary 只留视频/动画等替代格式'
        : '未发现 Supplementary 节（符合）');
}

/* C6 引用编号须按首次出现顺序（与参考文献表顺序一致） */
if ((S.references_style || '').indexOf('numbered') >= 0) {
  const citeNums = [];
  const re = /\[(\d+(?:\s*[-,–—]\s*\d+)*)\]/g;
  const forCite = noMeta.slice(0, refsIdx >= 0 ? refsIdx : noMeta.length);
  let m;
  while ((m = re.exec(forCite))) {
    for (const part of m[1].split(',')) {
      const rng = part.split(/[–—-]/);
      if (rng.length === 2) {
        const a = parseInt(rng[0], 10), b = parseInt(rng[1], 10);
        if (Number.isFinite(a) && Number.isFinite(b)) for (let i = a; i <= b; i++) citeNums.push(i);
      } else if (Number.isFinite(parseInt(part, 10))) citeNums.push(parseInt(part, 10));
    }
  }
  const firstSeen = [];
  for (const n of citeNums) if (!firstSeen.includes(n)) firstSeen.push(n);
  const inOrder = firstSeen.join(',') === firstSeen.slice().sort((a, b) => a - b).join(',');
  /* 指出第一处逆序（只报「不合规」不指出位置 = 把排查成本转嫁给读者） */
  let where = '';
  if (!inOrder) {
    const lines = forCite.split('\n');
    const seen = [];
    outer:
    for (let li = 0; li < lines.length; li++) {
      const mm = lines[li].match(re) || [];
      for (const tok of mm) {
        const nums = [];
        for (const part of tok.slice(1, -1).split(',')) {
          const rng = part.split(/[–—-]/);
          if (rng.length === 2) { const a = +rng[0], b = +rng[1]; if (a && b) for (let i = a; i <= b; i++) nums.push(i); }
          else if (+part) nums.push(+part);
        }
        for (const n of nums) {
          if (!seen.includes(n)) {
            const expected = Math.max(...seen) + 1;
            if (seen.length && n !== expected) {
              where = `；第一处逆序在第 ${li + 1} 行（正文口径）：此处首次引用 [${n}]，但它之前已出现 [${seen.join(',')}] ⇒ 按出现顺序它应编为 [${expected}]`;
              break outer;
            }
            seen.push(n);
          }
        }
      }
    }
  }
  check('references_numbered_in_order', 'FAIL', firstSeen.length > 0 && inOrder,
    firstSeen.length === 0 ? '正文中未解析到方括号编号引用'
      : `首次出现顺序${inOrder ? '= 升序（合规）' : '≠ 升序（不合规）'}；最大引用号 ${Math.max(...firstSeen)}；解析到条目行 ${(raw.match(/^(\*\*)?\[\d+\]/gm) || []).length} 条${where}`);
}

/* C7 条目必备项 */
const need = S.reference_entry_must_include || [];
if (need.length && refsIdx >= 0) {
  const refBody = noMeta.slice(refsIdx, appIdx > refsIdx ? appIdx : noMeta.length);
  const entries = refBody.split('\n').map(s => s.trim()).filter(s => /^(\*\*)?\[\d+\]/.test(s));
  const missing = [];
  for (const e of entries) {
    /* 年份规则：接受出版年份，也接受「accessed YYYY-MM-DD」——数据集/网页类来源常无出版年，
       但其访问日期是可核的；此时要求一个不存在的年份才是坏规则。 */
    if (need.includes('year') && !/(19|20)\d{2}/.test(e)) missing.push('缺年份且无访问日期：' + e.slice(0, 60));
  }
  check('reference_entries_complete', 'WARN', entries.length > 0 && missing.length === 0,
    entries.length === 0 ? '未解析到参考文献条目（格式可能不含行首 [n]）'
      : `条目 ${entries.length} 条，缺项 ${missing.length} 条${missing.length ? '（示例：' + missing[0] + '）' : ''}`);
}

/* C8 关键词 */
if (S.keywords_required) {
  const kw = new RegExp('(?:\\*\\*)?(?:' + aliasAlt('keywords', 'Key\\s*words?') + ')', 'i').test(noMeta);
  check('keywords_present', 'FAIL', kw, kw ? '存在关键词行' : '未找到关键词行（## Keywords 或契约别名）');
}

/* C9 CRediT 作者贡献 */
if (S.credit_required) {
  const cFile = pkg.exists ? pkgFileHit(/(credit|contribution|author[-_]?statement)/i) : '';
  const declDraft = declLineIn(noMeta, /CRediT|Author contributions?/i);
  const declPkg = pkg.exists ? declLineIn(pkgText, /CRediT|Author contributions?/i) : '';
  const inDraft = !!declDraft;
  const inPkgText = !!declPkg;
  const cOk = inDraft || !!cFile || inPkgText;
  check('credit_present', 'FAIL', cOk,
    cOk ? '存在 CRediT 作者贡献声明（证据：' + ev(inDraft, !!(cFile || inPkgText), cFile || '正文关键词') + '）'
        : '未找到 CRediT 声明' + (pkg.exists ? '（稿件与投稿包内都没有）' : '（**未给 --package，若声明在独立文件里会误报**）'),
    cFile ? 'package:' + cFile : (inPkgText ? 'package:标题行' : (inDraft ? 'draft:标题行' : '')));
}

/* C10 致谢须在参考文献之前 */
if (S.acknowledgements_before_references && refsIdx >= 0) {
  const ackIdx = noMeta.search(/^##+\s*Acknowledg(e)?ments\b/im);
  const ok = ackIdx >= 0 && ackIdx < refsIdx;
  check('acknowledgements_before_references', 'FAIL', ok,
    ackIdx < 0 ? '未找到 Acknowledgments 节' : (ok ? '致谢节位于参考文献之前（合规）' : '致谢节位于参考文献之后（不合规）'));
}

/* C11 生成式 AI 使用声明（Elsevier 出版社级硬要求；置于参考文献之前）
   ★ 与其余各项不同：此项**不是** JoES Guide 页面的摘录，而是出版社级政策的产物，
     故在 contract JSON 里单独标了 ai_declaration_provenance 说明来源 —— 门只负责「有没有、位置对不对」，
     不替作者判断「怎么声明才属实」（那必须作者自己认）。 */
if (S.ai_declaration_required) {
  const aiIdx = noMeta.search(/^##+\s*.*(generative\s*AI|AI[- ]assisted\s*technologies).*$/im);
  const before = aiIdx >= 0 && (refsIdx < 0 || aiIdx < refsIdx);
  const aiFile = pkg.exists ? pkgFileHit(/(generative[-_ ]?ai|ai[-_ ]?(use|declaration|statement))/i) : '';
  const aiDeclDraft = declLineIn(noMeta, /generative\s*AI|AI[- ]assisted\s*technologies/i);
  const aiDeclPkg = pkg.exists ? declLineIn(pkgText, /generative\s*AI|AI[- ]assisted\s*technologies/i) : '';
  const aiPkgText = !!aiDeclPkg;
  const aiOk = aiDeclPkg ? true : (aiIdx >= 0 && !!aiDeclDraft) || !!aiFile;
  check('ai_declaration_present', 'FAIL', aiOk,
    aiOk ? '存在生成式 AI 使用声明（证据：' + ev(aiIdx >= 0, !!(aiFile || aiPkgText), aiFile || '正文关键词') + '）'
         : '未找到生成式 AI 使用声明节（Elsevier 要求单独成节）' + (pkg.exists ? '' : '（**未给 --package，若声明在独立文件里会误报**）'),
    aiFile ? 'package:' + aiFile : (aiPkgText ? 'package:标题行' : (aiIdx >= 0 ? 'draft:标题行' : '')));
  check('ai_declaration_before_references', 'WARN', before,
    aiIdx < 0 ? '未能定位声明节，位置检查跳过（已计入上一条 FAIL）'
      : (before ? 'AI 声明位于参考文献之前（合规）' : 'AI 声明位于参考文献之后（建议移到之前）'));
}

/* ── C12–C17（v3.2.8 新增 · 全部契约驱动）：把契约里声明过的量**真正执行** ──
   为什么：PLOS 契约（plos-one.json）声明了 12 条可机检要点，而本门此前只跑 2 项 ⇒
   典型的「登记过 ≠ 可机检」。以下六条补上声明与执行之间的缺口；契约没写这些字段的刊不受影响。 */

/* C12 全标题字符数（PLOS ≤250 等） */
if (L.title_max_chars) {
  const m = noMeta.match(/^#\s+(.+)$/m);
  const title = m ? m[1].trim() : '';
  check('title_max_chars', 'FAIL', !!title && title.length <= L.title_max_chars,
    title ? `实测 ${title.length} 字符 / 上限 ${L.title_max_chars}（余量 ${L.title_max_chars - title.length}）`
         : '未找到 H1 标题行（不得当了通过）');
}

/* C13 短标题（PLOS 要 ≤100 字符且必须有） */
if (L.short_title_required || L.short_title_max_chars) {
  const m = noMeta.match(/^.*(?:short title|running title|running head)\s*[:：]\s*(.+)$/im);
  const st = m ? m[1].trim() : '';
  const over = st && L.short_title_max_chars && st.length > L.short_title_max_chars;
  check('short_title', 'FAIL', !!st && !over,
    st ? `实测 ${st.length} 字符${L.short_title_max_chars ? ' / 上限 ' + L.short_title_max_chars : ''}（余量 ${L.short_title_max_chars ? L.short_title_max_chars - st.length : '—'}）`
       : '契约要求短标题（short/running title），稿件中未找到该行');
}

/* C14 标题层级上限（PLOS ≤3 级） */
if (L.heading_levels_max) {
  const dist = {};
  for (const m of noMeta.matchAll(/^(#{1,6})\s+\S/gm)) { const n = m[1].length; dist[n] = (dist[n] || 0) + 1; }
  const maxLv = Object.keys(dist).map(Number).sort((a, b) => b - a)[0] || 0;
  const over = Object.keys(dist).map(Number).filter((n) => n > L.heading_levels_max);
  check('heading_levels_max', 'FAIL', maxLv > 0 && over.length === 0,
    maxLv ? `最深 ${maxLv} 级 / 上限 ${L.heading_levels_max} 级（分布 ${Object.keys(dist).sort().map((k) => 'H' + k + '=' + dist[k]).join(' · ')}${over.length ? '；超限级别 ' + over.map((n) => 'H' + n).join(',') : ''}）`
          : '未解析到任何标题行');
}

/* C14b 各级标题字数上限（中文刊常见「各级标题 ≤15 字」） */
if (L.heading_max_chars) {
  const hs = [...noMeta.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
  const over = hs.filter((h) => h.length > L.heading_max_chars);
  check('heading_max_chars', 'FAIL', hs.length > 0 && over.length === 0,
    hs.length === 0 ? '未解析到标题行' : (over.length === 0 ? `全部 ${hs.length} 个标题 ≤ ${L.heading_max_chars} 字（最长 ${Math.max(...hs.map((h) => h.length))}）`
      : `${over.length}/${hs.length} 个标题超 ${L.heading_max_chars} 字：` + over.slice(0, 3).map((h) => h.slice(0, 20) + '(' + h.length + ')').join(' / ')));
}

/* C14c 关键词个数（逐刊不同：3–5 或 5–8） */
if (L.keywords_min || L.keywords_max) {
  const kwLine = (noMeta.match(new RegExp('^[^\\n]*(?:' + aliasAlt('keywords', 'Key\\s*words?') + ')\\s*[:：]?[^\\n]*$', 'm')) || [''])[0];
  const body = kwLine.replace(/^[^:：]*[:：]?/, '').trim();
  const kws = body.split(/[;；,，、]/).map((s) => s.trim()).filter((s) => s && s.length <= 30);
  const lo = L.keywords_min || 0; const hi = L.keywords_max || 99;
  check('keywords_count', 'FAIL', kws.length >= lo && kws.length <= hi,
    kws.length === 0 ? '未解析到关键词行（## Keywords / 关键词）' : `实测 ${kws.length} 个 / 要求 ${lo}–${hi} 个`);
}

/* ── 图件头解析（v3.2.19 · 纯 JS 无依赖）──────────────────────────────
   为什么：图件规格（分辨率/格式/尺寸/体积）是投稿被打回的常见原因，而此前只数了"图有几张"。
   ★ 纪律：读不出分辨率 ⇒ 必须报"核不了"，**不得当成通过**（B 条）。 */
function imageInfo(abs) {
  let b;
  try { b = fs.readFileSync(abs); } catch (e) { return { error: String((e && e.message) || e) }; }
  const out = { bytes: b.length, pxW: null, pxH: null, dpi: null, format: '', note: '' };
  const SIG_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (b.length > 24 && b.slice(0, 8).equals(SIG_PNG)) {
    out.format = 'png';
    out.pxW = b.readUInt32BE(16); out.pxH = b.readUInt32BE(20);
    let off = 8;
    while (off + 12 <= b.length) {
      const len = b.readUInt32BE(off); const type = b.slice(off + 4, off + 8).toString('latin1');
      if (type === 'pHYs' && len >= 9) {
        const ppuX = b.readUInt32BE(off + 8); const unit = b[off + 16];
        if (unit === 1 && ppuX > 0) out.dpi = Math.round(ppuX * 0.0254);
      }
      if (type === 'IDAT' || type === 'IEND') break;
      off += 12 + len;
    }
    if (out.dpi === null) out.note = 'PNG 未含 pHYs 块（未标注物理分辨率）';
  } else if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
    out.format = 'jpeg';
    let off = 2;
    while (off + 4 < b.length) {
      if (b[off] !== 0xFF) { off++; continue; }
      const marker = b[off + 1]; const len = b.readUInt16BE(off + 2);
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC && off + 9 < b.length) {
        out.pxH = b.readUInt16BE(off + 5); out.pxW = b.readUInt16BE(off + 7);
      }
      if (marker === 0xE0 && len >= 14 && b.slice(off + 4, off + 9).toString('latin1') === 'JFIF\u0000') {
        const units = b[off + 11]; const xd = b.readUInt16BE(off + 12);
        if (units === 1 && xd > 0) out.dpi = xd;
        else if (units === 2 && xd > 0) out.dpi = Math.round(xd * 2.54);
      }
      if (out.pxW) break;
      off += 2 + len;
    }
    if (out.dpi === null) out.note = 'JPEG 未含 JFIF 密度（未标注物理分辨率）';
  } else if (b.slice(0, 3).toString('latin1') === 'GIF') {
    out.format = 'gif'; out.pxW = b.readUInt16LE(6); out.pxH = b.readUInt16LE(8);
    out.note = 'GIF 无标准物理分辨率字段';
  } else if (b.length > 26 && b.slice(0, 2).toString('latin1') === 'BM') {
    out.format = 'bmp'; out.pxW = b.readInt32LE(18); out.pxH = Math.abs(b.readInt32LE(22));
    out.note = 'BMP 无标准物理分辨率字段';
  } else if (/^%!PS/.test(b.slice(0, 4).toString('latin1'))) {
    out.format = 'eps';
    const m = /%%(?:HiRes)?BoundingBox:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/.exec(b.slice(0, 8000).toString('latin1'));
    if (m) { out.pxW = Math.round(parseFloat(m[3]) - parseFloat(m[1])); out.pxH = Math.round(parseFloat(m[4]) - parseFloat(m[2])); out.note = 'EPS 边界盒单位为点（72 pt = 1 in ⇒ 10 in 宽 ≈ 720 pt）'; }
    else out.note = 'EPS 未找到 %%BoundingBox';
  } else if (/<svg/i.test(b.slice(0, 3000).toString('utf8'))) {
    out.format = 'svg';
    const head = b.slice(0, 4000).toString('utf8');
    const mw = /\bwidth\s*=\s*"([\d.]+)\s*(mm|px|pt|in)?"/i.exec(head);
    const mh = /\bheight\s*=\s*"([\d.]+)\s*(mm|px|pt|in)?"/i.exec(head);
    if (mw) out.pxW = Math.round(parseFloat(mw[1]));
    if (mh) out.pxH = Math.round(parseFloat(mh[1]));
    out.note = 'SVG 为矢量：按 width/height 属性读数（单位见文件，未换算）';
  } else {
    out.format = 'unknown';
    out.note = '未识别的图件格式（无法判定）';
  }
  return out;
}
/** ★ v3.2.42：**扁平写法的图件规格** 归一成 `figure_spec` 形状。
 *  为什么：PLOS 契约把图件要求直接写在 `limits.*` 下（`figure_format` / `figure_dpi` / `figure_file_max_mb` /
 *  `figure_width_px` / `figure_height_px_max`），而门此前只读 `limits.figure_spec` ⇒ **这批键没有任何门在管**
 *  （2026-10-16 由「契约声明 vs 门执行」机械锁抓出，登记为 known_gap；本轮关掉）。
 *  单位换算：MB→KB（×1024）；dpi 的 min/max 与 px 上下限直通。 */
function figureSpecFromLimits(L) {
  const out = Object.assign({}, (L && L.figure_spec) || {});
  const s = L || {};
  if (!out.allowed_formats && Array.isArray(s.figure_format) && s.figure_format.length) out.allowed_formats = s.figure_format;
  if (s.figure_dpi && typeof s.figure_dpi === 'object') {
    if (out.min_dpi === undefined && typeof s.figure_dpi.min === 'number') out.min_dpi = s.figure_dpi.min;
    if (out.max_dpi === undefined && typeof s.figure_dpi.max === 'number') out.max_dpi = s.figure_dpi.max;
  }
  if (out.max_file_kb === undefined && typeof s.figure_file_max_mb === 'number') out.max_file_kb = Math.round(s.figure_file_max_mb * 1024);
  if (s.figure_width_px && typeof s.figure_width_px === 'object') {
    if (out.min_width_px === undefined && typeof s.figure_width_px.min === 'number') out.min_width_px = s.figure_width_px.min;
    if (out.max_width_px === undefined && typeof s.figure_width_px.max === 'number') out.max_width_px = s.figure_width_px.max;
  }
  if (out.max_height_px === undefined && typeof s.figure_height_px_max === 'number') out.max_height_px = s.figure_height_px_max;
  return out;
}
/** 图件规格判据（契约 limits.figure_spec 或扁平写法归一生的同一形状） */
function figureSpecJudge(files, spec) {
  const S = spec || {};
  const per = [];
  for (const f of files) {
    const info = imageInfo(f.abs);
    if (info.error) { per.push({ file: f.rel, verdict: 'unreadable', why: info.error }); continue; }
    const problems = []; const unknowns = [];
    const fmt = String(info.format || '').toLowerCase();
    if (Array.isArray(S.allowed_formats) && S.allowed_formats.length) {
      /* ★ 修正（自查）：首版写成 `!A.indexOf(x) >= 0` ⇒ 取反后比大小、实际恒真 ⇒ 连允许的格式也被判违规。
         正规写法是 `indexOf(...) < 0`。格式名归一：jpeg→jpg、tiff→tif。 */
      const normFmt = (x) => String(x).toLowerCase().replace(/^jpeg$/, 'jpg').replace(/^tiff?$/, 'tif');
      const allowed = S.allowed_formats.map(normFmt);
      if (allowed.indexOf(normFmt(fmt)) < 0) {
        problems.push('格式 ' + (fmt || '未知') + ' 不在允许列表 ' + S.allowed_formats.join('/'));
      }
    }
    if (S.min_dpi) {
      if (info.dpi === null || info.dpi === undefined) {
        if (S.dpi_required) problems.push('未标注物理分辨率（契约要求必须可判）');
        else unknowns.push('未标注物理分辨率 ⇒ 核不了（不等于合规）');
      } else if (info.dpi < S.min_dpi) {
        problems.push('实测 ' + info.dpi + ' dpi < 要求 ' + S.min_dpi + ' dpi');
      }
    }
    /* ★ v3.2.42：**dpi 上限**与 **px 上下限**（PLOS 契约这两类都会写；此前只支持 min_dpi 与 mm 宽度）。 */
    if (S.max_dpi && info.dpi && info.dpi > S.max_dpi) problems.push('实测 ' + info.dpi + ' dpi > 上限 ' + S.max_dpi + ' dpi');
    if (S.min_width_px && info.pxW && info.pxW < S.min_width_px) problems.push('宽 ' + info.pxW + ' px < 最小 ' + S.min_width_px + ' px');
    if (S.max_width_px && info.pxW && info.pxW > S.max_width_px) problems.push('宽 ' + info.pxW + ' px > 最大 ' + S.max_width_px + ' px');
    if (S.max_height_px && info.pxH && info.pxH > S.max_height_px) problems.push('高 ' + info.pxH + ' px > 最大 ' + S.max_height_px + ' px');
    if ((S.min_width_px || S.max_width_px || S.max_height_px) && (!info.pxW || !info.pxH)) unknowns.push('取不到像素尺寸 ⇒ px 上下限不可判（**未检查 ≠ 通过**）');
    const effDpi = info.dpi || S.min_dpi || null;
    if (info.pxW && effDpi) {
      const mm = Math.round(info.pxW / effDpi * 25.4 * 10) / 10;
      if (S.min_width_mm && mm < S.min_width_mm) problems.push('宽 ' + mm + ' mm < 最小 ' + S.min_width_mm + ' mm（按 ' + effDpi + ' dpi 折算）');
      if (S.max_width_mm && mm > S.max_width_mm) problems.push('宽 ' + mm + ' mm > 最大 ' + S.max_width_mm + ' mm（按 ' + effDpi + ' dpi 折算）');
      per.push({ file: f.rel, fmt, pxW: info.pxW, pxH: info.pxH, dpi: info.dpi, mmW: mm, kb: Math.round(info.bytes / 1024), verdict: problems.length ? 'fail' : (unknowns.length ? 'unknown' : 'ok'), why: problems.concat(unknowns).join('；') || (info.note || '') });
    } else {
      if (S.min_width_mm || S.max_width_mm) unknowns.push('缺像素尺寸或分辨率 ⇒ 宽不可判');
      per.push({ file: f.rel, fmt, pxW: info.pxW, pxH: info.pxH, dpi: info.dpi, mmW: null, kb: Math.round(info.bytes / 1024), verdict: problems.length ? 'fail' : (unknowns.length ? 'unknown' : 'ok'), why: problems.concat(unknowns).join('；') || (info.note || '') });
    }
    if (S.min_file_kb) {
      const kb = Math.round(info.bytes / 1024);
      if (kb < S.min_file_kb) { per[per.length - 1].verdict = 'fail'; per[per.length - 1].why += (per[per.length - 1].why ? '；' : '') + '体积 ' + kb + ' KB < 最小 ' + S.min_file_kb + ' KB'; }
    }
    if (S.max_file_kb) {
      const kb = Math.round(info.bytes / 1024);
      if (kb > S.max_file_kb) { per[per.length - 1].verdict = 'fail'; per[per.length - 1].why += (per[per.length - 1].why ? '；' : '') + '体积 ' + kb + ' KB > 上限 ' + S.max_file_kb + ' KB'; }
    }
  }
  const bad = per.filter((x) => x.verdict === 'fail');
  const unk = per.filter((x) => x.verdict === 'unknown');
  const ok = per.filter((x) => x.verdict === 'ok');
  const detail = per.map((x) => `${x.file}[${x.verdict}${x.dpi ? ' ' + x.dpi + 'dpi' : ''}${x.mmW ? ' ' + x.mmW + 'mm' : ''}${x.kb ? ' ' + x.kb + 'KB' : ''}${x.why ? '：' + x.why : ''}]`).join(' · ');
  return { per, bad, unk, ok, detail };
}

/* 图表编号 ↔ 正文引用 双向一致性（v3.2.27）
 *  为什么：**正文引用了不存在的图表**（"as shown in Table 3"，可文中只有 2 张表）是审稿人一眼就看到的硬伤；
 *  反向的"图从未被引用"、以及编号跳号（图 1、图 3）同样该报。三类都可机械判定。
 *  判据：**声明** = 行首图题（`**Figure 1.**` / `Fig. 1:` / `图 1 `）；**引用** = 正文里出现的 `Figure/Fig./Table/图/表 N`（图题行自身不算引用）。 */
/* 修正（v3.2.27 真稿实测抓到的假阳性）：A 稿图题写成引用块形态
   > **Figure 1.** Reference-discharge SOH trajectories ...
   原正则要求行首即标签 ⇒ 认不出图题 ⇒ 把 4 张确实内嵌的图全判成"引用了不存在的图"。
   现允许 > 与列表前缀，并在正则里直接捕获图/表字样（原先事后 strip 判类型，遇 > 前缀会把图误判成表）。 */
const CAPTION_RE = /^\s*(?:>\s*)?(?:[-*+]\s+)?(?:\*\*|__)?\s*(Figure|Fig\.?|Table|表|图)\s*(\d+)\s*(?:\*\*|__)?\s*[.:：]\s*(\S.*)$/i;
function figureTableXref(draft) {
  const lines = String(draft || '').replace(/\r\n?/g, '\n').split('\n');
  const declared = { fig: new Set(), tab: new Set() };
  const declLines = new Set();
  lines.forEach((L, i) => {
    const m = CAPTION_RE.exec(L);
    if (!m) return;
    const kind = /^(?:Figure|Fig\.?|图)$/i.test(m[1]) ? 'fig' : 'tab';   // 用捕获到的字样判类型
    declared[kind].add(Number(m[2]));
    declLines.add(i);
  });
  const referenced = { fig: new Set(), tab: new Set() };
  lines.forEach((L, i) => {
    if (declLines.has(i)) return;                     // 图题行不算"引用"
    if (/^\s*!\[/.test(L)) return;                     // 内嵌图片标记行也不算引用
    for (const m of L.matchAll(/\b(?:Figure|Fig\.?)\s*(\d+)/gi)) referenced.fig.add(Number(m[1]));
    for (const m of L.matchAll(/\bTables?\s*(\d+)/gi)) referenced.tab.add(Number(m[1]));
    for (const m of L.matchAll(/图\s*(\d+)/g)) referenced.fig.add(Number(m[1]));
    for (const m of L.matchAll(/表\s*(\d+)/g)) referenced.tab.add(Number(m[1]));
  });
  return { declared, referenced, declLines };
}
function contiguousGaps(set) {
  const a = Array.from(set).sort((x, y) => x - y);
  const gaps = [];
  for (let v = 1; v <= (a[a.length - 1] || 0); v++) if (!set.has(v)) gaps.push(v);
  return gaps;
}

/* C14f 书写顺序（中文刊特有 · 逐刊可能不同 ⇒ 契约声明，机器核**相对次序**）
   判据：对声明的每个标记，找**首个非待办行**且该行"以标记开头"（允许井号、粗体星号、短横等项目符号前缀，后接可选冒号），
        然后要求这些标记的行号**非严格降序**（允许同一行，如"中图分类号：… 文献标志码：A"）。
   ★ 不许静默通过：找到的标记**少于 min_found（默认 4）** ⇒ 判失败，说清"标记太少、核不了顺序"。*/
if (Array.isArray(S.writing_order) && S.writing_order.length) {
  const W = S.writing_order.map((x) => (typeof x === 'string' ? { name: x, aliases: [x] } : x));
  const minFound = S.writing_order_min_found || 4;
  const lineNoOf = (alias) => {
    const alt = '(?:' + alias.map((a) => String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
    const re = new RegExp('^\\s*(?:[#>*\\-]+\\s*)?(?:\\*\\*)?\\s*(' + alt + ')\\s*(?:\\*\\*)?', 'i');
    const lines = noMeta.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = re.exec(lines[i]);
      if (!m || TODO_ISH.test(lines[i])) continue;
      /* ★ 标记后**必须是冒号或行尾**，否则那是"更长的词"而不是该标记：
         例：页脚的「作者简介：…」不得被当成前置项「作者」（本检查首版就因此误判倒置）。 */
      const rest = lines[i].slice(m[0].length);
      if (/^\s*[:：]/.test(rest) || rest.trim() === '') return i + 1;
    }
    return 0;
  };
  const found = [];
  for (const w of W) {
    const ln = lineNoOf(w.aliases && w.aliases.length ? w.aliases : [w.name]);
    if (ln) found.push({ name: w.name, line: ln });
  }
  if (found.length < minFound) {
    check('writing_order', 'FAIL', false,
      `只找到 ${found.length} 个书写顺序标记（需 ≥${minFound} 才能核顺序）：` + (found.map((f) => f.name + '@L' + f.line).join(' · ') || '（一个都没有）')
      + '　⇒ 标记太少＝核不了顺序，**不得当成通过**（中文刊前置项按"标记：内容"行写，如"中图分类号：TM912"）');
  } else {
    const inv = [];
    for (let i = 1; i < found.length; i++) {
      if (found[i].line < found[i - 1].line) inv.push(`${found[i - 1].name}(L${found[i - 1].line}) 出现在 ${found[i].name}(L${found[i].line}) **之后**`);
    }
    check('writing_order', 'FAIL', inv.length === 0,
      inv.length === 0 ? `书写顺序正确（${found.length} 个标记：` + found.map((f) => f.name + '@L' + f.line).join(' → ') + '）'
        : '书写顺序倒置：' + inv.join('；'));
  }
}

/* C14g 图件规格（契约 limits.figure_spec）——图件是**二进制**，按其头部读真实分辨率/尺寸；
   没有图件却声明了规格 ⇒ 判失败（不得当通过）；读不出分辨率 ⇒ 记 unknown 并在 detail 里明说。 */
/* ★ v3.2.42：触发条件改为**归一后非空** —— 否则「用扁平写法声明的图件规格」整块被跳过（known_gap 的本体）。 */
const FIGSPEC = figureSpecFromLimits(L);
if (Object.keys(FIGSPEC).length && pkg.exists) {
  const IMG = /\.(png|jpe?g|tif?f|eps|svg|gif|bmp)$/i;
  const imgs = pkg.files.filter((f) => IMG.test(f));
  if (!imgs.length) {
    check('figure_spec', 'FAIL', false, '契约声明了图件规格，但投稿包里**没有找到任何图件文件**（没有图件 ≠ 规格合规）');
  } else {
    const files = imgs.map((rel) => ({ rel, abs: path.join(pkg.dir, rel) }));
    const r = figureSpecJudge(files, FIGSPEC);
    const level = r.bad.length ? 'FAIL' : (r.unk.length ? 'WARN' : 'PASS');
    check('figure_spec', level, level === 'PASS',
      `图件 ${imgs.length} 张：合规 ${r.ok.length} · 不合规 ${r.bad.length} · 核不了 ${r.unk.length}　` + r.detail);
  }
}

/* ★ v3.2.42：**补充材料体积上限**（PLOS `si_file_max_mb`）—— 与图件体积同一类问题：
   超过上限会被投稿系统直接拒收，而此前没有任何门在看它。 */
if (typeof L.si_file_max_mb === 'number') {
  if (!pkg.exists) {
    check('si_file_max_mb', 'WARN', false, '未给 --package ⇒ **未检查**（未检查 ≠ 通过）：契约要求单个补充材料 ≤ ' + L.si_file_max_mb + ' MB');
  } else {
    const SI = /(suppl|supplement|supporting|^s\d|SI[-_])/i;
    const si = pkg.files.filter((f) => SI.test(path.basename(f)));
    const over = si.map((rel) => ({ rel, mb: (() => { try { return fs.statSync(path.join(pkg.dir, rel)).size / 1048576; } catch { return 0; } })() }))
      .filter((x) => x.mb > L.si_file_max_mb).map((x) => x.rel + '（' + Math.round(x.mb * 100) / 100 + ' MB）');
    check('si_file_max_mb', 'FAIL', over.length === 0,
      '补充材料 ' + si.length + ' 件 / 上限 ' + L.si_file_max_mb + ' MB' + (over.length ? '　超限：' + over.join(' · ') : '　（全部在上限内）'));
  }
}

/* ★ v3.2.42：**图注词数上限**（PLOS `figure_caption_max_words`）。图注从正文里数（四种图注约定都认）。 */
if (typeof L.figure_caption_max_words === 'number') {
  const capRe = /^(?:#{2,4}\s*|>\s*\*\*|\*\*|!\[[^\]]*\]\()?\s*(?:Figure|Fig\.?)\s*(\d+)[.):\s]/gim;
  const caps = [];
  const lines = noMeta.split('\n');
  lines.forEach((ln, i) => {
    if (!capRe.test(ln)) return;
    /* 图注正文＝该行去掉标记后的文字；并接上紧随其后的续行（到空行为止）。 */
    let t = ln.replace(/^(?:#{2,4}\s*|>\s*\*\*|\*\*|!\[[^\]]*\]\()?\s*/, '').replace(/\*\*/g, '');
    for (let k = i + 1; k < lines.length && lines[k].trim() && !/^(?:#{1,6}\s|\*\*Figure|>\s*\*\*Figure)/i.test(lines[k]); k++) t += ' ' + lines[k].trim();
    caps.push({ n: (ln.match(/Figure\s*(\d+)/i) || [])[1] || '?', words: t.trim().split(/\s+/).filter(Boolean).length, text: t.trim() });
  });
  const overCap = caps.filter((c) => c.words > L.figure_caption_max_words);
  check('figure_caption_max_words', 'FAIL', overCap.length === 0,
    caps.length ? ('图注 ' + caps.length + ' 条 / 每条上限 ' + L.figure_caption_max_words + ' 词' + (overCap.length ? '　超限：' + overCap.map((c) => 'Figure ' + c.n + '（' + c.words + ' 词）').join(' · ') : '　（全部在上限内）'))
      : '未解析到图注（**取不到 ≠ 通过**：请确认图注写法）');
}

/* C14i 投稿包卫生（v3.2.28）
 *  为什么：**投稿包里混进内部产物**是很容易发生、又很不体面的失误——工作目录里同时躺着
 *  校验报告、脚本、日志、旧版文件（如 `_契约检查报告-*.md`、`*-stale-*.docx`、`_*.py`、`*.log`），
 *  一打包就全投给编辑部。反向也要查：契约声明的**必备件**（如独立图件、投稿信）是否在场。
 *  判据全部作用在**包内相对路径**上，逐条给出文件名。 */
const HYGIENE_FORBID = [
  { re: /(^|\/)_[^/]*$/, why: '下划线前缀的内部产物（校验报告/脚本/工作单等）' },
  { re: /(^|\/)anchors-.*\.json$/i, why: '锚点表等工具中间产物' },
  { re: /-OA报告|-report\.md$|\.bak(?:-|$)|(^|\/)[^/]*\.log$/i, why: '工具报告/备份/日志' },
  /* ★ 只认**明确危险**的陈旧/备份标记。首版把 draft 也算进来 ⇒ 正常命名的 draft.md
     被误判为「不该进包」，还把门里一条旧夹具撞红（假阳性）。tmp/temp 保留，但要求后随分隔符或数字，
     所以 temperature_analysis.csv 这类正常名不会命中。 */
  { re: /(?:^|[-_.])(?:stale|old|backup|copy|tmp|temp|旧版|备份)(?:[-_.]|\d|$)/i, why: '陈旧/旧版/备份/临时标记（上传错文件的高危来源）' },
  { re: /^~\$|Thumbs\.db$|\.DS_Store$/, why: '办公软件临时文件/系统垃圾' },
  { re: /(^|\/)(?:_refs|_rollback[^/]*|sandbox)(\/|$)/i, why: '工作用目录（不应进投稿包）' },
];
function hygieneJudge(files, opt) {
  const S = opt || {};
  const forbid = Array.isArray(S.forbid_patterns) && S.forbid_patterns.length
    ? S.forbid_patterns.map((p) => ({ re: new RegExp(p, 'i'), why: '契约自定义禁用模式' })) : HYGIENE_FORBID;
  const allow = (S.allow_patterns || []).map((p) => new RegExp(p, 'i'));
  const bad = [];
  for (const f of files) {
    const rel = String(f).replace(/\\/g, '/');
    if (allow.some((r) => r.test(rel))) continue;
    for (const p of forbid) if (p.re.test(rel)) { bad.push({ file: rel, why: p.why }); break; }
  }
  const missing = [];
  for (const g of (S.required_globs || [])) {
    const re = new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    if (!files.some((f) => re.test(String(f).replace(/\\/g, '/')))) missing.push(g);
  }
  return { bad, missing };
}

/* C14j 投稿包卫生（给了 --package 才跑；契约 structure.package_hygiene 可定制/关闭） */
if (pkg.exists && S.package_hygiene !== false) {
  const h = hygieneJudge(pkg.files, S.package_hygiene || {});
  const level = (h.bad.length || h.missing.length) ? 'FAIL' : 'PASS';
  check('package_hygiene', level, level === 'PASS',
    '包内文件 ' + pkg.files.length + ' 个'
    + (h.bad.length ? ' · **不该出现在投稿包里的 ' + h.bad.length + ' 个**：' + h.bad.slice(0, 12).map((x) => x.file + '（' + x.why + '）').join('；') + (h.bad.length > 12 ? ' 等' : '') : '')
    + (h.missing.length ? ' · **缺必备件**：' + h.missing.join('、') : '')
    + (!h.bad.length && !h.missing.length ? ' · 无内部产物、必备件齐备' : ''));
}

/* C14h 图表编号 ↔ 正文引用（契约 structure.figure_table_xref；不给声明时默认执行） */
{
  const opt = (S.figure_table_xref === false) ? null : (S.figure_table_xref || {});
  if (opt) {
    const x = figureTableXref(noMeta);
    const kindName = { fig: '图', tab: '表' };
    const dangling = []; const orphan = []; const gaps = [];
    for (const k of ['fig', 'tab']) {
      for (const n of x.referenced[k]) if (!x.declared[k].has(n)) dangling.push(kindName[k] + ' ' + n);
      for (const n of x.declared[k]) if (!x.referenced[k].has(n)) orphan.push(kindName[k] + ' ' + n);
      /* 跳号**默认就该报**（图 1、图 3 而无图 2 几乎总是错的）；契约可用 `require_contiguous: false` 显式关掉 */
      if (opt.require_contiguous !== false) gaps.push(...contiguousGaps(x.declared[k]).map((g) => kindName[k] + ' ' + g));
    }
    const sum = (s, k) => (Array.from(s[k]).sort((a, b) => a - b).join(',') || '无');
    const detail = '声明：图[' + sum(x.declared, 'fig') + '] 表[' + sum(x.declared, 'tab') + '] · '
      + '正文引用：图[' + sum(x.referenced, 'fig') + '] 表[' + sum(x.referenced, 'tab') + ']'
      + (dangling.length ? ' · **引用了不存在的图表：' + dangling.join('、') + '**' : '')
      + (gaps.length ? ' · **编号跳号：' + gaps.join('、') + '**' : '')
      + (orphan.length ? ' · 声明但未被正文引用（' + (opt.orphan_level || 'WARN') + '）：' + orphan.join('、') : '');
    const level = dangling.length ? 'FAIL' : (gaps.length ? 'FAIL' : (orphan.length ? (opt.orphan_level || 'WARN') : 'PASS'));
    /* ★ 诚实计数：WARN 级必须 `ok:false`（这样它会显示成 ⚠ WARN 并计入 WARN 总数），
       而 PASS 才是 `ok:true`。首版把 WARN 也给了 ok:true ⇒ 报告里显示 ✓、也不计入 WARN。 */
    check('figure_table_xref', level, level === 'PASS', detail);
  }
}

/* C14e 契约要求的**节**必须都在场（声明段：Data Availability / CRediT / COI / Funding …）
   ★ 证据强度沿用"声明级"纪律：只认①标题行 或 ②文件名；**待办行不算**（[ ] / TODO / 待填…）。
   ★ 且支持逐刊差异：PLOS 把 Data Availability / CRediT 等收在**投稿系统**里 ⇒ 其契约 required_sections 为空数组，
     "空"是**显式声明**（配套 required_sections_note 写明原因），不是忘了写。 */
if (Array.isArray(S.required_sections) && S.required_sections.length) {
  const secs = S.required_sections.map((x) => (typeof x === 'string' ? { name: x, aliases: [x] } : x));
  const found = []; const missing = [];
  for (const s of secs) {
    const aliases = (s.aliases && s.aliases.length ? s.aliases : [s.name]);
    const alt = '(?:' + aliases.map((a) => String(a).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')';
    /* 每节可指定证据强度：heading（默认，须是标题行）或 line（普通行亦可，但仍**排除待办行**）——
       中文刊的「中图分类号 / 文献标志码」是正文前普通行，不是标题 ⇒ 一刀切认标题会造假阴性。 */
    const lineIn = (text, re) => {
      for (const line of String(text || '').split('\n')) {
        if (!re.test(line)) continue;
        if (TODO_ISH.test(line)) continue;
        return line.trim();
      }
      return '';
    };
    /* ★ v3.2.20：逐节可给 `patterns`（标准声明句），与标签/标题**同等强**；仍排除待办行。 */
    const pick = (s.evidence === 'line')
      ? ((text, re) => lineIn(text, re))
      : ((text, re) => declLineIn(text, re, s.patterns));
    const hitDraft = pick(noMeta, new RegExp(alt, 'i'));
    /* 文件名匹配：词间允许**任意单个非字母数字字符**（空格/连字符/下划线/点都算）。
       ★ 首版写成 [*_\- ]? 触发 Range out of order（`_`..空格 是非法区间）—— 真跑崩、而 25/25 自检没抓到，
         原因是夹具里没有"带 --package 的文件名匹配"这条支路 ⇒ 同一批已补上该支路夹具。 */
    const pkgAlt = aliases.map((a) => String(a).replace(/[^A-Za-z0-9\u4e00-\u9fff]+/g, '[^A-Za-z0-9\\u4e00-\\u9fff]?')).join('|');
    const fileHit = pkg.exists ? pkgFileHit(new RegExp('(?:' + pkgAlt + ')', 'i')) : '';
    const hitPkg = pkg.exists ? pick(pkgText, new RegExp(alt, 'i')) : '';
    if (hitDraft || fileHit || hitPkg) found.push(s.name + '（' + (hitDraft ? '稿件标题行' : (fileHit ? 'package:' + fileHit : 'package 标题行')) + '）');
    else missing.push(s.name);
  }
  check('required_sections', 'FAIL', missing.length === 0,
    missing.length === 0 ? `契约要求的 ${secs.length} 个节均在：` + found.join(' · ')
      : `缺 ${missing.length}/${secs.length} 个契约要求的节：` + missing.join('、') + (pkg.exists ? '' : '（**未给 --package，若声明在独立文件里会误报**）'));
}

/* C14d 契约要求的著录项必须在场（中文刊页脚常见：基金项目 / 作者简介 / 通信作者） */
if (Array.isArray(S.required_terms_present) && S.required_terms_present.length) {
  const miss = S.required_terms_present.filter((k) => noMeta.indexOf(k) < 0);
  check('required_terms_present', 'FAIL', miss.length === 0,
    miss.length === 0 ? `必备著录项 ${S.required_terms_present.length} 项均在（${S.required_terms_present.join('、')}）`
      : `缺必备著录项：${miss.join('、')}`);
}

/* C15 摘要内不得有编号引用（PLOS 明确） */
if (L.abstract_no_citations) {
  const abs = section(/^##+\s*Abstract\b/m, /^##+\s|^\*\*Keywords/m);
  const n = abs ? (abs.match(/\[\d+(?:\s*[-,–—]\s*\d+)*\]/g) || []).length : 0;
  check('abstract_no_citations', 'FAIL', !!abs && n === 0,
    abs === null ? '未找到 Abstract 节' : (n === 0 ? '摘要内无方括号编号引用（合规）' : `摘要内出现 ${n} 处编号引用（该刊要求摘要不含引用）`));
}

/* C16 图件不得内嵌正文（PLOS 要求图件单独文件上传） */
if (S.figures_separate_files) {
  const emb = noMeta.match(/!\[[^\]]*\]\([^)]*\)/g) || [];
  check('figures_not_embedded', 'FAIL', emb.length === 0,
    emb.length === 0 ? '正文未内嵌图片（合规）' : `正文内嵌 ${emb.length} 处图片；该刊要求图件作为独立文件上传（正文只留图题）`);
}

/* C17 资助信息不得写进正文（PLOS：只在投稿系统填） */
if (S.funding_in_manuscript === false) {
  const pos = []; const neg = [];
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/\b(funding|funded by|grant|award)\b/i.test(lines[i])) continue;
    const line = lines[i];
    /* 否定式（本研究未获资助 / no funding）≠ 资助披露：前者是"无"的声明，后者才是要移出正文的内容 */
    const isNeg = /(did not receive|no specific|no funding|not funded|无资助|未获资助|no external)/i.test(line);
    (isNeg ? neg : pos).push('L' + (i + 1) + ':' + line.trim().slice(0, 55));
  }
  if (pos.length) check('funding_not_in_manuscript', 'FAIL', false, `正文出现 ${pos.length} 处资助披露（该刊要求资助只在投稿系统里填）：` + pos.slice(0, 3).join(' | '));
  else if (neg.length) check('funding_not_in_manuscript', 'WARN', false, `正文仅出现"无资助"类陈述 ${neg.length} 处（非资助披露，但该刊要求资助信息含"无资助"也只在系统里填，建议移出正文）：` + neg.slice(0, 2).join(' | '));
  else check('funding_not_in_manuscript', 'FAIL', true, '正文未出现资助字样（合规）');
}

/* ---------- 输出 ---------- */
if (pkgDir) {
  check('package_dir', 'FAIL', pkg.exists, pkg.exists
    ? '投稿包目录可读：扫描到 ' + pkg.files.length + ' 个文件（文本 ' + pkg.texts.length + ' 个' + (pkg.unreadable.length ? '，不可读 ' + pkg.unreadable.length + ' 个' : '') + '）'
    : '给的 --package 目录不存在或不是目录：' + pkgDir + ' ⇒ 包级要件无法判定（不得当了通过）');
}
/* 契约自身状态：标了 needs_official_recheck 的契约**不得静默通过**（数字未经官网重核是软状态，必须每次显形） */
if (contract.needs_official_recheck === true) {
  check('contract_recheck_required', 'WARN', false,
    '本契约标了 needs_official_recheck=true ⇒ 数字来自归档二手口径、**尚未经官网重核**（' + String(contract.provenance_level || '来源等级未标') + '）；使用前须人工登录官网核对并更新 verified_at。');
}
/* C18 契约声明的可机检项必须**真的有检查在跑**（登记过 ≠ 可机检）。
   ★ 必须放在**所有检查之后**：首版把它放在 package_dir 之前 ⇒ 那个检查是在对账之后才追加的，
     对账看不见它 ⇒ 假报"package_dir 没执行"（本次由机器生成的报告第一时间暴露）。
     教训与上一轮同族：**顺序也是一种分支**，夹具要覆盖"带 --package + 对账"的组合。 */
const declaredIds = Array.isArray(contract.checkable_ids) ? contract.checkable_ids : [];
if (declaredIds.length) {
  const ranIds = new Set(results.map((r) => r.id));
  const notRun = declaredIds.filter((id) => id !== 'checkable_ids_covered' && !ranIds.has(id));
  check('checkable_ids_covered', 'FAIL', notRun.length === 0,
    notRun.length === 0 ? `契约声明的 ${declaredIds.length} 项可机检均已执行`
      : `契约声明了 ${declaredIds.length} 项，其中 ${notRun.length} 项**本门没执行**（登记过≠可机检）：` + notRun.join(', '));
}
const fails = results.filter(r => !r.ok && r.level === 'FAIL');
const warns = results.filter(r => !r.ok && r.level === 'WARN');
/* ★ 未核实项：契约 unverified 列出的项必须**显形跳过**，绝不计入通过；无可机检项时必须说明本次运行不构成通过（判据纪律） */
const unverified = Array.isArray(contract.unverified) ? contract.unverified : [];
const facts = contract.verified_facts || null;

if (asJson) {
  console.log(JSON.stringify({
    journal: contract.journal, contract_verified_at: contract.verified_at, contract_verified_from: contract.verified_from,
    draft: path.basename(draftPath),
    mode: pkg.exists ? 'package' : 'single',
    package_dir: pkg.dir || null,
    package_files_scanned: pkg.files.length,
    passed: results.filter(r => r.ok).length, failed: fails.length, warned: warns.length,
    checkable_items: results.length, unverified: unverified, verified_facts: facts, results: results
  }, null, 2));
} else {
  console.log('════ 期刊契约检查（' + contract.journal + ' · 契约核于 ' + contract.verified_at + '）════');
  console.log('  范围：' + (pkg.exists ? '包级模式（稿件 + 投稿包目录，扫描 ' + pkg.files.length + ' 个文件）' : '单文件模式（只扫稿件）') + (pkg.exists ? '' : '  ⚠ 包级要件（Highlights / CRediT / 声明段）若放在独立文件里会被误报缺失 ⇒ 建议加 --package <投稿包目录>'));
  for (const r of results) console.log(`${r.ok ? '  ✓' : (r.level === 'FAIL' ? '  ✗' : '  ⚠')} [${r.id}] ${r.detail}`);
  console.log(`\n  通过 ${results.filter(r => r.ok).length} · FAIL ${fails.length} · WARN ${warns.length}`);
/* ★ v3.2.30：给聚合层一个**机器可读**的提醒通道。本门退出码只有 0/1/2（1＝存在 FAIL），
   提醒不体现在退出码里 ⇒ 必须另行示形；否则聚合层要么看不见 WARN、要么把 FAIL 当 WARN 遮掉。 */
console.log('WARN_COUNT=' + warns.length + ' FAIL_COUNT=' + fails.length);
  if (fails.length) console.log('  ⇒ 提交前必须修掉全部 FAIL 项。');
  if (!results.length) console.log('  ★ 本契约**没有可机检项** ⇒ 本次运行不构成对任何一项的通过（未被检查 ≠ 通过）。');
  if (facts) {
    console.log('  ── 已核实事实（来源见契约 verified_from）──');
    for (const [k, v] of Object.entries(facts)) console.log('     · ' + k + ': ' + (v && typeof v === 'object' ? JSON.stringify(v) : String(v)));
  }
  if (unverified.length) {
    console.log('  ⚠ 未核实项 ' + unverified.length + ' 条（本机取不到，**不得视为通过**，须由人核对）：');
    for (const u of unverified) console.log('     · ' + u);
  }
}
/* ── --report：机器生成的检查表（替代手抄读数） ── */
if (reportPath) {
  const L2 = [];
  L2.push('# 契约检查报告 · ' + contract.journal);
  L2.push('');
  L2.push('- 生成：**由 `_journal-contract.cjs` 自动生成，勿手改**（改动请改契约或稿件后重跑）');
  L2.push('- 稿件：`' + path.basename(draftPath) + '`');
  L2.push('- 契约：`' + path.basename(contractPath) + '` · 契约核于 **' + contract.verified_at + '**' + (contract.provenance_level ? ' · 来源等级 **' + contract.provenance_level + '**' : ''));
  if (pkg.exists) L2.push('- 范围：包级模式（扫描 ' + pkg.files.length + ' 个文件）');
  else L2.push('- 范围：单文件模式（**包级要件若在独立文件里会被误报** ⇒ 建议加 `--package`）');
  L2.push('- 结论：通过 **' + results.filter((r) => r.ok).length + '** · FAIL **' + fails.length + '** · WARN **' + warns.length + '**');
  L2.push('');
  L2.push('| 检查 | 实测 / 依据 | 判定 | 证据 |');
  L2.push('|---|---|---|---|');
  for (const r of results) {
    const mark = r.ok ? '✓' : (r.level === 'FAIL' ? '**✗ FAIL**' : '⚠ WARN');
    L2.push('| `' + r.id + '` | ' + String(r.detail).replace(/\|/g, '\\|') + ' | ' + mark + ' | ' + (r.evidence || (r.ok ? '—' : '')) + ' |');
  }
  if (unverified.length) { L2.push(''); L2.push('## 未核实项（契约声明本机取不到；**不得视为通过**）'); for (const u of unverified) L2.push('- ' + u); }
  const ho = Array.isArray(contract.human_only) ? contract.human_only : [];
  if (ho.length) { L2.push(''); L2.push('## 人工边界（机器不判）'); for (const u of ho) L2.push('- ' + u); }
  if (contract.needs_official_recheck === true) { L2.push(''); L2.push('> ⚠ **本契约标 `needs_official_recheck`**：数字来自归档二手口径，尚未经官网重核（须人工登录官网核对并更新 `verified_at`）。'); }
  /* ★ 2026-10-16（与 paper-studio v3.2.34 **同格式**）：**报告运行指纹** —— 报告要能回答「属于哪一次运行」。
     同一格式（`<!-- PROVENANCE: {...} -->`）⇒ paper-studio 的 `report-check` / `reports --scan` 能直接核这份报告。
     `version` 用**门脚本自身的内容摘要**：这样「凭什么判」也能追到具体是哪一版门（比手写版本号更难撒谎）。 */
  {
    const crypto = require('crypto');
    const sha12 = (b) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);
    const dirDigest = (p) => {
      const rows = [];
      const walk = (d, pre) => {
        for (const name of fs.readdirSync(d).sort()) {
          const full = path.join(d, name);
          const s = fs.statSync(full);
          if (s.isDirectory()) { rows.push(pre + name + '/'); walk(full, pre + name + '/'); }
          else rows.push(pre + name + ' ' + s.size + ' ' + sha12(fs.readFileSync(full)));
        }
      };
      walk(p, '');
      return { kind: 'dir', sha12: sha12(rows.join('\n')), n: rows.length };
    };
    const inputs = [];
    for (const [role, v] of [['draft', draftPath], ['contract', contractPath], ['package', arg('package')]]) {
      if (!v) continue;
      const abs = path.resolve(v);
      if (!fs.existsSync(abs)) { inputs.push({ role, path: abs, missing: true }); continue; }
      const st = fs.statSync(abs);
      const d2 = st.isDirectory() ? dirDigest(abs) : { kind: 'file', sha12: sha12(fs.readFileSync(abs)), n: st.size };
      inputs.push({ role, path: abs, kind: d2.kind, sha12: d2.sha12, n: d2.n });
    }
    L2.push('');
    L2.push('<!-- PROVENANCE: ' + JSON.stringify({ tool: 'journal-contract', version: 'sha-' + sha12(fs.readFileSync(__filename)), at: new Date().toISOString(), inputs }) + ' -->');
  }
  try { fs.writeFileSync(reportPath, L2.join('\n') + '\n', 'utf8'); console.log('\n  报告已写入：' + reportPath + '（' + results.length + ' 项）'); }
  catch (e) { console.error('报告写入失败（不得当成已出报告）：' + String((e && e.message) || e)); process.exit(2); }
}
process.exit(fails.length ? 1 : 0);
