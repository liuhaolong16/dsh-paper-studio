#!/usr/bin/env node
/**
 * generate — 分节写作简报 + 真·正文生成（模型可插拔）
 *
 * 为什么需要它：`studio draft` 只生成**规划文档**（骨架、证据表、跑法），不产正文；
 * 而"论文正文"又不可能由插件凭空写出——它需要模型。本工具把两者接起来：
 *   ① `--brief`  把提纲变成**分节写作简报**：每节的目标 / 必现要素 / 禁用词 / 证据槽 / 字数预算
 *   ② `--run`    逐节调用 **OpenAI 兼容** 的 /chat/completions 生成正文 → 拼成整稿 → 立刻跑门
 *   ③ `--retries` 把门的**具体问题行**回喂给模型重写（不是"再试一次"这种空话）
 *
 * ★ 模型从哪来（三档，按序回落，**每档都明说用了哪个**）：
 *   ① **显式配置**：`PAPER_STUDIO_LLM_BASE/KEY/MODEL` 或 `--base/--model`；`--engine env` 强制只用这一档（缺即 exit 2，**不偷换**）
 *   ② **面板凭据**：`bin/keys-store.cjs` 里已启用的 provider（与面板 / `studio.cjs model keys` 共用同一份本机存储）
 *   ③ **免 key 本地引擎（自动发现）**：Ollama `127.0.0.1:11434/v1` · LM Studio `:1234/v1` · llama.cpp `:8080/v1`
 *      ⇒ 一条 key 都没有也能逐节生成；`--probe` 只报发现结果、不耗算力
 * ★ 一台真模型都没有时**不静默拼模板**：要么 exit 2 说清缺什么，要么你**显式**要 `--scaffold` 骨架模式
 *   （骨架带「待填」槽位 + `engine=scaffold` 标注，任何环节都不当模型正文交付）。
 * ★ 纪律：生成结果一律标注 `<!-- generated:engine=... model=... -->`，并输出"门读数"；
 *   门不过就报具体项，**不把生成成功当成交付成功**。
 *
 * 用法：
 *   node bin/generate.cjs --probe                        # 本机有哪条模型通道（不生成）
 *   node bin/generate.cjs --demo-spec --out spec.json
 *   node bin/generate.cjs --brief --spec spec.json --out briefs/
 *   node bin/generate.cjs --run --briefs briefs/ --out draft/ [--model m] [--base url] [--retries 2]
 *   node bin/generate.cjs --run --briefs briefs/ --out draft/ --engine local|env|auto
 *   node bin/generate.cjs --scaffold --briefs briefs/ --out draft/     # 无模型：出骨架，不冒充正文
 *   node bin/generate.cjs --selftest
 * 退出码：0 成功 · 1 门未过/生成失败 · 2 前提层失败（无可用模型/缺文件）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/**
 * 禁用词只从**词级**真源取：`revise.AI_MARKERS`（AI 腔标记）+ `stylecheck.WORD_LISTS.FILLERS`（填充词）。
 *
 * ★ 为什么不能把所有 WORD_LISTS 都抽一遍：`FORBIDDEN_OPENING` 是**句首短语规则**
 *   （如 "In recent years, deep learning ..."），抽词会得到 `machine` / `learning` / `large` / `language`
 *   —— 把机器学习论文的核心词当禁用词，等于让生成器无法写方法。这条是被 `--brief` 的实测输出抓出来的。
 */
function literalsOf(re) {
  return [...new Set(String(re)
    .split('|')
    .map((s) => s.replace(/\(\?<[^)]*\)|\(\?[=!][^)]*\)|\\b|\\s\*?|\\\.|\[[^\]]*\]|[\\^$*+?.:(){}]/g, ' ')
      .replace(/\s+/g, ' ').trim().toLowerCase())
    .flatMap((s) => s.split(' '))
    .filter((w) => w.length >= 4 && /^[a-z]+$/.test(w)))];
}

/**
 * 过常用词剔除表：这些词在 AI_MARKERS 里是**短语**的一部分（如 `state-of-the-art`），
 * 单独抽出来当禁用词会误伤正常学术表达——实测里 `state that ...` 被判"使用禁用词"就是这个假阳性。
 * 只保留真正的 AI 腔（delve / pivotal / seamless / comprehensive / holistic / testament / realm ...）。
 */
const OVERCOMMON = new Set([
  'state', 'only', 'also', 'into', 'plays', 'play', 'role', 'game', 'framework', 'solution',
  'understanding', 'significant', 'crucial', 'vital', 'show', 'shows', 'result', 'results',
  'that', 'this', 'with', 'from', 'chang', 'leverag', 'showcas',
]);

function bannedWords() {
  try {
    const rv = require(path.join(__dirname, 'revise.cjs'));
    const sc = require(path.join(__dirname, 'stylecheck.cjs'));
    const markers = (rv.AI_MARKERS || []).flatMap((m) => literalsOf(m.re || m));
    const fillers = literalsOf((sc.WORD_LISTS && sc.WORD_LISTS.FILLERS) || '');
    return [...new Set([...markers, ...fillers])].filter((w) => !OVERCOMMON.has(w)).slice(0, 40);
  } catch (e) {
    return [];
  }
}

function demoSpec() {
  return {
    title: 'Demo paper',
    genre: 'research',
    sections: [
      {
        id: '1-intro',
        title: '1. Introduction',
        goal: '让读者认同"这个缺口值得研究"，并交代本文回答哪三个问题',
        must_have: ['运行示例或背景数据', '已有做法的具体不足（带引用）', '本文贡献三条以内'],
        words: 700,
      },
      {
        id: '2-method',
        title: '2. Methods',
        goal: '让同行能照着复现',
        must_have: ['数据来源与许可', '超参与选择依据', '评价协议（避免自证）'],
        words: 900,
      },
    ],
  };
}

function briefFor(section, spec) {
  return {
    id: section.id,
    title: section.title,
    role: 'author',
    lang: section.lang || spec.lang || 'en',
    goal: section.goal || '',
    must_have: section.must_have || [],
    words: section.words || 600,
    banned: bannedWords(),
    evidence_slots: (section.must_have || []).map((m) => ({ claim: m, evidence: '', source: '' })),
    rules: [
      '每段首句是断言，且断言后面必须紧跟支撑（数字/引用/图表/因果）',
      '不做超出证据的因果表述；限定词保留',
      '不出现"delve / leverage / robust / seamless"这类空词',
      '节内不得出现未定义缩写；首次使用给定义',
      '正文第一行就是句子：**不要回显 ## / ### 小节标题**（标题由上游写）',
    ],
    paper_title: spec.title || '',
  };
}

function buildBriefs(spec, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  spec.sections.forEach((s, i) => {
    const b = briefFor(s, spec);
    const p = path.join(outDir, String(i + 1).padStart(2, '0') + '-' + s.id + '.json');
    fs.writeFileSync(p, JSON.stringify(b, null, 2) + '\n', 'utf8');
    written.push(p);
  });
  return written;
}

function promptFor(brief, priorIssues) {
  const langName = brief.lang === 'zh' ? 'Chinese (简体中文)' : (brief.lang || 'en');
  const lines = [
    'You are drafting ONE section of an academic paper.',
    'Paper title: ' + (brief.paper_title || '(untitled)'),
    'Section: ' + brief.title,
    'Goal: ' + brief.goal,
    'Length: about ' + brief.words + ' words.',
    '',
    // ★ 语言必须显式钉住：简报里的 goal/must_have 常是中文（写给人看的），弱模型会照着中文写成中文正文。
    //   实测：qwen2.5-3b 在没这句时会整节输出中文，且字数按拉丁词计只有 6 词。
    'OUTPUT LANGUAGE: ' + langName + ' ONLY. The labels above are written for a human editor;'
      + ' they are NOT the language of your output.',
    '',
    'Must appear in this section:',
    ...brief.must_have.map((m) => '- ' + m),
    '',
    'Hard rules:',
    ...brief.rules.map((r) => '- ' + r),
    '',
    'Forbidden words (never use): ' + brief.banned.slice(0, 20).join(', '),
    '',
    'Output ONLY the section prose. No heading of any kind, no meta commentary.',
  ];
  if (priorIssues && priorIssues.length) {
    lines.push('', 'Fix these specific problems from the previous attempt:');
    priorIssues.forEach((p) => lines.push('- ' + p));
  }
  return lines.join('\n');
}

function post(urlStr, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(bodyObj), 'utf8');
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers),
      timeout: 180000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('请求超时 180s')));
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
}

/**
 * 免 key 本地引擎候选。
 * ★ 为什么先 Ollama：它是本机唯一**自带模型清单**的（`/api/tags` 直接给出有什么模型），
 *   不用让用户猜模型名；另外两个走 OpenAI 兼容的 `/v1/models`。
 * ★ 端口写死在这里而不是"扫全网段"：扫描既慢又会被安全软件拦，且这三条覆盖了 99% 的本机部署。
 */
const LOCAL_PROBES = [
  { id: 'local-ollama', label: 'Ollama', base: 'http://127.0.0.1:11434/v1', tags: '/api/tags' },
  { id: 'local-lmstudio', label: 'LM Studio', base: 'http://127.0.0.1:1234/v1', tags: '/models' },
  { id: 'local-llamacpp', label: 'llama.cpp', base: 'http://127.0.0.1:8080/v1', tags: '/models' },
];

function getJson(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, timeout: timeoutMs || 1500,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

/**
 * 本地模型挑哪个：**参数量 > 指令微调 > 上下文够用 > 非视觉**。
 * ★ 2026-10-19 修正：上一版把"大上下文"给到 30 分，导致装了 7B 之后**仍然会选 3B-32k**
 *   （实测：`qwen2.5-3b-32k` 胜 `qwen2.5:7b-instruct`）。而写一节正文只需要 2–4k 上下文，
 *   32k 早够 —— 让上下文压倒参数量等于"装了更好的模型却不用它"。
 *   现在参数量上限 40 分（14B 打满、7B 约 21、3B 约 10.5），上下文只做"够用即加分"（6 分）。
 */
function scoreModel(name) {
  const n = String(name || '').toLowerCase();
  let s = 0;
  const m = /(\d+(?:\.\d+)?)\s*b(?![a-z0-9])/.exec(n);
  if (m) s += Math.min(40, Number(m[1]) * 1.5);
  if (/32k|64k|128k|65536|131072/.test(n)) s += 6;
  else if (/16k|8k/.test(n)) s += 4;
  if (/instruct|chat/.test(n)) s += 5;                                  // 没微调过的基座不听指令
  if (/(^|[^a-z])(vl|vision|llava|mmproj)([^a-z]|$)/.test(n)) s -= 25;   // 视觉模型写论文次优
  return s;
}

/** 探本地引擎：返回第一个**真的在跑且有模型**的；全都探不到返回 null（不是错误，交给上层分型）。 */
async function probeLocal(probes) {
  const list = Array.isArray(probes) ? probes : LOCAL_PROBES;
  for (const p of list) {
    const root = p.base.replace(/\/v1$/, '');
    const j = await getJson(root + p.tags, 1500);
    if (!j) continue;
    const names = Array.isArray(j.models) ? j.models.map((m) => m.name || m.model)
      : Array.isArray(j.data) ? j.data.map((m) => m.id) : [];
    const clean = names.filter((x) => typeof x === 'string' && x.trim());
    if (!clean.length) continue;
    clean.sort((a, b) => scoreModel(b) - scoreModel(a));
    return {
      base: p.base, model: clean[0], engine: p.id, label: p.label,
      why: p.label + ' 在跑；模型按「上下文 > 参数量」排序取第一个，可换的还有 ' + clean.slice(1, 4).join(', '),
      candidates: clean,
    };
  }
  return null;
}

function isLocalHost(base) {
  try { return /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i.test(new URL(base).hostname); } catch (e) { return false; }
}

/**
 * 面板凭据（`bin/keys-store.cjs` 是**唯一真源**，与面板/CLI 共用一份本机存储）。
 * 只取 `enabled !== false` 且 base_url+model 齐的那条；非本机地址还要求有 key。
 */
function panelEngine() {
  try {
    const ks = require(path.join(__dirname, 'keys-store.cjs'));
    const r = ks.read();
    if (!r || !r.ok) return null;
    const providers = (r.doc && r.doc.providers) || {};
    for (const pid of Object.keys(providers)) {
      const v = providers[pid] || {};
      if (v.enabled === false) continue;
      const base = String(v.base_url || '').trim();
      const model = String(v.model || '').trim();
      const key = String(v.key || '').trim();
      if (!base || !model) continue;
      if (!key && !isLocalHost(base)) continue;
      return { base, key, model, engine: 'panel:' + pid, why: '面板凭据（keys-store，与面板/CLI 同一份本机存储）' };
    }
    return null;
  } catch (e) { return null; }
}

/**
 * 引擎解析：**顺序固定，且必须回传 engine 名**（provenance 靠它，绝不把"文本是谁写的"藏起来）。
 * `--engine env` = 只用显式配置（企业/合规场景要能锁定）；`--engine local` = 只用本机引擎。
 */
async function resolveEngine(argv, opts = {}) {
  const want = argOf(argv, '--engine') || 'auto';
  const base = argOf(argv, '--base') || process.env.PAPER_STUDIO_LLM_BASE || '';
  const model = argOf(argv, '--model') || process.env.PAPER_STUDIO_LLM_MODEL || '';
  const key = process.env.PAPER_STUDIO_LLM_KEY || '';

  if (want === 'env' || want === 'explicit') {
    const missing = [];
    if (!base) missing.push('PAPER_STUDIO_LLM_BASE');
    if (!model) missing.push('PAPER_STUDIO_LLM_MODEL');
    if (!key && !isLocalHost(base)) missing.push('PAPER_STUDIO_LLM_KEY');
    if (missing.length) return { error: '前提层失败：--engine env 要求显式配置，缺 ' + missing.join(' / '), missing };
    return { base, key, model, engine: isLocalHost(base) ? 'env-localhost' : 'env', why: '显式配置（--engine env 锁定）' };
  }
  if (base && model && (key || isLocalHost(base))) {
    return { base, key, model, engine: isLocalHost(base) ? 'env-localhost' : 'env', why: '环境变量/参数' };
  }
  if (!opts.noPanel) {
    const panel = panelEngine();
    if (panel) return panel;
  }
  const loc = await probeLocal(opts.probes);
  if (loc) return loc;
  return {
    error: '前提层失败：没有任何可用模型通道（显式配置为空 · 面板无已启用 provider · 本机没探到 Ollama/LM Studio/llama.cpp）',
    missing: ['PAPER_STUDIO_LLM_BASE', 'PAPER_STUDIO_LLM_KEY', 'PAPER_STUDIO_LLM_MODEL'],
  };
}

/**
 * 宿主接管包（--host-handoff）：把「这一节该写成什么」变成**给宿主模型的写作任务书**。
 * 为什么需要它：本地模型不写正文（会自造素材），而宿主模型有全场上下文与用户素材。
 * 于是分工固定为：**插件出规格 → 宿主写正文 → 门做判据**。
 */
function hostHandoff(briefDir, outDir) {
  const briefs = fs.readdirSync(briefDir).filter((f) => f.endsWith('.json')).sort();
  if (!briefs.length) return { error: '前提层失败：' + briefDir + ' 里没有简报 json' };
  fs.mkdirSync(outDir, { recursive: true });
  const files = [];
  briefs.forEach((f) => {
    const brief = JSON.parse(fs.readFileSync(path.join(briefDir, f), 'utf8'));
    const prompt = promptFor(brief, []);
    const target = path.join(outDir, f.replace(/\.json$/, '.md'));
    const words = brief.words || 600;
    const md = [
      '<!-- host-handoff:section=' + brief.id + ' · spec=host-model -->',
      '# 写作任务书 · ' + brief.title,
      '',
      '> 这是给**宿主模型**的写作指令，**不是正文**。写完把正文写回同名 `.md`（去掉 `.prompt`）。',
      '> 铁律：**不得编造素材** —— 没有的数据/引用/机构/年份一律写「待补」并注明需要作者提供什么。',
      '',
      '## 产出规格',
      '- 回填路径：`' + target + '`',
      '- 题头：`<!-- generated:engine=host model=<填模型名> · section=' + brief.id + ' -->`',
      '- 正文标题：`## ' + brief.title + '`',
      '- 语言：' + (brief.lang === 'zh' ? '中文' : 'English only')
        + ' · 字数：约 ' + words + ' 词（合格带 ' + Math.round(words * 0.5) + '–' + Math.round(words * 1.8) + '）',
      '- 写完就跑门：`node bin/paragraph-logic.cjs --draft <拼稿>`（**门读数才是判据**）',
      '',
      '## 提示词原文（可直接投给宿主模型）',
      '```text',
      prompt,
      '```',
      '',
    ].join('\n');
    const p = path.join(outDir, f.replace(/\.json$/, '.prompt.md'));
    fs.writeFileSync(p, md, 'utf8');
    files.push(p);
  });
  const readme = [
    '# 宿主接管说明（--host-handoff）',
    '',
    '本地引擎**不写正文**：实测会自造素材（"气候变化与小农户"、"NHANES 2015-2016"），那不是草稿而是编造。',
    '分工固定为：**插件出规格 → 宿主写正文 → 门做判据**。',
    '',
    '## 怎么用',
    '1. 宿主模型逐节读 `NN-<id>.prompt.md`，按「提示词原文」写正文；',
    '2. 把正文写回同目录 `NN-<id>.md`（带题头与 `## 标题`，只写正文、不回显标题）；',
    '3. 拼稿后跑门：`node bin/paragraph-logic.cjs --draft draft/assembled.md`；',
    '4. 要本地模型帮忙**审查**：`node bin/generate.cjs --review --draft draft/NN-<id>.md`（只出建议、不改稿、不当判据）。',
    '',
    '★ 纪律：任何「因为没有数据就编一段」都不允许 —— 缺素材就写「待补」并要求作者提供。',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'README-HANDOFF.md'), readme, 'utf8');
  return { files, readme: path.join(outDir, 'README-HANDOFF.md') };
}

/**
 * 审查/校正（--review）：**默认纯机检（零模型、可复现）**，模型只在 `--with-model` 时对**已发现的问题**给建议。
 *
 * ★ 2026-10-19 实测换来的设计：先让 7B 自己"找问题"，对一份故意塞了 4 类缺陷的稿子（未定义缩写 XQZ/SPQ、
 *   72 词长句、中文片段、无支撑断言）它回了 **NO-ISSUES**，3.4 秒。也就是说"让本地模型自由审查"＝假安全感。
 *   正确分工：**发现归确定性机检**（stylecheck / paragraph-logic / tense-check，零 key、可复现），
 *   **建议归模型**（只针对机检已报出的那几句），且模型的建议一律标 advisory、不改稿、不当判据。
 */
const REVIEW_TOOLS = [
  { id: 'stylecheck', args: (f) => ['--draft', f] },
  { id: 'paragraph-logic', args: (f) => ['--draft', f] },
  { id: 'tense-check', args: (f) => ['--draft', f] },
];

/**
 * 内置确定性小检查（零依赖）：这些正是"让 7B 自己找"时它**全部漏掉**的类别
 * （实测：故意塞了未定义缩写 XQZ/SPQ、72 词长句、中文片段、无支撑断言 ⇒ 它回 NO-ISSUES）。
 * 只报「能逐条指到原文」的事实，不做语义判断。
 */
const ABBREV_WHITELIST = new Set(['AI', 'ML', 'DL', 'NLP', 'LLM', 'LLMS', 'GPU', 'CPU', 'API', 'DOI', 'PDF',
  'RSS', 'URL', 'HTTP', 'HTTPS', 'USA', 'UK', 'EU', 'IEEE', 'ACM', 'RCT', 'CI', 'SD', 'RMSE', 'MAE', 'MAPE']);

function builtinChecks(text, lang) {
  const out = [];
  const lines = String(text || '').split('\n');
  // ① 语言混入（英文稿里出现成段中文 / 中文稿里出现成段英文，本工具只判前者）
  if (lang !== 'zh') {
    const hits = [];
    lines.forEach((l, i) => {
      const cjk = (l.match(/[\u4e00-\u9fff]/g) || []).length;
      if (cjk >= 4) hits.push('L' + (i + 1) + '：含中文 ' + cjk + ' 字 — ' + l.trim().slice(0, 60));
    });
    out.push({ id: 'lang-fragment', status: hits.length ? 'WARN' : 'OK', out: hits.length ? hits.join('\n') : '未发现中文片段' });
  }
  // ② 未定义缩写：全大写 2–6 字母，第一次出现处前后 40 字符内没有括号展开
  const abbrevBad = [];
  const body = String(text || '');
  const seen = new Set();
  const re = /\b([A-Z]{2,6})\b/g;
  let m;
  while ((m = re.exec(body))) {
    const t = m[1];
    if (ABBREV_WHITELIST.has(t) || seen.has(t)) continue;
    seen.add(t);
    const around = body.slice(Math.max(0, m.index - 40), m.index + t.length + 40);
    const defined = new RegExp('\\(\\s*' + t + '\\s*\\)').test(around)
      || new RegExp(t + '[^()\\n]{0,30}\\([^)]{3,60}\\)').test(around)
      || new RegExp('\\([^)]{3,40}\\s' + t + '\\)').test(around);
    if (!defined) {
      const lineNo = body.slice(0, m.index).split('\n').length;
      abbrevBad.push('L' + lineNo + '：' + t + ' 首次出现处未给展开');
    }
  }
  out.push({ id: 'abbrev-undefined', status: abbrevBad.length ? 'WARN' : 'OK', out: abbrevBad.length ? abbrevBad.join('\n') : '未发现未定义缩写' });
  // ③ 超长句（>45 词）
  const longSent = [];
  String(text || '').split(/(?<=[.!?。！？])\s+/).forEach((s) => {
    const w = (s.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
    if (w > 45) longSent.push(w + ' 词 — ' + s.trim().slice(0, 90) + '…');
  });
  out.push({ id: 'sentence-over-45', status: longSent.length ? 'WARN' : 'OK', out: longSent.length ? longSent.join('\n') : '未发现超长句' });
  return out;
}

function runMachineChecks(draft, opts = {}) {
  const results = [];
  try {
    const text = fs.readFileSync(draft, 'utf8');
    const lang = opts.lang || 'en';
    for (const c of builtinChecks(text, lang)) results.push(c);
  } catch (e) { results.push({ id: 'builtin', status: 'MISSING', out: '读不到稿件：' + e.message }); }
  for (const t of REVIEW_TOOLS) {
    const script = path.join(__dirname, t.id === 'stylecheck' ? 'stylecheck.cjs' : (t.id + '.cjs'));
    if (!fs.existsSync(script)) { results.push({ id: t.id, status: 'MISSING', out: '脚本不存在：' + path.basename(script) }); continue; }
    const r = (opts.spawnFn || spawnSync)(process.execPath, [script].concat(t.args(draft)), { encoding: 'utf8', timeout: 120000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    const m = /(?:状态|判定)[：:]\s*([A-Z_]+)/.exec(out) || /(PASS|REVIEW|ISSUES|WARN|FAIL|SKIP|OK)\b/.exec(out);
    results.push({ id: t.id, status: m ? m[1] : (r.status === 0 ? 'OK' : 'EXIT_' + r.status), out });
  }
  return results;
}

/** 只把机检**报出来的问题行**交给模型，让它逐条给「改写建议」——不给它自由发现的机会。 */
function suggestPrompt(issueText) {
  return [
    'You are a copy-editor. You are given a list of ALREADY-DETECTED issues from deterministic checkers.',
    'For each issue, give ONE concrete minimal fix in the same line format: ISSUE #n | FIX',
    'Do not invent new issues. Do not rewrite whole paragraphs. If you cannot fix an issue, write ISSUE #n | (needs author)',
    '',
    issueText,
  ].join('\n');
}

async function askVia(eng, prompt, opts = {}) {
  const url = opts.mockUrl || (String(eng.base || '').replace(/\/$/, '') + '/chat/completions');
  let res;
  try {
    res = await (opts.postFn || post)(url, eng.key ? { Authorization: 'Bearer ' + eng.key } : {}, {
      model: eng.model || 'mock', temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) { return { ok: false, error: e.message }; }
  if (res.status !== 200) return { ok: false, error: 'HTTP ' + res.status + ' · ' + String(res.body || '').slice(0, 160) };
  try {
    const j = JSON.parse(res.body);
    const text = ((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
    return { ok: true, text };
  } catch (e) { return { ok: false, error: '响应不是 JSON' }; }
}

async function runReview(draftPaths, argv, opts = {}) {
  if (!draftPaths.length) { console.error('前提层失败：--review 需要 --draft <稿.md>'); return 2; }
  const withModel = argv.includes('--with-model');
  let eng = null;
  if (withModel) {
    eng = opts.mockUrl
      ? { base: '', model: argOf(argv, '--model') || 'mock', engine: 'mock', key: '' }
      : await resolveEngine(argv, opts);
    if (eng.error) { console.error('提示：拿不到引擎 ⇒ 本次只跑机检（模型建议跳过）。'); eng = null; }
  }
  console.log('审查模式：' + (eng ? '机检 + 模型建议（模型只对已发现的问题给建议）' : '**纯机检（零模型、可复现）**'));
  let failed = 0;
  for (const d of draftPaths) {
    if (!fs.existsSync(d)) { console.error('前提层失败：文件不存在 ' + d); return 2; }
    const before = Buffer.from(fs.readFileSync(d)).toString('base64');
    const checks = runMachineChecks(d, opts);
    const flagged = checks.filter((c) => /REVIEW|ISSUES|WARN|FAIL/.test(c.status));
    let modelLines = [];
    let modelNote = '（未启用模型建议）';
    if (eng && flagged.length) {
      const issueText = flagged.map((c) => '[' + c.id + ' · ' + c.status + ']\n' + c.out.split('\n').slice(0, 40).join('\n')).join('\n\n');
      const r = await askVia(eng, suggestPrompt(issueText), opts);
      if (r.ok) {
        modelLines = r.text.split('\n').map((l) => l.trim()).filter((l) => /^ISSUE\s*#\d+\s*\|/.test(l))
          .map((l) => '- （模型建议）' + l.replace(/^ISSUE\s*#(\d+)\s*\|/, '第 $1 条 →'));
        modelNote = modelLines.length ? '模型给了 ' + modelLines.length + ' 条建议' : '模型没给出可用建议（已丢弃其自由发挥）';
      } else { modelNote = '模型调用失败：' + r.error; }
    } else if (eng) {
      modelNote = '机检没报问题 ⇒ 不浪费算力让模型找问题（实测它会对真有缺陷的稿子回 NO-ISSUES）';
    }
    const after = Buffer.from(fs.readFileSync(d)).toString('base64');
    const out = d.replace(/\.md$/, '') + '.review.md';
    const body = [
      '<!-- review:deterministic engine=' + (eng ? eng.engine + ':' + eng.model : 'none') + ' -->',
      '# 审查报告 · ' + path.basename(d),
      '',
      '> 分工：**发现问题＝确定性机检**（零 key、可复现）· **模型只对已发现的问题给建议**（advisory，不改稿）。',
      '> 原稿未被改动：' + (before === after ? '✔ 字节未变' : '✘ 变了（这是 bug，请报告）'),
      '',
      '## 一、机检发现（确定性）',
      ...checks.map((c) => '- **' + c.id + '**：' + c.status + (/REVIEW|ISSUES|WARN|FAIL/.test(c.status) ? ' ⚠' : '')),
      '',
      ...checks.filter((c) => /REVIEW|ISSUES|WARN|FAIL/.test(c.status)).map((c) => [
        '<details><summary>' + c.id + ' · ' + c.status + '</summary>', '', '```text',
        c.out.split('\n').slice(0, 60).join('\n'), '```', '', '</details>', ''].join('\n')),
      '## 二、模型建议（advisory · 不做判据）',
      modelNote,
      ...modelLines,
      '',
      '---',
      '机器判据仍是门：`node bin/paragraph-logic.cjs --draft <稿>` / `presubmit-all`。',
      '',
    ].filter((x) => x !== '').join('\n');
    fs.writeFileSync(out, body, 'utf8');
    console.log('✔ ' + path.basename(d) + ' → ' + out + '（机检 ' + checks.length + ' 项，其中 ' + flagged.length + ' 项有问题）');
    if (flagged.length) failed += 1;
  }
  return 0; // advisory：不因发现而失败（判据在门那里）
}

/** 骨架模式：没有模型也要能出**可填的**东西，但必须长着一张"骨架脸"（槽位 + 标注），不冒充正文。 */
function scaffoldFor(brief) {
  const must = (brief.must_have || []).filter(Boolean);
  const n = Math.max(3, Math.min(6, must.length + 2));
  const words = brief.words || 600;
  const out = [];
  out.push('> **骨架模式（engine=scaffold）**：下面**不是模型写出的正文**，是待填槽位。');
  out.push('> 每个「待填」都要求一条**可核验的支撑**；填完再跑 `paragraph-logic` 复读。');
  out.push('');
  out.push('**本节目标**：' + (brief.goal || '（未给——先补 goal，否则写什么都是空话）'));
  out.push('**字数预算**：约 ' + words + ' 词（合格带 ' + Math.round(words * 0.5) + '–' + Math.round(words * 1.8) + '）');
  out.push('');
  for (let i = 1; i <= n; i += 1) {
    const slot = must[i - 1] || '';
    out.push('**断言 ' + i + '（待填）**：<这一段的主题句；必须是可被证伪的断言，不是"随着…发展">');
    out.push('- 支撑：<' + (slot || '数字 / 引用 / 图号 / 因果链') + '>');
    out.push('- 出处：<引用键 / 表号 / 图号>；拿不到就写「待补引用」，**不要编**');
    out.push('');
  }
  if (must.length) {
    out.push('**必现要素核对**（填完后逐条打勾，缺哪条就补哪条）：');
    must.forEach((m) => out.push('- [ ] ' + m));
    out.push('');
  }
  out.push('**本节不得出现**：' + ((brief.banned || []).slice(0, 12).join(', ') || '（词表为空）'));
  return out.join('\n');
}

async function runGeneration(briefDir, outDir, argv, opts = {}) {
  const briefs = fs.readdirSync(briefDir).filter((f) => f.endsWith('.json')).sort();
  if (!briefs.length) { console.error('前提层失败：' + briefDir + ' 里没有简报 json'); return 2; }
  const scaffoldMode = opts.scaffold === true || argv.includes('--scaffold') || argv.includes('--offline');

  let eng = null;
  if (scaffoldMode) {
    console.log('模式：scaffold（**骨架，不是正文**；零模型可用）');
  } else if (!opts.mockUrl) {
    eng = await resolveEngine(argv, opts);
    if (eng.error) {
      console.error(eng.error);
      console.error('  三条合法通道（任一即可）：');
      console.error('   ① 显式配置：set PAPER_STUDIO_LLM_BASE=... & set PAPER_STUDIO_LLM_MODEL=... & set PAPER_STUDIO_LLM_KEY=...');
      console.error('   ② 面板录入（bin/keys-store.cjs，与面板 / studio.cjs model keys 共用一份本机存储）');
      console.error('   ③ **免 key 本地引擎**：装 Ollama 后 ollama pull 一个带大上下文的模型（本工具自动发现 127.0.0.1:11434）');
      console.error('   另外：不想等模型就先 `--scaffold` 要**骨架模式**（带「待填」槽位，明确标注不是模型正文）。');
      console.error('  ★ 未配置不等于"生成了空稿"——本工具不会用模板拼接冒充正文。');
      return 2;
    }
    // ★ 2026-10-19 用户定的职责边界：**本地模型不写正文**，只做审查/校正。
    //   实测依据：7B 在只有「目标/必现要素」的简报上自造了「气候变化与小农户/FAO」「NHANES 2015-2016」
    //   整段内容 —— 像论文但与用户研究无关，等于替作者编造素材。写作交给宿主（或云端强模型）。
    if (/^local-/.test(eng.engine)) {
      console.error('拒绝：本地引擎（' + eng.engine + ' · ' + eng.model + '）**不承担正文写作**。');
      console.error('  实测它会在没有素材时自造领域内容（"气候变化与小农户/FAO"、"NHANES 2015-2016"），');
      console.error('  看起来像论文但与你的研究无关 —— 这属于替作者编造素材，不是草稿。');
      console.error('  两条合法路径：');
      console.error('   ① **写作交给宿主模型**：node bin/generate.cjs --host-handoff --briefs <目录> --out <目录>');
      console.error('      ⇒ 每节产出写作提示词（目标/必现要素/字数/语言/禁词），宿主写完回填 draft/ 再跑门；');
      console.error('   ② 云端强模型：配 PAPER_STUDIO_LLM_* 或面板凭据后 --run。');
      console.error('  ★ 本地引擎的正确用途是**审查/校正**：node bin/generate.cjs --review --draft <稿.md>');
      return 2;
    }
    console.log('引擎：' + eng.engine + ' · ' + eng.model + '（' + eng.why + '）');
  }
  fs.mkdirSync(outDir, { recursive: true });
  const retries = Number(argv.includes('--retries') ? argv[argv.indexOf('--retries') + 1] : 0) || 0;
  const parts = [];
  let failed = 0;

  for (const f of briefs) {
    const brief = JSON.parse(fs.readFileSync(path.join(briefDir, f), 'utf8'));
    if (!brief.goal) { console.error('简报 ' + f + ' 缺 goal —— 拒绝生成（没有目标的正文必然是空话）'); return 2; }
    let issues = [];
    let notes = [];
    let text = '';
    if (scaffoldMode) {
      text = scaffoldFor(brief);
      notes.push('骨架模式：本节是待填槽位，不是模型正文');
    } else {
      const useModel = opts.mockUrl ? (argOf(argv, '--model') || 'mock') : eng.model;
      const useBase = eng ? eng.base : '';
      const useKey = eng ? eng.key : '';
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const url = opts.mockUrl || (useBase.replace(/\/$/, '') + '/chat/completions');
        const payload = {
          model: useModel || 'mock', temperature: 0.2,
          messages: [{ role: 'user', content: promptFor(brief, issues) }],
        };
        let res;
        try {
          res = await post(url, useKey ? { Authorization: 'Bearer ' + useKey } : {}, payload);
        } catch (e) {
          console.error('生成失败（' + brief.title + '）：' + e.message);
          return 1;
        }
        if (res.status !== 200) {
          console.error('生成失败（' + brief.title + '）：HTTP ' + res.status + ' · ' + res.body.slice(0, 200));
          return 1;
        }
        try {
          const j = JSON.parse(res.body);
          text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
        } catch (e) {
          console.error('生成失败（' + brief.title + '）：响应不是 JSON · ' + res.body.slice(0, 160));
          return 1;
        }
        if (!text.trim()) { console.error('生成失败（' + brief.title + '）：模型返回空正文'); return 1; }
        text = stripEchoHeading(text, brief.title);
        if (!text.trim()) { console.error('生成失败（' + brief.title + '）：剥掉回显标题后没有正文了'); return 1; }
        // 当场自检：禁用词 / 语言 / 字数带 / 必现要素（中文要素记入 notes，不判红）
        notes = [];
        issues = quickIssues(text, brief, notes);
        if (!issues.length) break;
        if (attempt === retries) failed += 1;
      }
    }
    const out = path.join(outDir, f.replace(/\.json$/, '.md'));
    const engineName = scaffoldMode ? 'scaffold' : (opts.mockUrl ? 'mock' : eng.engine);
    const modelName = scaffoldMode ? '-' : (opts.mockUrl ? (argOf(argv, '--model') || 'mock') : eng.model);
    const prov = scaffoldMode
      ? '<!-- generated:engine=scaffold · section=' + brief.id + ' -->'
      : '<!-- generated:engine=' + engineName + ' model=' + modelName + ' · section=' + brief.id + ' -->';
    fs.writeFileSync(out, prov + '\n\n## ' + brief.title + '\n\n' + text.trim() + '\n', 'utf8');
    parts.push({ file: out, issues, notes });
    console.log('✔ ' + brief.title + ' → ' + out + (issues.length ? '（仍有 ' + issues.length + ' 条自检问题）' : ''));
    notes.forEach((n) => console.log('  · ' + n));
  }

  const assembled = path.join(outDir, 'assembled.md');
  fs.writeFileSync(assembled, parts.map((p) => fs.readFileSync(p.file, 'utf8')).join('\n'), 'utf8');
  console.log('\n拼稿：' + assembled);

  if (scaffoldMode) {
    // 骨架**不是正文**，所以跑散文门只会得到一堆假信号 ⇒ 明确跳过并说清原因（未检查≠通过）
    console.log('门（paragraph-logic）：⚠ 未运行 —— 骨架模式不产散文，跑了只会得到假信号');
    console.log('  ★ 骨架已就绪：把每个「待填」补成带证据的断言后，再 `--run` 或跑 paragraph-logic。');
    return 0;
  }

  // 门读数：用现成的 paragraph-logic（纯本地、无网络）
  const gate = spawnSync(process.execPath, [path.join(__dirname, 'paragraph-logic.cjs'), '--draft', assembled],
    { encoding: 'utf8', timeout: 120000 });
  const gateOut = (gate.stdout || '') + (gate.stderr || '');
  console.log('门（paragraph-logic）：' + (/状态：\s*(\w+)/.exec(gateOut) ? RegExp.$1 : (gate.status === 0 ? 'OK' : '见输出')));
  const allIssues = parts.reduce((a, p) => a.concat(p.issues), []);
  if (allIssues.length) {
    console.log('\n生成后仍有问题（' + allIssues.length + ' 条）：');
    allIssues.slice(0, 12).forEach((i) => console.log('  - ' + i));
  }
  return allIssues.length ? 1 : 0;
}

/** 生成后当场自检：这些是**纯本地可判**的，不依赖模型自评。
 *  ★ 中英混排的现实：简报里的必现要素常写成中文（如"数据来源与许可"），而正文是英文，
 *    用中文子串去英文正文里找必然"缺失" ⇒ 假阳性。改法：**CJK 要素一律记为"待人确认"**（不判红），
 *    只有 ASCII 要素才做子串机检。这条是拿 chinese must_have + 英文正文实测出来的。
 *  ★ 语言守门（2026-10-18 实测换来的）：给 3B 本地模型中文简报时，它会**整节输出中文**；
 *    而字数按拉丁词计只有 6 词——不报"语言不对"就只会报"字数偏少"，把根因藏起来。
 */
function quickIssues(text, brief, notes) {
  const issues = [];
  const lower = text.toLowerCase();
  const lang = brief.lang || 'en';
  const hit = (brief.banned || []).filter((w) => w.length > 4 && new RegExp('\\b' + w + '\\b', 'i').test(lower));
  if (hit.length) issues.push('使用了禁用词：' + [...new Set(hit)].slice(0, 6).join(', '));
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const latinWords = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  if (lang === 'en' && cjk > 20 && cjk * 2 > latinWords * 3) {
    issues.push('语言不对：要求英文，但输出以中文为主（CJK ' + cjk + ' 字 / 拉丁 ' + latinWords + ' 词）');
  }
  if (lang === 'zh' && latinWords > 120 && latinWords > cjk) {
    issues.push('语言不对：要求中文，但输出以英文为主（拉丁 ' + latinWords + ' 词 / CJK ' + cjk + ' 字）');
  }
  const words = lang === 'zh' ? (cjk + latinWords) : latinWords;
  const lo = Math.round((brief.words || 600) * 0.5);
  const hi = Math.round((brief.words || 600) * 1.8);
  if (words < lo) issues.push('字数偏少：' + words + ' < ' + lo);
  if (words > hi) issues.push('字数偏多：' + words + ' > ' + hi);
  (brief.must_have || []).forEach((m) => {
    const isCjk = /[\u4e00-\u9fff]/.test(String(m));
    if (isCjk) { if (Array.isArray(notes)) notes.push('需人工确认（中文要素不做机检）：' + m); return; }
    const key = String(m).split(/[（(]/)[0].trim().slice(0, 6).toLowerCase();
    if (key && !lower.includes(key)) issues.push('缺必现要素："' + m + '"');
  });
  return issues;
}

/**
 * 剥掉模型**回显的小节标题**：prompt 已要求"不要标题"，但弱模型仍会写 `### 2. Methods`，
 * 甚至把 `2. Methods` 当**裸标题行**输出（不带 #）。两种情况都会让文件里出现重复标题
 * （实测 qwen2.5-3b 两种都必现）。
 * 规则：**正文出现之前**的回显标题一律剥掉；正文之后的子标题是内容，保留。
 */
function stripEchoHeading(text, title) {
  const titleNorm = String(title || '').replace(/^[\d.\s]+/, '').trim().toLowerCase();
  const out = [];
  let seenProse = false;
  for (const line of String(text || '').split('\n')) {
    const raw = line.trim();
    if (!seenProse) {
      const m = /^#{1,6}\s*(.*)$/.exec(raw);
      if (m) continue;                                  // 正文前的 Markdown 标题：剥
      if (!raw) { out.push(line); continue; }           // 空行原样留着
      const cand = raw.replace(/^[\d.\s]+/, '').trim().toLowerCase();
      const isBareTitle = cand && (cand === titleNorm
        || (cand.length >= 4 && cand.length <= 40
          && (titleNorm.includes(cand) || cand.includes(titleNorm))));
      if (isBareTitle) continue;                        // 裸标题行：剥
      seenProse = true;
    }
    out.push(line);
  }
  return out.join('\n').replace(/^\s+/, '');
}

/* ───────────── selftest（本地 mock，不联网、不需要 key） ───────────── */
async function selftest() {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-selftest-'));
  const results = [];
  const ck = (name, fn) => {
    let r;
    try { r = fn(); } catch (e) { r = 'THREW: ' + e.message; }
    results.push({ name, ok: r === true, why: r === true ? '' : String(r) });
  };
  const ckA = async (name, fn) => {
    let r;
    try { r = await fn(); } catch (e) { r = 'THREW: ' + e.message; }
    results.push({ name, ok: r === true, why: r === true ? '' : String(r) });
  };

  const spec = demoSpec();
  const briefDir = path.join(dir, 'briefs');
  const outDir = path.join(dir, 'draft');

  ck('--brief：每节一条简报，含 goal/must_have/banned', () => {
    const files = buildBriefs(spec, briefDir);
    if (files.length !== spec.sections.length) return '文件数不对';
    const b = JSON.parse(fs.readFileSync(files[0], 'utf8'));
    if (!b.goal) return '缺 goal';
    if (!b.must_have.length) return '缺 must_have';
    if (!Array.isArray(b.banned)) return '缺 banned';
    return true;
  });

  ck('★禁用词取自词级真源，且**不含** machine/learning/state 等常用词（防误禁）', () => {
    const w = bannedWords();
    if (!Array.isArray(w) || !w.length) return '禁用词为空（AI_MARKERS/FILLERS 未取到）';
    const bad = ['machine', 'learning', 'large', 'language', 'models', 'recent', 'state', 'only', 'also'].filter((x) => w.includes(x));
    if (bad.length) return '把常用词/术语当禁用词了：' + bad.join(', ');
    const tone = ['delve', 'pivotal', 'seamless', 'comprehensive', 'holistic'];
    return tone.some((t) => w.includes(t)) ? true : '没有任何 AI 腔词，词源可能是空的：' + w.slice(0, 8).join(',');
  });

  ck('prompt：含必现要素与禁用词，且明确"只输出正文"', () => {
    const b = briefFor(spec.sections[0], spec);
    const p = promptFor(b, ['字数偏少：100 < 350']);
    if (!p.includes('Must appear')) return '缺必现要素段';
    if (!p.includes('Forbidden words')) return '缺禁用词段';
    if (!/Output ONLY the section prose/.test(p)) return '缺输出约束';
    if (!p.includes('字数偏少')) return '上次问题没回喂';
    return true;
  });

  ck('quickIssues：禁用词/字数/必现要素缺失都要报', () => {
    const b = { words: 100, must_have: ['data source'], banned: ['delve'] };
    const iss = quickIssues('We delve a bit. Short.', b);
    const has = (re) => iss.some((x) => re.test(x));
    if (!has(/禁用词/)) return '没报禁用词';
    if (!has(/字数偏少/)) return '没报字数';
    if (!has(/缺必现要素/)) return '没报必现要素';
    return true;
  });

  ck('quickIssues：合格正文不报问题（防误报）', () => {
    const b = { words: 20, must_have: ['data source'], banned: ['delve'] };
    const text = 'The data source is described here. ' + 'word '.repeat(18);
    const iss = quickIssues(text, b);
    return iss.length === 0 ? true : JSON.stringify(iss);
  });

  // ★ 中英混排的现实：简报要素常写中文，正文是英文；用中文子串去英文里找必然"缺失"
  ck('★中英混排：中文必现要素记为"待人确认"，不判红（防假阳性）', () => {
    const b = { words: 20, must_have: ['数据来源与许可'], banned: [] };
    const notes = [];
    const iss = quickIssues('English prose about a data source. ' + 'word '.repeat(18), b, notes);
    if (iss.length) return '中文要素被判红了：' + JSON.stringify(iss);
    return notes.length === 1 && /需人工确认/.test(notes[0]) ? true : JSON.stringify(notes);
  });

  // ★ 2026-10-18 实测换来的两条：给 3B 本地模型中文简报时，它会**整节写中文**并**回显 ### 标题**
  ck('★语言守门：要求英文却整节写中文 ⇒ 报「语言不对」（不许只报"字数偏少"把根因藏起来）', () => {
    const b = { words: 300, must_have: [], banned: [], lang: 'en' };
    const zh = '本研究的数据来源包括公开数据库，这些数据均遵循许可协议。'.repeat(6);
    const iss = quickIssues(zh, b);
    const hasLang = iss.some((x) => /语言不对/.test(x));
    const hasWords = iss.some((x) => /字数偏少/.test(x));
    return (hasLang && hasWords) ? true : '语言=' + hasLang + ' 字数=' + hasWords;
  });

  ck('★语言守门：要求中文时按中文字数计（不能拿拉丁词数判"字数偏少"）', () => {
    const b = { words: 100, must_have: [], banned: [], lang: 'zh' };
    const zh = '本研究的数据来源包括公开数据库，并遵循相应的许可协议。'.repeat(4);
    const iss = quickIssues(zh, b);
    return iss.some((x) => /字数偏少/.test(x)) ? ('仍报字数偏少：' + JSON.stringify(iss)) : true;
  });

  ck('★stripEchoHeading：Markdown 标题与**裸标题行**都剥，正文后子标题保留', () => {
    // 真实形状（qwen2.5-3b 实测）：先 `### 2. Methods`，再裸标题 `2. Methods`
    const t = '### 2. Methods\n\n2. Methods\n\nTo ensure the section is replicable, we detail sources.\n\n### Data\n\nWe used X.\n';
    const s = stripEchoHeading(t, '2. Methods');
    const first = (s.split('\n').find((l) => l.trim()) || '');
    if (/^#{1,6}\s/.test(first) || /^2\.\s*Methods$/i.test(first)) return '正文第一行还是标题：' + JSON.stringify(first.slice(0, 40));
    if (!/To ensure the section is replicable/.test(s)) return '正文被吃了';
    return /### Data/.test(s) ? true : '正文后的子标题被误删';
  });

  ck('★prompt：语言被显式钉住（简报是中文也不许把中文当输出语言）', () => {
    const b = briefFor(spec.sections[0], spec);   // goal / must_have 都是中文
    const p = promptFor(b, []);
    if (!/OUTPUT LANGUAGE: en ONLY/.test(p)) return '没写输出语言';
    if (!/NOT the language of your output/.test(p)) return '没排除"照抄简报语言"';
    return /No heading of any kind/.test(p) ? true : '没禁标题';
  });

  // mock 端点：GET /api/tags 与 /v1/models 用来演"本地引擎发现"；POST /chat/completions 返回合格正文；/bad 返回 500
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.indexOf('/api/tags') === 0) {
        // 故意把视觉模型放前面：发现逻辑必须自己挑出 32k 那个
        return res.end(JSON.stringify({ models: [{ name: 'qwen2.5vl:3b' }, { name: 'qwen2.5-3b-32k:latest' }, { name: 'tiny-0.5b' }] }));
      }
      if (req.url.indexOf('/v1/models') === 0) {
        return res.end(JSON.stringify({ data: [{ id: 'mock-local-model' }] }));
      }
      return res.end('{}');
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url === '/bad') { res.writeHead(500); return res.end('boom'); }
      const payload = JSON.parse(body || '{}');
      const userMsg = (payload.messages || [{}])[0].content || '';
      const isIntro = userMsg.includes('1. Introduction');
      const text = isIntro
        ? '数据来源与许可是公开的。已有做法在跨温度下失效，因此本文给出三条贡献。' + 'word '.repeat(80)
        : '超参与选择依据如下。评价协议避免自证。' + 'word '.repeat(80);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const mockUrl = 'http://127.0.0.1:' + port + '/chat/completions';
  const mockProbes = [{ id: 'local-ollama', label: 'Ollama', base: 'http://127.0.0.1:' + port + '/v1', tags: '/api/tags' }];
  const noEnv = (fn) => {
    const saved = {
      b: process.env.PAPER_STUDIO_LLM_BASE, k: process.env.PAPER_STUDIO_LLM_KEY, m: process.env.PAPER_STUDIO_LLM_MODEL,
      f: process.env.DSH_PAPER_KEYS_FILE,
    };
    delete process.env.PAPER_STUDIO_LLM_BASE; delete process.env.PAPER_STUDIO_LLM_KEY; delete process.env.PAPER_STUDIO_LLM_MODEL;
    // 面板凭据指向不存在的文件 ⇒ 这一档必为空（否则本机真凭据会让"零 key"用例失真）
    process.env.DSH_PAPER_KEYS_FILE = path.join(dir, 'no-such-keys.json');
    return Promise.resolve().then(fn).finally(() => {
      if (saved.b) process.env.PAPER_STUDIO_LLM_BASE = saved.b; else delete process.env.PAPER_STUDIO_LLM_BASE;
      if (saved.k) process.env.PAPER_STUDIO_LLM_KEY = saved.k; else delete process.env.PAPER_STUDIO_LLM_KEY;
      if (saved.m) process.env.PAPER_STUDIO_LLM_MODEL = saved.m; else delete process.env.PAPER_STUDIO_LLM_MODEL;
      if (saved.f) process.env.DSH_PAPER_KEYS_FILE = saved.f; else delete process.env.DSH_PAPER_KEYS_FILE;
    });
  };

  await ckA('--run：mock 端点端到端生成 2 节并拼稿', async () => {
    const code = await runGeneration(briefDir, outDir, ['--model', 'mock-model'], { mockUrl });
    if (!fs.existsSync(path.join(outDir, 'assembled.md'))) return '没有拼稿';
    const n = fs.readdirSync(outDir).filter((f) => /\.md$/.test(f) && f !== 'assembled.md').length;
    if (n !== spec.sections.length) return '节数=' + n;
    return code === 0 || code === 1 ? true : 'code=' + code;
  });

  ck('生成物带 provenance 标注（engine + model）', () => {
    const f = fs.readdirSync(outDir).filter((x) => /^\d{2}-.*\.md$/.test(x))[0];
    const t = fs.readFileSync(path.join(outDir, f), 'utf8');
    return /<!-- generated:engine=mock model=mock-model/.test(t) ? true : '缺标注：' + t.split('\n')[0];
  });

  await ckA('★必失败面：模型返回 500 ⇒ exit 1 且说明原因', async () => {
    const badUrl = mockUrl.replace('/chat/completions', '/bad');
    const code = await runGeneration(briefDir, path.join(dir, 'draft-bad'), ['--model', 'm'], { mockUrl: badUrl });
    return code === 1 ? true : 'code=' + code;
  });

  await noEnv(async () => {
    await ckA('★必失败面：三档全空（无 env / 无面板 / 无本地引擎）⇒ exit 2（不静默用模板冒充正文）', async () => {
      const code = await runGeneration(briefDir, path.join(dir, 'draft-nokey'), [], { probes: [] });
      return code === 2 ? true : 'code=' + code;
    });
  });

  ck('★scoreModel：32k 文本模型 > 视觉模型(降权) > 小模型', () => {
    const ranked = ['qwen2.5vl:3b', 'qwen2.5-3b-32k:latest', 'tiny-0.5b'].sort((a, b) => scoreModel(b) - scoreModel(a));
    return ranked[0] === 'qwen2.5-3b-32k:latest' ? true : '排序=' + ranked.join(' > ');
  });

  await ckA('★probeLocal：从 mock 的 /api/tags 发现引擎并挑出 32k 模型', async () => {
    const r = await probeLocal(mockProbes);
    if (!r) return '没发现任何本地引擎';
    if (r.model !== 'qwen2.5-3b-32k:latest') return '挑错模型：' + r.model;
    return r.engine === 'local-ollama' ? true : '引擎名=' + r.engine;
  });

  // ★ 2026-10-19：原先这条臂断言「零 key 时本地引擎会写正文」—— 该行为已按用户要求**取消**，
  //   改由下面的「职责边界」臂守住相反方向（本地引擎必须拒绝写正文）。夹具随行为一起改，不留假绿。

  await noEnv(async () => {
    await ckA('★必失败面：--engine env 锁定但 env 为空 ⇒ exit 2（不许偷偷回落到本地引擎）', async () => {
      const code = await runGeneration(briefDir, path.join(dir, 'draft-forced'), ['--engine', 'env'], { probes: mockProbes });
      return code === 2 ? true : 'code=' + code;
    });
  });

  await noEnv(async () => {
    await ckA('★面板凭据也能当引擎：keys-store 里已启用的 provider ⇒ engine=panel:<id>', async () => {
      const kf = path.join(dir, 'keys.json');
      fs.writeFileSync(kf, JSON.stringify({
        version: 1,
        providers: { localp: { key: 'k', enabled: true, base_url: 'http://127.0.0.1:' + port + '/v1', model: 'panel-model' } },
      }), 'utf8');
      process.env.DSH_PAPER_KEYS_FILE = kf;
      const r = await resolveEngine([], { probes: mockProbes });
      if (r.error) return '解析失败：' + r.error;
      return (r.engine === 'panel:localp' && r.model === 'panel-model') ? true : JSON.stringify(r);
    });
  });

  await noEnv(async () => {
    await ckA('★--scaffold：零模型也出骨架，且明确标 engine=scaffold（不当正文交付）', async () => {
      const out = path.join(dir, 'draft-scaffold');
      const code = await runGeneration(briefDir, out, ['--scaffold'], { probes: [] });
      if (code !== 0) return 'code=' + code;
      const files = fs.readdirSync(out).filter((x) => /^\d{2}-.*\.md$/.test(x));
      if (files.length !== spec.sections.length) return '节数=' + files.length;
      const t = fs.readFileSync(path.join(out, files[0]), 'utf8');
      if (!/engine=scaffold/.test(t)) return '缺 engine=scaffold 标注';
      if (!/骨架模式/.test(t)) return '没明说这是骨架';
      if (/generated:model=/.test(t)) return '骨架被当成了模型正文';
      return /待填/.test(t) ? true : '没有待填槽位';
    });
  });

  await ckA('★必失败面：简报缺 goal ⇒ 拒绝生成并 exit 2', async () => {
    const d2 = path.join(dir, 'briefs-nogoal');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, '01-x.json'), JSON.stringify({ id: 'x', title: 'X', words: 100 }), 'utf8');
    const code = await runGeneration(d2, path.join(dir, 'draft-nogoal'), ['--model', 'm'], { mockUrl });
    return code === 2 ? true : 'code=' + code;
  });

  // server.close() 也必须在**所有臂之后**：下面几条臂还要用它探"本地引擎"
  // ★ 2026-10-19 用户定的职责边界：本地模型只做审查/校正，**正文写作交给宿主**
  //   注：清理临时目录必须放在**所有**用夹具的臂之后 —— 上一版把 rmSync 写在这里，
  //   结果后加的 5 条臂全因 briefs 已被删而红（自检立刻抓到，说明"先清理后测试"是自伤）。
  await noEnv(async () => {
    await ckA('★职责边界：只发现本地引擎时 --run 必须 exit 2 并说明「不承担正文写作」', async () => {
      const out = path.join(dir, 'draft-local-refused');
      let msg = '';
      const origErr = console.error;
      console.error = (...a) => { msg += a.join(' ') + '\n'; };
      let code;
      try { code = await runGeneration(briefDir, out, [], { probes: mockProbes }); } finally { console.error = origErr; }
      if (code !== 2) return 'code=' + code;
      if (!/不承担正文写作/.test(msg)) return '消息没说是职责边界：' + msg.slice(0, 140);
      return fs.existsSync(path.join(out, '01-1-intro.md')) ? '居然写出了正文文件' : true;
    });
  });

  ck('★--host-handoff：每节一份写作任务书 + README，含回填路径与「不得编造素材」', () => {
    const out = path.join(dir, 'handoff');
    const r = hostHandoff(briefDir, out);
    if (r.error) return r.error;
    if (r.files.length !== spec.sections.length) return '数量=' + r.files.length;
    const t = fs.readFileSync(r.files[0], 'utf8');
    if (!/写作任务书/.test(t)) return '缺标题';
    if (!/不得编造素材/.test(t)) return '缺「不得编造素材」纪律';
    if (!/回填路径/.test(t)) return '缺回填路径';
    if (!/Must appear/.test(t)) return '没带提示词原文';
    if (!fs.existsSync(r.readme)) return '缺 README';
    if (!/正文写作交给宿主|宿主写正文/.test(fs.readFileSync(r.readme, 'utf8'))) return 'README 没写分工';
    // 反控：剥掉 ``` 代码块后，任务书里不该出现长英文段落（那就是夹带正文了）
    const stripped = t.replace(/```[\s\S]*?```/g, '');
    const prose = stripped.split('\n').filter((l) => l.trim() && !/^[\s*>#\-|]/.test(l) && /[A-Za-z]/.test(l) && l.length > 200);
    return prose.length ? '疑似夹带正文：' + prose[0].slice(0, 60) : true;
  });

  ckA('★--review 默认**纯机检**（不调模型、原稿不变、三项机检齐全）', async () => {
    const d = path.join(dir, 'review-target.md');
    fs.writeFileSync(d, [
      '## 2. Methods',
      '',
      'The system is fast. It is also accurate. Users like it. It scales well. It is cheap. It is robust. It is simple. It is reliable.',
      '',
    ].join('\n'), 'utf8');
    const before = fs.readFileSync(d);
    let modelCalled = false;
    const code = await runReview([d], [], {
      postFn: async () => { modelCalled = true; throw new Error('should not be called'); },
    });
    if (code !== 0) return 'code=' + code;
    if (modelCalled) return '纯机检却调了模型';
    const out = d.replace(/\.md$/, '') + '.review.md';
    if (!fs.existsSync(out)) return '没有产出 review 文件';
    const t = fs.readFileSync(out, 'utf8');
    if (!/机检发现（确定性）/.test(t)) return '缺机检段';
    if (!/stylecheck/.test(t) || !/paragraph-logic/.test(t) || !/tense-check/.test(t)) return '机检项没跑齐';
    if (!/advisory/.test(t)) return '缺 advisory 标注';
    if (!before.equals(fs.readFileSync(d))) return '原稿被改了';
    return /REVIEW|ISSUES|WARN/.test(t) ? true : '机检没报出任何问题（夹具本该触发：8 句无支撑段落）';
  });

  await ckA('★--with-model：模型只对已发现问题给建议并标 advisory；模型坏了也不影响机检结论', async () => {
    const d = path.join(dir, 'review-target.md');
    const ok = await runReview([d], ['--with-model', '--model', 'mock-model'], {
      mockUrl,
      postFn: async () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: 'ISSUE #1 | add a citation for the robustness claim' } }] }) }),
    });
    if (ok !== 0) return 'code=' + ok;
    const t = fs.readFileSync(d.replace(/\.md$/, '') + '.review.md', 'utf8');
    if (!/模型建议（advisory · 不做判据）/.test(t)) return '缺模型建议段';
    if (!/第 1 条 →/.test(t)) return '建议没被格式化：' + t.slice(-200);
    const bad = await runReview([d], ['--with-model', '--model', 'mock-model'], {
      mockUrl,
      postFn: async () => ({ status: 500, body: 'boom' }),
    });
    if (bad !== 0) return '模型失败时不该让整体失败：code=' + bad;
    const t2 = fs.readFileSync(d.replace(/\.md$/, '') + '.review.md', 'utf8');
    return (/模型调用失败/.test(t2) && /机检发现（确定性）/.test(t2)) ? true : '模型失败时机检结果丢了';
  });

  // 清理放在**所有臂之后**（先清理后测试会让后加的臂假红 —— 这轮踩过一次）
  server.close();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* 清理失败不致命 */ }
  ck('★builtinChecks：中文片段 / 未定义缩写 / 超长句 三类都要被抓（7B 自查时这三类全漏）', () => {
    const bad = '## 2. Methods\n\nThe XQZ protocol improves accuracy significantly, and it is clear that this approach works better than the baseline in every condition we examined while also remaining computationally efficient across all tested configurations that we collected during the study period, which lasted eighteen months and involved multiple sites. 本研究使用了若干数据集。\n';
    const r = builtinChecks(bad, 'en');
    const st = (id) => (r.find((x) => x.id === id) || {}).status;
    if (st('lang-fragment') !== 'WARN') return '没抓中文片段';
    if (st('abbrev-undefined') !== 'WARN') return '没抓未定义缩写';
    if (st('sentence-over-45') !== 'WARN') return '没抓超长句';
    const good = '## 2. Methods\n\nWe used the XQZ protocol (Cross-domain Query Zipper) on 10 datasets.\n';
    const g = builtinChecks(good, 'en');
    const gs = (id) => (g.find((x) => x.id === id) || {}).status;
    return (gs('lang-fragment') === 'OK' && gs('abbrev-undefined') === 'OK')
      ? true : '反控误报：' + JSON.stringify(g.map((x) => [x.id, x.status]));
  });
  const pass = results.filter((x) => x.ok).length;
  results.forEach((r) => console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' :: ' + r.why)));
  console.log('\ngenerate selftest: ' + pass + '/' + results.length + ' 通过');
  return pass === results.length ? 0 : 1;
}

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--demo-spec')) {
    const out = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : 'spec.json';
    fs.writeFileSync(out, JSON.stringify(demoSpec(), null, 2) + '\n', 'utf8');
    console.log('已写示例 spec：' + out);
    return 0;
  }
  if (argv.includes('--brief')) {
    const specPath = argv[argv.indexOf('--spec') + 1];
    if (!specPath || !fs.existsSync(specPath)) { console.error('前提层失败：--brief 需要存在的 --spec <json>'); return 2; }
    const out = argv[argv.indexOf('--out') + 1];
    if (!out) { console.error('前提层失败：--brief 需要 --out <目录>'); return 2; }
    const files = buildBriefs(JSON.parse(fs.readFileSync(specPath, 'utf8')), out);
    console.log('已生成 ' + files.length + ' 条分节简报 → ' + out);
    console.log('下一步：node bin/generate.cjs --run --briefs ' + out + ' --out draft/');
    return 0;
  }
  if (argv.includes('--probe')) {
    const eng = await resolveEngine(argv, {});
    if (eng.error) {
      console.error(eng.error);
      console.error('  可加：① 显式配置 PAPER_STUDIO_LLM_*；② 面板录入；③ 装 Ollama（本机 11434 自动发现）');
      return 2;
    }
    console.log('可用引擎：' + eng.engine + ' · ' + eng.model);
    console.log('  base：' + eng.base);
    console.log('  来源：' + eng.why);
    if (Array.isArray(eng.candidates) && eng.candidates.length > 1) {
      console.log('  其它候选：' + eng.candidates.slice(1, 6).join(', ') + '（--model 可指定）');
    }
    return 0;
  }
  // 写作交给宿主：出每节写作任务书（插件出规格 → 宿主写正文 → 门做判据）
  if (argv.includes('--host-handoff')) {
    const briefs = argv[argv.indexOf('--briefs') + 1];
    const out = argv[argv.indexOf('--out') + 1];
    if (!briefs || !fs.existsSync(briefs)) { console.error('前提层失败：--host-handoff 需要存在的 --briefs <目录>'); return 2; }
    if (!out) { console.error('前提层失败：--host-handoff 需要 --out <目录>'); return 2; }
    const r = hostHandoff(briefs, out);
    if (r.error) { console.error(r.error); return 2; }
    console.log('已出 ' + r.files.length + ' 份写作任务书 → ' + out);
    console.log('  说明：' + r.readme);
    console.log('  下一步：宿主模型逐节照任务书写正文并回填 NN-<id>.md，再跑 paragraph-logic 出读数。');
    return 0;
  }
  // 本地审查/校正（只出建议，不改稿，不当判据）
  if (argv.includes('--review')) {
    const drafts = [];
    argv.forEach((a, i) => { if (a === '--draft' && argv[i + 1]) drafts.push(argv[i + 1]); });
    return runReview(drafts, argv);
  }
  if (argv.includes('--run') || argv.includes('--scaffold') || argv.includes('--offline')) {
    const briefs = argv[argv.indexOf('--briefs') + 1];
    const out = argv[argv.indexOf('--out') + 1];
    if (!briefs || !fs.existsSync(briefs)) { console.error('前提层失败：--run/--scaffold 需要存在的 --briefs <目录>'); return 2; }
    if (!out) { console.error('前提层失败：--run/--scaffold 需要 --out <目录>'); return 2; }
    return runGeneration(briefs, out, argv);
  }
  console.log('用法：--probe | --demo-spec | --brief --spec <json> --out <dir> | '
    + '--host-handoff --briefs <dir> --out <dir>（写作交宿主：出每节写作任务书） | '
    + '--review --draft <稿.md>（本地模型只出审查建议，不改稿） | '
    + '--run --briefs <dir> --out <dir> [--retries N] [--engine auto|env]（**仅云端强模型**；本地引擎会被拒绝） | '
    + '--scaffold --briefs <dir> --out <dir>（零模型：出骨架，不冒充正文）| --selftest');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
}
module.exports = {
  buildBriefs, briefFor, promptFor, quickIssues, bannedWords, runGeneration, demoSpec,
  resolveEngine, probeLocal, panelEngine, scoreModel, scaffoldFor, stripEchoHeading, LOCAL_PROBES,
  hostHandoff, runReview, runMachineChecks, builtinChecks, suggestPrompt, askVia
};
