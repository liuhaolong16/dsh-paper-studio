#!/usr/bin/env node
/**
 * figures — 图表助手（V3 · 补齐 P2 缺口；机制对齐市面「论文架构图 / 实验绘图推荐 / 生成图表标题」三件）
 *
 * ★ 诚实边界：**本工具不生成任何图片**。它产出的是**可渲染的源码与规格** ——
 *   题注文本、绘图类型建议（含反模式警告）、以及 **Mermaid/Graphviz 源码骨架**（用户自己渲染成图）。
 *   理由：图片生成属另一条能力线，硬塞进来只会得到不可控的半成品（宁可给能核对的源码）。
 *
 * 三个子命令：
 *   caption   —— **题注生成/体检**：按「自包含」清单（画了什么 / 在什么上 / 该注意什么 / n / 不确定度定义 / 单位）
 *                生成题注模板；`--check` 则体检已有题注（抓「见正文」「没有 n」「没有单位」等）。
 *   recommend —— **绘图推荐**：按数据结构（类别数/变量类型/是否时序/是否比较均值）给出图型建议 + 反模式警告。
 *   arch      —— **架构图源码骨架**：按阶段/模块清单输出 Mermaid 源码（可渲染），不画图。
 *
 * 用法：
 *   node bin/figures.cjs caption --figure 2 --what "cross-temperature R² collapse" --on "26 cells" --n 26 --notice "R² falls below zero at 4 °C" [--uncertainty "5 seeds, mean±sd"] [--units "R²"]
 *   node bin/figures.cjs caption --check --file <稿.md>
 *   node bin/figures.cjs recommend --categories 26 --value mean --compare --trend
 *   node bin/figures.cjs arch --modules "Data,Features,Model,Evaluation" [--title "Pipeline"]
 *   node bin/figures.cjs --selftest
 * 退出码：0 通过 · 1 体检发现问题 · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ── 题注「自包含」清单 ──
const CAPTION_FIELDS = [
  { key: 'what', label: '画的是什么', why: '读者只看题注要能知道图在表达什么量' },
  { key: 'on', label: '在什么对象/条件上', why: '数据集/样本/条件（如 26 cells、4 °C）' },
  { key: 'notice', label: '该注意到什么', why: '这张图要支撑的主张（没有它读者不知道为什么给这张图）' },
  { key: 'n', label: '样本量 n', why: '没有 n 的实验图无法判断可信度' },
  { key: 'uncertainty', label: '不确定度定义', why: '误差棒/区间是什么（sd? se? 95% CI? 几个种子?）—— 定义了才可比较' },
  { key: 'units', label: '单位/量纲', why: '数值必须有单位或明确是归一化量' },
];

function captionTemplate(spec) {
  const missing = CAPTION_FIELDS.filter((f) => !spec[f.key]).map((f) => f.label);
  const fig = spec.figure ? `图 ${spec.figure}` : '图 N';
  const parts = [
    `${fig}｜${spec.what || '〔画的是什么：量 + 方法，例如 "cross-temperature R² of the SOH model"〕'}`,
    `在${spec.on || '〔什么对象/条件，例如 26 cells（4 °C × 11, 24 °C × 11, 43 °C × 4）〕'}上`,
    `，n = ${spec.n || '〔样本量〕'}`,
    spec.uncertainty ? `，误差为 ${spec.uncertainty}` : '，〔不确定度定义：sd / se / 95% CI / 种子数〕',
    spec.units ? `；纵轴单位为 ${spec.units}` : '；〔单位〕',
    `。${spec.notice || '〔该注意到的现象或结论指向，例如 "R² 在 4 °C 处跌破 0"〕'}`,
  ];
  return { caption: parts.join(''), missing };
}

/**
 * 体检已有题注。★ 分级（真稿实测后修正）：
 *   **硬问题**（判失败）：① 依赖正文（"见正文/As shown in the main text"）② 过短（<40 字符几乎不可能自包含）
 *   **提示**（不判失败，逐条说明为什么）：缺 n / 缺不确定度 / 缺单位或无量纲说明
 *   —— 为什么后三项只作提示：**表格的 n 与单位常写在表头或表体**（题注层看不到）；
 *      **示意图/架构图**本来就不需要 n 与误差；**R²/AUC 这类指标本就无量纲**。硬判会造成大量假阳性。
 */
const DIMENSIONLESS = /\b(R2|R²|rho|spearman|pearson|auc|f1|accuracy|precision|recall|score|correlation|index)\b/i;
const SCHEMATIC = /(architect|pipeline|workflow|schematic|overview|framework diagram|架构图|流程|示意)/i;
function captionCheck(captions, opts) {
  const kinds = (opts && opts.kindByNumber) || {};
  return captions.map((c) => {
    const text = c.text;
    const problems = []; const warnings = [];
    if (/\b(as (shown|described|discussed) (in|above)|see (the )?(text|main text|section)|见正文|如正文所述|详见正文)\b/i.test(text)) {
      problems.push({ rule: 'depends-on-text', why: '题注不得依赖正文（"见正文"）—— 题注必须自包含' });
    }
    // ★ 真稿实测后降级：**过短只是启发式**（简单参考表/计数表的题注本来就短）⇒ 提示而非硬失败。
    //   唯一保留的硬失败是「依赖正文」—— 那是自包含性的**无歧义违反**。
    if (text.replace(/\s/g, '').length < 40) warnings.push({ rule: 'short-caption', why: '题注偏短（<40 字符）⇒ 很可能不自包含（若表体/图本身已给足信息可忽略）' });
    const isSchematic = SCHEMATIC.test(text) || kinds[c.number] === 'schematic';
    if (!isSchematic) {
      if (!/\bn\s*=\s*\d+/i.test(text)) warnings.push({ rule: 'maybe-missing-n', why: '题注未见 n（若 n 写在表头/表体或正文口径中，可忽略此提示）' });
      if (!/\b(sd|s\.d\.|std|standard deviation|se\b|s\.e\.|confidence interval|95%\s*CI|seeds?|±)\b/i.test(text)) warnings.push({ rule: 'maybe-missing-uncertainty', why: '题注未见不确定度定义（sd/se/CI/种子数/±）；示意图与纯计数表可忽略' });
    // ★ `\b°C\b` 匹配不上（`°` 不是单词字符）⇒ 摄氏度/百分号必须放在 `\b` 之外
    if (!/(°C|%|\b(units?|ms|seconds?|minutes?|hours?|Ah|mAh|kg|Hz|dB|rpm|MPa|kPa)\b)/i.test(text) && !DIMENSIONLESS.test(text)) warnings.push({ rule: 'maybe-missing-units', why: '题注未见单位，也未见无量纲指标名（R²/AUC/F1 等）⇒ 数值量纲不明' });
    }
    return { ...c, is_schematic: isSchematic, problems, warnings };
  });
}
/** 从稿子里抽题注：Markdown 的 `Figure N:`/`Table N:` 行 与 LaTeX 的 `\caption{...}`。 */
function extractCaptions(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((ln, i) => {
    const md = ln.match(/^\s*\*{0,2}(Figure|Fig\.?|Table|图|表)\s*(\d+)[:：.．]?\*{0,2}\s*(.+)$/i);
    if (md) out.push({ kind: md[1], number: md[2], line: i + 1, text: md[3].trim() });
    for (const m of ln.matchAll(/\\caption\{([^}]*)\}/g)) out.push({ kind: 'latex', number: null, line: i + 1, text: m[1].trim() });
  });
  return out;
}

// ── 绘图推荐（规则表，确定性） ──
const RECOMMEND_RULES = [
  { when: (o) => o.categories > 8, rec: '条形图 / 点图（横向）', why: '类别 > 8 ⇒ 饼图与竖排标签都不可读', avoid: '饼图（>5 类几乎必错）' },
  { when: (o) => o.categories >= 2 && o.categories <= 5 && o.parts, rec: '饼图 / 堆叠条', why: '类别少且是**整体占比**时占比图合适', avoid: '类别多时用饼图' },
  { when: (o) => o.trend, rec: '折线图（+ 阴影带表示不确定度）', why: '时序/随某连续量变化 ⇒ 折线；带区间更诚实', avoid: '用条形图表示连续趋势' },
  { when: (o) => o.compare && o.value === 'mean', rec: '点图/条形 + **误差棒**（并注明 sd/se/n）', why: '比较均值必须给离散度，否则读者无法判断差异是否真实', avoid: '只画均值柱（常见退回项）' },
  { when: (o) => o.categories >= 2 && o.categories <= 12, rec: '箱线图 / 小提琴图 + 原始点', why: '分布比较时比均值柱信息量大得多', avoid: '把分布压成一个均值' },
  { when: (o) => o.relations >= 2, rec: '散点图矩阵 / 相关热图', why: '看多变量关系', avoid: '双 Y 轴（易误导）' },
];
function recommend(opt) {
  const o = { categories: Number(opt.categories || 0), trend: !!opt.trend, compare: !!opt.compare, value: opt.value || '', parts: !!opt.parts, relations: Number(opt.relations || 0), n: Number(opt.n || 0) };
  const hits = RECOMMEND_RULES.filter((r) => { try { return r.when(o); } catch { return false; } });
  const warnings = [];
  warnings.push('**可达性**：色盲友好配色（避开红绿配对）、灰度下仍可读、除颜色外再用线型与标记');
  warnings.push('**图内不放装饰性标题**（挪进题注）；矢量输出（PDF/EPS）优先');
  if (o.categories > 5) warnings.push(`类别 ${o.categories} > 5 ⇒ **不要用饼图**`);
  if (o.value === 'mean') warnings.push('画均值必须配误差棒并注明不确定度定义');
  if (o.n && o.n < 10) warnings.push(`n = ${o.n} 偏小 ⇒ 建议同时画出**原始点**（别只给均值±区间）`);
  return { input: o, recommendations: hits.length ? hits : [{ rec: '先明确"这张图要支撑哪条主张"，再选图型', why: '图型应由主张决定，而不是由数据形状决定', avoid: '为凑图而作图' }], warnings, note: '**只给规格与建议，不生成图片**；渲染与美学取舍归人。' };
}

// ── 架构图源码骨架（Mermaid） ──
function archSkeleton(modules, title) {
  const ms = String(modules).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (ms.length < 2) throw new Error('前提层失败：--modules 至少 2 个（用逗号分隔）');
  const ids = ms.map((m, i) => `M${i + 1}`);
  const lines = ['```mermaid', 'flowchart LR', `  %% ${title || '论文架构图'}（可渲染；本工具**不生成图片**）`];
  ms.forEach((m, i) => lines.push(`  ${ids[i]}["${m}"]`));
  for (let i = 0; i + 1 < ids.length; i++) lines.push(`  ${ids[i]} --> ${ids[i + 1]}`);
  lines.push('```', '', '**自查（架构图）**：① 每条箭头都有实际数据/控制流（不画"未来工作"）② 与正文的模块命名一致 ③ 不放装饰性标题 ④ 图注自包含（哪部分是本文贡献要能看出来）。');
  return lines.join('\n');
}

function runSelftest() {
  const os = require('os');
  const results = [];
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figs-'));
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };

  check('★ 正控 · 题注模板：信息齐全时不报缺项，且拼出的题注包含 n / 不确定度 / 单位 / 现象', () => {
    const r = captionTemplate({ figure: 2, what: 'cross-temperature R²', on: '26 cells', n: 26, uncertainty: 'mean±sd over 5 seeds', units: 'R²', notice: 'R² falls below zero at 4 °C' });
    const ok = r.missing.length === 0 && /n = 26/.test(r.caption) && /mean±sd over 5 seeds/.test(r.caption) && /R²/.test(r.caption) && /falls below zero/.test(r.caption);
    return ok ? true : JSON.stringify(r);
  });
  check('★ 正控 · 题注模板：缺什么就点名（缺 n / 缺不确定度 / 缺单位）', () => {
    const r = captionTemplate({ what: 'X', on: 'Y', notice: 'Z' });
    return (r.missing.includes('样本量 n') && r.missing.includes('不确定度定义') && r.missing.includes('单位/量纲')) ? true : JSON.stringify(r.missing);
  });
  check('★★ 正控 · 体检：**依赖正文是唯一的硬判据**；缺 n/不确定度/单位、过短都只作提示（真稿实测后定级）', () => {
    const caps = [{ kind: 'Figure', number: '1', line: 3, text: 'As shown in the main text, our method works.' }];
    const r = captionCheck(caps);
    const rules = r[0].problems.map((p) => p.rule);
    const warns = r[0].warnings.map((p) => p.rule);
    return (rules.length === 1 && rules[0] === 'depends-on-text' && warns.includes('maybe-missing-n') && warns.includes('short-caption')) ? true : JSON.stringify({ rules, warns });
  });
  check('★★ 反控 · 一份**自包含**的题注不得有任何硬问题（R² 无量纲也不算缺单位）', () => {
    const caps = [{ kind: 'Figure', number: '2', line: 9, text: 'Cross-temperature R² of the SOH model on 26 cells (4/24/43 °C); n = 26; error bars are mean±sd over 5 seeds; the dashed line marks R² = 0.' }];
    const r = captionCheck(caps);
    return (r[0].problems.length === 0 && r[0].warnings.length === 0) ? true : JSON.stringify({ p: r[0].problems, w: r[0].warnings });
  });
  check('★ 反控 · **示意图/架构图**题注不得被要求给 n 与误差（本来就不需要）', () => {
    const caps = [{ kind: 'Figure', number: '1', line: 5, text: 'Overall architecture of the proposed pipeline: data verification, feature construction, model fitting, and cross-temperature evaluation.' }];
    const r = captionCheck(caps);
    return (r[0].problems.length === 0 && r[0].warnings.length === 0 && r[0].is_schematic === true) ? true : JSON.stringify(r[0]);
  });
  check('★ 正控 · 抽题注：Markdown 的 Figure/Table 行与 LaTeX 的 \\caption{} 都能抽到', () => {
    const t = '# T\n\n**Figure 2:** something about 26 cells.\n\n| a | b |\n\nTable 1: ablation results with n = 11.\n\n\\caption{LaTeX caption here}';
    const c = extractCaptions(t);
    return (c.length === 3 && c.some((x) => x.kind === 'latex')) ? true : JSON.stringify(c);
  });
  check('★ 正控 · 绘图推荐：26 类 ⇒ 明确否掉饼图；比较均值 ⇒ 必须误差棒或画分布', () => {
    const r = recommend({ categories: 26, compare: true, value: 'mean', n: 26 });
    const recs = r.recommendations.map((x) => x.rec + ' ' + x.avoid).join(' | ');
    return (/饼图/.test(recs) || r.warnings.some((w) => /不要用饼图/.test(w))) && r.warnings.some((w) => /误差棒/.test(w)) ? true : JSON.stringify(r);
  });
  check('★ 反控 · 说不出理由时**不硬推荐图型**，而是要求先明确主张（不假装有唯一正解）', () => {
    const r = recommend({});
    return /先明确/.test(r.recommendations[0].rec) ? true : JSON.stringify(r.recommendations);
  });
  check('★ 正控 · 架构图骨架：模块 ≥2 时给出 Mermaid 源码与自查项；模块不足要报前提失败', () => {
    const s = archSkeleton('Data,Features,Model,Evaluation', 'Pipeline');
    let e = '';
    try { archSkeleton('OnlyOne', ''); } catch (err) { e = err.message; }
    return (/```mermaid/.test(s) && /M1\["Data"\]/.test(s) && /架构图/.test(s) && /至少 2 个/.test(e)) ? true : JSON.stringify({ s: s.slice(0, 80), e });
  });
  check('★ 反控 · 本工具**不得声称生成图片**（边界声明必须在输出里）', () => {
    const r = recommend({ categories: 3, parts: true });
    return /不生成图片/.test(r.note) ? true : r.note;
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\nfigures 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const opt = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  const read = (f) => { if (!f || !fs.existsSync(f)) throw new Error(`文件不存在：${f}`); return fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''); };
  const cmd = argv.find((a) => !a.startsWith('--') && !['--file', '--figure', '--what', '--on', '--n', '--notice', '--uncertainty', '--units', '--categories', '--value', '--relations', '--modules', '--title', '--json'].includes(a));
  try {
    if (cmd === 'caption') {
      if (argv.includes('--check')) {
        const caps = extractCaptions(read(opt('--file')));
        if (!caps.length) { console.log('未抽到题注（Figure/Table 行或 \\caption{}）—— **明说没抽到**，不假装体检过'); return 0; }
        const rows = captionCheck(caps);
        const hard = rows.filter((r) => r.problems.length);
        const soft = rows.filter((r) => !r.problems.length && r.warnings.length);
        console.log(`题注体检：${caps.length} 条 · 硬问题 ${hard.length} 条 · 仅提示 ${soft.length} 条`);
        for (const r of rows) {
          if (!r.problems.length && !r.warnings.length) continue;
          console.log(`  ${r.problems.length ? '✘' : '·'} L${r.line} ${r.kind}${r.number ? ' ' + r.number : ''}${r.is_schematic ? '（示意图）' : ''}：${r.text.slice(0, 90)}`);
          for (const p of r.problems) console.log(`      - [硬/${p.rule}] ${p.why}`);
          for (const w of r.warnings) console.log(`      - [提示/${w.rule}] ${w.why}`);
        }
        console.log(hard.length ? '  ⇒ 有硬问题（依赖正文 / 过短）。' : '  ⇒ 无硬问题。**提示项不等于不合格**：表格的 n 与单位常写在表头/表体，题注层看不到；示意图无需 n。');
        return hard.length ? 1 : 0;
      }
      const r = captionTemplate({ figure: opt('--figure'), what: opt('--what'), on: opt('--on'), n: opt('--n'), notice: opt('--notice'), uncertainty: opt('--uncertainty'), units: opt('--units') });
      console.log('题注模板（自包含清单：画了什么 / 在什么上 / 该注意什么 / n / 不确定度 / 单位）：');
      console.log('  ' + r.caption);
      if (r.missing.length) console.log(`  ⚠ 还缺：${r.missing.join(' · ')}`);
      console.log('  自查：① 不写"见正文"② 不放装饰性标题③ 与正文数字同口径。');
      return 0;
    }
    if (cmd === 'recommend') {
      const r = recommend({ categories: opt('--categories'), value: opt('--value'), relations: opt('--relations'), n: opt('--n'), trend: argv.includes('--trend'), compare: argv.includes('--compare'), parts: argv.includes('--parts') });
      if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
      console.log('绘图建议（规则表，确定性）：');
      for (const x of r.recommendations) console.log(`  · 建议：${x.rec}\n      理由：${x.why}\n      别做：${x.avoid}`);
      console.log('  必查：'); for (const w of r.warnings) console.log(`    - ${w}`);
      console.log('  ' + r.note);
      return 0;
    }
    if (cmd === 'arch') { console.log(archSkeleton(opt('--modules'), opt('--title'))); return 0; }
    console.error('用法：figures.cjs caption|recommend|arch …（或 --selftest）'); return 2;
  } catch (e) { console.error('前提层失败：' + String((e && e.message) || e)); return 2; }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { captionTemplate, captionCheck, extractCaptions, recommend, archSkeleton, CAPTION_FIELDS, RECOMMEND_RULES, main };
