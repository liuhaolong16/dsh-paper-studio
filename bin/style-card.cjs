#!/usr/bin/env node
'use strict';

/**
 * UI 风格约束卡 · 取卡与机检（style-card）
 *
 * 由来：AI 生成的界面丑且风格漂移，根因不是缺审美，是缺约束——给不出 token 时，
 * 模型只会回落到训练集里频率最高的那套默认值（灰底、圆角、渐变、彩色单边强调）。
 * 本工具把「风格卡」当合同：颜色、圆角、阴影、边框、字号只能来自卡；
 * 卡外颜色、卡禁类名、卡禁模式一律报红。
 *
 * 用法：
 *   node bin/style-card.cjs --list
 *   node bin/style-card.cjs --card [paper-editorial] [--json]
 *   node bin/style-card.cjs --prompt
 *   node bin/style-card.cjs --check <文件或目录> [--json]
 *   node bin/style-card.cjs --selftest
 *
 * 退出码：0 = 通过；1 = 有违规；2 = 用法/读取错误。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CARD_DIR = path.join(ROOT, 'assets', 'ui-style');
const CARDS = ['paper-editorial'];
const PROMPT = path.join(CARD_DIR, 'prompt.template.md');
const SCAN_EXT = new Set(['.html', '.htm', '.css', '.js', '.jsx', '.tsx', '.vue', '.svelte', '.svg']);

function cardPath(id) {
  return path.join(CARD_DIR, 'style-card.' + id + '.json');
}

function loadCard(id) {
  const file = cardPath(id);
  if (!fs.existsSync(file)) {
    const err = new Error('风格卡不存在：' + id + '；可用：' + CARDS.join(' / '));
    err.code = 2;
    throw err;
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function normalizeHex(value) {
  const raw = String(value).replace('#', '').toLowerCase();
  if (raw.length === 3) return raw.split('').map((c) => c + c).join('');
  return raw;
}

function allowedColors(card) {
  const hex = new Set();
  const rgba = new Set();
  const walk = (node) => {
    if (typeof node === 'string') {
      if (/^#[0-9a-fA-F]{3,8}$/.test(node)) hex.add(normalizeHex(node));
      if (/^rgba?\(/i.test(node)) rgba.add(node.replace(/\s+/g, '').toLowerCase());
      return;
    }
    if (node && typeof node === 'object') for (const value of Object.values(node)) walk(value);
  };
  walk(card.colors);
  return { hex, rgba };
}

function listFiles(target) {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (SCAN_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };
  walk(target);
  return out;
}

function scanText(text, card, allowed, file) {
  const issues = [];
  const lines = text.split(/\r?\n/);
  const forbiddenClasses = (card.forbidden && card.forbidden.classes) || [];
  const forbiddenPatterns = ((card.forbidden && card.forbidden.patterns) || []).map((pattern) => {
    try { return new RegExp(pattern, 'g'); } catch (error) { return null; }
  }).filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNo = index + 1;

    const hexes = line.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    for (const value of hexes) {
      if (!allowed.hex.has(normalizeHex(value))) {
        issues.push({ code: 'E_OFFCARD_COLOR', file, line: lineNo, snippet: value, message: '卡外颜色 ' + value + '（风格卡只允许 ' + Array.from(allowed.hex).join('/') + '）' });
      }
    }

    for (const cls of forbiddenClasses) {
      const rx = new RegExp('(?<![\\w-])' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w-])', 'g');
      if (rx.test(line)) {
        issues.push({ code: 'E_FORBIDDEN_CLASS', file, line: lineNo, snippet: cls, message: '禁用类名 ' + cls });
      }
    }

    for (const rx of forbiddenPatterns) {
      rx.lastIndex = 0;
      const hit = rx.exec(line);
      if (hit) {
        issues.push({ code: 'E_FORBIDDEN_PATTERN', file, line: lineNo, snippet: hit[0], message: '命中禁用模式 /' + rx.source + '/：' + hit[0] });
      }
    }
  }
  return issues;
}

function checkPath(target, card) {
  const allowed = allowedColors(card);
  const issues = [];
  for (const file of listFiles(target)) {
    const text = fs.readFileSync(file, 'utf8');
    issues.push(...scanText(text, card, allowed, file));
  }
  return issues;
}

// ---------- selftest ----------

function runCase(name, files, expectCodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'style-card-'));
  for (const [name_, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name_), content, 'utf8');
  }
  const card = loadCard('paper-editorial');
  const codes = Array.from(new Set(checkPath(dir, card).map((item) => item.code)));
  const missing = expectCodes.filter((code) => !codes.includes(code));
  const unexpected = expectCodes.length === 0 ? codes : [];
  return { name, ok: missing.length === 0 && unexpected.length === 0, codes, missing, unexpected };
}

function selftest() {
  const good = [
    '<div class="card" style="background:#F9F8F6;color:#1C1C1C;border:1px solid rgba(28,28,28,0.12)">',
    '  <h2 class="title">Paper tool</h2>',
    '  <span style="color:#2F6B4F">success</span>',
    '</div>',
  ].join('\n');
  const bad = [
    '<div class="rounded-lg shadow-md bg-gradient-to-r border-l-red-500" style="color:#123456">bad</div>',
  ].join('\n');
  const pureBlack = '<p style="color:#000">pure black</p>';

  const cases = [
    runCase('good fixture must pass', { 'good.html': good }, []),
    runCase('bad fixture must hit color/class/pattern', { 'bad.html': bad }, ['E_OFFCARD_COLOR', 'E_FORBIDDEN_CLASS', 'E_FORBIDDEN_PATTERN']),
    runCase('pure black must be off-card', { 'black.html': pureBlack }, ['E_OFFCARD_COLOR']),
    runCase('token definition with allowed colors must pass', { 'tokens.css': ':root { --bg:#F9F8F6; --fg:#1C1C1C; }' }, []),
  ];

  let failed = 0;
  for (const item of cases) {
    const ok = item.ok;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + item.name + (ok ? '' : '  missing=' + item.missing.join(',') + ' unexpected=' + item.unexpected.join(',') + ' got=' + item.codes.join(',')));
    if (!ok) failed += 1;
  }
  console.log('\nselftest: ' + (cases.length - failed) + '/' + cases.length + ' 通过');
  return failed === 0 ? 0 : 1;
}

// ---------- CLI ----------

function main(argv) {
  const args = argv.slice(2);
  const asJson = args.includes('--json');
  try {
    if (args.includes('--selftest')) {
      process.exitCode = selftest();
      return;
    }
    if (args.includes('--list')) {
      console.log(CARDS.join('\n'));
      return;
    }
    if (args.includes('--prompt')) {
      if (!fs.existsSync(PROMPT)) {
        console.error('提示词模板不存在：' + PROMPT);
        process.exitCode = 2;
        return;
      }
      console.log(fs.readFileSync(PROMPT, 'utf8'));
      return;
    }
    if (args.includes('--card')) {
      const id = args[args.indexOf('--card') + 1] && !args[args.indexOf('--card') + 1].startsWith('--')
        ? args[args.indexOf('--card') + 1]
        : 'paper-editorial';
      const card = loadCard(id);
      console.log(asJson ? JSON.stringify(card, null, 2) : JSON.stringify(card, null, 2));
      return;
    }
    if (args.includes('--check')) {
      const target = args[args.indexOf('--check') + 1];
      if (!target || target.startsWith('--')) {
        console.error('用法：node bin/style-card.cjs --check <文件或目录>');
        process.exitCode = 2;
        return;
      }
      if (!fs.existsSync(target)) {
        console.error('前提层失败：路径不存在 ' + target);
        process.exitCode = 2;
        return;
      }
      const issues = checkPath(target, loadCard('paper-editorial'));
      if (asJson) {
        console.log(JSON.stringify({ target, passed: issues.length === 0, count: issues.length, issues }, null, 2));
      } else if (issues.length === 0) {
        console.log('通过：' + target + '（0 个违规）');
      } else {
        console.log('未通过：' + target + '（' + issues.length + ' 个违规）');
        for (const item of issues.slice(0, 50)) {
          console.log('  [' + item.code + '] ' + path.relative(ROOT, item.file) + ':' + item.line + '  ' + item.message);
        }
        if (issues.length > 50) console.log('  …另有 ' + (issues.length - 50) + ' 条未列出');
      }
      process.exitCode = issues.length === 0 ? 0 : 1;
      return;
    }
    console.error('用法：node bin/style-card.cjs --list | --card [id] | --prompt | --check <路径> | --selftest');
    process.exitCode = 2;
  } catch (error) {
    console.error('失败：' + error.message);
    process.exitCode = error.code === 2 ? 2 : 1;
  }
}

main(process.argv);
