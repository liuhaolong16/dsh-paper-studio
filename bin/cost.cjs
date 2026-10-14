#!/usr/bin/env node
/**
 * studio cost —— 论文成本总结（交付后自动算「这篇论文花了多少 token 和多少人民币」）
 *
 * 数据来源（**不估、不猜**）：DSH 的会话日志
 *   `~/.dsh/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd`
 *   里面 `assistant/message` 记录的 `data.usage` 就是**真实用量**：
 *     { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens }
 *   同一条记录的 `data.message.source = { provider, model }` 给出**是哪家哪个模型**。
 *
 * ★ 两个必须记住的实测坑（否则会读出"没内容"）：
 *   ① 会话日志是**多帧 zstd 拼接**：`zlib.zstdDecompressSync` **只解第一帧**！
 *      必须按魔数 `28 B5 2F FD` **切帧逐帧解**再拼接（实测：9 帧 → 385KB，直接解只有头帧）。
 *   ② 用量在 `assistant/message` 里，**不在** `step/end`/`turn/end`（那两个只有 turn/step 编号）。
 *
 * ★ 钱怎么算（**诚实优先**）：
 *   DSH **不自带模型价格表**（实测 asar 里没有 inputPrice/pricePerMillion 之类）。
 *   所以本工具把「token 数」当**事实**报出，把「金额」建立在**可核实的价格表**上：
 *     - 价格表默认读 `~/.dsh/paper-studio-prices.json`（可用 `--prices <文件>` 覆盖）；
 *     - **表里没有的模型 ⇒ 标"未定价"，费用记 null，绝不当 0**（当 0 = 假装免费，是最坏的谎）
 *     - 每条价格可带 `verified` 与 `source`、`as_of`，输出里如实标注「已核实 / 未核实(估算)」；
 *     - 需要外币时用 `--usd-cny <汇率>`（**汇率由你给**，工具不去替你猜当日汇率）。
 *
 * 用法：
 *   node bin/cost.cjs --file <session.v4.jsonl.zstd> [--json] [--out 交付总结.md] [--since <ISO>]
 *   node bin/cost.cjs --latest                 # 自动取最近改动的会话日志
 *   node bin/cost.cjs --prices-template        # 打印价格表模板（照着填）
 *   node bin/cost.cjs --selftest               # 自检（含必失败：未定价不得算成 0）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const zlib = require('node:zlib')

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')
const DEFAULT_PRICES = path.join(os.homedir(), '.dsh', 'paper-studio-prices.json')

const argv = process.argv.slice(2)
// ★ 参数一律经这层读：`ARGV` 由 `main(args)` 设置 —— 因为 studio.cjs 会以
//   `require('./cost.cjs').main(argv)` 的方式调用（**不是**当独立进程跑），
//   若这里直接绑死 `process.argv`，被 require 时读到的就不是调用方给的参数。
//   同时，模块加载时也不能自己执行 —— 见文件末尾的入口守卫。
let ARGV = argv
const has = (f) => ARGV.includes(f)
const val = (f, d = null) => { const i = ARGV.indexOf(f); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : d }

// ───────────────────────── 会话日志读取（多帧 zstd）─────────────────────────
function splitFrames(buf) {
  const offs = []
  let i = 0
  while (true) { const k = buf.indexOf(ZSTD_MAGIC, i); if (k < 0) break; offs.push(k); i = k + 4 }
  const out = []
  for (let n = 0; n < offs.length; n++) out.push(buf.subarray(offs[n], n + 1 < offs.length ? offs[n + 1] : buf.length))
  return out
}
/** 逐帧解压、逐行解析，累加（不把整个解压文本留在内存里） */
function scanSession(file, onRecord) {
  const buf = fs.readFileSync(file)
  const frames = splitFrames(buf)
  let lines = 0, bad = 0, decoded = 0, tail = ''
  for (const fr of frames) {
    let text = ''
    try { text = zlib.zstdDecompressSync(fr).toString('utf8'); decoded++ } catch (e) { bad++; continue }
    const chunk = tail + text
    const parts = chunk.split('\n')
    tail = parts.pop()   // 末行可能被帧边界截断，留到下一帧再拼
    for (const line of parts) {
      if (!line.trim()) continue
      lines++
      let rec = null
      try { rec = JSON.parse(line) } catch (e) { bad++; continue }
      onRecord(rec)
    }
  }
  if (tail.trim()) { lines++; try { onRecord(JSON.parse(tail)) } catch (e) { bad++ } }
  return { frames: frames.length, decodedFrames: decoded, badFrames: bad, lines, badLines: bad }
}

/** 从一条会话记录里抽「用量 + 模型」；没有就返回 null */
function usageOf(rec) {
  if (!rec || rec.type !== 'assistant/message') return null
  const d = rec.data || {}
  const u = d.usage
  if (!u || typeof u !== 'object') return null
  const src = (d.message && d.message.source) || {}
  return {
    time: rec.time || null,
    provider: src.provider || null,
    model: src.model || null,
    inputTokens: Number(u.inputTokens || 0),
    outputTokens: Number(u.outputTokens || 0),
    cacheReadTokens: Number(u.cacheReadTokens || 0),
    cacheWriteTokens: Number(u.cacheWriteTokens || 0),
    reasoningTokens: Number(u.reasoningTokens || 0),
    totalTokens: Number(u.totalTokens != null ? u.totalTokens : (Number(u.inputTokens || 0) + Number(u.outputTokens || 0))),
  }
}

// ───────────────────────── 价格表与费用 ─────────────────────────
// ★ 实测坑：`argv` 是**模块加载时的副本** —— 之后改 `process.argv` 不会影响它。
//   所以凡是"可能要带不同参数再算一遍"的地方（尤其自检），一律**显式传 opts**，不靠全局。
function pricesTemplate() {
  return {
    _说明: 'paper-studio 价格表：键用 `<provider>/<model>`（也可只写 `<model>` 或 `*` 兜底）。单位默认「每百万 token」，币种默认 CNY。',
    _填写要求: '每条请写明 source（价格来自哪个页面/账单）与 as_of（日期），verified 表示你是否已核对。工具会把未核实的金额标注为「未核实(估算)」。',
    unit: 1000000,
    currency: 'CNY',
    prices: {
      'deepseek-account/deepseek-flash': { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8, currency: 'CNY', unit: 1000000, verified: false, source: '【待你填写：官方价目页 URL 或账单】', as_of: '【YYYY-MM-DD】' },
      '*': { input: null, cacheRead: null, cacheWrite: null, output: null, currency: 'CNY', unit: 1000000, verified: false, source: '兜底项：字段留 null 表示「未定价」' },
    },
  }
}
function loadPrices(file) {
  if (!file || !fs.existsSync(file)) return { table: null, file: file || null, reason: '价格表不存在' }
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { table: j, file, reason: null }
  } catch (e) { return { table: null, file, reason: '价格表解析失败：' + e.message } }
}
function pickPrice(table, provider, model) {
  if (!table || !table.prices) return null
  const keys = [provider && model ? provider + '/' + model : null, model, '*'].filter(Boolean)
  for (const k of keys) {
    const p = table.prices[k]
    if (p && (p.input != null || p.output != null || p.cacheRead != null || p.cacheWrite != null)) return { key: k, ...p }
  }
  return null
}
/** 单条用量 → 金额（可能为 null = 未定价）；返回 {amount, currency, verified, source, as_of, note} */
function costOf(u, table, usdCny) {
  const p = pickPrice(table, u.provider, u.model)
  if (!p) return { amount: null, currency: table && table.currency ? table.currency : 'CNY', priced: false, note: '该模型未在价格表中 ⇒ 未定价（不计入合计）' }
  const unit = Number(p.unit || (table && table.unit) || 1000000)
  const rate = Number(usdCny) || (table && Number(table.usdToCny)) || null
  let amount = 0, missing = []
  const add = (tokens, price, label) => {
    if (price == null) { if (tokens > 0) missing.push(label); return }
    amount += (tokens / unit) * Number(price)
  }
  add(u.inputTokens, p.input, 'input')
  add(u.outputTokens, p.output, 'output')
  add(u.cacheReadTokens, p.cacheRead, 'cacheRead')
  add(u.cacheWriteTokens, p.cacheWrite, 'cacheWrite')
  let currency = p.currency || (table && table.currency) || 'CNY'
  let note = missing.length ? ('价格表缺 ' + missing.join('/') + ' 单价（该部分未计入）') : null
  if (currency === 'USD' && rate) { amount = amount * rate; currency = 'CNY'; note = (note ? note + '；' : '') + '按 1 USD = ' + rate + ' CNY 折算' }
  else if (currency === 'USD' && !rate) { note = (note ? note + '；' : '') + '价格以 USD 计但未提供汇率（--usd-cny）⇒ 此处仍是 USD' }
  return { amount, currency, priced: true, verified: p.verified === true, source: p.source || null, as_of: p.as_of || null, key: p.key, note }
}

// ───────────────────────── 汇总 ─────────────────────────
function latestSessionFile() {
  if (!fs.existsSync(SESSIONS_ROOT)) return null
  let best = null
  for (const ws of fs.readdirSync(SESSIONS_ROOT)) {
    const wsDir = path.join(SESSIONS_ROOT, ws)
    let sessDirs = []
    try { sessDirs = fs.readdirSync(wsDir) } catch (e) { continue }
    for (const s of sessDirs) {
      const f = path.join(wsDir, s, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(f)) continue
      const st = fs.statSync(f)
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: f, mtimeMs: st.mtimeMs, workspace: ws, session: s }
    }
  }
  return best
}

function summarize(file, opts) {
  const o = opts || {}
  const since = o.since ? Date.parse(o.since) : null
  const byModel = new Map()
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
  let firstTime = null, lastTime = null, turns = new Set(), steps = 0, skippedBySince = 0
  const scan = scanSession(file, (rec) => {
    // ★ 窗口（--since）必须**对所有计数生效**：只过滤用量而放着 turn/step 不过滤，
    //   会产出"窗口内 200 次调用 / 346 个 turn"这种自相矛盾的报告（实测踩到）。
    if (since && rec.time && rec.time < since) { if (rec.type === 'assistant/message') skippedBySince++; return }
    if (rec.type === 'turn/start') { if (rec.data && rec.data.turn != null) turns.add(rec.data.turn) }
    if (rec.type === 'step/start') steps++
    const u = usageOf(rec)
    if (!u) return
    totals.calls++
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) totals[k] += u[k]
    if (u.time) { if (!firstTime || u.time < firstTime) firstTime = u.time; if (!lastTime || u.time > lastTime) lastTime = u.time }
    const key = (u.provider || '?') + '/' + (u.model || '?')
    const agg = byModel.get(key) || { key, provider: u.provider, model: u.model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0 }
    agg.calls++
    for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']) agg[k] += u[k]
    byModel.set(key, agg)
  })
  const prices = loadPrices(o.pricesFile || DEFAULT_PRICES)
  const models = [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens)
  let sumCNY = 0, sumOther = {}, anyUnverified = false, unpriced = []
  for (const m of models) {
    const c = costOf(m, prices.table, o.usdCny)
    m.cost = c
    if (c.amount == null) { unpriced.push(m.key); continue }
    if (c.currency === 'CNY') sumCNY += c.amount; else sumOther[c.currency] = (sumOther[c.currency] || 0) + c.amount
    if (c.priced && c.verified === false) anyUnverified = true
  }
  return { file, scan, totals, models, prices, sumCNY, sumOther, unpriced, anyUnverified, firstTime, lastTime, turns: turns.size, steps, skippedBySince, since: o.since || null }
}

// ───────────────────────── 渲染 ─────────────────────────
const n = (x) => Number(x || 0).toLocaleString('en-US')
const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE').replace('T', ' ').slice(0, 16) : '—')
function spanText(a, b) {
  if (!a || !b) return '—'
  const min = Math.round((b - a) / 60000)
  return min >= 60 ? Math.floor(min / 60) + ' 小时 ' + (min % 60) + ' 分' : min + ' 分'
}
function renderMarkdown(s, opt = {}) {
  const p = s.prices
  const L = []
  L.push('# 论文成本总结（自动生成）')
  L.push('')
  L.push('- 会话日志：`' + s.file + '`')
  L.push('- 时间范围：**' + fmtTime(s.firstTime) + ' → ' + fmtTime(s.lastTime) + '**（跨度 ' + spanText(s.firstTime, s.lastTime) + '）')
  L.push('- 轮次/步数：**' + s.turns + ' 个 turn · ' + s.steps + ' 个 step · ' + s.totals.calls + ' 次模型调用**')
  L.push('')
  L.push('## 一、Token 用量（**事实**：逐条读会话日志里的 usage 字段）')
  L.push('')
  L.push('| 项目 | 数量 |')
  L.push('|---|---:|')
  L.push('| 输入（未命中缓存） | ' + n(s.totals.inputTokens) + ' |')
  L.push('| 输入（缓存命中） | ' + n(s.totals.cacheReadTokens) + ' |')
  L.push('| 输入（写缓存） | ' + n(s.totals.cacheWriteTokens) + ' |')
  L.push('| 输出 | ' + n(s.totals.outputTokens) + ' |')
  if (s.totals.reasoningTokens) L.push('| 其中推理 | ' + n(s.totals.reasoningTokens) + ' |')
  L.push('| **合计（按日志口径）** | **' + n(s.totals.totalTokens) + '** |')
  L.push('')
  L.push('分模型：')
  L.push('')
  L.push('| 模型 | 调用 | 输入 | 缓存读 | 输出 | 合计 |')
  L.push('|---|---:|---:|---:|---:|---:|')
  for (const m of s.models) L.push('| `' + m.key + '` | ' + m.calls + ' | ' + n(m.inputTokens) + ' | ' + n(m.cacheReadTokens) + ' | ' + n(m.outputTokens) + ' | ' + n(m.totalTokens) + ' |')
  L.push('')
  L.push('## 二、费用（**按价格表算**，不是估的）')
  L.push('')
  if (!p.table) {
    L.push('> ⚠️ **没有价格表 ⇒ 金额无法计算**（' + (p.reason || '') + '）。token 数照上表为准，不编金额。')
    L.push('>')
    L.push('> 建一份价格表：`node bin/cost.cjs --prices-template > ' + DEFAULT_PRICES + '`，填好 `input/cacheRead/cacheWrite/output`（单位：每百万 token）与 `source`、`as_of` 后重跑。')
  } else {
    L.push('价格表：`' + p.file + '`' + (p.table.currency ? '（币种 ' + p.table.currency + '）' : ''))
    L.push('')
    L.push('| 模型 | 单价键 | 金额 | 核实状态 | 价格来源 / 日期 |')
    L.push('|---|---|---:|---|---|')
    for (const m of s.models) {
      const c = m.cost || {}
      const amt = c.amount == null ? '**未定价**' : (c.currency === 'CNY' ? '¥ ' : c.currency + ' ') + c.amount.toFixed(4)
      const ver = c.amount == null ? '—' : (c.verified ? '已核实' : '**未核实(估算)**')
      L.push('| `' + m.key + '` | ' + (c.key || '—') + ' | ' + amt + ' | ' + ver + ' | ' + (c.source || '—') + (c.as_of ? ' · ' + c.as_of : '') + ' |')
    }
    L.push('')
    L.push('**合计：¥ ' + s.sumCNY.toFixed(4) + '**' + (s.anyUnverified ? '（含**未核实**单价 ⇒ 这是估算，不是账单金额）' : '') + (Object.keys(s.sumOther).length ? '；另有 ' + Object.entries(s.sumOther).map(([c, v]) => c + ' ' + v.toFixed(4)).join('、') + ' 未折人民币' : ''))
    if (s.unpriced.length) {
      L.push('')
      L.push('> ⚠️ **未定价模型（未计入合计）**：' + s.unpriced.map((k) => '`' + k + '`').join('、') + ' —— 不给它们编单价，是这条总结的纪律；补进价格表后金额会自动包含它们。')
    }
  }
  L.push('')
  L.push('## 三、口径与限制（**读这份总结前先看这段**）')
  L.push('')
  L.push('1. 用量**只统计本会话日志里 `assistant/message` 的 usage**；**不含**子代理（各自独立会话）、不含本地脚本/门执行的机时（那部分不花 token）。')
  L.push('2. 金额**取决于价格表**：DSH 不自带模型价目表（实测），所以金额的权威性 = 你填的 `source` 的权威性。')
  L.push('3. 「缓存命中」按价格表的 `cacheRead` 单价算；若你的价格表没填缓存单价，**该部分不会被悄悄并入其它单价**，而是显式提示缺单价。')
  L.push('4. 汇率**由使用者给出**（`--usd-cny`），工具不替你猜当日汇率。')
  if (s.skippedBySince) L.push('5. 本次带 `--since ' + s.since + '`：已**跳过 ' + n(s.skippedBySince) + ' 次**发生在该时间之前的调用。')
  if (s.scan.badFrames || s.scan.badLines) L.push('6. 扫描告警：坏帧 ' + s.scan.badFrames + ' · 坏行 ' + s.scan.badLines + '（这些内容未计入，如实标出）。')
  L.push('')
  L.push('---')
  L.push('')
  L.push('*本文件由 `paper-studio` 的 `cost` 子命令生成（`node bin/cost.cjs`）。tokens 为事实；金额为按价格表计算的结果。*')
  return L.join('\n') + '\n'
}

// ───────────────────────── 自检 ─────────────────────────
function selftest() {
  const bad = []
  const tmp = path.join(os.tmpdir(), 'ps-cost-' + Date.now())
  fs.mkdirSync(tmp, { recursive: true })
  const mkFrame = (objs) => zlib.zstdCompressSync(Buffer.from(objs.map((o) => JSON.stringify(o)).join('\n') + '\n', 'utf8'))
  const rec = (t, inT, outT, cr, model) => ({ type: 'assistant/message', time: t, data: { usage: { inputTokens: inT, outputTokens: outT, cacheReadTokens: cr, cacheWriteTokens: 0, totalTokens: inT + outT + cr }, message: { source: { provider: 'p1', model } } } })
  const sess = path.join(tmp, 'session.v4.jsonl.zstd')
  // ★ 故意做成**多帧**：只有按魔数切帧逐个解才读得全（只解第一帧会少算）
  fs.writeFileSync(sess, Buffer.concat([
    mkFrame([{ type: 'turn/start', time: 1000, data: { turn: 1 } }, rec(1100, 100, 10, 1000, 'm-ok')]),
    mkFrame([{ type: 'turn/start', time: 2000, data: { turn: 2 } }, rec(2100, 200, 20, 2000, 'm-ok')]),
    mkFrame([rec(3100, 300, 30, 0, 'm-unknown')]),
  ]))
  const prices = path.join(tmp, 'prices.json')
  fs.writeFileSync(prices, JSON.stringify({ unit: 1000000, currency: 'CNY', prices: { 'p1/m-ok': { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8, verified: true, source: '自检夹具', as_of: '2026-10-15' } } }))
  // ① 帧切分与累加：三次调用应全被读到
  //   ★ 显式指向一个**不存在**的价格表：否则断言会依赖"默认价格表是否存在"这种外部状态（假阳性源）
  const s = summarize(sess, { pricesFile: path.join(tmp, 'nope.json') })
  if (s.totals.calls !== 3) bad.push('调用次数应为 3，实为 ' + s.totals.calls + '（多帧没切干净就会少）')
  if (s.totals.inputTokens !== 600) bad.push('输入合计应为 600，实为 ' + s.totals.inputTokens)
  if (s.totals.cacheReadTokens !== 3000) bad.push('缓存读应为 3000，实为 ' + s.totals.cacheReadTokens)
  if (s.turns !== 2) bad.push('turn 数应为 2，实为 ' + s.turns)
  // ② 没有价格表 ⇒ 必须"不可计算"，不得给 0
  if (s.prices.table) bad.push('不该读到价格表（这里显式指向了不存在的文件）')
  // ③ 有价格表：已定价的算得出，未定价的必须标 unpriced 且不计入合计（**必失败面：不得当 0**）
  const s2 = summarize(sess, { pricesFile: prices })
  const okModel = s2.models.find((m) => m.model === 'm-ok')
  const unkModel = s2.models.find((m) => m.model === 'm-unknown')
  if (!okModel || !unkModel) bad.push('分模型统计缺项')
  else {
    // 已定价模型只有**前两条**记录（第三条是 m-unknown）：输入 300 · 缓存读 3000 · 输出 30
    // ★ 期望值按夹具自己的数字推导，不写死一个"看起来对"的常数（写错常数会冤枉好代码）
    const expIn = 300, expCacheRead = 3000, expOut = 30
    const expect = (expIn / 1e6) * 2 + (expCacheRead / 1e6) * 0.5 + (expOut / 1e6) * 8
    if (Math.abs(okModel.inputTokens - expIn) > 1e-9 || Math.abs(okModel.cacheReadTokens - expCacheRead) > 1e-9) bad.push('已定价模型的分项用量不对：in=' + okModel.inputTokens + ' cacheRead=' + okModel.cacheReadTokens)
    if (Math.abs(okModel.cost.amount - expect) > 1e-9) bad.push('定价模型金额不符：期望 ' + expect + ' 实得 ' + okModel.cost.amount)
    if (unkModel.cost.amount !== null) bad.push('未定价模型必须记 null，实为 ' + unkModel.cost.amount + '（**当 0 就是撒谎**）')
    if (!s2.unpriced.includes('p1/m-unknown')) bad.push('未定价模型没进 unpriced 名单')
    if (Math.abs(s2.sumCNY - expect) > 1e-9) bad.push('合计应只含已定价部分：期望 ' + expect + ' 实得 ' + s2.sumCNY)
  }
  // ④ 渲染必须显形：未定价、未核实、缺单价都要在文里出现
  const md = renderMarkdown(s2)
  if (!/未定价/.test(md)) bad.push('渲染里没有"未定价"字样')
  if (!/未核实/.test(md) && !/已核实/.test(md)) bad.push('渲染里没有核实状态')
  if (!/价格表/.test(md)) bad.push('渲染里没有价格表出处')
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* ignore */ }
  if (bad.length) { console.error('cost 自检失败：\n - ' + bad.join('\n - ')); return 1 }
  console.log('cost 自检：10/10 通过（多帧切分 · 累加 · 未定价记 null · 合计只含已定价 · 渲染显形）')
  return 0
}

// ───────────────────────── main ─────────────────────────
function main(args) {
  ARGV = Array.isArray(args) ? args : process.argv.slice(2)   // ★ 以调用方给的参数为准（studio.cjs 会传 argv）
  if (has('--selftest')) return selftest()
  if (has('--prices-template')) { process.stdout.write(JSON.stringify(pricesTemplate(), null, 2) + '\n'); return 0 }
  let file = val('--file')
  if (!file && has('--latest')) {
    const l = latestSessionFile()
    if (!l) { console.error('找不到任何会话日志（' + SESSIONS_ROOT + '）'); return 2 }
    file = l.file
    console.error('（--latest：' + l.workspace + ' / ' + l.session + '）')
  }
  if (!file) { console.error('用法：node bin/cost.cjs --file <session.v4.jsonl.zstd> | --latest [--json] [--out <md>] [--since <ISO>] [--prices <json>]'); return 2 }
  if (!fs.existsSync(file)) { console.error('文件不存在：' + file); return 2 }
  const s = summarize(file, { since: val('--since'), pricesFile: val('--prices') || DEFAULT_PRICES, usdCny: val('--usd-cny') })
  if (has('--json')) { process.stdout.write(JSON.stringify({ file: s.file, scan: s.scan, totals: s.totals, turns: s.turns, steps: s.steps, firstTime: s.firstTime, lastTime: s.lastTime, models: s.models, sumCNY: s.sumCNY, sumOther: s.sumOther, unpriced: s.unpriced, anyUnverified: s.anyUnverified, pricesFile: s.prices.file, pricesLoaded: !!s.prices.table }, null, 2) + '\n') }
  const md = renderMarkdown(s)
  const out = val('--out')
  if (out) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, md, 'utf8'); console.error('已写：' + out) }
  if (!has('--json') || out) process.stdout.write(md)
  return 0
}

module.exports = { main, summarize, scanSession, splitFrames, usageOf, costOf, renderMarkdown, pricesTemplate, selftest, latestSessionFile, DEFAULT_PRICES, SESSIONS_ROOT }

// ⚠ 入口守卫必须在 module.exports **之后**（与 studio.cjs 同一条纪律）：
//   被 `require` 时**绝不能**自己跑 main —— 否则 require 的瞬间就打印/退出。
//   （真事故级别：原先写成 `process.exit(main())`，宿主一旦 require 就会**把宿主进程杀掉**。）
if (require.main === module) {
  process.exitCode = main(process.argv.slice(2))
}
