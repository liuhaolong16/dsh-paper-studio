#!/usr/bin/env node
/**
 * install-codex — 把 paper-studio 接进 Codex（**只用官方入口**，不手改配置）
 *
 * 做两件事：
 *   ① `codex mcp add paper-studio -- <node> <…>/bin/mcp-server.mjs`（官方 MCP 注册）
 *   ② 把技能拷进 `~/.codex/skills/paper-studio/`（Codex 的技能目录；**发现机制未实测**，如实标注）
 *
 * 安全纪律：
 *   - 改任何配置**前先备份** `~/.codex/config.toml`（带时间戳，可回退）；
 *   - **不直接编辑 config.toml**（那会被官方入口/内存副本覆盖，本项目已有教训）；
 *   - 幂等：重复运行不会重复注册（先查 `codex mcp list`）。
 *
 * 用法：node install-codex.cjs [--dry-run]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const DRY = process.argv.includes('--dry-run')
const HERE = __dirname
const PLUGIN = path.resolve(HERE, '..')
const SKILL_SRC = path.join(PLUGIN, 'skill')
const SERVER = path.join(PLUGIN, 'bin', 'mcp-server.mjs')
const CODEX_DIR = path.join(os.homedir(), '.codex')
const CFG = path.join(CODEX_DIR, 'config.toml')
const SKILL_DST = path.join(CODEX_DIR, 'skills', 'paper-studio')

const say = (s) => console.log('  ' + s)
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' })

function which(cmd) {
  const r = run(process.platform === 'win32' ? 'where' : 'which', [cmd])
  return r.status === 0 ? String(r.stdout).split(/\r?\n/)[0].trim() : null
}

;(() => {
  say('paper-studio → Codex 接入' + (DRY ? '（dry-run：不写任何东西）' : ''))
  if (!fs.existsSync(SERVER)) { say('✘ 找不到 ' + SERVER); process.exit(2) }
  const codex = which('codex')
  if (!codex) { say('✘ PATH 里没有 codex —— 先装 Codex CLI 再跑本脚本'); process.exit(2) }
  const node = process.execPath
  say('codex = ' + codex)
  say('node  = ' + node)

  // ① 备份配置（幂等：已有备份就不重复堆）
  if (fs.existsSync(CFG)) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13)
    const bak = CFG + '.bak-paperstudio-' + stamp
    if (DRY) say('（dry-run）会备份 ' + CFG + ' → ' + bak)
    else { fs.copyFileSync(CFG, bak); say('已备份配置 → ' + path.basename(bak)) }
  } else say('（没有 config.toml：Codex 会在首次运行时自建）')

  // ② MCP 注册（先查重）
  const list = run(codex, ['mcp', 'list'])
  const already = /paper-studio/.test(String(list.stdout || ''))
  if (already) say('MCP 已注册过 paper-studio，跳过（幂等）')
  else if (DRY) say('（dry-run）会执行：codex mcp add paper-studio -- ' + node + ' ' + SERVER)
  else {
    const r = run(codex, ['mcp', 'add', 'paper-studio', '--', node, SERVER])
    say('codex mcp add rc=' + r.status + ' ' + String(r.stdout || r.stderr || '').trim())
  }

  // ③ 技能目录（Codex 的 skills/；发现机制未实测，如实标注）
  if (DRY) say('（dry-run）会把技能拷到 ' + SKILL_DST)
  else {
    fs.mkdirSync(SKILL_DST, { recursive: true })
    fs.copyFileSync(path.join(SKILL_SRC, 'SKILL.md'), path.join(SKILL_DST, 'SKILL.md'))
    say('已拷技能 → ' + SKILL_DST + '\\SKILL.md（⚠️ Codex 对该目录的发现机制**未实测**）')
  }

  say('')
  say('复核：codex mcp list   （应看到 paper-studio 且 Status=enabled）')
  say('回退：codex mcp remove paper-studio   ＋ 用 config.toml.bak-paperstudio-* 覆盖回配置')
})()
