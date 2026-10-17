#!/usr/bin/env node
/**
 * rehearse —— **投稿前预演**：模拟审稿人（simulate-reviewers）+ 答辩问答预演（rehearse-qa）。
 *
 * ★ 这是**模拟**，不是真实审稿意见，也不是"预测会被拒/接收"：
 *   它按**固定画像 + 规则**扫描稿件自身的弱点（缺对照/缺样本量/缺种子/缺消融/缺局限/过度声称/图表无解读/声明缺失），
 *   输出"审稿人大概会问什么 + 你可以怎么答"，**每条都带证据锚点（节名 + 行号 + 原文片段）**。
 *   规则没命中 ≠ 稿件没问题（回执必须这么说）；缺节 ≠ 没做（未找到 ≠ 没有）。
 *
 * 用法：
 *   node bin/rehearse.cjs --draft <稿.md>            # 三画像 + 问答预演
 *   node bin/rehearse.cjs --draft <稿.md> --persona methods|significance|repro   # 只看一个画像
 *   node bin/rehearse.cjs --draft <稿.md> --json
 *   node bin/rehearse.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PERSONAS = [
  { id: 'methods', name: '方法严谨型', lens: '实验设计、对照、统计、可证伪' },
  { id: 'significance', name: '意义/新颖性型', lens: '贡献是否可证、与已有工作的差别、适用边界' },
  { id: 'repro', name: '复现/报告规范型', lens: '数据与代码可得、超参与种子、图表可读、声明齐备' },
];

/** 规则库：{id, persona, need（要有的信号）, ask（审稿人会怎么问）, check（怎么自检）, answer（答题骨架）} */
const RULES = [
  {
    id: 'no-n', persona: 'methods', need: /(?:\bn\s*=\s*\d|\d+\s*(?:cells|samples|subjects|participants|runs|seeds|replicates)|样本量|重复\s*\d+\s*次)/i,
    ask: '每个数字背后的样本量/重复次数是多少？单次结果还是多次平均？',
    answer: '在正文与图表题注里给出 n（含重复次数与是否带误差棒/置信区间），并在方法节写明每次实验的随机化方式。',
  },
  {
    id: 'no-baseline', persona: 'methods', need: /(baseline|compared? (?:with|to)|against (?:the )?(?:prior|existing|state-of-the-art)|对照|基线)/i,
    ask: '与哪些基线/已有方法比？为什么这几条基线是合适的？',
    answer: '列出基线清单与选择理由（同任务、同数据、同指标），并在表格里标明各基线的来源引用。',
  },
  {
    id: 'no-ablation', persona: 'methods', need: /(ablation|ablat|component analysis|消融)/i,
    ask: '各组件到底贡献多少？有没有消融或替换实验？',
    answer: '给出逐组件消融（每次只去掉一个组件），并说明组合效应是否非线性。',
  },
  {
    id: 'no-limitation', persona: 'significance', need: /(limitation|future work|caveat|局限|不足)/i,
    ask: '这个方法的适用边界在哪里？失效条件是什么？',
    answer: '单列一节说明数据范围、协议假设、失效条件，并给出至少一个"我们试过但不成立"的例子。',
  },
  {
    id: 'overclaim', persona: 'significance', need: null,
    ask: '文中出现"novel / first / state-of-the-art / 显著提升"这类断言，证据够吗？',
    answer: '把每个强断言降调为"在…设置下优于…（Δ=…）"，并给出对应表号/图号；删掉没有直接证据的"first/novel"。',
    scan: (t) => {
      const hits = [];
      /* ★ 收窄信号：`first` 单字在英文里歧义极大（the first thing / Our first filtering criterion / first-cycle capacity 都被真稿证明会误报）
         ⇒ **只认高辨识度短语**：the first <method|approach|framework|study|model|work|system|algorithm|attempt to> · first-of-its-kind · state-of-the-art · novel/novelty */
      const re = /(\bnovel\b|\bnovelty\b|first-of-its-kind|\bthe first (?:method|approach|framework|study|model|work|system|algorithm|attempt to)\b|\bstate[- ]of[- ]the[- ]art\b|\bsignificantly (?:improve[sd]?|outperform)\b|首次|填补空白|显著(?:优于|提升))/gi;
      let m;
      const sentenceAt = (i) => {
        const start = Math.max(t.lastIndexOf('.', i), t.lastIndexOf('\n', i), t.lastIndexOf('。', i));
        const endDot = t.indexOf('.', i), endNl = t.indexOf('\n', i), endCjk = t.indexOf('。', i);
        const cands = [endDot, endNl, endCjk].filter((x) => x > i);
        const end = cands.length ? Math.min.apply(null, cands) : t.length;
        return t.slice(start + 1, end + 1);
      };
      while ((m = re.exec(t)) !== null) {
        const word = m[0].toLowerCase();
        const sent = sentenceAt(m.index);
        /* 守卫 ①：**否认句**里的强词不算过度声称（真稿实测：论文 A 写 "We do not claim … novelty"） */
        if (/(do not claim|does not claim|no claim|not claim|we do not (?:argue|assert)|不主张|不声称|并非)/i.test(sent)) continue;
        /* 守卫 ②：`first` 作**序数**（其后 40 字符内出现 criterion/filter/step/thing… 等被修饰名词）不是新颖性主张
           真稿实测：`Our first filtering criterion …`、`the first (absolute-threshold) filtering criterion`、`the first thing a follow-up …` */
        if (/(?:^|\bthe )first$/.test(word)) {
          const win = t.slice(m.index + m[0].length, m.index + m[0].length + 40);
          if (/^\s*\(/.test(win)) continue;
          if (/\b(?:criterion|criteria|filter\w*|step|stage|layer|question|phase|attempt|round|pass|iteration|thing|place|time|author|section|figure|table|paragraph|term|row|column)\b/i.test(win)) continue;
        }
        /* 守卫 ③：**统计意义的 significantly**（同句有 p 值/±/CI/检验）不算过度声称 */
        if (/^significantly/.test(word) && /(p\s*[<=]\s*0?\.\d|±|confidence interval|\bCI\b|\bt-test\b|\btest\b|Mann|ANOVA)/i.test(sent)) continue;
        hits.push({ at: m.index, word: m[0] });
      }
      return hits;
    },
  },
  {
    id: 'no-seed', persona: 'repro', need: /(random seed|random_state|seed\s*=\s*\d|随机种子|固定种子)/i,
    ask: '随机性怎么控制？换个种子结果还成立吗？',
    answer: '写明种子与重复次数，并报告跨种子的均值±标准差（或至少给出区间）。',
  },
  {
    id: 'no-availability', persona: 'repro', need: /(data availability|code availability|github|zenodo|代码(?:已)?(?:公开|可得)|数据(?:已)?(?:公开|可得))/i,
    ask: '数据与代码在哪？别人能复现这个数字吗？',
    answer: '给出仓库/存档链接与版本号（含 DOI），并在附录写明运行命令与环境锁文件。',
  },
  {
    id: 'no-ethics', persona: 'repro', need: /(ethic|irb|consent|伦理|知情同意)/i,
    ask: '用到的数据/受试者是否合规？伦理审查在哪？',
    answer: '写明伦理审批编号与知情同意方式；若为公开数据，写明来源条款。',
  },
  {
    id: 'fig-unread', persona: 'repro', need: null,
    ask: '每张图都在正文被解读过吗？图想说明什么？',
    answer: '为每张图补一句"图 N 说明…（数值/趋势/对比）"，并在题注写清坐标、单位与误差表示。',
    scan: (t) => {
      const figs = (t.match(/!\[[^\]]*\]\(/g) || []).length;
      const reads = (t.match(/(?:Figure|Fig\.)\s*\d+\s*(?:shows?|indicates?|reveals?|illustrates?|displays?|图\s*\d+\s*(?:显示|表明|说明))/gi) || []).length;
      return figs > 0 && reads < figs ? [{ figs, reads }] : [];
    },
  },
  {
    id: 'p-no-n', persona: 'methods', need: null,
    ask: 'p 值/显著性检验用的什么检验、样本量多少、是否多重比较校正？',
    answer: '写明检验方法、样本量与校正方式（如 Holm/BH），并报告效应量而不只报 p。',
    scan: (t) => (/p\s*[<=]\s*0?\.\d/i.test(t) && !/n\s*=\s*\d/i.test(t)) ? [{ why: '有 p 值但全文无 n' }] : [],
  },
];

/** 切节，便于给锚点 */
function sections(text) {
  const out = [];
  let cur = { title: '(题前)', lines: [] };
  String(text || '').split('\n').forEach((L, i) => {
    const h = /^\s*#{1,6}\s*(.+?)\s*$/.exec(L);
    if (h) { out.push(cur); cur = { title: h[1], lines: [], start: i + 1 }; return; }
    cur.lines.push({ n: i + 1, text: L });
  });
  out.push(cur);
  return out.filter((s) => s.title !== '(题前)' || s.lines.some((l) => l.text.trim()));
}

function locate(text, at) {
  const before = String(text).slice(0, at);
  const line = before.split('\n').length;
  const secs = sections(text);
  let title = '(题前)';
  for (const s of secs) if (s.start && s.start <= line) title = s.title;
  return { line, section: title };
}

function rehearse(text, opts) {
  const o = opts || {};
  const t = String(text || '');
  if (!t.trim()) return { status: 'SKIP', why: '稿件为空 ⇒ 未预演' };
  const only = o.persona;
  const concerns = [];
  for (const r of RULES) {
    if (only && r.persona !== only) continue;
    if (r.scan) {
      const hits = r.scan(t);
      if (hits.length) {
        const h = hits[0];
        const anchor = h.at !== undefined ? locate(t, h.at) : { line: null, section: '（全文）' };
        concerns.push({ id: r.id, persona: r.persona, ask: r.ask, answer: r.answer, evidence: h, line: anchor.line, section: anchor.section, kind: 'scan' });
      }
      continue;
    }
    if (r.need && !r.need.test(t)) {
      concerns.push({ id: r.id, persona: r.persona, ask: r.ask, answer: r.answer, evidence: { missing: r.id }, line: null, section: '（全文未检出）', kind: 'absent' });
    }
  }
  const byPersona = {};
  for (const p of PERSONAS) byPersona[p.id] = concerns.filter((c) => c.persona === p.id);
  const qa = concerns.map((c, i) => ({ n: i + 1, q: c.ask, answerSkeleton: c.answer, persona: c.persona, section: c.section, line: c.line }));
  return {
    status: concerns.length ? 'REVIEW' : 'OK',
    counts: { concerns: concerns.length, byPersona: Object.fromEntries(PERSONAS.map((p) => [p.id, byPersona[p.id].length])), qa: qa.length },
    byPersona, qa, personas: PERSONAS,
    boundary: '**这是模拟，不是真实审稿意见**：按三个固定画像 + 规则扫描稿件自身的信号（缺 n/缺基线/缺消融/缺局限/过度声称/缺种子/缺数据可得/缺伦理/图表无解读/p 无 n），'
      + '**规则没命中 ≠ 稿件没问题**；`（全文未检出）` 只说明没找到该信号，**不等于作者真的没做**。每条都给了节名与行号（若有）供你核对原文。',
  };
}

function render(r) {
  const L = ['# 投稿前预演（模拟审稿人 + 答辩问答）· **' + r.status + '**', ''];
  L.push('共 ' + r.counts.concerns + ' 条会前预判（方法 ' + r.counts.byPersona.methods + ' · 意义 ' + r.counts.byPersona.significance + ' · 复现 ' + r.counts.byPersona.repro + '）');
  L.push('');
  for (const p of r.personas) {
    const list = r.byPersona[p.id];
    L.push('## ' + p.name + '（' + p.lens + '）· ' + list.length + ' 条');
    L.push('');
    if (!list.length) { L.push('- （本画像未命中规则；**不代表没问题**）'); L.push(''); continue; }
    for (const c of list) L.push('- **' + c.ask + '**  \n  ↳ 答题骨架：' + c.answer + '  \n  ↳ 锚点：' + c.section + (c.line ? '（第 ' + c.line + ' 行）' : ''));
    L.push('');
  }
  L.push('## 问答预演（可直接当答辩提纲）');
  L.push('');
  L.push('| # | 会被问什么 | 你准备怎么答 | 位置 |');
  L.push('|---|---|---|---|');
  for (const q of r.qa) L.push('| ' + q.n + ' | ' + q.q + ' | ' + q.answerSkeleton + ' | ' + q.section + (q.line ? ':' + q.line : '') + ' |');
  L.push('');
  L.push('> ' + r.boundary);
  return L.join('\n') + '\n';
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const WEAK = '# Battery SOH prediction\n\n## Method\nWe propose a novel framework and train it on the dataset.\n\n## Results\nOur method significantly improves accuracy (p < 0.01) and reaches 0.97.\n\nFigure 1: Accuracy.\n\n![a](f1.png)\n\n![b](f2.png)\n';
  const STRONG = [
    '# Battery SOH prediction with ablations',
    '',
    '## Method',
    'We fix the random seed (seed = 42) and repeat every run 5 times; each number is the mean of 5 replicates (n = 30 cells, 5 runs).',
    'We compare with two baselines (baseline A and baseline B, both re-implemented) and run a full ablation of each component.',
    '',
    '## Results',
    'The proposed model reaches 0.973 ± 0.004 (n = 30 cells, 5 seeds) versus 0.951 ± 0.006 for baseline A.',
    'Figure 1 shows the accuracy trend across protocols; Figure 2 shows the ablation.',
    '',
    '![a](f1.png)',
    '',
    'Figure 1: Accuracy across protocols.',
    '',
    '![b](f2.png)',
    '',
    'Figure 2: Ablation result.',
    '',
    '## Limitations',
    'Our setting assumes a fixed temperature range; outside it the model degrades, as we observed for two cells.',
    'Data availability: the dataset and code are archived at zenodo with a DOI.',
    'Ethics: only public, de-identified datasets were used (IRB not applicable).',
  ].join('\n');

  ck('正控：弱稿 ⇒ 三个画像各自命中（缺 n/缺基线/缺消融/缺局限/过度声称/缺种子/缺可得/缺伦理/图表无解读/p 无 n）', () => {
    const r = rehearse(WEAK);
    const bad = [];
    if (r.status !== 'REVIEW') bad.push('状态 ' + r.status);
    if (r.counts.byPersona.methods < 2) bad.push('方法型命中 ' + r.counts.byPersona.methods);
    if (r.counts.byPersona.significance < 2) bad.push('意义型命中 ' + r.counts.byPersona.significance);
    if (r.counts.byPersona.repro < 2) bad.push('复现行命中 ' + r.counts.byPersona.repro);
    if (r.qa.length < 6) bad.push('问答只有 ' + r.qa.length);
    return bad.length ? bad.join('；') : true;
  });

  ck('★反面对照：强稿（有 n/种子/基线/消融/局限/可得/伦理/图表解读）⇒ 命中显著减少（不许无差别报警）', () => {
    const weak = rehearse(WEAK), strong = rehearse(STRONG);
    if (!(strong.counts.concerns < weak.counts.concerns)) return '强稿命中 ' + strong.counts.concerns + ' ≥ 弱稿 ' + weak.counts.concerns;
    if (strong.counts.concerns > 2) return '强稿仍有 ' + strong.counts.concerns + ' 条：' + JSON.stringify(strong.qa.map((q) => q.q));
    return true;
  });

  ck('★必失败面：**缺节只报"未检出"**，不得断言作者没做（未找到 ≠ 没有）', () => {
    const r = rehearse('# T\n## Method\nWe train a model.\n');
    const absent = r.qa.filter((q) => /未检出/.test(q.section));
    return absent.length ? true : '没有"未检出"标记：' + JSON.stringify(r.qa.map((q) => q.section));
  });

  ck('★必失败面：空稿 ⇒ SKIP（未预演）', () => {
    return (rehearse('   ').status === 'SKIP') ? true : '应为 SKIP';
  });

  ck('过度声称要给出行号锚点（可复核）', () => {
    const r = rehearse('# T\nWe propose a novel method here.\n');
    const c = r.qa.find((q) => /novel|first|state-of-the-art|显著/.test(q.q));
    return (c && c.line) ? true : JSON.stringify(c || null);
  });

  ck('--persona 过滤只出该画像', () => {
    const r = rehearse(WEAK, { persona: 'repro' });
    return r.qa.every((q) => q.persona === 'repro') ? true : JSON.stringify(r.qa.map((q) => q.persona));
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nrehearse 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const d = val('--draft');
  if (!d) { console.error('前提层失败：需要 --draft <稿.md>'); return 2; }
  const p = path.resolve(d);
  if (!fs.existsSync(p)) { console.error('前提层失败：稿件不存在 —— ' + p); return 2; }
  const r = rehearse(fs.readFileSync(p, 'utf8'), { persona: val('--persona') });
  if (r.status === 'SKIP') { console.error('SKIP：' + r.why); return 2; }
  if (argv.includes('--json')) { console.log(JSON.stringify(r, null, 2)); return 0; }
  const out = val('--out'); const md = render(r);
  if (out) { fs.writeFileSync(path.resolve(out), md, 'utf8'); console.log('预演结果已写出：' + path.resolve(out)); }
  else console.log(md);
  console.log('状态：' + r.status + '（共 ' + r.counts.concerns + ' 条 · 方法 ' + r.counts.byPersona.methods + ' · 意义 ' + r.counts.byPersona.significance + ' · 复现 ' + r.counts.byPersona.repro + '）—— 模拟，不是真实审稿意见');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { rehearse, render, sections, RULES, PERSONAS, main, selftest };
