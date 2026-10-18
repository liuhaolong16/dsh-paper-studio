#!/usr/bin/env node
/**
 * local-engine — 本地引擎部署器（Ollama）· 免 key 的那条通道由它负责"装好、挑对、验通"
 *
 * 为什么需要它：`generate.cjs` 已经能**自动发现**本机引擎，但"自动发现"解决不了三件事：
 *   ① 机器上到底能跑多大的模型（显存/内存决定 3B / 7B / 14B）；② 该拉哪一个（名字要精确到量化档）；
 *   ③ 拉下来到底能不能用（端口在听 ≠ 模型能出文）。
 * 本工具把这三件做成一条路：`--status`（体检+建议）→ `--install`（拉模型+冒烟）→ `--status`（复核）。
 *
 * ★ 纪律：装不下就明说装不下（按显存给档位），**不推荐会自动溢到 CPU/swap 的尺寸**；
 *   冒烟失败一律算失败（退出码非 0），不把"拉完了"当"能用"。
 *
 * 用法：
 *   node bin/local-engine.cjs --status
 *   node bin/local-engine.cjs --install [--model qwen2.5:7b-instruct-q4_K_M] [--dry-run]
 *   node bin/local-engine.cjs --selftest
 * 退出码：0 可用 · 1 装了但验不过 / 端点不通 · 2 前提层失败（没装 Ollama / 拉取失败）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ENDPOINT = process.env.PAPER_STUDIO_OLLAMA_BASE || 'http://127.0.0.1:11434';

/**
 * 档位表：**按显存**给建议，权重估算按 q4_K_M 经验值。
 * 为什么不是"越大越好"：8 GB 显存跑 14B 必溢出到 CPU，速度掉到 3–5 tok/s，
 * 写一节 700 词要几分钟 —— 那不算"能用"。所以每档都标注权重与是否溢出。
 */
const TIERS = [
  { id: '14b', minVramGB: 15, model: 'qwen2.5:14b-instruct-q4_K_M', weightGB: 9.0, note: '写作质量最好；需 ≥15 GB 显存才不溢出' },
  { id: '7b', minVramGB: 7.5, model: 'qwen2.5:7b-instruct-q4_K_M', weightGB: 4.7, note: '质量/速度平衡点；8 GB 显存可全量进卡' },
  // 3B 的门槛不能写 0：写 0 就等于"任何显存都算装得下"，CPU 溢出这件事实会被吞掉（自检抓到的正是这个）
  { id: '3b', minVramGB: 3, model: 'qwen2.5:3b-instruct-q4_K_M', weightGB: 2.0, note: '兜底档；能写但只到"可编辑草稿"水平' },
];

function recommendFor(vramGB, ramGB) {
  const v = Number(vramGB) || 0;
  const r = Number(ramGB) || 0;
  const tier = TIERS.find((t) => v >= t.minVramGB);
  if (tier) return { tier, reason: '显存 ' + v + ' GB ≥ 该档门槛 ' + tier.minVramGB + ' GB ⇒ 可全量进卡' };
  const fallback = TIERS[TIERS.length - 1];
  return {
    tier: fallback,
    reason: '显存 ' + v + ' GB 低于兜底档门槛 ' + fallback.minVramGB + ' GB（差 '
      + (fallback.minVramGB - v).toFixed(1) + ' GB），RAM ' + r + ' GB ⇒ **部分/全部跑在 CPU**，速度会明显下降',
    cpuSpill: true,
  };
}

/** 解析 `ollama list` 的表格输出（列宽会随内容抖动，所以按空白切分而不是定宽截取）。 */
function parseOllamaList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    if (/^NAME\s+ID\s+SIZE/i.test(line)) continue;
    const m = /^(\S+)\s+([0-9a-f]{8,})\s+([\d.]+\s*[KMG]B)\s*(.*)$/i.exec(line);
    if (!m) continue;
    out.push({ name: m[1], id: m[2], size: m[3].replace(/\s+/g, ''), modified: (m[4] || '').trim() });
  }
  return out;
}

/** 单测/夹具用：把 GPU/RAM 采集与 HTTP 判定做成可注入，避免自检依赖真实硬件。 */
function probes() {
  const out = { vramGB: 0, gpuName: '', ramGB: 0, ollamaVersion: '', models: [], reachable: false, loaded: [] };
  const smi = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 8000 });
  if (smi.status === 0 && smi.stdout) {
    const first = smi.stdout.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
    const m = /^(.*),\s*([\d.]+)$/.exec(first);
    if (m) { out.gpuName = m[1].trim(); out.vramGB = Math.round((Number(m[2]) / 1024) * 10) / 10; }
  }
  const ram = spawnSync('powershell', ['-NoProfile', '-Command',
    '(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory'], { encoding: 'utf8', timeout: 8000 });
  if (ram.status === 0) out.ramGB = Math.round((Number(String(ram.stdout).trim()) / 1073741824) * 10) / 10;
  const ver = spawnSync('ollama', ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (ver.status === 0) out.ollamaVersion = String(ver.stdout || '').trim();
  const list = spawnSync('ollama', ['list'], { encoding: 'utf8', timeout: 20000 });
  if (list.status === 0) out.models = parseOllamaList(list.stdout);
  const ps = spawnSync('ollama', ['ps'], { encoding: 'utf8', timeout: 8000 });
  if (ps.status === 0) out.loaded = parseOllamaList(ps.stdout);
  return out;
}

function getJson(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, timeout: timeoutMs || 2000 }, (res) => {
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

/** 端口在听 ≠ 能用：这里只判"清单拿得到"，真正能不能出文由 smoke() 判。 */
async function endpointAlive(base) {
  const j = await getJson(String(base).replace(/\/$/, '') + '/v1/models', 2500);
  return Array.isArray(j && j.data) ? j.data.map((m) => m.id) : null;
}

function post(base, model, prompt, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(String(base).replace(/\/$/, '') + '/v1/chat/completions'); } catch (e) { return resolve({ ok: false, error: 'base 非法' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = Buffer.from(JSON.stringify({
      model, temperature: 0.2, stream: false,
      messages: [{ role: 'user', content: prompt }],
    }), 'utf8');
    const req = lib.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
      timeout: timeoutMs || 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve({ ok: false, error: 'HTTP ' + res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 200) });
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const text = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          resolve({ ok: true, text });
        } catch (e) { resolve({ ok: false, error: '响应不是 JSON' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '超时' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

/**
 * 冒烟：让模型写一句**可机检**的英文（避免"返回了但全是废话也算通"）。
 * 判据三条：非空 · 是英文（CJK 占比低）· 含被要求的词。任何一条不满足都算失败。
 */
async function smoke(base, model, opts = {}) {
  const ask = 'Reply with exactly one English sentence, at most 20 words, that contains the word "protocol".';
  const r = await (opts.postFn || post)(base, model, ask, opts.timeoutMs || 120000);
  if (!r.ok) return { ok: false, why: '请求失败：' + (r.error || '') + (r.body ? ' · ' + r.body : '') };
  const text = String(r.text || '').trim();
  if (!text) return { ok: false, why: '模型返回空正文' };
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (cjk > 5) return { ok: false, why: '要求的英文被写成中文（CJK ' + cjk + ' 字）' };
  if (!/protocol/i.test(text)) return { ok: false, why: '没出现要求的词 protocol：' + text.slice(0, 80) };
  return { ok: true, text: text.slice(0, 160) };
}

/**
 * 推荐档是否真的在场。
 * ★ 这里曾被自检/真机同时抓到一个假阳性：用 `name.indexOf('qwen2.5') === 0` 判，
 *   于是 `qwen2.5-3b-32k:latest` 被当成"7B 已就位"。判据必须**连参数档一起比**
 *   （`qwen2.5:7b` 前缀），否则"推荐档已就位"是在骗自己。
 */
function recommendedPresent(models, rec) {
  const want = rec.tier.model;
  const key = want.split('-')[0];            // 'qwen2.5:7b'
  return (models || []).some((m) => {
    const n = m && m.name;
    if (!n) return false;
    return n === want || n.indexOf(key) === 0;
  });
}

function statusText(p, opts = {}) {
  const rec = recommendFor(p.vramGB, p.ramGB);
  const lines = [];
  lines.push('本地引擎体检（' + (p.ollamaVersion || 'Ollama 未装/未在 PATH') + '）');
  lines.push('  · 端点：' + (opts.base || ENDPOINT) + '/v1 — ' + (p.reachable ? '在线（' + (p.endpointModels || []).length + ' 个模型）' : '**离线**'));
  lines.push('  · 硬件：' + (p.gpuName || '未测到独显') + ' · 显存 ' + (p.vramGB || 0) + ' GB · RAM ' + (p.ramGB || 0) + ' GB');
  lines.push('  · 建议档位：' + rec.tier.id.toUpperCase() + '（`' + rec.tier.model + '`，权重约 ' + rec.tier.weightGB + ' GB）');
  lines.push('    ' + rec.reason + (rec.cpuSpill ? ' ⚠ 会溢出到 CPU' : ''));
  const models = p.models || [];
  lines.push('  · 已装模型（' + models.length + '）：' + (models.length
    ? models.map((m) => m.name + ' ' + m.size).join(' · ')
    : '（无）'));
  if (p.loaded && p.loaded.length) lines.push('  · 正在跑：' + p.loaded.map((m) => m.name).join(', '));
  let picked = '';
  try {
    const gen = require(path.join(__dirname, 'generate.cjs'));
    const names = models.map((m) => m.name);
    if (names.length) {
      names.sort((a, b) => gen.scoreModel(b) - gen.scoreModel(a));
      picked = names[0];
    }
  } catch (e) { picked = ''; }
  lines.push('  · generate.cjs 会选：' + (picked || '（没有可选模型）'));
  const hasRec = recommendedPresent(models, rec);
  if (!p.reachable) lines.push('  → 端点离线：模型清单拿不到，**先解决 Ollama 未启动**（`ollama serve`）');
  else if (!hasRec) lines.push('  → 推荐模型未安装：`npm run model:install`（等价 `node bin/local-engine.cjs --install`）');
  else lines.push('  → 推荐档已就位');
  lines.push('  ★ 提醒：模型进卡 ≠ 会写论文；正文质量以 `paragraph-logic` 等门读数为准。');
  return { text: lines.join('\n'), rec, picked, recommendedPresent: hasRec };
}

async function install(argv) {
  const dry = argv.includes('--dry-run');
  const p = probes();
  if (!p.ollamaVersion) {
    console.error('前提层失败：本机没有 ollama（PATH 里找不到）。');
    console.error('  装法：https://ollama.com/download —— 装完 `ollama serve` 常驻，再回来跑本命令。');
    return 2;
  }
  const rec = recommendFor(p.vramGB, p.ramGB);
  const want = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : rec.tier.model;
  console.log('拉取：' + want + '（' + rec.tier.weightGB + ' GB 量级 · ' + rec.reason + '）');
  if (dry) { console.log('--dry-run：只报计划，不实际拉取'); return 0; }
  const pull = spawnSync('ollama', ['pull', want], { stdio: 'inherit', timeout: 3600000 });
  if (pull.status !== 0) { console.error('拉取失败（exit ' + pull.status + '）——网络或磁盘问题，模型未装成'); return 2; }
  console.log('\n冒烟（真让模型写一句可机检的英文）…');
  const s = await smoke(ENDPOINT, want);
  if (!s.ok) { console.error('冒烟失败：' + s.why); console.error('  ⇒ 模型拉下来了但**不能用**，别当装好。'); return 1; }
  console.log('冒烟通过：' + s.text);
  const st = await buildStatus(probes());
  console.log('\n' + st.text);
  return st.reachable ? 0 : 1;
}

/** 端点在线与否只由这里判一次，调用方拿 st.reachable 决定退出码（别在别处再猜一遍）。 */
async function buildStatus(p) {
  const endpointModels = await endpointAlive(ENDPOINT);
  const merged = Object.assign({}, p, { reachable: !!endpointModels, endpointModels: endpointModels || [] });
  const st = statusText(merged, { base: ENDPOINT });
  return Object.assign(st, { reachable: merged.reachable, endpointModels: merged.endpointModels });
}

async function selftest() {
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

  ck('档位：8 GB 显存 ⇒ 7B（不是 14B，也不退化到 3B）', () => {
    const r = recommendFor(8, 64);
    return r.tier.id === '7b' ? true : r.tier.id;
  });
  ck('档位：24 GB 显存 ⇒ 14B', () => {
    const r = recommendFor(24, 64);
    return r.tier.id === '14b' ? true : r.tier.id;
  });
  ck('★档位：2 GB 显存（低于兜底门槛）⇒ 3B 且**显形标注会溢出到 CPU**', () => {
    const r = recommendFor(2, 16);
    if (r.tier.id !== '3b') return '档位=' + r.tier.id;
    return (r.cpuSpill && /CPU/.test(r.reason)) ? true : '没标 CPU 溢出：' + JSON.stringify(r);
  });
  ck('★档位：没测到 GPU（0 GB）⇒ 3B + 明说 CPU，不吹"能跑 7B"', () => {
    const r = recommendFor(0, 32);
    return (r.tier.id === '3b' && r.cpuSpill) ? true : JSON.stringify(r);
  });
  ck('解析 ollama list：模型名/ID/体积都要抽到（列宽会抖，不许定宽截取）', () => {
    const txt = 'NAME                       ID              SIZE      MODIFIED\n'
      + 'qwen2.5:7b-instruct-q4_K_M 845dbda0ea48    4.7 GB    2 minutes ago\n'
      + 'qwen2.5-3b-32k:latest      a7ed0ccbbd51    2.1 GB    12 days ago\n';
    const m = parseOllamaList(txt);
    if (m.length !== 2) return '条数=' + m.length;
    if (m[0].name !== 'qwen2.5:7b-instruct-q4_K_M' || m[0].size !== '4.7GB') return JSON.stringify(m[0]);
    return m[1].size === '2.1GB' ? true : JSON.stringify(m[1]);
  });
  ck('★挑模型：7B instruct 必须赢 3B-32k（参数比上下文重要；否则装了 7B 也不会被用）', () => {
    const gen = require(path.join(__dirname, 'generate.cjs'));
    const names = ['qwen2.5:7b-instruct-q4_K_M', 'qwen2.5-3b-32k:latest'];
    names.sort((a, b) => gen.scoreModel(b) - gen.scoreModel(a));
    return names[0] === 'qwen2.5:7b-instruct-q4_K_M' ? true : '仍然选了 ' + names[0];
  });
  ck('★体检文本：离线要显形且给的是"服务没起"的补救（不是让人再拉一遍模型）', () => {
    const st = statusText({ ollamaVersion: 'ollama version is 0.35.1', gpuName: 'RTX 4060', vramGB: 8, ramGB: 64, models: [], loaded: [], reachable: false }, {});
    if (!/离线/.test(st.text)) return '没标离线';
    if (!/ollama serve/.test(st.text)) return '没给 serve 补救';
    return st.rec.tier.id === '7b' ? true : '档位=' + st.rec.tier.id;
  });
  ckA('★冒烟：返回空正文 ⇒ 失败（"拉完了"不等于"能用"）', async () => {
    const s = await smoke('http://x', 'm', { postFn: async () => ({ ok: true, text: '   ' }) });
    return (s.ok === false && /空正文/.test(s.why)) ? true : JSON.stringify(s);
  });
  ckA('★冒烟：要求英文却写中文 ⇒ 失败', async () => {
    const s = await smoke('http://x', 'm', { postFn: async () => ({ ok: true, text: '这是中文回答，protocol 在这里。' }) });
    return (s.ok === false && /中文/.test(s.why)) ? true : JSON.stringify(s);
  });
  ckA('★冒烟：合格英文 ⇒ 通过', async () => {
    const s = await smoke('http://x', 'm', { postFn: async () => ({ ok: true, text: 'The evaluation protocol is fixed before data collection.' }) });
    return s.ok === true ? true : JSON.stringify(s);
  });
  ckA('★冒烟：HTTP 非 200 ⇒ 失败并带原因', async () => {
    const s = await smoke('http://x', 'm', { postFn: async () => ({ ok: false, error: 'HTTP 500', body: 'boom' }) });
    return (s.ok === false && /HTTP 500/.test(s.why)) ? true : JSON.stringify(s);
  });
  ckA('★必失败面：端点离线 ⇒ --v1/models 拿不到（endpointAlive 返回 null，不是空数组）', async () => {
    const r = await endpointAlive('http://127.0.0.1:9');
    return r === null ? true : '返回了 ' + JSON.stringify(r);
  });
  ck('解析 ollama ps：正在跑的模型能被识别（PROCESSOR 列不能把名字切坏）', () => {
    const txt = 'NAME                     ID              SIZE      PROCESSOR    CONTEXT    UNTIL\n'
      + 'qwen2.5-3b-32k:latest    a7ed0ccbbd51    2.8 GB    100% GPU     32768      About a minute from now\n';
    const m = parseOllamaList(txt);
    return (m.length === 1 && m[0].name === 'qwen2.5-3b-32k:latest') ? true : JSON.stringify(m);
  });

  ck('★推荐档在场判定：只有 3B 时**不许**说"7B 已就位"（曾用 family 前缀判 ⇒ 假阳性）', () => {
    const rec = recommendFor(8, 64);
    const onlySmall = [{ name: 'qwen2.5-3b-32k:latest' }, { name: 'qwen2.5:3b-instruct-q4_K_M' }];
    const withBig = onlySmall.concat([{ name: 'qwen2.5:7b-instruct-q4_K_M' }]);
    if (recommendedPresent(onlySmall, rec)) return '3B 被当成了 7B';
    return recommendedPresent(withBig, rec) ? true : '装上了 7B 却没认出来';
  });

  ck('★体检文本：只有 3B 模型时必须提示"推荐模型未安装"（不能让用户以为装好了）', () => {
    const st = statusText({
      ollamaVersion: 'ollama version is 0.35.1', gpuName: 'RTX 4060', vramGB: 8, ramGB: 64,
      models: [{ name: 'qwen2.5-3b-32k:latest', size: '2.1GB' }], loaded: [], reachable: true,
    }, {});
    if (/推荐档已就位/.test(st.text)) return '仍然谎报已就位';
    return /推荐模型未安装/.test(st.text) ? true : st.text;
  });

  const pass = results.filter((x) => x.ok).length;
  results.forEach((r) => console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' :: ' + r.why)));
  console.log('\nlocal-engine selftest: ' + pass + '/' + results.length + ' 通过');
  return pass === results.length ? 0 : 1;
}

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--install')) return install(argv);
  if (argv.includes('--status') || argv.length === 0) {
    const st = await buildStatus(probes());
    console.log(st.text);
    return st.reachable ? 0 : 1;
  }
  console.log('用法：--status | --install [--model <名字>] [--dry-run] | --selftest');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
}
module.exports = {
  TIERS, recommendFor, parseOllamaList, statusText, recommendedPresent, smoke, endpointAlive, probes, buildStatus,
};
