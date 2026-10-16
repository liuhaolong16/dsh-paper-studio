// dsh-paper-keys —— 宿主半体（Host half）
//
// 定位：面板（客户端半体）的**服务端**。面板只做 UI 与同源 fetch；凭据的读写、连通性测试都在这里做。
// 为什么单独成一个插件而不塞进 paper-studio：paper-studio 的硬承诺是「**零面板**：不注册任何客户端 Slot /
// 路由 / 前端资产 ⇒ 不会出现面板消失/白屏」（见其 SKILL.md）。把面板另立一包，卸载它不影响论文能力本体。
//
// 硬约束（用户 2026-10-16 目标）：
//   · **纯具名导出**（无 default）；`apply` 全程护栏，**任何情况下不抛**（宿主绝不能因本插件崩溃）
//   · 凭据读写走**唯一真源** `<paper-studio>/bin/keys-store.cjs`（与 CLI 同一份，绝不各写一套解析）
//   · 路由只服务同源请求；**绝不回显明文**（列表只给掩码）；写操作只接受 POST + JSON
//   · 连通性测试是**真调用**（POST /chat/completions），失败必须如实报错（不许吞成成功）
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-paper-keys'
/** 硬依赖 webServer：没有它本插件无事可做（DSH 会因此不激活，而不是崩） */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const require_ = createRequire(import.meta.url)
const MAX_BODY = 8 * 1024
const ROUTE_PREFIX = '/api/paper-keys'

// ───────────────────────── 依赖解析（多候选，缺则明确报缺，绝不抛）─────────────────────────

/** paper-studio 根：环境变量 → 包内相对（panel/lib → 仓库根）→ 用户目录标准位。 */
function paperRoot() {
  const cands = [
    process.env.DSH_PAPER_STUDIO_ROOT,
    join(HERE, '..', '..'),                                   // 同仓：<repo>/panel/lib → <repo>
    join(HERE, '..', '..', '..'),                             // 装成 node_modules/dsh-paper-keys/lib → 上一级
    process.env.USERPROFILE ? join(process.env.USERPROFILE, '.dsh', 'skills', 'paper-studio') : '',
    process.env.HOME ? join(process.env.HOME, '.dsh', 'skills', 'paper-studio') : '',
  ].filter(Boolean)
  for (const c of cands) {
    try { if (existsSync(join(c, 'bin', 'keys-store.cjs'))) return c } catch { /* 继续找 */ }
  }
  return null
}

/** 唯一真源的凭据存储（CJS，宿主半体与 CLI 共用）。拿不到就返回 null，调用方按"未接线"处理。 */
export function loadStore() {
  const root = paperRoot()
  if (!root) return null
  try { return require_(join(root, 'bin', 'keys-store.cjs')) } catch { return null }
}

/** provider 真源（名字/中文名/默认模型/端点/环境变量名），用于校验入参与显示。 */
export function loadProviders() {
  const root = paperRoot()
  if (!root) return { providers: {}, root: null }
  try {
    const j = JSON.parse(readFileSync(join(root, 'references', 'model-providers.json'), 'utf8'))
    return { providers: (j && j.providers) || {}, root: root }
  } catch { return { providers: {}, root: root } }
}

// ───────────────────────── HTTP 小工具（响应约定照抄本机既有插件）─────────────────────────

function json(res, code, obj) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch { /* 客户端已断开也要稳住 */ }
}

/** 同源校验：浏览器同源请求才放行（防别的页面/脚本跨站打到本机端口）。 */
function sameOrigin(req) {
  try {
    const origin = String((req.headers && req.headers.origin) || '')
    if (!origin) return true                                   // 非浏览器/同源 GET 无 Origin：放行（仍是本机回环）
    const host = String((req.headers && req.headers.host) || '')
    const u = new URL(origin)
    return !!host && u.host === host
  } catch { return false }
}

function readJsonBody(req, cb) {
  let body = ''
  let done = false
  req.on('data', (c) => {
    body += c.toString('utf8')
    if (body.length > MAX_BODY) { try { req.destroy() } catch { /* noop */ } }
  })
  req.on('end', () => { if (done) return; done = true; try { cb(JSON.parse(body || '{}')) } catch { cb(null) } })
  req.on('error', () => { if (!done) { done = true; cb(null) } })
}

// ───────────────────────── 面板要用的读模型（**只出掩码**）─────────────────────────

export function listView() {
  const store = loadStore()
  const { providers } = loadProviders()
  const known = Object.keys(providers)
  if (!store) {
    return { ok: false, wired: false, reason: '找不到 paper-studio 的 bin/keys-store.cjs（唯一真源）—— 面板未接线，未改动任何文件', providers: [], path: null }
  }
  const r = store.rows(known)
  return {
    ok: true,
    wired: true,
    path: r.path,
    file_ok: r.file_ok,
    file_reason: r.file_reason || null,
    updated_at: r.updated_at || null,
    providers: r.items.map((it) => ({
      id: it.id,
      label: (providers[it.id] && providers[it.id].label) || it.id,
      present: !!it.present,
      enabled: it.enabled !== false,
      state: it.present ? (it.enabled !== false ? '已连接' : '已停用（保留）') : '未录入',
      key_masked: it.key_masked && it.key_masked !== '（未录入）' ? it.key_masked : '',   // 掩码；无则空串
      base_url: (providers[it.id] && providers[it.id].base_url) || '',
      model: it.model || (providers[it.id] && providers[it.id].default_model) || '',
      last_test: it.last_test || null,
    })),
  }
}

/** 真连通性测试（OpenAI 兼容 /chat/completions）。失败如实返回，不吞错。 */
export async function testProvider(pid, key, baseUrl, model, timeoutMs) {
  const meta = loadProviders().providers[pid] || {}
  const base = String(baseUrl || meta.base_url || '').replace(/\/+$/, '')
  const m = model || meta.default_model
  const chatPath = meta.chat_path || '/chat/completions'
  if (!base || !m) return { ok: false, status: 0, error: '缺少端点或默认模型（provider 真源里应有 base_url / default_model）' }
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), Number(timeoutMs || 20000))
  try {
    const res = await fetch(base + chatPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: m, messages: [{ role: 'user', content: 'ping' }], stream: false, max_tokens: 8 }),
      signal: ctrl.signal,
    })
    const txt = await res.text()
    clearTimeout(to)
    if (!res.ok) return { ok: false, status: res.status, error: 'HTTP ' + res.status + ' ' + String(txt).slice(0, 160) }
    let j = null
    try { j = JSON.parse(txt) } catch { return { ok: false, status: res.status, error: '响应不是 JSON' } }
    const text = j && j.choices && j.choices[0] && (j.choices[0].message ? j.choices[0].message.content : j.choices[0].text)
    if (!text) return { ok: false, status: res.status, error: '响应里没有可用文本（结构不符）' }
    return { ok: true, status: res.status, model: (j && j.model) || m, text: String(text).slice(0, 60) }
  } catch (e) {
    clearTimeout(to)
    return { ok: false, status: 0, error: (e && e.name === 'AbortError') ? ('超时（' + Number(timeoutMs || 20000) + 'ms）') : String((e && e.message) || e) }
  }
}

// ───────────────────────── apply（全程护栏：绝不抛）─────────────────────────

export function apply(ctx) {
  const disposers = []
  const webServer = (() => {
    try { return (ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : (ctx && ctx.webServer)) || null } catch { return null }
  })()
  if (!webServer || typeof webServer.register !== 'function') {
    try { console.error('[paper-keys] webServer 不可用 ⇒ 本插件不注册任何路由（宿主不受影响）') } catch { /* noop */ }
    return () => {}
  }

  /** 注册一条路由：任何异常都被吞掉并只记日志（**绝不让注册失败变成宿主崩溃**）。 */
  const route = (path, handler) => {
    try {
      const d = webServer.register({ kind: 'exact', path: ROUTE_PREFIX + path, handler: handler })
      if (typeof d === 'function') disposers.push(d)
    } catch (e) {
      try { console.error('[paper-keys] 路由注册失败 ' + path + '：' + String((e && e.message) || e)) } catch { /* noop */ }
    }
  }

  // ── 读：列表（只掩码） ──
  route('/list', (req, res) => {
    try {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '仅同源请求' })
      json(res, 200, listView())
    } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
  })

  // ── 写：录入 / 启用 / 停用 / 删除（POST + JSON，provider 必须在真源里） ──
  const mutate = (action) => (req, res) => {
    try {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '仅同源请求' })
      if (String(req.method || '').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: '写操作只接受 POST' })
      readJsonBody(req, (parsed) => {
        try {
          if (!parsed || typeof parsed !== 'object') return json(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
          const store = loadStore()
          if (!store) return json(res, 503, { ok: false, error: '未接线：找不到 paper-studio 的 bin/keys-store.cjs' })
          const pid = String(parsed.provider || '')
          const { providers } = loadProviders()
          if (!pid || !providers[pid]) return json(res, 400, { ok: false, error: '未知 provider（可选：' + Object.keys(providers).join(' / ') + '）' })
          if (action === 'set') {
            const key = typeof parsed.key === 'string' ? parsed.key.trim() : ''
            if (!key) return json(res, 400, { ok: false, error: 'key 不能为空' })
            if (parsed.confirm_overwrite !== true) {
              const cur = store.rows([pid]).items.find((x) => x.id === pid)
              if (cur && cur.present) return json(res, 409, { ok: false, error: '该 provider 已录入；覆盖需要显式确认（confirm_overwrite=true）' })
            }
            const w = store.setKey(pid, { key: key, enabled: true, base_url: typeof parsed.base_url === 'string' ? parsed.base_url : '', model: typeof parsed.model === 'string' ? parsed.model : '' })
            if (!w.ok) return json(res, 500, { ok: false, error: w.reason || '写入失败' })
            return json(res, 200, { ok: true, provider: pid, masked: store.maskWithLen(key), path: w.path, view: listView() })
          }
          if (action === 'enable' || action === 'disable') {
            const w = store.setEnabled(pid, action === 'enable')
            if (!w.ok) return json(res, 400, { ok: false, error: w.reason || '操作失败' })
            return json(res, 200, { ok: true, provider: pid, enabled: w.enabled, view: listView() })
          }
          if (action === 'remove') {
            const w = store.removeKey(pid)
            if (!w.ok) return json(res, 500, { ok: false, error: w.reason || '删除失败' })
            return json(res, 200, { ok: true, provider: pid, removed: !!w.removed, view: listView() })
          }
          json(res, 400, { ok: false, error: '未知操作：' + action })
        } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
      })
    } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
  }
  route('/set', mutate('set'))
  route('/enable', mutate('enable'))
  route('/disable', mutate('disable'))
  route('/remove', mutate('remove'))

  // ── 连接：真连通性测试，并把结果记进本机（面板可见"上次测试"） ──
  route('/test', (req, res) => {
    try {
      if (!sameOrigin(req)) return json(res, 403, { ok: false, error: '仅同源请求' })
      if (String(req.method || '').toUpperCase() !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
      readJsonBody(req, (parsed) => {
        ;(async () => {
          try {
            const store = loadStore()
            if (!store) return json(res, 503, { ok: false, error: '未接线：找不到 bin/keys-store.cjs' })
            const pid = String((parsed && parsed.provider) || '')
            const { providers } = loadProviders()
            if (!pid || !providers[pid]) return json(res, 400, { ok: false, error: '未知 provider' })
            const resolved = store.resolveKey(pid, { envNames: (providers[pid].env || []) })
            if (!resolved.key) return json(res, 400, { ok: false, error: resolved.disabled ? '该 provider 在面板里被停用 ⇒ 视为不可用（先启用再测）' : '面板里未录入该 provider，且环境变量为空' })
            const out = await testProvider(pid, resolved.key, providers[pid].base_url, providers[pid].default_model, 20000)
            try {
              const doc = store.read().doc
              if (doc.providers[pid]) {
                doc.providers[pid].last_test = { at: new Date().toISOString(), ok: !!out.ok, status: Number(out.status || 0), note: out.ok ? ('连通 · ' + (out.model || '')) : String(out.error || '').slice(0, 120) }
                store.write(doc)
              }
            } catch { /* 记录失败不影响测试结论 */ }
            json(res, out.ok ? 200 : 200, { ok: !!out.ok, status: out.status || 0, from: resolved.from, error: out.ok ? null : out.error, text: out.text || null, view: listView() })
          } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
        })()
      })
    } catch (e) { json(res, 500, { ok: false, error: String((e && e.message) || e) }) }
  })

  return function dispose() {
    for (const d of disposers) { try { d() } catch { /* 释放失败也不抛 */ } }
  }
}

/** 给夹具用的纯函数出口（**只读/纯计算**，不含副作用路径）。 */
export const __keys = { paperRoot, listView, testProvider, ROUTE_PREFIX }
