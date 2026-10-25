#!/usr/bin/env node
/**
 * longform.cjs —— 多角色长文流水线（吸收论衡的角色分工与人在环，但判据落在本仓）
 *
 * 用法：
 *   node bin/longform.cjs --plan --genre <academic|wechat|report|book-review|policy> --topic "<题目>" --out <目录>
 *   node bin/longform.cjs --state --dir <目录> [--set phase=1 | --set role=T1=done]
 *   node bin/longform.cjs --check --dir <目录>
 *   node bin/longform.cjs --selftest
 *
 * 退出码：0 通过 · 1 有失败项 · 2 前提层失败（缺文件/参数/JSON）
 * 设计边界：只做“流程状态 + 可机械检的交付物”，不做语义评判；文类结构/字数/引用阈值来自 references/longform.json。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'references', 'longform.json');

function readSpec() {
  return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
}
function flag(argv, name) {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : '';
}
function countUnits(text) {
  const body = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  const cjk = (body.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latin = (body.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  return cjk + latin;
}
function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; }
}
function phaseIndex(spec, id) {
  return spec.phases.findIndex((p) => String(p.id) === String(id));
}

function cmdPlan(spec, argv) {
  const genre = flag(argv, '--genre');
  const topic = flag(argv, '--topic') || '(未命名)';
  const out = flag(argv, '--out');
  if (!genre || !spec.genres[genre]) {
    console.log('前提层失败：--genre 必须是 ' + Object.keys(spec.genres).join(' / '));
    return 2;
  }
  if (!out) { console.log('前提层失败：缺 --out <目录>'); return 2; }
  fs.mkdirSync(out, { recursive: true });
  const g = spec.genres[genre];
  const L = [];
  L.push('# 长文任务包 · ' + topic, '');
  L.push('- 文类：' + g.label + '（`' + genre + '`）');
  L.push('- 字数预算：' + g.min_units + '–' + g.max_units + ' 单位（CJK 字 + 西文词）');
  L.push('- 引用下限：' + g.citations_min + (g.declarations ? ' · 必须含声明段' : ''));
  L.push('- 目标读者：由 Phase 0 与作者确认（模型不得代选）', '');
  L.push('## 阶段（人在环节点标 👤）', '');
  for (const p of spec.phases) L.push(`- Phase ${p.id} ${p.name}${p.human ? ' 👤' : ''} — ${p.why}`);
  L.push('', '## 角色与交付物（互不可替代）', '');
  L.push('| 角色 | 名称 | 交付物 | 最少字数 | 提示词 |');
  L.push('|---|---|---|---|---|');
  for (const r of spec.roles) L.push(`| ${r.id} | ${r.name} | \`${r.file}\` | ${r.min_chars} | ${r.prompt.replace(/\|/g, '\\|')} |`);
  L.push('', '## 下一步', '');
  L.push('1. Phase 0 由人确认题目/读者/文类后：`--state --dir <目录> --set phase=1`');
  L.push('2. 按角色产出文件；每完成一个：`--state --dir <目录> --set role=T1=done`（文件不存在或不足字数会拒绝）');
  L.push('3. 终稿写入 `' + spec.checks.final_file + '` 后跑 `--check --dir <目录>`；失败项按输出逐条修。');
  fs.writeFileSync(path.join(out, spec.checks.task_file), L.join('\n') + '\n', 'utf8');
  const state = {
    version: 1, genre, topic, phase: '0',
    roles: Object.fromEntries(spec.roles.map((r) => [r.id, 'pending'])),
    history: [{ at: new Date().toISOString(), action: 'plan', genre, topic }]
  };
  fs.writeFileSync(path.join(out, 'longform-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log('已建任务包：' + out);
  console.log('  阶段 0 · 角色 ' + spec.roles.length + ' 个 · 文类 ' + genre);
  console.log('  下一步：人确认题目后 --state --dir "' + out + '" --set phase=1');
  return 0;
}

function cmdState(spec, argv) {
  const dir = flag(argv, '--dir');
  const set = flag(argv, '--set');
  if (!dir) { console.log('前提层失败：缺 --dir <目录>'); return 2; }
  const sp = path.join(dir, 'longform-state.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); }
  catch (e) { console.log('前提层失败：读不到或解析不了 ' + sp); return 2; }
  if (set) {
    const mPhase = /^phase=(.+)$/.exec(set);
    const mRole = /^role=([^=]+)=(.+)$/.exec(set);
    if (mPhase) {
      const want = mPhase[1];
      const cur = phaseIndex(spec, st.phase);
      const next = phaseIndex(spec, want);
      if (next < 0) { console.log('失败：未知阶段 ' + want); return 1; }
      if (next > cur + 1) { console.log(`失败：不能从 Phase ${st.phase} 跳到 ${want}（必须先完成中间阶段）`); return 1; }
      if (next < cur) { console.log(`失败：不能回退阶段（当前 ${st.phase} → ${want}）`); return 1; }
      st.phase = String(want);
      st.history.push({ at: new Date().toISOString(), action: 'phase', to: String(want) });
    } else if (mRole) {
      const id = mRole[1], val = mRole[2];
      const role = spec.roles.find((r) => r.id === id);
      if (!role) { console.log('失败：未知角色 ' + id); return 1; }
      if (!['pending', 'done'].includes(val)) { console.log('失败：角色状态只能是 pending / done'); return 1; }
      if (!(id in st.roles)) { console.log('失败：state 里没有角色 ' + id); return 1; }
      if (val === 'done') {
        const fp = path.join(dir, role.file);
        const text = readIf(fp);
        if (text == null) { console.log(`失败：${id} 标 done 但交付物不存在 ${role.file}`); return 1; }
        const n = countUnits(text);
        if (n < role.min_chars) { console.log(`失败：${role.file} 只有 ${n} 单位，低于 ${role.min_chars}`); return 1; }
      }
      st.roles[id] = val;
      st.history.push({ at: new Date().toISOString(), action: 'role', role: id, to: val });
    } else {
      console.log('失败：--set 只支持 phase=<id> 或 role=<T#>=done|pending');
      return 1;
    }
    fs.writeFileSync(sp, JSON.stringify(st, null, 2) + '\n', 'utf8');
  }
  console.log(`阶段：${st.phase} · 文类：${st.genre} · ${st.topic}`);
  console.log('角色：' + spec.roles.map((r) => r.id + '=' + (st.roles[r.id] || 'pending')).join(' · '));
  return 0;
}

function cmdCheck(spec, argv) {
  const dir = flag(argv, '--dir');
  if (!dir) { console.log('前提层失败：缺 --dir <目录>'); return 2; }
  const sp = path.join(dir, 'longform-state.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); }
  catch (e) { console.log('前提层失败：读不到或解析不了 ' + sp); return 2; }
  const g = spec.genres[st.genre];
  if (!g) { console.log('前提层失败：state 里的文类未知 ' + st.genre); return 2; }
  const fails = [];
  const warns = [];
  const task = readIf(path.join(dir, spec.checks.task_file));
  if (task == null) fails.push('缺任务包 ' + spec.checks.task_file);
  for (const r of spec.roles) {
    if (r.id === 'T9' && st.genre !== 'academic') continue;
    const fp = path.join(dir, r.file);
    const text = readIf(fp);
    if (text == null) { fails.push(`缺角色交付物 ${r.file}（${r.id} ${r.name}）`); continue; }
    const n = countUnits(text);
    if (n < r.min_chars) fails.push(`${r.file} 只有 ${n} 单位，低于 ${r.min_chars}`);
  }
  const finalPath = path.join(dir, spec.checks.final_file);
  const finalText = readIf(finalPath);
  if (finalText == null) {
    fails.push('缺终稿 ' + spec.checks.final_file);
  } else {
    const units = countUnits(finalText);
    if (units < g.min_units) fails.push(`终稿 ${units} 单位，低于下限 ${g.min_units}`);
    if (units > g.max_units) fails.push(`终稿 ${units} 单位，超过上限 ${g.max_units}`);
    for (const h of g.structure || []) if (!finalText.includes(h)) fails.push('终稿缺结构项「' + h + '」');
    const cites = (finalText.match(new RegExp(spec.checks.citation_re, 'g')) || []).length;
    if (cites < g.citations_min) fails.push(`引用标记 ${cites} 个，低于下限 ${g.citations_min}`);
    if (g.declarations) {
      for (const p of spec.checks.declaration_patterns) {
        if (!new RegExp(p, 'i').test(finalText)) fails.push('缺声明段（正则 ' + p + '）');
      }
    }
    let hits = 0, sample = [];
    for (const p of spec.checks.ai_trace_patterns) {
      const n = (finalText.split(p).length - 1);
      if (n > 0) { hits += n; if (sample.length < 3) sample.push(p); }
    }
    if (hits >= spec.checks.ai_trace_fail_at) fails.push(`AI 痕迹词命中 ${hits} 次（阈值 ${spec.checks.ai_trace_fail_at}）：${sample.join(' / ')}`);
    else if (hits > 0) warns.push(`AI 痕迹词命中 ${hits} 次（未达阈值）`);
  }
  console.log('长文机检 · ' + (st.topic || '') + ' · 文类 ' + st.genre);
  for (const w of warns) console.log('  WARN ' + w);
  if (!fails.length) {
    console.log('通过：交付物齐、字数/结构/引用/AI 痕迹均在阈值内');
    return 0;
  }
  console.log(`未通过（${fails.length} 项）：`);
  for (const f of fails) console.log('  [FAIL] ' + f);
  return 1;
}

function writeRole(dir, name, text) {
  fs.writeFileSync(path.join(dir, name), text, 'utf8');
}
function pad(s, n) {
  let out = s;
  while (countUnits(out) < n) out += '\n' + s;
  return out;
}
function cmdSelftest() {
  const spec = readSpec();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'longform-'));
  let pass = 0, total = 0;
  // 判定必须严格 === true：失败时 reason 是字符串，用 !!cond 会把「失败原因」误读成通过。
  const ck = (name, cond, why) => {
    total++;
    if (cond === true) { pass++; console.log('PASS  ' + name); }
    else console.log('FAIL  ' + name + '  ' + (why || ''));
  };
  const run = (argv) => {
    const [cmd, ...rest] = argv;
    if (cmd === '--plan') return cmdPlan(spec, argv);
    if (cmd === '--state') return cmdState(spec, argv);
    if (cmd === '--check') return cmdCheck(spec, argv);
    return 2;
  };
  const d1 = path.join(base, 'p1');
  ck('plan 建任务包与状态', run(['--plan', '--genre', 'academic', '--topic', '测试题', '--out', d1]) === 0 && fs.existsSync(path.join(d1, 'longform-state.json')));
  ck('状态含 9 角色', Object.keys(JSON.parse(fs.readFileSync(path.join(d1, 'longform-state.json'), 'utf8')).roles).length === 9);
  ck('跳阶段必须被拒', run(['--state', '--dir', d1, '--set', 'phase=5']) === 1);
  ck('角色无文件标 done 必须被拒', run(['--state', '--dir', d1, '--set', 'role=T1=done']) === 1);
  writeRole(d1, '01-文献.md', pad('[1] A 2024. DOI 10.1/x', 400));
  ck('角色达成后可标 done', run(['--state', '--dir', d1, '--set', 'role=T1=done']) === 0);
  ck('交付物不全必须失败', run(['--check', '--dir', d1]) === 1);

  const d2 = path.join(base, 'p2');
  run(['--plan', '--genre', 'academic', '--topic', '完整稿', '--out', d2]);
  for (const r of spec.roles) writeRole(d2, r.file, pad('内容 ' + r.id + ' 证据与说明', Math.max(r.min_chars + 50, 600)));
  const acadFinal = ['# 题目', '## 摘要', '摘要正文', '## 关键词', '关键词', '## 引言', '引言', '## 方法', '方法', '## 结果', '结果', '## 讨论', '讨论', '## 参考文献', Array.from({ length: 12 }, (_, i) => `[${i + 1}] Ref ${i}`).join(' '), '利益冲突：无', '数据可用性：可请求', '正文补充内容说明 '.repeat(450)].join('\n');
  writeRole(d2, '90-终稿.md', acadFinal);
  ck('完整学术稿通过', run(['--check', '--dir', d2]) === 0);

  const d3 = path.join(base, 'p3');
  run(['--plan', '--genre', 'academic', '--topic', '缺引用', '--out', d3]);
  for (const r of spec.roles) if (r.id !== 'T9') writeRole(d3, r.file, pad('内容 ' + r.id, Math.max(r.min_chars + 50, 600)));
  writeRole(d3, '90-终稿.md', ['摘要', '关键词', '引言', '方法', '结果', '讨论', '参考文献', '利益冲突：无', '数据可用性：可请求', '正文内容补充说明 '.repeat(500)].join('\n'));
  ck('学术稿缺引用必须失败', run(['--check', '--dir', d3]) === 1);

  const d4 = path.join(base, 'p4');
  run(['--plan', '--genre', 'wechat', '--topic', '公众号', '--out', d4]);
  for (const r of spec.roles) if (r.id !== 'T9') writeRole(d4, r.file, pad('内容 ' + r.id, Math.max(r.min_chars + 50, 600)));
  writeRole(d4, '90-终稿.md', '正文内容补充说明 '.repeat(400));
  ck('公众号无引用可通过', run(['--check', '--dir', d4]) === 0);

  const d5 = path.join(base, 'p5');
  run(['--plan', '--genre', 'wechat', '--topic', 'AI 味', '--out', d5]);
  for (const r of spec.roles) if (r.id !== 'T9') writeRole(d5, r.file, pad('内容 ' + r.id, Math.max(r.min_chars + 50, 600)));
  writeRole(d5, '90-终稿.md', '综上所述，值得注意的是，在当今，随着社会的不断发展，' + '正文内容补充说明 '.repeat(250));
  ck('AI 痕迹超阈值必须失败', run(['--check', '--dir', d5]) === 1);

  const d6 = path.join(base, 'p6');
  run(['--plan', '--genre', 'book-review', '--topic', '短书评', '--out', d6]);
  for (const r of spec.roles) if (r.id !== 'T9') writeRole(d6, r.file, pad('内容 ' + r.id, Math.max(r.min_chars + 50, 600)));
  writeRole(d6, '90-终稿.md', '太短');
  ck('字数不足必须失败', run(['--check', '--dir', d6]) === 1);

  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\nlongform 自检：${pass}/${total} 通过`);
  return pass === total ? 0 : 1;
}

function main(argv) {
  const cmd = argv[0];
  try {
    if (!cmd || argv.includes('--help')) {
      console.log('用法：--plan --genre <文类> --topic "<题目>" --out <目录> | --state --dir <目录> [--set phase=<id>|role=<T#>=done|pending] | --check --dir <目录> | --selftest');
      return cmd ? 0 : 2;
    }
    if (cmd === '--selftest') return cmdSelftest();
    const spec = readSpec();
    if (cmd === '--plan') return cmdPlan(spec, argv);
    if (cmd === '--state') return cmdState(spec, argv);
    if (cmd === '--check') return cmdCheck(spec, argv);
    console.log('未知参数：' + cmd);
    return 2;
  } catch (e) {
    console.log('前提层失败：' + e.message);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { cmdPlan, cmdState, cmdCheck, cmdSelftest, countUnits };
