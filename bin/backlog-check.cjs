#!/usr/bin/env node
/**
 * backlog-check.cjs —— 欠账表格式门
 * 用法：node bin/backlog-check.cjs [--file docs/BACKLOG.md] | --selftest
 * 判据：表头固定、每行 5 列、编号唯一、状态在合法集、已关闭必须有证据。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HEADER = '| 编号 | 状态 | 项 | 可失败验收 | 证据 / 来源 |';
const STATUSES = ['待办', '进行中', '等人决策', '未查清', '不做', '已关闭'];

function checkText(text) {
  const fails = [];
  const lines = text.split(/\r?\n/);
  if (!lines.some((l) => l.trim() === HEADER)) fails.push('缺固定表头：' + HEADER);
  const rows = lines.filter((l) => /^\|\s*P-\d+/.test(l));
  if (!rows.length) fails.push('没有任何 P- 编号行');
  const seen = new Set();
  for (const row of rows) {
    const cells = row.split('|').slice(1, -1).map((s) => s.trim());
    if (cells.length !== 5) { fails.push('列数不是 5：' + row.slice(0, 40)); continue; }
    const [id, status, item, accept, evidence] = cells;
    if (seen.has(id)) fails.push('编号重复：' + id);
    seen.add(id);
    if (!STATUSES.includes(status)) fails.push(`${id} 状态非法：${status}`);
    if (status === '已关闭' && !evidence) fails.push(`${id} 已关闭但没有证据`);
    if (!item) fails.push(`${id} 缺项`);
    if (!accept) fails.push(`${id} 缺可失败验收`);
  }
  return fails;
}

function selftest() {
  const base = fs.mkdtempSync(path.join('D:\\DeepSeek\\_tmp', 'backlog-'));
  const good = [
    '# 欠账',
    '',
    '| 编号 | 状态 | 项 | 可失败验收 | 证据 / 来源 |',
    '|---|---|---|---|---|',
    '| P-01 | 已关闭 | A | 跑 X 得 0 | commit 1 |',
    '| P-02 | 待办 | B | 跑 Y 得 1 | 来源 Z |',
    ''
  ].join('\n');
  let pass = 0, total = 0;
  const ck = (name, condRaw) => {
    total++;
    const ok = condRaw === true;
    if (ok) { pass++; console.log('PASS  ' + name); } else console.log('FAIL  ' + name);
  };
  const run = (text) => { const f = path.join(base, 'b.md'); fs.writeFileSync(f, text, 'utf8'); return checkText(fs.readFileSync(f, 'utf8')); };
  ck('合法表通过', run(good).length === 0);
  ck('非法状态必须失败', run(good.replace('待办', '搁置')).length > 0);
  ck('已关闭无证据必须失败', run(good.replace('commit 1', '')).length > 0);
  ck('编号重复必须失败', run(good.replace('P-02', 'P-01')).length > 0);
  ck('缺表头必须失败', run(good.replace('| 编号 | 状态 | 项 | 可失败验收 | 证据 / 来源 |', '')).length > 0);
  ck('缺验收必须失败', run(good.replace('| 跑 Y 得 1 |', '| |')).length > 0);
  fs.rmSync(base, { recursive: true, force: true });
  console.log(`\nbacklog-check 自检：${pass}/${total} 通过`);
  return pass === total ? 0 : 1;
}

function main(argv) {
  if (argv[0] === '--selftest') return selftest();
  const i = argv.indexOf('--file');
  const file = i > -1 ? argv[i + 1] : path.join(__dirname, '..', 'docs', 'BACKLOG.md');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('前提层失败：读不到 ' + file); return 2; }
  const fails = checkText(text);
  console.log('欠账表格式门 · ' + file);
  if (!fails.length) { console.log('通过：表头/列数/编号/状态/关闭证据都合规'); return 0; }
  for (const f of fails) console.log('  [FAIL] ' + f);
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { checkText };
