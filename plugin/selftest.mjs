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
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

asyncChecks.push(['★ 反控 · 空输入不得被当成论文请求（也不得当成"确定不是"，而要问）', async () => {
  const r = await studio.execute({ action: 'intent', text: '' })
  return (r.ok === true && r.intent.is_paper === false && r.intent.need_clarify === true) ? true : JSON.stringify(r)
}])

asyncChecks.push(['★ 正控 · action=intent 经工具路径也可用（含判定理由，供模型解释给用户）', async () => {
  const r = await studio.execute({ action: 'intent', text: '帮我写论文' })
  return (r.ok === true && r.intent.is_paper === true && /强触发/.test(r.intent.reason)) ? true : JSON.stringify(r)
}])

// ── 启动安全（重启前必须过：插件抛错会把宿主界面带崩）──
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

for (const [name, fn] of asyncChecks) {
  try { const r = await fn(); results.push({ name, ok: r === true, detail: r === true ? '' : String(r) }) }
  catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }) }
}
// 去掉占位项
const filtered = results.filter((r) => !/占位/.test(r.name))

const failed = filtered.filter((r) => !r.ok)
for (const r of filtered) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n论文插件 V3 自检：${filtered.length - failed.length}/${filtered.length} 通过`)
if (flakes.length) { console.log('\n⚠ 偶发（重试后通过，**如实显形**）：'); for (const f of flakes) console.log('  · ' + f) }
try { rmSync(tmpHub, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exitCode = failed.length === 0 ? 0 : 1
