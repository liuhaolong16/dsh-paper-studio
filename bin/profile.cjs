#!/usr/bin/env node
/**
 * profile — 研究风格档案（V3 · 补齐 P0 缺口；机制吸收自 dsh-sci-fault-diag-paper 的 `hub/style/profile.json`）
 *
 * 为什么要有它：同一个用户反复写论文时，**领域/任务类型/常用方法/数据集/目标期刊/最少引用/语言偏好/禁忌词**
 * 每次都要重讲一遍。档案把这些**结构化存下来**，开工时用 `brief` 一次性注入 —— 模式选择后立刻贴合用户习惯。
 *
 * 硬约束：
 *   - **凭证类字段一律拒收**（密钥 / 令牌 / 口令 / 机密等英文名字段）—— 凭证不入档案、不入任何文件（用户级规则）。
 *   - 已知字段**类型固定**（数组就是数组、数字就是数字）；未知顶层字段**允许但会 warn**（可扩展，不锁死）。
 *   - `brief` **只输出已设置的字段**，不留空壳噪音（精简原则）。
 *
 * 用法：
 *   node bin/profile.cjs show   [--file f]
 *   node bin/profile.cjs get    <点路径> [--file f]
 *   node bin/profile.cjs set    <点路径> <值> [--file f]        # 值可写 JSON（数组用 '["a","b"]'）
 *   node bin/profile.cjs brief  [--file f]
 *   node bin/profile.cjs --selftest
 * 退出码：0 成功 · 1 拒收（凭证字段/类型不符） · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SCHEMA = {
  domain: 'string',            // 领域
  task_type: 'string',         // 任务类型（工程类 SCI / 综述 / 快报 …）
  methods: 'array',            // 常用方法
  datasets: 'array',           // 常用数据集
  target_journals: 'array',    // 目标期刊
  min_citations: 'number',     // 最少引用条数
  language: 'string',          // 写作语言偏好（en / zh / en-first …）
  tone_prefs: 'array',         // 语气偏好（简洁 / 少 hedging …）
  banned_words: 'array',       // 禁忌词与句式
  style_notes: 'array',        // 其他风格注记
};
/* ★ 检测器不得把被检字面写进发布文本（与 bin/criteria-abcd.cjs 同一纪律，v3.2.15）：
   候选词由片段拼接构造，文件里不出现这些字面本身。 */
const _w = (...p) => p.join('');
const SECRET_RE = new RegExp(_w('ke', 'y|', 'tok', 'en|', 'pass', 'word|', 'pass', 'wd|',
  'sec', 'ret|', 'cred', 'ential|', 'ap', 'ikey|api', '_key'), 'i');

const DEFAULTS = { domain: '', task_type: '', methods: [], datasets: [], target_journals: [], min_citations: 0, language: '', tone_prefs: [], banned_words: [], style_notes: [] };

function fileOf(argv) { const i = argv.indexOf('--file'); return i > -1 ? argv[i + 1] : path.join(process.cwd(), '.paper-studio', 'profile.json'); }

function load(file) {
  if (!fs.existsSync(file)) return { ...DEFAULTS, _exists: false };
  // ★ 剥 BOM：Windows 上 Set-Content/记事本写出的 JSON 常带 \uFEFF，不剥会直接抛解析错
  const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return { ...DEFAULTS, ...j, _exists: true };
}
function save(file, obj) {
  const clean = { ...obj }; delete clean._exists;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(clean, null, 2), 'utf8');
  return file;
}
/** 点路径（支持 `methods.0` 这类数组下标；只允许一层点号，避免深层结构失控）。 */
function parsePath(p) {
  const parts = String(p || '').split('.');
  if (!parts[0]) throw new Error('前提层失败：需要点路径，如 domain 或 methods.0');
  return { top: parts[0], idx: parts.length > 1 ? Number(parts[1]) : null };
}
function coerce(top, raw) {
  const kind = SCHEMA[top];
  if (!kind) return { value: raw, warn: `未知字段「${top}」—— 已写入，但它不在已知档案字段里（${Object.keys(SCHEMA).join('/')}）` };
  if (kind === 'array') {
    let v = raw;
    try { const j = JSON.parse(raw); if (Array.isArray(j)) v = j; else v = splitList(raw); }
    catch { v = splitList(raw); }
    if (!Array.isArray(v)) return { err: `类型不符：${top} 必须是数组` };
    return { value: v.map((s) => String(s)).filter((s) => s !== '') };
  }
  if (kind === 'number') { const n = Number(raw); return Number.isFinite(n) ? { value: n } : { err: `类型不符：${top} 必须是数字` }; }
  return { value: String(raw) };
}

/**
 * 逗号串 → 数组。**傻瓜式兜底**：调用方（尤其 PowerShell）常把 `["a","b"]` 的引号吞掉，
 * 于是值变成 `[a,b]` 甚至 `["[a","b"]` ⇒ 这里剥掉方括号与残留引号，别让用户为 shell 的怪癖买单。
 */
function splitList(raw) {
  return String(raw).split(',').map((s) => s.trim().replace(/^[[\]"']+/, '').replace(/[[\]"']+$/, '').trim()).filter((s) => s !== '');
}

function set(file, p, raw) {
  const { top, idx } = parsePath(p);
  if (SECRET_RE.test(top)) throw new Error(`拒收：字段名「${top}」像凭证类 ⇒ **凭证不入档案**（也不入任何文件）；如需记录环境，只写"走哪个通道"，不写值`);
  const obj = load(file);
  let warn;
  // ★ 带下标时写的是**元素**（标量），不能再按字段类型整体解析 —— 首版把整个数组塞进了 methods.1（夹具当场抓到）
  const scalar = idx !== null;
  let value;
  if (scalar) value = String(raw);
  else { const r = coerce(top, raw); if (r.err) throw new Error(r.err); value = r.value; warn = r.warn; }
  if (scalar && Number.isInteger(idx)) {
    if (!Array.isArray(obj[top])) obj[top] = [];
    while (obj[top].length <= idx) obj[top].push('');
    obj[top][idx] = value;
  } else obj[top] = value;
  save(file, obj);
  return { top, value: obj[top], warn };
}
function get(file, p) {
  const { top, idx } = parsePath(p);
  const obj = load(file);
  const v = obj[top];
  if (idx !== null && Array.isArray(v)) return v[idx];
  return v;
}
/** 开工注入块：只列已设置字段（不留空壳）。 */
function brief(file) {
  const o = load(file);
  const rows = [];
  const has = (x) => (Array.isArray(x) ? x.length > 0 : (x !== '' && x !== 0 && x !== undefined && x !== null));
  if (has(o.domain)) rows.push(`- 领域：${o.domain}`);
  if (has(o.task_type)) rows.push(`- 任务类型：${o.task_type}`);
  if (has(o.methods)) rows.push(`- 常用方法：${o.methods.join(' / ')}`);
  if (has(o.datasets)) rows.push(`- 常用数据集：${o.datasets.join(' / ')}`);
  if (has(o.target_journals)) rows.push(`- 目标期刊：${o.target_journals.join(' / ')}`);
  if (has(o.min_citations)) rows.push(`- 引用下限：≥ ${o.min_citations} 条（全核验）`);
  if (has(o.language)) rows.push(`- 写作语言：${o.language}`);
  if (has(o.tone_prefs)) rows.push(`- 语气偏好：${o.tone_prefs.join(' / ')}`);
  if (has(o.banned_words)) rows.push(`- 禁忌词与句式：${o.banned_words.join(' / ')}`);
  if (has(o.style_notes)) rows.push(`- 其他风格注记：${o.style_notes.join(' / ')}`);
  if (!rows.length) return `【研究风格档案】尚未建立（${file}）—— 建议先问一句：领域 / 任务类型 / 目标期刊 / 语言，共 4 项即可起步。`;
  return `【研究风格档案】（开工注入 · 只列已设置项）\n${rows.join('\n')}`;
}

function runSelftest() {
  const os = require('os');
  const results = [];
  const mkf = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prof-')), 'profile.json');
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };

  check('★ 正控 · 设置与读取往返（含数组字段）', () => {
    const f = mkf();
    set(f, 'domain', 'battery SOH prediction');
    set(f, 'methods', '["XGBoost","SHAP"]');
    set(f, 'min_citations', '40');
    const ok = get(f, 'domain') === 'battery SOH prediction' && JSON.stringify(get(f, 'methods')) === '["XGBoost","SHAP"]' && get(f, 'min_citations') === 40;
    return ok ? true : JSON.stringify({ d: get(f, 'domain'), m: get(f, 'methods'), n: get(f, 'min_citations') });
  });
  check('★ 必失败 · **凭证类字段一律拒收**（凭证不入档案、不入任何文件）', () => {
    const f = mkf(); let e = '';
    try { set(f, _w('api', '_key'), 'sk-xxx'); } catch (err) { e = err.message; }
    return (/拒收/.test(e) && !fs.existsSync(f)) ? true : `${e} / 文件存在=${fs.existsSync(f)}`;
  });
  check('★ 必失败 · 类型不符要拒（min_citations 给非数字）', () => {
    const f = mkf(); let e = '';
    try { set(f, 'min_citations', 'many'); } catch (err) { e = err.message; }
    return /类型不符/.test(e) ? true : e;
  });
  check('★ 正控 · 未知字段允许写入但必须 warn（可扩展，不锁死）', () => {
    const f = mkf(); const r = set(f, 'lab_name', 'GEAR Lab');
    return (r.warn && /未知字段/.test(r.warn) && get(f, 'lab_name') === 'GEAR Lab') ? true : JSON.stringify(r);
  });
  check('★★ 正控 · brief **只列已设置项**：空档案给"尚未建立"提示，设过的才出现（精简原则）', () => {
    const f = mkf();
    const empty = brief(f);
    set(f, 'domain', 'X'); set(f, 'target_journals', '["EAAI","SWJ"]');
    const b = brief(f);
    const ok = /尚未建立/.test(empty) && /EAAI \/ SWJ/.test(b) && !/任务类型：/.test(b);
    return ok ? true : JSON.stringify({ empty, b });
  });
  check('★ 正控 · 数组下标写入（methods.1）', () => {
    const f = mkf(); set(f, 'methods', '["a"]'); set(f, 'methods.1', 'b');
    return JSON.stringify(get(f, 'methods')) === '["a","b"]' ? true : JSON.stringify(get(f, 'methods'));
  });
  check('★ 反控 · 逗号串自动转数组（用户手打不被拒）', () => {
    const f = mkf(); set(f, 'datasets', 'NASA PCoE, DBP15K');
    return JSON.stringify(get(f, 'datasets')) === '["NASA PCoE","DBP15K"]' ? true : JSON.stringify(get(f, 'datasets'));
  });
  check('★ 反控（傻瓜式兜底）· PowerShell 吞掉引号后的 `[a,b]` 残形也要还原成干净数组', () => {
    const f = mkf(); set(f, 'target_journals', '["[EAAI","SWJ","Applied Intelligence]"');
    const v = get(f, 'target_journals');
    return JSON.stringify(v) === '["EAAI","SWJ","Applied Intelligence"]' ? true : JSON.stringify(v);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\nprofile 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const cmd = argv.find((a) => !a.startsWith('--'));
  const pos = argv.filter((a) => !a.startsWith('--'));
  const file = fileOf(argv);
  try {
    if (cmd === 'show') { const o = load(file); delete o._exists; console.log(JSON.stringify({ file, ...o }, null, 2)); return 0; }
    if (cmd === 'get') { console.log(JSON.stringify(get(file, pos[1]), null, 2)); return 0; }
    if (cmd === 'set') {
      const r = set(file, pos[1], pos[2]);
      console.log(`已设置 ${r.top} = ${JSON.stringify(r.value)}`);
      if (r.warn) console.log('  ⚠ ' + r.warn);
      return 0;
    }
    if (cmd === 'brief') { console.log(brief(file)); return 0; }
    console.error('用法：profile.cjs show|get|set|brief [--file f]（或 --selftest）'); return 2;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/^拒收/.test(msg)) { console.error(msg); return 1; }
    console.error('前提层失败：' + msg); return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { SCHEMA, DEFAULTS, load, save, set, get, brief, parsePath, main };
