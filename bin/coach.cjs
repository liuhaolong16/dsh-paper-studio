#!/usr/bin/env node
/**
 * coach — 开工教练：教训按「强制级别 + 用过次数」注入（V3 · 补齐最后一项 P2）
 *
 * 机制吸收自 Gitee `dsh-sci-fault-diag-paper` 的教训库（62 条 + 分级 + **按触发次数排序** + 开工 `lessons_brief` 自动注入）。
 * 我方不另造教训（**已有 13 条真教训**，真源 `references/lessons-from-first-draft.md`，经 `studio.readLessons()` 读取），
 * 只做三件它没有的事：
 *   ① **强制级别**：从 `checkable` **推导** —— 写明「已挂门」的属 **enforced**（机器会拦），其余属 **advisory**（只靠自觉）；
 *   ② **用过次数**：本地账本 `<root>/.paper-studio/lessons-usage.json` 记 count / last_used（`use <id>` 递增）；
 *   ③ **开工注入**：`brief` 按「用过次数降序，同级 enforced 优先」给 top-N，一行一条（**精简**：只给做法，不抄全文）。
 *
 * 用法：
 *   node bin/coach.cjs brief [--n 5] [--root <dir>]
 *   node bin/coach.cjs use   <id> [--root <dir>]
 *   node bin/coach.cjs list  [--root <dir>]
 *   node bin/coach.cjs stats
 *   node bin/coach.cjs --selftest
 * 退出码：0 成功 · 1 拒收（未知 id） · 2 前提层失败
 * ★ require 本文件必须安静（受 check-claims.cjs 的「模块可引用性」探针强制）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

/** 复用 studio 的真源读取（**不重复解析教训文件**）。 */
function loadLessons() {
  // eslint-disable-next-line global-require
  const studio = require('./studio.cjs');
  const L = studio.readLessons();
  const arr = Array.isArray(L) ? L : (L.lessons || []);
  if (!arr.length) throw new Error('前提层失败：真源里没有教训（lessons-from-first-draft.md 为空或读不到）');
  return arr;
}
/** 强制级别：**从 checkable 推导**（写明已挂门＝机器会拦）。 */
function enforcementOf(lesson) {
  const c = String(lesson.checkable || '');
  return /已挂门|gate|门\s*`/.test(c) ? 'enforced' : 'advisory';
}
function ledgerPath(root) { return path.join(root, '.paper-studio', 'lessons-usage.json'); }
function readLedger(root) {
  const f = ledgerPath(root);
  if (!fs.existsSync(f)) return {};
  const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
  const j = JSON.parse(raw);                       // 损坏就抛（不静默当 0）
  return (j && typeof j === 'object') ? j : {};
}
function writeLedger(root, obj) {
  const f = ledgerPath(root);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return f;
}
/** 记一次使用。**未知 id 一律拒收**（不做静默新建，避免账本里长出不存在的教训）。 */
function use(root, id) {
  const lessons = loadLessons();
  const hit = lessons.find((x) => x.id === id);
  if (!hit) throw new Error(`拒收：没有教训 ${id}（现有：${lessons.map((x) => x.id).join('/')}）`);
  const led = readLedger(root);
  const cur = led[id] || { count: 0, last_used: null };
  led[id] = { count: cur.count + 1, last_used: new Date().toISOString() };
  writeLedger(root, led);
  return { id, count: led[id].count, enforcement: enforcementOf(hit) };
}
/** 合并视图：教训 × 强制级别 × 用过次数。 */
function merged(root) {
  const led = readLedger(root);
  return loadLessons().map((x) => ({
    id: x.id, enforcement: enforcementOf(x), count: (led[x.id] && led[x.id].count) || 0,
    last_used: (led[x.id] && led[x.id].last_used) || null,
    practice: String(x.practice || '').trim(), lesson_head: String(x.lesson || '').replace(/\*\*/g, '').slice(0, 60),
  }));
}
/** 排序：**用过次数降序 → enforced 优先 → id**。 */
function rank(rows) {
  return [...rows].sort((a, b) => (b.count - a.count)
    || (a.enforcement === b.enforcement ? 0 : (a.enforcement === 'enforced' ? -1 : 1))
    || a.id.localeCompare(b.id));
}
/** 开工注入块：只给 top-N 的**做法**一行（不抄全文；无使用记录时明说是按强制级别兜底）。 */
function brief(root, n) {
  const top = Number(n || 5);
  const rows = merged(root);
  const ranked = rank(rows).slice(0, top);
  const anyUsed = rows.some((r) => r.count > 0);
  const lines = [`【开工教练】（${anyUsed ? '按用过次数排序' : '**尚无使用记录** ⇒ 按强制级别兜底'} · 共 ${rows.length} 条真教训，取前 ${ranked.length}）`];
  for (const r of ranked) lines.push(`- ${r.id}${r.enforcement === 'enforced' ? '（已挂门）' : '（advisory）'}：${r.practice || r.lesson_head}`);
  const enforced = rows.filter((r) => r.enforcement === 'enforced').length;
  lines.push(`- 【覆盖】${enforced}/${rows.length} 条已挂门（其余靠自觉）—— 机器能拦的只有这些。`);
  return lines.join('\n');
}
function stats(root) {
  const rows = merged(root);
  const by = { enforced: 0, advisory: 0 };
  for (const r of rows) by[r.enforcement]++;
  return { total: rows.length, ...by, used_any: rows.filter((r) => r.count > 0).map((r) => `${r.id}×${r.count}`), note: '**advisory 不等于不重要**，只表示目前没有机检门；把它们变成门才是升级路径。' };
}

function runSelftest() {
  const os = require('os');
  const results = [];
  const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'coach-'));
  const check = (name, fn) => { try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); } };

  check('★ 正控 · 强制级别**从 checkable 推导**（写明已挂门＝enforced）', () => {
    const a = enforcementOf({ checkable: '✅ **已挂门 `worknote-leak`**：…' });
    const b = enforcementOf({ checkable: '需人工检查' });
    return (a === 'enforced' && b === 'advisory') ? true : `${a}/${b}`;
  });
  check('★ 正控 · 真源教训被读到且 id 齐全（复用 studio，不重解析）', () => {
    const L = loadLessons();
    return (L.length >= 12 && L.every((x) => x.id && x.practice)) ? true : `n=${L.length}`;
  });
  check('★★ 正控 · 用过次数：use 递增并在 brief 排序里生效（用过的排前）', () => {
    const r = mk();
    use(r, 'L-13'); use(r, 'L-13'); use(r, 'L-1');
    const rows = merged(r);
    const first = rank(rows)[0];
    return (first.id === 'L-13' && first.count === 2) ? true : JSON.stringify(rows.slice(0, 3));
  });
  check('★ 必失败 · 未知教训 id ⇒ 拒收（不在账本里静默新建）', () => {
    const r = mk(); let e = '';
    try { use(r, 'L-99'); } catch (err) { e = err.message; }
    return (/拒收/.test(e) && Object.keys(readLedger(r)).length === 0) ? true : `${e} / ${JSON.stringify(readLedger(r))}`;
  });
  check('★ 反控 · 无账本 ⇒ 全 0（不假装有使用记录），且 brief 明说"按强制级别兜底"', () => {
    const r = mk();
    const b = brief(r, 5);
    return (merged(r).every((x) => x.count === 0) && /尚无使用记录/.test(b) && /兜底/.test(b)) ? true : b.slice(0, 120);
  });
  check('★ 正控 · brief 只给 top-N 且每条一行「做法」（精简原则）', () => {
    const r = mk();
    const b = brief(r, 3);
    const bullets = b.split('\n').filter((l) => l.startsWith('- '));
    // 3 条教训 + 1 条覆盖说明
    return (bullets.length === 4 && /【覆盖】/.test(b)) ? true : JSON.stringify(bullets);
  });
  check('★ 正控 · stats 给出 enforced/advisory 真实计数（不美化覆盖率）', () => {
    const s = stats(mk());
    return (s.total >= 12 && s.enforced + s.advisory === s.total && /不等于不重要/.test(s.note)) ? true : JSON.stringify(s);
  });
  check('★ 必失败 · 账本 JSON 损坏时抛错，不静默当 0（否则会悄悄丢掉使用记录）', () => {
    const r = mk(); const f = ledgerPath(r);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '{ this is not json', 'utf8');
    let e = '';
    try { readLedger(r); } catch (err) { e = err.message; }
    return /JSON|Unexpected|position/i.test(e) ? true : `未抛错：${e}`;
  });
  check('★ 正控 · 带 BOM 的账本必须能读（Windows 常态）', () => {
    const r = mk(); const f = ledgerPath(r);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '\uFEFF' + JSON.stringify({ 'L-1': { count: 3, last_used: null } }), 'utf8');
    return readLedger(r)['L-1'].count === 3 ? true : JSON.stringify(readLedger(r));
  });

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\ncoach 自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  if (argv.includes('--selftest')) return runSelftest();
  const opt = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
  const cmd = argv.find((a) => !a.startsWith('--') && !['--n', '--root'].includes(a));
  const root = opt('--root') || process.cwd();
  const pos = argv.filter((a) => !a.startsWith('--'));
  try {
    if (cmd === 'brief') { console.log(brief(root, opt('--n'))); return 0; }
    if (cmd === 'use') {
      const r = use(root, pos[1]);
      console.log(`已记：${r.id}（累计 ${r.count} 次 · ${r.enforcement}）`);
      return 0;
    }
    if (cmd === 'list') {
      for (const r of rank(merged(root))) console.log(`  ${r.id}\t${r.enforcement}\t×${r.count}\t${r.practice.slice(0, 70)}`);
      return 0;
    }
    if (cmd === 'stats') { console.log(JSON.stringify(stats(root), null, 2)); return 0; }
    console.error('用法：coach.cjs brief|use <id>|list|stats [--n N] [--root dir]（或 --selftest）'); return 2;
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/^拒收/.test(msg)) { console.error(msg); return 1; }
    console.error('前提层失败：' + msg); return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { loadLessons, enforcementOf, use, merged, rank, brief, stats, readLedger, ledgerPath, main };
