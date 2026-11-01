#!/usr/bin/env node
/**
 * aris-patch —— 给已安装的 ARIS codex-exec 桥打两个幂等补丁
 *
 * 用法：
 *   node bin/aris-patch.cjs --check
 *   node bin/aris-patch.cjs --apply
 *   node bin/aris-patch.cjs --selftest
 *   node bin/aris-patch.cjs --server <path/to/server.py>
 *
 * 为什么需要：
 *   1) 桥在 `turn.completed` 后 codex 进程不退出 → MCP 调用挂到宿主超时；
 *      补丁在该分支 `taskkill /PID <pid> /T /F` 结束进程树。
 *   2) 宿主进程常常没有 `VOLC_ARK_KEY`（只在 User 作用域）→ 桥自己从
 *      Windows 用户环境补一次，避免每次重启宿主都手动注入。
 *
 * 注意：改的是**已安装插件**（node_modules），插件升级会覆盖，升级后重跑 `--apply`。
 * 首次修改会写 `server.py.bak-aris-patch`；重复执行不会重复插入。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_SERVER = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'node_modules',
  'dsh-aris', 'mcp-servers', 'codex-exec', 'server.py');

const MARK_ENV = '桥自己从 Windows 用户环境补一次';
const MARK_KILL = '用 taskkill /T 杀掉整棵进程树';
const ENV_BLOCK = `# 本地补丁 2026-11-01：宿主进程常常没有 VOLC_ARK_KEY（只在 User 作用域）。
# 桥自己从 Windows 用户环境补一次，避免每次重启宿主都要手动注入。
if not os.environ.get("VOLC_ARK_KEY"):
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Environment") as _k:
            os.environ["VOLC_ARK_KEY"] = winreg.QueryValueEx(_k, "VOLC_ARK_KEY")[0]
    except Exception:
        pass

`;
const KILL_OLD = `            elif etype == "turn.completed":
                outcome.completed = True
`;
const KILL_NEW = `            elif etype == "turn.completed":
                outcome.completed = True
                # 本地补丁 2026-11-01：codex exec 在 turn 完成后仍不退出（子进程/stdio 未关），
                # 用 taskkill /T 杀掉整棵进程树，避免 MCP 调用一直挂到宿主超时。
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
`;

function check(server) {
  const p = server || DEFAULT_SERVER;
  if (!fs.existsSync(p)) return { ok: false, error: 'server.py 不存在：' + p };
  const t = fs.readFileSync(p, 'utf8');
  return {
    ok: t.includes(MARK_ENV) && t.includes(MARK_KILL),
    server: p,
    env_loader: t.includes(MARK_ENV),
    kill_patch: t.includes(MARK_KILL),
    backup: fs.existsSync(p + '.bak-aris-patch'),
  };
}

function apply(server) {
  const p = server || DEFAULT_SERVER;
  if (!fs.existsSync(p)) throw new Error('server.py 不存在：' + p);
  let t = fs.readFileSync(p, 'utf8');
  if (!fs.existsSync(p + '.bak-aris-patch')) fs.copyFileSync(p, p + '.bak-aris-patch');
  if (!t.includes(MARK_ENV)) {
    const needle = 'STATE_DIR = Path(os.environ.get("CODEX_EXEC_STATE_DIR"';
    const i = t.indexOf(needle);
    if (i < 0) throw new Error('找不到 STATE_DIR 锚点，插件结构可能变了');
    t = t.slice(0, i) + ENV_BLOCK + t.slice(i);
  }
  if (!t.includes(MARK_KILL)) {
    if (!t.includes(KILL_OLD)) throw new Error('找不到 turn.completed 锚点，插件结构可能变了');
    t = t.replace(KILL_OLD, KILL_NEW);
  }
  fs.writeFileSync(p, t, 'utf8');
  return check(p);
}

function selftest() {
  const dir = path.join('D:\\DeepSeek\\_tmp', 'aris-patch-selftest');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'server.py');
  fs.writeFileSync(f,
    'import os\n' +
    'STATE_DIR = Path(os.environ.get("CODEX_EXEC_STATE_DIR", "x"))\n' +
    'def run():\n' +
    '    if True:\n' +
    '        for etype in []:\n' +
    '            elif etype == "turn.completed":\n' +
    '                outcome.completed = True\n', 'utf8');
  const checks = [];
  const before = check(f);
  checks.push(['未打补丁时 --check 为红', before.ok === false && before.env_loader === false]);
  const after = apply(f);
  checks.push(['apply 后两项补丁都在', after.ok === true && after.env_loader && after.kill_patch]);
  const again = apply(f);
  const body = fs.readFileSync(f, 'utf8');
  checks.push(['幂等：重复 apply 不重复插入', (body.match(/subprocess\.run\(\["taskkill"/g) || []).length === 1 && again.ok]);
  let missing = false;
  try { apply(path.join(dir, 'nope.py')); } catch (e) { missing = true; }
  checks.push(['文件不存在必须报错', missing]);
  let ok = 0;
  for (const [n, p] of checks) { console.log((p ? 'PASS ' : 'FAIL ') + n); if (p) ok += 1; }
  console.log('aris-patch selftest: ' + ok + '/' + checks.length + ' 通过');
  return ok === checks.length ? 0 : 1;
}

function main(argv) {
  const v = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  const server = v('--server');
  if (argv.includes('--selftest')) return selftest();
  try {
    if (argv.includes('--apply')) {
      const r = apply(server);
      console.log('ARIS 桥补丁：' + (r.ok ? '已就绪' : '仍缺项') + '\n  server=' + r.server +
        '\n  env_loader=' + r.env_loader + ' · kill_patch=' + r.kill_patch + ' · backup=' + r.backup);
      return r.ok ? 0 : 1;
    }
    const r = check(server);
    console.log((r.ok ? 'PASS ' : 'FAIL ') + 'ARIS 桥补丁检查\n  server=' + (r.server || server) +
      '\n  env_loader=' + r.env_loader + ' · kill_patch=' + r.kill_patch + ' · backup=' + r.backup);
    return r.ok ? 0 : 1;
  } catch (e) {
    console.error('失败：' + e.message);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { check, apply, selftest, DEFAULT_SERVER };
