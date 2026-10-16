#!/usr/bin/env node
/**
 * selftest — 论文插件 V3 的自检（**不依赖宿主**：用 mock ctx 直接跑注册与行为）
 *
 * 为什么必须自带：规格里的两条硬要求是**可被证伪的**——
 *   ① **用户模式必须真封闭**（对内置文件的写入要**真的被拒**，否则是假封闭）；
 *   ② **五种模式必须行为差异化**（不是措辞差异）。
 * 这两条只能靠夹具证明，不能靠声明。
 *
 * 用法：node plugin/selftest.cjs
 * 退出码：0 全过 · 1 有失败
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')                       // paper-studio 根
const schemaCheck = require(join(ROOT, 'bin', 'schema-check.cjs'))

const results = []
const flakes = []   // ★ 偶发必须**可见**（不许隐藏）：重试后才通过的项记在这里，末尾显形
const check = (name, fn) => {
  try { const r = fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }) }
  catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }) }
}

// hub 落到临时目录，别动真实状态
const tmpHub = join(process.env.TEMP || process.env.TMP || '/tmp', 'paper-plugin-selftest-' + Date.now())
process.env.DSH_PAPER_HUB = tmpHub

const mod = await import(pathToFileURL(join(HERE, 'dist', 'plugin.js')).href)
const regs = []
const ctx = { tools: { register: (d) => { regs.push(d); return () => {} } }, on: () => {} }
mod.apply(ctx)

const T = (n) => regs.find((d) => d.name === n)
const studio = T('paper_studio')
const dev = T('paper_dev')

// ── 注册形态 ──
check('★ 正控 · 插件出口形态：name / inject=[tools] / apply 三者齐', () =>
  (mod.name === 'dsh-paper-studio-v3' && Array.isArray(mod.inject) && mod.inject.includes('tools') && typeof mod.apply === 'function') ? true : JSON.stringify({ name: mod.name, inject: mod.inject }))

check('★ 正控 · 恰好注册两个工具，且不注册任何面板/路由（规格：不要面板）', () => {
  const names = regs.map((r) => r.name).sort().join(',')
  return (regs.length === 2 && names === 'paper_dev,paper_studio') ? true : JSON.stringify(regs.map((r) => r.name))
})

// ── 兼容性硬项：用**本仓自己的** schema-check 交叉校验 parameters ──
check('★★ 兼容性硬项 · 两个工具的 parameters 都通过 schema-check 的严格校验（防 400 / 防"换模型才报错"）', () => {
  const bad = []
  for (const r of regs) {
    const v = schemaCheck.validateToolSchema(r.name, r.parameters)
    if (v.problems.length) bad.push(r.name + ': ' + v.problems.map((p) => p.rule).join('/'))
  }
  return bad.length === 0 ? true : bad.join(' | ')
})

check('★ 正控 · 每个工具都有 output.schema（object）与 render 函数（宿主契约要求）', () => {
  const bad = regs.filter((r) => !(r.output && r.output.schema && r.output.schema.type === 'object' && typeof r.output.render === 'function'))
  return bad.length === 0 ? true : bad.map((r) => r.name).join(',')
})

// ── 用户模式必须真封闭 ──
check('★★ 正控 · 默认是**用户模式**（封闭），且状态文件读不到时也按封闭处理', () => {
  const st = mod.__test__.readState()
  return st.sealed === true ? true : JSON.stringify(st)
})

// ── 行为断言（异步）──
const asyncChecks = []
asyncChecks.push(['★★ 正控 · 用户模式下 write 被拒，且目标文件**内容未变**（真封闭）', async () => {
  const target = join(ROOT, 'references', 'pipeline.json')
  const before = readFileSync(target, 'utf8').length
  const r = await dev.execute({ action: 'write', path: 'references/pipeline.json', content: 'X' })
  const after = readFileSync(target, 'utf8').length
  const ok = r.ok === false && r.sealed === true && /用户模式/.test(r.note) && /进入论文插件开发者模式/.test(r.note) && before === after
  return ok ? true : JSON.stringify({ ok: r.ok, sealed: r.sealed, note: r.note, before, after })
}])

asyncChecks.push(['★★ 正控 · **意图等价**可解锁：只说「进入开发者模式」也放行，且回显识别依据（2026-10-16 用户裁定）', async () => {
  const un = await dev.execute({ action: 'unlock', phrase: '进入开发者模式' })
  const st = mod.__test__.readState()
  const okForm = /意图等价/.test(String(un.note))
  const r1 = (un.ok === true && un.sealed === false && st.sealed === false && okForm) ? true : JSON.stringify({ un, st })
  await dev.execute({ action: 'seal' })
  return r1
}])

asyncChecks.push(['★ 必失败 · 与本意图无关的话仍不解锁（原话不符且不含「开发者模式」）', async () => {
  const bad = await dev.execute({ action: 'unlock', phrase: '帮我看看插件' })
  const st = mod.__test__.readState()
  return (bad.ok === false && st.sealed === true && /开发者模式/.test(String(bad.note))) ? true : JSON.stringify({ bad, st })
}])

asyncChecks.push(['★ 必失败 · 越界路径（../ 穿越）一律拒收，且与模式无关（先判安全再判模式）', async () => {
  const r = await dev.execute({ action: 'read', path: '../../Windows/System32/drivers/etc/hosts' })
  return (r.ok === false && /拒收|白名单/.test(r.note)) ? true : JSON.stringify(r)
}])

asyncChecks.push(['★ 必失败 · unlock 必须用约定原话；错话不解锁', async () => {
  const bad = await dev.execute({ action: 'unlock', phrase: '随便解锁一下' })
  const st1 = mod.__test__.readState()
  return (bad.ok === false && st1.sealed === true) ? true : JSON.stringify({ bad, st1 })
}])

asyncChecks.push(['★★ 正控 · 正确原话可解锁；解锁后 write 生效（写入临时资产再清理）', async () => {
  const un = await dev.execute({ action: 'unlock', phrase: mod.__test__.DEVELOPER_PHRASE })
  if (!un.ok || un.sealed !== false) return '解锁失败：' + JSON.stringify(un)
  const p = 'references/_selftest-tmp.md'
  const w = await dev.execute({ action: 'write', path: p, content: '# selftest temp\n' })
  const exists = existsSync(join(ROOT, p))
  const rd = await dev.execute({ action: 'read', path: p })
  try { rmSync(join(ROOT, p)) } catch { /* 清理失败不判失败，但下面 exists 会报 */ }
  const gone = !existsSync(join(ROOT, p))
  return (w.ok === true && w.sealed === false && exists && /selftest temp/.test(rd.content) && gone) ? true : JSON.stringify({ w, exists, gone })
}])

asyncChecks.push(['★ 正控 · 写入之后可重新封闭（seal）', async () => {
  const s = await dev.execute({ action: 'seal' })
  const st = mod.__test__.readState()
  return (s.ok === true && st.sealed === true) ? true : JSON.stringify({ s, st })
}])

asyncChecks.push(['★ 正控 · list 按分类列出资产（含唯一真源 pipeline.json 与一句话说明）', async () => {
  const r = await dev.execute({ action: 'list' })
  const hit = (r.listing || []).find((x) => /references\/pipeline\.json$/.test(x.path))
  return (r.ok && r.listing.length > 10 && hit && /唯一真源/.test(hit.what)) ? true : JSON.stringify({ n: (r.listing || []).length, hit })
}])

// ── 五种模式必须差异化 ──
asyncChecks.push(['★★ 正控 · modes 返回恰好 5 个模式，每项都有一行小字解释（给用户看）', async () => {
  const r = await studio.execute({ action: 'modes' })
  const m = (r.menu && r.menu.options) || []
  const ok = r.ok && m.length === 5 && m.every((x) => x.label && x.description && x.description.length >= 10)
  return ok ? true : JSON.stringify(m)
}])

asyncChecks.push(['★★ 正控 · 五个模式的**行为差异**两两不同（杜绝假选择），且写明了「怎么呈现」用 ask_user_question', async () => {
  const r = await studio.execute({ action: 'modes' })
  const d = ((r.menu && r.menu.differentiation) || []).map((x) => x.行为差异)
  const uniq = new Set(d)
  const ok = d.length === 5 && uniq.size === 5 && /ask_user_question/.test(r.menu.how_to_show)
  return ok ? true : JSON.stringify({ n: d.length, uniq: uniq.size, how: r.menu && r.menu.how_to_show })
}])

asyncChecks.push(['★★ 正控 · 全代写模式只问 4 项（作者三件套 + 方向/目标）；辅助创作模式问 4 项且**不产出正文**', async () => {
  const full = mod.__test__.MODES.find((m) => m.key === 'full')
  const assist = mod.__test__.MODES.find((m) => m.key === 'assist')
  const okFull = full.next_ask.length === 4 && /不再弹选项直接开写/.test(full.behavior) && /进不了实验室/.test(full.behavior)
  const okAssist = /不产出正文/.test(assist.behavior)
  return (okFull && okAssist) ? true : JSON.stringify({ full: full.next_ask.length, okFull, okAssist })
}])

// ── 真机冒烟抓到的坑：返回值必须是 lossless JSON（undefined/函数/NaN 都会让整次调用失败）──
asyncChecks.push(['★★ 正控（真机抓到的坑）· output.presentationMeta / render 的返回值必须能无损 JSON 往返', async () => {
  const samples = [
    await studio.execute({ action: 'modes' }),                                   // 无 exit_code 的路径（当年就栽在这）
    await studio.execute({ action: 'route', args: ['体检'] }),                    // 有 exit_code 的路径
    await dev.execute({ action: 'status' }),
  ]
  const lossless = (x) => {          // 缺键 vs undefined 视为不同 ⇒ 能抓出 undefined
    const round = JSON.parse(JSON.stringify(x))
    const keys = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o).sort().join(',') : '')
    return keys(round) === keys(x) && !JSON.stringify(x).includes('undefined')
  }
  const bad = []
  for (const tool of regs) {
    for (const v of samples) {
      if (typeof tool.output.render === 'function') {
        const blocks = tool.output.render({}, v)
        if (!Array.isArray(blocks) || !blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string')) bad.push(tool.name + '.render')
      }
      if (typeof tool.output.presentationMeta === 'function') {
        const meta = tool.output.presentationMeta({}, v)
        if (!lossless(meta)) bad.push(tool.name + '.presentationMeta(' + JSON.stringify(meta) + ')')
      }
      if (!lossless(v)) bad.push(tool.name + '.value')
    }
  }
  return bad.length === 0 ? true : bad.join(' | ')
}])

// ── 意图判断（规格硬要求：该启不启 / 不该启误启都要有夹具）──
asyncChecks.push(['★★ 正控 · **意图判据的夹具全过**（该启 / 不该启 / 拿不准 三类）', async () => {
  const bad = []
  for (const c of mod.__test__.INTENT_CASES) {
    const r = mod.__test__.classifyIntent(c.text)
    const got = r.is_paper ? 'paper' : (r.need_clarify ? 'clarify' : 'not')
    if (got !== c.expect) bad.push(`「${c.text}」期望 ${c.expect} 实得 ${got}（score=${r.score}）`)
  }
  return bad.length === 0 ? true : bad.join(' | ')
}])

// 判定结果走 `note`（字符串 + JSON 代码块），因为 `additionalProperties:false` 下新增字段要等模块重新导入才生效。
// 这个读取器是**唯一**取判定的方式 —— 夹具与实现必须同步，否则就是"声明 vs 实现"不一致。
const judgeOf = (r) => {
  const m = String((r && r.note) || '').match(/```json\s*([\s\S]*?)```/)
  return m ? JSON.parse(m[1]) : null
}

asyncChecks.push(['★ 反控 · 空输入不得被当成论文请求（也不得当成"确定不是"，而要问）', async () => {
  const r = await studio.execute({ action: 'intent', text: '' })
  const j = judgeOf(r)
  return (r.ok === true && j && j.is_paper === false && j.need_clarify === true) ? true : JSON.stringify({ note: r.note, parsed: j })
}])

asyncChecks.push(['★ 正控 · action=intent 经工具路径也可用（含判定理由，供模型解释给用户）', async () => {
  const r = await studio.execute({ action: 'intent', text: '帮我写论文' })
  const j = judgeOf(r)
  return (r.ok === true && j && j.is_paper === true && /强触发/.test(j.reason)) ? true : JSON.stringify({ note: r.note, parsed: j })
}])

// ── 启动安全（重启前必须过：插件抛错会把宿主界面带崩）──
asyncChecks.push(['★★ 正控（宿主中立）· 目标/自动推进机制**不得写死某一宿主的专有 API**（必须有自带兜底与宿主矩阵）', async () => {
  // 反面案例：早期版本把 autonomy.first 写成「调宿主的 create_goal」——那是 DSH 专有，
  //   下载插件的 Codex / Claude Code 用户拿到就是死指令。夹具据此看守措辞。
  const r = await studio.execute({ action: 'modes' })
  const a = ((r && r.menu) || {}).autonomy || {}
  const first = String(a.first || '')
  const hosts = a.hosts || {}
  const bad = []
  if (!/paper_progress|PROGRESS\.md/.test(first)) bad.push('autonomy.first 没有中立兜底（paper_progress / PROGRESS.md）')
  if (!hosts.dsh && !/DSH/i.test(first)) bad.push('未说明 DSH 用什么')
  if (!hosts.codex) bad.push('hosts 缺 codex（Codex 用户也要有目标机制）')
  if (!hosts.claude_code) bad.push('hosts 缺 claude_code')
  if (!/paper_progress/.test(String(hosts.mcp_any || ''))) bad.push('hosts.mcp_any 未指向本插件自带的 paper_progress')
  if (!/PROGRESS\.md/.test(String(hosts.none || ''))) bad.push('hosts.none 未给出纯文件兜底')
  if (!/催/.test(String(a.why || ''))) bad.push('autonomy.why 未写反面案例')
  if (!/每一轮|逐轮/.test(String(a.then || ''))) bad.push('autonomy.then 未写明逐轮推进')
  return bad.length === 0 ? true : bad.join(' | ')
}])

// ── 跨宿主安装器：合并必须安全（不许吃掉别人配置），且自检不能是空的 ──
asyncChecks.push(['★★ 正控（跨宿主）· install-mcp 的合并：原有条目一条不少 + 幂等 + 可移除 + 报告的真实性', async () => {
  const inst = join(HERE, 'adapters', 'install-mcp.cjs')
  if (!existsSync(inst)) return '缺 adapters/install-mcp.cjs'
  const dir = join(tmpdir(), 'ps-mcpinst-' + Date.now())
  const cfg = join(dir, 'mcp.json')
  mkdirSync(dir, { recursive: true })
  const seed = { mcpServers: { alpha: { command: 'x', args: ['1'] }, beta: { command: 'y', args: [] }, gamma: { command: 'z', args: [] } } }
  writeFileSync(cfg, JSON.stringify(seed, null, 2) + '\n', 'utf8')
  const run = (extra) => spawnSync(process.execPath, [inst, '--host', 'trae-cn', '--config', cfg, ...extra], { encoding: 'utf8', timeout: 60000 })
  const bad = []
  const r1 = run([])
  const out1 = String(r1.stdout || '')
  // ① 报告必须说"原有 3 条完好"（若实现拿被改动的对象自比，会报 4 ⇒ 这条立刻红）
  if (!/原有 3 条完好/.test(out1)) bad.push('报告未如实反映原有条目数（期望"原有 3 条完好"）：' + out1.replace(/\s+/g, ' ').slice(0, 160))
  const after1 = JSON.parse(readFileSync(cfg, 'utf8'))
  const keys = Object.keys(after1.mcpServers).sort()
  for (const k of ['alpha', 'beta', 'gamma']) if (!keys.includes(k)) bad.push('原有条目被吃掉：' + k)
  if (!keys.includes('paper-studio')) bad.push('没装上 paper-studio')
  if (JSON.stringify(after1.mcpServers.alpha) !== JSON.stringify(seed.mcpServers.alpha)) bad.push('原有条目内容被改动（alpha）')
  // ② 幂等
  const r2 = run([])
  if (!/noop/.test(String(r2.stdout || ''))) bad.push('重复运行不幂等')
  // ③ 移除：只删自己那一条
  const r3 = run(['--remove'])
  const after3 = JSON.parse(readFileSync(cfg, 'utf8'))
  const keys3 = Object.keys(after3.mcpServers)
  if (keys3.includes('paper-studio')) bad.push('--remove 没删掉自己的条目')
  if (keys3.length !== 3) bad.push('--remove 误伤其它条目：' + keys3.join(','))
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  return bad.length === 0 ? true : bad.join(' | ')
}])

// ── 交付后成本总结（cost）：工具侧、CLI 侧、schema 枚举三处都得通 ──
asyncChecks.push(['★★ 正控 · cost 子命令（交付后成本总结）经插件与 CLI 都可跑，且 schema 枚举放行', async () => {
  if (!mod.__test__.STUDIO_ACTIONS.includes('cost')) return 'STUDIO_ACTIONS 里没有 cost'
  // ① schema 的 action 枚举必须含 cost —— 否则宿主会在**调用前**按 schema 拒掉（真事故：intent 那次）
  const enumList = (studio.parameters && studio.parameters.properties && studio.parameters.properties.action && studio.parameters.properties.action.enum) || []
  if (!enumList.includes('cost')) return 'paper_studio 的 action 枚举里没有 cost（宿主会按 schema 拒调用）'
  // ② 经插件真跑一次 cost 的自检（走 CLI 桥接）
  const r = await studio.execute({ action: 'cost', args: ['--selftest'] })
  if (!r || r.exit_code !== 0) return 'cost --selftest 经插件失败：' + JSON.stringify(r).slice(0, 300)
  if (!/10\/10/.test(String(r.stdout || ''))) return 'cost 自检输出里没有 10/10：' + String(r.stdout || '').slice(0, 200)
  // ③ 失败面：给一个不存在的文件 ⇒ 必须**非 0 退出**（不能静默"成功"）
  const r2 = await studio.execute({ action: 'cost', args: ['--file', join(tmpdir(), 'dsh-no-such-' + Date.now(), 'nope.jsonl.zstd')] })
  if (!r2 || r2.exit_code === 0) return '给不存在的文件竟然退出码 0（静默成功）'
  return true
}])

// ── 跨宿主适配：MCP 服务器必须真能握手与调用（否则"支持 Codex"就是空话）──
asyncChecks.push(['★★ 正控（跨宿主）· MCP 服务器真握手：initialize + tools/list 三工具 + paper_progress 往返', async () => {
  const srv = join(HERE, 'bin', 'mcp-server.mjs')
  if (!existsSync(srv)) return '缺 bin/mcp-server.mjs（跨宿主入口）'
  const probeDir = join(tmpdir(), 'ps-mcp-' + Date.now())
  const prog = join(probeDir, 'PROGRESS.md').replace(/\\/g, '/')
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'paper_studio', arguments: { action: 'intent', text: '帮我写论文' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'paper_progress', arguments: { action: 'append', path: prog, text: '阶段：夹具' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'paper_progress', arguments: { action: 'read', path: prog } } }),
  ].join('\n') + '\n'
  const r = spawnSync(process.execPath, [srv], { input: lines, encoding: 'utf8', timeout: 60000 })
  const bad = []
  if (r.status !== 0) bad.push('退出码 ' + r.status + ' err=' + String(r.stderr || '').slice(0, 200))
  const got = String(r.stdout || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  const by = (id) => got.find((m) => m.id === id)
  if (!(by(1) && by(1).result && by(1).result.serverInfo)) bad.push('initialize 无 serverInfo')
  const tools = (by(2) && by(2).result && by(2).result.tools) || []
  const names = tools.map((t) => t.name).sort().join(',')
  if (names !== 'paper_dev,paper_progress,paper_studio') bad.push('tools/list = ' + names)
  if (!tools.every((t) => t.inputSchema && t.inputSchema.type === 'object')) bad.push('有工具缺 inputSchema')
  if (!/is_paper/.test(JSON.stringify(by(3) || {}))) bad.push('paper_studio intent 经 MCP 不可用')
  if (!(by(4) && /已追加|已写入/.test(JSON.stringify(by(4))))) bad.push('paper_progress append 失败：' + JSON.stringify(by(4) || {}).slice(0, 200))
  if (!(by(5) && /阶段：夹具/.test(JSON.stringify(by(5))))) bad.push('paper_progress read 没读回刚写的内容')
  try { rmSync(probeDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
  return bad.length === 0 ? true : bad.join(' | ')
}])

asyncChecks.push(['★★ 正控（冷启动）· 在**全新子进程**里 import + apply（模拟宿主启动加载），不得抛错且注册 2 个工具', async () => {
  const probe = join(tmpdir(), 'ps-coldstart-' + Date.now() + '.mjs')
  writeFileSync(probe, `
    process.env.DSH_PAPER_HUB = process.env.DSH_PAPER_HUB || ''
    const m = await import('file:///${join(HERE, 'dist', 'plugin.js').replace(/\\/g, '/')}')
    const regs = []
    m.apply({ tools: { register: (d) => regs.push(d) }, on: () => {} })
    if (regs.length !== 2) { console.log('BAD:注册数=' + regs.length); process.exit(1) }
    console.log('OK:冷启动通过，注册 ' + regs.length + ' 个工具')
  `, 'utf8')
  try {
    const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', env: { ...process.env, DSH_PAPER_HUB: tmpHub }, timeout: 60000 })
    const ok = r.status === 0 && /OK:冷启动通过/.test(String(r.stdout || ''))
    return ok ? true : JSON.stringify({ status: r.status, out: String(r.stdout || '').slice(0, 200), err: String(r.stderr || '').slice(0, 300) })
  } finally { try { rmSync(probe, { force: true }) } catch { /* 忽略 */ } }
}])

asyncChecks.push(['★★ 正控（必失败面）· 敌意/残缺 ctx 下 apply **不得抛错**（只降级为"本插件不工作"）', async () => {
  const hostile = [
    { tools: { register() { throw new Error('register 炸了') } }, on() { throw new Error('on 炸了') } },
    {},                                   // 完全没有 tools
    { tools: {} },                        // 有 tools 但没有 register
    { tools: { register: () => {} } },    // 没有 on
  ]
  const thrown = []
  for (const [i, c] of hostile.entries()) {
    try { mod.apply(c) } catch (e) { thrown.push('#' + i + '：' + String((e && e.message) || e)) }
  }
  return thrown.length === 0 ? true : thrown.join(' | ')
}])

// ── 出厂卫生（真机事故换来的：BOM 让宿主 manifest 解析失败 ⇒ 整个 bundle 被静默跳过）──
asyncChecks.push(['★★ 正控（真机事故）· 交付文件不得带 UTF-8 BOM，且每个 JSON 必须能被严格 JSON.parse', async () => {
  // 事故复盘（2026-10-14 重启后实证）：`plugin/package.json` 被某次
  //   PowerShell `Set-Content -Encoding UTF8` 写入了 BOM（\uFEFF）；
  //   宿主诊断原话：`Unexpected token '﻿', "﻿{\n  \"name\"... is not valid JSON"`；
  //   后果：**manifest 读取失败 ⇒ 该 bundle 被静默跳过（skippedBundles）** ⇒ 工具一个都不注册、界面不崩。
  //   注意 `JSON.parse` 对 BOM **不宽容**（会抛），所以本夹具天然能拦住它。
  const root = join(HERE, '..')
  const files = [
    'plugin/package.json', 'plugin/cordis.patch.yml', 'plugin/tools-manifest.json',
    'plugin/skill/SKILL.md', 'plugin/README.md', 'plugin/hub/README.md',
    'plugin/dist/plugin.js', 'plugin/selftest.mjs',
    // ★ 跨宿主入口也必须在守卫范围内（否则新加的文件没人管 BOM）
    'plugin/bin/mcp-server.mjs', 'plugin/adapters/install-mcp.cjs',
    'plugin/adapters/install-codex.cjs', 'plugin/adapters/README.md',
    'references/pipeline.json', 'references/templates.json',
    'package.json', 'README.md', 'CHANGELOG.md', 'NOTICE.md', 'SKILL.md',
  ]
  const bom = []
  const parseFail = []
  for (const rel of files) {
    const p = join(root, rel)
    if (!existsSync(p)) continue
    const buf = readFileSync(p)
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom.push(rel)
    if (rel.endsWith('.json')) { try { JSON.parse(readFileSync(p, 'utf8')) } catch (e) { parseFail.push(rel + ' → ' + e.message) } }
  }
  const pj = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  const patchRel = pj && pj.dsh && pj.dsh.bundle && pj.dsh.bundle.patch
  const patchOk = patchRel && existsSync(join(HERE, patchRel))
  const bad = []
  if (bom.length) bad.push('带 BOM：' + bom.join(', '))
  if (parseFail.length) bad.push('JSON 解析失败：' + parseFail.join(' | '))
  if (!patchOk) bad.push('dsh.bundle.patch 指向的文件不存在：' + patchRel)
  return bad.length === 0 ? true : bad.join(' ；')
}])

// ── 声明 vs 实现（这类错已咬过两次：presentationMeta 的 undefined、intent 漏声明）──
asyncChecks.push(['★★ 正控 · **每个工具的实际返回值必须符合它自己声明的 output.schema**（additionalProperties:false 下多一个键就整次调用失败）', async () => {
  // 迷你校验器：只覆盖本插件用到的那部分 JSON Schema 子集
  check('漂移锁：paper_studio 的 action 枚举必须覆盖 CLI 全部子命令（漏一个 ⇒ 该能力对别的宿主不可达）', () => {
    /* 由 **真 MCP 探针** 发现：formats/preflight/anchors/report/schemacheck 五个子命令在原枚举下根本调不到。
       这条锁把"工具面 vs CLI"的一致性变成可机检，避免再悄悄漂移。modes/intent 是工具面**原生动作**（不转发 CLI），故豁免。 */
    const cli = readFileSync(new URL('../bin/studio.cjs', import.meta.url), 'utf8')
    const sm = /const SUBCOMMANDS = \[([\s\S]*?)\]/.exec(cli)
    const subs = sm ? Array.from(sm[1].matchAll(/['"]([a-z0-9-]+)['"]/g)).map((x) => x[1]) : []
    const dist = readFileSync(new URL('./dist/plugin.js', import.meta.url), 'utf8')
    const am = /STUDIO_ACTIONS = \[([\s\S]*?)\]/.exec(dist)
    const acts = am ? Array.from(am[1].matchAll(/['"]([a-z0-9-]+)['"]/g)).map((x) => x[1]) : []
    const missing = subs.filter((s) => !acts.includes(s))
    return (subs.length > 20 && missing.length === 0) || ('CLI 子命令 ' + subs.length + ' 个，枚举缺：' + missing.join(','));
  });
  check('漂移锁：MCP serverInfo 的版本必须等于 package.json（不许硬编码漂移）', () => {
    const mcp = readFileSync(new URL('./bin/mcp-server.mjs', import.meta.url), 'utf8')
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    const hard = /SERVER\s*=\s*\{[^}]*version:\s*['"](\d[^'"]*)['"]/.exec(mcp)
    const derived = /PKG_VERSION/.test(mcp) && /package\.json/.test(mcp)
    return (!hard && derived && typeof pkg.version === 'string') || ('硬编码版本=' + (hard && hard[1]) + ' 派生=' + derived);
  });
  const checkVal = (v, s, path) => {
    if (!s || typeof s !== 'object') return []
    const bad = []
    const t = s.type
    const isObj = v !== null && typeof v === 'object' && !Array.isArray(v)
    if (t === 'object') { if (!isObj) return [path + ' 应为 object，实为 ' + (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)] }
    else if (t === 'array') { if (!Array.isArray(v)) return [path + ' 应为 array'] }
    else if (t === 'string') { if (typeof v !== 'string') return [path + ' 应为 string'] }
    else if (t === 'boolean') { if (typeof v !== 'boolean') return [path + ' 应为 boolean'] }
    else if (t === 'integer') { if (!Number.isInteger(v)) return [path + ' 应为 integer'] }
    if (isObj && s.properties) {
      for (const [k, val] of Object.entries(v)) {
        if (!(k in s.properties)) { if (s.additionalProperties === false) bad.push(path + '.' + k + ' 未在 schema 中声明（additionalProperties:false ⇒ 会整次失败）'); continue }
        bad.push(...checkVal(val, s.properties[k], path + '.' + k))
      }
      for (const r of s.required || []) if (!(r in v)) bad.push(path + '.' + r + ' 缺失（required）')
    }
    return bad
  }
  const samples = [
    ['paper_studio', await studio.execute({ action: 'modes' })],
    ['paper_studio', await studio.execute({ action: 'intent', text: '帮我写论文' })],
    ['paper_studio', await studio.execute({ action: 'nope-not-an-action' })],
    ['paper_dev', await dev.execute({ action: 'status' })],
    ['paper_dev', await dev.execute({ action: 'list' })],
    ['paper_dev', await dev.execute({ action: 'write', path: 'references/pipeline.json', content: 'x' })],
  ]
  const bad = []
  for (const [name, value] of samples) {
    const tool = name === 'paper_studio' ? studio : dev
    bad.push(...checkVal(value, tool.output.schema, name).map((m) => m))
    if (typeof tool.output.render === 'function') {
      const blocks = tool.output.render({}, value)
      if (!Array.isArray(blocks) || !blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string')) bad.push(name + '.render 返回不合法')
    }
  }
  // intent 的判定必须真的出现在渲染输出里（它走 note，而不是新开字段）
  const intentRes = await studio.execute({ action: 'intent', text: '帮我写论文' })
  const intentText = studio.output.render({}, intentRes).map((b) => b.text).join('')
  if (!/is_paper/.test(intentText)) bad.push('paper_studio.render 未把 intent 判定渲染出来（应在 note 里）')
  if ('intent' in intentRes) bad.push('intent 不应新开字段（宿主 schema 未声明 ⇒ 会整次失败）')
  return bad.length === 0 ? true : bad.slice(0, 6).join(' | ')
}])

asyncChecks.push(['★★ 正控 · 菜单协议内置「自动推进」：收齐信息后先建持久目标，不许每步停下等催', async () => {
  const r = await studio.execute({ action: 'modes' })
  const m = (r && r.menu) || {}
  const a = m.autonomy || {}
  const bad = []
  if (!String(a.first || '').trim()) bad.push('autonomy.first 为空')
  if (!/逐轮|自动推进/.test(String(a.then || ''))) bad.push('autonomy.then 未写明逐轮自动推进')
  if (!/用户才有的东西|作者/.test(String(a.blocked || ''))) bad.push('autonomy.blocked 未界定何时才可停')
  if (!/完成/.test(String(a.done || ''))) bad.push('autonomy.done 未要求收尾标记完成')
  if (!/目标|create_goal|paper_progress|PROGRESS/.test(String(m.after_choice || ''))) bad.push('after_choice 未提示先建/接续目标')
  return bad.length === 0 ? true : bad.join(' | ')
}])

// ── 端到端：真的把 CLI 跑起来 ──
asyncChecks.push(['★★ 正控（端到端）· paper_studio action=audit 真的跑通 CLI 并返回退出码 0', async () => {
  // ★ 端到端会连带跑 10 个子工具的自检，负载高时可能偶发慢/失败（实测在"全新副本"里出现过 1 次）。
  //   处置：**重试一次**；重试通过则判过，但把这次偶发**显形**在末尾（不隐藏，也不因此把判据放水）。
  const once = () => studio.execute({ action: 'audit' })
  const good = (x) => x.ok === true && x.exit_code === 0 && /出厂审查/.test(x.stdout)
  let r = await once()
  if (good(r)) return true
  const first = JSON.stringify({ exit_code: r.exit_code, head: String(r.stdout || '').slice(0, 120), note: r.note })
  r = await once()
  if (good(r)) { flakes.push(`audit 首次失败、重试通过（首次：${first}）`); return true }
  flakes.push(`audit 两次都失败（首次：${first}）`)
  return JSON.stringify({ exit_code: r.exit_code, head: String(r.stdout || '').slice(0, 160), err: String(r.stderr || '').slice(0, 200), note: r.note })
}])

asyncChecks.push(['★ 必失败 · 未知 action 被拒（前提层错误，不当成"跑过了"）', async () => {
  const r = await studio.execute({ action: 'definitely-not-an-action' })
  return (r.ok === false && /前提层错误/.test(r.note)) ? true : JSON.stringify(r)
}])

// ★ v3.2.2：跨面一致性 —— 真源 agent_facing 的命令必须都能从插件工具面调到
check('跨面：真源 agent_facing 的命令必须都在插件 STUDIO_ACTIONS 里（防 CLI 加了命令、工具面漏接）', () => {
  let pj = {}
  try { pj = JSON.parse(readFileSync(join(ROOT, 'references', 'pipeline.json'), 'utf8')) } catch (e) { return '读不到真源 pipeline.json ⇒ 不得当通过：' + String(e.message || e) }
  const need = pj.agent_facing || []
  if (need.length < 5) return '真源 agent_facing 条数异常（' + need.length + '）⇒ 前提不成立，不得当通过'
  const src = readFileSync(join(ROOT, 'plugin', 'dist', 'plugin.js'), 'utf8')
  const m = /const STUDIO_ACTIONS = \[([\s\S]*?)\]/.exec(src)
  if (!m) return '读不到 STUDIO_ACTIONS（插件半体结构变了？）⇒ 不得当通过'
  const have = new Set((m[1].match(/'([a-z-]+)'/g) || []).map((s) => s.slice(1, -1)))
  const miss = need.filter((c) => !have.has(c))
  return miss.length === 0 || ('工具面未接线: ' + miss.join(', '))
})

check('★ 必失败 · agent_facing 里的幽灵动作必须被抓（不许静默通过）', () => {
  const src = "const STUDIO_ACTIONS = ['route', 'selftest']"
  const m = /const STUDIO_ACTIONS = \[([\s\S]*?)\]/.exec(src)
  const have = new Set((m[1].match(/'([a-z-]+)'/g) || []).map((s) => s.slice(1, -1)))
  const need = ['route', 'ghost-action-xyz']
  const miss = need.filter((c) => !have.has(c))
  return (miss.length === 1 && miss[0] === 'ghost-action-xyz') || ('未抓到：' + JSON.stringify(miss))
})

// ★ v3.2.3：整包自证 —— "装了这个包就有全部能力"必须可机检，而不是靠文档保证
check('整包：根 package.json 必须把全部能力打进 files（bin/references/plugin/SKILL.md）', () => {
  let pkg = {}
  try { pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) } catch (e) { return '读不到根 package.json ⇒ 整包安装不可用（不得当通过）：' + String((e && e.message) || e) }
  const need = ['bin', 'references', 'plugin', 'SKILL.md']
  const files = pkg.files || []
  const miss = need.filter((f) => !files.includes(f))
  if (miss.length) return '整包 files 缺: ' + miss.join(', ')
  const patch = (pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch) || ''
  if (!patch) return '根 package.json 缺 dsh.bundle.patch ⇒ 装了也不会被宿主当插件加载'
  if (!existsSync(join(ROOT, patch))) return 'dsh.bundle.patch 指向的文件不存在: ' + patch
  if (!pkg.main || !existsSync(join(ROOT, pkg.main))) return 'main 指向的文件不存在: ' + String(pkg.main)
  return true
})

check('★ 必失败 · 整包清单漏 references 必须被抓（防"装了包却没有判据资产"）', () => {
  const pkg = { files: ['bin', 'plugin', 'SKILL.md'], main: './x', dsh: { bundle: { patch: './y' } } }
  const miss = ['bin', 'references', 'plugin', 'SKILL.md'].filter((f) => !(pkg.files || []).includes(f))
  return (miss.length === 1 && miss[0] === 'references') || ('未抓到：' + JSON.stringify(miss))
})

check('整包：resolveRoot 必须含"包内自带"候选（否则整包装了也找不到能力树）', () => {
  const src = readFileSync(join(ROOT, 'plugin', 'dist', 'plugin.js'), 'utf8')
  return /包内自带/.test(src) || 'resolveRoot 缺包内自带候选（整包安装会找不到 bin/studio.cjs）'
})

for (const [name, fn] of asyncChecks) {
  try { const r = await fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }) }
  catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }) }
}
// 去掉占位项
const filtered = results.filter((r) => !/占位/.test(r.name))

const failed = filtered.filter((r) => !r.ok)
// v3.1.9：机器可读计数出口（下游一律引用本命令，别手抄数字 —— 2026-10-16 日审抓到的漂移就是这么来的）
if (process.argv.includes('--json')) {
  let __ver = 'unknown'
  try { __ver = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version } catch { /* 取不到就写 unknown，不猜 */ }
  console.log(JSON.stringify({ suite: 'plugin', pass: filtered.length - failed.length, total: filtered.length, ok: failed.length === 0, version: __ver, failed: failed.map((r) => r.name), flakes }, null, 2))
} else {
  for (const r of filtered) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
  console.log(`\n论文插件 V3 自检：${filtered.length - failed.length}/${filtered.length} 通过`)
  if (flakes.length) { console.log('\n⚠ 偶发（重试通过，**如实显形**）：'); for (const f of flakes) console.log('  · ' + f) }
}
try { rmSync(tmpHub, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exitCode = failed.length === 0 ? 0 : 1
