#!/usr/bin/env node
/**
 * talk —— 讲授/呈现类（吸收自 lifecycle-skills 的 make-slides / write-talk-script 等技能，Apache-2.0）
 *
 * ★ 吸收说明（必须留痕）：**规则与流程**吸收自第三方技能包 `lifecycle-skills`（Apache-2.0）：
 *   · make-slides：槽位→预算（~1 张/内容分钟，硬上限 1.25×）· problem-first 分节配比 ·
 *     claim 式标题（禁止 "Background/方法" 这类非断言标题）· 单页 >100 词即"文档不是幻灯片" ·
 *     要点过载 · 图片缺失/不可渲染 · 备份页不计预算 · **绝不臆测槽位时长**、绝不编数字
 *   · write-talk-script：按语速把口播词数摊到每页（中文按字/分，英文按词/分）
 *   · rehearse-qa / simulate-reviewers / triage-reviews：留待后续轮（本文件先落 budget/script/lint）
 *   **实现为本仓自有 Node 纯函数 + 夹具，未复制其任何代码**；许可与来源见 references/external-adoptions.md。
 *
 * 用法：
 *   node bin/talk.cjs budget --minutes <内容分钟> [--qa <问答分钟>] [--format auto|full|lightning] [--json]
 *   node bin/talk.cjs script --minutes <内容分钟> [--deck <幻灯片文件>] [--lang zh|en] [--json]
 *   node bin/talk.cjs lint <幻灯片文件> --minutes <内容分钟> [--lang zh|en] [--strict] [--json]
 *   node bin/talk.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ── 语速与页时长默认值（与真源 forms.budget 同源；调用方可传入覆盖）── */
const DEFAULT_BUDGET = { speech_rate: { zh: [180, 220], en: [120, 150] }, seconds_per_slide: 50 };

const SHAPES = {
  full: [
    { id: 'hook', label: '开场：问题为什么重要', share: 0.10 },
    { id: 'gap', label: '既有做法与缺口', share: 0.15 },
    { id: 'method', label: '方法（一条主张 + 一张图）', share: 0.25 },
    { id: 'results', label: '结果（主图 + 关键数字）', share: 0.35 },
    { id: 'conclusion', label: '结论与展望', share: 0.10 },
    { id: 'thanks', label: '致谢与联系', share: 0.05 },
  ],
  lightning: [
    { id: 'hook', label: '开场：问题一句话', share: 0.20 },
    { id: 'method', label: '方法一句话 + 一张图', share: 0.20 },
    { id: 'results', label: '主结果（图 + 数字）', share: 0.50 },
    { id: 'conclusion', label: '结论一句话', share: 0.10 },
  ],
};

function fail(msg, code) { const e = new Error(msg); e.code = code || 'TALK_PRECONDITION'; return e; }

/** 槽位→预算。★ 前提：minutes 必须由调用方给出（**不许从记忆或场所档案里臆测**） */
function talkBudget(minutes, opts) {
  const o = opts || {};
  const qa = Number(o.qa) > 0 ? Number(o.qa) : 0;
  const m = Number(minutes);
  if (!(m > 0)) throw fail('前提层失败：talk budget 需要 --minutes <内容分钟>（不许臆测槽位时长；场所档案不编码槽位）', 'NO_MINUTES');
  const shape = (o.format && o.format !== 'auto') ? o.format : (m <= 7 ? 'lightning' : 'full');
  const spec = SHAPES[shape] || SHAPES.full;
  const target = Math.max(1, Math.round(m * 1.0));
  const hardMax = Math.ceil(m * 1.25);
  const sections = spec.map((s) => ({
    id: s.id, label: s.label, share: s.share,
    minutes: Math.round(m * s.share * 10) / 10,
    slides: Math.max(0, Math.round(target * s.share)),
  }));
  const shareSum = Math.round(spec.reduce((a, s) => a + s.share, 0) * 100) / 100;
  const slideSum = sections.reduce((a, s) => a + s.slides, 0);
  const notes = [
    '内容页目标 ≈ ' + target + ' 张（≈1 张/内容分钟）；**硬上限 ' + hardMax + ' 张**（1.25×）——超了必须删并页，不许靠讲快。',
    '备份页（Backup/备份）不占预算，放最后。',
    '每页标题必须是**断言**（"结果"、"背景"这类非断言标题会被 lint 判风险）。',
    '数字与图只能来自论文或作者本人；未定结果留 [RESULT] 占位并在交付时点明。',
    qa > 0 ? ('问答 ' + qa + ' 分钟**另计**，不要算进内容页预算（合计槽位 = ' + (Math.round((m + qa) * 10) / 10) + ' 分钟）。') : '未给问答时长 ⇒ 合计槽位以内容分钟计。',
  ];
  if (shape === 'lightning') notes.push('闪电报告形态（≤7 分钟）：只留"问题—一句方法—主结果—结论"。');
  return {
    shape, speaking_minutes: m, qa_minutes: qa, total_minutes: Math.round((m + qa) * 10) / 10,
    content_slides_target: target, hard_max_slides: hardMax,
    sections, shares_sum: shareSum, slides_sum: slideSum, notes,
  };
}

/* ── 解析幻灯片（Marp: --- 分隔；Beamer: \begin{frame}…\end{frame}）── */
function parseDeck(text, opts) {
  const o = opts || {};
  const isBeamer = /\\begin\{frame\}/.test(text) || /\\documentclass/.test(text);
  let slides = [];
  if (isBeamer) {
    const re = /\\begin\{frame\}([\s\S]*?)\\end\{frame\}/g;
    let m2;
    while ((m2 = re.exec(text)) !== null) slides.push(m2[1]);
  } else {
    /* Marp：先**剥掉开头的 front matter**（`---\nkey: value\n---`），否则那一段会被当成第一页
       （2026-10-17 实测踩到：夹具恰好把"含 front matter 的页数"写成期望值 ⇒ 固化了一个 bug）。 */
    let body = text.replace(/^\uFEFF?/, '');
    if (/^\s*---\s*\r?\n/.test(body)) {
      const m0 = body.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
      if (m0) body = body.slice(m0[0].length);
    }
    const parts = body.split(/^\s*---\s*$/m);
    slides = parts.filter((p) => p && p.trim());
    if (slides.length === 0 && body.trim()) slides = [body];
  }
  const isMarp = !isBeamer;
  const out = slides.map((raw, i) => {
    const lines = raw.split(/\r?\n/);
    const titleLine = lines.find((l) => /^\s{0,3}(#{1,6})\s+\S/.test(l)) || lines.find((l) => /\\frametitle\{/.test(l)) || '';
    const title = titleLine.replace(/^\s{0,3}#{1,6}\s+/, '').replace(/\\frametitle\{|\}/g, '').trim();
    const words = (raw.replace(/```[\s\S]*?```/g, ' ').match(/[\u4e00-\u9fa5]|[A-Za-z][A-Za-z'\-]*/g) || []).length;
    const bullets = lines.filter((l) => /^\s*([-*+]|\d+\.)\s+\S/.test(l)).length;
    const imgs = [];
    const re2 = /!\[[^\]]*\]\(([^)\s]+)/g; let m3;
    while ((m3 = re2.exec(raw)) !== null) imgs.push(m3[1]);
    const isBackup = /^(backup|备份)\b/i.test(title);
    return { index: i + 1, title, words, bullets, images: imgs, is_backup: isBackup };
  });
  return { kind: isBeamer ? 'beamer' : (isMarp ? 'marp' : 'unknown'), slides: out };
}

const GENERIC_TITLE = /^(background|introduction|intro|motivation|method|methods|methodology|approach|results|result|experiment|experiments|evaluation|discussion|conclusion|conclusions|outline|agenda|related\s*work|summary|thanks|q\s*&\s*a|背景|介绍|引言|动机|方法|结果|实验|讨论|结论|展望|目录|提纲|致谢|相关工作|总结)$/i;

/** 幻灯片 lint：pacing / 单页过载 / 要点过载 / 非断言标题 / 图片缺失 / Marp 不能渲染 PDF 图 */
function talkLint(text, opts) {
  const o = opts || {};
  const m = Number(o.minutes);
  if (!(m > 0)) throw fail('前提层失败：talk lint 需要 --minutes <内容分钟>（pacing 判据没有槽位就无法成立）', 'NO_MINUTES');
  const deck = parseDeck(text, o);
  const budget = talkBudget(m, { format: o.format });
  const content = deck.slides.filter((s) => !s.is_backup);
  const backup = deck.slides.filter((s) => s.is_backup);
  const findings = [];
  const push = (level, check, slide, msg) => findings.push({ level, check, slide: slide || null, msg });
  const baseDir = o.baseDir || '';
  for (const s of content) {
    if (s.words > 100) push('RISK', 'overfull', s.index, '单页 ' + s.words + ' 词 > 100 ⇒ 这是文档不是幻灯片（拆页或改成图/一句数字）');
    else if (s.words > 60) push('WARN', 'dense', s.index, '单页 ' + s.words + ' 词偏密（>60；对齐 deck_lint 的 wordy 口径、由 INFO 升为 WARN）');
    if (s.bullets > 6) push('WARN', 'bullet-overload', s.index, '要点 ' + s.bullets + ' 条 > 6 ⇒ 观众读不完（合并或改图）');
    if (s.title && GENERIC_TITLE.test(s.title)) push('WARN', 'generic-title', s.index, '标题「' + s.title + '」不是断言 ⇒ 改成一句话主张');
    if (!s.title) push('INFO', 'no-title', s.index, '该页没有标题行 ⇒ 无法判 claim；补一句主张作标题');
    for (const img of s.images) {
      if (deck.kind === 'marp' && /\.pdf$/i.test(img)) push('RISK', 'marp-pdf-image', s.index, 'Marp 不能渲染 PDF 图：' + img + '（先转 PNG/SVG）');
      const p = path.isAbsolute(img) ? img : path.join(baseDir, img);
      if (baseDir && !fs.existsSync(p)) push('RISK', 'missing-image', s.index, '图片不存在：' + img);
    }
  }
  /* ── 以下三项为 2026-10-17 Task B 对拍后补齐（对面 deck_lint.py 有、我方缺）── */
  // no-marp-header：markdown deck 没有 marp: true 前置元数据 ⇒ Marp 工具链会当普通 markdown
  if (deck.kind === 'marp' && !/^---[\s\S]*?marp\s*:\s*true/im.test(text)) {
    push('WARN', 'no-marp-header', null, 'markdown deck 缺 marp: true 前置元数据 ⇒ Marp 工具链会当普通 markdown 处理');
  }
  // tiny-font：Beamer 正文用 \tiny/\scriptsize ⇒ 投影不可读
  if (deck.kind === 'beamer' && /\\(tiny|scriptsize)\b/.test(text)) {
    push('WARN', 'tiny-font', null, 'Beamer 正文出现 \\tiny/\\scriptsize ⇒ 投影时不可读');
  }
  // aspect-ratio：Beamer 未设 16:9 ⇒ 多数会场是宽屏
  if (deck.kind === 'beamer' && !/aspectratio\s*=\s*169/.test(text)) {
    push('INFO', 'aspect-ratio', null, 'Beamer 未设 aspectratio=169 ⇒ 多数会议室为 16:9');
  }
  if (content.length > budget.hard_max_slides) push('RISK', 'pacing', null, '内容页 ' + content.length + ' 张 > 硬上限 ' + budget.hard_max_slides + '（' + m + ' 分钟 × 1.25）⇒ 删并页，不许讲快');
  else if (content.length > budget.content_slides_target) push('INFO', 'pacing-soft', null, '内容页 ' + content.length + ' 张 > 目标 ' + budget.content_slides_target + '（尚在上限内）');
  const risks = findings.filter((f) => f.level === 'RISK');
  return {
    kind: deck.kind, minutes: m, slides_total: deck.slides.length,
    content_slides: content.length, backup_slides: backup.length,
    target: budget.content_slides_target, hard_max: budget.hard_max_slides,
    findings, risks: risks.length, infos: findings.length - risks.length,
    ok: risks.length === 0,
  };
}

/** 口播稿预算：按语速把词数摊到每页 */
function talkScript(minutes, opts) {
  const o = opts || {};
  const m = Number(minutes);
  if (!(m > 0)) throw fail('前提层失败：talk script 需要 --minutes <内容分钟>', 'NO_MINUTES');
  const cfg = o.budgetCfg || DEFAULT_BUDGET;
  const lang = (o.lang === 'en') ? 'en' : 'zh';
  const rate = ((cfg.speech_rate || DEFAULT_BUDGET.speech_rate)[lang]) || DEFAULT_BUDGET.speech_rate[lang];
  const sec = Number(cfg.seconds_per_slide) > 0 ? Number(cfg.seconds_per_slide) : DEFAULT_BUDGET.seconds_per_slide;
  let slides = null;
  if (o.deckText) {
    const d = parseDeck(o.deckText, o);
    slides = d.slides;
  }
  const totalLo = Math.round(m * rate[0]);
  const totalHi = Math.round(m * rate[1]);
  const perSlideLo = Math.round((sec / 60) * rate[0]);
  const perSlideHi = Math.round((sec / 60) * rate[1]);
  const rows = slides ? slides.map((s) => ({
    index: s.index, title: s.title || '（无标题）', is_backup: s.is_backup,
    target: s.is_backup ? '—' : (perSlideLo + '–' + perSlideHi + (lang === 'zh' ? ' 字' : ' 词')),
  })) : [];
  return {
    lang, minutes: m, rate_lo: rate[0], rate_hi: rate[1], seconds_per_slide: sec,
    total_target: totalLo + '–' + totalHi + (lang === 'zh' ? ' 字' : ' 词'),
    per_slide_target: perSlideLo + '–' + perSlideHi + (lang === 'zh' ? ' 字' : ' 词'),
    content_slides: slides ? slides.filter((s) => !s.is_backup).length : null,
    backup_slides: slides ? slides.filter((s) => s.is_backup).length : null,
    rows,
    notes: [
      '口播稿按**内容页**分配；备份页不配词。',
      '语速取真源 forms.budget.speech_rate（' + lang + '：' + rate[0] + '–' + rate[1] + '）⇒ 这是**设计上限**，实操留 10% 余量。',
      '每页一句主张 + 一个支撑（图/数字）；讲不完就删页，不要加速。',
    ],
  };
}

/* ─────────────────────────── selftest ─────────────────────────── */
function selftest() {
  const cases = [];
  const ck = (name, fn) => { let r; try { r = fn(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); };

  ck('budget·15 分钟全篇：目标≈15 张、硬上限 19 张、分节份额合计=100%', () => {
    const b = talkBudget(15, { qa: 3 });
    if (b.shape !== 'full') return '形态应为 full：' + b.shape;
    if (b.content_slides_target !== 15) return '目标页数应为 15：' + b.content_slides_target;
    if (b.hard_max_slides !== 19) return '硬上限应为 19：' + b.hard_max_slides;
    if (Math.abs(b.shares_sum - 1) > 0.01) return '份额合计不是 100%：' + b.shares_sum;
    const mins = b.sections.reduce((a, s) => a + s.minutes, 0);
    if (Math.abs(mins - 15) > 0.6) return '分节分钟合计偏离槽位：' + mins;
    if (b.total_minutes !== 18) return '槽位合计应为 15+3=18：' + b.total_minutes;
    return true;
  });

  ck('budget·5 分钟 ⇒ 闪电形态（≤7 分钟），目标 5 张、硬上限 7 张', () => {
    const b = talkBudget(5, {});
    if (b.shape !== 'lightning') return '形态应为 lightning：' + b.shape;
    if (b.content_slides_target !== 5 || b.hard_max_slides !== 7) return '目标/上限应为 5/7：' + b.content_slides_target + '/' + b.hard_max_slides;
    return b.sections.length === 4 ? true : '闪电形态应为 4 节：' + b.sections.length;
  });

  ck('★必失败面：不给 --minutes ⇒ 前提层失败（绝不许臆测槽位时长）', () => {
    let threw = '';
    try { talkBudget(undefined, {}); } catch (e) { threw = e.code || 'x'; }
    if (threw !== 'NO_MINUTES') return '未按前提层失败：' + threw;
    let t2 = '';
    try { talkLint('# A\n' + 'word '.repeat(20), {}); } catch (e) { t2 = e.code || 'x'; }
    if (t2 !== 'NO_MINUTES') return 'lint 缺 minutes 未失败：' + t2;
    return true;
  });

  ck('script·15 分钟中文：总词数落在语速区间内，且每页预算按 seconds_per_slide 摊分', () => {
    const s = talkScript(15, { lang: 'zh', budgetCfg: DEFAULT_BUDGET });
    if (!/2700–3300/.test(s.total_target)) return '15 分钟×180–220 字应为 2700–3300：' + s.total_target;
    if (s.per_slide_target !== '150–183 字') return '每页预算（50 秒）应为 150–183 字：' + s.per_slide_target;
    const s2 = talkScript(10, { lang: 'en', budgetCfg: DEFAULT_BUDGET });
    if (!/1200–1500/.test(s2.total_target)) return '英文 10 分钟×120–150 应为 1200–1500 词：' + s2.total_target;
    return true;
  });

  ck('lint·★必失败面：坏幻灯片必须同时抓出 pacing / 过载 / 非断言标题 / 图片缺失 四类风险', () => {
    const bad = ['---', 'marp: true', '---', '', '# Background', '', 'word '.repeat(130), '', '---', '', '# Results', '', ...Array(9).fill('- bullet'), '', '![](figs/missing.png)', '', '---', '', '# Backup: proofs', '', 'word '.repeat(200)].join('\n');
    const r = talkLint(bad, { minutes: 10, baseDir: process.cwd() });
    const got = new Set(r.findings.map((f) => f.check));
    for (const need of ['overfull', 'bullet-overload', 'generic-title', 'missing-image']) if (!got.has(need)) return '未抓出 ' + need + '（实得：' + [...got].join(',') + '）';
    if (r.slides_total !== 3) return 'front matter 不得算页：总页应为 3（实得 ' + r.slides_total + '）';
    if (r.content_slides !== 2) return '内容页应为 2（front matter 与备份页都不计）：' + r.content_slides;
    if (r.backup_slides !== 1) return '备份页应为 1：' + r.backup_slides;
    return r.risks > 0 && r.ok === false ? true : 'ok 应为 false';
  });

  ck('lint·正控：规整幻灯片（claim 标题、每页短、无图）必须无 RISK', () => {
    const good = ['---', 'marp: true', '---', '', '# 该方法把召回率提到 92%', '', '![](figs/a.png)', '', '---', '', '# 主结果对比三个基线都占优', '', '- 一句话要点', '', '---', '', '# Backup: 消融细节', '', 'word '.repeat(200)].join('\n');
    const r = talkLint(good, { minutes: 15, baseDir: '' });
    return r.ok ? true : ('仍报风险：' + JSON.stringify(r.findings));
  });

  ck('lint·pacing 只在超过 1.25× 时判 RISK（软上限内只记 INFO）', () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => '# 断言标题 ' + i + '\n\n短内容').join('\n---\n');
    const soft = talkLint(mk(12), { minutes: 10, baseDir: '' });   // 12 ≤ 12.5 ⇒ 软
    const hard = talkLint(mk(14), { minutes: 10, baseDir: '' });   // 14 > 12.5 ⇒ 硬
    if (soft.findings.some((f) => f.check === 'pacing')) return '软上限内不应判 pacing RISK';
    if (!hard.findings.some((f) => f.check === 'pacing' && f.level === 'RISK')) return '超硬上限未判 pacing RISK';
    return true;
  });


  ck('lint·★必失败面：Marp front matter 不得被当成一页（夹具曾把这个 bug 固化成期望值）', () => {
    const t = '---\nmarp: true\ntheme: gaia\npaginate: true\n---\n\n# 该断言是标题\n\n短\n';
    const d = parseDeck(t, {});
    if (d.slides.length !== 1) return 'front matter 被算成页：解析出 ' + d.slides.length + ' 页';
    if (/marp|theme|paginate/i.test(d.slides[0].title + JSON.stringify(d.slides[0].images))) return 'front matter 内容混进了页';
    if (/:/.test(d.slides[0].title || '')) return '标题里混进 front matter 键值：' + d.slides[0].title;
    const r = talkLint(t, { minutes: 5, baseDir: '' });
    return (r.content_slides === 1 && r.ok) ? true : ('内容页应为 1 且无风险：' + r.content_slides + '/' + JSON.stringify(r.findings));
  });

  ck('lint·Marp 下 PDF 图必须判风险（Marp 渲染不了 PDF）', () => {
    const t = '# 一句断言标题\n\n![](figs/x.pdf)\n---\n# 另一句断言\n\n图\n';
    const r = talkLint(t, { minutes: 5, baseDir: '' });
    return r.findings.some((f) => f.check === 'marp-pdf-image') ? true : '未判 Marp PDF 图风险';
  });

  ck('端到端（纯函数）：budget → script → lint 三件能串起来跑且都带前提门', () => {
    const b = talkBudget(12, { qa: 3 });
    const s = talkScript(12, { lang: 'zh', budgetCfg: DEFAULT_BUDGET });
    const deck = Array.from({ length: b.content_slides_target }, (_, i) => '# 断言式标题 ' + i + '\n\n一句要点').join('\n---\n');
    const r = talkLint(deck, { minutes: 12, baseDir: '' });
    if (b.content_slides_target !== 12) return '目标页数异常';
    if (!s.total_target) return '口播预算缺失';
    if (!r.ok) return '按预算生成的幻灯片竟有 RISK：' + JSON.stringify(r.findings);
    return true;
  });

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.ok ? '' : '  ← ' + c.detail));
  console.log('\ntalk 自检：' + (cases.length - failed.length) + '/' + cases.length + ' 通过');
  return failed.length ? 1 : 0;
}

/* ─────────────────────────── CLI ─────────────────────────── */
function main(argv, ctx) {
  const o = ctx || {};
  const pipeline = o.pipeline || null;
  const budgetCfg = (pipeline && pipeline.forms && pipeline.forms.budget) || DEFAULT_BUDGET;
  if (argv.includes('--selftest')) return selftest();
  const sub = argv[0] || '';
  const rest = argv.slice(1);
  const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
  const json = rest.includes('--json');
  try {
    if (sub === 'budget') {
      const r = talkBudget(flag('--minutes'), { qa: flag('--qa'), format: flag('--format') || 'auto' });
      if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log('形态：' + r.shape + ' · 内容 ' + r.speaking_minutes + ' 分钟' + (r.qa_minutes ? ' + 问答 ' + r.qa_minutes + ' 分钟' : '') + ' = 合计 ' + r.total_minutes + ' 分钟');
      console.log('内容页：目标 ' + r.content_slides_target + ' 张 · **硬上限 ' + r.hard_max_slides + ' 张**（超了删并页，不许讲快）');
      console.log('problem-first 分节：');
      for (const s of r.sections) console.log('  · ' + s.label + ' ⇒ ' + s.minutes + ' 分钟 / ' + s.slides + ' 张');
      for (const n of r.notes) console.log('  - ' + n);
      return 0;
    }
    if (sub === 'script') {
      const deckPath = flag('--deck');
      let deckText = '';
      if (deckPath) { if (!fs.existsSync(deckPath)) { console.error('前提层失败：找不到幻灯片文件 ' + deckPath); return 2; } deckText = fs.readFileSync(deckPath, 'utf8'); }
      const r = talkScript(flag('--minutes'), { lang: flag('--lang') || 'zh', budgetCfg, deckText, baseDir: deckPath ? path.dirname(deckPath) : '' });
      if (json) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log('口播预算（' + r.lang + ' · ' + r.rate_lo + '–' + r.rate_hi + (r.lang === 'zh' ? ' 字/分' : ' 词/分') + '）：' + r.minutes + ' 分钟 ⇒ 合计 ' + r.total_target + ' · 每页 ' + r.per_slide_target);
      if (r.rows && r.rows.length) { for (const x of r.rows) console.log('  ' + String(x.index).padStart(2) + '. ' + x.title.slice(0, 40).padEnd(42) + x.target); }
      for (const n of r.notes) console.log('  - ' + n);
      return 0;
    }
    if (sub === 'lint') {
      const f = rest.find((a) => !a.startsWith('--') && a !== flag('--minutes') && a !== flag('--lang') && a !== flag('--format'));
      if (!f || !fs.existsSync(f)) { console.error('前提层失败：lint 需要存在的幻灯片文件（收到 ' + (f || '空') + '）'); return 2; }
      const r = talkLint(fs.readFileSync(f, 'utf8'), { minutes: flag('--minutes'), baseDir: path.dirname(path.resolve(f)), format: flag('--format'), lang: flag('--lang') });
      if (json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 2; }
      console.log('幻灯片 lint（' + r.kind + ' · 内容分钟 ' + r.minutes + '）：内容页 ' + r.content_slides + '（目标 ' + r.target + ' / 上限 ' + r.hard_max + '）· 备份页 ' + r.backup_slides);
      for (const x of r.findings) console.log('  ' + (x.level === 'RISK' ? '✘' : '·') + ' [' + x.check + ']' + (x.slide ? ' 第' + x.slide + '页' : '') + ' ' + x.msg);
      console.log(r.ok ? '  判定：无 RISK（' + r.infos + ' 条提示）' : '  判定：' + r.risks + ' 条 RISK 必须修');
      return r.ok ? 0 : 2;
    }
    console.error('用法：talk budget --minutes <n> [--qa <n>] | talk script --minutes <n> [--deck <f>] | talk lint <f> --minutes <n> | talk --selftest');
    return 2;
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { talkBudget, talkScript, talkLint, parseDeck, main, selftest, DEFAULT_BUDGET, SHAPES };
