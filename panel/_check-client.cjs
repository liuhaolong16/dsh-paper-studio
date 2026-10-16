// dsh-paper-keys · 隔离验证器（`node panel/_check-client.cjs`）
//
// 为什么必须有它：客户端半体是**在别人的宿主里跑**的代码，一旦抛错就是白屏；而白屏无法在开发机上"看"到。
//   所以把"能不能被安全加载 / 会不会抛 / 注册到哪 / 会不会泄露明文"做成**可执行的断言**，在启用之前先跑。
//
// 四类检查：
//   ① 加载面：包壳 id、**纯具名导出**（无 default 依赖）、exports.apply/inject 形态
//   ② 敌意 ctx 面：`apply` 在空/畸形/抛错的 ctx 下**不得抛**，且必须返回可释放函数
//   ③ 正控：桩 slots / 桩 webServer ⇒ 断言注册到 `settings.section`（id/order/label）与 6 条 /api 路由
//   ④ 必失败面 + 安全面：篡改后的副本必须被判失败（证明检查不是空转）；列表**不得出现明文**；跨源必须 403
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')

const PANEL = __dirname
const CLIENT = path.join(PANEL, 'lib', 'client.js')
const HOST = path.join(PANEL, 'lib', 'index.js')
const PLANTED = ['sk', 'leakcheck', '9'.repeat(24)].join('-')

const checks = []
const ck = (n, fn) => { try { const r = fn(); checks.push({ n, ok: r === true, why: r === true ? '' : String(r) }) } catch (e) { checks.push({ n, ok: false, why: String((e && e.message) || e) }) } }
const ckA = async (n, fn) => { try { const r = await fn(); checks.push({ n, ok: r === true, why: r === true ? '' : String(r) }) } catch (e) { checks.push({ n, ok: false, why: String((e && e.message) || e) }) } }

/** 在 VM 里加载客户端半体：桩掉 window.__ModuleLoader__ 与 require。 */
function loadClient(src) {
  let captured = null
  const requireStub = (name) => {
    if (name === 'react') return { createElement: (...a) => ({ type: a[0], props: a[1] || {}, children: a.slice(2) }), useState: (v) => [v, () => {}], useEffect: () => {} }
    throw new Error('客户端不应 require：' + name)
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (cfg) => { captured = cfg } } },
    console: { log() {}, error() {} },
    document: undefined,
    fetch: () => Promise.reject(new Error('check 环境不发网络请求')),
    URL,
    JSON, Object, Array, String, Number, Boolean, Symbol, Promise, Error, Date, RegExp,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(String(src), sandbox, { filename: 'client.js' })
  if (!captured) throw new Error('没有调用 window.__ModuleLoader__.load')
  return { cfg: captured, mod: captured.factory(requireStub) }
}

// ───────────────── ① 加载面 ─────────────────

const clientSrc = fs.readFileSync(CLIENT, 'utf8')
let loaded = null

ck('① 包壳：id 必须是 dsh-paper-keys（与 package.json 同名，否则宿主认不出）', () => {
  if (!/__ModuleLoader__\s*\.\s*load\(/.test(clientSrc)) return '不是 ModuleLoader 包壳形态'
  loaded = loadClient(clientSrc)
  return loaded.cfg.id === 'dsh-paper-keys' ? true : ('id=' + loaded.cfg.id)
})

ck('① 纯具名导出：apply 是函数、inject 是数组，且**不依赖 default**', () => {
  const m = loaded.mod
  if (typeof m.apply !== 'function') return 'apply 不是函数'
  if (!Array.isArray(m.inject) || m.inject.indexOf('slots') < 0) return 'inject 必须含 slots：' + JSON.stringify(m.inject)
  if (m.default) return '出现了 default 导出（本插件要求纯具名）'
  return true
})

ck('① 客户端源码安全面：不得 document.write / eval / 引入 fs', () => {
  const bad = []
  if (/document\.write\s*\(/.test(clientSrc)) bad.push('document.write')
  if (/\beval\s*\(/.test(clientSrc)) bad.push('eval')
  if (/require\(\s*['"](node:)?fs['"]\s*\)/.test(clientSrc)) bad.push('require(fs)')
  return bad.length === 0 ? true : ('命中：' + bad.join(', '))
})

// ───────────────── ② 敌意 ctx 面（**不许抛**）─────────────────

ck('② 敌意 ctx：{} / null / get 抛错 / slots 半残 —— apply 都不得抛且要返回释放函数', () => {
  const apply = loaded.mod.apply
  const cases = [
    ['{}', {}],
    ['null', null],
    ['undefined', undefined],
    ['get 抛错', { get() { throw new Error('boom') } }],
    ['slots 半残（只有 inject）', { slots: { inject() {} } }],
    ['slots 半残（只有 register）', { slots: { register() {} } }],
    ['slots 抛错', { slots: { inject() { throw new Error('boom') }, register() { throw new Error('boom') } } }],
  ]
  for (const [label, ctx] of cases) {
    let ret
    try { ret = apply(ctx) } catch (e) { return label + ' 抛了：' + String((e && e.message) || e) }
    if (typeof ret !== 'function') return label + ' 没返回释放函数'
    try { ret() } catch (e) { return label + ' 的释放函数抛了' }
  }
  return true
})

// ───────────────── ③ 正控：注册面 ─────────────────

ck('③ 正控：桩 slots 下恰好注册一格 settings.section（id/order/label 都对）', () => {
  const regs = []
  let injected = null
  const ctx = {
    slots: {
      inject(name, cb) { injected = name; cb(); return () => { regs.push(['disposed']) } },
      register(spec, Comp) { regs.push({ spec, Comp }); return () => {} },
    },
  }
  const dispose = loaded.mod.apply(ctx)
  if (injected !== 'settings.section') return 'inject 的槽不是 settings.section：' + injected
  const real = regs.filter((r) => r && r.spec)
  if (real.length !== 1) return '注册次数应为 1，实际 ' + real.length
  const { spec, Comp } = real[0]
  if (spec.name !== 'settings.section') return 'spec.name=' + spec.name
  if (spec.id !== 'paper-keys') return 'spec.id=' + spec.id
  if (typeof spec.order !== 'number') return 'order 不是数字'
  const label = typeof spec.label === 'function' ? spec.label() : spec.label
  if (String(label).indexOf('论文插件外置 key 连接器') < 0) return 'label 不含要求的名称：' + label
  if (typeof Comp !== 'function') return '组件不是函数'
  try { dispose() } catch (e) { return 'dispose 抛了' }
  return true
})

// ───────────────── ④ 必失败面（证明检查不是空转）─────────────────

ck('④ 必失败面：把 apply 改成会抛的版本 ⇒ 敌意 ctx 检查必须能判失败', () => {
  const broken = String(clientSrc).replace('function apply(ctx) {', 'function apply(ctx) { throw new Error("broken-for-fixture");')
  if (broken === clientSrc) return '篡改锚点没命中（夹具失效）'
  let mod = null
  try { mod = loadClient(broken).mod } catch (e) { return '篡改后加载就失败了：' + String((e && e.message) || e) }
  let threw = false
  try { mod.apply({}) } catch (e) { threw = true }
  return threw ? true : '篡改版居然没抛 ⇒ 检查是空转的'
})

ck('④ 必失败面：把 exports.apply 去掉 ⇒ 纯具名导出检查必须能判失败', () => {
  const broken = String(clientSrc).replace('exports.apply = apply;', '// exports.apply removed by fixture')
  if (broken === clientSrc) return '篡改锚点没命中（夹具失效）'
  const mod = loadClient(broken).mod
  return typeof mod.apply !== 'function' ? true : '去掉 apply 后仍被认为是函数 ⇒ 检查空转'
})

ck('④ 必失败面：把 SECTION_LABEL 改成别的 ⇒ 名称检查必须能判失败', () => {
  const broken = String(clientSrc).replace("var SECTION_LABEL = '论文插件外置 key 连接器';", "var SECTION_LABEL = '别的名字';")
  if (broken === clientSrc) return '篡改锚点没命中（夹具失效）'
  const mod = loadClient(broken).mod
  const regs = []
  mod.apply({ slots: { inject: (n, cb) => { cb(); return () => {} }, register: (spec, C) => { regs.push({ spec, C }); return () => {} } } })
  const label = regs.length && regs[0].spec && (typeof regs[0].spec.label === 'function' ? regs[0].spec.label() : regs[0].spec.label)
  return String(label).indexOf('论文插件外置 key 连接器') < 0 ? true : '改名字后检查仍通过 ⇒ 空转'
})

// ───────────────── ⑤ 宿主半体：加载 / 敌意 ctx / 路由 / 明文不泄露 ─────────────────

function fakeRes() {
  return {
    code: 0, headers: null, body: '',
    writeHead(c, hh) { this.code = c; this.headers = hh },
    end(s) { this.body = s == null ? '' : String(s) },
    json() { try { return JSON.parse(this.body) } catch (e) { return null } },
  }
}
function fakeReq(opts) {
  const o = opts || {}
  const reg = {}
  return {
    method: o.method || 'GET',
    headers: { origin: o.origin, host: o.host || '127.0.0.1:19387', 'content-type': 'application/json' },
    destroyed: false,
    on(ev, cb) { (reg[ev] = reg[ev] || []).push(cb) },
    destroy() { this.destroyed = true },
    flush(body) { (reg.data || []).forEach((f) => f(Buffer.from(body || '', 'utf8'))); (reg.end || []).forEach((f) => f()) },
    fail() { (reg.error || []).forEach((f) => f(new Error('socket error'))) },
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper-keys-check-'))
process.env.DSH_PAPER_KEYS_FILE = path.join(tmpDir, 'keys.json')

;(async () => {
  const hostMod = await import(pathToFileURL(HOST).href)
  ck('⑤ 宿主半体：具名导出 name/inject/apply，且 inject 含 webServer', () => {
    if (hostMod.name !== 'dsh-paper-keys') return 'name=' + hostMod.name
    if (!Array.isArray(hostMod.inject) || hostMod.inject.indexOf('webServer') < 0) return 'inject 缺 webServer'
    if (typeof hostMod.apply !== 'function') return 'apply 不是函数'
    if (hostMod.default) return '出现了 default 导出'
    return true
  })

  ck('⑤ 宿主敌意 ctx：{} / null / get 抛错 / webServer 半残 ⇒ apply 不得抛', () => {
    const cases = [
      ['{}', {}], ['null', null],
      ['get 抛错', { get() { throw new Error('boom') } }],
      ['webServer 半残', { get: () => ({ register: 'not-a-function' }) }],
      ['webServer 抛错', { get: () => ({ register() { throw new Error('boom') } }) }],
    ]
    for (const [label, ctx] of cases) {
      let ret
      try { ret = hostMod.apply(ctx) } catch (e) { return label + ' 抛了：' + String((e && e.message) || e) }
      if (typeof ret !== 'function') return label + ' 没返回释放函数'
      try { ret() } catch (e) { return label + ' 释放函数抛了' }
    }
    return true
  })

  const routes = {}
  hostMod.apply({ get: () => ({ register: (r) => { routes[r.path] = r.handler; return () => {} } }) })

  ck('⑤ 正控：六条路由都注册了，且 kind 都是 exact', () => {
    const want = ['/api/paper-keys/list', '/api/paper-keys/set', '/api/paper-keys/enable', '/api/paper-keys/disable', '/api/paper-keys/remove', '/api/paper-keys/test']
    const miss = want.filter((p) => typeof routes[p] !== 'function')
    return miss.length ? ('缺：' + miss.join(', ')) : true
  })

  await ckA('⑤ 安全：跨源请求必须 403（否则任意网页都能读写你的本机凭据文件）', async () => {
    const res = fakeRes()
    routes['/api/paper-keys/list'](fakeReq({ origin: 'https://evil.example', host: '127.0.0.1:19387' }), res)
    return (res.code === 403) ? true : ('code=' + res.code + ' body=' + res.body.slice(0, 80))
  })

  await ckA('⑤ 正控：同源 GET /list ⇒ 200 且返回 provider 列表（含掩码字段）', async () => {
    const res = fakeRes()
    routes['/api/paper-keys/list'](fakeReq({ origin: 'http://127.0.0.1:19387' }), res)
    const j = res.json()
    if (res.code !== 200 || !j) return 'code=' + res.code
    if (!Array.isArray(j.providers) || !j.providers.length) return 'providers 为空：' + JSON.stringify(j).slice(0, 120)
    if (typeof j.path !== 'string' || !j.path.length) return '没返回存储路径'
    return true
  })

  await ckA('⑤ 写操作：GET 打 /set 必须 405（写操作只接受 POST）', async () => {
    const res = fakeRes()
    routes['/api/paper-keys/set'](fakeReq({ method: 'GET', origin: 'http://127.0.0.1:19387' }), res)
    return res.code === 405 ? true : ('code=' + res.code)
  })

  await ckA('⑤ 写操作：未知 provider 必须 400（不许写进凭据文件）', async () => {
    const res = fakeRes()
    const req = fakeReq({ method: 'POST', origin: 'http://127.0.0.1:19387' })
    routes['/api/paper-keys/set'](req, res)
    req.flush(JSON.stringify({ provider: 'nope', key: PLANTED }))
    await new Promise((r) => setTimeout(r, 30))
    return res.code === 400 ? true : ('code=' + res.code + ' body=' + res.body.slice(0, 90))
  })

  await ckA('⑤ ★明文不泄露：录入后 /list 与 /set 的响应里**都不得出现完整 key**（只许掩码）', async () => {
    const res = fakeRes()
    const req = fakeReq({ method: 'POST', origin: 'http://127.0.0.1:19387' })
    routes['/api/paper-keys/set'](req, res)
    req.flush(JSON.stringify({ provider: 'deepseek', key: PLANTED, confirm_overwrite: true }))
    await new Promise((r) => setTimeout(r, 60))
    if (res.code !== 200) return '录入失败 code=' + res.code + ' body=' + res.body.slice(0, 120)
    if (res.body.indexOf(PLANTED) >= 0) return '★ /set 响应里出现了明文 key'
    const j = res.json()
    if (!j || !j.masked || j.masked.indexOf('***') < 0) return '响应里没有掩码：' + JSON.stringify(j).slice(0, 120)
    const res2 = fakeRes()
    routes['/api/paper-keys/list'](fakeReq({ origin: 'http://127.0.0.1:19387' }), res2)
    if (res2.body.indexOf(PLANTED) >= 0) return '★ /list 响应里出现了明文 key'
    const row = (res2.json().providers || []).find((x) => x.id === 'deepseek') || {}
    if (row.state !== '已连接') return '状态应为已连接，实际 ' + row.state
    if (!row.key_masked || row.key_masked.indexOf('***') < 0) return '掩码字段缺失'
    return true
  })

  await ckA('⑤ 停用：/disable 后状态变「已停用（保留）」且**凭据仍在**（掩码还看得见）', async () => {
    const res = fakeRes()
    const req = fakeReq({ method: 'POST', origin: 'http://127.0.0.1:19387' })
    routes['/api/paper-keys/disable'](req, res)
    req.flush(JSON.stringify({ provider: 'deepseek' }))
    await new Promise((r) => setTimeout(r, 60))
    if (res.code !== 200) return 'disable 失败：' + res.body.slice(0, 100)
    const row = ((res.json().view || {}).providers || []).find((x) => x.id === 'deepseek') || {}
    if (row.state !== '已停用（保留）') return '状态不对：' + row.state
    if (!row.key_masked) return '停用后掩码丢了 ⇒ 那不是"保留"'
    return true
  })

  await ckA('⑤ 删除：/remove 后回到「未录入」，且掩码清空', async () => {
    const res = fakeRes()
    const req = fakeReq({ method: 'POST', origin: 'http://127.0.0.1:19387' })
    routes['/api/paper-keys/remove'](req, res)
    req.flush(JSON.stringify({ provider: 'deepseek' }))
    await new Promise((r) => setTimeout(r, 60))
    if (res.code !== 200) return 'remove 失败：' + res.body.slice(0, 100)
    const row = ((res.json().view || {}).providers || []).find((x) => x.id === 'deepseek') || {}
    return row.state === '未录入' && !row.key_masked ? true : ('状态=' + row.state + ' mask=' + row.key_masked)
  })

  await ckA('⑤ 未接线诚实面：所有候选路径都不存在时 /list 必须 ok=false 且**不抛**（不许假装成功）', async () => {
    /* 严格隔离：把插件副本放进一个"什么都没有"的临时树，并把 HOME/USERPROFILE 也指到临时家目录，
       这样 paperRoot() 的每个候选都落空 ⇒ 才能真的走到"未接线"这条分支。
       （第一版判据写错过：本插件就在 repo 内，包内相对候选必然命中 ⇒ 那条断言前提本身是错的。） */
    const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-iso-'))
    const fakeHome = path.join(iso, 'home')
    const isoLib = path.join(iso, 'pkg', 'lib')
    fs.mkdirSync(isoLib, { recursive: true })
    fs.mkdirSync(fakeHome, { recursive: true })
    fs.copyFileSync(HOST, path.join(isoLib, 'index.js'))
    const runner = path.join(iso, 'run.cjs')
    fs.writeFileSync(runner, [
      "const { pathToFileURL } = require('node:url');",
      "const path = require('node:path');",
      "(async () => {",
      "  const m = await import(pathToFileURL(path.join(__dirname,'pkg','lib','index.js')).href);",
      "  const routes = {};",
      "  m.apply({ get: () => ({ register: (r) => { routes[r.path] = r.handler; return () => {} } }) });",
      "  const res = { code: 0, body: '', writeHead(c){this.code=c}, end(s){this.body = s==null?'':String(s)} };",
      "  const req = { method: 'GET', headers: { host: '127.0.0.1:19387' }, on(){}, destroy(){} };",
      "  routes['/api/paper-keys/list'](req, res);",
      "  process.stdout.write(JSON.stringify({ code: res.code, body: res.body }));",
      "})().catch(e => { process.stdout.write(JSON.stringify({ crash: String(e && e.message || e) })); });",
    ].join('\n'), 'utf8')
    const { spawnSync } = require('node:child_process')
    const r = spawnSync(process.execPath, [runner], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        DSH_PAPER_STUDIO_ROOT: path.join(iso, 'nope'),
        USERPROFILE: fakeHome, HOME: fakeHome,
        DSH_PAPER_KEYS_FILE: path.join(iso, 'keys.json'),
      }),
      timeout: 60000,
    })
    try { fs.rmSync(iso, { recursive: true, force: true }) } catch (e) { /* 清理失败不致命 */ }
    const out = String(r.stdout || '')
    let j = null
    try { j = JSON.parse(out) } catch (e) { return '子进程输出不可解析：' + out.slice(0, 140) + ' / stderr=' + String(r.stderr || '').slice(0, 120) }
    if (j.crash) return '子进程崩了（不许崩）：' + j.crash
    if (j.code !== 200) return 'code=' + j.code
    let body = null
    try { body = JSON.parse(j.body) } catch (e) { return '响应不是 JSON：' + String(j.body).slice(0, 120) }
    if (body.ok !== false || body.wired !== false) return '没如实报告未接线：' + String(j.body).slice(0, 140)
    if (!body.reason) return '没给出原因'
    return true
  })

  await ckA('⑤ ★同判（跨实现锁）：面板写入的 provider，CLI `studio model providers` 必须**看到同一份**并报「面板」来源', async () => {
    /* 这条是目标第③条的可执行形式：面板与 CLI 必须用同一个真源、给同一个判断。
       做法：① 用面板的 /set 写一枚 key（临时存储）② 用同一个 DSH_PAPER_KEYS_FILE 跑 CLI 的
       `model providers --json`，断言它把该 provider 报成「已连接」且来源指向面板。 */
    const { spawnSync } = require('node:child_process')
    const storeFile = path.join(tmpDir, 'same-judgment.json')
    try { fs.rmSync(storeFile, { force: true }) } catch (e) { /* noop */ }
    const env = Object.assign({}, process.env, { DSH_PAPER_KEYS_FILE: storeFile })
    /* ★ 面板是**进程内**调用：必须同时改本进程的 env，否则它写的是另一个文件（我已在这上面栽过一次） */
    const prevKeysEnv = process.env.DSH_PAPER_KEYS_FILE
    process.env.DSH_PAPER_KEYS_FILE = storeFile
    // ① 面板侧写入
    const m = await import(pathToFileURL(HOST).href + '?same=' + Date.now())
    const routes2 = {}
    m.apply({ get: () => ({ register: (r) => { routes2[r.path] = r.handler; return () => {} } }) })
    const res = fakeRes()
    const req = fakeReq({ method: 'POST', origin: 'http://127.0.0.1:19387' })
    routes2['/api/paper-keys/set'](req, res)
    req.flush(JSON.stringify({ provider: 'deepseek', key: PLANTED, confirm_overwrite: true }))
    await new Promise((r) => setTimeout(r, 60))
    if (res.code !== 200) return '面板侧写入失败：' + res.body.slice(0, 120)
    // ② CLI 侧读取（同一份文件）
    const root = path.join(PANEL, '..')
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'studio.cjs'), 'model', 'providers', '--json'], { encoding: 'utf8', env, timeout: 90000 })
    if (r.status !== 0) return 'CLI 退 ' + r.status + '：' + String(r.stderr || '').slice(0, 120)
    let j = null
    try { j = JSON.parse(String(r.stdout || '')) } catch (e) { return 'CLI 输出不是 JSON：' + String(r.stdout || '').slice(0, 120) }
    const row = (j.providers || []).find((x) => x.id === 'deepseek') || {}
    if (row.state !== '已配置') return 'CLI 没把面板录入的算作可用：state=' + row.state
    if (!/面板/.test(String(row.from))) return 'CLI 没把来源归到面板：from=' + row.from
    if (!row.panel_key_masked || row.panel_key_masked.indexOf('***') < 0) return 'CLI 侧掩码缺失'
    // ③ 反向：面板停用后，CLI 必须判「已停用」而**不是**「未配置」
    const m2 = await import(pathToFileURL(HOST).href + '?same2=' + Date.now())
    const routes3 = {}
    m2.apply({ get: () => ({ register: (rr) => { routes3[rr.path] = rr.handler; return () => {} } }) })
    const res2 = fakeRes()
    const req2 = fakeReq({ method: 'POST', origin: 'http://127.0.0.1:19387' })
    routes3['/api/paper-keys/disable'](req2, res2)
    req2.flush(JSON.stringify({ provider: 'deepseek' }))
    await new Promise((rr) => setTimeout(rr, 60))
    const r2 = spawnSync(process.execPath, [path.join(root, 'bin', 'studio.cjs'), 'model', 'providers', '--json'], { encoding: 'utf8', env, timeout: 90000 })
    let j2 = null
    try { j2 = JSON.parse(String(r2.stdout || '')) } catch (e) { return 'CLI 第二次输出不是 JSON' }
    const row2 = (j2.providers || []).find((x) => x.id === 'deepseek') || {}
    if (row2.state !== '已停用') return '面板停用后 CLI 的状态应＝已停用，实际 ' + row2.state
    if (row2.configured) return '面板停用后 CLI 不该仍算已配置'
    try { fs.rmSync(storeFile, { force: true }) } catch (e) { /* noop */ }
    if (prevKeysEnv === undefined) delete process.env.DSH_PAPER_KEYS_FILE; else process.env.DSH_PAPER_KEYS_FILE = prevKeysEnv
    return true
  })

  // ───────────────── ⑥ 视图映射（纯函数）+ 渲染冒烟（把「不白屏」变成断言）─────────────────

  ck('⑥ 视图映射：null / 空对象 / 字符串 / 无效载荷 ⇒ **绝不进 ready**（不许渲染空的就绪列表）且不抛', () => {
    const vm = loaded.mod.__paperKeys.viewModel
    for (const v of [null, undefined, {}, 'oops', 42, { ok: false, error: 'HTTP 500' }]) {
      let r
      try { r = vm(v) } catch (e) { return '抛了：' + String((e && e.message) || e) }
      if (!r || r.mode === 'ready') return '无效载荷被当成就绪：' + JSON.stringify(v).slice(0, 40)
      if (['loading', 'unavailable', 'not_wired'].indexOf(r.mode) < 0) return '未知 mode=' + r.mode
      if (!r.title) return '没给标题（用户会看到空白）'
    }
    return true
  })

  ck('⑥ 视图映射：未接线载荷 ⇒ not_wired 且必须带原因（不许静默空白）', () => {
    const vm = loaded.mod.__paperKeys.viewModel
    const r = vm({ ok: false, wired: false, reason: '找不到 paper-studio 的 bin/keys-store.cjs' })
    if (r.mode !== 'not_wired') return 'mode=' + r.mode
    return /keys-store/.test(String(r.message)) ? true : ('原因丢了：' + r.message)
  })

  ck('⑥ 视图映射：完整载荷 ⇒ 行数/状态/掩码；★停用行必须仍显示掩码（证明「保留」）', () => {
    const vm = loaded.mod.__paperKeys.viewModel
    const r = vm({
      ok: true, wired: true, path: 'C:/x/keys.json', updated_at: '2026-10-16T12:00:00Z', file_ok: true,
      providers: [
        { id: 'deepseek', label: '深度求索', present: true, enabled: true, key_masked: 'sk-***ab（长度 39）', last_test: { at: '2026-10-16T11:00:00Z', ok: true, note: '连通' } },
        { id: 'openai', label: 'OpenAI', present: true, enabled: false, key_masked: 'sk-***zz' },
        { id: 'glm', label: 'GLM', present: false },
      ],
    })
    if (r.mode !== 'ready') return 'mode=' + r.mode
    if (r.rows.length !== 3) return '行数=' + r.rows.length
    if (r.rows[0].state !== '已连接' || !/\*\*\*/.test(r.rows[0].masked)) return '第一行不对：' + JSON.stringify(r.rows[0])
    if (r.rows[0].lastTestAt !== '2026-10-16T11:00:00Z') return '上次测试时间丢了'
    if (r.rows[1].state !== '已停用（保留）') return '停用行状态=' + r.rows[1].state
    if (!/\*\*\*/.test(r.rows[1].masked)) return '★停用行必须仍显示掩码'
    if (r.rows[2].state !== '未录入' || r.rows[2].masked !== '') return '未录入行不对：' + JSON.stringify(r.rows[2])
    return true
  })

  ck('⑥ 视图映射：畸形载荷（providers 非数组 / 行是 null / 字段类型错）⇒ 降级但**绝不抛**', () => {
    const vm = loaded.mod.__paperKeys.viewModel
    const bad = [
      { ok: true, providers: 'not-an-array' },
      { ok: true, providers: [null, 7, { id: 1, key_masked: 2, last_test: 'x' }] },
      { ok: true, providers: [{}] },
    ]
    for (const v of bad) {
      let r
      try { r = vm(v) } catch (e) { return '抛了：' + String((e && e.message) || e) + ' 载荷=' + JSON.stringify(v).slice(0, 60) }
      if (!r || !Array.isArray(r.rows)) return 'rows 不是数组'
    }
    return true
  })

  ck('⑥ 渲染冒烟：组件在 loading 态（view=null）必须返回元素而非抛错（白屏的直接防线）', () => {
    const Section = loaded.mod.__paperKeys.PaperKeysSection
    if (typeof Section !== 'function') return '组件不是函数'
    let el
    try { el = Section({}) } catch (e) { return '渲染抛了：' + String((e && e.message) || e) }
    if (!el || typeof el !== 'object') return '没返回元素'
    return el.type === 'div' ? true : ('返回的 type=' + String(el.type))
  })

  // ───────────────── 汇总 ─────────────────

  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (e) { /* 清理失败不致命 */ }
  const bad = checks.filter((c) => !c.ok)
  for (const c of checks) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : ('  ← ' + c.why)))
  console.log('')
  console.log('自检：' + (checks.length - bad.length) + '/' + checks.length + ' 通过')
  process.exit(bad.length ? 1 : 0)
})()
