#!/usr/bin/env node
/**
 * sync-skill-table —— 把「真源 agent_facing 命令总表」同步进对话侧技能文档。
 *
 * 由来（2026-10-17 实盘）：对话侧 `plugin/skill/SKILL.md` 曾落后根文档 **17 个命令**
 * （`talk`/`reviewers` 等新能力对"从对话进"的用户等于不存在）。根因是**同一份清单手写两遍**。
 * 规矩：**凡两处都要写同一份清单，就必须有一处是生成的**。
 *
 * 用法：
 *   node bin/sync-skill-table.cjs            # 刷新（幂等：已最新则不改动）
 *   node bin/sync-skill-table.cjs --check    # 只核对：不同步则退 1（可接进 CI/发布前自检）
 *   node bin/sync-skill-table.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TARGET = path.join(ROOT, 'plugin', 'skill', 'SKILL.md');
const START = '<!-- AUTO:agent-facing:start';
const END = '<!-- AUTO:agent-facing:end -->';
const SCRIPT_REL = 'bin/sync-skill-table.cjs';

function read(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }

function oneLiner(rootDoc, cmd) {
  for (const line of rootDoc.split('\n')) {
    if (line.indexOf('studio.cjs ' + cmd) >= 0) {
      const m = /::\s*(.+)$/.exec(line);
      if (m) return m[1].trim();
      return line.trim().slice(0, 110);
    }
  }
  return '（根文档未写一行说明 —— 请补根文档）';
}

/** 生成总表区块（纯函数：给定真源命令列表 + 根文档 ⇒ 字符串，可夹具） */
function buildBlock(need, rootDoc) {
  const L = [START + ' 本段由 `' + SCRIPT_REL + '` 生成；不要手改（改了会被跨面文档锁抓） -->', '',
    '## 真源 agent_facing 命令总表（' + need.length + ' 个 · 自动同步自 references/pipeline.json）', '',
    '> 根 `SKILL.md` 写每条的用法（命令侧权威）；本表保证**对话侧文档不漏任何一个命令** —— 插件自检的跨面文档锁核的就是这一份。', ''];
  for (const c of need) L.push('- `' + c + '`：' + oneLiner(rootDoc, c));
  L.push('', END, '');
  return L.join('\n');
}

function sync(opt) {
  const o = opt || {};
  const target = o.target || TARGET;          // 夹具可传临时文件 ⇒ 自检不依赖仓库当前文档状态
  const studio = require(path.join(ROOT, 'bin', 'studio.cjs'));
  const pj = studio.readPipeline();                       // ★ 真源只许 studio 读（single-source 反控会抓直读）
  const need = pj.agent_facing || [];
  if (!Array.isArray(need) || need.length < 20) throw new Error('真源 agent_facing 条数异常（' + need.length + '）⇒ 前提不成立，不许当通过');
  const rootDoc = read(path.join(ROOT, 'SKILL.md'));
  const block = buildBlock(need, rootDoc);
  const cur = read(target);
  const re = new RegExp(START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?');
  const next = re.test(cur) ? cur.replace(re, () => block) : (cur.replace(/\s*$/, '') + '\n' + block);
  const changed = next !== cur;
  if (o.check) return { ok: !changed, changed, commands: need.length };
  if (changed && !o.check) fs.writeFileSync(target, next, 'utf8');
  return { ok: true, changed, commands: need.length };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };

  ck('buildBlock：命令行数必须等于真源条数（不许漏项/多项）', () => {
    const need = ['route', 'draft', 'talk'];
    const b = buildBlock(need, 'node bin/studio.cjs talk budget :: 讲授预算');
    const n = (b.match(/^- `/gm) || []).length;
    if (n !== need.length) return '条目数 ' + n + ' ≠ ' + need.length;
    const talkLine = b.split('\n').find((l) => l.indexOf('- `talk`：') === 0) || '';
    if (talkLine.indexOf('讲授预算') < 0) return 'talk 那行未取到根文档说明：' + talkLine;
    const routeLine = b.split('\n').find((l) => l.indexOf('- `route`：') === 0) || '';
    if (routeLine.indexOf('根文档未写一行说明') < 0) return 'route 不在假文档里，那行应显式点出缺说明：' + routeLine;
    return true;
  });

  ck('buildBlock：根文档未写说明时必须显式点出来（不许静默留空）', () => {
    const b = buildBlock(['ghost'], '（根文档里没有这条）');
    return /根文档未写一行说明/.test(b) ? true : '未点出缺失说明';
  });

  ck('幂等：同一输入生成两次必须逐字节相同（此前用 re.sub 的替换串吃过反斜杠转义的坑）', () => {
    const need = ['route', 'draft'];
    const doc = 'node bin/studio.cjs route :: 路由\nnode bin/studio.cjs draft :: 任务书';
    return buildBlock(need, doc) === buildBlock(need, doc) ? true : '两次生成不一致';
  });

  ck('工具本地闭环：对临时文档 ① 陈旧时必须刷新 ② 刷新后 check 必须一致 ③ 再刷新必须幂等', () => {
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sst-'));
    const tmp = path.join(dir, 'SKILL.md');
    fs.writeFileSync(tmp, '# 临时技能文档\n\n（故意没有总表）\n', 'utf8');
    const r1 = sync({ target: tmp });
    if (!r1.changed) return '陈旧文档未被刷新';
    const r2 = sync({ target: tmp, check: true });
    if (!r2.ok) return '刷新后 check 仍报不同步';
    const before = fs.readFileSync(tmp, 'utf8');
    const r3 = sync({ target: tmp });
    if (r3.changed) return '第二次刷新竟有改动（不幂等）';
    if (fs.readFileSync(tmp, 'utf8') !== before) return '第二次刷新内容变了';
    const n = (before.match(/^- `/gm) || []).length;
    if (n < 20) return '临时文档里的条目数异常：' + n;
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  });

  ck('★必失败面：真源条数异常（读不到/被清空）必须抛错，不许静默生成空表', () => {
    /* 用一个空的 agent_facing 模拟：直接验 buildBlock 只负责渲染，前置门在 sync 里 —— 这里断言门确实存在 */
    const src = read(__filename);
    if (src.indexOf("agent_facing 条数异常") < 0) return '没有条数前置门';
    return /length < 20/.test(src) ? true : '前置门阈值写法变了（复核）';
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nsync-skill-table 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  try {
    const r = sync({ check: argv.includes('--check') });
    if (argv.includes('--check')) {
      if (!r.ok) { console.error('不同步：对话侧技能文档 != 真源（' + r.commands + ' 个命令）⇒ 跑 node ' + SCRIPT_REL); return 1; }
      console.log('同步：对话侧技能文档与真源一致（' + r.commands + ' 个命令）');
      return 0;
    }
    console.log(r.changed ? ('已刷新命令总表（' + r.commands + ' 个命令）') : ('已是最新（' + r.commands + ' 个命令，无改动）'));
    return 0;
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 2;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { sync, buildBlock, oneLiner, selftest, TARGET, START, END };
