#!/usr/bin/env node
/**
 * longform.cjs —— 多角色长文流水线（角色分工 + 人在环 + 审稿回环 + 配图/演示/选题）
 *
 * 用法：
 *   --plan --genre <academic|wechat|report|book-review|policy> --topic "<题目>" --out <目录>
 *   --state --dir <目录> [--set phase=<id> | --set role=T1=done]
 *   --check --dir <目录>
 *   --review --draft <稿.md> --out <目录> [--rounds 2]      # 多轮批判/审计/审稿 + 修订说明
 *   --review-check --dir <目录>
 *   --selftest
 *
 * 退出码：0 通过 · 1 有失败项 · 2 前提层失败
 * 设计边界：只判流程状态与可机械检项；语义质量由角色交付物与人负责。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SPEC_PATH = path.join(ROOT, 'references', 'longform.json');

function readSpec() { return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')); }
function flag(argv, name) { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : ''; }
function countUnits(text) {
  const body = String(text || '').replace(/```[\s\S]*?```/g, ' ');
  const cjk = (body.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
  const latin = (body.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  return cjk + latin;
}
function readIf(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return null; } }
function phaseIndex(spec, id) { return spec.phases.findIndex((p) => String(p.id) === String(id)); }
function requiredRoles(spec, genre) {
  const g = spec.genres[genre] || {};
  return spec.roles.filter((r) => {
    if (r.id === 'T9') return genre === 'academic';
    if (r.id === 'T10') return !!g.visual;
    if (r.id === 'T11') return !!g.slides;
    return true;
  });
}

function cmdPlan(spec, argv) {
  const genre = flag(argv, '--genre');
  const topic = flag(argv, '--topic') || '(未命名)';
  const out = flag(argv, '--out');
  if (!genre || !spec.genres[genre]) { console.log('前提层失败：--genre 必须是 ' + Object.keys(spec.genres).join(' / ')); return 2; }
  if (!out) { console.log('前提层失败：缺 --out <目录>'); return 2; }
  fs.mkdirSync(out, { recursive: true });
  const g = spec.genres[genre];
  const roles = requiredRoles(spec, genre);
  const L = [];
  L.push('# 长文任务包 · ' + topic, '');
  L.push('- 文类：' + g.label + '（`' + genre + '`）');
  L.push('- 字数预算：' + g.min_units + '–' + g.max_units + ' 单位（CJK 字 + 西文词）');
  L.push('- 引用下限：' + g.citations_min + (g.declarations ? ' · 必须含声明段' : '') + (g.visual ? ' · 需配图规格' : '') + (g.slides ? ' · 需演示页数' : ''));
  L.push('- 目标读者：由 Phase 0 与作者确认（模型不得代选）', '');
  L.push('## 阶段（人在环节点标 👤）', '');
  for (const p of spec.phases) L.push(`- Phase ${p.id} ${p.name}${p.human ? ' 👤' : ''} — ${p.why}`);
  L.push('', '## Phase 0 选题工作表（必须是人选的，不是模型代选）', '');
  L.push('新建 `' + spec.checks.topic_file + '`，至少列 3 个候选，每个候选给：读者 / 新意 / 可行性 / 证据可得性 / 风险，并标出最终选择与理由。');
  L.push('', '## 角色与交付物（互不可替代）', '');
  L.push('| 角色 | 名称 | 交付物 | 最少字数 | 提示词 |');
  L.push('|---|---|---|---|---|');
  for (const r of roles) L.push(`| ${r.id} | ${r.name} | \`${r.file}\` | ${r.min_chars} | ${r.prompt.replace(/\|/g, '\\|')} |`);
  L.push('', '## 下一步', '');
  L.push('1. 人确认题目/读者/文类后：`--state --dir <目录> --set phase=1`');
  L.push('2. 按角色产出文件；每完成一个：`--state --dir <目录> --set role=T1=done`（文件不存在或不足字数会拒绝）');
  L.push('3. 终稿写入 `' + spec.checks.final_file + '` 后跑 `--check --dir <目录>`；失败项按输出逐条修。');
  L.push('4. 已有稿要挑错：`--review --draft <稿.md> --out <目录> --rounds 2`，按轮跑 T6/T7/T9 并写修订说明。');
  fs.writeFileSync(path.join(out, spec.checks.task_file), L.join('\n') + '\n', 'utf8');
  const state = {
    version: 2, genre, topic, phase: '0',
    roles: Object.fromEntries(roles.map((r) => [r.id, 'pending'])),
    history: [{ at: new Date().toISOString(), action: 'plan', genre, topic }]
  };
  fs.writeFileSync(path.join(out, 'longform-state.json'), JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log('已建任务包：' + out);
  console.log('  阶段 0 · 角色 ' + roles.length + ' 个 · 文类 ' + genre);
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
      if (!(id in st.roles)) { console.log('失败：该文类不需要角色 ' + id); return 1; }
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
  console.log('角色：' + Object.keys(st.roles).map((r) => r + '=' + st.roles[r]).join(' · '));
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
  const fails = [], warns = [];
  if (readIf(path.join(dir, spec.checks.task_file)) == null) fails.push('缺任务包 ' + spec.checks.task_file);

  const topicText = readIf(path.join(dir, spec.checks.topic_file));
  if (topicText == null) fails.push('缺选题工作表 ' + spec.checks.topic_file);
  else {
    const n = (topicText.match(/候选/g) || []).length;
    if (n < spec.checks.topic_min_candidates) fails.push(`选题工作表只有 ${n} 个候选，少于 ${spec.checks.topic_min_candidates}`);
  }

  for (const r of requiredRoles(spec, st.genre)) {
    const text = readIf(path.join(dir, r.file));
    if (text == null) { fails.push(`缺角色交付物 ${r.file}（${r.id} ${r.name}）`); continue; }
    const n = countUnits(text);
    if (n < r.min_chars) fails.push(`${r.file} 只有 ${n} 单位，低于 ${r.min_chars}`);
    if (r.id === 'T10') {
      const hits = (text.match(new RegExp(spec.checks.visual_entry_re, 'gi')) || []).length;
      if (hits < 2) fails.push(`15-配图.md 只有 ${hits} 条合格图规格（需 图N + 来源 + dpi/分辨率，至少 2 条）`);
    }
    if (r.id === 'T11') {
      const lines = text.split('\n').filter((ln) => /^\s*(?:\||#{1,4}\s*)?(?:P|第)?\d+[\.、:：]/.test(ln)).length;
      if (lines < spec.checks.slides_min) fails.push(`16-演示.md 只有 ${lines} 页，少于 ${spec.checks.slides_min}`);
      if (!new RegExp(spec.checks.slides_total_re).test(text)) fails.push('16-演示.md 缺总时长');
    }
  }

  const finalText = readIf(path.join(dir, spec.checks.final_file));
  if (finalText == null) fails.push('缺终稿 ' + spec.checks.final_file);
  else {
    const units = countUnits(finalText);
    if (units < g.min_units) fails.push(`终稿 ${units} 单位，低于下限 ${g.min_units}`);
    if (units > g.max_units) fails.push(`终稿 ${units} 单位，超过上限 ${g.max_units}`);
    for (const h of g.structure || []) if (!finalText.includes(h)) fails.push('终稿缺结构项「' + h + '」');
    const cites = (finalText.match(new RegExp(spec.checks.citation_re, 'g')) || []).length;
    if (cites < g.citations_min) fails.push(`引用标记 ${cites} 个，低于下限 ${g.citations_min}`);
    if (g.declarations) for (const p of spec.checks.declaration_patterns) if (!new RegExp(p, 'i').test(finalText)) fails.push('缺声明段（正则 ' + p + '）');
    let hits = 0, sample = [];
    for (const p of spec.checks.ai_trace_patterns) {
      const n = finalText.split(p).length - 1;
      if (n > 0) { hits += n; if (sample.length < 3) sample.push(p); }
    }
    if (hits >= spec.checks.ai_trace_fail_at) fails.push(`AI 痕迹词命中 ${hits} 次（阈值 ${spec.checks.ai_trace_fail_at}）：${sample.join(' / ')}`);
    else if (hits > 0) warns.push(`AI 痕迹词命中 ${hits} 次（未达阈值）`);
  }
  console.log('长文机检 · ' + (st.topic || '') + ' · 文类 ' + st.genre);
  for (const w of warns) console.log('  WARN ' + w);
  if (!fails.length) { console.log('通过：交付物齐、字数/结构/引用/配图/演示/AI 痕迹均在阈值内'); return 0; }
  console.log(`未通过（${fails.length} 项）：`);
  for (const f of fails) console.log('  [FAIL] ' + f);
  return 1;
}

function cmdReviewPlan(spec, argv) {
  const draft = flag(argv, '--draft');
  const out = flag(argv, '--out');
  const rounds = Number(flag(argv, '--rounds') || spec.review.rounds_default);
  if (!draft || !fs.existsSync(draft)) { console.log('前提层失败：缺 --draft 或文件不存在'); return 2; }
  if (!out) { console.log('前提层失败：缺 --out <目录>'); return 2; }
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) { console.log('前提层失败：--rounds 必须是 1–5'); return 2; }
  fs.mkdirSync(out, { recursive: true });
  const L = [];
  L.push('# 审稿回环任务 · ' + path.basename(draft), '');
  L.push('- 稿件：`' + draft + '`');
  L.push('- 轮数：' + rounds + '（每轮：T6 批判 → T9 审稿 → T7 审计 → 修订说明）');
  L.push('- 角色文件：`11-批判-r{n}.md` / `14-审稿-r{n}.md` / `12-审计-r{n}.md` / `15-修订说明-r{n}.md`');
  L.push('- 规则：批判里每条问题用 `- [P<n>] …`；修订说明必须逐条回应（`[P<n>] 已修/不修/保留 + 理由`）；不回应不得进入下一轮。', '');
  L.push('## 每轮判据', '');
  L.push('1. 批判至少 1 条问题；审稿至少 200 字；审计至少 200 字。');
  L.push('2. 修订说明引用的问题编号必须覆盖批判里的全部编号。');
  L.push('3. 全部轮次完成后，把修订版写入 `90-终稿.md` 再跑 `--review-check`。');
  fs.writeFileSync(path.join(out, '00-审稿任务.md'), L.join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(out, 'longform-review.json'), JSON.stringify({ version: 1, draft, rounds, status: 'open', createdAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  console.log('已建审稿回环：' + out + ' · ' + rounds + ' 轮');
  return 0;
}

function cmdReviewCheck(spec, argv) {
  const dir = flag(argv, '--dir');
  if (!dir) { console.log('前提层失败：缺 --dir <目录>'); return 2; }
  const sp = path.join(dir, 'longform-review.json');
  let st;
  try { st = JSON.parse(fs.readFileSync(sp, 'utf8')); }
  catch (e) { console.log('前提层失败：读不到或解析不了 ' + sp); return 2; }
  const fails = [];
  for (let r = 1; r <= st.rounds; r++) {
    const files = spec.review.files.map((f) => f.replace('{n}', String(r)));
    const texts = {};
    for (const f of files) {
      const t = readIf(path.join(dir, f));
      if (t == null) { fails.push(`第 ${r} 轮缺 ${f}`); continue; }
      texts[f] = t;
      if (countUnits(t) < spec.review.min_chars) fails.push(`第 ${r} 轮 ${f} 不足 ${spec.review.min_chars} 单位`);
    }
    const critique = texts[`11-批判-r${r}.md`];
    const fixes = texts[`15-修订说明-r${r}.md`];
    if (critique && fixes) {
      const issues = [...critique.matchAll(/- \[P(\d+)\]/g)].map((m) => m[1]);
      const uniq = [...new Set(issues)];
      if (!uniq.length) fails.push(`第 ${r} 轮批判没有任何 - [P<n>] 问题`);
      for (const id of uniq) if (!new RegExp('\\[P' + id + '\\]').test(fixes)) fails.push(`第 ${r} 轮修订说明未回应 [P${id}]`);
      if (!/(已修|不修|保留)/.test(fixes)) fails.push(`第 ${r} 轮修订说明没有任何处置决定（已修/不修/保留）`);
    }
  }
  const final = readIf(path.join(dir, '90-终稿.md'));
  if (final == null || countUnits(final) < 100) fails.push('缺修订后的 90-终稿.md（或不足 100 单位）');
  console.log('审稿回环机检 · ' + path.basename(st.draft || '') + ' · ' + st.rounds + ' 轮');
  if (!fails.length) { console.log('通过：每轮批判/审稿/审计/修订说明齐，问题编号全部有回应，终稿存在'); return 0; }
  console.log(`未通过（${fails.length} 项）：`);
  for (const f of fails) console.log('  [FAIL] ' + f);
  return 1;
}

function writeRole(dir, name, text) { fs.writeFileSync(path.join(dir, name), text, 'utf8'); }
function pad(s, n) { let out = s; while (countUnits(out) < n) out += '\n' + s; return out; }
function fillRoles(spec, dir, genre, opt = {}) {
  for (const r of requiredRoles(spec, genre)) {
    if (opt.skip && opt.skip.includes(r.id)) continue;
    let body = pad('内容 ' + r.id + ' 证据与说明', Math.max(r.min_chars + 80, 600));
    if (r.id === 'T10') body = '图1 来源 DOI 10.1/x dpi 600\n图2 来源 实测 dpi 300\n' + body;
    if (r.id === 'T11') body = 'P1. 封面\nP2. 问题\nP3. 方法\nP4. 结果\nP5. 讨论\nP6. 结论\nP7. 附录\nP8. 致谢\n总时长 15 分钟\n' + body;
    writeRole(dir, r.file, body);
  }
  writeRole(dir, spec.checks.topic_file, '候选1 读者 新意 可行性 证据 风险 评分\n候选2 读者 新意 可行性 证据 风险 评分\n候选3 读者 新意 可行性 证据 风险 评分\n选题：候选1\n');
}
function acadFinal(cites = 12) {
  return ['# 题目', '## 摘要', '摘要正文', '## 关键词', '关键词', '## 引言', '引言', '## 方法', '方法', '## 结果', '结果', '## 讨论', '讨论', '## 参考文献', Array.from({ length: cites }, (_, i) => `[${i + 1}] Ref ${i}`).join(' '), '利益冲突：无', '数据可用性：可请求', '正文补充内容说明 '.repeat(450)].join('\n');
}
function run(spec, argv) {
  const [cmd] = argv;
  if (cmd === '--plan') return cmdPlan(spec, argv);
  if (cmd === '--state') return cmdState(spec, argv);
  if (cmd === '--check') return cmdCheck(spec, argv);
  if (cmd === '--review') return cmdReviewPlan(spec, argv);
  if (cmd === '--review-check') return cmdReviewCheck(spec, argv);
  return 2;
}
function cmdSelftest() {
  const spec = readSpec();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'longform-'));
  let pass = 0, total = 0;
  const ck = (name, cond, why) => { total++; if (cond === true) { pass++; console.log('PASS  ' + name); } else console.log('FAIL  ' + name + '  ' + (why || '')); };

  const d1 = path.join(base, 'p1');
  ck('plan 建任务包与状态', run(spec, ['--plan', '--genre', 'academic', '--topic', '测试题', '--out', d1]) === 0 && fs.existsSync(path.join(d1, 'longform-state.json')));
  ck('状态含 11 角色', Object.keys(JSON.parse(fs.readFileSync(path.join(d1, 'longform-state.json'), 'utf8')).roles).length === 11);
  ck('跳阶段必须被拒', run(spec, ['--state', '--dir', d1, '--set', 'phase=5']) === 1);
  ck('角色无文件标 done 必须被拒', run(spec, ['--state', '--dir', d1, '--set', 'role=T1=done']) === 1);
  writeRole(d1, '01-文献.md', pad('[1] A 2024. DOI 10.1/x', 400));
  ck('角色达成后可标 done', run(spec, ['--state', '--dir', d1, '--set', 'role=T1=done']) === 0);
  ck('交付物不全必须失败', run(spec, ['--check', '--dir', d1]) === 1);

  const d2 = path.join(base, 'p2');
  run(spec, ['--plan', '--genre', 'academic', '--topic', '完整稿', '--out', d2]);
  fillRoles(spec, d2, 'academic');
  writeRole(d2, '90-终稿.md', acadFinal(12));
  ck('完整学术稿通过', run(spec, ['--check', '--dir', d2]) === 0);

  const d3 = path.join(base, 'p3');
  run(spec, ['--plan', '--genre', 'academic', '--topic', '缺引用', '--out', d3]);
  fillRoles(spec, d3, 'academic');
  writeRole(d3, '90-终稿.md', acadFinal(0));
  ck('学术稿缺引用必须失败', run(spec, ['--check', '--dir', d3]) === 1);

  const d4 = path.join(base, 'p4');
  run(spec, ['--plan', '--genre', 'wechat', '--topic', '公众号', '--out', d4]);
  fillRoles(spec, d4, 'wechat');
  writeRole(d4, '90-终稿.md', '正文内容补充说明 '.repeat(400));
  ck('公众号无引用可通过', run(spec, ['--check', '--dir', d4]) === 0);

  const d5 = path.join(base, 'p5');
  run(spec, ['--plan', '--genre', 'wechat', '--topic', 'AI 味', '--out', d5]);
  fillRoles(spec, d5, 'wechat');
  writeRole(d5, '90-终稿.md', '综上所述，值得注意的是，在当今，随着社会的不断发展，' + '正文内容补充说明 '.repeat(250));
  ck('AI 痕迹超阈值必须失败', run(spec, ['--check', '--dir', d5]) === 1);

  const d6 = path.join(base, 'p6');
  run(spec, ['--plan', '--genre', 'book-review', '--topic', '短书评', '--out', d6]);
  fillRoles(spec, d6, 'book-review');
  writeRole(d6, '90-终稿.md', '太短');
  ck('字数不足必须失败', run(spec, ['--check', '--dir', d6]) === 1);

  const d7 = path.join(base, 'p7');
  run(spec, ['--plan', '--genre', 'report', '--topic', '缺配图', '--out', d7]);
  fillRoles(spec, d7, 'report');
  writeRole(d7, '15-配图.md', pad('没有图规格的说明文字', 200));
  writeRole(d7, '90-终稿.md', '背景 问题 分析 建议 摘要 方法 发现 建议'.repeat(300));
  ck('配图规格缺失必须失败', run(spec, ['--check', '--dir', d7]) === 1);

  const r1 = path.join(base, 'r1');
  const draft = path.join(base, 'draft.md');
  writeRole(base, 'draft.md', '稿件正文 '.repeat(200));
  ck('review 建审稿任务', run(spec, ['--review', '--draft', draft, '--out', r1, '--rounds', '2']) === 0 && fs.existsSync(path.join(r1, 'longform-review.json')));
  ck('review 缺轮次文件必须失败', run(spec, ['--review-check', '--dir', r1]) === 1);
  for (let r = 1; r <= 2; r++) {
    writeRole(r1, `11-批判-r${r}.md`, pad('- [P1] 问题一\n- [P2] 问题二', 260));
    writeRole(r1, `14-审稿-r${r}.md`, pad('审稿意见', 260));
    writeRole(r1, `12-审计-r${r}.md`, pad('审计结果', 260));
    writeRole(r1, `15-修订说明-r${r}.md`, pad('[P1] 已修\n[P2] 不修，理由', 260));
  }
  writeRole(r1, '90-终稿.md', pad('修订后的终稿', 200));
  ck('review 完整回环通过', run(spec, ['--review-check', '--dir', r1]) === 0);
  fs.writeFileSync(path.join(r1, '15-修订说明-r1.md'), pad('[P1] 已修', 260));
  ck('review 未回应问题必须失败', run(spec, ['--review-check', '--dir', r1]) === 1);

  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\nlongform 自检：${pass}/${total} 通过`);
  return pass === total ? 0 : 1;
}

function main(argv) {
  const cmd = argv[0];
  try {
    if (!cmd || argv.includes('--help')) {
      console.log('用法：--plan --genre <文类> --topic "<题目>" --out <目录> | --state --dir <目录> [--set phase=<id>|role=<T#>=done|pending] | --check --dir <目录> | --review --draft <稿.md> --out <目录> [--rounds N] | --review-check --dir <目录> | --selftest');
      return cmd ? 0 : 2;
    }
    if (cmd === '--selftest') return cmdSelftest();
    const spec = readSpec();
    return run(spec, argv);
  } catch (e) {
    console.log('前提层失败：' + e.message);
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { cmdPlan, cmdState, cmdCheck, cmdReviewPlan, cmdReviewCheck, cmdSelftest, countUnits, requiredRoles };
