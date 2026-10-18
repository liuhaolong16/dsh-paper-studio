#!/usr/bin/env node
/**
 * tex-engine — 给插件**自带**一套 LaTeX 引擎（一条命令装好，不污染系统 PATH）
 *
 * 为什么要有它：`latex.cjs --compile` 在本机长期只会返回 SKIP（pdflatex/xelatex/tectonic 全无），
 * 而"没引擎"不是使用者的错、也不该让他自己去翻 TeX Live 安装教程。这里把"装引擎"做成插件能力：
 * 下载 **tectonic 单文件**（自带包管理器，按需拉宏包，不需要 3GB 的 TeX Live），
 * 落到 `~/.dsh/cache/paper-studio/tex/`，`latex.cjs` 会**优先**用它。
 *
 * 子命令：
 *   --install   下载并解压当前平台对应的 tectonic（已存在则跳过，除非 --force）
 *   --status    报告：用哪个引擎、版本、路径（没有则给安装命令）
 *   --selftest  纯离线自检：URL 拼装 / 缓存路径 / 状态判定（**不做网络请求**）
 *
 * ★ 纪律：安装失败必须给出**具体原因**（HTTP 码 / 解压错 / 版本校验不符），并把半成品清掉，
 *   绝不留下一个"看起来装了"的目录——因为 `latex.cjs` 会优先信任这个缓存目录。
 *
 * 用法：
 *   node bin/tex-engine.cjs --install [--force]
 *   node bin/tex-engine.cjs --status
 *   node bin/tex-engine.cjs --selftest
 * 退出码：0 成功/已就绪 · 1 失败 · 3 未安装（status 用）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const VERSION = '0.17.0';

function cacheDir() {
  return path.join(os.homedir(), '.dsh', 'cache', 'paper-studio', 'tex');
}
function exeName() {
  return process.platform === 'win32' ? 'tectonic.exe' : 'tectonic';
}
function cacheExe() {
  return path.join(cacheDir(), exeName());
}

/**
 * 平台三元组 → tectonic 的 release 资产名。未知平台返回 null（明确不支持，不猜）。
 * ★ 参数约定：可传 `assetFor('win32-x64')`（整键），也可传 `assetFor(platform, arch)`。
 *   首版只接受后一种，自检里按整键调用 ⇒ 三个用例全部拿到 null，自检自己把自己抓出来了。
 */
function assetFor(platform, arch) {
  const key = arch ? (platform + '-' + arch) : String(platform || (process.platform + '-' + process.arch));
  const map = {
    'win32-x64': ['x86_64-pc-windows-msvc', 'zip'],
    'darwin-x64': ['x86_64-apple-darwin', 'tar.gz'],
    'darwin-arm64': ['aarch64-apple-darwin', 'tar.gz'],
    'linux-x64': ['x86_64-unknown-linux-musl', 'tar.gz'],
    'linux-arm64': ['aarch64-unknown-linux-musl', 'tar.gz'],
  };
  return map[key] || null;
}
function urlFor(platform, arch, version = VERSION) {
  const a = assetFor(platform, arch);
  if (!a) return null;
  const [target, ext] = a;
  return 'https://github.com/tectonic-typesetting/tectonic/releases/download/' +
    'tectonic%40' + version + '/tectonic-' + version + '-' + target + '.' + ext;
}

function download(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('重定向过多'));
    const req = https.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        return resolve(download(next, dest, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode + ' 于 ' + url));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(dest)));
      out.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('下载超时（120s）')));
    req.on('error', reject);
  });
}

function extract(archive, dir) {
  if (/\.zip$/i.test(archive)) {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command',
      'Expand-Archive -LiteralPath "' + archive + '" -DestinationPath "' + dir + '" -Force'],
      { encoding: 'utf8', timeout: 300000 });
    return r.status === 0 ? null : '解压失败：' + (r.stderr || r.stdout || '').slice(0, 200);
  }
  const r = spawnSync('tar', ['-xzf', archive, '-C', dir], { encoding: 'utf8', timeout: 300000 });
  return r.status === 0 ? null : '解压失败：' + (r.stderr || '').slice(0, 200);
}

function probe(exe) {
  if (!fs.existsSync(exe)) return null;
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 30000 });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0 || !/tectonic/i.test(out)) return null;
  return out.split(/\r?\n/)[0].trim();
}

function findInstalled() {
  const cached = probe(cacheExe());
  if (cached) return { kind: 'cache', path: cacheExe(), version: cached };
  if (process.env.PAPER_STUDIO_TEX) {
    const v = probe(process.env.PAPER_STUDIO_TEX);
    if (v) return { kind: 'env', path: process.env.PAPER_STUDIO_TEX, version: v };
  }
  for (const e of ['tectonic', 'pdflatex', 'xelatex', 'lualatex']) {
    const r = spawnSync(e, ['--version'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0) {
      const out = ((r.stdout || '') + (r.stderr || '')).trim();
      return { kind: 'path', path: e, version: out.split(/\r?\n/)[0].trim() };
    }
  }
  return null;
}

async function install(force) {
  const existing = findInstalled();
  if (existing && existing.kind === 'cache' && !force) {
    console.log('已安装（跳过）：' + existing.version + ' · ' + existing.path);
    console.log('要强制重装加 --force');
    return 0;
  }
  const url = urlFor();
  if (!url) {
    console.error('不支持的平台：' + process.platform + '-' + process.arch + '（支持 win32-x64 / darwin-x64 / darwin-arm64 / linux-x64 / linux-arm64）');
    return 1;
  }
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const ext = /\.zip$/i.test(url) ? '.zip' : '.tar.gz';
  const archive = path.join(dir, 'tectonic-download' + ext);
  console.log('下载中（约 20-30 MB）：' + url);
  try {
    await download(url, archive);
  } catch (e) {
    console.error('下载失败：' + e.message);
    console.error('可手动放置：把 tectonic 可执行文件放到 ' + cacheExe());
    return 1;
  }
  const size = (fs.statSync(archive).size / 1024 / 1024).toFixed(2);
  console.log('下载完成 ' + size + ' MB · 解压中');
  const err = extract(archive, dir);
  if (err) {
    console.error(err);
    fs.rmSync(archive, { force: true });
    return 1;
  }
  fs.rmSync(archive, { force: true });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(cacheExe(), 0o755); } catch (e) { /* 非致命 */ }
  }
  // ★ 校验：解压成功 ≠ 可执行。必须真跑 --version，否则 latex.cjs 会信任一个坏缓存。
  const v = probe(cacheExe());
  if (!v) {
    console.error('解压后校验失败：' + cacheExe() + ' 不能运行（已保留文件供排查）');
    return 1;
  }
  console.log('安装完成：' + v + '\n  路径：' + cacheExe());
  console.log('  latex.cjs --compile 现在会优先使用它');
  return 0;
}

function status() {
  const found = findInstalled();
  if (!found) {
    console.log('未安装 LaTeX 引擎（tectonic 缓存 / PAPER_STUDIO_TEX / PATH 都没有）');
    console.log('  安装：node bin/tex-engine.cjs --install');
    return 3;
  }
  console.log('可用引擎：' + found.kind + ' · ' + found.version);
  console.log('  路径：' + found.path);
  return 0;
}

function selftest() {
  const results = [];
  /** ★ 严格 === true（防 !!r 把失败读成通过） */
  const ck = (name, fn) => {
    let r;
    try { r = fn(); } catch (e) { r = 'THREW: ' + e.message; }
    results.push({ name, ok: r === true, why: r === true ? '' : String(r) });
  };

  ck('资产名：win32-x64 → msvc zip', () => {
    const a = assetFor('win32-x64');
    return (a && a[0] === 'x86_64-pc-windows-msvc' && a[1] === 'zip') ? true : JSON.stringify(a);
  });
  ck('资产名：darwin-arm64 → apple tar.gz', () => {
    const a = assetFor('darwin-arm64');
    return (a && a[0] === 'aarch64-apple-darwin' && a[1] === 'tar.gz') ? true : JSON.stringify(a);
  });
  ck('资产名：linux-x64 → musl tar.gz', () => {
    const a = assetFor('linux-x64');
    return (a && a[0] === 'x86_64-unknown-linux-musl' && a[1] === 'tar.gz') ? true : JSON.stringify(a);
  });
  ck('★未知平台返回 null（不猜一个可能下错的包）', () => {
    return assetFor('sunos-sparc') === null ? true : '返回了非 null';
  });
  ck('URL：含 tag 编码 tectonic%40 与版本号', () => {
    const u = urlFor('win32-x64', undefined, '0.17.0');
    if (!u) return 'null';
    if (!u.includes('tectonic%400.17.0')) return 'tag 编码不对：' + u;
    if (!u.endsWith('tectonic-0.17.0-x86_64-pc-windows-msvc.zip')) return '文件名不对：' + u;
    return true;
  });
  ck('缓存路径：落在 ~/.dsh/cache/paper-studio/tex 下', () => {
    const p = cacheExe();
    const want = path.join(os.homedir(), '.dsh', 'cache', 'paper-studio', 'tex');
    return p.startsWith(want) ? true : p;
  });
  ck('★status 三态：未安装必须 exit 3（不是 0）', () => {
    const found = findInstalled();
    const code = status();
    if (!found) return code === 3 ? true : '未安装却 exit ' + code;
    return code === 0 ? true : '已安装却 exit ' + code;
  });
  ck('★probe 对不存在的路径返回 null（不把缺失当可用）', () => {
    return probe(path.join(os.tmpdir(), 'definitely-not-a-tex-engine-' + Date.now())) === null ? true : '返回了非 null';
  });

  const pass = results.filter((x) => x.ok).length;
  results.forEach((r) => console.log((r.ok ? 'PASS ' : 'FAIL ') + r.name + (r.ok ? '' : ' :: ' + r.why)));
  console.log('\ntex-engine selftest: ' + pass + '/' + results.length + ' 通过');
  return pass === results.length ? 0 : 1;
}

async function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  if (argv.includes('--status')) return status();
  if (argv.includes('--install')) return install(argv.includes('--force'));
  console.log('用法：--install [--force] | --status | --selftest');
  return 2;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((c) => process.exit(c)).catch((e) => {
    console.error('ERR ' + e.message);
    process.exit(1);
  });
}
module.exports = { assetFor, urlFor, cacheExe, findInstalled, probe, VERSION };
