// dsh-paper-studio · 面板凭据存储（**唯一真源**，宿主半体 plugin/dist/plugin.js 与 CLI bin/studio.cjs 共用）
//
// 为什么要有这个文件：面板里录入的 token 必须让 CLI 也能用（否则"面板里连上了、写论文时却仍无模型"）。
// 所以**只允许一处定义格式与优先级**，两边都 import 它 —— 不许各写一份解析逻辑（那必然分叉）。
//
// 硬约束（用户 2026-10-16 目标）：
//   · 凭据只写本机（默认 ~/.dsh/paper-studio/keys.json，**在仓库之外**，不进 git、不进日志、不在对话里回显）
//   · 读失败/文件损坏 **绝不抛**：返回空 + 原因，调用方按"没有面板凭据"继续（失败方向必须安全）
//   · 写入尽力收紧权限（POSIX 0600；Windows 上 chmod 基本是 no-op，靠目录在用户家目录下）
//   · 「停用」语义：面板停用 **优先于环境变量** —— 用户点停用就是停用，不许被 env 悄悄复活
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const VERSION = 1
const PID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/i

/** 存储位置：环境变量（测试/便携用）→ 用户家目录标准位。**永不在仓库内**。 */
function keysFilePath() {
  const e = process.env.DSH_PAPER_KEYS_FILE
  if (e && String(e).trim()) return String(e).trim()
  return path.join(os.homedir(), '.dsh', 'paper-studio', 'keys.json')
}

function emptyDoc() { return { version: VERSION, updated_at: null, providers: {} } }

/** 归一化：只认已知字段，未知字段丢弃（避免把别的东西写进凭据文件）。 */
function normDoc(raw) {
  const doc = emptyDoc()
  if (!raw || typeof raw !== 'object') return doc
  if (raw.updated_at) doc.updated_at = String(raw.updated_at)
  const src = (raw.providers && typeof raw.providers === 'object') ? raw.providers : {}
  for (const pid of Object.keys(src)) {
    if (!PID_RE.test(pid)) continue
    const v = src[pid]
    if (!v || typeof v !== 'object') continue
    const ent = {
      key: typeof v.key === 'string' ? v.key.trim() : '',
      enabled: v.enabled !== false,                        // 默认启用＝写入即启用
      base_url: typeof v.base_url === 'string' ? v.base_url.trim() : '',
      model: typeof v.model === 'string' ? v.model.trim() : '',
      label: typeof v.label === 'string' ? v.label.trim() : '',
      added_at: v.added_at ? String(v.added_at) : null,
      last_test: (v.last_test && typeof v.last_test === 'object')
        ? { at: v.last_test.at ? String(v.last_test.at) : null, ok: v.last_test.ok === true, status: Number(v.last_test.status || 0), note: String(v.last_test.note || '').slice(0, 200) }
        : null,
    }
    if (!ent.key && ent.enabled !== false) continue          // 空 key 且未显式停用 ⇒ 视为没这条
    doc.providers[pid] = ent
  }
  return doc
}

/** 读：**永不抛**。ok=false 时 doc 仍可用（空文档）+ reason 说明为什么。 */
function read() {
  const p = keysFilePath()
  try {
    if (!fs.existsSync(p)) return { ok: true, exists: false, doc: emptyDoc(), path: p, reason: null }
    const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
    if (!txt.trim()) return { ok: true, exists: true, doc: emptyDoc(), path: p, reason: '文件为空' }
    let raw = null
    try { raw = JSON.parse(txt) } catch (e) { return { ok: false, exists: true, doc: emptyDoc(), path: p, reason: 'JSON 解析失败：' + String(e && e.message || e).slice(0, 120) } }
    return { ok: true, exists: true, doc: normDoc(raw), path: p, reason: null }
  } catch (e) {
    return { ok: false, exists: false, doc: emptyDoc(), path: p, reason: '读取失败：' + String(e && e.message || e).slice(0, 120) }
  }
}

/** 写：先建目录、再原子写（临时文件 + rename），尽力 0600。**永不抛**。 */
function write(doc) {
  const p = keysFilePath()
  try {
    const d = path.dirname(p)
    fs.mkdirSync(d, { recursive: true })
    const out = normDoc(doc)
    out.version = VERSION
    out.updated_at = new Date().toISOString()
    const tmp = p + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    try { fs.chmodSync(tmp, 0o600) } catch (e) { /* Windows 上是 no-op，不致命 */ }
    fs.renameSync(tmp, p)
    try { fs.chmodSync(p, 0o600) } catch (e) { /* 同上 */ }
    return { ok: true, path: p, reason: null }
  } catch (e) {
    return { ok: false, path: p, reason: '写入失败：' + String(e && e.message || e).slice(0, 120) }
  }
}

function assertPid(pid) {
  const s = String(pid || '')
  if (!PID_RE.test(s)) throw new Error('provider 名字非法（只允许字母数字与 - _，最长 32）：' + s.slice(0, 40))
  return s
}

/** 录入/更新一枚 key（默认启用）。 */
function setKey(pid, patch) {
  const id = assertPid(pid)
  const r = read()
  const doc = r.doc
  const cur = doc.providers[id] || {}
  const p = patch || {}
  doc.providers[id] = Object.assign({}, cur, {
    key: p.key === undefined ? (cur.key || '') : String(p.key).trim(),
    enabled: p.enabled === undefined ? (cur.enabled !== false) : (p.enabled !== false),
    base_url: p.base_url === undefined ? (cur.base_url || '') : String(p.base_url).trim(),
    model: p.model === undefined ? (cur.model || '') : String(p.model).trim(),
    label: p.label === undefined ? (cur.label || '') : String(p.label).trim(),
    added_at: cur.added_at || new Date().toISOString(),
  })
  const w = write(doc)
  return { ok: w.ok, path: w.path, reason: w.reason, pid: id }
}

/** 停用 / 启用（**停用保留 key**，不删除 —— 用户要求"保留但关闭"）。 */
function setEnabled(pid, enabled) {
  const id = assertPid(pid)
  const r = read()
  const doc = r.doc
  const cur = doc.providers[id]
  if (!cur) return { ok: false, path: r.path, reason: '该 provider 未录入（先 set 再 enable/disable）', pid: id }
  cur.enabled = enabled !== false
  const w = write(doc)
  return { ok: w.ok, path: w.path, reason: w.reason, pid: id, enabled: cur.enabled }
}

/** 删除（真删，连 key 一起）。 */
function removeKey(pid) {
  const id = assertPid(pid)
  const r = read()
  const doc = r.doc
  if (!doc.providers[id]) return { ok: true, path: r.path, reason: null, pid: id, removed: false }
  delete doc.providers[id]
  const w = write(doc)
  return { ok: w.ok, path: w.path, reason: w.reason, pid: id, removed: true }
}

/** 掩码（面板与 CLI 只显示它；长度也只在明确要求时显示）。 */
function mask(k) { const s = String(k || ''); return s ? (s.slice(0, 3) + '***' + s.slice(-2)) : '（未配置）' }
function maskWithLen(k) { const s = String(k || ''); return s ? (mask(s) + '（长度 ' + s.length + '）') : '（未配置）' }

/**
 * 凭据解析（**唯一优先级定义**）：`--key` > 面板停用（阻断）> 面板启用 > `--key-file` > 环境变量。
 * 返回 { key, from, disabled, reason }；disabled=true 表示"明确不可用"，调用方必须**说明原因**而不是报"未配置"。
 */
function resolveKey(pid, opts) {
  const o = opts || {}
  const id = String(pid || '')
  if (o.argvKey && String(o.argvKey).trim()) return { key: String(o.argvKey).trim(), from: '--key（一次性参数，不落盘）', disabled: false, reason: null }
  const r = read()
  const ent = (r.doc.providers && r.doc.providers[id]) || null
  if (ent && ent.enabled === false) {
    return { key: '', from: '面板：已停用', disabled: true, reason: '面板里该 provider 被停用 ⇒ 即便环境变量有值也不使用（要临时用请加 --key）' }
  }
  if (ent && ent.key) return { key: ent.key, from: '面板（本机 ' + r.path + '，不进仓库）', disabled: false, reason: null }
  if (o.keyFile && fs.existsSync(o.keyFile)) {
    try {
      const t = fs.readFileSync(o.keyFile, 'utf8').trim()
      if (/^\S+$/.test(t)) return { key: t, from: '--key-file（外部文件，本工具只读不写）', disabled: false, reason: null }
    } catch (e) { /* 落到 env */ }
  }
  const env = o.env || process.env
  for (const n of (o.envNames || [])) {
    const v = env[n]
    if (v && String(v).trim()) return { key: String(v).trim(), from: 'env ' + n, disabled: false, reason: null }
  }
  const why = r.ok ? null : ('面板凭据文件有问题（' + r.reason + '），已按未配置继续')
  return { key: '', from: '（未配置）', disabled: false, reason: why }
}

/** 面板/CLI 列表要用的摘要（**绝不含明文**）。 */
function rows(knownIds) {
  const r = read()
  const ids = Array.from(new Set([].concat(knownIds || [], Object.keys(r.doc.providers || {})))).sort()
  return {
    path: r.path, file_ok: r.ok, file_reason: r.reason, updated_at: r.doc.updated_at,
    items: ids.map((id) => {
      const e = (r.doc.providers || {})[id]
      return e
        ? { id, present: true, enabled: e.enabled !== false, key_masked: maskWithLen(e.key), base_url: e.base_url || '', model: e.model || '', label: e.label || '', added_at: e.added_at, last_test: e.last_test }
        : { id, present: false, enabled: false, key_masked: '（未录入）', base_url: '', model: '', label: '', added_at: null, last_test: null }
    }),
  }
}

module.exports = { VERSION, keysFilePath, emptyDoc, normDoc, read, write, setKey, setEnabled, removeKey, mask, maskWithLen, resolveKey, rows }

/* ───────────────────────── 自检（`node bin/keys-store.cjs --selftest`）─────────────────────────
 * 为什么共享库也要有自检：它是**宿主半体与 CLI 共用的唯一真源**，一旦它错，两边一起错，
 * 而且错法很隐蔽（优先级反了 ≈ 用户点了停用却仍在用凭据）。所以判据必须可执行、可回归。
 * 全部在临时目录里跑，**绝不碰用户的真实凭据文件**。 */
if (require.main === module) {
  const args = process.argv.slice(2)
  if (!args.includes('--selftest')) { console.error('用法：node bin/keys-store.cjs --selftest（共享库无其它命令行入口）'); process.exit(2) }
  const checks = []
  const ck = (n, f) => { try { const r = f(); checks.push({ n: n, ok: r === true, why: r === true ? '' : String(r) }) } catch (e) { checks.push({ n: n, ok: false, why: String((e && e.message) || e) }) } }
  const ROOTDIR = path.resolve(__dirname, '..')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pks-self-'))
  const prevEnv = process.env.DSH_PAPER_KEYS_FILE
  process.env.DSH_PAPER_KEYS_FILE = path.join(dir, 'keys.json')
  const FAKE = ['sk', 'selftest', '2'.repeat(24)].join('-')

  ck('1 存储路径必须在**仓库之外**（凭据不进 git）', () => {
    const p0 = path.resolve(keysFilePath()).toLowerCase()
    return p0.startsWith(ROOTDIR.toLowerCase() + path.sep) ? ('落在仓库内：' + p0) : true
  })
  ck('2 文件不存在 ⇒ 不抛、返回空文档、ok=true（不是错误）', () => {
    const r = read()
    if (!r.ok || r.exists) return 'ok=' + r.ok + ' exists=' + r.exists
    return Object.keys(r.doc.providers).length === 0 ? true : '空文档却有 provider'
  })
  ck('3 setKey → read：掩码不含明文，长度如实', () => {
    setKey('deepseek', { key: FAKE, enabled: true })
    const r = read()
    const e = r.doc.providers.deepseek
    if (!e || e.key !== FAKE) return '写入未生效'
    const m = maskWithLen(FAKE)
    return (!m.includes(FAKE) && /\*\*\*/.test(m)) ? true : ('掩码泄露：' + m)
  })
  ck('4 ★停用优先于环境变量（用户点停用就是停用）', () => {
    setEnabled('deepseek', false)
    const r = resolveKey('deepseek', { envNames: ['DSH_FAKE_KEY'], env: { DSH_FAKE_KEY: FAKE } })
    if (r.key) return '停用后仍取到 key（来源 ' + r.from + '）'
    return (r.disabled === true && /停用/.test(r.from)) ? true : ('未标记 disabled：' + JSON.stringify(r))
  })
  ck('5 ★--key 优先于停用（临时显式用是允许的）', () => {
    const r = resolveKey('deepseek', { argvKey: FAKE, envNames: ['DSH_FAKE_KEY'], env: { DSH_FAKE_KEY: 'x' } })
    return (r.key === FAKE && !r.disabled && /--key/.test(r.from)) ? true : JSON.stringify(r)
  })
  ck('6 面板无该 provider ⇒ 回落环境变量（零面板也能用）', () => {
    const r = resolveKey('openai', { envNames: ['DSH_FAKE_KEY'], env: { DSH_FAKE_KEY: FAKE } })
    return (r.key === FAKE && /env /.test(r.from)) ? true : JSON.stringify(r)
  })
  ck('7 ★必失败面：损坏 JSON ⇒ 不抛，且明确给出原因', () => {
    fs.writeFileSync(keysFilePath(), '{ broken', 'utf8')
    const r = read()
    if (r.ok) return '损坏文件被当成正常'
    if (!/JSON/.test(String(r.reason))) return '原因没说明是 JSON：' + r.reason
    const rr = resolveKey('deepseek', { envNames: [], env: {} })
    return (rr.key === '' && rr.reason) ? true : ('resolveKey 未带出原因：' + JSON.stringify(rr))
  })
  ck('8 归一化：未知字段与非法 provider 名一律丢弃', () => {
    const d = normDoc({ providers: { 'bad name!': { key: 'x' }, ok1: { key: 'y', evil: 'z' } } })
    if (d.providers['bad name!']) return '非法名字被保留'
    return (d.providers.ok1 && d.providers.ok1.evil === undefined) ? true : '未知字段被保留'
  })
  ck('9 原子写：写完后目录里不留 .tmp- 残片', () => {
    fs.rmSync(keysFilePath(), { force: true })
    setKey('glm', { key: FAKE, enabled: true })
    const junk = fs.readdirSync(dir).filter((x) => x.includes('.tmp-'))
    return junk.length === 0 ? true : ('残留：' + junk.join(','))
  })
  ck('10 必失败面：非法 provider 名必须被拒（不许写进凭据文件）', () => {
    let threw = false
    try { setKey('../evil', { key: FAKE }) } catch (e) { threw = true }
    const guarded = (() => { try { return removeKey('a b') } catch (e) { return { ok: false } } })()
    return (threw && guarded.ok === false) ? true : ('threw=' + threw + ' removeGuard=' + JSON.stringify(guarded))
  })

  if (prevEnv === undefined) delete process.env.DSH_PAPER_KEYS_FILE; else process.env.DSH_PAPER_KEYS_FILE = prevEnv
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { /* 清理失败不致命 */ }
  const bad = checks.filter((c) => !c.ok)
  for (const c of checks) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : ('  ← ' + c.why)))
  console.log('自检：' + (checks.length - bad.length) + '/' + checks.length + ' 通过')
  process.exit(bad.length ? 1 : 0)
}
