#!/usr/bin/env node
/**
 * paper-studio MCP 服务器（stdio · **零依赖**）
 *
 * 为什么要有它：DSH 插件那层（`cordis.patch.yml` + `ctx.tools.register`）**只有 DSH 认**。
 * 别的宿主（Codex / Claude Code / Cursor / Cline / 任何支持 MCP 的客户端）不读 DSH bundle。
 * 而 MCP 是这些宿主**共同**的扩展口 ⇒ 把这套能力做成 MCP 服务器，一份代码到处能用。
 *
 * ★ 单一真源：本文件**不复制任何判据** —— 模式菜单、意图判据、双模式状态、白名单根、
 *   解锁原话全部从 `../dist/plugin.js` 的 `__test__` 导入；24 个子命令一律**转发给 `bin/studio.cjs`**。
 *   本文件只做三件事：讲 MCP 协议、做参数校验、把结果包成 MCP 内容块。
 *
 * 用法（在宿主里注册；不同宿主的注册命令见 ../adapters/）：
 *   node <此文件路径>
 * 协议：JSON-RPC 2.0，stdio 传输，**每行一个 JSON 消息**（MCP stdio 约定）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { __test__ } from '../dist/plugin.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const { modeMenu, classifyIntent, STUDIO_ACTIONS, readState, writeState, DEV_ROOTS, DEVELOPER_PHRASE, resolveRoot } = __test__
const SERVER = { name: 'paper-studio', version: '3.1.0' }
const PROTOCOL_FALLBACK = '2024-11-05'

// ───────────────────────────── 工具实现 ─────────────────────────────

const clip = (s, n = 30000) => { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) + `\n…（已截断，原长 ${t.length} 字符）` : t }

/** 转发给 CLI（24 个子命令） */
function runStudio(sub, args) {
  const root = resolveRoot()
  if (!root) return Promise.resolve({ ok: false, exit_code: null, stdout: '', stderr: '', note: '找不到 paper-studio 根：设 DSH_PAPER_STUDIO_ROOT，或把 paper-studio 放到 ~/.agents/skills/paper-studio' })
  const cli = join(root, 'bin', 'studio.cjs')
  if (!existsSync(cli)) return Promise.resolve({ ok: false, exit_code: null, stdout: '', stderr: '', note: '缺少 bin/studio.cjs：' + cli })
  return new Promise((done) => {
    const p = spawn(process.execPath, [cli, sub, ...(args || [])], { cwd: root, windowsHide: true })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => done({ ok: false, exit_code: null, stdout: '', stderr: String(e.message || e), note: 'CLI 启动失败' }))
    p.on('close', (code) => done({ ok: code === 0, exit_code: code, stdout: clip(out), stderr: clip(err), note: `$ node bin/studio.cjs ${sub} ${(args || []).join(' ')}`.trim() }))
  })
}

async function toolStudio(a) {
  const action = String((a && a.action) || '')
  if (!STUDIO_ACTIONS.includes(action)) return { ok: false, action, note: `前提层错误：未知 action「${action}」；合法值：${STUDIO_ACTIONS.join('/')}` }
  if (action === 'modes') return { ok: true, action, menu: modeMenu() }
  if (action === 'intent') {
    const j = classifyIntent(a.text)
    return { ok: true, action, note: j.reason + (j.need_clarify ? ' ⇒ **先问一句再决定**（不猜）' : '') + '\n```json\n' + JSON.stringify(j, null, 2) + '\n```' }
  }
  return Object.assign({ action }, await runStudio(action, a.args))
}

async function toolDev(a) {
  const action = String((a && a.action) || '')
  const st = readState()
  const guide = st.sealed ? `（要改插件自带内容，请让用户明确说「${DEVELOPER_PHRASE}」）` : ''
  if (action === 'status') return { ok: true, sealed: st.sealed, action, note: st.sealed ? '当前：**用户模式**（封闭）' : '当前：**开发者模式**（已解锁）' }
  if (action === 'seal') { writeState({ sealed: true, unlock_phrase: '' }); return { ok: true, sealed: true, action, note: '已重新封闭（用户模式）' } }
  if (action === 'unlock') {
    const phrase = String((a && a.phrase) || '')
    if (phrase !== DEVELOPER_PHRASE) return { ok: false, sealed: true, action, note: `解锁失败：需要用户的明确原话「${DEVELOPER_PHRASE}」` }
    writeState({ sealed: false, unlock_phrase: phrase })
    return { ok: true, sealed: false, action, note: '已进入开发者模式，可 list/read/write 白名单资产' }
  }
  if (action === 'list') {
    const listing = []
    for (const r of DEV_ROOTS) {
      const base = isAbsolute(r) ? r : join(resolveRoot() || HERE, r)
      if (!existsSync(base)) continue
      for (const f of walk(base)) listing.push({ path: f })
    }
    return { ok: true, sealed: st.sealed, action, listing, note: `共 ${listing.length} 个资产（白名单根：${DEV_ROOTS.join(' · ')}）` }
  }
  if (action === 'read' || action === 'write') {
    const rel = String((a && a.path) || '')
    if (!rel) return { ok: false, sealed: st.sealed, action, note: '前提层错误：read/write 需要 path' }
    const root = resolveRoot() || HERE
    const roots = DEV_ROOTS.map((r) => (isAbsolute(r) ? r : join(root, r)))
    const cand = isAbsolute(rel) ? rel : join(root, rel)
    const abs = resolve(cand)
    const inside = roots.some((r) => { const rr = resolve(r); return abs === rr || abs.startsWith(rr + (rr.endsWith('\\') ? '' : '\\')) })
    if (!inside) return { ok: false, sealed: st.sealed, action, note: `拒收：「${rel}」不在白名单资产根内（或试图越界）` }
    if (action === 'read') {
      try { return { ok: true, sealed: st.sealed, action, content: clip(readFileSync(abs, 'utf8'), 20000), note: `读到 ${rel}` } }
      catch (e) { return { ok: false, sealed: st.sealed, action, note: '读失败：' + String(e.message || e) } }
    }
    if (st.sealed) return { ok: false, sealed: true, action, note: `**用户模式：写入被拒**（插件自带内容只读）${guide}` }
    try { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, String(a.content), 'utf8'); return { ok: true, sealed: false, action, written: rel, note: `已写入 ${rel}` } }
    catch (e) { return { ok: false, sealed: st.sealed, action, note: '写失败：' + String(e.message || e) } }
  }
  return { ok: false, sealed: st.sealed, action, note: `前提层错误：未知 action「${action}」` }
}
function walk(dir) {
  const out = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents = []
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) { if (e.name === 'node_modules' || e.name === '.git') continue; const p = join(d, e.name); if (e.isDirectory()) stack.push(p); else out.push(p) }
  }
  return out
}

/** ★ 宿主中立的「目标/进度」机制：宿主没有原生目标工具时，用它把长任务顶住（见 adapters/ 与 SKILL.md §2.1） */
async function toolProgress(a) {
  const action = String((a && a.action) || 'read')
  const target = a && a.path ? resolve(String(a.path)) : join(process.cwd(), 'PROGRESS.md')
  if (action === 'read') {
    if (!existsSync(target)) return { ok: true, action, path: target, exists: false, note: '还没有进度文件。用 action=update 建一份（阶段/已完成/下一步/阻塞）。' }
    return { ok: true, action, path: target, exists: true, content: clip(readFileSync(target, 'utf8'), 20000) }
  }
  if (action === 'update' || action === 'append') {
    const text = String((a && a.text) || '')
    if (!text.trim()) return { ok: false, action, path: target, note: '前提层错误：update/append 需要 text' }
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
    mkdirSync(dirname(target), { recursive: true })   // ★ 两个分支都要建目录（实测 append 漏了 ⇒ ENOENT）
    if (action === 'update') { writeFileSync(target, text, 'utf8') }
    else {
      const head = '# 进度（宿主中立的持久目标替代物）\n\n> 每轮**先读**本文件再干活，**干完追加**一行；只有这样长任务才不会每步停下等人催。\n'
      const cur = existsSync(target) ? readFileSync(target, 'utf8') : head
      writeFileSync(target, cur.replace(/\s*$/, '') + `\n\n## ${stamp}\n` + text + '\n', 'utf8')
    }
    return { ok: true, action, path: target, note: `${action === 'update' ? '已写入' : '已追加'} ${target}` }
  }
  return { ok: false, action, path: target, note: `前提层错误：未知 action「${action}」（read/update/append）` }
}

const TOOLS = [
  {
    name: 'paper_studio',
    description: '论文方案执行入口（宿主中立版）：action=modes 取五模式菜单；action=intent 做确定性意图判定；其余 action 转发给 paper-studio 的 24 个子命令（route/gates/intake/draft/scaffold/genre/sections/verify/stylecheck/polish/revise/figures/profile/coach/audit/state/lessons/method/handoff/crosscheck/docx/selftest）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: STUDIO_ACTIONS, description: '要执行的动作' },
        text: { type: 'string', description: 'action=intent 时要判定的用户原话' },
        args: { type: 'array', items: { type: 'string' }, description: '转发给 CLI 的附加参数（如 ["--genre","review","--out","D:\\\\run\\\\x"]）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: toolStudio,
  },
  {
    name: 'paper_dev',
    description: '论文插件的双模式管理：status/list/read/write/unlock/seal。默认**用户模式（封闭）**，写入被拒；只有用户明确说出开发者口令才能解锁（进入后也只允许改白名单资产）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'list', 'read', 'write', 'unlock', 'seal'] },
        path: { type: 'string', description: 'read/write 的相对路径（限白名单资产根内）' },
        content: { type: 'string', description: 'write 的正文' },
        phrase: { type: 'string', description: 'unlock 时用户的明确原话' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: toolDev,
  },
  {
    name: 'paper_progress',
    description: '宿主中立的「持久目标/进度」：长任务（写论文、跑门、补声明）用它在磁盘上留一份阶段账。**每轮先 read、干完 append**，这样即使宿主没有原生目标工具，也不会每步停下等人催。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'update', 'append'], description: 'read=读当前进度；update=整篇替换（首次建立用）；append=追加本轮进展' },
        path: { type: 'string', description: '进度文件路径，默认当前目录的 PROGRESS.md' },
        text: { type: 'string', description: 'update/append 的正文（建议四段：阶段/已完成/下一步/阻塞）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: toolProgress,
  },
]

// ───────────────────────────── MCP 协议（stdio · 一行一消息）─────────────────────────────

const send = (msg) => { try { process.stdout.write(JSON.stringify(msg) + '\n') } catch { /* 对端已关 */ } }
const ok = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

async function dispatch(msg) {
  const { id, method, params } = msg || {}
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_FALLBACK,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER,
      instructions: '论文方案（paper-studio）宿主中立入口。要写论文时：先用 paper_studio action=intent 判意图，再用 action=modes 取五模式菜单（用宿主的可点击选项呈现给用户）；选定后**先建持久目标**（宿主原生目标工具，或 paper_progress），再逐轮推进、不要在阶段之间停下等用户催。',
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'ping') return ok(id, {})
  if (method === 'tools/list') return ok(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) })
  if (method === 'resources/list') return ok(id, { resources: [] })
  if (method === 'prompts/list') return ok(id, { prompts: [] })
  if (method === 'tools/call') {
    const name = params && params.name
    const t = TOOLS.find((x) => x.name === name)
    if (!t) return fail(id, -32602, '未知工具：' + name)
    try {
      const value = await t.handler((params && params.arguments) || {})
      const text = value && value.menu ? JSON.stringify(value.menu, null, 2) : value && value.listing ? JSON.stringify(value.listing, null, 2) : (value && (value.content || value.note || value.stdout)) ? [value.note, value.content, value.stdout, value.stderr].filter(Boolean).join('\n') : JSON.stringify(value, null, 2)
      return ok(id, { content: [{ type: 'text', text: clip(text, 60000) }], isError: !(value && value.ok !== false) })
    } catch (e) { return ok(id, { content: [{ type: 'text', text: '工具执行失败：' + String((e && e.message) || e) }], isError: true }) }
  }
  if (id !== undefined) return fail(id, -32601, '未实现的方法：' + method)
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg = null
    try { msg = JSON.parse(line) } catch (e) {
      // ★ 静默跳过不合法行是协议要求（对端可能发非 JSON 噪声），但**必须**留一条 stderr 便于排查：
      //   实测踩过——客户端把 Windows 路径的反斜杠没转义，JSON 非法，表现却是"某个调用没回包"，很难查。
      try { process.stderr.write('[paper-studio-mcp] 跳过非法 JSON 行（' + String((e && e.message) || e) + '）：' + line.slice(0, 160) + '\n') } catch { /* ignore */ }
      continue
    }
    Promise.resolve(dispatch(msg)).catch((e) => { if (msg && msg.id !== undefined) fail(msg.id, -32603, String((e && e.message) || e)) })
  }
})
process.stdin.on('end', () => process.exit(0))
