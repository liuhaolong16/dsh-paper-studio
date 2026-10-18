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
 * ★ 模型从哪来：`PAPER_STUDIO_LLM_BASE` / `PAPER_STUDIO_LLM_KEY` / `PAPER_STUDIO_LLM_MODEL`
 *   三者缺一 ⇒ **exit 2 并说明缺哪个**（绝不静默降级成模板拼接冒充"生成"）。
 * ★ 纪律：生成结果一律标注 `<!-- generated:model=... -->`，并输出"门读数"；
 *   门不过就报具体项，**不把生成成功当成交付成功**。
 *
 * 用法：
 *   node bin/generate.cjs --demo-spec --out spec.json
 *   node bin/generate.cjs --brief --spec spec.json --out briefs/
 *   node bin/generate.cjs --run --briefs briefs/ --out draft/ [--model m] [--base url] [--retries 2]
 *   node bin/generate.cjs --selftest
 * 退出码：0 成功 · 1 门未过/生成失败 · 2 前提层失败（缺配置/缺文件）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/** 禁用词从 stylecheck 的真源取，不在这里另抄一份（两套词表＝两套真相）。 */
function bannedWords() {
  try {
    const sc = require(path.join(__dirname, 'stylecheck.cjs'));
    const flat = Object.values(sc.WORD_LISTS || {}).flatMap((re) => {
      const src = String(re);
      return [...src.matchAll(/[a-z]{4,}/gi)].map((m) => m[0].toLowerCase());
    });
    return [...new Set(flat)].slice(0, 60);
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
  const lines = [
    'You are drafting ONE section of an academic paper in English.',
    'Paper title: ' + (brief.paper_title || '(untitled)'),
    'Section: ' + brief.title,
    'Goal: ' + brief.goal,
    'Length: about ' + brief.words + ' words.',
    '',
    'Must appear in this section:',
    ...brief.must_have.map((m) => '- ' + m),
    '',
    'Hard rules:',
    ...brief.rules.map((r) => '- ' + r),
    '',
    'Forbidden words (never use): ' + brief.banned.slice(0, 20).join(', '),
    '',
    'Output ONLY the section prose in Markdown. No heading, no meta commentary.',
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

function llmConfig(argv) {
  const base = argv[argv.indexOf('--base') + 1] && argv.includes('--base')
    ? argv[argv.indexOf('--base') + 1] : (process.env.PAPER_STUDIO_LLM_BASE || '');
  const key = process.env.PAPER_STUDIO_LLM_KEY || '';
  const model = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : (process.env.PAPER_STUDIO_LLM_MODEL || '');
  return { base, key, model };
}

async function runGeneration(briefDir, outDir, argv, opts = {}) {
  const cfg = llmConfig(argv);
  if (!opts.mockUrl) {
    const missing = [];
    if (!cfg.base) missing.push('PAPER_STUDIO_LLM_BASE');
    if (!cfg.key) missing.push('PAPER_STUDIO_LLM_KEY');
    if (!cfg.model) missing.push('PAPER_STUDIO_LLM_MODEL');
    if (missing.length) {
      console.error('前提层失败：未配置模型（缺 ' + missing.join(' / ') + '）');
      console.error('  例：set PAPER_STUDIO_LLM_BASE=https://api.deepseek.com/v1 & set PAPER_STUDIO_LLM_MODEL=deepseek-chat & set PAPER_STUDIO_LLM_KEY=...');
      console.error('  ★ 未配置不等于"生成了空稿"——本工具不会用模板拼接冒充正文。');
      return 2;
    }
  }
  const briefs = fs.readdirSync(briefDir).filter((f) => f.endsWith('.json')).sort();
  if (!briefs.length) { console.error('前提层失败：' + briefDir + ' 里没有简报 json'); return 2; }
  fs.mkdirSync(outDir, { recursive: true });
  const retries = Number(argv.includes('--retries') ? argv[argv.indexOf('--retries') + 1] : 0) || 0;
  const parts = [];
  let failed = 0;

  for (const f of briefs) {
    const brief = JSON.parse(fs.readFileSync(path.join(briefDir, f), 'utf8'));
    if (!brief.goal) { console.error('简报 ' + f + ' 缺 goal —— 拒绝生成（没有目标的正文必然是空话）'); return 2; }
    let issues = [];
    let text = '';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const url = (opts.mockUrl || cfg.base.replace(/\/$/, '') + '/chat/completions');
      const payload = {
        model: cfg.model || 'mock', temperature: 0.2,
        messages: [{ role: 'user', content: promptFor(brief, issues) }],
      };
      let res;
      try {
        res = await post(url, cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}, payload);
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
      // 当场自检：禁用词 / 字数带 / 必现要素
      issues = quickIssues(text, brief);
      if (!issues.length) break;
      if (attempt === retries) failed += 1;
    }
    const out = path.join(outDir, f.replace(/\.json$/, '.md'));
    fs.writeFileSync(out,
      '<!-- generated:model=' + (cfg.model || 'mock') + ' · section=' + brief.id + ' -->\n\n## ' + brief.title + '\n\n' + text.trim() + '\n',
      'utf8');
    parts.push({ file: out, issues });
    console.log('✔ ' + brief.title + ' → ' + out + (issues.length ? '（仍有 ' + issues.length + ' 条自检问题）' : ''));
  }

  const assembled = path.join(outDir, 'assembled.md');
  fs.writeFileSync(assembled, parts.map((p) => fs.readFileSync(p.file, 'utf8')).join('\n'), 'utf8');
  console.log('\n拼稿：' + assembled);

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

/** 生成后当场自检：这些是**纯本地可判**的，不依赖模型自评。 */
function quickIssues(text, brief) {
  const issues = [];
  const lower = text.toLowerCase();
  const hit = (brief.banned || []).filter((w) => w.length > 4 && new RegExp('\\b' + w + '\\b', 'i').test(lower));
  if (hit.length) issues.push('使用了禁用词：' + [...new Set(hit)].slice(0, 6).join(', '));
  const words = (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  const lo = Math.round((brief.words || 600) * 0.5);
  const hi = Math.round((brief.words || 600) * 1.8);
  if (words < lo) issues.push('字数偏少：' + words + ' < ' + lo);
  if (words > hi) issues.push('字数偏多：' + words + ' > ' + hi);
  (brief.must_have || []).forEach((m) => {
    const key = String(m).split(/[（(]/)[0].trim().slice(0, 6).toLowerCase();
    if (key && !lower.includes(key)) issues.push('缺必现要素："' + m + '"');
  });
  return issues;
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

  ck('★禁用词来自 stylecheck 真源（不另抄词表）', () => {
    const w = bannedWords();
    if (!Array.isArray(w)) return '不是数组';
    const sc = require(path.join(__dirname, 'stylecheck.cjs'));
    const total = Object.values(sc.WORD_LISTS || {}).length;
    return total > 0 && w.length > 0 ? true : 'stylecheck 词表为空或未取到';
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
    const b = { words: 100, must_have: ['数据来源与许可'], banned: ['delve'] };
    const iss = quickIssues('We delve into this. Short.', b);
    const has = (re) => iss.some((x) => re.test(x));
    if (!has(/禁用词/)) return '没报禁用词';
    if (!has(/字数偏少/)) return '没报字数';
    if (!has(/缺必现要素/)) return '没报必现要素';
    return true;
  });

  ck('quickIssues：合格正文不报问题（防误报）', () => {
    const b = { words: 20, must_have: ['数据来源'], banned: ['delve'] };
    const text = '数据来源 is described here. ' + 'word '.repeat(18);
    const iss = quickIssues(text, b);
    return iss.length === 0 ? true : JSON.stringify(iss);
  });

  // mock LLM：/chat/completions 返回合格正文；/bad 返回 500
  const server = http.createServer((req, res) => {
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
  const mockUrl = 'http://127.0.0.1:' + server.address().port + '/chat/completions';

  await ckA('--run：mock 端点端到端生成 2 节并拼稿', async () => {
    const code = await runGeneration(briefDir, outDir, ['--model', 'mock-model'], { mockUrl });
    if (!fs.existsSync(path.join(outDir, 'assembled.md'))) return '没有拼稿';
    const n = fs.readdirSync(outDir).filter((f) => /\.md$/.test(f) && f !== 'assembled.md').length;
    if (n !== spec.sections.length) return '节数=' + n;
    return code === 0 || code === 1 ? true : 'code=' + code;
  });

  ck('生成物带 provenance 标注（generated:model=...）', () => {
    const f = fs.readdirSync(outDir).filter((x) => /^\d{2}-.*\.md$/.test(x))[0];
    const t = fs.readFileSync(path.join(outDir, f), 'utf8');
    return /<!-- generated:model=mock-model/.test(t) ? true : '缺标注';
  });

  await ckA('★必失败面：模型返回 500 ⇒ exit 1 且说明原因', async () => {
    const badUrl = mockUrl.replace('/chat/completions', '/bad');
    const code = await runGeneration(briefDir, path.join(dir, 'draft-bad'), ['--model', 'm'], { mockUrl: badUrl });
    return code === 1 ? true : 'code=' + code;
  });

  await ckA('★必失败面：未配置模型 ⇒ exit 2（不静默用模板冒充正文）', async () => {
    const saved = { b: process.env.PAPER_STUDIO_LLM_BASE, k: process.env.PAPER_STUDIO_LLM_KEY, m: process.env.PAPER_STUDIO_LLM_MODEL };
    delete process.env.PAPER_STUDIO_LLM_BASE; delete process.env.PAPER_STUDIO_LLM_KEY; delete process.env.PAPER_STUDIO_LLM_MODEL;
    const code = await runGeneration(briefDir, path.join(dir, 'draft-nokey'), [], {});
    if (saved.b) process.env.PAPER_STUDIO_LLM_BASE = saved.b;
    if (saved.k) process.env.PAPER_STUDIO_LLM_KEY = saved.k;
    if (saved.m) process.env.PAPER_STUDIO_LLM_MODEL = saved.m;
    return code === 2 ? true : 'code=' + code;
  });

  await ckA('★必失败面：简报缺 goal ⇒ 拒绝生成并 exit 2', async () => {
    const d2 = path.join(dir, 'briefs-nogoal');
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, '01-x.json'), JSON.stringify({ id: 'x', title: 'X', words: 100 }), 'utf8');
    const code = await runGeneration(d2, path.join(dir, 'draft-nogoal'), ['--model', 'm'], { mockUrl });
    return code === 2 ? true : 'code=' + code;
  });

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
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
  if (argv.includes('--run')) {
    const briefs = argv[argv.indexOf('--briefs') + 1];
    const out = argv[argv.indexOf('--out') + 1];
    if (!briefs || !fs.existsSync(briefs)) { console.error('前提层失败：--run 需要存在的 --briefs <目录>'); return 2; }
    if (!out) { console.error('前提层失败：--run 需要 --out <目录>'); return 2; }
    return runGeneration(briefs, out, argv);
  }
  console.log('用法：--demo-spec | --brief --spec <json> --out <dir> | --run --briefs <dir> --out <dir> [--retries N] | --selftest');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
}
module.exports = { buildBriefs, briefFor, promptFor, quickIssues, bannedWords, runGeneration, demoSpec };
