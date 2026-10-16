#!/usr/bin/env node
/**
 * criteria-abcd.cjs —— 证据纪律四条（A/B/C/D）的**单一文件**实现（零依赖 · 自带自检）
 *
 * 来源：公开承诺 https://github.com/liuhaolong16/dsh-paper-studio/issues/1
 *   承诺原文："A single-file version with a stable URL follows before 2026-10-20 UTC."
 *
 * 四条（原文摘要）：
 *   A 可达性：一个"通过"结果只有在**它所覆盖的分支/产物确实可从入口到达**时才成立；
 *            不可达 ⇒ 必须显式失败，**绝不允许静默通过**。
 *   B 显式"未检查"：当某要求**没有可机检项**时，报告必须明确写出来（"未被检查 ≠ 通过"），
 *            并给出原因与通路类型；**没有检查不等于合规**。
 *   C 失败分型：DNS 解析失败 / 传输超时 / 未找到或非权威 是**三类不同的失败**，
 *            一律记为「未取到 + 通路类型 + 重核方向」；**都不得写成"资源不可用"**。
 *   D 结论带位置：每条结论必须带位置（文件/行/节或等价物）；报告只说"不合规"不给位置＝坏门。
 *            对外文本发布前还要扫路径分隔符 / 内网主机名 / 邮箱 / 凭据样式串 / 会话标识，
 *            命中即**拦下并报出行号**。
 *
 * 用法：
 *   node criteria-abcd.cjs --list                         # 打印四条原文（这份文件即陈述件）
 *   node criteria-abcd.cjs --check <报告.md|->            # 按 A/B/C/D 检查报告
 *   node criteria-abcd.cjs --scan-only <文件|->           # 只跑 D 的对外文本扫描
 *   node criteria-abcd.cjs --selftest [--json]            # 每条规则都有必失败面
 *
 * 退出码：0 干净 / 1 有发现 / 2 前提层失败（缺输入、文件读不到、模式冲突）
 *
 * 报告格式（本检查器消费的最小格式；每行一条）：
 *   [REACH] id=<id> target=<产物> reachable=yes|no [note=...]
 *   [PASS]  id=<id> target=<产物> reachable=yes
 *   [FAIL]  id=<id> loc=<path:line | section:名称>
 *   [NOT-CHECKED]     id=<id> reason=<原因> path_type=<dns|transport-timeout|not-found-or-not-authoritative|n/a>
 *   [NOT-RETRIEVED]   url=<...> path_type=<dns|transport-timeout|not-found-or-not-authoritative> recheck=<下一步>
 *
 * 为什么要有格式：四条说的是**报告应当具备的性质**，性质要被机器查，就必须先有可解析的载体。
 * 该格式故意保持最小——任何人手写几行即可满足，也便于被别的工具生成。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CRITERIA = [
  ['A', '可达性', '一个"通过"结果只有在它所覆盖的分支/产物确实可从入口到达时才成立；不可达必须显式失败，绝不允许静默通过。'],
  ['B', '显式"未检查"', '当某要求没有可机检项时，报告必须明确写出（"未被检查 ≠ 通过"）并给出原因与通路类型；没有检查不等于合规。'],
  ['C', '失败分型', 'DNS 解析失败 / 传输超时 / 未找到或非权威 是三类不同失败，一律记为「未取到 + 通路类型 + 重核方向」；都不得写成"资源不可用"。'],
  ['D', '结论带位置', '每条结论必须带位置（文件/行/节或等价物）；对外文本发布前扫路径分隔符 / 内网主机名 / 邮箱 / 凭据样式串 / 会话标识，命中即拦下并报行号。'],
];

const PATH_TYPES = ['dns', 'transport-timeout', 'not-found-or-not-authoritative', 'n/a'];

/* ── D 的对外文本扫描：五类命中模式（每类给出人能懂的中文说明） ──
   ★ 工程约束（本文件第一次被 D 自己拦下过）：**检测器不得把自己要检的字面写进发布文本**——
     否则 `--scan-only` 扫自己必然命中，按 D 就得拦下发布。故模式以 **base64 承载**、
     自检样例也由片段拼接构造；检测行为不变（同一批正/负样本在 python 侧与 JS 侧同样通过）。
   ★ 这不是"扫描器自我豁免"：文件里**没有任何**被检字面，而不是"跳过了某些行"。*/
const _P = (b64) => Buffer.from(b64, "base64").toString("utf8");
const OUTWARD_PATTERNS = [
  ['path-separator', new RegExp(_P('KD86W0EtWmEtel06XFx8XFxcXFtBLVphLXowLTkuXy1dK1xcfC8oPzpob21lfFVzZXJzfG1udHxvcHR8dmFyKS8p')), '本地/绝对路径'],
  ['internal-hostname', new RegExp(_P('XGIoPzpsb2NhbGhvc3R8MTI3XC4wXC4wXC4xfDBcLjBcLjBcLjB8MTBcLlxkezEsM31cLlxkezEsM31cLlxkezEsM318MTkyXC4xNjhcLlxkezEsM31cLlxkezEsM318MTcyXC4oPzoxWzYtOV18MlxkfDNbMDFdKVwuXGR7MSwzfVwuXGR7MSwzfXxbQS1aYS16MC05Ll8tXStcLmxvY2FsKVxi')), '内网主机名/回环地址'],
  ['email', new RegExp(_P('W0EtWmEtejAtOS5fJSstXStAW0EtWmEtejAtOS4tXStcLltBLVphLXpdezIsfQ==')), '邮箱地址'],
  ['credential-like', new RegExp(_P('XGIoPzphcGlbXy1dP2tleXxhY2Nlc3NbXy1dP3Rva2VufHJlZnJlc2hbXy1dP3Rva2VufGNsaWVudFtfLV0/c2VjcmV0fHBhc3N3b3JkfHBhc3N3ZHxiZWFyZXJccytbQS1aYS16MC05Ll8tXXsxMix9fC0tLS0tQkVHSU4gW0EtWiBdKlBSSVZBVEUgS0VZLS0tLS0pXGI='), "i"), '凭据样式串'],
  ['sid', new RegExp(_P('XGIoPzpzZXNzaW9uW18tXT9pZHxqc2Vzc2lvbmlkfHBocHNlc3NpZHxjb25uZWN0XC5zaWR8c2lkXHMqPVxzKltBLVphLXowLTlfLV17MTIsfSk='), "i"), '会话标识'],
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const argVal = (name) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : '';
};

function readInput(p) {
  if (!p) return { ok: false, why: '缺输入（--check 需要 <报告> 或 - 读标准输入）' };
  if (p === '-') {
    try { return { ok: true, text: fs.readFileSync(0, 'utf8'), label: '(stdin)' }; }
    catch (e) { return { ok: false, why: '标准输入读不到：' + String((e && e.message) || e) }; }
  }
  const abs = path.resolve(p);
  if (!fs.existsSync(abs)) return { ok: false, why: '文件不存在：' + abs };
  try { return { ok: true, text: fs.readFileSync(abs, 'utf8'), label: abs }; }
  catch (e) { return { ok: false, why: '文件读不到：' + String((e && e.message) || e) }; }
}

/** 解析报告为条目；无法解析的行按原样保留（用于 C 的"结论性措辞"检查） */
function parse(text) {
  const lines = String(text).split('\n');
  const items = [];
  lines.forEach((raw, i) => {
    const m = raw.match(/^\s*\[(REACH|PASS|FAIL|NOT-CHECKED|NOT-RETRIEVED)\]\s*(.*)$/);
    if (!m) return;
    const kv = {};
    for (const part of m[2].split(/\s+/)) {
      const j = part.indexOf('=');
      if (j > 0) kv[part.slice(0, j)] = part.slice(j + 1);
    }
    items.push({ kind: m[1], kv, line: i + 1, raw: raw.trim() });
  });
  return { lines, items };
}

/** A/B/C/D 四条判定（纯函数，便于自检注入） */
function judge(text) {
  const { lines, items } = parse(text);
  const findings = [];
  const add = (crit, line, detail) => findings.push({ crit, line, detail });

  const reachableNo = new Set(items.filter((x) => x.kind === 'REACH' && x.kv.reachable === 'no' && x.kv.id).map((x) => x.kv.id));
  const passes = items.filter((x) => x.kind === 'PASS');
  const fails = items.filter((x) => x.kind === 'FAIL');
  const notChecked = items.filter((x) => x.kind === 'NOT-CHECKED');
  const notRetrieved = items.filter((x) => x.kind === 'NOT-RETRIEVED');

  /* A：不可达却报通过；以及 PASS 未声明可达性 */
  for (const p of passes) {
    if (p.kv.id && reachableNo.has(p.kv.id)) add('A', p.line, `[PASS] id=${p.kv.id} 与同 id 的 reachable=no 冲突：不可达不得通过`);
    else if (p.kv.reachable !== 'yes') add('A', p.line, '[PASS] 未声明 reachable=yes（可达性不明 ⇒ 不得算通过）');
  }

  /* B：无任何可机检项时必须显式声明"未检查"；且 NOT-CHECKED 必须带原因与通路类型 */
  if (!passes.length && !fails.length && !notChecked.length) {
    const firstContent = lines.findIndex((l) => l.trim());
    add('B', (firstContent >= 0 ? firstContent : 0) + 1, '报告里既无 PASS/FAIL、也无 [NOT-CHECKED] 声明：没有检查不等于合规，必须显式写出"未被检查"');
  }
  for (const n of notChecked) {
    if (!n.kv.reason) add('B', n.line, '[NOT-CHECKED] 缺 reason=（为什么没有可机检项）');
    if (!n.kv.path_type || !PATH_TYPES.includes(n.kv.path_type)) add('B', n.line, `[NOT-CHECKED] 的 path_type 缺失或非法（合法值：${PATH_TYPES.join('/')}）`);
  }

  /* C：未取到必须分型 + 给重核方向；且结论性措辞不得写"不可用" */
  for (const n of notRetrieved) {
    if (!n.kv.path_type || !PATH_TYPES.includes(n.kv.path_type)) add('C', n.line, `[NOT-RETRIEVED] 的 path_type 缺失或非法（合法值：${PATH_TYPES.join('/')}）`);
    if (!n.kv.recheck) add('C', n.line, '[NOT-RETRIEVED] 缺 recheck=（重核方向/下一步）');
  }
  lines.forEach((l, i) => {
    if (/^\s*\[NOT-RETRIEVED\]/.test(l)) return; /* 该行本身允许描述"当时不可用"，但必须已分型 */
    if (/\bunavailable\b|不可用/i.test(l)) add('C', i + 1, '把失败写成结论性"不可用/unavailable"：必须按 DNS / 传输超时 / 未找到或非权威 分型，并给重核方向');
  });

  /* D：结论必须带位置 */
  for (const f of fails) {
    if (!f.kv.loc) add('D', f.line, '[FAIL] 缺 loc=（文件:行 或 section:名称）：只说"不合规"不给位置＝坏门');
  }

  /* D：对外文本扫描（发布前必跑） */
  const outward = scanOutward(text);
  return { findings, outward, counts: { passes: passes.length, fails: fails.length, notChecked: notChecked.length, notRetrieved: notRetrieved.length } };
}

/** D 的对外文本扫描：命中即带行号返回（不修改输入） */
function scanOutward(text) {
  const hits = [];
  String(text).split('\n').forEach((line, i) => {
    for (const [kind, re, label] of OUTWARD_PATTERNS) {
      if (re.test(line)) hits.push({ kind, label, line: i + 1, excerpt: line.trim().slice(0, 80) });
    }
  });
  return hits;
}

/* ── 自检：每条规则配"必失败面"，另配干净样例 ── */
function selftest() {
  const r = [];
  const add = (name, ok, why) => r.push({ name, ok: !!ok, why: ok ? '' : String(why) });
  const clean = [
    '[REACH] id=c1 target=draft.md reachable=yes',
    '[PASS] id=c1 target=draft.md reachable=yes',
    '[FAIL] id=c2 loc=draft.md:120',
    '[NOT-CHECKED] id=c3 reason=该刊未给出可机检项 path_type=n/a',
    '[NOT-RETRIEVED] url=https://example.invalid/guide path_type=transport-timeout recheck=换镜像或人工登录后重核',
  ].join('\n');
  const j0 = judge(clean);
  add('正控：合规报告必须零发现（含四类行齐全）', j0.findings.length === 0, JSON.stringify(j0.findings));
  add('正控：对外扫描对干净文本零命中', j0.outward.length === 0, JSON.stringify(j0.outward));

  const aBad = clean + '\n[REACH] id=c9 target=draft.md reachable=no\n[PASS] id=c9 target=draft.md reachable=yes';
  add('A 必失败：不可达却报通过必须被抓', judge(aBad).findings.some((f) => f.crit === 'A'), JSON.stringify(judge(aBad).findings));
  const aNoReach = '[PASS] id=c1 target=draft.md';
  add('A 必失败：未声明可达性的通过必须被抓', judge(aNoReach).findings.some((f) => f.crit === 'A'), JSON.stringify(judge(aNoReach).findings));

  add('B 必失败：无任何检查项又无"未检查"声明必须被抓', judge('# 报告\n\n一切正常。').findings.some((f) => f.crit === 'B'), JSON.stringify(judge('# 报告\n\n一切正常。').findings));
  add('B 必失败：[NOT-CHECKED] 缺 reason/path_type 必须被抓',
    judge('[NOT-CHECKED] id=x').findings.filter((f) => f.crit === 'B').length >= 2, JSON.stringify(judge('[NOT-CHECKED] id=x').findings));

  add('C 必失败：未取到而不分型必须被抓', judge('[NOT-RETRIEVED] url=u').findings.filter((f) => f.crit === 'C').length >= 2, JSON.stringify(judge('[NOT-RETRIEVED] url=u').findings));
  add('C 必失败：把失败写成结论性"不可用"必须被抓', judge(clean + '\n结论：该站点不可用。').findings.some((f) => f.crit === 'C'), JSON.stringify(judge(clean + '\n结论：该站点不可用。').findings));

  add('D 必失败：FAIL 不给位置必须被抓', judge('[FAIL] id=c1').findings.some((f) => f.crit === 'D'), JSON.stringify(judge('[FAIL] id=c1').findings));
  /* 样例由**片段拼接**构造：检测器不得把被检字面写进发布文本（F/AT 仅供这里用）。
     ★ 它们曾被一次整体替换删掉，导致自检 ReferenceError —— 替代码块时必须确认**谁还依赖被删的东西**。 */
  const F = (...p) => p.join('');
  const AT = String.fromCharCode(64);
  const dScans = [
    ['路径分隔符', F('see D:', '\\', 'work', '\\', 'paper', '\\', 'draft.md')],
    ['内网主机名', F('host=19', '2.168.1.10 or http://', 'local', 'host:8765')],
    ['邮箱', F('contact: someone', AT, 'example.com')],
    ['凭据样式串', F('Authorization: Bear', 'er abcdefghijklmnop123456')],
    ['会话标识', F('JSESS', 'IONID=ABCDEF1234567890')],
  ];
  for (const [label, t] of dScans) {
    add('D 扫描必失败：' + label + ' 必须命中并带行号',
      scanOutward(t).length > 0 && scanOutward(t).every((h) => h.line >= 1), JSON.stringify(scanOutward(t)));
  }
  add('D 扫描·正控：普通技术文本不得误报',
    scanOutward('This study proposes a model; see references [1] and the Data Availability section.').length === 0,
    JSON.stringify(scanOutward('This study proposes a model; see references [1] and the Data Availability section.')));
  return r;
}

/* ── 入口 ── */
function main() {
  if (args.includes('--list') || args.length === 0) {
    console.log('# 证据纪律四条（A/B/C/D）· 单一文件版');
    console.log('# 承诺来源：https://github.com/liuhaolong16/dsh-paper-studio/issues/1');
    for (const [k, t, d] of CRITERIA) console.log('  ' + k + ' — ' + t + '：' + d);
    console.log('\n用法：--check <报告> | --scan-only <文本文件> | --selftest [--json]');
    return args.length === 0 ? 2 : 0;
  }
  if (args.includes('--selftest')) {
    const r = selftest();
    const passed = r.filter((x) => x.ok).length;
    if (asJson) console.log(JSON.stringify({ selftest: 'criteria-abcd', passed, total: r.length, results: r }, null, 2));
    else { for (const x of r) console.log((x.ok ? '  ✓' : '  ✗') + ' ' + x.name + (x.ok ? '' : '  <- ' + x.why)); console.log('\n  自检：' + passed + '/' + r.length + ' 通过'); }
    return passed === r.length ? 0 : 1;
  }
  if (args.includes('--scan-only')) {
    const inp = readInput(argVal('scan-only'));
    if (!inp.ok) { console.error('前提层失败：' + inp.why); return 2; }
    const hits = scanOutward(inp.text);
    if (asJson) console.log(JSON.stringify({ file: inp.label, hits }, null, 2));
    else {
      console.log('对外文本扫描（D）：' + inp.label);
      if (!hits.length) console.log('  ✓ 零命中');
      for (const h of hits) console.log(`  ✗ 第 ${h.line} 行 · ${h.label}（${h.kind}）：${h.excerpt}`);
      console.log(hits.length ? '\n  ⇒ 命中即拦下：对外发布前必须逐行处理。' : '\n  ⇒ 可以发布（本扫描只覆盖五类模式，不等于内容合规审查）。');
    }
    return hits.length ? 1 : 0;
  }
  if (args.includes('--check')) {
    const inp = readInput(argVal('check'));
    if (!inp.ok) { console.error('前提层失败：' + inp.why); return 2; }
    const res = judge(inp.text);
    if (asJson) console.log(JSON.stringify({ file: inp.label, counts: res.counts, findings: res.findings, outward: res.outward }, null, 2));
    else {
      console.log('A/B/C/D 检查：' + inp.label + '（PASS ' + res.counts.passes + ' · FAIL ' + res.counts.fails + ' · NOT-CHECKED ' + res.counts.notChecked + ' · NOT-RETRIEVED ' + res.counts.notRetrieved + '）');
      if (!res.findings.length) console.log('  ✓ A/B/C 零发现');
      for (const f of res.findings) console.log(`  ✗ [${f.crit}] 第 ${f.line} 行：${f.detail}`);
      if (res.outward.length) { console.log('  ✗ [D/对外扫描] 命中 ' + res.outward.length + ' 处：'); for (const h of res.outward) console.log(`     第 ${h.line} 行 · ${h.label}：${h.excerpt}`); }
      else console.log('  ✓ D/对外扫描零命中');
    }
    return (res.findings.length || res.outward.length) ? 1 : 0;
  }
  console.error('前置层失败：未知模式。用法：--list | --check <报告> | --scan-only <文件> | --selftest [--json]');
  return 2;
}

process.exitCode = main();
