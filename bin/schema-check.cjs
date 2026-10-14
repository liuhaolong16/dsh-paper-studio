#!/usr/bin/env node
/**
 * schema-check — 工具 `parameters` 严格性校验（V3 · **兼容性硬项**）
 *
 * 为什么必须做（**来自一个真实事故**，见 `references/market-parity.md` §4）：
 *   `dsh-sci-fault-diag-paper` v2.1 修过的坑 —— 工具 `parameters` 用了**扁平写法**
 *   （把 `required: true` 写在属性定义里、缺顶层 `type:'object'` + `properties{}` 包裹）⇒
 *   **严格校验的模型 API 直接 400 拒收**（`Tool N function has invalid 'parameters' schema`），
 *   **宽松通道静默通过** ⇒ 症状表现为「**换个模型才报错**」，极难定位。
 *   ⇒ 本插件每个工具出厂前必须过这道机检。
 *
 * 判据（objective，可机检）：
 *   HARD① 顶层必须有 `type: 'object'`
 *   HARD② 必须有 `properties`（对象）
 *   HARD③ **属性定义里不得出现 `required`**（正确写法是顶层 `required: [...]`）—— 正是那次事故的签名
 *   HARD④ 若给了 `required`，必须是**字符串数组**且每个都在 `properties` 里
 *   HARD⑤ 每个属性必须有 `type`（或 anyOf/oneOf/枚举等合法替代）
 *   HARD⑥ 不得出现**严格校验器不认的键**（白名单外的一律报）
 *   SOFT  建议显式 `additionalProperties: false`（更严；不强制，避免误伤）
 *
 * 用法：
 *   node bin/schema-check.cjs --manifest tools.json      # [{name, parameters}, …]
 *   node bin/schema-check.cjs --scan dist/plugin.js      # 只抓"事故签名"：属性里的 required: true
 *   node bin/schema-check.cjs --selftest
 * 退出码：0 通过 · 1 有问题 · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OK_KEYS = new Set(['type', 'description', 'default', 'enum', 'const', 'examples', 'items', 'properties', 'required', 'additionalProperties', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems', 'anyOf', 'oneOf', 'allOf', 'not', 'title', 'deprecated', '$ref', 'definitions', 'propertyNames']);

/** 校验单个工具的 parameters。返回 { problems:[{rule,detail}], warnings:[] }。 */
function validateToolSchema(name, schema) {
  const problems = []; const warnings = [];
  if (!schema || typeof schema !== 'object') { problems.push({ rule: 'not-object', detail: `${name}: parameters 缺失或不是对象` }); return { problems, warnings }; }
  if (schema.type !== 'object') problems.push({ rule: 'no-type-object', detail: `${name}: 顶层必须 type:'object'（当前 ${JSON.stringify(schema.type)}）` });
  if (!schema.properties || typeof schema.properties !== 'object') problems.push({ rule: 'no-properties', detail: `${name}: 必须给 properties 对象（"换模型才报错"最常见起因）` });

  // HARD③：事故签名 —— **布尔** `required`（JSON Schema 的 required 永远是字符串数组；布尔值一定是扁平写法）
  //   ★ 反控修正：首版"只要 properties 路径下有 required 就报"⇒ 把合法的**嵌套对象** schema（items.properties.x 的 required:['x']）误判
  const boolRequiredAt = []; const arrayRequiredInPropNode = [];
  const walk = (node, pathStr) => {
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'required') {
        if (typeof v === 'boolean') boolRequiredAt.push(pathStr);
        else if (Array.isArray(v) && /\.properties\.[^.]+$/.test(pathStr)) arrayRequiredInPropNode.push(pathStr);
      }
      if (k === 'properties' && v && typeof v === 'object') { for (const [pn, pv] of Object.entries(v)) walk(pv, `${pathStr}.properties.${pn}`); }
      else if (k === 'items') walk(v, `${pathStr}.items`);
      else if (['anyOf', 'oneOf', 'allOf'].includes(k) && Array.isArray(v)) v.forEach((x, i) => walk(x, `${pathStr}.${k}[${i}]`));
    }
  };
  walk(schema, name);
  if (boolRequiredAt.length) problems.push({ rule: 'required-inside-property', detail: `${name}: **属性定义里出现布尔 required**（${boolRequiredAt.join(', ')}）—— 正确写法是顶层 required:[…]；这正是 400 事故的签名` });
  if (arrayRequiredInPropNode.length) warnings.push({ rule: 'array-required-in-property-node', detail: `${name}: ${arrayRequiredInPropNode.join(', ')} 直接带 required 数组 —— 合法但少见，确认这是"嵌套对象 schema"而不是写错了层级` });

  // HARD④ required 形态
  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) problems.push({ rule: 'required-not-array', detail: `${name}: required 必须是字符串数组，当前是 ${typeof schema.required}` });
    else {
      const notString = schema.required.filter((x) => typeof x !== 'string');
      if (notString.length) problems.push({ rule: 'required-non-string', detail: `${name}: required 里有非字符串项：${JSON.stringify(notString)}` });
      const unknown = schema.required.filter((x) => typeof x === 'string' && schema.properties && !(x in schema.properties));
      if (unknown.length) problems.push({ rule: 'required-unknown-prop', detail: `${name}: required 里的 ${unknown.join('/')} 不在 properties 中` });
    }
  }
  // HARD⑤ 每个属性要有类型（或合法替代）
  for (const [pn, pv] of Object.entries(schema.properties || {})) {
    const hasType = pv && (pv.type || pv.anyOf || pv.oneOf || pv.allOf || pv.enum || pv.const || pv.$ref);
    if (!hasType) problems.push({ rule: 'property-without-type', detail: `${name}.${pn}: 属性缺 type（或 anyOf/oneOf/enum/$ref）` });
  }
  // HARD⑥ 未知键
  for (const k of Object.keys(schema)) if (!OK_KEYS.has(k)) problems.push({ rule: 'unknown-key', detail: `${name}: 顶层出现严格校验器可能不认的键「${k}」` });
  if (schema.additionalProperties === undefined) warnings.push({ rule: 'suggest-additional-properties-false', detail: `${name}: 建议显式 additionalProperties:false（更严，避免模型塞多余字段）` });
  return { problems, warnings };
}

/** ★ 读 JSON 时**剥掉 BOM**：Windows 上 `Set-Content -Encoding UTF8`（及记事本）写出的 JSON 常带 \uFEFF ⇒
 *  不剥会让 `JSON.parse` 直接抛 "Unexpected token ''" —— 傻瓜式必须兜住（实测踩到）。 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function validateManifest(file) {
  if (!fs.existsSync(file)) throw new Error(`清单不存在：${file}`);
  const arr = readJson(file);
  if (!Array.isArray(arr)) throw new Error('清单必须是数组：[{name, parameters}, …]');
  if (!arr.length) throw new Error('清单为空：没有可检的工具');
  const all = { tools: arr.length, problems: [], warnings: [] };
  for (const t of arr) {
    if (!t || !t.name) { all.problems.push({ rule: 'tool-without-name', detail: '(匿名工具)' }); continue; }
    const r = validateToolSchema(t.name, t.parameters);
    all.problems.push(...r.problems); all.warnings.push(...r.warnings);
  }
  return all;
}

/** 只抓事故签名：JS 源码里的 `required: true|false`（扁平写法的痕迹）。 */
function scanJsForFlattenedRequired(file) {
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  const hits = [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((ln, i) => { if (/required\s*:\s*(true|false)\b/.test(ln) && !/\/\//.test(ln.split('required')[0])) hits.push({ line: i + 1, text: ln.trim().slice(0, 120) }); });
  return { file, flattened_required_lines: hits.length, samples: hits.slice(0, 5) };
}

function runSelftest() {
  const os = require('os');
  const results = [];
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'schema-'));
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };
  const good = { type: 'object', properties: { draft: { type: 'string', description: '稿子路径' }, n: { type: 'number' } }, required: ['draft'], additionalProperties: false };

  check('★ 正控 · 规范 schema 必须通过（含 required 数组）', () => {
    const r = validateToolSchema('t', good);
    return r.problems.length === 0 ? true : JSON.stringify(r.problems);
  });
  check('★★ 正控 · **那次事故的签名**：属性里写 required ⇒ 必须报（这是 400/"换模型才报错"的根因）', () => {
    const bad = { type: 'object', properties: { draft: { type: 'string', required: true } } };
    const r = validateToolSchema('t', bad);
    return r.problems.some((p) => p.rule === 'required-inside-property') ? true : JSON.stringify(r.problems);
  });
  check('★ 正控 · 缺 type:object / 缺 properties / required 非数组 / 属性缺 type / 未知键 ⇒ 各自报', () => {
    const a = validateToolSchema('a', { properties: {} });
    const b = validateToolSchema('b', { type: 'object' });
    const c = validateToolSchema('c', { type: 'object', properties: {}, required: 'x' });
    const d = validateToolSchema('d', { type: 'object', properties: { q: { description: 'no type' } } });
    const e = validateToolSchema('e', { type: 'object', properties: {}, weirdKey: 1 });
    const okA = a.problems.some((p) => p.rule === 'no-type-object');
    const okB = b.problems.some((p) => p.rule === 'no-properties');
    const okC = c.problems.some((p) => p.rule === 'required-not-array');
    const okD = d.problems.some((p) => p.rule === 'property-without-type');
    const okE = e.problems.some((p) => p.rule === 'unknown-key');
    return (okA && okB && okC && okD && okE) ? true : JSON.stringify({ a: a.problems, b: b.problems, c: c.problems, d: d.problems, e: e.problems });
  });
  check('★ 反控 · 合法替代（anyOf / enum / $ref）不得被误判"缺 type"', () => {
    const s = { type: 'object', properties: { mode: { anyOf: [{ type: 'string' }, { type: 'number' }] }, k: { enum: ['a', 'b'] } } };
    const r = validateToolSchema('t', s);
    return r.problems.length === 0 ? true : JSON.stringify(r.problems);
  });
  check('★ 反控 · 嵌套 items / additionalProperties 里的正常结构不得误报', () => {
    const s = { type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } } };
    const r = validateToolSchema('t', s);
    return r.problems.length === 0 ? true : JSON.stringify(r.problems);
  });
  check('★ 正控 · manifest 模式聚合多个工具的结论 + 空清单必须报前提失败（不假装检过）', () => {
    const d = mk();
    const f = path.join(d, 'ok.json'); fs.writeFileSync(f, JSON.stringify([{ name: 't1', parameters: good }]));
    const f2 = path.join(d, 'empty.json'); fs.writeFileSync(f2, JSON.stringify([]));
    const r = validateManifest(f); let e = '';
    try { validateManifest(f2); } catch (err) { e = err.message; }
    return (r.tools === 1 && r.problems.length === 0 && /清单为空/.test(e)) ? true : JSON.stringify({ r, e });
  });
  check('★ 反控（实测踩到的傻瓜式兜底）· 带 BOM 的 JSON 清单必须能解析（Windows 上 Set-Content/记事本常写 BOM）', () => {
    const d = mk(); const f = path.join(d, 'bom.json');
    fs.writeFileSync(f, '\uFEFF' + JSON.stringify([{ name: 't1', parameters: good }]), 'utf8');
    const r = validateManifest(f);
    return (r.tools === 1 && r.problems.length === 0) ? true : JSON.stringify(r);
  });
  check('★ 正控 · scan 模式抓到扁平 required 的源码痕迹（含行号）', () => {
    const d = mk(); const f = path.join(d, 'p.js');
    fs.writeFileSync(f, "parameters: { type: 'object', properties: { a: { type: 'string', required: true } } }\n");
    const r = scanJsForFlattenedRequired(f);
    return (r.flattened_required_lines === 1 && r.samples[0].line === 1) ? true : JSON.stringify(r);
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\nschema-check 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const opt = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  try {
    if (opt('--manifest')) {
      const r = validateManifest(opt('--manifest'));
      console.log(`工具 schema 校验：${r.tools} 个工具 · 问题 ${r.problems.length} · 建议 ${r.warnings.length}`);
      for (const p of r.problems) console.log(`  ✘ [${p.rule}] ${p.detail}`);
      for (const w of r.warnings) console.log(`  · [${w.rule}] ${w.detail}`);
      console.log(r.problems.length ? '  ⇒ **不通过**：严格通道可能 400 拒收、宽松通道静默通过（表现为"换模型才报错"）。' : '  ⇒ 通过（严格 JSON Schema 合规）。');
      return r.problems.length ? 1 : 0;
    }
    if (opt('--scan')) {
      const r = scanJsForFlattenedRequired(opt('--scan'));
      console.log(`扁平 required 扫描：${r.file} ⇒ ${r.flattened_required_lines} 处`);
      for (const s of r.samples) console.log(`  ✘ L${s.line} ${s.text}`);
      if (!r.flattened_required_lines) console.log('  ⇒ 未发现事故签名。注意：**只扫这一种签名**，结构化校验请用 --manifest。');
      return r.flattened_required_lines ? 1 : 0;
    }
    console.error('用法：schema-check.cjs --manifest tools.json | --scan dist/plugin.js | --selftest'); return 2;
  } catch (e) { console.error('前提层失败：' + String((e && e.message) || e)); return 2; }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { validateToolSchema, validateManifest, scanJsForFlattenedRequired, OK_KEYS, main };
