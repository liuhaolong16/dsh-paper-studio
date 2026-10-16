#!/usr/bin/env node
/**
 * package-audit —— 源文件完整性与兼容度校验（可复跑）
 *
 * 为什么单独一个脚本：这是**发布前/收尾时要能一键复跑**的判据集合，且必须：
 *   · 清单**由声明推导**（读 package.json 的 files 白名单 + 走文件系统），不手写；
 *   · 拿不到外部对照物时记 **SKIP 而不是 pass**（"没检查"≠"合格"）；
 *   · 违禁文件（.npmrc / node_modules / .git / 密钥样式文本）出现在清单里 ⇒ **直接判失败**。
 *
 * 用法：
 *   node bin/package-audit.cjs [--json] [--write-manifest <路径>]
 *   node bin/package-audit.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const EXTERNAL_GATE = process.env.PS_EXTERNAL_GATE || 'D:\\DeepSeek\\research-paper-playbook\\_journal-contract.cjs';
const FORBIDDEN = ['.npmrc', 'node_modules', '.git/', '.env', 'id_rsa', 'keys.json'];
const SECRET_RE = /npm_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 由 package.json 的 files 白名单推导随包清单（不手写）。 */
function deriveManifest(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = pkg.files || [];
  const out = [];
  const walk = (abs, rel) => {
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.join(abs, name), rel ? rel + '/' + name : name);
    } else out.push(rel);
  };
  for (const d of declared) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) { out.push('MISSING:' + d); continue; }
    walk(abs, d);
  }
  return { declared, files: out };
}

function forbiddenHits(files) {
  const hits = [];
  for (const f of files) for (const bad of FORBIDDEN) if (f.split('\\').join('/').includes(bad)) hits.push(f + ' ← 命中违禁项 ' + bad);
  return hits;
}

function secretScan(root, files) {
  const hits = [];
  for (const f of files.slice(0, 500)) {
    const abs = path.join(root, f);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    if (st.size > 2 * 1024 * 1024) continue;
    let txt = '';
    try { txt = fs.readFileSync(abs, 'latin1'); } catch (e) { continue; }
    if (SECRET_RE.test(txt)) hits.push(f + ' ← 疑似密钥样式文本');
  }
  return hits;
}

function cslLock(root) {
  const lockPath = path.join(root, 'references', 'csl-lock.json');
  if (!fs.existsSync(lockPath)) return { ok: false, reason: '缺 references/csl-lock.json', checked: 0, total: 0 };
  const j = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const dir = path.join(root, j.dir || 'assets/csl');
  let checked = 0; const total = Object.keys(j.styles || {}).length; const bad = [];
  for (const [k, v] of Object.entries(j.styles || {})) {
    const f = path.join(dir, v.file);
    if (!fs.existsSync(f)) { bad.push(k + '（缺文件）'); continue; }
    // ★ v3.2.80：与 studio 同口径 —— 行尾归一后再比，避免 Windows/Linux 两判
    const nb = Buffer.from(fs.readFileSync(f).toString('binary').replace(/\r\n/g, '\n'), 'binary');
    const h = crypto.createHash('sha256').update(nb).digest('hex');
    if (h === String(v.sha256).toLowerCase()) checked++; else bad.push(k + '（哈希不符）');
  }
  return { ok: bad.length === 0 && total > 0, checked, total, bad };
}

/** 从真源推导**声明的**外部对照件路径（`__LOCAL__` 未解析时返回空 ⇒ 判 SKIP 而不是假装绑定了身份）。 */
function declaredExternal(root) {
  /* ★ v3.2.84 修正：真源（pipeline.json）**只允许 studio.cjs 读** —— 本工具此前自己 readFileSync，
     被自家 `audit` 的 single-source 审查器抓成"两套真相"（反控夹具直接扫真实仓库，属真违规）。
     现在改为：经 studio 的导出读取真源，并复用它的 resolveGateScript 解析 `__LOCAL__` 本机路径表。
     解析不到（干净安装 / 未配本机路径表）⇒ 返回空 ⇒ gateParity 判 SKIP（不是 PASS）。 */
  try {
    const studio = require(path.join(root, 'bin', 'studio.cjs'));
    const P = studio.readPipeline();
    const g = (P.gates || []).find((x) => x.entry === '_journal-contract.cjs');
    if (!g) return '';
    const r = studio.resolveGateScript(g, P);   // 传**完整** gate（含 rel）——只给 {id,entry} 会丢外部路径
    return (r && r.source === 'external' && r.script) ? r.script : '';
  } catch (e) { return ''; }
}

function gateParity(root, external, expected) {
  /* ★ v3.2.83 **身份绑定**（同伴指出的缺口）：此前只比内容摘要 ⇒ 把同一份内容放到第二个目录再比
     仍然会绿，等于「对象被替换」测不出来。现在要求：对照件必须是**声明的那个文件**（路径身份），
     且在身份成立的前提下再比逐字节摘要 ⇒ 身份 + 内容两层独立。声明缺位时记 SKIP（不是 PASS）。 */
  const builtin = path.join(root, 'gates', '_journal-contract.cjs');
  if (!fs.existsSync(builtin)) return { status: 'FAIL', reason: '内置门缺失' };
  if (!fs.existsSync(external)) return { status: 'SKIP', reason: '外部对照门不存在（换机/别人机器上属正常）' };
  const exp = expected || process.env.PS_EXTERNAL_GATE_EXPECTED || '';
  if (!exp) {
    return { status: 'SKIP', reason: '未声明对照件身份（真源里该路径仍是 __LOCAL__ 占位符）⇒ 只核对内容会漏掉对象替换', resolved: external };
  }
  let samePath = false;
  try { samePath = path.resolve(external) === path.resolve(exp); } catch (e) { samePath = false; }
  if (!samePath) {
    return { status: 'FAIL', reason: '身份不符：对照件不是声明的那个文件（内容即便相同也不算）', resolved: external, expected: exp };
  }
  const a = sha256(builtin), b = sha256(external);
  return a === b
    ? { status: 'PASS', sha: a.slice(0, 24), identity: 'bound' }
    : { status: 'FAIL', reason: '内外门不一致', builtin: a.slice(0, 24), external: b.slice(0, 24) };
}

function adapterCheck(root) {
  const out = { ok: true, items: [] };
  const tm = path.join(root, 'plugin', 'tools-manifest.json');
  try {
    const j = JSON.parse(fs.readFileSync(tm, 'utf8'));
    const acts = (((j[0] || {}).parameters || {}).properties || {}).action;
    const n = (acts && acts.enum ? acts.enum.length : 0);
    out.items.push({ name: 'plugin/tools-manifest.json', ok: n > 20, note: 'action 枚举 ' + n + ' 项' });
    if (!(n > 20)) out.ok = false;
  } catch (e) { out.items.push({ name: 'plugin/tools-manifest.json', ok: false, note: String((e && e.message) || e).slice(0, 60) }); out.ok = false; }
  for (const rel of ['plugin/adapters/install-mcp.cjs', 'plugin/adapters/install-codex.cjs', 'plugin/skill/SKILL.md', 'plugin/bin/mcp-server.mjs']) {
    const p = path.join(root, rel);
    const ok = fs.existsSync(p) && fs.statSync(p).size > 100;
    out.items.push({ name: rel, ok, note: ok ? '存在' : '缺失或过小' });
    if (!ok) out.ok = false;
  }
  return out;
}

function runAudit(opts) {
  const o = opts || {};
  const root = o.root || ROOT;
  const man = deriveManifest(root);
  const parentPkg = JSON.parse(fs.readFileSync(path.join(root, 'plugin', 'package.json'), 'utf8'));
  const res = {
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
    pluginVersion: parentPkg.version,
    declared: man.declared.length,
    fileCount: man.files.filter((f) => !f.startsWith('MISSING:')).length,
    missing: man.files.filter((f) => f.startsWith('MISSING:')),
    forbidden: forbiddenHits(man.files),
    secrets: secretScan(root, man.files.filter((f) => !f.startsWith('MISSING:'))),
    csl: cslLock(root),
    gate: gateParity(root, o.externalGate || EXTERNAL_GATE, o.expectedGate || declaredExternal(root)),
    adapters: adapterCheck(root),
    /* ★ v3.2.94：许可合规（依赖许可原文 + 随包资产登记/署名）。跑不起来记 SKIP 并写明原因（不是通过）。 */
    licenseAudit: (() => {
      try { const la = require('./license-audit.cjs'); const r = la.audit(root);
        return { status: r.status, fails: r.fails, warns: r.warns, skips: r.skips, deps: r.deps.rows.length, assets: r.assets.rows.length };
      } catch (e) { return { status: 'SKIP', reason: '许可合规检查跑不起来：' + String((e && e.message) || e) }; }
    })(),
    manifest: null,
    derivation: 'package.json files 白名单（★不含 npm 自身的忽略规则 ⇒ 本清单是发布 tarball 的**超集**）',
    npmFileCount: Number(process.env.PS_NPM_FILE_COUNT) || null,
  };
  if (res.npmFileCount) res.npmDelta = res.fileCount - res.npmFileCount;
  if (o.writeManifest) {
    const rows = man.files.filter((f) => !f.startsWith('MISSING:')).map((f) => ({ path: f, sha256: sha256(path.join(root, f)), bytes: fs.statSync(path.join(root, f)).size }));
    fs.mkdirSync(path.dirname(o.writeManifest), { recursive: true });
    fs.writeFileSync(o.writeManifest, JSON.stringify({ version: res.version, generated_at: new Date().toISOString(), count: rows.length, files: rows }, null, 2), 'utf8');
    res.manifest = { path: o.writeManifest, count: rows.length };
  }
  const fails = [];
  if (res.missing.length) fails.push('随包清单声明了但文件不存在：' + res.missing.join(' / '));
  if (res.forbidden.length) fails.push('清单含违禁项：' + res.forbidden.join(' / '));
  if (res.secrets.length) fails.push('清单里疑似密钥样式文本：' + res.secrets.join(' / '));
  if (!res.csl.ok) fails.push('样式锁不成立：' + (res.csl.bad || []).join(' / ') + (res.csl.reason ? ' ' + res.csl.reason : ''));
  if (res.gate.status === 'FAIL') fails.push('门副本对拍失败：' + JSON.stringify(res.gate));
  if (!res.adapters.ok) fails.push('适配器/宿主兼容项缺失：' + res.adapters.items.filter((x) => !x.ok).map((x) => x.name).join(' / '));
  if (res.licenseAudit.status === 'FAIL') fails.push('许可合规未通过（依赖许可或随包资产登记/署名）⇒ 跑 node bin/license-audit.cjs 看明细');
  if (res.pluginVersion !== res.version) fails.push('版本不同步：主包 ' + res.version + ' vs 插件 ' + res.pluginVersion);
  res.ok = fails.length === 0;
  res.fails = fails;
  return res;
}

// ─────────────────────────── selftest ───────────────────────────
function selftest() {
  const cases = [];
  const ck = (name, fn) => { let r; try { r = fn(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ name, ok: r === true, detail: r === true ? '' : String(r) }); };

  ck('清单由声明推导：必须包含 panel/ 与 references/forms/（否则随包能力缺失）', () => {
    const m = deriveManifest(ROOT);
    const has = (p) => m.files.some((f) => f.split('\\').join('/').startsWith(p));
    if (!has('panel/')) return '缺 panel/';
    if (!has('references/forms/')) return '缺 references/forms/';
    if (!has('bin/')) return '缺 bin/';
    if (m.files.length < 50) return '清单过短：' + m.files.length;
    return true;
  });

  ck('★必失败面：清单里塞进 node_modules / .npmrc 必须被违禁扫描抓出', () => {
    const hits = forbiddenHits(['panel/lib/index.js', 'node_modules/x/index.js', '.npmrc', '.git/config']);
    if (hits.length !== 3) return '应抓 3 项，实得 ' + hits.length;
    return true;
  });

  ck('★诚实面：外部对照门不存在时必须记 SKIP（不是 PASS）', () => {
    const r = gateParity(ROOT, path.join(ROOT, 'no-such-external.cjs'));
    return r.status === 'SKIP' ? true : ('状态应为 SKIP，实得 ' + r.status);
  });

  ck('样式锁：3 个 CSL 样式必须逐一对上 sha256', () => {
    const r = cslLock(ROOT);
    if (!r.ok) return '不成立：' + JSON.stringify(r);
    return r.total === 3 ? true : ('样式数应为 3，实得 ' + r.total);
  });

  ck('适配器面：MCP 清单 action 枚举必须够多且四个宿主相关文件都在', () => {
    const r = adapterCheck(ROOT);
    return r.ok ? true : ('缺：' + r.items.filter((x) => !x.ok).map((x) => x.name).join(' / '));
  });


  ck('v3.2.83·★对拍锁身份绑定：同一份内容放到第二个目录，必须判 FAIL（内容相同也不算）', () => {
    const os = require('os');
    const src = path.join(ROOT, 'gates', '_journal-contract.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-id-'));
    const copy = path.join(dir, '_journal-contract.cjs');
    fs.copyFileSync(src, copy);
    const r = gateParity(ROOT, copy, src);   // 内容相同、路径不同
    fs.rmSync(dir, { recursive: true, force: true });
    if (r.status !== 'FAIL') return '应 FAIL，实得 ' + r.status;
    return /身份不符/.test(String(r.reason)) ? true : '原因未点明身份：' + r.reason;
  });

  ck('v3.2.83·对拍锁：身份成立但内容不同 ⇒ FAIL（漂移）；身份成立且内容相同 ⇒ PASS（正控）', () => {
    const os = require('os');
    const src = path.join(ROOT, 'gates', '_journal-contract.cjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-dr-'));
    const mod = path.join(dir, '_journal-contract.cjs');
    fs.copyFileSync(src, mod);
    fs.appendFileSync(mod, '\n// drift\n');
    const bad = gateParity(ROOT, mod, mod);          // 身份=自己，内容与内置不同
    const good = gateParity(ROOT, src, src);         // 正控
    fs.rmSync(dir, { recursive: true, force: true });
    if (bad.status !== 'FAIL') return '漂移应 FAIL，实得 ' + bad.status;
    if (good.status !== 'PASS') return '正控应 PASS，实得 ' + good.status + ' ' + JSON.stringify(good.reason);
    return good.identity === 'bound' ? true : 'PASS 未标身份绑定';
  });

  ck('v3.2.83·对拍锁：未声明身份时必须记 SKIP（不是 PASS）', () => {
    const src = path.join(ROOT, 'gates', '_journal-contract.cjs');
    const r = gateParity(ROOT, src, '');
    if (r.status === 'PASS') return '缺身份声明竟判 PASS（会漏掉对象替换）';
    return r.status === 'SKIP' ? true : ('应 SKIP，实得 ' + r.status);
  });

  ck('v3.2.83·声明路径推导：真源里该路径为 __LOCAL__ 占位符时必须返回空（不许假装绑定）', () => {
    const d = declaredExternal(ROOT);
    if (d && /__LOCAL__/.test(d)) return '把占位符当成了真实路径：' + d;
    return true;
  });

  ck('端到端：runAudit 必须 ok=true（主包与插件版本一致、无违禁项、样式锁成立）', () => {
    const r = runAudit({});
    if (!r.ok) return '失败项：' + r.fails.join(' ｜ ');
    if (r.pluginVersion !== r.version) return '版本不同步';
    return true;
  });

  ck('清单落盘：--write-manifest 必须真的写出可复核的 sha256 表', () => {
    const tmp = path.join(require('os').tmpdir(), 'ps-manifest-' + Date.now() + '.json');
    const r = runAudit({ writeManifest: tmp });
    const ok = fs.existsSync(tmp);
    const j = ok ? JSON.parse(fs.readFileSync(tmp, 'utf8')) : null;
    try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
    if (!ok) return '没写出清单文件';
    if (!j.count || j.count !== r.fileCount) return '清单条目数与 runAudit 不一致：' + (j && j.count) + ' vs ' + r.fileCount;
    if (!(j.files || []).every((x) => x.sha256 && x.sha256.length === 64)) return '有条目缺 sha256';
    return true;
  });

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.name + (c.ok ? '' : '  ← ' + c.detail));
  console.log('\npackage-audit 自检：' + (cases.length - failed.length) + '/' + cases.length + ' 通过');
  return failed.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const flag = (k) => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : ''; };
  const json = argv.includes('--json');
  const r = runAudit({ writeManifest: flag('--write-manifest') || null });
  if (json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 2; }
  console.log('源文件完整性与兼容度校验 · v' + r.version + '（插件 v' + r.pluginVersion + '）');
  console.log('  随包清单：声明 ' + r.declared + ' 项 ⇒ 实际文件 ' + r.fileCount + ' 个' + (r.missing.length ? ' · ⚠ 声明了但缺失 ' + r.missing.length : ''));
  console.log('  口径：' + r.derivation);
  if (r.npmFileCount) console.log('  与 npm 实发对拍：npm ' + r.npmFileCount + ' 个 ⇒ 本清单多 ' + r.npmDelta + ' 个（超集属正常：npm 有自己的忽略规则）');
  if (r.manifest) console.log('  清单已落盘：' + r.manifest.path + '（' + r.manifest.count + ' 条含 sha256）');
  console.log('  违禁项：' + (r.forbidden.length ? '✘ ' + r.forbidden.join(' / ') : '✔ 无（无 .npmrc / node_modules / .git / 密钥文件）'));
  console.log('  密钥样式扫描：' + (r.secrets.length ? '✘ ' + r.secrets.join(' / ') : '✔ 未发现'));
  console.log('  样式锁：' + (r.csl.ok ? '✔ ' + r.csl.checked + '/' + r.csl.total : '✘ ' + JSON.stringify(r.csl)));
  console.log('  门副本逐字节：' + r.gate.status + (r.gate.sha ? '（sha256 ' + r.gate.sha + '…）' : r.gate.reason ? '（' + r.gate.reason + '）' : ''));
  console.log('  适配器/宿主兼容：' + (r.adapters.ok ? '✔ ' + r.adapters.items.length + ' 项' : '✘ 缺 ' + r.adapters.items.filter((x) => !x.ok).map((x) => x.name).join(' / ')));
  console.log('  许可合规：' + (r.licenseAudit.status === 'PASS' ? '✔ 依赖 ' + r.licenseAudit.deps + ' 项 / 资产 ' + r.licenseAudit.assets + ' 项（无 FAIL）' : (r.licenseAudit.status + '（FAIL ' + r.licenseAudit.fails + ' · WARN ' + r.licenseAudit.warns + ' · SKIP ' + r.licenseAudit.skips + '）' + (r.licenseAudit.reason ? ' ' + r.licenseAudit.reason : ''))));
  console.log(r.ok ? '\n  判定：通过' : '\n  判定：失败\n' + r.fails.map((f) => '    ✘ ' + f).join('\n'));
  return r.ok ? 0 : 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { runAudit, deriveManifest, forbiddenHits, cslLock, gateParity, declaredExternal, adapterCheck, sha256 };
