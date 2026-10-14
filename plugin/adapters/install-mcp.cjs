#!/usr/bin/env node
/**
 * install-mcp — 把 paper-studio 的 MCP 服务器接入**市面上大多数宿主**
 *
 * 为什么要通用安装器：每个宿主的接入方式不同（有的读 `mcpServers` 的 JSON、有的用别的键、有的只认自己的 CLI）。
 * 与其一家家写文档，不如把"宿主 → 配置位置 → 写法"做成一张表，一次装到位、且**都留备份可回退**。
 *
 * 安全纪律（本项目硬规则）：
 *   1. 写任何配置**前先备份**（带时间戳）；
 *   2. **只增/删我们自己的那一条**，其它键原样保留（读进来 → 合并 → 写回，绝不整篇重写别人的内容）；
 *   3. 幂等：重复运行不重复添加；
 *   4. 有官方 CLI 的宿主（Codex/Claude Code）**只走官方入口**，不手改它的配置文件；
 *   5. **不读取也不打印**别人配置里的凭证值（只判断存在性）。
 *
 * 用法：
 *   node install-mcp.cjs --list                 # 看本机检测到哪些宿主
 *   node install-mcp.cjs --host auto            # 装进所有检测到、且支持的宿主
 *   node install-mcp.cjs --host trae-cn         # 只装某一个（可多个：--host trae-cn,cursor）
 *   node install-mcp.cjs --host trae-cn --dry-run
 *   node install-mcp.cjs --host trae-cn --remove
 *   node install-mcp.cjs --host trae-cn --config <path>   # 覆盖路径（测试用）
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const HERE = __dirname
const PLUGIN = path.resolve(HERE, '..')
const SERVER = path.join(PLUGIN, 'bin', 'mcp-server.mjs')
const ENTRY = 'paper-studio'

const A = process.argv.slice(2)
const has = (f) => A.includes(f)
const val = (f, d = null) => { const i = A.indexOf(f); return i >= 0 && A[i + 1] ? A[i + 1] : d }
const DRY = has('--dry-run')
const REMOVE = has('--remove')
const home = os.homedir()
const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')

/** 宿主表：dialect 决定"写哪个键"；cli 型的走官方命令 */
const HOSTS = [
  { id: 'trae-cn', label: 'TRAE CN（字节 AI IDE · 国内版）', dialect: 'mcpServers', config: path.join(appdata, 'Trae CN', 'User', 'mcp.json'), verified: true },
  { id: 'trae', label: 'TRAE（国际版）', dialect: 'mcpServers', config: path.join(appdata, 'Trae', 'User', 'mcp.json'), verified: false },
  { id: 'cursor', label: 'Cursor', dialect: 'mcpServers', config: path.join(home, '.cursor', 'mcp.json'), verified: false },
  { id: 'vscode', label: 'VS Code（Copilot / MCP）', dialect: 'mcpServers', config: path.join(appdata, 'Code', 'User', 'mcp.json'), verified: false },
  { id: 'claude-desktop', label: 'Claude Desktop', dialect: 'mcpServers', config: path.join(appdata, 'Claude', 'claude_desktop_config.json'), verified: false },
  { id: 'windsurf', label: 'Windsurf', dialect: 'mcpServers', config: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), verified: false },
  { id: 'cline', label: 'Cline（VS Code 插件）', dialect: 'mcpServers', config: path.join(appdata, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'), verified: false },
  { id: 'gemini-cli', label: 'Gemini CLI', dialect: 'mcpServers', config: path.join(home, '.gemini', 'settings.json'), verified: false },
  { id: 'continue', label: 'Continue', dialect: 'mcpServers', config: path.join(home, '.continue', 'config.json'), verified: false },
  { id: 'zed', label: 'Zed（用 context_servers 键）', dialect: 'context_servers', config: path.join(appdata, 'Zed', 'settings.json'), verified: false },
  { id: 'claude-code', label: 'Claude Code（官方 CLI）', dialect: 'cli', cli: 'claude', args: ['mcp', 'add', ENTRY, '--', process.execPath, SERVER], verified: false },
  { id: 'codex', label: 'Codex（官方 CLI）', dialect: 'cli', cli: 'codex', args: ['mcp', 'add', ENTRY, '--', process.execPath, SERVER], verified: true },
]

const say = (s) => console.log('  ' + s)
const which = (cmd) => {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', shell: process.platform === 'win32' })
  return r.status === 0 ? String(r.stdout).split(/\r?\n/)[0].trim() : null
}
const readJson = (p) => {
  if (!fs.existsSync(p)) return { ok: true, obj: {}, existed: false }
  const raw = fs.readFileSync(p, 'utf8')
  try { return { ok: true, obj: JSON.parse(raw), existed: true, raw } } catch (e) { return { ok: false, error: e.message, raw } }
}
function entryFor() { return { command: process.execPath, args: [SERVER], env: {} } }

function doEnvHost(h, dry) {
  const cfgPath = val('--config') || (process.env.PS_MCP_CONFIG_OVERRIDE && h.id === val('--host') ? process.env.PS_MCP_CONFIG_OVERRIDE : h.config)
  const key = h.dialect // 'mcpServers' | 'context_servers'
  const rd = readJson(cfgPath)
  if (!rd.ok) return { host: h.id, action: 'skip', why: '现有配置不是合法 JSON（先手工修好，我不覆盖）：' + rd.error }
  const obj = rd.obj || {}
  const bucket = obj[key] && typeof obj[key] === 'object' ? obj[key] : (obj[key] = {})
  // ★ 必须在**改动之前**把原有键快照下来（用副本，不能用同一个被改动的对象）——
  //   实测踩过：拿 `obj[key]` 自己比对，等于"自己跟自己比"，永远通过 ⇒ 写后自检形同虚设。
  const beforeKeys = Object.keys(JSON.parse(JSON.stringify(bucket)))
  const exists = !!bucket[ENTRY]
  if (REMOVE) {
    if (!exists) return { host: h.id, action: 'noop', why: '本来就没装' }
    if (dry) return { host: h.id, action: 'would-remove', cfg: cfgPath }
    const bak = cfgPath + '.bak-paperstudio-' + Date.now()
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true }); fs.copyFileSync(cfgPath, bak)
    delete bucket[ENTRY]; fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2) + '\n', 'utf8')
    return { host: h.id, action: 'removed', cfg: cfgPath, backup: bak }
  }
  if (exists) return { host: h.id, action: 'noop', why: '已装（幂等跳过）', cfg: cfgPath }
  if (dry) return { host: h.id, action: 'would-add', cfg: cfgPath, key }
  const bak = cfgPath + '.bak-paperstudio-' + Date.now()
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
  if (rd.existed) fs.copyFileSync(cfgPath, bak)
  bucket[ENTRY] = entryFor()
  fs.writeFileSync(cfgPath, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  // 写后自校验：必须能解析，且**原有条目一个不少**（防止整篇重写把别人的配置吃掉）
  const after = readJson(cfgPath)
  if (!after.ok) return { host: h.id, action: 'error', why: '写后 JSON 非法：' + after.error }
  const lost = beforeKeys.filter((k) => !(k in after.obj[key]))
  if (lost.length) return { host: h.id, action: 'error', why: '写后丢了原有条目：' + lost.join(',') }
  return { host: h.id, action: 'added', cfg: cfgPath, backup: rd.existed ? bak : null, keptKeys: beforeKeys.length }
}

function doCliHost(h, dry) {
  const exe = which(h.cli)
  if (!exe) return { host: h.id, action: 'skip', why: 'PATH 里没有 ' + h.cli }
  const list = spawnSync(h.cli, [h.args[0], 'list'], { encoding: 'utf8', shell: process.platform === 'win32' })
  if (!REMOVE && new RegExp(ENTRY).test(String(list.stdout || ''))) return { host: h.id, action: 'noop', why: '已装（幂等跳过）' }
  if (dry) return { host: h.id, action: REMOVE ? 'would-remove' : 'would-add', via: h.cli }
  const args = REMOVE ? [h.args[0], 'remove', ENTRY] : h.args
  const r = spawnSync(h.cli, args, { encoding: 'utf8', shell: process.platform === 'win32' })
  return { host: h.id, action: r.status === 0 ? (REMOVE ? 'removed' : 'added') : 'error', via: h.cli, out: String(r.stdout || r.stderr || '').trim().slice(0, 160) }
}

;(() => {
  const only = val('--host')
  const target = val('--config') ? [HOSTS.find((h) => h.id === only)].filter(Boolean) : null
  const selected = target || (has('--list')
    ? []
    : only && only !== 'auto' && only !== 'all'
      ? HOSTS.filter((h) => only.split(',').map((s) => s.trim()).includes(h.id))
      : HOSTS.filter((h) => (only === 'all' ? true : h.dialect === 'cli' ? !!which(h.cli) : fs.existsSync(h.config))))

  if (has('--list') || !selected.length) {
    say('宿主检测（只看"配置文件/CLI 是否存在"，不读内容里的凭证值）：')
    for (const h of HOSTS) {
      const inst = h.dialect === 'cli' ? !!which(h.cli) : fs.existsSync(h.config)
      let installed = ''
      if (inst && h.dialect !== 'cli') {
        const rd = readJson(h.config)
        if (rd.ok) { const b = rd.obj[h.dialect] || {}; installed = b[ENTRY] ? '  ← 已装 paper-studio' : '' }
      }
      say(`   ${inst ? '✔' : '✘'} ${h.label}${inst ? '  ' + (h.config || ('CLI: ' + h.cli)) : ''}${installed}${h.verified ? '  〔本机已验证〕' : ''}`)
    }
    if (!selected.length) { say(''); say('用法：--host auto|<id>,<id>|all  [--dry-run] [--remove]') }
    return
  }

  say((DRY ? '（dry-run）' : '') + (REMOVE ? '移除' : '接入') + ' paper-studio → ' + selected.map((h) => h.id).join(', '))
  for (const h of selected) {
    const r = h.dialect === 'cli' ? doCliHost(h, DRY) : doEnvHost(h, DRY)
    say(`   [${r.action}] ${h.label}` + (r.cfg ? '  ' + r.cfg : '') + (r.why ? '  — ' + r.why : '') + (r.backup ? '  （备份 ' + path.basename(r.backup) + '）' : '') + (r.keptKeys !== undefined ? '（原有 ' + r.keptKeys + ' 条完好）' : '') + (r.out ? '  ' + r.out : ''))
  }
  say('')
  say('复核：宿主重启后在它的 MCP 面板/列表里应看到 paper-studio；或用 --list 看检测结果。')
})()
