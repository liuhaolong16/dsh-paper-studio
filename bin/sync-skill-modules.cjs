#!/usr/bin/env node
/**
 * sync-skill-modules —— 从真源生成**模块化技能包**：`skills/<模块>/SKILL.md`。
 *
 * 为什么（用户 2026-10-17 追问「他们那种多 SKILL.md 更经济，为啥不用」）：
 *   · 竞品的做法（lifecycle-skills 42 个 / kalaris 281 个）是**按"何时用"拆成多个 SKILL.md**，发现器可**按需单独加载**；
 *   · 我们此前是「一两个大文档 + 一堆 references」⇒ 只做"润色"这一件事也要吞下全部 47 个子命令的文档 ⇒ 命中不准、token 不经济。
 *   · 但我们的做法要**带自己的约束**：模块不许写成空话 —— 每模块的每条命令必须**真实存在于 SUBCOMMANDS**，
 *     且**并集必须恰好等于真源 agent_facing**（不许漏、不许幽灵、不许一条命令挂两个模块）。
 *
 * 用法：node bin/sync-skill-modules.cjs [--check]   ·   --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const START_I = '<!-- AUTO:skill-modules:start';
const END_I = '<!-- AUTO:skill-modules:end -->';
const START_M = '<!-- AUTO:skill-module:start';
const END_M = '<!-- AUTO:skill-module:end -->';
const SCRIPT_REL = 'bin/sync-skill-modules.cjs';
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const re = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 从根 SKILL.md 取某命令的一行说明（命令侧权威描述的唯一来源） */
function oneLiner(rootDoc, cmd) {
  for (const line of rootDoc.split('\n')) {
    if (line.indexOf('studio.cjs ' + cmd) >= 0) {
      const m = /::\s*(.+)$/.exec(line);
      return m ? m[1].trim() : line.trim().slice(0, 110);
    }
  }
  return '（根文档未写一行说明 —— 请补根文档）';
}

/** 校验模块表（纯函数；把"空话模块/漏项/重复/幽灵"全部拦下） */
function validateModules(mods, agentFacing, subcommands) {
  const errs = [];
  if (!Array.isArray(mods) || !mods.length) return ['真源没有 skill_modules（或为空）'];
  const seen = {};
  for (const m of mods) {
    if (!m || !/^[a-z][a-z0-9-]*$/.test(String(m.id || ''))) { errs.push('模块 id 非 kebab-case：' + JSON.stringify(m && m.id)); continue; }
    if (fs.existsSync(path.join(ROOT, 'skills', m.id, 'SKILL.md')) === false && !m._allowMissing) { /* 首次生成时允许不存在 */ }
    if (String(m.when || '').length < 20) errs.push(m.id + '：when（何时用）不足 20 字 ⇒ 发现器按它命中，写太短等于没写');
    if (m.triggers !== undefined) {
      if (!Array.isArray(m.triggers) || !m.triggers.length) errs.push(m.id + '：triggers 给了但为空 ⇒ 要么删掉该字段，要么写真触发词');
      else for (const t of m.triggers) if (String(t).length < 2) errs.push(m.id + '：triggers 里有过短项「' + t + '」（<2 字，发现器命中不到）');
    }
    const cmds = Array.isArray(m.commands) ? m.commands : [];
    if (!cmds.length) errs.push(m.id + '：一个命令都没挂 ⇒ 空话模块');
    for (const c of cmds.concat(Array.isArray(m.extra_commands) ? m.extra_commands : [])) {
      if (subcommands.indexOf(c) < 0) errs.push(m.id + '：命令 ' + c + ' 不在 SUBCOMMANDS 里（幽灵命令）');
    }
    for (const c of cmds) {
      if (seen[c]) errs.push('命令 ' + c + ' 被两个模块同时认领：' + seen[c] + ' 与 ' + m.id + '（同一件事只能有一个所有者）');
      seen[c] = m.id;
      if (agentFacing.indexOf(c) < 0) errs.push(m.id + '：命令 ' + c + ' 不在真源 agent_facing 里（要么它是 CLI 直用命令、应放 extra_commands，要么真源漏登记）');
    }
  }
  const missing = agentFacing.filter((c) => !seen[c]);
  if (missing.length) errs.push('真源 agent_facing 有命令没被任何模块认领：' + missing.join(', '));
  return errs;
}

function buildModuleDoc(m, rootDoc) {
  const L = [];
  L.push('---');
  L.push('name: ' + m.id);
  L.push('description: |');
  L.push('  ' + m.title + '。' + m.when);
  L.push('  **不用于**：' + (m.not_for || '与本科目无关的任务（先走根 `SKILL.md` 的路由表）') + '。');
  if (Array.isArray(m.triggers) && m.triggers.length) L.push('  Triggers on: ' + m.triggers.join(' · ') + '。');
  L.push('  真源：`references/pipeline.json` 的 `skill_modules.' + m.id + '`；本文件由 `' + SCRIPT_REL + '` 生成，**勿手改**。');
  L.push('---');
  L.push('');
  L.push('# ' + m.title);
  L.push('');
  L.push(START_M + ' 由 ' + SCRIPT_REL + ' 生成 -->');
  L.push('');
  L.push('## 何时用');
  L.push('');
  L.push(m.when);
  L.push('');
  L.push('## 这个模块管什么（命令面）');
  L.push('');
  L.push('| 命令 | 说明 |');
  L.push('|---|---|');
  for (const c of m.commands) L.push('| `' + c + '` | ' + oneLiner(rootDoc, c).replace(/\|/g, '/') + ' |');
  L.push('');
  if (Array.isArray(m.extra_commands) && m.extra_commands.length) {
    L.push('**相关 CLI（非 agent_facing，供直接调用）**：' + m.extra_commands.map((c) => '`' + c + '`').join(' · '));
    L.push('');
  }
  if (Array.isArray(m.gates) && m.gates.length) {
    L.push('## 相关门');
    L.push('');
    for (const g of m.gates) L.push('- `' + g + '`');
    L.push('');
  }
  if (Array.isArray(m.assets) && m.assets.length) {
    L.push('## 相关真源与资产');
    L.push('');
    for (const a of m.assets) L.push('- `' + a + '`');
    L.push('');
  }
  if (Array.isArray(m.boundaries) && m.boundaries.length) {
    L.push('## 边界（这些事本模块不做）');
    L.push('');
    for (const b of m.boundaries) L.push('- ' + b);
    L.push('');
  }
  L.push('## 与整包的关系');
  L.push('');
  L.push('- 入口（命令侧全文）：根 `SKILL.md`；入口（对话侧）：`plugin/skill/SKILL.md`。');
  L.push('- 全模块索引见根 `SKILL.md` 的「能力模块索引」段（同上由生成器维护）。');
  L.push('- 本模块只写"何时用 + 命令面 + 边界"；**判据与数字一律在真源**，此处不复制第二份。');
  L.push('');
  L.push(END_M);
  L.push('');
  return L.join('\n');
}

function buildIndex(mods) {
  const L = [START_I + ' 由 ' + SCRIPT_REL + ' 生成；勿手改 -->', '', '## 能力模块索引（按需要单独加载 · ' + mods.length + ' 个模块）', '',
    '> 发现器可按"何时用"只加载其中一个模块，不必吞下整包文档。每个模块的命令并集 = 真源 `agent_facing`（机器核对，见 `' + SCRIPT_REL + ' --check`）。', '',
    '| 模块 | 何时用 | 命令数 |', '|---|---|---|'];
  for (const m of mods) L.push('| [`skills/' + m.id + '/SKILL.md`](skills/' + m.id + '/SKILL.md) | ' + String(m.when).replace(/\|/g, '/') + ' | ' + m.commands.length + ' |');
  L.push('', END_I, '');
  return L.join('\n');
}

function sync(opt) {
  const o = opt || {};
  const studio = require(path.join(ROOT, 'bin', 'studio.cjs'));
  const pj = studio.readPipeline();                        // ★ 真源只许 studio 读
  const mods = pj.skill_modules;
  const errs = validateModules(mods, pj.agent_facing || [], studio.SUBCOMMANDS || []);
  if (errs.length) return { ok: false, errors: errs, changed: false, modules: (mods || []).length };
  const rootDoc = read(path.join(ROOT, 'SKILL.md'));
  const changed = [];
  for (const m of mods) {
    const dir = path.join(ROOT, 'skills', m.id);
    const file = path.join(dir, 'SKILL.md');
    const doc = buildModuleDoc(m, rootDoc);
    const cur = fs.existsSync(file) ? read(file) : '';
    if (cur !== doc) { changed.push('skills/' + m.id + '/SKILL.md'); if (!o.check) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, doc, 'utf8'); } }
  }
  /* 索引段写进两份入口文档（保证"两份说法"由生成器统一） */
  const index = buildIndex(mods);
  for (const rel of [['SKILL.md', 'root'], ['plugin/skill/SKILL.md', 'flat']]) {
    const p = path.join(ROOT, ...rel[0].split('/'));
    if (!fs.existsSync(p)) continue;
    const cur = read(p);
    const r = new RegExp(re(START_I) + '[\\s\\S]*?' + re(END_I) + '\\n?');
    const next = r.test(cur) ? cur.replace(r, () => index) : (cur.replace(/\s*$/, '') + '\n\n' + index);
    if (next !== cur) { changed.push(rel[0]); if (!o.check) fs.writeFileSync(p, next, 'utf8'); }
  }
  return { ok: true, changed: changed.length > 0, changed_files: changed, modules: mods.length,
    commands: (pj.agent_facing || []).length };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };
  const M = (id, cmds, when) => ({ id, title: 'T', when: when || '当用户要求做与本科目相关的事情时需要用到本模块', commands: cmds });

  ck('校验·正控：覆盖 agent_facing 的模块表必须通过', () => {
    const e = validateModules([M('a', ['x', 'y']), M('b', ['z'])], ['x', 'y', 'z'], ['x', 'y', 'z']);
    return e.length === 0 ? true : JSON.stringify(e);
  });

  ck('★必失败面：漏认领（真源有命令没模块管）⇒ 必须报出', () => {
    const e = validateModules([M('a', ['x'])], ['x', 'y'], ['x', 'y']);
    return e.some((s) => /没被任何模块认领/.test(s) && /y/.test(s)) ? true : JSON.stringify(e);
  });

  ck('★必失败面：幽灵命令（不在 SUBCOMMANDS）⇒ 必须报出', () => {
    const e = validateModules([M('a', ['x', 'ghost'])], ['x'], ['x']);
    return e.some((s) => /幽灵命令/.test(s)) ? true : JSON.stringify(e);
  });

  ck('★必失败面：一条命令被两个模块认领 ⇒ 必须报出（同一件事只能有一个所有者）', () => {
    const e = validateModules([M('a', ['x']), M('b', ['x'])], ['x'], ['x']);
    return e.some((s) => /被两个模块同时认领/.test(s)) ? true : JSON.stringify(e);
  });

  ck('★必失败面：空话模块（无命令 / when 太短）⇒ 必须报出', () => {
    const e1 = validateModules([M('a', [], '当用户要写论文时使用这个模块')], [], ['x']);
    const e2 = validateModules([M('a', ['x'], '短')], ['x'], ['x']);
    if (!e1.some((s) => /空话模块/.test(s))) return '无命令未报：' + JSON.stringify(e1);
    return e2.some((s) => /不足 20 字/.test(s)) ? true : ('when 太短未报：' + JSON.stringify(e2));
  });

  ck('生成：模块文档必须含 frontmatter（name/description）与命令表，且幂等', () => {
    const doc = buildModuleDoc(M('paper-x', ['route'], '当用户要做路由时需要本模块'), 'node bin/studio.cjs route :: 路由到资产');
    if (!/^---\nname: paper-x\n/.test(doc)) return '缺 frontmatter name';
    if (!/description: \|/.test(doc)) return '缺 description';
    if (doc.indexOf('| `route` |') < 0) return '缺命令表行';
    if (doc !== buildModuleDoc(M('paper-x', ['route'], '当用户要做路由时需要本模块'), 'node bin/studio.cjs route :: 路由到资产')) return '两次生成不一致';
    return true;
  });

  ck('索引：模块索引必须列出每个模块的路径与「何时用」', () => {
    const idx = buildIndex([M('a', ['x'], '当用户要看甲科目时使用'), M('b', ['y'], '当用户要看乙科目时使用')]);
    if (idx.indexOf('skills/a/SKILL.md') < 0 || idx.indexOf('skills/b/SKILL.md') < 0) return '缺模块路径';
    if (idx.indexOf('当用户要看甲科目时使用') < 0) return '缺何时用';
    return /2 个模块/.test(idx) ? true : '缺模块数';
  });

  ck('实盘：真源模块表必须通过校验，且生成物与磁盘一致（--check 为空）', () => {
    const r = sync({ check: true });
    if (!r.ok) return '校验失败：' + JSON.stringify(r.errors);
    return r.changed === false ? true : ('磁盘与真源不一致：' + (r.changed_files || []).join(', '));
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nsync-skill-modules 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const r = sync({ check: argv.includes('--check') });
  if (!r.ok) { console.error('模块表校验失败：\n  ' + r.errors.join('\n  ')); return 2; }
  if (argv.includes('--check')) {
    if (r.changed) { console.error('不同步：' + (r.changed_files || []).join(' / ') + ' ⇒ 跑 node ' + SCRIPT_REL); return 1; }
    console.log('同步：' + r.modules + ' 个模块的 SKILL.md 与索引段都与真源一致（覆盖 ' + r.commands + ' 条 agent_facing 命令）');
    return 0;
  }
  console.log(r.changed ? ('已生成/更新：' + (r.changed_files || []).join(' / ')) : ('已是最新（' + r.modules + ' 个模块，无改动）'));
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { sync, validateModules, buildModuleDoc, buildIndex, oneLiner, main, selftest };
