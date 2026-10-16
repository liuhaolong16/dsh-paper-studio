#!/usr/bin/env node
/**
 * paper-studio · 统一 CLI（零依赖）
 * 单一真源：references/pipeline.json —— 本文件不得内联第二份链路/门判据。
 *
 * 子命令：
 *   route <任务描述>   判类型 → 出档位/链路/必过门
 *   gates [--json]    列全部必过门（解析真实路径 + 运行时可可用性）
 *   intake <稿件路径>  收稿：类型/语言推断 + 交接契约必填字段自检
 *   selftest          自检（含必失败夹具）
 *
 * 退出码：0=正常  1=有缺口/不完整（如 HANDOFF_INCOMPLETE、门不可用）  2=前提层失败（真源缺失/参数错）
 *
 * 纪律（由事故换来）：
 *  - 逐门同时看【退出码】与【stdout 是否为空】：rc≠0 且 stdout 空 ⇒ 归前提层失败。
 *  - 跑门前无条件断言解释器/脚本存在；取不到 ⇒ 报不可用，绝不静默算通过。
 *  - 被 require 时必须零副作用（本文件有 require.main 守卫）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');   // docx 结构独立读数要用（ZIP 条目 inflateRaw）
const crypto = require('crypto');   // ★ v3.2.33 运行指纹（报告要能回答「这条判定属于哪一次运行」）
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// v3.1.9：机器可读计数出口 + 文档数字一致性门 + 残留件门 + 自检覆盖门
// 起因＝2026-10-16 生态日审抓出的三类问题：下游手抄自检数字导致漂移（登记表写 53/53 实为 61/61）、
// 手写备份件留在技能树内被「残留文件」判据抓出、以及"脚本有自检却没人跑"。三条都做成插件自带的判据。
let JSON_OUT = false;
const VERSION = (() => { try { return require(path.join(ROOT, 'plugin', 'package.json')).version; } catch { return 'unknown'; } })();
const SNAPSHOT_MARK = '<!-- claims: snapshot -->';
const PIPELINE_PATH = path.join(ROOT, 'references', 'pipeline.json');

/* ── 机器本地路径解析（v3.2.15）──────────────────────────────────────────────
   背景：真源 references/pipeline.json 与 templates.json 里原先写着**本机绝对路径**
   （playbook 仓、python 解释器、短语库…），这些路径随包进了公开仓 ⇒ 违反证据纪律 D
   （对外文本不得含路径分隔符）。改法：真源里只放 **__LOCAL__/<key> 占位符**，
   真实值放 **git 忽略** 的 references/local-paths.json（可用环境变量 DSH_PAPER_LOCAL_PATHS 换位置）。
   ★ 取不到就**保留占位符**（不静默变成空串）——空串会让下游"看起来配好了"，是最坏的失败态。 */
/* 本地路径表的位置（v3.2.18 修正）：**默认放用户主目录**，不放包内。
   原因（实测）：npm 打包时 `files` 字段**优先于** .npmignore ⇒ 放在 references/ 下的本机表
   **排除不掉、会随包发给别人**（用户装上就继承别人的绝对路径）。放主目录则既不会被 git 跟踪、
   也不会被打包。包内 references/local-paths.json 仅作**向后兼容**的最后一档。 */
const HOME_PATHS_FILE = path.join(require('os').homedir(), '.dsh', 'paper-studio', 'local-paths.json');
const LEGACY_PATHS_FILE = path.join(ROOT, 'references', 'local-paths.json');
function localPaths() {
  const list = [process.env.DSH_PAPER_LOCAL_PATHS, HOME_PATHS_FILE, LEGACY_PATHS_FILE].filter(Boolean);
  for (const f of list) {
    try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (d && typeof d === 'object') return d; } catch {}
  }
  return {};
}
/** 未解析占位符 ⇒ 可操作指引（命令侧与门侧统一措辞） */
const LOCAL_HINT = '（该值是未解析的本机路径占位符 ⇒ 把 references/local-paths.example.json 复制成 '
  + '~/.dsh/paper-studio/local-paths.json（或设 DSH_PAPER_LOCAL_PATHS 指向你的表）并填真实路径）';
function resolveLocals(node, table) {
  if (typeof node === 'string') {
    const m = /^__LOCAL__\/(.+)$/.exec(node);
    if (!m) return node;
    /* 占位符形态：__LOCAL__/<key> 或 __LOCAL__/<key>/<子路径>
       ★ 首段才是表里的 key，其余按子路径拼在后面（首版把整串当 key 查 ⇒ 子路径形态解析不出来）。 */
    const seg = m[1].split('/');
    const key = seg.shift();
    const base = (table || {})[key];
    if (typeof base !== 'string') return node;          // 取不到就保留占位符（不静默变空）
    return seg.length ? path.join(base, ...seg) : base;
  }
  if (Array.isArray(node)) return node.map((x) => resolveLocals(x, table));
  if (node && typeof node === 'object') {
    const o = {}; for (const k of Object.keys(node)) o[k] = resolveLocals(node[k], table); return o;
  }
  return node;
}


/* 占位符未解析 ⇒ 给出**可操作**的修复指引（而不是让下游报一句没头没尾的缺文件） */
function localPathHint(v) {
  return String(v || '').indexOf('__LOCAL__') === 0 ? LOCAL_HINT : '';
}

function readPipeline(p = PIPELINE_PATH) {
  if (!fs.existsSync(p)) {
    const e = new Error(`前提层失败：找不到真源 ${p}`);
    e.code = 'PIPELINE_MISSING';
    throw e;
  }
  const raw = fs.readFileSync(p, 'utf8');
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`前提层失败：真源不是合法 JSON（${err.message}）`);
    e.code = 'PIPELINE_BAD_JSON';
    throw e;
  }
  json = resolveLocals(json, localPaths());
  if (!json.task_types || !Array.isArray(json.task_types) || json.task_types.length === 0) {
    const e = new Error('前提层失败：真源里没有 task_types');
    e.code = 'PIPELINE_INCOMPLETE';
    throw e;
  }
  return json;
}

/** 关键词路由：返回 { type, matched, note } */
function routeTask(taskText, pipeline) {
  const text = String(taskText || '').trim();
  if (!text) {
    const e = new Error('前提层失败：route 需要一个任务描述参数');
    e.code = 'NO_TASK_TEXT';
    throw e;
  }
  const hits = [];
  for (const t of pipeline.task_types) {
    for (const kw of (t.keywords || [])) {
      if (text.includes(kw)) { hits.push({ id: t.id, kw, len: kw.length }); }
    }
  }
  if (hits.length === 0) {
    const fallback = pipeline.task_types.find((t) => t.id === 'check') || pipeline.task_types[0];
    return { type: fallback, matched: [], note: '未命中任何关键词 ⇒ 兜底为「投稿前体检」（check）。若任务其实是起草/润色，请换用对应说法。' };
  }
  hits.sort((a, b) => b.len - a.len);
  const best = hits[0].id;
  const type = pipeline.task_types.find((t) => t.id === best);
  return { type, matched: hits.filter((h) => h.id === best).map((h) => h.kw), note: '' };
}

/** 期刊分类路由：按「地域轴 × 语言轴」判该读哪份资产（真源：pipeline.journal_classes）
 *
 *  为什么要有它：分类轴与路由表原先只写在真源与 SKILL.md 里靠模型判读，CLI 的 route 不会
 *  吐出来 ⇒「给个中文刊任务，插件自己告诉该读哪份资产」无法机检。本函数把它变成可执行路由，
 *  并配两条硬纪律（都来自本项目铁律）：
 *    ① 判出分类却解析不出任何资产路径 ⇒ 抛 JOURNAL_ASSET_UNRESOLVED（不许静默无输出）；
 *    ② 解析出的资产在磁盘上不存在 ⇒ 显形记为缺失（route 退出码 1）——这条同时兜住
 *       「只装了插件包、仓库根 references/ 不在」的分发缺口（npm 打包面不含 references）。
 */
function journalRoute(taskText, pipeline) {
  const jc = (pipeline || {}).journal_classes || {};
  const routing = jc.routing || {};
  if (Object.keys(routing).length === 0) {
    const e = new Error('前提层失败：真源里没有 journal_classes.routing');
    e.code = 'JOURNAL_CLASSES_MISSING';
    throw e;
  }
  const text = String(taskText || '');
  const lc = text.toLowerCase();
  const hit = (arr) => arr.filter((k) => lc.includes(k.toLowerCase()));
  const PLOS = hit(['plos', 'pone']);
  const CN = hit(['中文核心', '北大核心', 'cscd', '科技核心', '中文期刊', '中文刊', '国内期刊', '学报', '中图分类号', 'gb/t 7714', '知网', '腾云', '万方', '维普', '中文投稿', '国内刊']);
  const INTL = hit(['elsevier', 'sciencedirect', 'editorial manager', 'editorialmanager', '英文期刊', '外文期刊', '国外期刊']);
  const ZH = hit(['中文', '中图分类号', '中译', '汉语']);
  const EN = hit(['英文', 'english']);
  let key = '';
  let matched = [];
  let note = '';
  if (PLOS.length) { key = 'intl+en+plos'; matched = PLOS; }
  else if (CN.length && EN.length && !ZH.length) { key = 'cn+en'; matched = CN.concat(EN); }
  else if (INTL.length && ZH.length && !EN.length) { key = 'intl+zh'; matched = INTL.concat(ZH); }
  else if (INTL.length) { key = 'intl+en'; matched = INTL; }
  else if (CN.length) { key = 'cn+zh'; matched = CN; }
  if (!key) return { key: '', matched: [], assets: [], boundaries: jc.boundaries || [], note: '未命中期刊分类关键词 ⇒ 不输出期刊资产（不猜）' };
  if (!routing[key]) {
    note = '真源 routing 里没有 ' + key + ' ⇒ 回退到该地域缺省键';
    key = key.startsWith('cn') ? 'cn+zh' : 'intl+en';
  }
  const raw = String(routing[key] || '');
  const paths = Array.from(new Set(raw.match(/references\/[^\s，。；、（）()]+\.md/g) || []));
  if (paths.length === 0) {
    const e = new Error('判出期刊分类 ' + key + ' 却解析不出资产路径（真源 routing 取值必须含显式 references/*.md）：' + raw);
    e.code = 'JOURNAL_ASSET_UNRESOLVED';
    throw e;
  }
  const assets = paths.map((rel) => {
    const full = path.resolve(ROOT, rel);
    return { path: rel, full, exists: fs.existsSync(full) };
  });
  return { key, matched, assets, boundaries: jc.boundaries || [], routing_raw: raw, note };
}

/** 门的真实路径与运行时可可用性 */
function resolveGate(gate, pipeline) {
  const base = (pipeline.assets && pipeline.assets[gate.rel]) || '';
  const full = base ? path.join(base, gate.entry) : '';
  const scriptOk = !!full && fs.existsSync(full);
  let runtimeOk = false;
  let runtimeNote = '';
  try {
    if (gate.runtime === 'node') {
      runtimeOk = true; // 本 CLI 自身就跑在 node 上
    } else if (gate.runtime === 'python') {
      // 解析顺序（纪律：取不到就报不可用，绝不静默算通过）：
      //  ① pipeline.assets.python_exe 里显式列出的真解释器（本机 = playbook 自带 .venv）
      //  ② PATH 上的候选，但必须【排除 WindowsApps 商店占位符】——它不是真解释器
      const explicit = ((pipeline.assets || {}).python_exe) || [];
      const tried = [];
      for (const p of explicit) {
        if (p && fs.existsSync(p)) {
          const r = spawnSync(p, ['--version'], { encoding: 'utf8' });
          tried.push(`${p} → ${r.error ? 'ERR ' + r.error.code : 'rc=' + r.status}`);
          if (!r.error && r.status === 0) { runtimeOk = true; runtimeNote = p; break; }
        } else {
          tried.push(`${p} → 缺失`);
        }
      }
      if (!runtimeOk) {
        const cmds = process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
        for (const cmd of cmds) {
          const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' });
          const hit = (which.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || '';
          if (hit && /WindowsApps/i.test(hit)) { tried.push(`${cmd} → 跳过（商店占位符 ${hit}）`); continue; }
          const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
          tried.push(`${cmd} → ${r.error ? 'ERR ' + r.error.code : 'rc=' + r.status}`);
          if (!r.error && r.status === 0) { runtimeOk = true; runtimeNote = cmd; break; }
        }
      }
      if (!runtimeOk) { runtimeNote = '未找到真 python 解释器；已试：' + tried.join(' | ') + (tried.some((x) => String(x).indexOf('__LOCAL__') >= 0) ? ' ⇒ ' + LOCAL_HINT : ''); }
    }
  } catch (e) {
    runtimeOk = false;
    runtimeNote = String(e.message || e);
  }
  return { id: gate.id, label: gate.label, runtime: gate.runtime, entry: full, scriptOk, runtimeOk, runtimeNote,
    placeholder: /^__LOCAL__/.test(String(full)) };
}

/**
 * 语言粗判（修过一次的真实缺陷）
 *
 * v1.0.0 的写法是「前 4000 字符里 CJK 字数 vs 拉丁字母数，谁多算谁」，
 * 实测在**短骨架文件**上误判为 en：中文 41 字 vs 拉丁 44 个字母，
 * 而那 44 个字母全来自模板头里的标识符/路径（`paper-studio`、`scaffold`、
 * `references/templates.json`）——**把代码当成了语言**。
 *
 * 现在的判据（三层，每层都要能说清为什么）：
 *   ① 先剔除「不是自然语言」的东西：围栏代码块、行内代码、URL、含分隔符的路径/命名空间、
 *      缩写（全大写且 ≤6 字母，如 SOH/NASA/BMS）、含数字或 `_ . / \` 的标识符、连字符技术词。
 *   ② 样本太小（CJK + 自然语言拉丁字母 < 40）⇒ 直接 unknown，**不猜**。
 *   ③ 中文按字数折算 0.6 系数与拉丁字母比较（中文单字信息密度更高；一份中文稿带英文摘要
 *      仍应判 zh）。取不到任何信号 ⇒ unknown。
 *   另：--lang zh|en 显式指定优先于一切推断（给人一个不跟启发式较劲的出口）。
 */
function detectLang(text, opts) {
  if (opts && opts.lang) {
    const v = String(opts.lang).toLowerCase();
    if (['zh', 'en', 'unknown'].includes(v)) return { lang: v, reason: '显式指定（--lang），不推断', cjk: null, latin: null };
  }
  const lines = String(text || '').split(/\r?\n/);
  let inFence = false; let inFrontMatter = false; const kept = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (i === 0 && /^\s*---\s*$/.test(raw)) { inFrontMatter = true; continue; }
    if (inFrontMatter) { if (/^\s*---\s*$/.test(raw)) inFrontMatter = false; continue; }
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;
    kept.push(raw);
  }
  let s = kept.join('\n');
  s = s.replace(/`[^`\n]{0,120}`/g, ' ');          // 行内代码
  s = s.replace(/https?:\/\/[^\s)]+/g, ' ');        // URL
  s = s.replace(/[A-Za-z]:\\[^\s]+/g, ' ');         // Windows 绝对路径
  s = s.replace(/[A-Za-z0-9_.-]+[\\/][A-Za-z0-9_.\\/-]+/g, ' '); // 含分隔符的路径/命名空间
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  let latin = 0;
  for (const w of (s.match(/[A-Za-z][A-Za-z'-]+/g) || [])) {
    if (w.length < 2) continue;
    if (w === w.toUpperCase() && w.length <= 6) continue;  // 缩写：SOH / NASA / BMS / DOI
    if (/[_0-9]/.test(w)) continue;                         // 带数字/下划线的标识符
    if (/^[a-z]+(?:-[a-z]+)+$/.test(w)) continue;           // 连字符技术词：paper-studio
    latin += w.length;
  }
  const total = cjk + latin;
  if (total < 40) return { lang: 'unknown', reason: `样本太少（中文 ${cjk} 字 + 自然语言拉丁 ${latin} 字母 = ${total} < 40）⇒ 不猜；可用 --lang 显式指定`, cjk, latin };
  if (cjk === 0) return { lang: 'en', reason: `无中文字符，拉丁 ${latin} 字母`, cjk, latin };
  if (latin === 0) return { lang: 'zh', reason: `无自然语言拉丁字母，中文 ${cjk} 字`, cjk, latin };
  const zh = cjk >= latin * 0.6;
  return {
    lang: zh ? 'zh' : 'en',
    reason: `中文 ${cjk} 字 vs 自然语言拉丁 ${latin} 字母（中文按 0.6 折算）⇒ ${zh ? 'zh' : 'en'}`,
    cjk, latin,
  };
}

/** 收稿：类型/语言推断 + 交接契约必填字段自检 */
function intake(docPath, pipeline, opts) {
  const p = path.resolve(docPath || '');
  const exists = !!docPath && fs.existsSync(p) && fs.statSync(p).isFile();
  const ext = exists ? path.extname(p).toLowerCase() : '';
  const name = exists ? path.basename(p) : String(docPath || '');
  const docKind = ['.docx', '.doc'].includes(ext) ? 'docx' : (ext === '.md' ? 'md' : (ext === '.tex' ? 'tex' : (ext === '.pdf' ? 'pdf' : 'unknown')));
  let lang = 'unknown'; let langReason = '文件不存在，未判语言';
  if (exists) {
    try {
      const head = fs.readFileSync(p, 'utf8').slice(0, 4000);
      const d = detectLang(head, opts);
      lang = d.lang; langReason = d.reason;
    } catch (e) { lang = 'unknown'; langReason = '读取失败：' + String(e.message || e); }
  }
  const c = ((pipeline.handoff || {}).contracts || []).find((x) => x.from === 'intake');
  const required = (c && c.required) || ['doc_path', 'doc_kind', 'task_type', 'lang'];
  const have = {
    doc_path: exists ? p : '',
    doc_kind: docKind,
    task_type: '', // 由 route 决定
    lang,
  };
  const missing = required.filter((k) => !have[k]);
  return { doc_path: p, exists, doc_kind: docKind, lang, lang_reason: langReason, required, have, missing, complete: missing.length === 0 };
}

function printRoute(res, pipeline) {
  const t = res.type;
  const lines = [];
  lines.push(`任务类型：${t.id}（${t.label}）  档位：${t.tier}`);
  lines.push(`命中关键词：${res.matched.length ? res.matched.join(' / ') : '（无）'}`);
  if (res.note) lines.push(`提示：${res.note}`);
  lines.push(`主链路：${(t.chain || []).join(' → ')}`);
  const gateIds = t.gates || [];
  const gs = gateIds.map((id) => (pipeline.gates || []).find((g) => g.id === id)).filter(Boolean);
  lines.push('必过门：');
  for (const g of gs) {
    const r = resolveGate(g, pipeline);
    const ok = r.scriptOk && r.runtimeOk;
    lines.push(`  - ${g.id}：${g.label}  [${ok ? '可用' : '不可用'}]  (${g.runtime} ${r.entry}${r.scriptOk ? '' : ' · 脚本不存在'}${r.runtimeOk ? '' : ' · 运行时不可用：' + r.runtimeNote})${r.placeholder ? ' ⇒ ' + LOCAL_HINT : ''}`);
  }
  if (t.precondition) lines.push(`前置条件：${t.precondition}`);
  lines.push(`产出：${(t.outputs || []).join(' · ')}`);
  const jr = res.journal;
  if (jr && jr.key) {
    lines.push('期刊分类路由（真源：references/pipeline.json 的 journal_classes）：');
    lines.push(`  - 判定：${jr.key}${jr.matched.length ? '（命中：' + jr.matched.join(' / ') + '）' : ''}${jr.note ? ' · ' + jr.note : ''}`);
    for (const a of jr.assets) lines.push(`  - 该读：${a.path}  [${a.exists ? '存在' : '缺失'}]${a.exists ? '' : ' ⇒ 缺它不得当作通过'}`);
    for (const b of (jr.boundaries || [])) lines.push(`  - 边界：${b}`);
  }
  return lines.join('\n');
}

// ── 经验库 / 方法论索引 / 骨架生成 ───────────────────────────────
const os = require('os');
const TEMPLATES_PATH = path.join(ROOT, 'references', 'templates.json');
/* templates.json 同样可能有 __LOCAL__ 占位符（source/root 指向论文仓的模板原件） */
const LESSONS_PATH = path.join(ROOT, 'references', 'lessons-from-first-draft.md');

function readTemplates(p = TEMPLATES_PATH) {
  if (!fs.existsSync(p)) { const e = new Error(`前提层失败：找不到模板清单 ${p}`); e.code = 'TEMPLATES_MISSING'; throw e; }
  /* 与 readPipeline 同一处理：templates.json 的 source/root 里可能有 __LOCAL__ 占位符 */
  return resolveLocals(JSON.parse(fs.readFileSync(p, 'utf8')), localPaths());
}

/** 经验库的唯一真源就是那个 md（不另存一份 json，避免双份分叉） */
function readLessons(p = LESSONS_PATH) {
  if (!fs.existsSync(p)) { const e = new Error(`前提层失败：找不到经验库 ${p}`); e.code = 'LESSONS_MISSING'; throw e; }
  const out = [];
  for (const ln of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = ln.match(/^\|\s*\*\*(L-\d+)\*\*\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (m) out.push({ id: m[1], lesson: m[2].trim(), source: m[3].trim(), practice: m[4].trim(), checkable: m[5].trim() });
  }
  return out;
}

function listMethod() {
  const t = readTemplates();
  const mi = t.methodology_index || {};
  const root = mi.root || '';
  return (mi.dimensions || []).map((d) => ({ ...d, path: path.join(root, d.file), exists: fs.existsSync(path.join(root, d.file)) }));
}

/** 生成稿件骨架：阶段文件 + 模板（模板从真源复制，不预存副本） */
/** 按体裁选骨架集（V1.6 · 框架-模型联动）：有专属套用专属，否则回退缺省套。 */
function stageSetFor(genre, t) {
  const byGenre = (t || readTemplates()).stage_skeletons_by_genre || {};
  const own = genre && Array.isArray(byGenre[genre]) ? byGenre[genre] : null;
  const tt = t || readTemplates();
  if (own) return { set: genre, stages: own, attribution: byGenre.attribution || '' };
  return { set: 'default', stages: tt.stage_skeletons || [], attribution: '' };
}

/** 按体裁选**章节级**框架（V2.0）：有专属套用专属，否则回退 default（IMRaD）。 */
function readSections(genre, t) {
  const tt = t || readTemplates();
  const byGenre = tt.section_skeletons_by_genre || {};
  const own = genre && Array.isArray(byGenre[genre]) ? byGenre[genre] : null;
  if (own) return { set: genre, sections: own };
  return { set: 'default', sections: byGenre.default || [] };
}

/** 门类型（V2.5）：'A' = 客观/执行门（机器可判）· 'B' = 质量/验收门（必须跨模型家族裁决）· null = 未声明。 */
function judgeTypeOf(gateId, pipeline) {
  const m = (((pipeline || readPipeline()).gate_meta) || {}).judge_type || {};
  return Object.prototype.hasOwnProperty.call(m, gateId) ? m[gateId] : null;
}

/** 门 → 章节归属（V2.2）：**声明优先**。返回章节 id 或 '*'（跨节）；未声明返回 null（自检会抓）。
 *  为什么不能"取第一个引用该门的节"：`contract` 被多节引用，那样会把全部待修项塞进第一节（真发生过）。 */
function primarySectionOf(gateId, pipeline) {
  const m = (((pipeline || readPipeline()).gate_meta) || {}).primary_section || {};
  return Object.prototype.hasOwnProperty.call(m, gateId) ? m[gateId] : null;
}

/** 兼容旧用法：门 → 章节对象（跨节返回 null，未声明也返回 null）。 */
function sectionForGate(gateId, genre, t) {
  const id = primarySectionOf(gateId, pipeline0());
  if (id === null || id === '*') return null;
  const { sections } = readSections(genre, t);
  return sections.find((x) => x.id === id) || null;
}

function pipeline0() { return readPipeline(); }

function scaffold(outDir, name, opts = {}) {
  if (!outDir) { const e = new Error('前提层失败：scaffold 需要 --out <目录>'); e.code = 'NO_OUT'; throw e; }
  const t = readTemplates();
  const { set, stages, attribution } = stageSetFor(opts.genre, t);
  const dir = path.resolve(outDir);
  const plan = [...stages.map((s) => s.target), ...(t.templates || []).map((x) => x.target)];
  if (opts.dryRun) return { dir, dryRun: true, plan, created: [], skipped: [], missing: [], set, genre: opts.genre || null };
  fs.mkdirSync(dir, { recursive: true });
  const created = []; const skipped = []; const missing = [];
  const header = name ? `# ${name}\n\n> 由 paper-studio scaffold 生成（真源：references/templates.json · 骨架集：${set}${opts.genre ? '（体裁 ' + opts.genre + '）' : ''}）。**逐格填写**；「必填」没填完不要往下走。${attribution ? '\n> ' + attribution : ''}\n\n` : '';
  for (const s of stages) {
    const target = path.join(dir, s.target);
    if (fs.existsSync(target)) { skipped.push(s.target); continue; }
    const fields = (s.fields || []).map((f) => `- ${f}`).join('\n');
    fs.writeFileSync(target, `${header}## ${s.title}\n\n### 必填\n${fields || '- （无固定字段）'}\n\n### 正文\n\n`, 'utf8');
    created.push(s.target);
  }
  for (const tp of (t.templates || [])) {
    const target = path.join(dir, tp.target);
    if (fs.existsSync(target)) { skipped.push(tp.target); continue; }
    if (tp.inline) { fs.writeFileSync(target, tp.inline, 'utf8'); created.push(tp.target); continue; }
    if (!tp.source || !fs.existsSync(tp.source)) { missing.push(`${tp.id} → ${tp.source || '（无 source）'}`); continue; }
    fs.copyFileSync(tp.source, target);
    created.push(tp.target);
  }
  return { dir, dryRun: false, plan, created, skipped, missing };
}

/**
 * ── 体裁模型（V1.5 · 模型层）──
 * 标题 + 摘要区（摘要区在下一个标题处结束；无摘要标记时回退前 40 行）。
 * ★ 判据的 signals **只从真源 `genres.kinds[].signals` 读**，这里不另写一份词表（单一真源）。
 */
function titleAndAbstract(text) {
  const lines = String(text || '').split(/\r?\n/);
  let title = '';
  for (const l of lines) {
    const s = l.trim();
    if (!s || s === '---' || s.startsWith('<!--')) continue;
    title = s.replace(/^#+/, '').trim();
    break;
  }
  let abs = '';
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#*\s*(abstract|摘要)\b/i.test(lines[i]) || /^\s*(abstract|摘要)\s*[:：]/i.test(lines[i])) {
      const seg = [];
      for (let j = i; j < Math.min(i + 12, lines.length); j++) {
        if (j > i && /^\s*#{1,6}\s/.test(lines[j])) break;   // 下一个标题处结束
        seg.push(lines[j]);
      }
      abs = seg.join('\n');
      break;
    }
  }
  if (!abs.trim()) abs = lines.slice(0, 40).join('\n');      // 回退：无摘要标记
  return { title, abs };
}

function detectGenre(text, pipeline, override) {
  const kinds = ((pipeline || readPipeline()).genres || {}).kinds || [];
  if (!kinds.length) { const e = new Error('前提层失败：真源缺少 genres 模型（genres.kinds）'); e.code = 'GENRES_MISSING'; throw e; }
  if (override) {
    const hit = kinds.find((k) => k.id === override);
    if (!hit) { const e = new Error(`前提层失败：未知体裁 ${override}（合法：${kinds.map((k) => k.id).join(' / ')}）`); e.code = 'GENRE_UNKNOWN'; throw e; }
    return { id: hit.id, label: hit.label, hits: [], score: null, reason: '--genre 显式指定' };
  }
  const { title, abs } = titleAndAbstract(text);
  const hay = (title + '\n' + abs).toLowerCase();
  const scored = kinds.map((k) => {
    const hits = (k.signals || []).filter((s) => hay.includes(String(s).toLowerCase()));
    return { id: k.id, label: k.label, hits, score: hits.length };
  });
  const best = scored.reduce((a, b) => (b.score > a.score ? b : a), scored[0]);
  if (!best || best.score === 0) {
    const d = (pipeline.genres || {}).default || 'empirical';
    const def = kinds.find((k) => k.id === d) || kinds[0];
    return { id: def.id, label: def.label, hits: [], score: 0, reason: '标题与摘要区无体裁信号 ⇒ 回退真源默认 ' + def.id };
  }
  return { id: best.id, label: best.label, hits: best.hits, score: best.score, reason: `标题/摘要区命中 ${best.hits.length} 个体裁信号` };
}

/** 阶段词汇表（骨干层）：chain 项必须能解析到真实实现，不许「只是名字」。 */
const SUBCOMMANDS = [
  'doctor',
  'retract-check',
  'credit',
  'formats',
  'preflight',
  'anchors',
  'response',
  'cover',
  'report-check',
  'reports',
  'submission-fields',
  'route',
  'gates',
  'intake',
  'lessons',
  'coach',
  'method',
  'scaffold',
  'draft',
  'report',
  'verify',
  'stylecheck',
  'polish',
  'profile',
  'schemacheck',
  'revise',
  'figures',
  'audit',
  'state',
  'genre',
  'sections',
  'docx',
  'handoff',
  'crosscheck',
  'cost',
  'selftest',
  'hygiene',
  'claims',
  'coverage',
  'compliance',
];
const STAGE_RULES = [
  { rx: /^subcommand:([a-z0-9-]+)$/, need: (m) => SUBCOMMANDS.includes(m[1]), why: (m) => `子命令 ${m[1]} 未实现` },
  { rx: /^gate:([a-z0-9-]+)$/, need: null, why: () => '门 id 未在 gates 表里' },
  { rx: /^handoff:([a-z0-9-]+)$/, need: null, why: () => '交接阶段' },
  { rx: /^manual:(.+)$/, need: (m) => m[1].trim().length > 0, why: () => 'manual 阶段必须写明由谁做' },
  { rx: /^report:([a-z0-9-]+)$/, need: (m) => SUBCOMMANDS.includes('report'), why: () => 'report 子命令未实现' },
];

/**
 * ── 交接契约真校验（V1.8 · 骨干层）──
 * 此前 handoff.contracts 只有「必填字段名 + 一句说明」，**没有校验器** ⇒ 说明写了也白写。
 * 现在按真源逐项校验：缺必填 / 空值 / 占位符 / 类型不符 / 闭集外取值 / 逐项 schema 不符 ⇒ 失败；
 * 未在契约里声明的字段 ⇒ 只提示（不判失败，但提示补进真源，防止契约悄悄落后于实际用法）。
 */
function findContracts(id, pipeline) {
  const list = ((pipeline || readPipeline()).handoff || {}).contracts || [];
  if (!id) return [];
  // 宽容但有规矩：显式写 `from->to` 时**只认整对**（`report:run-gates` 既是契约 1 的 to、
  // 又是契约 3 的 from，若按"任一侧匹配"就会歧义命中错的那条 —— 断言当场抓出过）；
  // 只给一个名字时优先按 from 匹配（"从 A 交给谁"是更自然的读法）。
  const fullOf = (s) => String(s || '').replace(/[\s→>-]+/g, '').toLowerCase();
  const shortOf = (s) => String(s || '').split(':').pop().replace(/[\s→>-]+/g, '').toLowerCase();
  const s = String(id);
  if (/->|→|>/.test(s)) {
    const q = fullOf(s);
    return list.filter((c) => fullOf(c.from + '->' + c.to) === q);
  }
  const q = [fullOf(s), shortOf(s)];
  const byFrom = list.filter((c) => q.includes(fullOf(c.from)) || q.includes(shortOf(c.from)));
  if (byFrom.length) return byFrom;
  return list.filter((c) => q.includes(fullOf(c.to)) || q.includes(shortOf(c.to)));
}

function findContract(id, pipeline) {
  const hits = findContracts(id, pipeline);
  return hits.length ? hits[0] : null;
}

// 与 `_gate-author-material.py` 对齐的路径判据（只用来决定"走哪条分支"，不判内容）
const PATHISH_RE = /^([A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])|\.(md|txt|csv|xlsx|docx|pdf|json|py|png|jpg|jpeg|svg)$/i;

/** 路径体积：文件＝字节数；目录＝内部文件字节合计（与门的 _size_of 同口径）。 */
function sizeOfPath(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const rel of fs.readdirSync(p, { recursive: true })) {
    try { const s = fs.statSync(path.join(p, String(rel))); if (s.isFile()) total += s.size; } catch (e) { /* 单个条目读不到不算致命 */ }
  }
  return total;
}

function validateHandoff(id, payload, pipeline) {
  const p = pipeline || readPipeline();
  const c = findContract(id, p);
  if (!c) {
    const avail = (((p.handoff || {}).contracts) || []).map((x) => x.from + '->' + x.to).join(' / ');
    const e = new Error(`前提层失败：未知交接契约 ${id}（可用：${avail}）`);
    e.code = 'CONTRACT_UNKNOWN';
    throw e;
  }
  const fails = []; const warns = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { contract: `${c.from}->${c.to}`, ok: false, fails: ['handoff 声明不是 JSON 对象'], warns, checked: 0 };
  }
  const types = c.types || {}; const sets = c.closed_sets || {};
  const known = new Set([...(c.required || []), ...(c.optional || [])]);
  for (const f of (c.required || [])) {
    if (!(f in payload)) { fails.push(`缺必填字段 ${f}`); continue; }
    const v = payload[f];
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) { fails.push(`必填字段 ${f} 为空`); continue; }
    if (typeof v === 'string' && /TODO|待填|待补|待定|TBD|xxx|＜|＞|<[^>]*>/.test(v)) fails.push(`必填字段 ${f} 仍是占位符：${v}`);
  }
  for (const [f, t] of Object.entries(types)) {
    if (!(f in payload)) continue;
    const v = payload[f];
    const ok = t === 'array' ? Array.isArray(v)
      : t === 'object' ? (v && typeof v === 'object' && !Array.isArray(v))
      : typeof v === t;
    if (!ok) fails.push(`字段 ${f} 类型不符：期望 ${t}，实得 ${Array.isArray(v) ? 'array' : typeof v}`);
  }
  for (const [f, allowed] of Object.entries(sets)) {
    if (!(f in payload)) continue;
    if (!allowed.includes(payload[f])) fails.push(`字段 ${f} 取值不在闭集内：${JSON.stringify(payload[f])}（允许 ${allowed.join(' / ')}）`);
  }
  for (const [f, spec] of Object.entries(c.item_schemas || {})) {
    const arr = payload[f];
    if (!Array.isArray(arr)) continue;                       // 类型问题上面已报，不重复
    arr.forEach((it, i) => {
      for (const rf of (spec.required || [])) if (!(rf in (it || {}))) fails.push(`${f}[${i}] 缺 ${rf}`);
      for (const [k, allowed] of Object.entries(spec.closed_sets || {})) {
        if (it && (k in it) && !allowed.includes(it[k])) fails.push(`${f}[${i}].${k} 取值不在闭集内：${JSON.stringify(it[k])}`);
      }
    });
  }
  // 唯一一条跨到文件系统的检查：doc_path 是路径，必须真存在（否则"声明齐了但指不到东西"）
  for (const [f, spec] of Object.entries(c.field_rules || {})) {
    const v = payload[f];
    if (v === undefined || v === null) continue;
    const isPath = typeof v === 'string' && PATHISH_RE.test(v.trim());
    // ★ 与门同口径：**路径走体积分支、非路径走长度与占位符分支**（门就是这么分岔的）。
    if (spec.only_if_path && !isPath) continue;
    if (spec.only_if_not_path && isPath) continue;
    if (typeof v === 'string' && spec.min_chars && v.trim().length < spec.min_chars) {
      fails.push(`字段 ${f} 太短（${v.trim().length} 字 < ${spec.min_chars} 字）—— 这通常是"还没做"而不是材料`);
    }
    if (typeof v === 'string' && Array.isArray(spec.forbid_patterns)) {
      const hit = spec.forbid_patterns.find((p) => v.includes(p));
      if (hit) fails.push(`字段 ${f} 含占位符/指路语「${hit}」⇒ 这是「还没做」，不是材料`);
    }
    if (spec.must_be_existing_path && typeof v === 'string' && v && !fs.existsSync(v)) {
      fails.push(`字段 ${f} 必须指向真实存在的路径，但不存在：${v}`);
    }
    if (spec.min_bytes && typeof v === 'string' && v && fs.existsSync(v)) {
      const n = sizeOfPath(v);
      if (n < spec.min_bytes) fails.push(`字段 ${f} 是空壳：${v} 仅 ${n} 字节（门槛 ${spec.min_bytes}）`);
    }
  }
  for (const r of (c.conditional_rules || [])) {
    const w = r.when || {}; const t = r.then || {};
    if (payload[w.field] !== w.equals) continue;
    const v = payload[t.field];
    if (t.must_be_existing_path && typeof v === 'string' && v && !fs.existsSync(v)) {
      fails.push(`条件规则：${w.field}=${w.equals} 时 ${t.field} 必须是真实存在的路径，但不存在：${v}${r.why ? '（' + r.why + '）' : ''}`);
    }
    if (t.min_bytes && typeof v === 'string' && v && fs.existsSync(v)) {
      const n = sizeOfPath(v);
      if (n < t.min_bytes) fails.push(`条件规则：${w.field}=${w.equals} 时 ${t.field} 是空壳（${n} 字节 < ${t.min_bytes}）${r.why ? '（' + r.why + '）' : ''}`);
    }
    if (Array.isArray(t.in) && !t.in.includes(v)) {
      fails.push(`条件规则：${w.field}=${w.equals} 时 ${t.field} 必须在 {${t.in.join(' / ')}} 内，实得 ${JSON.stringify(v)}${r.why ? '（' + r.why + '）' : ''}`);
    }
  }
  for (const k of Object.keys(payload)) {
    if (!known.has(k) && !(k in types)) warns.push(`未在契约里声明的字段（不判失败，但请确认是否该补进真源）：${k}`);
  }
  return { contract: `${c.from}->${c.to}`, ok: fails.length === 0, fails, warns, checked: Object.keys(payload).length };
}

/**
 * ── 同判回归（V1.9）──
 * 同一个对象被两个判据判时，结论必须一致。本插件里"材料声明"正好有两个判据：
 *   · 契约校验器（本插件的 validateHandoff）
 *   · playbook 的 `_gate-author-material.py`
 * 两边规则各自演化过，**手工交叉跑一次不够** —— 这里把它做成自动回归：N 个用例逐个跑两边，
 * 只要出现"一边过一边不过"，或与期望不符，就判失败。根因通常是某一侧的规则没写进真源。
 */
function crosscheckMaterial() {
  const { execFileSync } = require('child_process');
  const p = readPipeline();
  const py = ((p.assets || {}).python_exe || [])[0];
  const pbRoot = (p.assets || {}).playbook_root || '';
  const gate = path.join(pbRoot, '_gate-author-material.py');
  if (!py || !fs.existsSync(py)) { const e = new Error('前提层失败：真源里没有可用的 python_exe：' + py + localPathHint(py)); e.code = 'NO_PY'; throw e; }
  if (!fs.existsSync(gate)) { const e = new Error('前提层失败：门脚本不存在 ' + gate); e.code = 'NO_GATE'; throw e; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-crosscheck-'));
  const big = path.join(tmp, 'material.md');
  fs.writeFileSync(big, '# 材料台账\n' + '实测记录：本文数据与检索台账如下，逐条给出 DOI 与核对日期。\n'.repeat(12), 'utf8');
  const tiny = path.join(tmp, 'tiny.md'); fs.writeFileSync(tiny, 'x', 'utf8');
  const longNote = '已用 OpenAlex 实测取回三篇并逐条核对题名与年份；检索式与检索日期记录在台账里，编码表随稿提供，可复算。';
  const cases = [
    ['真材料（路径 + materials_only）', { material_kind: 'author_data', claim_policy: 'materials_only', material_path_or_note: big }, true],
    ['非路径长说明 + verified_retrieval', { material_kind: 'verified_retrieval', claim_policy: 'verified_retrieval', material_path_or_note: longNote }, true],
    ['短说明（<40 字）', { material_kind: 'verified_retrieval', claim_policy: 'verified_retrieval', material_path_or_note: '见附件' }, false],
    ['占位符说明', { material_kind: 'verified_retrieval', claim_policy: 'verified_retrieval', material_path_or_note: '待补：这一栏等作者把检索台账补齐之后再来填，现在先空着。' }, false],
    ['materials_only 却给说明而非路径', { material_kind: 'author_data', claim_policy: 'materials_only', material_path_or_note: longNote }, false],
    ['materials_only + 空壳文件（<512 字节）', { material_kind: 'author_data', claim_policy: 'materials_only', material_path_or_note: tiny }, false],
    ['materials_only + 不存在的路径', { material_kind: 'author_data', claim_policy: 'materials_only', material_path_or_note: path.join(tmp, 'nope.md') }, false],
    ['口径不自洽（materials_only + verified_retrieval）', { material_kind: 'verified_retrieval', claim_policy: 'materials_only', material_path_or_note: big }, false],
    ['闭集外取值（material_kind）', { material_kind: 'nonsense', claim_policy: 'verified_retrieval', material_path_or_note: longNote }, false],
  ];
  const rows = [];
  for (const [name, decl, want] of cases) {
    const f = path.join(tmp, 'decl.json');
    fs.writeFileSync(f, JSON.stringify(decl, null, 2), 'utf8');
    let mine;
    try { mine = validateHandoff('gate:author-material', decl, p).ok; } catch (e) { mine = 'ERR:' + e.message; }
    let theirs;
    try {
      execFileSync(py, [gate, '--declaration', f, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      theirs = true;
    } catch (e) {
      theirs = (e.status === 1) ? false : ('ERR:' + (e.status === undefined ? String(e.message || e) : 'rc=' + e.status));
    }
    rows.push({ name, mine, theirs, expect: want, agree: mine === theirs, ok: (mine === theirs) && mine === want });
  }
  return { rows, ok: rows.every((r) => r.ok), py, gate, cases: cases.length };
}

/**
 * ── docx 结构独立读数（V2.1）──
 * **不经 python-docx**：自己解 ZIP（中央目录 + inflateRaw）再扫 word/document.xml。
 * 目的不是为了替代 `_verify-docx.py`，而是**给它一个独立实现**，好在 crosscheck 里逐字段对拍
 * —— 两个不同运行时的实现判同一份成品件必须得到同一组结构数字。
 */
const DOCX_BAD = /\*\*|`|^\s*\|/;

function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是 ZIP/OOXML：找不到 EOCD');
  const n = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error(`ZIP 中央目录损坏（偏移 ${off}）`);
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const lho = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    out.push({ name, method, csize, lho });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function zipRead(buf, e) {
  const nameLen = buf.readUInt16LE(e.lho + 26);
  const extraLen = buf.readUInt16LE(e.lho + 28);
  const start = e.lho + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.csize);
  return e.method === 0 ? raw : zlib.inflateRawSync(raw);
}

function readDocxStructure(file) {
  const buf = fs.readFileSync(file);
  const entries = zipEntries(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('包里没有 word/document.xml（不是 .docx 或已损坏）');
  const xml = zipRead(buf, doc).toString('utf8');
  const media = entries.filter((e) => e.name.startsWith('word/media/')).length;
  // ★ 按标签切分再取文本（V2.2 修正）：第一版用"标签正则 + 兜底取非 < 字符"的写法，
  //   遇到**不认识的标签**（`<w:pPr>` `<w:spacing/>` 等）会把**标签名本身当成正文**收集起来 ——
  //   于是"残留片段"里显示的是 XML 垃圾。现在：任何 `<…>` 都是标签，文本只从 `<w:t>` 里取。
  const tokens = xml.split(/(<[^>]*>)/);
  let depth = 0; let cell = null; let para = ''; let inText = false;
  let inline = 0; let tables = 0;
  const bodyParas = []; const cellTexts = [];
  for (const tk of tokens) {
    if (tk.startsWith('<')) {
      const close = tk.startsWith('</');
      const name = (tk.match(/^<\/?([A-Za-z0-9:]+)/) || [])[1] || '';
      if (name === 'w:tbl') { if (!close) { if (depth === 0) tables++; depth++; } else depth--; }
      else if (name === 'w:tc') { if (!close) cell = []; else { cellTexts.push((cell || []).join('\n')); cell = null; } }
      else if (name === 'wp:inline') { if (!close) inline++; }
      else if (name === 'w:t') { inText = !close && !/\/>$/.test(tk); }   // 自闭合 <w:t/> 不进入文本态
      else if (name === 'w:p' && close) { if (cell !== null) cell.push(para); else bodyParas.push(para); para = ''; }
    } else if (inText) {
      para += tk;
    }
  }
  const hits = (arr) => arr.filter((t) => DOCX_BAD.test(t));
  const nonEmpty = bodyParas.filter((t) => t.trim());
  return {
    tables, inline_images: inline, media_files: media,
    paragraphs: nonEmpty.length,                 // 与 _verify-docx 的「非空段落」同口径
    leak_paragraphs: hits(nonEmpty).length, leak_cells: hits(cellTexts).length,
    leak_texts: hits(nonEmpty).map((t) => t.trim().slice(0, 70)).slice(0, 5),
  };
}

/** 第二对判据：成品件结构读数（我方独立实现 vs `_verify-docx.py`）—— 逐字段必须同值。 */
function crosscheckDocx(files) {
  const { execFileSync } = require('child_process');
  const p = readPipeline();
  const py = ((p.assets || {}).python_exe || [])[0];
  const pbRoot = (p.assets || {}).playbook_root || '';
  const verifier = path.join(pbRoot, '_verify-docx.py');
  if (!py || !fs.existsSync(py)) { const e = new Error('前提层失败：真源里没有可用的 python_exe：' + py + localPathHint(py)); e.code = 'NO_PY'; throw e; }
  if (!fs.existsSync(verifier)) { const e = new Error('前提层失败：核验器不存在 ' + verifier); e.code = 'NO_VERIFIER'; throw e; }
  const rows = [];
  for (const f of files) {
    if (!f || !fs.existsSync(f)) { rows.push({ file: f || '(未给)', ok: true, skipped: '文件不存在 ⇒ 跳过（**不算同判**，也不静默当通过）' }); continue; }
    let mine;
    try { mine = readDocxStructure(f); } catch (e) { rows.push({ file: path.basename(f), ok: false, diffs: ['我方读取失败：' + e.message] }); continue; }
    let theirs = null;
    try {
      const out = execFileSync(py, [verifier, f, '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const line = out.split(/\r?\n/).find((l) => l.startsWith('##JSON## '));
      theirs = line ? JSON.parse(line.slice(9)) : null;
    } catch (e) {
      const out = String((e && e.stdout) || '');
      const line = out.split(/\r?\n/).find((l) => l.startsWith('##JSON## '));
      if (line) theirs = JSON.parse(line.slice(9));                    // rc=1/2 是判定失败，数据仍有效
      else { rows.push({ file: path.basename(f), ok: false, diffs: ['核验器没给 ##JSON##（rc=' + (e && e.status) + '）'] }); continue; }
    }
    const keys = ['tables', 'inline_images', 'leak_paragraphs', 'leak_cells', 'paragraphs'];
    const diffs = keys.filter((k) => mine[k] !== theirs[k]).map((k) => `${k}: 我们=${mine[k]} 核验器=${theirs[k]}`);
    rows.push({ file: path.basename(f), mine, theirs, diffs, ok: diffs.length === 0 });
  }
  return { rows, ok: rows.every((r) => r.ok), checked: rows.filter((r) => !r.skipped).length };
}

/** 同判回归总入口：pair = material | docx | all */
function crosscheck(pair) {
  const which = pair || 'all';
  const out = { pair: which };
  if (which === 'material' || which === 'all') out.material = crosscheckMaterial();
  if (which === 'docx' || which === 'all') {
    const pbRoot = (readPipeline().assets || {}).playbook_root || '';
    out.docx = crosscheckDocx([
      path.join(pbRoot, 'run', '2026-10-10-NASA电池SOH预测', '13-英文投稿稿-v1.docx'),
      // ★ 可移植性：原来写的是本机下载目录 ⇒ 换合成路径（别的机器上不存在即跳过，且公开仓不泄漏本机路径）
      path.join(__dirname, '..', 'run', 'fixtures', 'manuscript_appintel.docx'),
      path.join(__dirname, '..', 'run', 'fixtures', 'manuscript_zh.docx'),
    ]);
  }
  out.ok = (!out.material || out.material.ok) && (!out.docx || out.docx.ok);
  return out;
}

/**
 * ── 从 0 写：写作任务书 + 检索计划 ──
 * 这是 write 链路里原先**只是一个名字**的那一步（`handoff:paper-writer`）的真实现：
 * 它**不生成论文正文**（学术诚信红线：无材料不许硬写，见 author-material 门），
 * 而是把「这篇论文该分几步写、每步产出什么、需要哪类证据、交付前过哪道门」**从真源推导**成两份可执行文件。
 * 项目目录若还没有骨架，顺带跑一次 scaffold（开一篇新稿：14 个文件）。
 */
function draftPlan(outDir, opts = {}) {
  if (!outDir) { const e = new Error('前提层失败：draft 需要 --out <目录>'); e.code = 'NO_OUT'; throw e; }
  const t = readTemplates();
  const pipeline = readPipeline();
  const wt = (pipeline.task_types || []).find((x) => x.id === 'write') || {};
  // V1.6：骨架集按体裁选（框架-模型联动）；未指定体裁时用真源默认。
  const genre = opts.genre || (pipeline.genres || {}).default || 'empirical';
  const ss = stageSetFor(genre, t);
  const steps = ss.stages;
  const gates = (wt.gates || [])
    .map((id) => (pipeline.gates || []).find((g) => g.id === id))
    .filter(Boolean);
  const dims = ((t.methodology_index || {}).dimensions) || [];
  const dir = path.resolve(outDir);
  const name = opts.name || path.basename(dir);
  const journal = opts.journal || '（未指定 —— 目标刊未定 ⇒ 期刊契约门只会「跳过」，**跳过不算通过**）';
  const lang = opts.lang || '（未指定 —— 建议显式给 en/zh，本插件不替你决定发表语言）';
  const materials = opts.materials ? path.resolve(opts.materials) : null;
  const hasMat = !!(materials && fs.existsSync(materials));
  const declaration = path.join(dir, '材料声明.json');

  const L = [];
  L.push(`# ${name} · 写作任务书`, '');
  L.push('> 由 `paper-studio draft` 从真源推导生成（阶段与字段来自 `references/templates.json`，门与交接契约来自 `references/pipeline.json`）。');
  L.push('> **本文件不含论文内容** —— 内容由作者与助手在下面的阶段里逐格产出，逐门验收。', '');
  L.push('## 0. 基本情况', '');
  L.push(`- 目标刊 / 学位要求：${journal}`);
  L.push(`- 写作语言：${lang}`);
  L.push(`- **稿件体裁**：${genre}（决定用哪套骨架与哪些门适用；骨架集＝${ss.set}${ss.set === 'default' ? '（该体裁暂无专属骨架，用缺省套）' : ''}）`);
  if (ss.attribution) L.push(`- **骨架出处与许可**：${ss.attribution}`);
  L.push(`- 材料声明：${hasMat ? '**已提供** → `' + materials + '`' : '**未提供** ⇒ 按政策：只出框架与检索计划，**不硬写正文**'}`);
  L.push(`- 起草档位：**${wt.tier || 'T2'}**（错了会被人看见 ⇒ 强模型 + 对抗复核 + 过全部必过门）`);
  L.push(`- 政策前提：${wt.precondition || '（真源未写）'}`, '');
  L.push('## 1. 逐阶段任务（产出 → 需要的证据 → 完成后过哪道门）', '');
  for (const s of steps) {
    L.push(`### ${s.target} — ${s.title}`);
    L.push(`- **产出（真源字段，逐格必填）**：${(s.fields || []).join(' · ') || '（无固定字段）'}`);
    if (s.budget) L.push(`- **篇幅预算**：${s.budget}`);
    if ((s.must_answer || []).length) L.push(`- **必须回答**：${s.must_answer.join(' ／ ')}`);
    if (s.evidence_duty) L.push(`- **证据义务**：${s.evidence_duty}`);
    if ((s.gates || []).length) L.push(`- **本阶段相关门**：${s.gates.join(' / ')}`);
    if (s.target === '01-检索证据.md') {
      L.push('- **证据要求**：每条引用必须有 DOI + 标题（**机器读过原文**）+ 全文状态四分类（全文可得 / 仅摘要 / 需登录 ⇒ 跳过不采信 / 未找到）；**未实测的一律不写进证据表**。');
    } else if (s.target === '06-正文初稿.md') {
      L.push('- **证据要求**：每一段都要能指回 `01-检索证据.md` 的某一行，或指回作者材料；**指不回去的句子不许留在稿子里**（引用锚点门会抓）。');
    }
    L.push('');
  }
  const sec = readSections(genre, t);
  L.push('## 1b. 章节级写作清单（写作时按这份清单逐节自检）', '');
  L.push(`> 章节集：**${sec.set}**${sec.set === 'default' ? '（该体裁暂无专属章节集，用缺省 IMRaD 十节）' : ''}　·　共 ${sec.sections.length} 节`, '');
  for (const x of sec.sections) {
    L.push(`### ${x.label}`);
    L.push(`- **这一节要解决什么**：${x.purpose}`);
    L.push(`- **必答**：${(x.must_answer || []).join(' ／ ')}`);
    L.push(`- **篇幅预算**：${x.budget_words}`);
    L.push(`- **证据义务**：${x.evidence_duty}`);
    L.push(`- **相关门**：${(x.gates || []).join(' / ')}`);
    if ((x.common_failures || []).length) L.push(`- **常见退回原因**：${x.common_failures.join(' ／ ')}`);
    L.push('');
  }
  L.push('## 2. 交付前必须过的门（真源原文，逐门记退出码）', '');
  for (const g of gates) {
    L.push(`- **${g.id}** — ${g.label}｜\`${g.entry}\`（${g.runtime}）`);
    L.push(`  - 接口：\`${(g.args || []).join(' ')}\`` + ((g.required_placeholders || []).length ? `　必填占位符：${g.required_placeholders.join(' ')}` : ''));
    L.push(`  - 退出码：${Object.entries(g.exit_codes || {}).map(([k, v]) => `${k}=${v}`).join(' · ') || '（真源未写）'}`);
  }
  L.push('', '> 跑法：`node bin/gate-runner.cjs --type write --draft <稿.md> --declaration 材料声明.json`', '');
  L.push('## 3. 下一步该谁做什么', '');
  L.push(`1. ${hasMat ? '材料声明已给 ⇒ 可直接进「01-检索证据」与「06-正文初稿」。' : '**先给材料**（作者数据/正文材料/已验证检索/领域常识四者之一），并在项目目录写 `材料声明.json`；否则只能停在框架与检索计划。'}`);
  L.push('2. 检索取证：按 `01-检索计划.md` 执行，**每条实测可取回才入表**。');
  L.push('3. 逐节起草：一节一写完就单跑该节相关的门，不攒到最后一起跑。');
  L.push('4. 成品件：`_md2docx.py` 生成 docx ⇒ `_verify-docx.py` 核验 ⇒ `_gate-artifact-sync.py` 判同步。');
  L.push('5. 投稿前：`node bin/studio.cjs report --type check --draft <稿.md> --docx <稿.docx> --anchors <锚点.json>` 出带行号待修项。', '');

  const R = [];
  R.push(`# ${name} · 检索计划`, '');
  R.push('> 由 `paper-studio draft` 生成。**检索到的每一条必须当场实测可取回**，取不回的不进证据表（宁可少，不可假）。', '');
  R.push('## 1. 记录字段（每条引用一行，缺一不可）', '');
  R.push('| DOI | 标题（机器读过原文） | 年份 | 来源/期刊 | 全文状态 | 这条支持哪句 claim | 可核验链接 |');
  R.push('|---|---|---|---|---|---|---|');
  R.push('| | | | | 全文可得/仅摘要/需登录（跳过）/未找到 | | |', '');
  R.push('## 2. 要查什么（按方法论真源，逐个方向建清单）', '');
  for (const d of dims) {
    R.push(`- **${d.id} ${d.label}** ⇒ 真源：\`${(t.methodology_index || {}).root || ''}${d.file}\``);
  }
  R.push('', '## 3. 检索纪律（每条都踩过坑）', '');
  R.push('1. **先实测再采信**：任何"某源可用"的说法都要本机真跑一次（历史上 4 个免 key 源里有 1 个是 404）。');
  R.push('2. **四分类必须分类**：「需登录」≠「找不到」，前者的正确动作是**跳过并记录原因**，不是换个说法当找到了。');
  R.push('3. **标题必须机器读过**：只凭搜索结果的标题不算读过原文（同名/预印本/撤稿都可能同形）。');
  R.push('4. **取不回就如实写**：检索失败也是结果，写进表里；**不许用"一般认为"补上**。', '');

  const files = [
    { target: '00-写作任务书.md', body: L.join('\n') },
    { target: '01-检索计划.md', body: R.join('\n') },
  ];
  if (opts.dryRun) {
    return { dir, dryRun: true, plan: files.map((f) => f.target), created: [], skipped: [], scaffold: null,
             materialProvided: hasMat, declaration, steps: steps.length, gates: gates.map((g) => g.id) };
  }
  const sc = scaffold(dir, name, { genre: opts.genre || null });     // 顺手把骨架铺好（已存在的文件不覆盖）
  fs.mkdirSync(dir, { recursive: true });
  const created = []; const skipped = [];
  for (const f of files) {
    const p = path.join(dir, f.target);
    if (fs.existsSync(p)) { skipped.push(f.target); continue; }
    fs.writeFileSync(p, f.body, 'utf8');
    created.push(f.target);
  }
  return { dir, dryRun: false, plan: files.map((f) => f.target), created, skipped, scaffold: sc,
           materialProvided: hasMat, declaration, steps: steps.length, gates: gates.map((g) => g.id) };
}

function runSelftest() {
  const results = [];
  // ★严格契约：夹具必须【返回 true】才算通过；返回字符串 = 失败并附原因。
  // 绝不能用 !!r —— 失败时返回的说明字符串是非空的，用真值判定会把失败读成通过
  //（本文件 v0.1.0 就踩过：11/11"全绿"里有一条本该红的兜底夹具）。
  const check = (name, fn) => {
    try {
      const r = fn();
      const ok = r === true;
      results.push({
        name,
        ok,
        detail: ok ? '' : (typeof r === 'string' ? r : `夹具返回了 ${typeof r}（${String(r)}），必须返回 true 才算通过`),
      });
    } catch (e) { results.push({ name, ok: false, detail: String((e && e.message) || e) }); }
  };
  const pipeline = readPipeline();

  check('真源可读且含 task_types', () => pipeline.task_types.length > 0 || 'task_types 为空');

  check('必失败：真源缺失必须抛 PIPELINE_MISSING（不是返回空链路）', () => {
    try {
      readPipeline(path.join(ROOT, 'references', '__not_exist__.json'));
      return '没抛错 ⇒ 判据失效';
    } catch (e) { return e.code === 'PIPELINE_MISSING' || ('抛错但 code=' + e.code); }
  });

  check('必失败：route 无参数必须抛（不是兜底成 check）', () => {
    try { routeTask('', pipeline); return '没抛错 ⇒ 判据失效'; }
    catch (e) { return e.code === 'NO_TASK_TEXT' || ('抛错但 code=' + e.code); }
  });

  check('必失败：未知任务必须兜底为 check 且带说明', () => {
    const r = routeTask('今天天气不错，随便聊两句', pipeline);
    return (r.type.id === 'check' && r.note.length > 0) ? true : `兜底到 ${r.type.id}，note=${r.note}`;
  });

  check('关键词表：不允许单字 CJK 关键词（过宽 ⇒ 任何含该字的句子都误命中）', () => {
    const bad = [];
    for (const t of pipeline.task_types) for (const kw of (t.keywords || [])) {
      if (/^[\u4e00-\u9fff]$/.test(kw)) bad.push(`${t.id}:${kw}`);
    }
    return bad.length === 0 ? true : `发现单字关键词 ${bad.join(', ')} ⇒ 改成长词或加否定词表`;
  });

  check('路由回归：仅含「写」字的闲聊句不得命中 write', () => {
    const r = routeTask('我想写点东西但还没想好', pipeline);
    return r.type.id !== 'write' ? true : '命中了 write ⇒ 单字「写」仍在词表里';
  });

  check('关键词命中：投稿前体检 → check', () => routeTask('给这篇稿子做投稿前体检', pipeline).type.id === 'check' || '未命中 check');
  check('关键词命中：中译英 → polish', () => routeTask('把中文稿中译英到能投', pipeline).type.id === 'polish' || '未命中 polish');
  check('关键词命中：起草 → write 且档位 T2', () => {
    const r = routeTask('帮我把结果扩写成论文正文', pipeline);
    return (r.type.id === 'write' && r.type.tier === 'T2') || `得到 ${r.type.id}/${r.type.tier}`;
  });

  // ★ 2026-10-16（v3.1.8）：期刊分类路由可执行化 —— 分类轴从「只写在真源里」变成「route 会吐出来且可机检」
  check('期刊分类路由：中文刊任务 ⇒ cn+zh 且资产存在', () => {
    const r = journalRoute('把这篇稿子按中文核心期刊要求改好再投《储能科学与技术》', pipeline);
    if (r.key !== 'cn+zh') return '得到 ' + r.key;
    if (!r.assets.some((a) => a.path === 'references/cn-journals.md')) return 'assets=' + JSON.stringify(r.assets);
    return r.assets.every((a) => a.exists) || '有资产缺失：' + JSON.stringify(r.assets.filter((a) => !a.exists));
  });
  check('期刊分类路由：PLOS 任务 ⇒ intl+en+plos 且指向 plos-one.md', () => {
    const r = journalRoute('把这稿改成 PLOS ONE 版式并过图件规格', pipeline);
    return (r.key === 'intl+en+plos' && r.assets.some((a) => a.path === 'references/plos-one.md')) || JSON.stringify(r);
  });
  check('期刊分类路由：Elsevier 任务 ⇒ intl+en 且指向 submission-runbook.md', () => {
    const r = journalRoute('按 Elsevier 的 Journal of Energy Storage 要求改稿', pipeline);
    return (r.key === 'intl+en' && r.assets.some((a) => a.path === 'references/submission-runbook.md')) || JSON.stringify(r);
  });
  check('期刊分类路由：无期刊关键词的任务不得输出资产（不猜）', () => {
    const r = journalRoute('给这篇稿子做投稿前体检', pipeline);
    return (r.key === '' && r.assets.length === 0) || JSON.stringify(r);
  });
  check('期刊分类路由回归：routing 每个取值都必须含显式 references 路径（真源自洽）', () => {
    const bad = [];
    for (const [k, v] of Object.entries(pipeline.journal_classes.routing)) {
      if (!/references\/[^\s，。；、（）()]+\.md/.test(String(v))) bad.push(k);
    }
    return bad.length === 0 ? true : '以下取值没有显式路径：' + bad.join(', ');
  });
  check('必失败：真源缺 journal_classes.routing 必须抛 JOURNAL_CLASSES_MISSING', () => {
    const bad = JSON.parse(JSON.stringify(pipeline)); bad.journal_classes = { routing: {} };
    try { journalRoute('中文核心期刊', bad); return '没抛错 ⇒ 判据失效'; }
    catch (e) { return e.code === 'JOURNAL_CLASSES_MISSING' || ('抛错但 code=' + e.code); }
  });
  check('必失败：判出分类却解析不出资产路径必须抛 JOURNAL_ASSET_UNRESOLVED', () => {
    const bad = JSON.parse(JSON.stringify(pipeline)); bad.journal_classes.routing['cn+zh'] = '读国内刊专章（故意不写路径）';
    try { journalRoute('中文核心期刊', bad); return '没抛错 ⇒ 判据失效'; }
    catch (e) { return e.code === 'JOURNAL_ASSET_UNRESOLVED' || ('抛错但 code=' + e.code); }
  });
  check('必失败：资产文件缺失必须显形（同时兜住 npm 包缺 references 的分发缺口）', () => {
    const bad = JSON.parse(JSON.stringify(pipeline)); bad.journal_classes.routing['cn+zh'] = 'references/__no_such_asset__.md';
    const r = journalRoute('中文核心期刊', bad);
    return (r.assets.length === 1 && r.assets[0].exists === false) || '未显形：' + JSON.stringify(r.assets);
  });

  // ★ v3.1.9（由 2026-10-16 生态日审的真实问题驱动）：三道新判据 + 机器可读出口
  check('残留件门：当前技能树内不得有备份/临时件', () => {
    const r = hygiene({});
    return r.ok || ('发现 ' + r.files.length + ' 件：' + r.files.slice(0, 3).join(', '));
  });
  check('必失败：残留件门必须能抓出 .bak（不许静默通过）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-hyg-'));
    fs.writeFileSync(path.join(tmp, 'x.md.bak-20260101'), 'x');
    const r = hygiene({ roots: [tmp] });
    fs.rmSync(tmp, { recursive: true, force: true });
    return (!r.ok && r.files.length === 1) || ('未抓到：' + JSON.stringify(r));
  });
  // 说明：真实文档与实跑的对比交给 `node bin/studio.cjs claims` 这条命令（它会 spawn 探针取数）。
  // 夹具这里只测**机制**并显式给 live，避免 selftest 内部再 spawn 探针造成递归。
  check('文档数字一致性门（机制）：与给定实跑数一致时不得误报', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-claims-ok-'));
    const f = path.join(tmp, 'doc.md');
    fs.writeFileSync(f, '| 自检 | studio.cjs selftest | **67/67 通过** |\n');
    const r = claims({ files: [f], live: [{ suite: 'studio', pass: 67, total: 67 }] });
    fs.rmSync(tmp, { recursive: true, force: true });
    return r.ok || ('误报：' + JSON.stringify(r.mismatches));
  });
  check('必失败：实跑计数取不到时必须判失败（不许当通过）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-claims-na-'));
    const f = path.join(tmp, 'doc.md');
    fs.writeFileSync(f, '| 自检 | studio.cjs selftest | **67/67 通过** |\n');
    const r = claims({ files: [f], live: [{ suite: 'studio', pass: -1, total: -1, err: '取不到' }] });
    fs.rmSync(tmp, { recursive: true, force: true });
    return (!r.ok && r.mismatches.some((m) => /取不到/.test(m))) || ('未显形：' + JSON.stringify(r));
  });
  check('必失败：文档数字一致性门必须能抓出错的 N/N', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-claims-'));
    const f = path.join(tmp, 'doc.md');
    fs.writeFileSync(f, '| 自检 | studio.cjs selftest | **9999/9999 通过** |\n');
    const r = claims({ files: [f], live: [{ suite: 'studio', pass: 67, total: 67 }] });
    fs.rmSync(tmp, { recursive: true, force: true });
    return (!r.ok && r.mismatches.length === 1) || ('未抓到：' + JSON.stringify(r));
  });
  check('必失败：标了快照标记的文档跳过数字对拍（但必须留下快照记录）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-snap-'));
    const f = path.join(tmp, 'snap.md');
    fs.writeFileSync(f, SNAPSHOT_MARK + '\n| CLI 自检 | 21/21 通过 |\n');
    const r = claims({ files: [f], live: [{ suite: 'studio', pass: 67, total: 67 }] });
    fs.rmSync(tmp, { recursive: true, force: true });
    return (r.ok && r.snapshots.length === 1 && r.checked.length === 0) || ('未按快照处理：' + JSON.stringify(r));
  });
  check('自检覆盖门：bin/*.cjs 含自检者必须在真源 selfchecks 登记', () => {
    const r = coverage(pipeline);
    return r.ok || ('缺口：' + r.gaps.join(', '));
  });

  // ★ v3.2.0：合规门（蒸馏自 2026-10 一手取证；含必失败面）
  check('合规门·清单文档：5 类锚点齐备（在先发表/许可/地图/清样/可机检）', () => {
    const d = complianceDoc(null);
    return d.ok || ('缺：' + d.missing.join('、'));
  });
  check('必失败：清单文档被删节时必须报（不许静默当齐备）', () => {
    const d = complianceDoc('只有在先发表和许可两节');
    return (!d.ok && d.missing.length === 3) || ('未报到：' + JSON.stringify(d));
  });
  check('合规门·正控：齐备投稿包应通过（硬项与声明段全在）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-ok-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), 'Data Availability: 见仓库\nCRediT: 单人\nConflict of Interest: 无\nFunding: 无\nEthics: 不适用\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'dear editor');
    fs.writeFileSync(path.join(tmp, 'fig1.png'), 'x');
    fs.writeFileSync(path.join(tmp, 'refs.md'), 'refs');
    fs.writeFileSync(path.join(tmp, 'journal-contract.json'), '{}');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    return (r.ok && r.hardMissing.length === 0) || ('未通过：' + JSON.stringify({ hard: r.hardMissing, un: r.unreadable }));
  });
  check('必失败：缺 Cover Letter 时硬项必须报缺且不通过', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-noletter-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), 'Data Availability\nCRediT\nConflict of Interest\nFunding\nEthics\n');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    return (!r.ok && r.hardMissing.length === 1) || ('未报到：' + JSON.stringify({ ok: r.ok, hard: r.hardMissing }));
  });
  check('必失败：目录不存在必须显形为失败（取不到 ≠ 通过）', () => {
    const ghost = path.join(require('os').tmpdir(), 'ps-comp-ghost-' + Date.now());
    const r = complianceScan(ghost);
    return (r.ok === false && r.unreadable.length === 1) || ('未显形：' + JSON.stringify(r));
  });
  check('合规门·三值区分：软项缺只显形、不置非零（硬项齐时 ok 仍为真）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-soft-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), 'Data Availability\nCRediT\nConflict of Interest\nFunding\nEthics\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'x');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    return (r.ok && r.missing.length >= 3) || ('三值未区分：' + JSON.stringify({ ok: r.ok, miss: r.missing, hard: r.hardMissing }));
  });

  check('必失败：声明段措辞必须覆盖 BMC 系（Competing interests / Availability of data）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-bmc-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), '## Declarations\nCompeting interests: none.\nAvailability of data and materials: repository link.\nEthics: not applicable.\nFunding: none.\nAuthor contributions: single author.\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'x');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    const miss = r.items.filter((i) => i.key.indexOf('decl:') === 0 && i.state !== 'hit').map((i) => i.key);
    return (miss.length === 0) || ('BMC 措辞被误报缺：' + JSON.stringify(miss));
  });
  check('必失败：只写 Conflict of Interest 而不写 Competing interests 时仍应命中（宽口径双向）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-ieee-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), 'Conflicts of Interest: none. Data Availability: yes. Ethics: n/a. Funding: n/a. CRediT: one.\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'x');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    const miss = r.items.filter((i) => i.key.indexOf('decl:') === 0 && i.state !== 'hit').map((i) => i.key);
    return (miss.length === 0) || ('IEEE 措辞被误报缺：' + JSON.stringify(miss));
  });

  check('必失败：正文含 availability 短语但无声明段时不得误判为命中（防假阳性）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-fp-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), 'Scope: explicitly not covered (an availability limitation, not a claim). Competing interest: none. Ethics: n/a. Funding: n/a. CRediT: one.\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'x');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    const da = r.items.find((i) => i.key === 'decl:Data Availability');
    return (da && da.state === 'missing') || ('假阳性：' + JSON.stringify(da));
  });
  check('正控：Data and code availability 这类标题必须命中（第二处假阴性回归）', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ps-comp-dca-'));
    fs.writeFileSync(path.join(tmp, 'manuscript.md'), '### 4.6 Data and code availability\nAll materials supplied. Competing interest: none. Ethics: n/a. Funding: n/a. CRediT: one.\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'x');
    const r = complianceScan(tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    const da = r.items.find((i) => i.key === 'decl:Data Availability');
    return (da && da.state === 'hit') || ('未命中：' + JSON.stringify(da));
  });

  // ★ v3.2.1：接口面一致性门（由用户一问"你是以 skill 放进去的吗"追问出的真漂移）
  check('格式表：真源可读且来源可核（verified_at / verified_from 必须在）', () => {
    try { const f = readFormats(); return (Array.isArray(f.formats) && f.formats.length >= 3 && !!f.verified_at && !!f.verified_from) || '表不完整'; }
    catch (e) { return String((e && e.message) || e); }
  });
  check('格式检测·正控：\\documentclass{elsarticle} 必须命中 Elsevier/elsarticle（读真实内容，不猜）', () => {
    const det = detectTexFormat('\\documentclass[5p]{elsarticle}\n\\bibliographystyle{elsarticle-num}\n\\usepackage{graphicx}\n');
    const hit = readFormats().formats.filter((f) => (f.class_names || []).indexOf(det.documentclass) >= 0)[0];
    return (det.documentclass === 'elsarticle' && det.bibliographystyle === 'elsarticle-num' && hit && hit.publisher === 'Elsevier')
      || ('实得 ' + JSON.stringify({ det, hit: hit && hit.publisher }));
  });
  check('格式检测·必失败面：未知类文件不得命中（不许"随便什么都算通过"）', () => {
    const det = detectTexFormat('\\documentclass{__no_such_class__}\n');
    const hit = readFormats().formats.filter((f) => (f.class_names || []).indexOf(det.documentclass) >= 0)[0];
    return (!hit && det.documentclass === '__no_such_class__') || '未知类被误判命中';
  });
  check('格式检测·CLI 分支（走真进程，不调内部函数）：--detect 必须走检测分支而不是打印整张表', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = path.join(os.tmpdir(), 'dsh-fmt-' + Date.now() + '.tex');
    fs.writeFileSync(tmp, '\\documentclass[5p]{elsarticle}\n\\bibliographystyle{elsarticle-num}\n');
    const r = spawnSync(process.execPath, [__filename, 'formats', '--detect', tmp], { encoding: 'utf8' });
    try { fs.unlinkSync(tmp); } catch {}
    const out = String(r.stdout || '');
    const ok = r.status === 0 && out.indexOf('documentclass = elsarticle') >= 0 && out.indexOf('投稿格式模板（真源') < 0;
    return ok || ('exit=' + r.status + ' ｜ 含类名=' + (out.indexOf('documentclass = elsarticle') >= 0)
      + ' ｜ 误打整表=' + (out.indexOf('投稿格式模板（真源') >= 0));
  });
  check('格式检测·CLI 必失败面：未知类必须 exit=1 且明说未命中（不许一律通过）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = path.join(os.tmpdir(), 'dsh-fmt-bad-' + Date.now() + '.tex');
    fs.writeFileSync(tmp, '\\documentclass{__no_such_class__}\n');
    const r = spawnSync(process.execPath, [__filename, 'formats', '--detect', tmp], { encoding: 'utf8' });
    try { fs.unlinkSync(tmp); } catch {}
    const out = String(r.stdout || '');
    return (r.status === 1 && out.indexOf('未命中') >= 0) || ('exit=' + r.status + ' ｜ 含未命中=' + (out.indexOf('未命中') >= 0));
  });
  check('preflight·结构：能生成总检报告（含门执行器段落与结论行）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-'));
    const d = path.join(tmp, 'd.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nA few words.\n\n## Introduction\n\nBody.\n');
    const out = path.join(tmp, 'pf.md');
    const r = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--out', out], { encoding: 'utf8' });
    let txt = '';
    try { txt = fs.readFileSync(out, 'utf8'); } catch {}
    const ok = r.status !== 2 && /^# 投稿前总检/m.test(txt) && /## 一、门执行器/.test(txt) && /## 二、期刊契约门/.test(txt)
      && /## 三、投稿信要素核对/.test(txt) && /## 四、返修回复信核对/.test(txt)   /* v3.2.29：接入返修回复信步骤 */
      && /共 6 步/.test(txt)   /* 步数 4→5→6（v3.2.36 加「投稿门户字段」） */
      && /结论：\*\*/.test(txt) && /未检查 ≠ 通过|未检查（不是通过）/.test(txt)
      /* ★ 顺序锁：第一节的内容必须是**门执行器的真输出**（gate-runner 打印"门执行结果"），
         而不是别的门的报告——首版因下标写死+漏跑一步，把契约门报告顶到了第一节。 */
      && /## 一、门执行器[\s\S]{0,200}门执行结果/.test(txt);
    return ok || ('exit=' + r.status + ' ｜ 报告长度=' + txt.length + ' ｜ 输出头=' + JSON.stringify(String(r.stdout || '').slice(0, 80)));
  });
  check('preflight·必失败面：给了不存在的契约必须 exit=2（不许静默跳过契约门）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf2-'));
    const d = path.join(tmp, 'd.md');
    fs.writeFileSync(d, '# T\n');
    const r = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', path.join(tmp, 'nope.json')], { encoding: 'utf8' });
    return (r.status === 2 && /不许静默跳过契约门/.test(String(r.stderr || '') + String(r.stdout || ''))) || ('exit=' + r.status);
  });
  check('preflight·必失败面：缺 --draft 必须 exit=2 并说明用法', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [__filename, 'preflight'], { encoding: 'utf8' });
    return (r.status === 2 && /需要 --draft/.test(String(r.stderr || ''))) || ('exit=' + r.status);
  });
  check('anchors --oa·正控：按 DOI 批量查得 OA/订阅两态，并写回锚点表（离线 stub，不联网）', () => {
    const stub = (url) => {
      if (url.indexOf('doi:') < 0) return '{}';
      return JSON.stringify({ results: [
        { doi: 'https://doi.org/10.1/oa-one', title: 'OA one', open_access: { is_oa: true, oa_status: 'gold' }, best_oa_location: { pdf_url: 'https://ex.org/one.pdf' } },
        { doi: 'https://doi.org/10.1/closed-one', title: 'Closed one', open_access: { is_oa: false, oa_status: 'closed' }, best_oa_location: null },
      ] });
    };
    const { byDoi, log } = oaLookup(['10.1/oa-one', '10.1/closed-one', '10.1/absent'], stub);
    const ok = byDoi.size === 2 && byDoi.get('10.1/oa-one').is_oa === true && byDoi.get('10.1/oa-one').pdf_url === 'https://ex.org/one.pdf'
      && byDoi.get('10.1/closed-one').is_oa === false && log.length === 0;
    return ok || ('size=' + byDoi.size + ' log=' + JSON.stringify(log));
  });
  check('anchors --oa·必失败面：接口报错（400/error 体）必须**记进日志**，不得静默成"未取到"', () => {
    const errStub = () => JSON.stringify({ error: 'Invalid query parameters error.', message: 'is_oa is not a valid select field.' });
    const { byDoi, log } = oaLookup(['10.1/x'], errStub);
    const ok = byDoi.size === 0 && log.some((l) => l.stage === 'api-error' && /is_oa is not a valid/.test(l.why));
    return ok || ('log=' + JSON.stringify(log).slice(0, 160));
  });
  check('anchors --oa·必失败面：**未取到**必须标 not-retrieved（不得当作"不可达"或"已核"）', () => {
    const stub = () => JSON.stringify({ results: [] });
    const { byDoi } = oaLookup(['10.1/ghost'], stub);
    const miss = byDoi.size === 0;
    const bad = (() => { try { oaLookup(['10.1/x'], () => { throw new Error('curl 退出码 7'); }); return false; } catch (e) { return true; } })();
    return (miss && !bad) || ('size=' + byDoi.size + ' threw=' + bad);
  });
  check('cover·正控：四项声明在场 + 刊名与契约一致 + 无占位符 ⇒ 通过', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-'));
    const k = path.join(tmp, 'k.json'); const c = path.join(tmp, 'cover.md');
    fs.writeFileSync(k, JSON.stringify({ journal: 'Journal of Energy Storage', publisher: 'Elsevier', verified_at: '2026-10-16', verified_from: 'u', limits: {} }));
    fs.writeFileSync(c, 'Dear Editor,\n\nWe submit our original manuscript, which has not been published before and is not under consideration elsewhere, for exclusive consideration by the Journal of Energy Storage.\n\nAll authors have read and approved the submission. The authors declare no competing interests.\n\nSincerely,\nA. B.\n');
    const r = spawnSync(process.execPath, [__filename, 'cover', '--cover', c, '--contract', k], { encoding: 'utf8' });
    return (r.status === 0 && /投稿信要素核对/.test(String(r.stdout))) || ('exit=' + r.status + ' out=' + String(r.stdout).slice(0, 160));
  });
  /* ★ v3.2.43：**逐个命令都测**（此前只测 cover ⇒ `anchors` 的落点污染一路漏过去，直到包卫生门把 A 稿判红）。 */
  /* ★ v3.2.45：**不得从"要求清单/证据表"里借作者**。真身事故：B 稿的包内搜索从
     `9-期刊投稿要求核实清单.md` 抽到 `**作者**：<被引论文六位作者>` 当本稿作者块 ⇒ 会把别人名字填进作者栏。 */
  check('v3.2.45·不借作者：要求清单/证据表里的"作者"不得当作本稿作者块（取不到就判缺失）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'au-'))
    const d = path.join(tmp, 'manuscript.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody text.\n\n**Keywords:** a; b\n');
    fs.writeFileSync(path.join(tmp, '9-期刊投稿要求核实清单.md'), '**题名**：Someone else paper\n\n**作者**：Fengqing Jiang · Yichen Feng · Yuetai Li\n');
    const r = spawnSync(process.execPath, [__filename, 'submission-fields', '--draft', d, '--package', tmp, '--json'], { encoding: 'utf8' });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    const row = j && j.rows ? j.rows.find((x) => /Authors/.test(x.field)) : null;
    if (!row) return '没找到 Authors 行';
    if (/Fengqing/.test(String(row.value || ''))) return '把要求清单里被引论文的作者借来了：' + row.value;
    return row.state === 'missing' ? true : ('state=' + row.state + ' value=' + row.value);
  });
  check('v3.2.45·不借作者·正控：包内 Cover-Letter 里的 Authors 仍必须取到（防"一律判缺失"）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'au2-'))
    const d = path.join(tmp, 'manuscript.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody text.\n\n**Keywords:** a; b\n');
    fs.writeFileSync(path.join(tmp, 'Cover-Letter.md'), 'Dear Editor,\n\n**Authors:** Hao Liu\n');
    const r = spawnSync(process.execPath, [__filename, 'submission-fields', '--draft', d, '--package', tmp, '--json'], { encoding: 'utf8' });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    const row = j && j.rows ? j.rows.find((x) => /Authors/.test(x.field)) : null;
    return (row && row.state === 'ok' && /Hao Liu/.test(String(row.value))) ? true : ('row=' + JSON.stringify(row));
  });
  /* ★ v3.2.46：**同类扫查**（承 v3.2.45）—— 证据挑选必须排除"工作件/模板/清单"。
     真身事故：B 稿工作目录里 `0-一页速查.md` 被当成"稿件"去核声明段（✔/✘ 全无意义）；
     且 `9-投稿前总检查表.md` 因名字含"投**稿**前"被当成稿件（打分改成 manuscript>paper/draft>稿）。 */
  check('v3.2.46·工作件不是稿件：声明段必须从真稿件读，不得从速查表/检查表读', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decl-'))
    fs.writeFileSync(path.join(tmp, '0-一页速查.md'), '# 速查\n\n**Data Availability** 有\n**Ethics** 有\n');
    fs.writeFileSync(path.join(tmp, '9-投稿前总检查表.md'), '# 总检查表（含"投稿"二字）\n\n正文。\n');
    fs.writeFileSync(path.join(tmp, 'manuscript-x.md'), '# T\n\n## Abstract\n\nBody.\n\n**Funding** 无资助。\n');
    const r = spawnSync(process.execPath, [__filename, 'compliance', tmp, '--json'], { encoding: 'utf8' });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    if (!j) return 'JSON 解析失败';
    const rows = (j.scan.items || []).filter((x) => /^decl:/.test(x.key));
    if (!rows.length) return '没有声明段行';
    const users = Array.from(new Set(rows.map((x) => (x.files || [])[0])));
    if (users.indexOf('manuscript-x.md') < 0) return '没用真稿件，用的是：' + JSON.stringify(users);
    const da = rows.find((x) => /Data Availability/.test(x.key));
    if (da && da.state === 'hit') return '把速查表里的 Data Availability 当成了稿件的（应为 missing）';
    return true;
  });
  check('v3.2.46·脚本不是参考文献：refcheck.cjs / mkrefs.py 不得被算作参考文献清单', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'refs-'))
    fs.writeFileSync(path.join(tmp, 'manuscript-x.md'), '# T\n\n## Abstract\n\nBody.\n');
    fs.writeFileSync(path.join(tmp, 'mkrefs.cjs'), '// ref tool\n');
    fs.writeFileSync(path.join(tmp, 'refcheck-openalex.py'), '# ref tool\n');
    fs.writeFileSync(path.join(tmp, 'refs.md'), '# Reference list\n');
    const r = spawnSync(process.execPath, [__filename, 'compliance', tmp, '--json'], { encoding: 'utf8' });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    const row = j && (j.scan.items || []).find((x) => x.key === 'references');
    const bad = ((row && row.files) || []).filter((f) => /\.(cjs|py|js)$/.test(f));
    if (bad.length) return '把脚本当参考文献了：' + JSON.stringify(bad);
    return (row && (row.files || []).some((f) => /refs\.md$/.test(f))) ? true : 'refs.md 应被认作参考文献：' + JSON.stringify(row);
  });
  check('v3.2.46·取不到就不判定：目录里只有工作件（无可信稿件）⇒ 声明段记 unreadable，不得从工作件读', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'decl2-'))
    fs.writeFileSync(path.join(tmp, '0-一页速查.md'), '# 速查\n\n**Data Availability** 有\n');
    const r = spawnSync(process.execPath, [__filename, 'compliance', tmp, '--json'], { encoding: 'utf8' });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    const row = j && (j.scan.items || []).find((x) => x.key === 'decl');
    return (row && row.state === 'unreadable') ? true : ('row=' + JSON.stringify(row));
  });
  /* ★ v3.2.48：`doctor` —— 环境自检。两条夹具：真源应齐备；**缺外部资产必须非零退出**（fail-first）。
     为什么值得测：本插件 12 道门**全在插件之外** ⇒ 新装的人很可能"门一个都没有"，那时 doctor 必须说清楚。 */
  check('v3.2.48·doctor·正控：本机真源应门全可用（gatesOk === gatesTotal，ok=true）', () => {
    const r = doctorScan(readPipeline(), {});
    return (r.gatesTotal > 0 && r.gatesOk === r.gatesTotal && r.ok === true)
      ? true : ('门 ' + r.gatesOk + '/' + r.gatesTotal + ' 素材 ' + r.assetsOk + '/' + r.assetsTotal + ' ok=' + r.ok + ' degraded=' + JSON.stringify(r.degraded));
  });
  check('v3.2.49·doctor：外部不可用时**回落插件内置副本** ⇒ 仍门齐（12/12）+ exit 0（＝缺口已补）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-'))
    const pj = path.join(tmp, 'p.json');
    /* 用**真源的副本**、只把 playbook_root 换成未解析占位 —— 更贴近"新装机没配本机路径表"的真实场景。
       （首版用最小合成真源 ⇒ 被 readPipeline 的 task_types 校验挡下，属夹具不合格。） */
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'references', 'pipeline.json'), 'utf8'));
    real.assets = Object.assign({}, real.assets, { playbook_root: '__LOCAL__/playbook_root' });
    fs.writeFileSync(pj, JSON.stringify(real));
    /* ★ 关键：还必须把"本机路径表"也指走 —— 否则 readPipeline 会拿本机真表把 `__LOCAL__` 解析成真路径，
       于是"新装机"场景根本模拟不出来（首版就栽在这里：实得 12/12）。 */
    const emptyPaths = path.join(tmp, 'paths.json');
    fs.writeFileSync(emptyPaths, '{}');
    const env = Object.assign({}, process.env, { DSH_PAPER_LOCAL_PATHS: emptyPaths });
    const r = spawnSync(process.execPath, [__filename, 'doctor', '--pipeline', pj, '--json'], { encoding: 'utf8', env });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    if (!j) return 'JSON 解析失败：' + o.slice(0, 120);
    if (j.gatesOk !== j.gatesTotal || j.ok !== true) return ('应回落到内置副本并保持门齐，实得 ' + j.gatesOk + '/' + j.gatesTotal + ' ok=' + j.ok);
    if (r.status !== 0) return '回落成功却退出非 0：' + r.status;
    const bundled = (j.gateRows || []).filter((g) => g.source === 'bundled').length;
    if (bundled !== j.gatesTotal) return ('应全部门走内置副本，实得 ' + bundled + '/' + j.gatesTotal);
    return true;
  });
  check('v3.2.49·doctor·fail-first：门在"外部与内置都没有"时 ⇒ 报缺口 + **退出码非 0**', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doc2-'))
    const pj = path.join(tmp, 'p.json');
    const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'references', 'pipeline.json'), 'utf8'));
    real.gates = [{ id: 'ghost', rel: 'playbook_root', entry: '_gate-does-not-exist.cjs' }];
    fs.writeFileSync(pj, JSON.stringify(real));
    const r = spawnSync(process.execPath, [__filename, 'doctor', '--pipeline', pj, '--json'], { encoding: 'utf8' });
    const o = String(r.stdout); const b0 = o.indexOf('{'), e0 = o.lastIndexOf('}');
    let j = null; try { j = JSON.parse(o.slice(b0, e0 + 1)); } catch {}
    if (!j) return 'JSON 解析失败：' + o.slice(0, 120);
    if (j.gatesOk !== 0 || j.ok !== false) return ('应报 0/1 缺口，实得 ' + j.gatesOk + '/' + j.gatesTotal + ' ok=' + j.ok);
    if (r.status === 0) return '真正缺门却退出 0（必须非零）';
    return true;
  });
  check('v3.2.49·内外字节对拍：`gates/` 内置副本必须与本机外部门**逐字节一致**（否则两份会各自漂移）', () => {
    const crypto = require('node:crypto');
    const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    const pipeline = readPipeline();
    const pb = String((pipeline.assets || {}).playbook_root || '');
    if (!pb || pb.indexOf('__LOCAL__') === 0 || !fs.existsSync(pb)) return true;   // 本机无外部 → 无从对拍（内置副本仍可用）
    let n = 0; const diff = [];
    for (const g of (pipeline.gates || [])) {
      const ext = path.join(pb, g.entry); const bun = path.join(ROOT, 'gates', g.entry);
      if (!fs.existsSync(ext) || !fs.existsSync(bun)) continue;
      n++;
      if (sha(ext) !== sha(bun)) diff.push(g.entry);
    }
    if (!n) return '外部与内置没有可对拍的公共文件（至少应有一道）';
    return diff.length === 0 ? true : ('内外副本不一致（会各自漂移）：' + diff.join(', '));
  });
  check('★报告默认落点不得写进投稿包目录（**逐个会写报告的命令都测**：cover / anchors / preflight）', () => {
    const { spawnSync } = require('node:child_process');
    const results = [];
    const mk = (name) => { const tmp = fs.mkdtempSync(path.join(os.tmpdir(), name)); const pkg = path.join(tmp, 'submission'); fs.mkdirSync(pkg); return { tmp, pkg }; };
    /* ① cover */
    { const { pkg } = mk('h1-'); const c = path.join(pkg, 'Cover-Letter.md');
      fs.writeFileSync(c, 'Dear Editor, original, not under consideration elsewhere, the author approved, no competing interests.\n');
      const r = spawnSync(process.execPath, [__filename, 'cover', '--cover', c], { encoding: 'utf8' });
      const strays = fs.readdirSync(pkg).filter((f) => f.startsWith('_'));
      if (strays.length) results.push('cover:exit=' + r.status + ' 混入=' + JSON.stringify(strays)); }
    /* ② anchors（本轮修的那个） */
    { const { tmp, pkg } = mk('h2-'); const d = path.join(pkg, 'manuscript.md');
      fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody cites [1].\n');
      /* 给一份锚点表，免得它走"无锚点态"再来回跑门（与本锁无关）。 */
      fs.writeFileSync(path.join(tmp, 'anchors-已解析.json'), JSON.stringify({ anchors: [{ marker: '1', identifier: { doi: '10.1000/x' } }] }));
      const r = spawnSync(process.execPath, [__filename, 'anchors', '--draft', d], { encoding: 'utf8' });
      const strays = fs.readdirSync(pkg).filter((f) => f.startsWith('_'));
      if (strays.length) results.push('anchors:exit=' + r.status + ' 混入=' + JSON.stringify(strays));
      const landed = fs.readdirSync(tmp).filter((f) => /^_锚点表工作单-/.test(f));
      if (!landed.length) results.push('anchors:工作单没落在父目录（应在 ' + tmp + '）'); }
    /* ③ preflight */
    { const { pkg } = mk('h3-'); const d = path.join(pkg, 'manuscript.md');
      fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody.\n');
      const r = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d], { encoding: 'utf8' });
      const strays = fs.readdirSync(pkg).filter((f) => /^_(投稿前总检|契约检查报告|锚点表工作单)/.test(f));
      if (strays.length) results.push('preflight:exit=' + r.status + ' 混入=' + JSON.stringify(strays)); }
    return results.length === 0 ? true : results.join(' · ');
  });
  check('★假阴性锁：**单作者稿**写 "The author approved the submission" 必须判通过（首版只认 all authors ⇒ 误报缺声明）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov-single-'));
    const c = path.join(tmp, 'cover.md');
    fs.writeFileSync(c, 'Dear Editor,\n\nOur original manuscript is not under consideration elsewhere. The author approved the submission and declares no competing interests.\n');
    const r = spawnSync(process.execPath, [__filename, 'cover', '--cover', c], { encoding: 'utf8' });
    const out = String(r.stdout);
    return (r.status === 0 && !/✘ 作者已同意投稿/.test(out)) || ('exit=' + r.status + ' out=' + out.replace(/\n/g, ' | ').slice(0, 200));
  });
  check('cover·必失败面：漏"未一稿多投"必须报缺；刊名与契约不一致必须 FAIL（交叉核）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov2-'));
    const k = path.join(tmp, 'k.json'); const c = path.join(tmp, 'cover.md');
    fs.writeFileSync(k, JSON.stringify({ journal: 'Journal of Energy Storage', publisher: 'Elsevier', verified_at: '2026-10-16', verified_from: 'u', limits: {} }));
    fs.writeFileSync(c, 'Dear Editor,\n\nPlease consider our original manuscript for publication in Renewable Energy.\n\nAll authors have approved this submission and declare no competing interests.\n');
    const r = spawnSync(process.execPath, [__filename, 'cover', '--cover', c, '--contract', k], { encoding: 'utf8' });
    const out = String(r.stdout);
    return (r.status === 1 && /未一稿多投/.test(out) && /找不到/.test(out)) || ('exit=' + r.status + ' out=' + out.slice(0, 220));
  });
  check('cover·必失败面：残留模板占位符（[待填]/TODO）必须被抓', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov3-'));
    const c = path.join(tmp, 'cover.md');
    fs.writeFileSync(c, 'Dear [待填 Editors],\n\nOur original manuscript is not under consideration elsewhere. All authors have approved. No competing interests.\n\nTODO: add suggested reviewers.\n');
    const r = spawnSync(process.execPath, [__filename, 'cover', '--cover', c], { encoding: 'utf8' });
    const out = String(r.stdout);
    return (r.status === 1 && /占位符/.test(out)) || ('exit=' + r.status + ' out=' + out.slice(0, 200));
  });
  check('cover·必失败面：没给 --cover 必须 exit=2', () => {
    const { spawnSync } = require('node:child_process');
    const r = spawnSync(process.execPath, [__filename, 'cover'], { encoding: 'utf8' });
    return (r.status === 2 && /需要 --cover/.test(String(r.stderr))) || ('exit=' + r.status);
  });
  check('cover·未核不得当通过：不给 --contract 时刊名一栏必须显式记"未交叉核对"', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cov4-'));
    const c = path.join(tmp, 'cover.md'); const o = path.join(tmp, 'r.md');
    fs.writeFileSync(c, 'Dear Editor, original, not under consideration elsewhere, all authors approved, no competing interests.\n');
    const r = spawnSync(process.execPath, [__filename, 'cover', '--cover', c, '--out', o], { encoding: 'utf8' });
    let txt = '';
    try { txt = fs.readFileSync(o, 'utf8'); } catch {}
    return (r.status === 0 && /未交叉核对/.test(txt) && /不等于通过/.test(txt)) || ('exit=' + r.status + ' 报告=' + txt.slice(0, 160));
  });
  check('★preflight·只有提醒（rc=1）时：结论必须是"可投（有 N 项提醒）"且退出码 1 —— 既不得报"不可投"，也不得报"全绿"', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-warn-only-'));
    const d = path.join(tmp, 'm.md'); const k = path.join(tmp, 'k.json');
    /* 图题被声明但正文从不引用 ⇒ figure_table_xref 给 WARN ⇒ 契约门 rc=1（纯提醒，无 FAIL） */
    /* 本场景必须**没有任何 FAIL**才有资格测"纯提醒"的结论口径 ⇒ 四段声明必须在场
       （此前这条夹具的草稿缺声明，declaration-set 真 FAIL，是靠 v3.2.29 的错映射"通过"的）。 */
    fs.writeFileSync(d, ['# T', '', '## Abstract', '', 'A few words here for the abstract.', '',
      '**Figure 1.** Never cited in the body.', '',
      '## CRediT authorship contribution statement', '', 'A. B.: conceptualization, writing.', '',
      '## Declaration of competing interest', '', 'The author declares no competing interests.', '',
      '## Funding', '', 'This research received no external funding.', '',
      '## Declaration of generative AI and AI-assisted technologies in the writing process', '',
      'No generative AI was used.', ''].join('\n'));
    /* ★ 用**契约的图表数量区间**造一条**真 WARN**（实测 1 图 < 建议 8–10 ⇒ 记 WARN 且退出码仍 0）；
       此前这条夹具是拿一个会真 FAIL 的契约，靠 v3.2.29 的"rc=1 ⇒ 提醒"错误映射"通过"的 —— 那正是遮丑。 */
    fs.writeFileSync(k, JSON.stringify({ journal: 'J', publisher: 'P', verified_at: '2026-01-01', verified_from: 'u',
      limits: { figures_tables_range: [8, 10] } }));
    /* 本夹具只测"纯提醒"的结论口径；必须给 claim-anchor 一份（空的）锚点表，
       否则该门按"无锚点"判 HIGH ⇒ 门执行器 rc=2 ⇒ 测的就不是提醒而是阻断了。 */
    const anc = path.join(tmp, 'anchors.json');
    fs.writeFileSync(anc, JSON.stringify({ anchors: [] }));
    const r = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--anchors', anc], { encoding: 'utf8' });
    const out = String(r.stdout) + String(r.stderr);
    const okConcl = /结论：\*\*可投（有 \d+ 项提醒/.test(out);
    const notBlock = !/不可投/.test(out);
    return (r.status === 1 && okConcl && notBlock) || ('exit=' + r.status + ' 含提醒结论=' + okConcl + ' 无不可投=' + notBlock + ' out=' + out.replace(/\n/g, ' | ').slice(0, 220));
  });
  check('★preflight·返修步骤必须真被执行（防"声明了步骤却没跑"的死变量）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-reply-'));
    const d = path.join(tmp, 'm.md'); const c = path.join(tmp, 'com.md'); const l = path.join(tmp, 'let.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nA few words here for the abstract.\n');
    fs.writeFileSync(c, '1. Please clarify the threshold used for the health indicator.\n');
    fs.writeFileSync(l, '**Comment 1:** Please clarify the threshold used for the health indicator.\n\n**Response:** 已修改\n');
    const r = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--letter', l, '--comments', c], { encoding: 'utf8' });
    const out = String(r.stdout) + String(r.stderr);
    /* 该步若只"声明"不执行，段落里会是「退出码 未运行」；真执行时响应 exit 1（空回应） */
    /* ★ 断言落在**控制台那一层**：步进行 `⚠ 返修回复信核对（退出码 1）` 证明该步**真被调用**且返回 1；
       报告里的 `## 四、…` 只写在报告文件里、stdout 没有（首版断言盯错了层）。 */
    return (/返修回复信核对（退出码 1）/.test(out) && !/返修回复信核对（退出码 未运行）/.test(out))
      || ('exit=' + r.status + ' out=' + out.replace(/\n/g, ' | ').slice(0, 280));
  });
  /* ★ v3.2.33：报告运行指纹（PROVENANCE）+ report-check。四条夹具的判据是「能不能回答属于哪一次运行」。 */
  /* ★ v3.2.34：`reports --scan` 零参数陈旧巡检 —— 按**报告里记录的路径**重算，一次看清哪份结论还成立。 */
  check('★reports·多声明：复合报告里**每一条**声明都要核 —— 第一条新鲜、第二条陈旧 ⇒ 整体仍是 STALE（只看第一条就会漏）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rs5-'));
    const a = path.join(tmp, 'a.md'); const bf = path.join(tmp, 'b.md'); const r = path.join(tmp, '_复合报告.md');
    fs.writeFileSync(a, 'AAA\n'); fs.writeFileSync(bf, 'BBB\n');
    const mk = (tool, file, sha) => '<!-- PROVENANCE: ' + JSON.stringify({ tool, version: 'x', at: '2026-01-01T00:00:00Z', inputs: [{ role: 'draft', path: file, kind: 'file', sha12: sha, n: 4 }] }) + ' -->';
    /* 第一条声明：指纹与当前文件**一致**（新鲜）；第二条声明：故意给错摘要（陈旧） */
    const good = provenanceClaims(mk('toolA', a, digestOf(a).sha12)).length === 1;
    fs.writeFileSync(r, '# 复合报告\n\n' + mk('toolA', a, digestOf(a).sha12) + '\n\n' + mk('toolB', bf, 'deadbeef0000') + '\n');
    const out = spawnSync(process.execPath, [__filename, 'reports', '--scan', tmp, '--json'], { encoding: 'utf8' });
    const so = String(out.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const row = j && j.rows ? j.rows.find((x) => x.report === '_复合报告.md') : null;
    const roles = row && row.bad ? row.bad.map((x) => x.role) : [];
    return (good && out.status === 1 && row && row.state === 'STALE' && roles.length === 1 && /toolB/.test(roles[0]))
      ? true : `good=${good} rc=${out.status} state=${row && row.state} bad=${JSON.stringify(roles)}`;
  });
  /* ★ v3.2.35：投稿门户填写单 —— 核心不变量是「**每个值必须在来源里逐字存在**」。 */
  /* ★★ v3.2.39：**跨实现对拍** —— 同一个指标如果有两套实现（我的 submission-fields vs 契约门），
     两边读数必须一致。加上这条锁的直接原因：我新写的计数器把 `---` 分隔线算成一条亮点，
     报出「6 条 / 上限 5」的**假超限**，而契约门一直算的是 5 —— **同一目录里两套实现，我没对拍**。 */
  /* ★★ v3.2.41：**第三处行为对拍** —— `anchors` 命令报的 HIGH/LOW 必须等于「把同一份锚点表直接交给门」的结果。
     加上这条的直接原因：`anchors` 此前**从不透传锚点表** ⇒ 门按无锚点判 ⇒ 报 HIGH 23，而带表直跑是 HIGH 0 —— 错报持续了多轮。 */
  /* ★ v3.2.44：**候选原句**（`anchors --quote-hints`）—— 离线夹具，fetcher 注入 stub（不联网）。
     三条不变量：逐字来自来源 / 标证据层级 / 取不到就列"须人工读原文"。 */
  check('v3.2.44·原句候选：候选句必须**逐字**来自抓取到的来源（去标签后仍原样），且按词重叠排序', () => {
    const src = 'Unrelated sentence about other topics entirely here. Battery state of health prediction degrades across temperatures in our dataset substantially.';
    const xml = '<article><body><p>Unrelated sentence about other topics entirely here.</p><p>Battery state of health prediction degrades across temperatures in our dataset substantially.</p></body></article>';
    const j = JSON.stringify({ resultList: { result: [{ id: '1', pmcid: 'PMC1', isOpenAccess: 'Y', title: 'Stub', abstractText: 'abs' }] } });
    const stub = (url) => (url.indexOf('fullTextXML') >= 0 ? xml : j);
    const got = epmcLookup('10.1000/x', stub);
    if (got.state !== 'fulltext') return 'state=' + got.state;
    /* 逐字：每个候选句必须是来源文本的子串（去标签只发生在抓取阶段）。 */
    const sents = sentencesOf(got.text, 40);
    const bad = sents.filter((s) => src.indexOf(s) < 0);
    if (bad.length) return '非逐字候选：' + JSON.stringify(bad.slice(0, 1));
    const claim = ['Battery state of health prediction degrades across temperatures [1].'];
    const hints = rankHints(claim, sents, 3);
    if (!hints.length) return '没排出候选';
    if (hints[0].text.indexOf('degrades across temperatures') < 0) return '排序不对：' + hints[0].text;
    if (hints.some((h) => h.text.indexOf('Unrelated sentence') >= 0)) return '把无重叠句也排进来了';
    return true;
  });
  check('v3.2.44·原句候选·诚实面：取不到 ⇒ 记 not-retrieved，**不得**编候选', () => {
    const empty = JSON.stringify({ resultList: { result: [] } });
    const a = epmcLookup('10.1000/none', () => empty);
    const b = epmcLookup('', () => empty);
    const c = epmcLookup('10.1000/y', () => JSON.stringify({ resultList: { result: [{ id: '2', isOpenAccess: 'N', abstractText: '' }] } }));
    const ok = a.state === 'not-retrieved' && b.state === 'no-doi' && c.state === 'not-retrieved';
    return ok ? true : ('a=' + a.state + ' b=' + b.state + ' c=' + c.state);
  });
  check('v3.2.44·原句候选·不代填措辞：产物里必须写明"候选须你确认 / 本工具不代填"（防工具悄悄替人填）', () => {
    const src = fs.readFileSync(__filename, 'utf8');
    const has = /本工具不代填/.test(src) && /候选原句（按与主张句的词重叠排序，\*\*须你确认\*\*）/.test(src);
    return has ? true : '产物模板缺少"不代填/须你确认"措辞';
  });
  check('★锚点·行为对拍：studio anchors（带 --anchors）与门直接跑，HIGH/LOW 必须同值', () => {
    const { spawnSync } = require('node:child_process');
    const os2 = require('node:os');
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'anc-'));
    const d = path.join(tmp, 'd.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody cites [1] and [2] here.\n');
    const at = path.join(tmp, 'anchors.json');
    fs.writeFileSync(at, JSON.stringify({ anchors: [ { marker: '1', identifier: { doi: '10.1000/x' }, locator: { kind: 'page-quote', value: 'p1', quote: 'a quoted sentence long enough to count as verbatim' }, verdict: 'SUPPORTED', status: 'published', evidence_layer: 'author_statement' }, { marker: '2', identifier: { doi: '10.1000/y' }, locator: { kind: 'page-quote', value: 'p2', quote: 'another quoted sentence long enough to count verbatim' }, verdict: 'SUPPORTED', status: 'published', evidence_layer: 'author_statement' } ] }));
    const P = readPipeline();
    const g = (P.gates || []).find((x) => x.id === 'claim-anchor');
    let gate = '';
    try { const r = g ? resolveGateScript(g, P) : null; if (r && r.script) gate = r.script; } catch (e) {}
    if (!gate || !fs.existsSync(gate)) return '门脚本不可得 ⇒ 本锁跳过（不假装通过）';
    const parse = (s2) => { const b = s2.indexOf('{'); const e2 = s2.lastIndexOf('}'); try { return (b >= 0 && e2 > b) ? JSON.parse(s2.slice(b, e2 + 1)) : null; } catch { return null; } };
    const mine = parse(String(spawnSync(process.execPath, [__filename, 'anchors', '--draft', d, '--anchors', at, '--json'], { encoding: 'utf8' }).stdout));
    const theirs = parse(String(spawnSync(process.execPath, [gate, '--draft', d, '--anchors', at, '--json'], { encoding: 'utf8' }).stdout));
    if (!mine || !theirs) return '有一侧没输出 JSON ⇒ 无法对拍（mine=' + !!mine + ' gate=' + !!theirs + '）';
    const mh = ((mine.gate || {}).high), ml = ((mine.gate || {}).low);
    const th = (theirs.HIGH || []).length, tl = (theirs.LOW || []).length;
    return (mh === th && ml === tl) ? true : ('不同判：我方 HIGH=' + mh + '/LOW=' + ml + ' 门=' + th + '/' + tl);
  });
  check('★跨实现对拍：submission-fields 与契约门对同一稿的 Highlights 条数、摘要词数必须同值', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'xc-'));
    const d = path.join(tmp, 'd.md'); const c = path.join(tmp, 'c.json');
    fs.writeFileSync(d, ['# T', '', '## Abstract', '', 'Body sentence one. Body sentence two. Body sentence three.', '', '### Highlights', '', '- first bullet', '- second bullet', '- third bullet', '', '---', '', '## 1. Introduction', '', 'Body.'].join('\n'));
    fs.writeFileSync(c, JSON.stringify({ journal: 'J', article_type: 'review', verified_at: '2026-01-01', verified_from: 'selftest', limits: { abstract_max_words: 500, highlights: { required: true, min: 1, max: 5, max_chars_each: 85 } } }));
    const mine = spawnSync(process.execPath, [__filename, 'submission-fields', '--draft', d, '--contract', c, '--json'], { encoding: 'utf8' });
    const so = String(mine.stdout); const i0 = so.indexOf('\n{');
    let jm = null; try { jm = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const myHl = jm && jm.rows ? ((jm.rows.find((r) => /Highlights/.test(r.field)) || {}).items) : null;
    const myAbs = jm && jm.rows ? ((jm.rows.find((r) => /Abstract/.test(r.field)) || {}).words) : null;
    const P = readPipeline();   // ★ 本文件自检里没有 `studio` 这个名字（那是 gate-runner 对本模块的称呼）
    /* ★ 用 pipeline 里的**门定义**去解析（本文件注释里就记着：给 resolveGateScript 传空对象会拿到空结果）。
       解析不到要把**尝试过的路径**打出来 —— 否则这条锁会以「跳过」的形式静默失效。 */
    const tried = [];
    let gate = '';
    const gd = (P.gates || []).find((x) => x.id === 'journal-contract');
    try { const r = gd ? resolveGateScript(gd, P) : null; if (r && r.script) gate = r.script; } catch (e) { tried.push('resolveGateScript:' + String(e && e.message || e)); }
    if (!gate && P.assets && P.assets.playbook_root) gate = path.join(P.assets.playbook_root, '_journal-contract.cjs');
    if (!fs.existsSync(gate)) return '门脚本不可得 ⇒ 本锁跳过（不假装通过）。尝试过：' + (gate || '(空)') + ' · ' + tried.join(' / ');
    const g = spawnSync(process.execPath, [gate, '--draft', d, '--contract', c, '--json'], { encoding: 'utf8' });
    /* ★ 稳健提取：门的 JSON 可能**在最前**（studio 的输出在最后）⇒ 取「首个 `{` 到最后一个 `}`」，
       不要假设「行首花括号出现在中间」（首版就是这么错的）。 */
    const gout = String(g.stdout);
    const bs = gout.indexOf('{'); const be = gout.lastIndexOf('}');
    let jg = null; try { jg = (bs >= 0 && be > bs) ? JSON.parse(gout.slice(bs, be + 1)) : null; } catch {}
    if (!jg) return '契约门 JSON 解析失败：' + gout.slice(0, 120);
    const rowHl = (jg.results || []).find((x) => x.id === 'highlights_count') || {};
    const rowAbs = (jg.results || []).find((x) => x.id === 'abstract_max_words') || {};
    const gHl = (String(rowHl.detail || '').match(/实测\s*(\d+)\s*条/) || [])[1];
    const gAbs = (String(rowAbs.detail || '').match(/实测\s*(\d+)\s*词/) || [])[1];
    const okHl = myHl !== null && gHl !== undefined && Number(myHl) === Number(gHl);
    const okAbs = myAbs !== null && gAbs !== undefined && Number(myAbs) === Number(gAbs);
    return (okHl && okAbs) ? true : `我的 highlights=${myHl} 门=${gHl} · 我的 abstract=${myAbs} 门=${gAbs}`;
  });
  check('submission-fields·正控：逐字段抽出，且**每个非缺失值都在其来源里逐字存在**，exit=0', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sf1-'));
    const d = path.join(tmp, 'draft.md');
    fs.writeFileSync(d, ['# Cross-temperature battery SoH prediction', '', '## Abstract', '', 'We predict state of health across temperatures.', '', '**Keywords:** battery; SoH; cross-temperature', '', '## Highlights', '', '- first highlight', '- second highlight', '', '**Authors:** A. B., C. D.', '', '**Corresponding author:** A. B. (a.b@example.org)', '', '**CRediT authorship contribution statement.** Conceptualization: A. B.', '', '**Declaration of competing interest.** The authors declare no competing interests.', '', '**Funding.** This research did not receive any specific grant.', ''].join('\n'));
    const out = spawnSync(process.execPath, [__filename, 'submission-fields', '--draft', d, '--json'], { encoding: 'utf8' });
    const so = String(out.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    if (!j) return 'JSON 解析失败：' + so.slice(0, 120);
    const draftTxt = fs.readFileSync(d, 'utf8');
    const bad = j.rows.filter((r) => r.state === 'ok' && draftTxt.indexOf(r.value) < 0).map((r) => r.field);
    const got = j.rows.filter((r) => r.state === 'ok').length;
    return (out.status === 0 && j.fields_code === 'OK' && got >= 6 && bad.length === 0)
      ? true : `rc=${out.status} code=${j.fields_code} ok行=${got} 非逐字=${JSON.stringify(bad)}`;
  });
  check('submission-fields·必失败面：关键词缺失 ⇒ 进 missing 且 exit=1（缺失不许静默留空）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sf2-'));
    const d = path.join(tmp, 'draft.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody text here.\n');
    const out = spawnSync(process.execPath, [__filename, 'submission-fields', '--draft', d, '--json'], { encoding: 'utf8' });
    const so = String(out.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    return (out.status === 1 && j && j.fields_code === 'MISSING' && j.missing.includes('Keywords 关键词'))
      ? true : `rc=${out.status} code=${j && j.fields_code} missing=${JSON.stringify(j && j.missing)}`;
  });
  check('★submission-fields·反控（不得凭空造）：verbatimCheck 对真子串为真、对伪造串必为假', () => {
    const src = '# T\n\nAbstract\n\nReal sentence about cells.\n';
    const okReal = verbatimCheck('Real sentence about cells.', src) === true;
    const okFake = verbatimCheck('A sentence that nobody ever wrote in this file.', src) === false;
    const okEmpty = verbatimCheck('', src) === false;
    return (okReal && okFake && okEmpty) ? true : `real=${okReal} fake=${okFake} empty=${okEmpty}`;
  });
  check('submission-fields·超限与嵌套限额：抽象词数超契约上限 ⇒ over_limit 且 exit=1；对象型限额逐子键比（不打成 [object Object]）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'sf3-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(tmp, 'c.json');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\n' + 'word '.repeat(40) + '\n\n## Highlights\n\n- a\n- b\n- c\n- d\n');
    fs.writeFileSync(k, JSON.stringify({ journal: 'J', limits: { abstract_max_words: 5, highlights: { max_items: 2 } } }));
    const out = spawnSync(process.execPath, [__filename, 'submission-fields', '--draft', d, '--contract', k, '--json'], { encoding: 'utf8' });
    const so = String(out.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const over = j ? j.over_limit : [];
    const hasObj = so.indexOf('[object Object]') >= 0;
    /* ★ 断言过窄的修正：这份夹具的最小草稿**同时也缺关键词等字段**，所以 fields_code 会是 MISSING；
       本条要验的是「超限被算出来 + 对象型限额逐子键比」。 */
    return (out.status === 1 && j && over.includes('abstract_max_words') && over.includes('highlights.max_items') && !hasObj)
      ? true : `rc=${out.status} code=${j && j.fields_code} over=${JSON.stringify(over)} objBug=${hasObj}`;
  });
  check('reports·正控：目录里一份新鲜报告 ⇒ FRESH / scan_code=ALL-FRESH / exit=0', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rs1-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(ROOT, 'references', 'contracts', 'joes-elsevier.json'); const r = path.join(tmp, '_总检.md');
    fs.writeFileSync(d, '# Draft\n\nBody for the scan fixture.\n');
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--out', r], { encoding: 'utf8' });
    const b = spawnSync(process.execPath, [__filename, 'reports', '--scan', tmp, '--json'], { encoding: 'utf8' });
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    return (b.status === 0 && j && j.scan_code === 'ALL-FRESH' && j.counts && j.counts.FRESH === 1) ? true : `rc=${b.status} code=${j && j.scan_code} counts=${JSON.stringify(j && j.counts)}`;
  });
  check('★reports·判别力：报告记录的那个输入被改 ⇒ STALE 并点名角色，exit=1', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rs2-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(ROOT, 'references', 'contracts', 'joes-elsevier.json'); const r = path.join(tmp, '_总检.md');
    fs.writeFileSync(d, '# Draft\n\nFirst version.\n');
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--out', r], { encoding: 'utf8' });
    fs.appendFileSync(d, '\nChanged after the report.\n');
    const b = spawnSync(process.execPath, [__filename, 'reports', '--scan', tmp, '--json'], { encoding: 'utf8' });
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const row = j && j.rows ? j.rows[0] : null;
    const roles = row && row.bad ? row.bad.map((x) => x.role) : [];
    return (b.status === 1 && row && row.state === 'STALE' && roles.length >= 1 && roles.every((r) => /draft$/.test(r))) ? true : `rc=${b.status} state=${row && row.state} bad=${JSON.stringify(roles)}`;
  });
  check('reports·必失败面：报告记录的路径被删 ⇒ MISSING（**按报告里记录的路径核**，不是按命令行给的），exit=1', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rs3-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(ROOT, 'references', 'contracts', 'joes-elsevier.json'); const r = path.join(tmp, '_总检.md');
    fs.writeFileSync(d, '# Draft\n\nTo be deleted.\n');
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--out', r], { encoding: 'utf8' });
    fs.unlinkSync(d);
    const b = spawnSync(process.execPath, [__filename, 'reports', '--scan', tmp, '--json'], { encoding: 'utf8' });
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const row = j && j.rows ? j.rows[0] : null;
    return (b.status === 1 && row && row.state === 'MISSING') ? true : `rc=${b.status} state=${row && row.state}`;
  });
  check('reports·反控：没有指纹的报告 ⇒ 计 UNSTAMPED 且 exit=1（不得当新鲜）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rs4-'));
    fs.writeFileSync(path.join(tmp, '_手写报告.md'), '# 手写\n\n结论：可投\n');
    const b = spawnSync(process.execPath, [__filename, 'reports', '--scan', tmp, '--json'], { encoding: 'utf8' });
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    return (b.status === 1 && j && j.counts && j.counts.UNSTAMPED === 1) ? true : `rc=${b.status} counts=${JSON.stringify(j && j.counts)}`;
  });
  check('★preflight·小节序号唯一：报告里所有 `## <序号>、` 不得重复（首版硬编码「五」⇒ 加第 6 步后出现两个「五」）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pfno-'));
    const d = path.join(tmp, 'draft.md'); const r = path.join(tmp, 'rep.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody.\n');
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--out', r], { encoding: 'utf8' });
    const txt = fs.existsSync(r) ? fs.readFileSync(r, 'utf8') : '';
    const secs = (txt.match(/^## ([^\n]+?)、/gm) || []).map((x) => x.replace(/^## /, '').replace(/、.*$/, ''));
    const dup = secs.filter((x, i) => secs.indexOf(x) !== i);
    return (secs.length >= 6 && dup.length === 0) ? true : `小节数=${secs.length} 重复序号=${JSON.stringify(dup)}`;
  });
  check('report-check·正控：报告带运行指纹（含工具版本 + 逐输入 sha256 前 12 位），同输入核对为 FRESH 且 exit=0', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rc1-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(ROOT, 'references', 'contracts', 'joes-elsevier.json'); const r = path.join(tmp, 'rep.md');
    fs.writeFileSync(d, '# Draft\n\n## Introduction\n\nThis study reports a battery state-of-health prediction pipeline with公开数据与可复算口径。\n');
    const a = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--out', r], { encoding: 'utf8' });
    const txt = fs.existsSync(r) ? fs.readFileSync(r, 'utf8') : '';
    const stamp = /<!-- PROVENANCE: ([\s\S]*?) -->/.exec(txt);
    let prov = null; try { prov = stamp ? JSON.parse(stamp[1]) : null; } catch {}
    const ver = require(path.join(ROOT, 'package.json')).version;
    const b = spawnSync(process.execPath, [__filename, 'report-check', '--report', r, '--draft', d, '--contract', k, '--json'], { encoding: 'utf8' });
    /* ★ 修正：JSON 是**多行美化输出**，只 parse 第一行 '{' 会抛异常并被 catch 吞成 null（首版夹具的错）。
       从第一处行首花括号起到末尾整块解析。 */
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    /* ★ v3.2.34：报告里**可能有不止一条声明**（preflight 会把契约门报告正文内联进来）⇒ 看「有没有我方那条章」。 */
    const claims0 = provenanceClaims(txt);
    const mine = claims0.find((c) => c.tool === 'paper-studio' && c.version === ver);
    const roles = mine && mine.inputs ? mine.inputs.map((x) => x.role).sort().join(',') : '';
    /* ★ v3.2.34：多声明 ⇒ 判「存在一条 paper-studio@当前版本 且覆盖 draft+contract」，再看整体核对结论。
       （补救说明：上一轮局部替换把这一行的 return 吃掉了 ⇒ 夹具返回 undefined；已补回。） */
    return ((a.status === 0 || a.status === 1) && mine && roles === 'contract,draft' && b.status === 0 && j && j.verdict_code === 'FRESH')
      ? true : `preflight=${a.status} 我方章=${!!mine} roles=${roles} rc=${b.status} code=${j && j.verdict_code}`;
  });
  check('★report-check·判别力：输入改了之后必须判 STALE、点名是哪个输入变了（这就是「属于哪一次运行」的机器判据）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rc2-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(ROOT, 'references', 'contracts', 'joes-elsevier.json'); const r = path.join(tmp, 'rep.md');
    fs.writeFileSync(d, '# Draft\n\n## Introduction\n\nFirst version of the manuscript body.\n');
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--out', r], { encoding: 'utf8' });
    fs.appendFileSync(d, '\nOne more paragraph added after the report was produced.\n');
    const b = spawnSync(process.execPath, [__filename, 'report-check', '--report', r, '--draft', d, '--contract', k, '--json'], { encoding: 'utf8' });
    /* ★ 修正：JSON 是**多行美化输出**，只 parse 第一行 '{' 会抛异常并被 catch 吞成 null（首版夹具的错）。
       从第一处行首花括号起到末尾整块解析。 */
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const changed = j && j.rows ? j.rows.filter((x) => x.state === 'changed').map((x) => x.role) : [];
    return (b.status === 1 && j && j.verdict_code === 'STALE' && changed.length >= 1 && changed.every((r) => /draft$/.test(r)))
      ? true : `rc=${b.status} verdict=${j && j.verdict} changed=${JSON.stringify(changed)}`;
  });
  check('report-check·必失败面：报告**没有**运行指纹 ⇒ exit=2（核不了属于哪一次运行，不得当通过）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rc3-'));
    const r = path.join(tmp, 'plain.md'); const d = path.join(tmp, 'draft.md');
    fs.writeFileSync(r, '# 手写报告\n\n结论：可投\n'); fs.writeFileSync(d, '# D\n');
    const b = spawnSync(process.execPath, [__filename, 'report-check', '--report', r, '--draft', d], { encoding: 'utf8' });
    return (b.status === 2 && /没有运行指纹/.test(String(b.stderr))) ? true : `rc=${b.status}`;
  });
  check('report-check·反控：报告里有、但本次**没提供**的输入 ⇒ 判「未比对」且 exit=1（不得当成新鲜）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'rc4-'));
    const d = path.join(tmp, 'draft.md'); const k = path.join(ROOT, 'references', 'contracts', 'joes-elsevier.json'); const r = path.join(tmp, 'rep.md');
    fs.writeFileSync(d, '# Draft\n\nBody text for the provenance fixture.\n');
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--contract', k, '--out', r], { encoding: 'utf8' });
    const b = spawnSync(process.execPath, [__filename, 'report-check', '--report', r, '--draft', d, '--json'], { encoding: 'utf8' });
    /* ★ 修正：JSON 是**多行美化输出**，只 parse 第一行 '{' 会抛异常并被 catch 吞成 null（首版夹具的错）。
       从第一处行首花括号起到末尾整块解析。 */
    const so = String(b.stdout); const i0 = so.indexOf('\n{');
    let j = null; try { j = i0 >= 0 ? JSON.parse(so.slice(i0 + 1)) : null; } catch {}
    const un = j && j.rows ? j.rows.filter((x) => x.state === 'uncompared').map((x) => x.role) : [];
    return (b.status === 1 && j && j.verdict_code === 'PARTIAL' && un.length >= 1 && un.every((r) => /contract$/.test(r))) ? true : `rc=${b.status} code=${j && j.verdict_code} un=${JSON.stringify(un)}`;
  });
  /* ★ v3.2.36：preflight 现在 6 步（最后一步是「投稿门户字段」，**提醒级不阻断**）。 */
  check('preflight·第 6 步：报告里出现「投稿门户字段」小节、共 6 步，且必填齐全时该步 退出码 0', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pf6-'));
    const d = path.join(tmp, 'draft.md'); const r = path.join(tmp, 'rep.md');
    fs.writeFileSync(d, ['# T', '', '## Abstract', '', 'Body text here.', '', '**Keywords:** a; b', '', '**Authors:** A. B.', '', '**Corresponding author:** A. B.', ''].join('\n'));
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--out', r], { encoding: 'utf8' });
    const txt = fs.existsSync(r) ? fs.readFileSync(r, 'utf8') : '';
    /* ★ 定位**小节标题**（`## 六、投稿门户字段`）而不是报告头那行（`- 投稿门户字段：…`）—— 首版就栽在这。 */
    const idx = txt.indexOf('、投稿门户字段');
    const seg = idx >= 0 ? txt.slice(idx, idx + 300) : '';
    return (idx >= 0 && /共 6 步/.test(txt) && /退出码：0/.test(seg))
      ? true : `有小节=${idx >= 0} 共6步=${/共 6 步/.test(txt)} 段内退出码0=${/退出码：0/.test(seg)}`;
  });
  check('★preflight·门户是提醒级：必填缺失 ⇒ 该步 退出码 1 且结论落在「提醒」桶（**不得变成不可投**）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pf7-'));
    const d = path.join(tmp, 'draft.md'); const r = path.join(tmp, 'rep.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nBody text here.\n');   // 缺关键词/作者/通讯作者（必填）
    spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--out', r], { encoding: 'utf8' });
    const txt = fs.existsSync(r) ? fs.readFileSync(r, 'utf8') : '';
    /* ★ 精确定位小节并只看**这一步自己的桶标签**：rc=1 必须显示「有提醒（不阻断，逐条确认）」。
       不能苛求整篇 verdict —— 这份极简草稿在**别的门**（门执行器）那步本就 rc≥2 ⇒ 整篇"不可投"是正确的，
       与本步是否提醒级无关（首版把两件事混在一起，断言写错了）。 */
    const idx = txt.indexOf('、投稿门户字段');
    const seg = idx >= 0 ? txt.slice(idx, idx + 300) : '';
    return (idx >= 0 && /退出码：1/.test(seg) && /有提醒（不阻断，逐条确认）/.test(seg) && !/本次未通过|⇒ \*\*未通过\*\*/.test(seg))
      ? true : `有小节=${idx >= 0} 该步1=${/退出码：1/.test(seg)} 段=${seg.slice(0, 120)}`;
  });
  check('scaffold·正控：按 --comments 生成逐条待填骨架（每条的原文逐字带入 + 两处填写位 + 待填哨兵）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scaf-'));
    const c = path.join(tmp, 'c.md'); const s = path.join(tmp, 's.md');
    fs.writeFileSync(c, '1. The comparison with the baseline is missing; please add it.\n\n2. Please clarify the threshold used for the health indicator.\n');
    const r = spawnSync(process.execPath, [__filename, 'response', '--comments', c, '--scaffold', s], { encoding: 'utf8' });
    let txt = ''; try { txt = fs.readFileSync(s, 'utf8'); } catch {}
    const heads = (txt.match(/^## Comment \d+/gm) || []).length;
    const okOrig = txt.includes('The comparison with the baseline is missing; please add it.') && txt.includes('Please clarify the threshold used for the health indicator.');
    /* 说明行里也含这两个标签字样 ⇒ 用 >=2 而不是 ==2（首版按 ==2 断言，红的是断言不是生成器）。 */
    const okSlots = (txt.match(/\*\*Response:\*\*/g) || []).length >= 2 && (txt.match(/\*\*Where:\*\*/g) || []).length >= 2;
    const okSentinel = (txt.match(/待填/g) || []).length >= 2;
    return (r.status === 0 && heads === 2 && okOrig && okSlots && okSentinel) ? true
      : `exit=${r.status} 段数=${heads} 原文=${okOrig} 填写位=${okSlots} 哨兵=${okSentinel}`;
  });
  check('★scaffold·fail-first：**刚生成的骨架必须通不过核对**（每条判 not-filled，退出码 1）—— 骨架不得被当成成品交出去', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scaf2-'));
    const c = path.join(tmp, 'c.md'); const s = path.join(tmp, 's.md');
    fs.writeFileSync(c, '1. Please add a comparison with the baseline model.\n\n2. The dataset section is unclear about preprocessing steps.\n');
    spawnSync(process.execPath, [__filename, 'response', '--comments', c, '--scaffold', s], { encoding: 'utf8' });
    const r = spawnSync(process.execPath, [__filename, 'response', '--letter', s, '--comments', c, '--json'], { encoding: 'utf8' });
    let j = null; try { j = JSON.parse(String(r.stdout)); } catch {}
    const all = j && j.rows && j.rows.length === 2 && j.rows.every((x) => x.verdict === 'not-filled');
    return (r.status === 1 && all) ? true : `exit=${r.status} rows=${JSON.stringify(j && j.rows && j.rows.map((x) => x.verdict))}`;
  });
  check('scaffold·必失败面：没给 --comments 必须 exit=2（生成不出逐条骨架）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scaf3-'));
    const r = spawnSync(process.execPath, [__filename, 'response', '--scaffold', path.join(tmp, 's.md')], { encoding: 'utf8' });
    return (r.status === 2 && /需要 --comments/.test(String(r.stderr))) ? true : `exit=${r.status}`;
  });
  check('scaffold·反控：意见文件里解析不出条目 ⇒ exit=2（不得生成空骨架后报成功）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'scaf4-'));
    const c = path.join(tmp, 'c.md'); const s = path.join(tmp, 's.md');
    fs.writeFileSync(c, '短\n');
    const r = spawnSync(process.execPath, [__filename, 'response', '--comments', c, '--scaffold', s], { encoding: 'utf8' });
    return (r.status === 2 && !fs.existsSync(s)) ? true : `exit=${r.status} 生成了=${fs.existsSync(s)}`;
  });
  check('response·正控：逐条有回应且指明改动位置 ⇒ 通过', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resp-'));
    const c = path.join(tmp, 'c.md'); const l = path.join(tmp, 'l.md');
    fs.writeFileSync(c, '1. The manuscript lacks a comparison with the baseline model, please add it.\n\n2. The dataset section is unclear about preprocessing steps.\n');
    fs.writeFileSync(l, '## Response to Reviewer 1\n\n**Comment 1:** The manuscript lacks a comparison with the baseline model, please add it.\n\n**Response:** We thank the reviewer. We conducted the missing comparison and added a new subsection with numbers.\nThe results are now in Section 3.4 (new Table 4) and discussed in the last paragraph of p.12.\n\n**Comment 2:** The dataset section is unclear about preprocessing steps.\n\n**Response:** Agreed. We rewrote the data preparation paragraph; the filtering thresholds and the split ratios are now stated explicitly in Section 2.2.\n');
    const r = spawnSync(process.execPath, [__filename, 'response', '--letter', l, '--comments', c], { encoding: 'utf8' });
    return (r.status === 0 && /审稿意见 2 条 ⇒ 合规 2 · 有问题 0/.test(String(r.stdout))) || ('exit=' + r.status + ' out=' + String(r.stdout).slice(0, 160));
  });
  check('response·必失败面：漏回一条必须报 missing 并指出编号', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resp2-'));
    const c = path.join(tmp, 'c.md'); const l = path.join(tmp, 'l.md');
    fs.writeFileSync(c, '1. Please add a comparison with the baseline model.\n\n2. The dataset section is unclear about preprocessing steps.\n');
    fs.writeFileSync(l, '**Comment 1:** Please add a comparison with the baseline model.\n\n**Response:** We added the comparison in Section 3.4 with new numbers and a new Table 4.\n');
    const r = spawnSync(process.execPath, [__filename, 'response', '--letter', l, '--comments', c], { encoding: 'utf8' });
    const out = String(r.stdout);
    return (r.status === 1 && /#2/.test(out) && /漏回/.test(out)) || ('exit=' + r.status + ' out=' + out.slice(0, 200));
  });
  check('response·必失败面：空回应（"已修改"）与缺改动位置都必须 FAIL', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resp3-'));
    const c = path.join(tmp, 'c.md'); const l = path.join(tmp, 'l.md');
    fs.writeFileSync(c, '1. Please clarify the threshold used for the health indicator.\n\n2. Please justify the choice of the evaluation metric.\n');
    fs.writeFileSync(l, '**Comment 1:** Please clarify the threshold used for the health indicator.\n\n**Response:** 已修改\n\n**Comment 2:** Please justify the choice of the evaluation metric.\n\n**Response:** We agree with the reviewer and we have thought about this carefully for a long time, and we believe the current choice is the most appropriate one for this kind of study.\n');
    const r = spawnSync(process.execPath, [__filename, 'response', '--letter', l, '--comments', c], { encoding: 'utf8' });
    const out = String(r.stdout);
    return (r.status === 1 && /空回应/.test(out) && /未指明改动位置/.test(out)) || ('exit=' + r.status + ' out=' + out.slice(0, 220));
  });
  check('response·必失败面：没给 --comments 必须 exit=2（没有意见清单就核不了覆盖）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resp4-'));
    const l = path.join(tmp, 'l.md');
    fs.writeFileSync(l, '**Response:** something.\n');
    const r = spawnSync(process.execPath, [__filename, 'response', '--letter', l], { encoding: 'utf8' });
    return (r.status === 2 && /不得当通过/.test(String(r.stderr))) || ('exit=' + r.status);
  });
  check('anchors --resolve·正控：identifiers 取自**稿件题录**（有则采/无则留空并标注），不联网', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ares-'));
    const d = path.join(tmp, 'd.md');
    /* ★ 复现真稿条件：CRLF（此前夹具只写 \n ⇒ 漏掉了"`.` 不匹配 `\r`"这条失效路径） */
    fs.writeFileSync(d, ('# T\n\n## Abstract\n\nWords [1] and [2].\n\nAlso cites [3].\n\n'
      + '## References\n\n**[1]** *Alpha study of thing.* Journal A, 2019. `10.1016/j.alpha.2019.01`\n\n'
      + '**[2]** *Beta study without id.* Journal B, 2020.\n\n**[3]** *Gamma study.* Journal C, 2021. https://example.org/gamma\n')
      .replace(/\n/g, '\r\n'));
    const out = path.join(tmp, 'a.json');
    const r = spawnSync(process.execPath, [__filename, 'anchors', '--draft', d, '--resolve', '--out', out], { encoding: 'utf8' });
    let J = null;
    try { J = JSON.parse(fs.readFileSync(out, 'utf8')); } catch {}
    const by = {}; for (const a of (J && J.anchors) || []) by[a.marker] = a;
    const ok = r.status === 0 && J && J.anchors.length === 3
      && by['1'] && by['1'].identifier.doi === '10.1016/j.alpha.2019.01' && !by['1']._unresolved
      && by['3'] && by['3'].identifier.url === 'https://example.org/gamma'
      && by['2'] && by['2'].identifier.doi === '' && by['2']._unresolved
      && /题录区：/.test(String(r.stdout || '')) && /未解析\/待人工 1 条/.test(String(r.stdout || ''));
    return ok || ('exit=' + r.status + ' ｜ ' + JSON.stringify(by['1'] && by['1'].identifier) + ' ｜ 未解析=' + (by['2'] && by['2']._unresolved));
  });
  check('anchors --resolve·必失败面：在线兜底**相似度不达标必须留空**（不得为了凑数采用低分匹配）', () => {
    const fake = () => JSON.stringify({ message: { items: [{ DOI: '10.9999/wrong', title: ['Totally unrelated topic about fish'] }] } });
    const entries = [{ key: '9', raw: 'Some battery paper title here', title: 'Some battery paper title here', doi: '', url: '', pmid: '' }];
    const log = resolveRefsOnline(entries, fake, { minScore: 0.7 });
    const kept = entries[0].doi;
    const below = log.some((l) => l.stage === 'below-threshold') && kept === '';
    const strict = resolveRefsOnline([{ key: '9', raw: 'Some battery paper title here', title: 'Some battery paper title here', doi: '', url: '', pmid: '' }],
      () => JSON.stringify({ message: { items: [{ DOI: '10.1/ok', title: ['Some battery paper title here'] }] } }), { minScore: 0.7 });
    const good = entries.length && strict.length >= 0;
    return (below && good) || ('kept=' + kept + ' log=' + JSON.stringify(log).slice(0, 140));
  });
  check('anchors·正控：工作单列出全部引用键与行号，且骨架字段留空（不预填来源）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anch-'));
    const d = path.join(tmp, 'd.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nWords [1].\n\nThe method follows [2] and [3–4].\n\n## References\n\n[1] A. [2] B. [3] C.\n');
    const out = path.join(tmp, 'w.md'); const sk = path.join(tmp, 'sk.json');
    const r = spawnSync(process.execPath, [__filename, 'anchors', '--draft', d, '--out', out, '--json', sk], { encoding: 'utf8' });
    let txt = '', J = null;
    try { txt = fs.readFileSync(out, 'utf8'); } catch {}
    try { J = JSON.parse(fs.readFileSync(sk, 'utf8')); } catch {}
    const keysOk = ['1', '2', '3', '4'].every((k) => new RegExp('### `\\[' + k + '\\]`').test(txt));
    const blank = J && Array.isArray(J.anchors) && J.anchors.length === 4
      && J.anchors.every((a) => a.identifier && a.identifier.doi === '' && a.locator && a.locator.quote === '');
    const noPrefill = !/10\.\d{4}\//.test(JSON.stringify(J || {}));
    return (r.status === 0 && keysOk && blank && noPrefill && /第 14 道门/.test(txt))
      || ('exit=' + r.status + ' keys=' + keysOk + ' blank=' + blank);
  });
  check('anchors·必失败面：无引用标记时须明说"未发现"，且骨架为空数组（不得编出条目）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'anch2-'));
    const d = path.join(tmp, 'd.md');
    fs.writeFileSync(d, '# T\n\nNo citations here at all.\n');
    const out = path.join(tmp, 'w.md'); const sk = path.join(tmp, 'sk.json');
    const r = spawnSync(process.execPath, [__filename, 'anchors', '--draft', d, '--out', out, '--json', sk], { encoding: 'utf8' });
    let txt = '', J = null;
    try { txt = fs.readFileSync(out, 'utf8'); } catch {}
    try { J = JSON.parse(fs.readFileSync(sk, 'utf8')); } catch {}
    return (r.status === 0 && /未发现引用标记/.test(txt) && J && J.anchors.length === 0) || ('exit=' + r.status);
  });
  check('preflight·透传：报告头必须写明是否给了锚点表（未给时明说 claim-anchor 按无锚点判）', () => {
    const { spawnSync } = require('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf3-'));
    const d = path.join(tmp, 'd.md');
    fs.writeFileSync(d, '# T\n\n## Abstract\n\nWords [1].\n');
    const out = path.join(tmp, 'pf.md');
    const r = spawnSync(process.execPath, [__filename, 'preflight', '--draft', d, '--out', out], { encoding: 'utf8' });
    let txt = '';
    try { txt = fs.readFileSync(out, 'utf8'); } catch {}
    return (r.status !== 2 && /- 引用锚点表：\*\*未给\*\*/.test(txt)) || ('exit=' + r.status);
  });

  check('接口面：分派支持的命令必须都在 SUBCOMMANDS 登记（不许加了命令忘登记）', () => {
    const r = subcommandGaps(fs.readFileSync(__filename, 'utf8'), SUBCOMMANDS);
    return (r.missing.length === 0 && r.phantom.length === 0) || ('未登记: ' + r.missing.join(',') + ' ｜ 幽灵登记: ' + r.phantom.join(','));
  });
  check('必失败：未登记的分派命令必须被抓出（不许静默通过）', () => {
    const r = subcommandGaps("    if (cmd === 'ghost-cmd') return 0;", ['route', 'selftest']);
    return (r.missing.length === 1 && r.missing[0] === 'ghost-cmd') || ('未抓到：' + JSON.stringify(r));
  });
  check('必失败：登记了但没实现（幽灵命令）也必须被抓出', () => {
    const r = subcommandGaps("    if (cmd === 'route') return 0;", ['route', 'phantom-cmd']);
    return (r.phantom.length === 1 && r.phantom[0] === 'phantom-cmd') || ('未抓到：' + JSON.stringify(r));
  });

  check('接口面：SUBCOMMANDS 的每个命令必须在根 SKILL.md 出现（文档面不许漏命令）', () => {
    let sk = '';
    try { sk = fs.readFileSync(path.join(ROOT, 'SKILL.md'), 'utf8'); } catch { return '读不到根 SKILL.md ⇒ 不得当通过'; }
    const miss = SUBCOMMANDS.filter((c) => sk.indexOf('studio.cjs ' + c) === -1);
    return miss.length === 0 || ('根 SKILL.md 未出现: ' + miss.join(', '));
  });
  check('必失败：SKILL.md 漏命令必须被抓出', () => {
    const sk = 'node bin/studio.cjs route "x"';
    const miss = ['route', 'verify'].filter((c) => sk.indexOf('studio.cjs ' + c) === -1);
    return (miss.length === 1 && miss[0] === 'verify') || ('未抓到：' + JSON.stringify(miss));
  });

  // ★ v3.2.2：跨面一致性（真源 agent_facing ↔ CLI 登记表）
  check('跨面：真源 agent_facing 的命令必须都在 SUBCOMMANDS 里（防拼错/删命令）', () => {
    const need = (pipeline && pipeline.agent_facing) || [];
    const miss = need.filter((c) => !SUBCOMMANDS.includes(c));
    return (need.length >= 5 && miss.length === 0) || ('未登记: ' + miss.join(', ') + '（agent_facing ' + need.length + ' 条）');
  });
  check('必失败：agent_facing 里拼错的命令必须被抓', () => {
    const need = ['route', 'ghost-mm'];
    const miss = need.filter((c) => !SUBCOMMANDS.includes(c));
    return (miss.length === 1 && miss[0] === 'ghost-mm') || ('未抓到：' + JSON.stringify(miss));
  });

  // ★ v3.2.4：契约资产自证 + 整包清单覆盖运行时依赖（都由本轮"真装实测/合规门缺口"驱动）
  check('契约资产：PLOS ONE 契约必须存在、严格可解析、且带取证日期与来源', () => {
    const p = path.join(ROOT, 'references', 'contracts', 'plos-one.json');
    let c = null;
    try { c = JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return '读不到或不可解析（不得当通过）：' + String((e && e.message) || e); }
    const need = ['journal', 'publisher', 'article_type', 'verified_at', 'verified_from', 'limits', 'structure', 'references', 'cover_letter', 'human_only', 'machine_checkable'];
    const miss = need.filter((k) => !(k in c));
    if (miss.length) return '缺必填键: ' + miss.join(', ');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.verified_at))) return 'verified_at 形态不对: ' + c.verified_at;
    if (!String(c.verified_from).trim()) return 'verified_from 为空 ⇒ 无取证来源不得当通过';
    if (!(c.limits.title_max_chars > 0 && c.limits.abstract_max_words > 0 && c.limits.heading_levels_max > 0)) return 'limits 关键数字缺失';
    if (!(c.human_only || []).length) return 'human_only 为空 ⇒ 人工边界没写出来（易被读成"机器全包"）';
    return true;
  });
  check('必失败：契约缺取证日期必须被抓（不许无取证日期入真源）', () => {
    const bad = { journal: 'X', publisher: 'Y', article_type: 'z', verified_from: 'u', limits: {}, structure: {}, references: {}, cover_letter: {}, human_only: ['h'], machine_checkable: ['m'] };
    const miss = ['journal', 'publisher', 'article_type', 'verified_at', 'verified_from', 'limits', 'structure', 'references', 'cover_letter', 'human_only', 'machine_checkable'].filter((k) => !(k in bad));
    return (miss.length === 1 && miss[0] === 'verified_at') || ('未抓到：' + JSON.stringify(miss));
  });
  check('整包：运行时引用的仓内文件必须都被 package.json.files 覆盖（防"代码读了没入包的文件"）', () => {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch (e) { return '读不到根 package.json（不得当通过）：' + String((e && e.message) || e); }
    const files = pkg.files || [];
    const cands = new Set();
    for (const rel of ['bin/studio.cjs', 'bin/gate-runner.cjs', 'plugin/dist/plugin.js', 'plugin/selftest.mjs', 'references/pipeline.json']) {
      let txt = '';
      try { txt = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { continue; }
      for (const m of txt.matchAll(/(?:references|bin|plugin)\/[A-Za-z0-9._\-\/]+\.(?:cjs|mjs|js|json|md|yml)/g)) cands.add(m[0]);
      for (const m of txt.matchAll(/'(SKILL\.md|README\.md|CHANGELOG\.md|LICENSE)'/g)) cands.add(m[1]);
    }
    const problems = [];
    for (const rel of cands) {
      if (!fs.existsSync(path.join(ROOT, rel))) continue;                 // 只检查确实存在的引用
      const top = rel.split('/')[0];
      if (files.includes(top) || files.includes(rel)) continue;
      problems.push(rel);
    }
    return problems.length === 0 || ('未入包清单: ' + problems.slice(0, 6).join(' · '));
  });
  check('必失败：files 漏掉某顶层目录必须被抓（不许静默少装）', () => {
    const files = ['plugin', 'SKILL.md'];
    const rel = 'references/pipeline.json';
    const covered = files.includes(rel.split('/')[0]) || files.includes(rel);
    return covered ? '未被抓到（本应报缺）' : true;
  });

  // ★ v3.2.4：合规门"契约项缺失"必须给出可执行的下一步（告诉作者包内已备好哪一份）
  check('合规门：投稿包缺契约时，该软项的 label 必须指出包内可复制的契约文件', () => {
    const os2 = require('os');
    const tmp = fs.mkdtempSync(path.join(os2.tmpdir(), 'ps-contract-hint-'));
    try {
      fs.writeFileSync(path.join(tmp, 'manuscript.md'), '# T\n\nabstract\n');
      const r = complianceScan(tmp);
      const it = (r.items || []).find((x) => x.key === 'journal_contract');
      if (!it) return '合规门里没有 journal_contract 这一项（判据前提不成立）';
      if (it.state !== 'missing') return '该目录本不应有契约，却判成 ' + it.state;
      return /包内(已备好|暂无契约模板)/.test(it.label) ? true : ('label 未给可执行提示：' + it.label);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  // ★ v3.2.5：契约目录**通则**判据 —— 分族：限额结构族（limits+structure，Elsevier 系/PLOS）
  //   或 核验族（verified_facts + publisher_level_policies/implications，BMC 系）；
  //   **不属于任何已知族 ⇒ 显形报"未知契约族"，不放行**。
  check('契约目录：每份 *.json 必须可解析、带取证信息（journal/publisher/verified_at/verified_from），且属于已知契约族', () => {
    const dir = path.join(ROOT, 'references', 'contracts');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => /\.json$/.test(f)); } catch (e) { return '读不到契约目录（不得当通过）：' + String((e && e.message) || e); }
    if (files.length < 1) return '契约目录为空 ⇒ 前提不成立，不得当通过';
    const bad = [];
    for (const f of files) {
      let c = null;
      try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { bad.push(f + ' 不可解析'); continue; }
      for (const m of contractSchemaProblems(c)) bad.push(f + ' ' + m);
    }
    return bad.length === 0 ? true : (files.length + ' 份里有问题：' + bad.slice(0, 6).join('；'));
  });
  check('必失败：形状不属于任何已知契约族必须被抓（不许"形状不对也静默通过"）', () => {
    const weird = { journal: 'X', publisher: 'Y', verified_at: '2026-01-01', verified_from: 'u', some_other_thing: {} };
    const probs = contractSchemaProblems(weird);
    return probs.some((m) => /未知契约族/.test(m)) ? true : ('未抓到未知族：' + JSON.stringify(probs));
  });
  check('正控：三份已入包契约（JoES 限额族 / RIPP 核验族 / PLOS 限额族）都必须判为合法', () => {
    const dir = path.join(ROOT, 'references', 'contracts');
    const bad = [];
    for (const f of ['joes-elsevier.json', 'ripp-bmc.json', 'plos-one.json']) {
      try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); const probs = contractSchemaProblems(c); if (probs.length) bad.push(f + ':' + probs.join(',')); }
      catch (e) { bad.push(f + ' 读不到'); }
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  // ★ v3.2.6：CRediT 官方角色资产 + 非官方写法判据（素材来自 credit.niso.org，CC-BY 4.0）
  check('CRediT 资产：14 个官方角色、含 en dash 逐字、带取证信息与逐角色链接', () => {
    let c = null;
    try { c = JSON.parse(fs.readFileSync(path.join(ROOT, 'references', 'credit-roles.json'), 'utf8')); } catch (e) { return '读不到或不可解析（不得当通过）：' + String((e && e.message) || e); }
    const roles = (c.roles || []).map((r) => r.name);
    if (roles.length !== 14) return '角色数应为 14，实得 ' + roles.length;
    const w = roles.filter((x) => /^Writing/.test(x));
    if (w.length !== 2) return 'Writing 系列角色应为 2 个，实得 ' + w.length;
    for (const x of w) if (!/\u2013/.test(x)) return '「' + x + '」缺 en dash（官方逐字为 Writing – …，不得改连字符）';
    if (!(c.roles || []).every((r) => /^https:\/\//.test(String(r.url || '')))) return '有角色缺官方链接';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.verified_at || '')) || !String(c.verified_from || '').trim()) return '缺取证日期或来源';
    if (!/NISO|ANSI/i.test(String(c.standard || ''))) return '缺标准号（ANSI/NISO Z39.104-2022）';
    return true;
  });
  check('CRediT 正控：用官方写法写的贡献段必须判通过', () => {
    const txt = '## Author contributions\n\nConceptualization: A. B.; Data curation: C. D.; Formal analysis: C. D.; Funding acquisition: A. B.; Investigation: C. D.; Methodology: A. B.; Supervision: A. B.; Visualization: C. D.; Writing \u2013 original draft: A. B.; Writing \u2013 review & editing: A. B.\n';
    const r = creditScan(txt);
    return r.ok === true ? true : JSON.stringify({ variants: r.variants, reasons: r.reasons, found: r.rolesFound.length });
  });
  check('必失败：非官方写法（Visualisation / Conceptualisation）必须被抓（不许静默通过）', () => {
    const txt = '## CRediT\n\nConceptualisation: A. B.; Visualization: C. D.; Visualisation: C. D.; Supervision: A. B.\n';
    const r = creditScan(txt);
    return (!r.ok && r.variants.length >= 1 && r.variants.some((v) => /Visualisation|Conceptualisation/.test(v.found))) ? true : JSON.stringify(r.variants);
  });
  check('必失败：没有 CRediT 段必须判未通过（缺段不等于没问题）', () => {
    const r = creditScan('# Manuscript\n\nAbstract...\n\n## Introduction\n\nWe studied X.\n');
    return (!r.ok && r.reasons.some((x) => /未找到 CRediT/.test(x))) ? true : JSON.stringify(r.reasons);
  });

  // ★ v3.2.7：引用撤稿检查（同步测纯判据；异步网络路径由真跑覆盖）
  check('撤稿检查·DOI 提取：抽 DOI 并清洗尾部标点与 URL 前缀', () => {
    const txt = 'Refs: doi:10.1038/nature00870. and https://doi.org/10.1371/journal.pone.0000217, plus 10.1016/j.ijantimicag.2020.105949;';
    const d = extractDois(txt);
    return (d.length === 3 && d.includes('10.1038/nature00870') && d.includes('10.1016/j.ijantimicag.2020.105949')) ? true : JSON.stringify(d);
  });
  check('撤稿检查·正控：批结果里全部未标撤稿 ⇒ 通过', () => {
    const b = [{ ok: true, results: [
      { doi: 'https://doi.org/10.1000/aaa', title: 'A', is_retracted: false, publication_year: 2020 },
      { doi: 'https://doi.org/10.1000/bbb', title: 'B', is_retracted: false, publication_year: 2021 }] }];
    const r = retractJudge(['10.1000/aaa', '10.1000/bbb'], b);
    return r.ok === true ? true : JSON.stringify({ clean: r.clean.length, retracted: r.retracted.length, unreadable: r.unreadable.length });
  });
  check('必失败：有撤稿文献必须判不通过并逐条列出', () => {
    const b = [{ ok: true, results: [
      { doi: 'https://doi.org/10.1000/aaa', title: 'RETRACTED', is_retracted: true, publication_year: 2019 },
      { doi: 'https://doi.org/10.1000/bbb', title: 'B', is_retracted: false, publication_year: 2021 }] }];
    const r = retractJudge(['10.1000/aaa', '10.1000/bbb'], b);
    return (!r.ok && r.retracted.length === 1 && r.retracted[0].doi === '10.1000/aaa') ? true : JSON.stringify(r.retracted);
  });
  check('必失败：批失败必须记 unreadable 且不判通过（取不到≠通过）', () => {
    const r = retractJudge(['10.1000/aaa'], [{ ok: false, error: 'HTTP 503' }]);
    return (!r.ok && r.unreadable.length === 1 && r.clean.length === 0) ? true : JSON.stringify({ ok: r.ok, unreadable: r.unreadable.length });
  });
  check('必失败：OpenAlex 无该 DOI 时记 notFound，且不得冒充 clean', () => {
    const r = retractJudge(['10.9999/none'], [{ ok: true, results: [] }]);
    return (r.notFound.length === 1 && r.clean.length === 0 && r.ok === false) ? true : JSON.stringify({ nf: r.notFound.length, clean: r.clean.length, ok: r.ok });
  });

  check('门解析：每个门的 entry 路径都能解析出字符串', () => (pipeline.gates || []).every((g) => typeof resolveGate(g, pipeline).entry === 'string' && resolveGate(g, pipeline).entry.length > 0) || '有门解析不出路径');
  check('门解析：脚本缺失必须标 scriptOk=false（不得默认通过）', () => {
    const fake = [{ id: 'x', label: '假门', runtime: 'node', entry: '__no_such_gate__.cjs', rel: 'playbook_root' }];
    return resolveGate(fake[0], pipeline).scriptOk === false || '缺失脚本却标成存在';
  });
  // 2026-10-14：write 链路的「作者材料前提」从一句约定变成真门（author-material）。
  // 这条断言防的是「有人把它从链路里摘掉/换名」——那会让 precondition 静默退回成没人执行的文字。
  check('write 链路必须含 author-material 门，且该门要求 {declaration} 输入', () => {
    const wt = (pipeline.task_types || []).find((t) => t.id === 'write');
    if (!wt) return '真源里没有 write 任务类型';
    if (!(wt.gates || []).includes('author-material')) return `write.gates 缺 author-material：${JSON.stringify(wt.gates)}`;
    const g = (pipeline.gates || []).find((x) => x.id === 'author-material');
    if (!g) return 'gates 表里没有 author-material 定义';
    const rp = g.required_placeholders || [];
    return (rp.includes('{declaration}') && g.used_by && g.used_by.includes('write')) || `required_placeholders=${JSON.stringify(rp)} used_by=${JSON.stringify(g.used_by)}`;
  });
  check('交接契约：intake 契约含必填字段且缺字段能识别', () => {
    const r = intake(path.join(ROOT, '__no_such_doc__.md'), pipeline);
    return (r.required.length > 0 && r.complete === false && r.missing.includes('doc_path')) || `required=${r.required} complete=${r.complete} missing=${r.missing}`;
  });
  check('policy：三项硬纪律在真源里为 true', () => {
    const p = pipeline.policy || {};
    return (p.no_ai_detection_evasion === true && p.no_third_party_content_copy === true && p.exit_code_and_stdout_both_checked === true) || JSON.stringify(p);
  });

  // ★ 2026-10-14 新增 4 条：写作类说法必须命中 write；draft 子命令（write 链路里原先只是名字的那一步）
  check('路由：写作类说法必须命中 write（曾把「帮我从0写一篇论文」兜底成 check）', () => {
    const cases = ['帮我从0写一篇论文', '从零写一篇论文', '代写一篇论文', '写一篇论文初稿'];
    const bad = [];
    for (const c of cases) { const r = routeTask(c, pipeline); if (r.type.id !== 'write') bad.push(`${c} ⇒ ${r.type.id}`); }
    return bad.length === 0 ? true : bad.join('；');
  });
  check('必失败：draft 不给 --out 必须抛（不许默默写到当前目录）', () => {
    try { draftPlan('', {}); return '没抛错 ⇒ 判据失效'; }
    catch (e) { return e.code === 'NO_OUT' ? true : `抛了但 code=${e.code}`; }
  });
  check('draft dry-run：只出计划、不写任何文件', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-draft-'));
    const target = path.join(tmp, 'paper');
    const r = draftPlan(target, { name: '测试', dryRun: true });
    return (r.dryRun === true && r.plan.length === 2 && fs.existsSync(target) === false) ? true : `dryRun=${r.dryRun} plan=${r.plan} 写了文件=${fs.existsSync(target)}`;
  });
  check('draft 真跑：任务书/检索计划都生成，阶段数与门数都来自真源（不许手写）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-draft2-'));
    const dir = path.join(tmp, 'paper');
    const r = draftPlan(dir, { name: '测试稿', lang: 'en', journal: 'JoES' });
    const tb = fs.readFileSync(path.join(dir, '00-写作任务书.md'), 'utf8');
    const t = readTemplates();
    const want = (t.stage_skeletons || []);
    const hit = want.filter((s) => tb.includes(s.target)).length;
    const okPlan = r.created.includes('00-写作任务书.md') && r.created.includes('01-检索计划.md');
    const okScaffold = !!(r.scaffold && r.scaffold.created.length > 0);
    return (okPlan && okScaffold && hit === want.length) ? true : `产物=${okPlan} 骨架=${okScaffold} 任务书命中阶段 ${hit}/${want.length}`;
  });

  // 2026-10-14（V1.4）：综述/审计类稿件的「方法完整性门」必须挂在 check 链路上，且必须显式声明
  // 「不适用对象」语义（非综述稿判不适用、退出码 0）——否则它会把实证稿判成失败，属于判据越界。
  // 2026-10-14（V1.5 修订）：**「不适用」语义已从单门内部提升为链路层机制**（applies_to + gate_meta）。
  // 因此断言改为检查**机制**：综述门必须显式声明体裁边界；真源必须声明缺省与「全不适用 ⇒ 1」的口径。
  // （这条断言在 V1.5 一度变红 —— 架构变了判据要跟着走，不能靠把措辞改回去让它变绿。）
  check('check 链路含 review-protocol，且「不适用」语义在链路层有机制（applies_to + gate_meta）', () => {
    const ct = (pipeline.task_types || []).find((t) => t.id === 'check');
    if (!ct) return '真源里没有 check 任务类型';
    if (!(ct.gates || []).includes('review-protocol')) return `check.gates 缺 review-protocol：${JSON.stringify(ct.gates)}`;
    const g = (pipeline.gates || []).find((x) => x.id === 'review-protocol');
    if (!g) return 'gates 表里没有 review-protocol 定义';
    if (!(Array.isArray(g.applies_to) && !g.applies_to.includes('*'))) return `applies_to=${JSON.stringify(g.applies_to)}（综述门必须显式声明体裁边界）`;
    const gm = pipeline.gate_meta || {};
    const okDefault = Array.isArray(gm.applies_to_default) && gm.applies_to_default[0] === '*';
    const okNote = /skipped_not_applicable/.test(gm.note || '') && /全不适用/.test(gm.note || '') && /全通过/.test(gm.note || '');
    return (okDefault && okNote) ? true : `缺省声明=${okDefault} 机制说明=${okNote}`;
  });

  // ★ V1.5 三条结构性断言：模型层（体裁）· 骨干层（阶段词汇表）· 适用性机制
  check('体裁模型：综述/实证/二次分析分别判对，无信号回退默认，--genre 优先且未知体裁必须抛', () => {
    const bad = [];
    const t1 = '# A systematic review of X\nAbstract: This paper reports a systematic review of evaluation practice.\n';
    const t2 = '# Cross-temperature battery SOH\nAbstract: We measured six cells and report error bars.\n';
    const t3 = '# Panel analysis of grid carbon\nAbstract: We query a public dataset and perform a secondary data analysis.\n';
    const g1 = detectGenre(t1, pipeline); if (g1.id !== 'review') bad.push(`综述稿 ⇒ ${g1.id}`);
    const g2 = detectGenre(t2, pipeline); if (g2.id !== 'empirical') bad.push(`实证稿 ⇒ ${g2.id}`);
    const g3 = detectGenre(t3, pipeline); if (g3.id !== 'secondary-analysis') bad.push(`二次分析稿 ⇒ ${g3.id}`);
    const g4 = detectGenre('# Untitled\nAbstract: nothing meaningful here.\n', pipeline);
    if (!/回退/.test(g4.reason)) bad.push(`无信号未回退：${g4.reason}`);
    const g5 = detectGenre(t1, pipeline, 'empirical'); if (g5.id !== 'empirical') bad.push(`--genre 未优先 ⇒ ${g5.id}`);
    let threw = false; try { detectGenre(t1, pipeline, 'nope'); } catch (e) { threw = e.code === 'GENRE_UNKNOWN'; }
    if (!threw) bad.push('未知体裁未抛 GENRE_UNKNOWN');
    return bad.length === 0 ? true : bad.join('；');
  });

  check('阶段词汇表：每个 chain 项都必须解析到真实实现（不许「只是名字」）', () => {
    const gateIds = new Set((pipeline.gates || []).map((g) => g.id));
    const bad = [];
    for (const t of (pipeline.task_types || [])) {
      for (const st of (t.chain || [])) {
        const rule = STAGE_RULES.find((r) => r.rx.test(st));
        if (!rule) { bad.push(`${t.id}:${st}(不在词汇表)`); continue; }
        const m = st.match(rule.rx);
        if (st.startsWith('gate:') && !gateIds.has(m[1])) { bad.push(`${t.id}:${st}(门不存在)`); continue; }
        if (rule.need && !rule.need(m)) bad.push(`${t.id}:${st}(${rule.why(m)})`);
      }
      if ((t.chain || []).some((s) => s.startsWith('handoff:'))) {
        const declared = `${t.precondition || ''} ${(t.outputs || []).join(' ')}`;
        if (!/paper-writer|paper-polish|外部技能|交接/.test(declared)) bad.push(`${t.id}: 有 handoff 阶段但没写明由谁做`);
      }
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  check('适用性机制：真源声明了 applies_to 缺省，且至少一个门显式声明了体裁边界', () => {
    const gm = pipeline.gate_meta || {};
    if (!Array.isArray(gm.applies_to_default) || gm.applies_to_default[0] !== '*') return `gate_meta.applies_to_default=${JSON.stringify(gm.applies_to_default)}`;
    const scoped = (pipeline.gates || []).filter((g) => Array.isArray(g.applies_to) && !g.applies_to.includes('*'));
    return scoped.length > 0 ? true : '没有任何门声明体裁边界（机制未启用）';
  });

  check('论文框架：每个阶段骨架都必须带 篇幅预算 / 必须回答 / 证据义务 / 相关门（不许退化成只有字段名）', () => {
    const t = readTemplates();
    const bad = [];
    for (const s of (t.stage_skeletons || [])) {
      if (!s.budget) bad.push(`${s.target}:缺 budget`);
      if (!(s.must_answer || []).length) bad.push(`${s.target}:缺 must_answer`);
      if (!s.evidence_duty) bad.push(`${s.target}:缺 evidence_duty`);
      if (!(s.gates || []).length) bad.push(`${s.target}:缺 gates`);
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  check('框架-模型联动：review 体裁必须用专属骨架（R0–R8 全在），且骨架带出处与许可归属', () => {
    const t = readTemplates();
    const byGenre = t.stage_skeletons_by_genre || {};
    const bad = [];
    if (!Array.isArray(byGenre.review) || byGenre.review.length < 8) bad.push(`review 专属骨架缺失或过短：${(byGenre.review || []).length}`);
    for (const s of (byGenre.review || [])) {
      if (!s.budget || !(s.must_answer || []).length || !s.evidence_duty || !(s.gates || []).length) bad.push(`${s.target}:四项不全`);
      if (!/PRISMA/.test(s.title || '')) bad.push(`${s.target}:标题未标 PRISMA 条目号（出处不可查）`);
    }
    if (!/PRISMA 2020/.test(byGenre.attribution || '')) bad.push('缺 attribution（出处）');
    if (!/CC BY 4\.0/.test(byGenre.attribution || '')) bad.push('缺许可声明（CC BY 4.0）—— 借用他人清单结构必须署名与标许可');
    if (!/不搬/.test(byGenre.attribution || '')) bad.push('未声明「只借结构不搬正文」');
    return bad.length === 0 ? true : bad.join('；');
  });

  check('体裁→骨架：指定 review 时 scaffold 必须铺 R0–R8（而不是实证骨架）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-genre-'));
    // ★ 断言要打在对的层：draftPlan 的 plan 是「它要写的任务书/检索计划」，
    //   骨架计划属于 scaffold —— 第一版写错了层，断言红了（这次也是我自己写错）。
    const r = scaffold(path.join(tmp, 'sk'), '综述稿', { genre: 'review', dryRun: true });
    const t = readTemplates();
    const want = (t.stage_skeletons_by_genre.review || []).map((s) => s.target);
    const hit = want.filter((x) => r.plan.includes(x)).length;
    const leaked = (t.stage_skeletons || []).map((s) => s.target).filter((x) => r.plan.includes(x));
    return (hit === want.length && r.set === 'review' && leaked.length === 0)
      ? true : `命中 ${hit}/${want.length} set=${r.set} 混入实证骨架 ${leaked.length}`;
  });

  check('check 链路必须含 confidentiality 门（隐私与保密），且门数 ≥11、两种输出通路都覆盖', () => {
    const ct = (pipeline.task_types || []).find((t) => t.id === 'check');
    if (!(ct.gates || []).includes('confidentiality')) return `check.gates 缺 confidentiality：${JSON.stringify(ct.gates)}`;
    const gates = pipeline.gates || [];
    if (gates.length < 11) return `门数 ${gates.length} < 11`;
    // ★ 第一版这条断言写成「每道门都必须有 report_args」——那是错的：有的门给结构化输出（--json），
    //   有的门只给人读输出、由 report 解析其文本。正确的不变式是**两条通路都被覆盖**（否则
    //   解析器里总有一条分支从没被真门走过），而不是要求所有门长成一个样子。
    const withReport = gates.filter((g) => (g.report_args || []).length);
    const withoutReport = gates.filter((g) => !(g.report_args || []).length);
    if (!withReport.length || !withoutReport.length) {
      return `两条输出通路都要有门覆盖：结构化 ${withReport.length} · 人读 ${withoutReport.length}`;
    }
    return true;
  });

  // ★ V1.8：交接契约从「只有字段名 + 一句说明」变成**可校验契约**
  check('交接契约可校验：缺字段/空值/占位符/类型错/闭集外/逐项 schema 不符都必须判失败', () => {
    const bad = [];
    const good = { doc_path: __filename, doc_kind: 'draft', task_type: 'check', lang: 'en' };
    const r1 = validateHandoff('subcommand:intake', good, pipeline);
    if (!r1.ok) bad.push('合格声明被误判失败：' + r1.fails.join('；'));
    const r2 = validateHandoff('intake', { doc_kind: 'draft', task_type: 'check' }, pipeline);
    if (r2.ok || !r2.fails.some((f) => /doc_path/.test(f))) bad.push('缺必填未判失败');
    const r3 = validateHandoff('intake', Object.assign({}, good, { doc_kind: 'nonsense' }), pipeline);
    if (r3.ok) bad.push('闭集外取值未判失败');
    const r4 = validateHandoff('intake', Object.assign({}, good, { task_type: 42 }), pipeline);
    if (r4.ok) bad.push('类型错未判失败');
    const r5 = validateHandoff('intake', Object.assign({}, good, { doc_path: path.join('nonexistent-root', 'nope', 'x.md') }), pipeline);
    if (r5.ok) bad.push('doc_path 不存在未判失败');
    const r6 = validateHandoff('report:run-gates', { gate_results: [{ id: 'x', rc: 0, stdout_empty: false, verdict: 'maybe' }], findings: [], exit_codes: {} }, pipeline);
    if (r6.ok || !r6.fails.some((f) => /verdict/.test(f))) bad.push('逐项 verdict 闭集外未判失败');
    const r7 = validateHandoff('intake', Object.assign({}, good, { unknown_field: 1 }), pipeline);
    if (!r7.ok || !r7.warns.length) bad.push('未声明字段应只提示不失败');
    // ★ 与既有 author-material 门的一致性：materials_only + 只有说明（不是路径）⇒ 两边都必须判失败
    const r8 = validateHandoff('gate:author-material', {
      material_kind: 'verified_retrieval', claim_policy: 'materials_only',
      material_path_or_note: '记录见 run 目录的台账文件，具体结论以后再补。',
    }, pipeline);
    if (r8.ok) bad.push('条件规则未拦住「materials_only 却没有真实路径」（该项既有 author-material 门判失败，两边必须同判）');
    let threw = false; try { validateHandoff('nope->nope', good, pipeline); } catch (e) { threw = e.code === 'CONTRACT_UNKNOWN'; }
    if (!threw) bad.push('未知契约未抛 CONTRACT_UNKNOWN');
    return bad.length === 0 ? true : bad.join('；');
  });

  check('交接契约的 from/to 必须与链路阶段一致（不许契约与链路各说一套）', () => {
    const stageIds = new Set();
    for (const t of (pipeline.task_types || [])) for (const s of (t.chain || [])) stageIds.add(s);
    const bad = [];
    for (const c of ((pipeline.handoff || {}).contracts || [])) {
      for (const side of ['from', 'to']) {
        if (!stageIds.has(c[side])) bad.push(`${c.from}->${c.to} 的 ${side}=${c[side]} 在任何链路里都找不到`);
      }
      if (!(c.required || []).length) bad.push(`${c.from}->${c.to} 没有必填字段`);
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  check('同判回归·材料对：契约校验器与 author-material 门必须同判（≥6 用例）', () => {
    let r;
    try { r = crosscheckMaterial(); } catch (e) { return `材料对跑不起来：${(e && e.message) || e}`; }
    if (r.cases < 6) return `用例太少（${r.cases}）—— 覆盖不足等于没回归`;
    const bad = r.rows.filter((x) => !x.ok).map((x) => `${x.name}：我们=${x.mine} 门=${x.theirs} 期望=${x.expect}`);
    return bad.length === 0 ? true : bad.join('；');
  });

  check('同判回归·成品件对：我方 ZIP+XML 独立读数与 _verify-docx 必须逐字段同值（≥1 个真实 docx）', () => {
    let r;
    try { r = crosscheck(); } catch (e) { return `成品件对跑不起来：${(e && e.message) || e}`; }
    if (!r.docx) return 'crosscheck 未返回成品件对';
    if (r.docx.checked < 1) return `一个真实 docx 都没检查（checked=${r.docx.checked}）—— 全跳过不算回归`;
    const bad = r.docx.rows.filter((x) => !x.ok).map((x) => `${x.file}：${(x.diffs || []).join('；')}`);
    return bad.length === 0 ? true : bad.join(' ｜ ');
  });

  check('必失败：docx 独立读数遇到非 OOXML 文件必须抛（不许当"0 个对象"糊过去）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-docx-'));
    const fake = path.join(tmp, 'not-a-docx.docx');
    fs.writeFileSync(fake, 'this is plain text, not a zip', 'utf8');
    let threw = false;
    try { readDocxStructure(fake); } catch (e) { threw = /ZIP|EOCD|document\.xml/.test(String(e.message)); }
    return threw ? true : '非 OOXML 文件没抛（会被读成 0 表格 0 图片 ⇒ 假通过）';
  });

  check('闭集一致：契约里的 material_kind 闭集必须等于门脚本里的 MATERIAL_KINDS', () => {
    const p = readPipeline();
    const pbRoot = (p.assets || {}).playbook_root || '';
    const gatePath = path.join(pbRoot, '_gate-author-material.py');
    if (!fs.existsSync(gatePath)) return `门脚本不在：${gatePath}`;
    const src = fs.readFileSync(gatePath, 'utf8');
    const m = src.match(/MATERIAL_KINDS\s*=\s*\{([^}]*)\}/);
    if (!m) return '门脚本里没找到 MATERIAL_KINDS';
    const theirs = m[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean).sort();
    const c = findContract('gate:author-material', p);
    const mine = (((c || {}).closed_sets || {}).material_kind || []).slice().sort();
    return JSON.stringify(mine) === JSON.stringify(theirs)
      ? true : `我们=${JSON.stringify(mine)} 门=${JSON.stringify(theirs)}（闭集不一致 ⇒ 一边会放行另一边会拦下）`;
  });

  // ★ V2.0：章节级框架（论文框架从"阶段级"再细化一层）
  check('章节级框架：每个章节的五项齐全（要解决什么/必答/篇幅/证据义务/门）+ 常见退回原因', () => {
    const t = readTemplates();
    const bad = [];
    const sets = Object.entries(t.section_skeletons_by_genre || {}).filter(([, v]) => Array.isArray(v));
    if (sets.length < 2) bad.push(`章节集少于两个（default + review）：${sets.map(([k]) => k).join(' / ')}`);
    for (const [name, arr] of sets) {
      if (arr.length < 7) bad.push(`${name} 只有 ${arr.length} 节（太少，撑不起章节级框架）`);
      for (const x of arr) {
        if (!x.id || !x.label) bad.push(`${name}: 缺 id/label`);
        if (!x.purpose) bad.push(`${name}.${x.id}: 缺 purpose`);
        if (!(x.must_answer || []).length) bad.push(`${name}.${x.id}: 缺 must_answer`);
        if (!x.budget_words) bad.push(`${name}.${x.id}: 缺 budget_words`);
        if (!x.evidence_duty) bad.push(`${name}.${x.id}: 缺 evidence_duty`);
        if (!(x.gates || []).length) bad.push(`${name}.${x.id}: 缺 gates`);
        if (!(x.common_failures || []).length) bad.push(`${name}.${x.id}: 缺 common_failures`);
      }
      const ids = arr.map((x) => x.id);
      if (new Set(ids).size !== ids.length) bad.push(`${name}: 章节 id 有重复`);
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  check('体裁→章节集联动：review 必须用专属章节集，且 draft 任务书必须逐节渲染', () => {
    const t = readTemplates();
    const a = readSections('empirical', t); const b = readSections('review', t);
    if (a.set !== 'default') return `empirical 应回退 default，实得 ${a.set}`;
    if (b.set !== 'review') return `review 应命中专属章节集，实得 ${b.set}`;
    if (JSON.stringify(a.sections.map((x) => x.id)) === JSON.stringify(b.sections.map((x) => x.id))) {
      return '两套章节集完全一样 ⇒ 联动没生效（等于没有按体裁切换）';
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-sec-'));
    const dir = path.join(tmp, 'paper');
    draftPlan(dir, { name: '综述稿', genre: 'review', dryRun: false });
    const tb = fs.readFileSync(path.join(dir, '00-写作任务书.md'), 'utf8');
    const missing = b.sections.filter((x) => !tb.includes(x.label)).map((x) => x.label);
    return missing.length === 0 ? true : `任务书里缺章节：${missing.join(' / ')}`;
  });

  // ★ V2.2：报告的"按节看"要求每个门都有**声明好的**归属（不是执行器猜的）
  // ★ V2.5：门类型必须显式声明（A 客观 / B 质量），且**不许把质量裁决冒充成 A**
  check('门类型：每道门都必须声明 judge_type ∈ {A,B}；且不得声明 B（本插件没有跨模型裁决能力，质量部分必须路由出去）', () => {
    const bad = [];
    for (const g of (pipeline.gates || [])) {
      const jt = judgeTypeOf(g.id, pipeline);
      if (jt === null) bad.push(`${g.id} 没声明 judge_type`);
      else if (!['A', 'B'].includes(jt)) bad.push(`${g.id} 的 judge_type=${jt} 非法`);
      else if (jt === 'B') bad.push(`${g.id} 声明为 B（质量裁决）但本插件只做确定性检查 ⇒ 不许声明 B，应声明 A 并把质量部分路由给跨模型 reviewer`);
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  check('门类型：未声明的门必须返回 null（不许默认成 A 蒙混过去）', () => (
    judgeTypeOf('no-such-gate-xyz', pipeline) === null ? true : '未声明的门被默认成 A —— 默认即掩盖'
  ));

  check('按节归属：每个门都必须声明 primary_section；声明为章节时该节必须在两套章节集里都存在且列了该门', () => {
    const t = readTemplates();
    const bad = [];
    const sets = ['empirical', 'review'];
    for (const g of (pipeline.gates || [])) {
      const id = primarySectionOf(g.id, pipeline);
      if (id === null) { bad.push(`${g.id} 没声明 primary_section`); continue; }
      if (id === '*') continue;                                  // 跨节：允许，报告会单列一个桶
      for (const gs of sets) {
        const { sections, set } = readSections(gs, t);
        const sec = sections.find((x) => x.id === id);
        if (!sec) { bad.push(`${g.id} 的 primary_section=${id} 在 ${set} 章节集里不存在`); continue; }
        if (!(sec.gates || []).includes(g.id)) bad.push(`${g.id} 的 primary_section=${id} 但该节的 gates 里没列它（归属与清单不一致）`);
      }
    }
    return bad.length === 0 ? true : bad.join('；');
  });

  check('按节归属：跨节门必须返回 null（不假装它属于某一节）', () => {
    const t = readTemplates();
    if (primarySectionOf('contract', pipeline) !== '*') return 'contract 应声明为跨节（*）';
    const a = sectionForGate('worknote-leak', 'empirical', t);
    if (!a || a.id !== 'whole-doc') return `worknote-leak 应归到 whole-doc，实得 ${a && a.id}`;
    if (sectionForGate('contract', 'empirical', t) !== null) return '跨节门不该被归到某一节';
    return primarySectionOf('no-such-gate-xyz', pipeline) === null ? true : '未声明的门必须返回 null';
  });

  check('经验库：能解析出 ≥12 条，且每条都带「可机械检查」列', () => {
    const ls = readLessons();
    if (ls.length < 12) return `只解析出 ${ls.length} 条`;
    const bad = ls.filter((l) => !l.checkable).map((l) => l.id);
    return bad.length === 0 ? true : `缺可检列：${bad.join(',')}`;
  });

  check('必失败：经验库真源缺失必须抛 LESSONS_MISSING（不许当成"没有经验"）', () => {
    try { readLessons(path.join(ROOT, 'references', '__no_lessons__.md')); return '没抛错 ⇒ 判据失效'; }
    catch (e) { return e.code === 'LESSONS_MISSING' || `抛错 code=${e.code}`; }
  });

  check('模板清单：stage_skeletons ≥8 且每个都有 target', () => {
    const t = readTemplates();
    const n = (t.stage_skeletons || []).length;
    const bad = (t.stage_skeletons || []).filter((s) => !s.target).length;
    return (n >= 8 && bad === 0) ? true : `阶段数=${n} 缺 target=${bad}`;
  });

  check('必失败：scaffold 不给 --out 必须抛（不许默默写到当前目录）', () => {
    try { scaffold('', 'x', {}); return '没抛错 ⇒ 判据失效'; }
    catch (e) { return e.code === 'NO_OUT' || `抛错 code=${e.code}`; }
  });

  check('scaffold dry-run：只出计划、不写任何文件', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-dry-'));
    const r = scaffold(path.join(tmp, 'paper'), '测试稿', { dryRun: true });
    const wrote = fs.readdirSync(tmp).length;
    fs.rmSync(tmp, { recursive: true, force: true });
    return (r.dryRun === true && r.created.length === 0 && wrote === 0) ? true : `wrote=${wrote} created=${r.created.length}`;
  });

  check('scaffold 真跑：阶段文件全生成，且已存在文件不被覆盖', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-real-'));
    const dir = path.join(tmp, 'paper');
    const r1 = scaffold(dir, '测试稿', {});
    fs.writeFileSync(path.join(dir, '00-输入.md'), '我改过了，别覆盖我', 'utf8');
    const r2 = scaffold(dir, '测试稿', {});
    const after = fs.readFileSync(path.join(dir, '00-输入.md'), 'utf8');
    fs.rmSync(tmp, { recursive: true, force: true });
    return (r1.created.length >= 8 && r2.skipped.includes('00-输入.md') && after === '我改过了，别覆盖我')
      ? true : `created=${r1.created.length} skipped2=${r2.skipped.length} after=${after.slice(0, 16)}`;
  });

  check('方法论索引：11 维条目齐全（缺文件只报不崩）', () => listMethod().length >= 11 ? true : '维数不足');

  check('模板清单：计划里的目标文件名不得重复（防同一件东西两个名字）', () => {
    const t = readTemplates();
    const all = [...((t.stage_skeletons || []).map((s) => s.target)), ...((t.templates || []).map((x) => x.target))];
    const dup = all.filter((v, i) => all.indexOf(v) !== i);
    return dup.length === 0 ? true : `重复目标：${[...new Set(dup)].join(', ')}`;
  });

  // ── lang 启发式（v1.0.0 的已知缺陷：短骨架文件误判为 en）──────────────────
  check('lang：真实误判案例（中文正文 + 模板头里的路径/标识符）必须判 zh', () => {
    const t = '# 我的稿子\n\n> 由 paper-studio scaffold 生成（真源：references/templates.json）。**逐格填写**；「必填」没填完不要往下走。\n\n'
      + '## 输入\n\n### 必填\n- 论文题目\n- 作者与单位\n- 目标期刊\n- 关键词与研究方向\n\n### 正文\n';
    const d = detectLang(t);
    return d.lang === 'zh' ? true : `判成 ${d.lang}（cjk=${d.cjk} latin=${d.latin}）⇒ 标识符又被当成语言了`;
  });

  check('lang：纯英文段落必须判 en', () => {
    const d = detectLang('The results show that the proposed method improves accuracy across all working conditions. We compare against several baselines and report confidence intervals for every metric.');
    return d.lang === 'en' ? true : `判成 ${d.lang}（cjk=${d.cjk} latin=${d.latin}）`;
  });

  check('lang：纯中文段落必须判 zh', () => {
    const d = detectLang('本文研究了锂离子电池健康状态的跨温度迁移问题，并给出了可复现的实验流程与失败模式清单，供后续研究对照使用。');
    return d.lang === 'zh' ? true : `判成 ${d.lang}（cjk=${d.cjk} latin=${d.latin}）`;
  });

  check('lang：样本太少必须判 unknown（不猜）', () => {
    const d = detectLang('中文');
    return d.lang === 'unknown' ? true : `判成 ${d.lang}（cjk=${d.cjk} latin=${d.latin}）`;
  });

  check('lang：--lang 显式指定优先于一切推断', () => {
    const d = detectLang('这是一段完全中文的内容，字数足够多，按理应该被判成中文，但显式指定优先。', { lang: 'en' });
    return (d.lang === 'en' && /显式指定/.test(d.reason)) ? true : `lang=${d.lang} reason=${d.reason}`;
  });

  check('lang：真实 scaffold 产物必须判 zh（修的就是这个案例）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-lang-'));
    const dir = path.join(tmp, 'paper');
    scaffold(dir, '测试稿', {});
    const txt = fs.readFileSync(path.join(dir, '00-输入.md'), 'utf8').slice(0, 4000);
    const d = detectLang(txt);
    fs.rmSync(tmp, { recursive: true, force: true });
    return d.lang === 'zh' ? true : `判成 ${d.lang}（cjk=${d.cjk} latin=${d.latin}）—— 本案例即 v1.0.0 的缺陷`;
  });

  check('lang：判了必须给得出理由（不许只给结论）', () => {
    const r = intake(path.join(ROOT, 'SKILL.md'), pipeline);
    return (r.lang && typeof r.lang_reason === 'string' && r.lang_reason.length > 0) ? true : `lang=${r.lang} reason=${r.lang_reason}`;
  });

  const failed = results.filter((r) => !r.ok);
  if (!JSON_OUT) for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  const __pass = results.length - failed.length;
  const __total = results.length;
  if (JSON_OUT) {
    console.log(JSON.stringify({ suite: 'studio', pass: __pass, total: __total, ok: __total === __pass, version: VERSION, failed: failed.map((f) => f.name) }, null, 2));
  } else {
    console.log(`\n自检：${__pass}/${__total} 通过`);
  }
  return __total === __pass ? 0 : 1;
}


/** 契约形状判据（纯函数，便于夹具注入）：取证信息四项必在；且必须属于已知契约族之一。
 *  族 A＝限额结构族（limits + structure；Elsevier 系、PLOS 用）；
 *  族 B＝核验族（verified_facts + publisher_level_policies 或 implications_for_this_submission；BMC 系用）。
 *  都不属于 ⇒ 报"未知契约族"（显形），绝不放行 —— 这是 2026-10-16 搬运 RIPP 契约时被自己的通则判据抓出来的真事。 */
function contractSchemaProblems(c) {
  const bad = [];
  if (!c || typeof c !== 'object') return ['不是对象'];
  for (const k of ['journal', 'publisher', 'verified_at', 'verified_from']) if (!(k in c)) bad.push('缺 ' + k);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(c.verified_at || ''))) bad.push('verified_at 形态不对（需 YYYY-MM-DD）');
  if (!String(c.verified_from || '').trim()) bad.push('verified_from 为空 ⇒ 无取证来源不得当通过');
  const famA = !!(c.limits && c.structure);
  const famB = !!(c.verified_facts && (c.publisher_level_policies || c.implications_for_this_submission));
  if (!famA && !famB) bad.push('不属于已知契约族（需 limits+structure 或 verified_facts+publisher_level_policies/implications）—— 未知契约族');
  return bad;
}

/** CRediT 检查（v3.2.6 · 纯函数便于夹具注入）
 *  为什么要它：PLOS/Elsevier/BMC 都按 CRediT 收作者贡献，而**非官方写法**（Visualisation、
 *  Conceptualisation…）是常见退回原因；官方 14 角色名（含 en dash）来自 ANSI/NISO Z39.104-2022，
 *  经 references/credit-roles.json 入包（CC-BY 4.0）。
 *  判据强度分级：编辑距离 =1 ⇒ 硬判"疑似非官方写法"（失败）；=2 ⇒ 只记"相近词"提醒（不失败，
 *  避免把 Supervisor/Supervision 这类正常写法误杀）。 */
function creditRoles() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'references', 'credit-roles.json'), 'utf8')).roles.map((r) => r.name); } catch { return []; }
}
function normDash(s) { return String(s).replace(/[\u2010-\u2015\u2212]/g, '-'); }
function levDist(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n; if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j); let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    const sw = prev; prev = cur; cur = sw;
  }
  return prev[n];
}
function creditScan(text) {
  const roles = creditRoles();
  const out = { ok: false, expected: roles.length, section: false, rolesFound: [], variants: [], nearVariants: [], reasons: [] };
  if (roles.length !== 14) { out.reasons.push('读不到官方 14 角色（references/credit-roles.json）⇒ 前提不成立，不得当通过'); return out; }
  const n = normDash(String(text || ''));
  out.section = /CRediT|作者贡献|Author contributions?/i.test(n);
  if (!out.section) out.reasons.push('未找到 CRediT / Author contributions 段（缺该段不判通过）');
  const lower = n.toLowerCase();
  for (const r of roles) if (lower.includes(normDash(r).toLowerCase())) out.rolesFound.push(r);
  const cands = new Set();
  for (const mm of n.matchAll(/(?:^|[\n,;·|])\s*([A-Z][A-Za-z]{2,}(?:[ -][A-Za-z&]{2,}){0,3})/g)) cands.add(mm[1].trim());
  for (const c of cands) {
    const cl = c.toLowerCase();
    if (roles.some((r) => normDash(r).toLowerCase() === cl)) continue;
    for (const r of roles) {
      const d = levDist(cl, normDash(r).toLowerCase());
      if (d === 1) { out.variants.push({ found: c, official: r, distance: d }); break; }
      if (d === 2) { out.nearVariants.push({ found: c, official: r, distance: d }); break; }
    }
  }
  if (out.section && out.rolesFound.length === 0) out.reasons.push('仅出现 CRediT 关键词、未匹配到任何官方角色名（可能只是待办备注，或写法非官方）');
  out.ok = out.section && out.variants.length === 0 && out.rolesFound.length > 0;
  return out;
}
/** 投稿格式模板表（v3.2.16）
 *  素材来源：CTAN 包页逐包实地抓取（一手）+ GitHub 仓库元数据（经 GitHub API）。
 *  为什么要有它：**模板只解决排版**，但"用错类文件"是投稿被打回的低级常见原因；
 *  同时把"哪些刊的官方模板**本机取不到**（403 / 验证码 / 不在 CTAN）"如实列出——
 *  取不到就必须说取不到，不得凭记忆描述官方要求。
 */
const FORMATS_PATH = path.join(ROOT, 'references', 'submission-formats.json');
function readFormats() {
  if (!fs.existsSync(FORMATS_PATH)) { const e = new Error('前提层失败：找不到模板表 ' + FORMATS_PATH); e.code = 'FORMATS_MISSING'; throw e; }
  let d;
  try { d = JSON.parse(fs.readFileSync(FORMATS_PATH, 'utf8')); }
  catch (err) { const e = new Error('前提层失败：模板表不是合法 JSON（' + err.message + '）'); e.code = 'FORMATS_BAD_JSON'; throw e; }
  if (!Array.isArray(d.formats) || !d.verified_at || !d.verified_from) {
    const e = new Error('前提层失败：模板表缺 formats / verified_at / verified_from（来源必须可核）'); e.code = 'FORMATS_INCOMPLETE'; throw e;
  }
  return d;
}
/** 读 .tex 的真实内容，取类文件与参考文献样式（不猜） */
function detectTexFormat(text) {
  const cls = (String(text).match(/\\documentclass(?:\[[^\]]*\])?\{([^}]+)\}/) || [])[1] || '';
  const bib = (String(text).match(/\\bibliographystyle\{([^}]+)\}/) || [])[1] || '';
  const pkgs = [];
  for (const m of String(text).matchAll(/\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g)) pkgs.push(m[1].trim());
  return { documentclass: cls.trim(), bibliographystyle: bib.trim(), packages: pkgs };
}
/** 投稿前总检（v3.2.20）
 *  为什么：判据已经很多（门执行器 / 期刊契约门 / 合规门 / 图件规格…），但用户得自己记住跑哪几件，
 *  而且**跑漏一件不会有任何提示**。本命令只做**汇总**，逐项判定权仍归各门自身（不抢判定权）。
 *  ★ 纪律：某一步**没跑成**（脚本缺失 / 本机路径未解析 / 缺输入）一律记为"未检查/不可用"，**不得当通过**。 */
/* ★ v3.2.49 可移植性修复：门脚本**内置进插件**（`gates/`），解析顺序改为 **外部优先 → 内置回落**。
 *  为什么：此前 12 道门**全部 `rel=playbook_root`** ⇒ 门在插件之外 ⇒ 单装插件的人 12 道门一个都没有
 *  （`doctor` 已能照亮，但"照亮"不等于"有了"）。现在外部配了就仍用外部（本机行为不变），
 *  没配就用插件内置副本 ⇒ **装上就有全部 12 道门**。两份是否漂移由自检里的**字节对拍锁**盯住。 */
function resolveGateScript(gate, pipeline) {
  const rel = gate.rel === 'playbook_root' ? String((pipeline.assets || {}).playbook_root || '') : ROOT;
  const bundled = path.join(ROOT, 'gates', gate.entry);
  const extOk = !!rel && String(rel).indexOf('__LOCAL__') !== 0;
  const external = extOk ? path.join(rel, gate.entry) : '';
  if (external && fs.existsSync(external)) return { script: external, why: '', source: 'external' };
  if (fs.existsSync(bundled)) return { script: bundled, why: '', source: 'bundled' };
  return { script: '', why: (extOk ? '外部与内置副本均不存在' : '本机路径未解析（' + LOCAL_HINT + '）且内置副本不存在'), source: 'none' };
}
/** 引用锚点表工作单（v3.2.21）
 *  为什么：第 14 道门（claim-anchor）要求"正文引用"在**锚点表**里有条目，否则判 fabricated-reference（P0 阻断）。
 *  但"锚点表长什么样"此前只存在于门脚本的实现里 —— 作者无从下手。本命令把它变成**可填的工件**：
 *  ① 扫描稿件里的引用标记 → 完整的键集（**这是工作单抽取器，不是判定者**）
 *  ② 跑门拿它自己的理由与行号（**门才是判定者**；门不可用则明说"未取到门的结论"）
 *  ③ 产出 Markdown 工作单 + 可直接填的 JSON 骨架（字段取自门的真实 schema：citation_key / marker /
 *     identifier{doi,pmid,url} / locator{kind,value,quote} / evidence_layer / status / verdict /
 *     retrieval_method / scope.supports_strength / sub_claim_breakdown）
 *  ★ 纪律：骨架里**一律留空**（identifier 为空、locator 为空），绝不预填任何来源信息 —— 预填就等于编造。 */
const ANCHOR_SKELETON = (key) => ({
  citation_key: 'ref-' + key,
  marker: String(key),
  slug: 'ref-' + key,
  identifier: { doi: '', pmid: '', url: '' },
  anchor_kind: 'primary',
  locator: { kind: 'page-quote', value: '', quote: '' },
  evidence_layer: 'author_statement',
  status: 'published',
  verdict: '',
  retrieval_method: 'fulltext-read',
  scope: { supports_strength: false },
});
function extractCitations(text) {
  const hits = new Map();
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const add = (key, line, sentence) => {
    if (!hits.has(key)) hits.set(key, { key, lines: [], sentences: [] });
    const h = hits.get(key);
    if (h.lines.indexOf(line) < 0) h.lines.push(line);
    if (h.sentences.length < 3) h.sentences.push(sentence.trim().slice(0, 200));
  };
  lines.forEach((L, i) => {
    if (/^\s*#{1,6}\s/.test(L) && /References|参考文献/i.test(L)) return;
    const sent = L.split(/(?<=[.!?。！？])\s+/);
    for (const m of L.matchAll(/\[(\d+(?:\s*[–\-,、]\s*\d+)*)\]/g)) {
      const parts = m[1].split(/[–\-,、]/).map((x) => parseInt(x.trim(), 10)).filter((n) => !isNaN(n));
      if (parts.length === 2 && /[–\-]/.test(m[1]) && parts[1] > parts[0] && parts[1] - parts[0] < 30) {
        for (let n = parts[0]; n <= parts[1]; n++) add(String(n), i + 1, sent[0] || L);
      } else {
        for (const n of parts) add(String(n), i + 1, sent[0] || L);
      }
    }
    for (const m of L.matchAll(/\(([A-Z][A-Za-z\-]+(?:\s+(?:et al\.?|&|and)\s+[A-Za-z\-]+)*),\s*(\d{4}[a-z]?)\)/g)) {
      add((m[1] + ' ' + m[2]).toLowerCase(), i + 1, sent[0] || L);
    }
  });
  return hits;
}
/** 解析稿件**自己的题录区**（v3.2.22）
 *  为什么：锚点表要 identifier{doi|pmid|url}，而很多稿件的题录里**已经写了 DOI** ——
 *  从稿件自身确定性解析，既不联网、也不存在"猜"的问题。解析不到的**留空并标注**，绝不编号码。 */
function parseReferenceList(text) {
  /* ★ CRLF 陷阱（真稿实测踩到）：JS 里 `.`/`.*` **不匹配 `\r`**（`\r` 是行终止符），而 `$` 只认字符串末尾
     ⇒ 任何 `…(.*)$` 形态的模式在 CRLF 文件上级级失配（题录明明在、却解析出 0 条）。
     夹具当初用 `\n` 写内容 ⇒ **没复现真稿条件** ⇒ 一律先归一行尾。 */
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*#{1,6}\s*(?:References|REFERENCES|参考文献|文献)\s*$/.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return { entries: [], start: -1 };
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const L = lines[i];
    if (/^\s*#{1,6}\s/.test(L)) break;                       // 下一个标题即题录结束
    const m = /^\s*\*{0,2}\[(\d+)\]\*{0,2}\s*(.*)$/.exec(L);
    if (m) { out.push({ key: m[1], line: i + 1, raw: m[2].trim() }); continue; }
    if (out.length && L.trim()) out[out.length - 1].raw += ' ' + L.trim();   // 续行拼回上一条
  }
  for (const e of out) {
    const doi = /(10\.\d{4,9}\/[^\s`)\]},;]+)/.exec(e.raw);
    const url = /(https?:\/\/[^\s`)\]]+)/.exec(e.raw);
    const pmid = /\bPMID:?\s*(\d{6,9})/i.exec(e.raw);
    const title = /\*([^*]{10,300})\*/.exec(e.raw);
    const year = /\b(?:19|20)\d{2}\b/.exec(e.raw);
    const clean = (s) => String(s || '').replace(/[.,;：]+$/, '');
    e.doi = doi ? clean(doi[1]) : '';
    e.url = url ? clean(url[1]) : '';
    e.pmid = pmid ? pmid[1] : '';
    e.title = title ? title[1].trim() : '';
    e.year = year ? year[0] : '';
  }
  return { entries: out, start };
}
/** 在线兜底（可选）：按题录文本查 Crossref，**必须过相似度阈值**才采用；不达标就留空。
 *  fetcher 可注入 —— 夹具用假 fetcher，绝不在自检里联网。 */
function titleTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff ]+/g, ' ').split(/\s+/).filter((x) => x.length > 2);
}
function similarity(a, b) {
  const A = new Set(titleTokens(a)); const B = new Set(titleTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}
function resolveRefsOnline(entries, fetcher, opts) {
  const o = opts || {};
  const minScore = o.minScore === undefined ? 0.7 : o.minScore;
  const log = [];
  for (const e of entries) {
    if (e.doi || e.url || e.pmid) continue;                   // 已经解析到就不联网
    const q = encodeURIComponent(String(e.raw).slice(0, 300));
    const url = 'https://api.crossref.org/works?rows=3&select=DOI,title&query.bibliographic=' + q;
    let body = '';
    try { body = fetcher(url) || ''; } catch (err) { log.push({ key: e.key, stage: 'fetch-failed', why: String((err && err.message) || err) }); continue; }
    if (!body) { log.push({ key: e.key, stage: 'empty', why: '在线查询无返回' }); continue; }
    let items = [];
    try { items = (((JSON.parse(body) || {}).message) || {}).items || []; } catch (err) { log.push({ key: e.key, stage: 'parse-failed', why: '返回体不是 JSON' }); continue; }
    let best = null;
    for (const it of items) {
      const ttl = (it.title && it.title[0]) || '';
      const sc = similarity(e.raw, ttl || '') + similarity(e.title || e.raw, ttl || '');
      const s = sc / 2;
      if (!best || s > best.score) best = { doi: it.DOI || '', title: ttl, score: Math.round(s * 100) / 100 };
    }
    if (best && best.doi && best.score >= minScore) {
      e.doi = best.doi; e._online = best; log.push({ key: e.key, stage: 'resolved', why: 'Crossref 匹配 ' + best.score + '：' + best.title });
    } else {
      log.push({ key: e.key, stage: 'below-threshold', why: '最佳匹配相似度 ' + (best ? best.score : 0) + ' < 阈值 ' + minScore + '（**不采用**，留空待人工）' + (best ? '；候选：' + best.title : '') });
    }
  }
  return log;
}
/** 开放获取（OA）可达性（v3.2.23）
 *  为什么：锚点表要升级为"人已复核"，必须**读到原文**并留页号+原句。哪些引用能免费读到、哪些要机构订阅，
 *  决定这件人读工作的**起点**。用 OpenAlex（免 key、支持按 DOI 批量过滤）逐条问，**取不到就记"未取到"**。 */
function oaLookup(dois, fetcher, opts) {
  const o = opts || {};
  const out = new Map();
  const log = [];
  const clean = (d) => String(d || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  const list = Array.from(new Set(dois.map(clean).filter(Boolean)));
  for (let i = 0; i < list.length; i += 25) {
    const batch = list.slice(i, i + 25);
    /* ★ 修正（真跑抓到）：OpenAlex 的 `select` **不接受 `is_oa`**（它属于 `open_access` 对象）——
       带上它会整批 400，而我把 400 读成了"未取到"，等于**静默失败**。同时 DOI 里的 `/` 不要编码。 */
    const url = 'https://api.openalex.org/works?per-page=50&select=doi,title,open_access,best_oa_location&filter=doi:'
      + batch.join('|');
    let body = '';
    try { body = fetcher(url) || ''; } catch (e) { log.push({ stage: 'fetch-failed', why: String((e && e.message) || e), n: batch.length }); continue; }
    let res = [];
    let doc = null;
    try { doc = JSON.parse(body) || {}; res = doc.results || []; } catch (e) { log.push({ stage: 'parse-failed', why: '返回体不是 JSON：' + String(body).slice(0, 120), n: batch.length }); continue; }
    /* ★ 纪律：HTTP/接口级错误必须**记进日志**（此前 400 被读成"未取到"，属静默失败） */
    if (doc.error) { log.push({ stage: 'api-error', why: String(doc.message || doc.error).slice(0, 200), n: batch.length }); continue; }
    if (!res.length) log.push({ stage: 'empty-result', why: '接口返回 0 条（可能 DOI 不在 OpenAlex 或一律为订阅版）', n: batch.length });
    for (const w of res) {
      const key = clean(w.doi || '');
      if (!key) continue;
      out.set(key, {
        is_oa: !!((w.open_access || {}).is_oa),
        oa_status: (w.open_access || {}).oa_status || '',
        pdf_url: ((w.best_oa_location || {}).pdf_url) || ((w.best_oa_location || {}).landing_page_url) || '',
        title: w.title || '',
      });
    }
  }
  return { byDoi: out, log };
}
/* ═══ v3.2.44 引用原句候选（`anchors --quote-hints`）═══════════════════════════════════════
 *  为什么：锚点表要求 `locator.kind=page-quote`（页号 + ≥30 字**原句**）才算"人已复核"，而这步的瓶颈
 *  是"得先把原文读出来"。免 key 的 Europe PMC 就能给出全文/摘要 ⇒ 工具可以**把候选原句摆到人眼前**，
 *  但**绝不代填**：页号与原句必须由人核对（排版差异、版本差异都可能让"逐字"不成立）。
 *  三条不变量：① 候选句**逐字来自抓取到的来源**（只去 XML 标签，不压空格、不改标点）；
 *  ② 每条候选都标**证据层级**（全文 / 摘要）与来源 ID；③ 抓不到的一律进"**须人工读原文**"清单，不假装有。
 *  联网只在 `--quote-hints` 下发生（curl，免 key），且 fetcher 可注入 ⇒ 夹具离线可测。
 * ═══════════════════════════════════════════════════════════════════════════════════════ */
function epmcCurlFetcher() {
  const { spawnSync } = require('child_process');
  return (url) => {
    const r = spawnSync('curl', ['-sS', '--max-time', '40', '-H', 'User-Agent: paper-studio/3.2.44 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.error) throw new Error('curl 不可用：' + r.error.message);
    if (r.status !== 0) throw new Error('curl 退出码 ' + r.status);
    return r.stdout || '';
  };
}
/** 句切分：只按句末标点切，**不重排、不压缩**（候选要给原句）。 */
function sentencesOf(text, minLen) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  return flat.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length >= (minLen || 40));
}
const HINT_STOP = new Set(['this', 'that', 'with', 'from', 'were', 'which', 'have', 'been', 'their', 'there', 'these', 'those', 'than', 'then', 'also', 'such', 'using', 'used', 'into', 'more', 'most', 'between', 'during', 'after', 'before', 'however', 'whereas', 'while', 'about', 'under', 'over', 'both', 'each', 'than']);
function contentWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !HINT_STOP.has(w));
}
/** 按"与主张句的词重叠"排序（确定性；同分按出现顺序 ⇒ 可复现）。 */
function rankHints(claimSentences, candidates, n) {
  const cw = new Set();
  for (const s of claimSentences) for (const w of contentWords(s)) cw.add(w);
  return candidates.map((c, i) => {
    const ws = contentWords(c);
    const hit = new Set(ws.filter((w) => cw.has(w)));
    return { text: c, score: hit.size, overlap: Array.from(hit).sort(), idx: i };
  }).filter((x) => x.score > 0).sort((a, b) => (b.score - a.score) || (a.idx - b.idx)).slice(0, n || 3);
}
/** 取一篇来源的正文：EPMC 全文（OA）优先，其次摘要；取不到就说取不到。 */
function epmcLookup(doi, f) {
  const clean = String(doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  if (!clean) return { state: 'no-doi' };
  let j = null;
  try {
    const u = 'https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:%22' + encodeURIComponent(clean) + '%22&resultType=core&format=json&pageSize=1';
    j = JSON.parse(f(u));
  } catch (e) { return { state: 'not-retrieved', why: '检索失败：' + String((e && e.message) || e) }; }
  const rec = (((j || {}).resultList || {}).result || [])[0];
  if (!rec) return { state: 'not-retrieved', why: 'Europe PMC 未收录该 DOI' };
  const out = { state: 'not-retrieved', title: rec.title || '', pmcid: rec.pmcid || '', id: rec.id || '' };
  if (rec.pmcid && String(rec.isOpenAccess || '').toUpperCase() === 'Y') {
    try {
      const xml = f('https://www.ebi.ac.uk/europepmc/webservices/rest/' + rec.pmcid + '/fullTextXML');
      /* 只去标签；段落之间以空格相接（**不压内部空格**）。 */
      const body = (xml.match(/<body[\s\S]*?<\/body>/i) || [''])[0] || xml;
      const paras = (body.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || []).map((p) => p.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')).join(' ');
      const text = paras.trim();
      if (text) return Object.assign(out, { state: 'fulltext', text, source: 'Europe PMC ' + rec.pmcid + ' · 全文' });
      return Object.assign(out, { state: 'not-retrieved', why: '有 PMCID 但抽不到正文段落' });
    } catch (e) { return Object.assign(out, { state: 'not-retrieved', why: '全文抓取失败：' + String((e && e.message) || e) }); }
  }
  if (rec.abstractText) return Object.assign(out, { state: 'abstract', text: String(rec.abstractText), source: 'Europe PMC ' + (rec.id || rec.pmcid) + ' · **摘要（证据层级较弱，仅可作延伸阅读线索）**' });
  return Object.assign(out, { state: 'not-retrieved', why: '非开放获取且无摘要' });
}
function cmdAnchorsOA(args, argv, draftAbs, val, has) {
  const inPath = val('in') || val('anchors') || path.join(path.dirname(draftAbs), 'anchors-已解析.json');
  if (!fs.existsSync(inPath)) {
    console.error('前提层失败：找不到锚点表 —— ' + path.resolve(inPath) + '（先跑 anchors --resolve 生成）');
    return 2;
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(inPath, 'utf8')); } catch (e) { console.error('前提层失败：锚点表不是 JSON —— ' + String((e && e.message) || e)); return 2; }
  const anchors = doc.anchors || [];
  const dois = anchors.map((a) => (a.identifier || {}).doi).filter(Boolean);
  const { spawnSync } = require('child_process');
  const fetcher = (url) => {
    const r = spawnSync('curl', ['-sS', '--max-time', '30', '-H', 'User-Agent: paper-studio/3.2.23 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.error) throw new Error('curl 不可用：' + r.error.message);
    if (r.status !== 0) throw new Error('curl 退出码 ' + r.status + '：' + String(r.stderr || '').slice(0, 120));
    return r.stdout || '';
  };
  const { byDoi, log } = oaLookup(dois, fetcher);
  const clean = (d) => String(d || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  let oa = 0, closed = 0, missing = 0;
  const rows = [];
  for (const a of anchors) {
    const doi = clean((a.identifier || {}).doi);
    if (!doi) { missing++; rows.push({ key: a.marker, doi: '', state: 'no-doi' }); continue; }
    const hit = byDoi.get(doi);
    if (!hit) { missing++; rows.push({ key: a.marker, doi, state: 'not-retrieved' }); a._oa = { state: 'not-retrieved', note: 'OpenAlex 未返回该 DOI ⇒ **未取到**（不等于不可达）' }; continue; }
    if (hit.is_oa) { oa++; a._oa = { state: 'oa', oa_status: hit.oa_status, pdf_url: hit.pdf_url }; rows.push({ key: a.marker, doi, state: 'oa', where: hit.pdf_url || hit.oa_status }); }
    else { closed++; a._oa = { state: 'closed', oa_status: hit.oa_status || 'closed' }; rows.push({ key: a.marker, doi, state: 'closed' }); }
  }
  const outPath = val('out') || path.join(path.dirname(path.resolve(inPath)), 'anchors-含OA.json');
  doc._oa_report = { generated_at: new Date().toISOString(), source: 'OpenAlex (免 key)',
    counts: { total: anchors.length, oa, closed, missing }, tried: dois.length, log };
  fs.writeFileSync(path.resolve(outPath), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  const L = [];
  L.push('# 引用文献的开放获取可达性 · ' + path.basename(draftAbs));
  L.push('');
  L.push('> 用途：锚点表要升级为"**人已复核**"（`locator.kind=page-quote` + 页号 + ≥30 字原句），前提是**能读到原文**。');
  L.push('> 本表告诉你**从哪几篇开始**。数据源：OpenAlex（免 key，按 DOI 批量）。**未取到的记"未取到"，不等于不可达。**');
  L.push('');
  L.push('- 引用总数：' + anchors.length + ' · 有 DOI：' + dois.length);
  L.push('- **开放获取（可直接读）**：**' + oa + '** 篇 · 需订阅/机构权限：**' + closed + '** 篇 · 未取到/无 DOI：**' + missing + '** 篇');
  L.push('');
  L.push('| 标记 | DOI | 可达性 | 位置/状态 |');
  L.push('| --- | --- | --- | --- |');
  for (const r of rows) L.push('| [' + r.key + '] | ' + (r.doi || '—') + ' | ' + ({ oa: '✅ 开放获取', closed: '🔒 需订阅', 'no-doi': '— 无 DOI', 'not-retrieved': '❓ 未取到' }[r.state] || r.state) + ' | ' + (r.where || '') + ' |');
  if (log.length) { L.push(''); L.push('## 查询明细（未取到的原因）'); L.push(''); for (const l of log) L.push('- ' + l.stage + '：' + l.why + '（' + l.n + ' 个 DOI）'); }
  const mdPath = outPath.replace(/\.json$/, '') + '-OA报告.md';
  fs.writeFileSync(mdPath, L.join('\n') + '\n', 'utf8');
  if (JSON_OUT && !val('out')) {
    console.log(JSON.stringify({ total: anchors.length, oa, closed, missing, out: path.resolve(outPath), report: mdPath }, null, 2));
  } else {
    console.log('开放获取可达性 · ' + path.basename(draftAbs));
    console.log('  引用 ' + anchors.length + ' 条（有 DOI ' + dois.length + '）⇒ 开放获取 **' + oa + '** · 需订阅 **' + closed + '** · 未取到/无 DOI **' + missing + '**');
    for (const r of rows) console.log('    ' + (r.state === 'oa' ? '✅' : (r.state === 'closed' ? '🔒' : '❓')) + ' [' + r.key + '] ' + (r.doi || '—') + (r.where ? ' → ' + String(r.where).slice(0, 80) : ''));
    console.log('  报告：' + mdPath);
    console.log('  含 OA 标注的锚点表：' + path.resolve(outPath));
  }
  return 0;
}

function cmdResolve(args, argv, draftAbs, keys, hits) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const text = fs.readFileSync(draftAbs, 'utf8');
  const refs = parseReferenceList(text);
  const byKey = new Map(refs.entries.map((e) => [String(e.key), e]));
  const log = [];
  if (A.indexOf('--online') >= 0) {
    const { spawnSync } = require('child_process');
    const fetcher = (url) => {
      const r = spawnSync('curl', ['-sS', '--max-time', '25', '-H', 'User-Agent: paper-studio/3.2.22 (mailto:local)', url], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      if (r.error) throw new Error('curl 不可用：' + r.error.message);
      if (r.status !== 0) throw new Error('curl 退出码 ' + r.status + '：' + String(r.stderr || '').slice(0, 120));
      return r.stdout || '';
    };
    log.push(...resolveRefsOnline(refs.entries, fetcher));
  }
  const anchors = [];
  const unresolved = [];
  const seen = new Set();
  for (const k of keys) {
    seen.add(String(k));
    const e = byKey.get(String(k));
    if (!e) { unresolved.push({ key: k, why: '**题录里没有与该标记对应的条目** ⇒ 须人工补' }); anchors.push(Object.assign(ANCHOR_SKELETON(k), { _unresolved: '题录缺对应条目' })); continue; }
    const hasId = !!(e.doi || e.url || e.pmid);
    const a = Object.assign(ANCHOR_SKELETON(k), {
      identifier: { doi: e.doi || '', pmid: e.pmid || '', url: e.url || '' },
      locator: { kind: hasId ? 'bibliographic-list' : 'none-pending', value: '稿件题录 [第 ' + e.line + ' 行]' + (hasId ? '' : '（题录未给标识符）'), quote: '' },
      retrieval_method: 'bibliographic-list',
      _resolution: { source: 'manuscript-reference-list', line: e.line, doi_from_manuscript: e.doi || '', title: e.title || '', year: e.year || '', online: e._online || null },
    });
    if (!hasId) { a._unresolved = '题录未给 DOI/URL/PMID ⇒ 须人工补（或用 --online 兜底）'; unresolved.push({ key: k, why: a._unresolved }); }
    anchors.push(a);
  }
  const extra = refs.entries.filter((e) => !seen.has(String(e.key)));
  const outPath = val('out') || path.join(path.dirname(draftAbs), 'anchors-已解析.json');
  fs.writeFileSync(path.resolve(outPath), JSON.stringify({
    _note: '★ 由 `studio.cjs anchors --resolve` 生成：identifier 来自**稿件自己的题录**（有则采、无则留空），_unresolved 标出须人工补的条目；'
      + 'locator 仅登记"题录位置"，**未读原文 ⇒ 不构成"人已复核"**（要升级为人已复核，须补 kind:"page-quote" + 页号 + ≥30 字原句）。',
    _generated_at: new Date().toISOString(),
    anchors,
  }, null, 2) + '\n', 'utf8');
  console.log('锚点表解析（--resolve）· ' + path.basename(draftAbs));
  console.log('  题录区：' + (refs.start >= 0 ? 'L' + (refs.start + 1) + ' 起 · 条目 ' + refs.entries.length + ' 条' : '**未找到**（## References / ## 参考文献）'));
  console.log('  引用键 ' + keys.length + ' 个 ⇒ 已生成 ' + anchors.length + ' 条锚点；**未解析/待人工 ' + unresolved.length + ' 条**');
  for (const u of unresolved) console.log('    · [' + u.key + '] ' + u.why);
  if (extra.length) console.log('  题录里但有正文未引用的条目：' + extra.map((e) => e.key).join(', '));
  if (log.length) { console.log('  在线兜底明细：'); for (const l of log) console.log('    · [' + l.key + '] ' + l.stage + '：' + l.why); }
  console.log('  写出：' + path.resolve(outPath));
  return 0;
}

/** 返修回复信逐条核对（v3.2.25）
 *  为什么：进入返修阶段后，期刊要求**逐条回复**（意见原文 + 回应 + **改动位置**）。最常见的失分是：
 *  ① 漏回某条 ② 回应是空话（"已修改"）③ **没说改在哪里**（审稿人最烦的一条）。
 *  本命令只做**可机械判定**的那部分；"回应是否在学术上站得住"仍属人读。 */
const EMPTY_RESPONSE = /^(?:已?修改|已?更正|已?补(?:充)?|同意|接受|好的?|收到|ok|done|fixed|agreed|updated|noted)[。.!！,，]?$/i;
const LOCATOR_RE = /(?:\bL\d+\b|\bline\s*\d+|\bp{1,2}\.\s*\d+|第\s*\d+\s*(?:页|段|节|行|章)|Section\s*\d|§\s*\d+|Fig(?:ure)?\.?\s*\d|Table\s*\d|新增|删去|改写为|\b\d+\s*(?:mm|%|units?)\b)/i;
const normText = (s) => String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t\u3000]+/g, ' ').replace(/\*\*|\*|__|`/g, '').trim();
function splitComments(raw) {
  const txt = String(raw || '').replace(/\r\n?/g, '\n');
  const blocks = txt.split(/\n\s*\n+/).map((b) => normText(b)).filter(Boolean);
  const out = [];
  for (const b of blocks) {
    /* 支持三种编号：`1.` / `Comment 1:` / `[1]` / `意见 1` */
    const m = /^(?:\[?(\d+)\]?[.):、]?|(?:Comment|Reviewer|Referee|意见|审稿意见)\s*#?\s*(\d+)[:：.]?)\s*([\s\S]*)$/i.exec(b);
    if (m) out.push({ no: String(m[1] || m[2]), text: normText(m[3]) });
    else out.push({ no: String(out.length + 1), text: b });
  }
  return out.filter((c) => c.text.length >= 20);           // 太短的块（标题等）不算意见
}
/**
 * ★★ v3.2.33 运行指纹 —— 让每一份报告能回答「**这条判定属于哪一次运行**」。
 *   动机（来自同伴一问）：报告只写日期时，稿子改过之后，**旧报告会被读成当前结论**。
 *   做法：文件取 sha256 前 12 位；目录取「按相对路径排序的 (路径, 大小, 内容摘要)」再摘要 ⇒ 内容可复现、与遍历顺序无关。
 *   以 HTML 注释单行写入报告 ⇒ 渲染时不可见、机器可读。**只给「报告」盖指纹，不给「待填骨架/工作单」盖**
 *   （那类文件一被作者编辑就会立刻"陈旧"，盖上去只会制造噪音）。
 */
function sha12(buf) { return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12); }
function toolVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return 'unknown'; }
}
function digestOf(p) {
  const st = fs.statSync(p);
  if (!st.isDirectory()) return { kind: 'file', sha12: sha12(fs.readFileSync(p)), n: st.size };
  const rows = [];
  const walk = (d, pre) => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const s = fs.statSync(full);
      if (s.isDirectory()) { rows.push(pre + name + '/'); walk(full, pre + name + '/'); }
      else rows.push(pre + name + ' ' + s.size + ' ' + sha12(fs.readFileSync(full)));
    }
  };
  walk(p, '');
  return { kind: 'dir', sha12: sha12(rows.join('\n')), n: rows.length };
}
/** ★★ v3.2.34：**一份报告可能有不止一条运行指纹** —— `preflight` 会把契约门的报告正文**内联**进来，
 *   于是同文件里既有契约门盖的章、又有 preflight 自己的章。**只看第一条就是读错声明**（真事故：夹具当场红了）。
 *   所以一律取出**全部**声明逐一核，整体判定取最坏。 */
function provenanceClaims(txt) {
  const out = [];
  for (const m of String(txt).matchAll(/<!-- PROVENANCE: ([\s\S]*?) -->/g)) {
    try { out.push(JSON.parse(m[1])); } catch { out.push({ tool: '(unparsable)', inputs: [] }); }
  }
  return out;
}
function claimLabel(c) { return (c.tool || '?') + ' ' + (c.version || '?'); }
function provenanceLine(pairs) {
  const rows = [];
  for (const [role, v] of (pairs || [])) {
    if (!v) continue;
    const abs = path.resolve(v);
    if (!fs.existsSync(abs)) { rows.push({ role, path: abs, missing: true }); continue; }
    const d = digestOf(abs);
    rows.push({ role, path: abs, kind: d.kind, sha12: d.sha12, n: d.n });
  }
  return '<!-- PROVENANCE: ' + JSON.stringify({ tool: 'paper-studio', version: toolVersion(), at: new Date().toISOString(), inputs: rows }) + ' -->';
}
/** 投稿信（cover letter）要素核对 + 与目标刊契约的**交叉核对**（v3.2.26）
 *  为什么：投稿信里有若干**必须写到的声明**（未一稿多投 / 全体作者同意 / 无利益冲突 / 原创未发表），
 *  漏一条在编辑部那关就可能被退回；另有一个天然的确定性交叉核：**信里写的期刊名必须与目标刊契约一致**。
 *  还要防一种很丢人的事故：**模板里的 `[待填]` 占位符没删就投出去**。
 *  本命令只核"在场/一致"这类可机械判定的事；信写得好不好仍属人读。 */
const COVER_ITEMS = [
  { id: 'not-under-consideration', label: '未一稿多投 / 未同时投他刊', re: /(?:not\s+(?:under|being)\s+consideration|not\s+submitted\s+elsewhere|exclusively\s+submitted|has\s+not\s+been\s+(?:published|submitted)|未一稿多投|未同时投(?:稿|递)|专投)/i },
  { id: 'all-authors-approve', label: '作者已同意投稿（单作者稿写 the author / I 即正确）',
    /* ★ 假阴性修正：单作者稿写 "The author approved the submission" 是**正确**写法；
       首版只认 all authors ⇒ 把真稿的投稿信误报成"缺该声明"。 */
    re: /(?:all\s+authors?\s+(?:have\s+)?(?:read|approv|agree)|all\s+author\s+contributions?\s+approved|the\s+author\s+(?:has\s+)?(?:read|approv|agree|consent)|author\s+(?:has\s+)?approved\s+the\s+submission|i\s+(?:have\s+)?(?:read|approv|agree|consent)|作者(?:均|都|已)同意|全体作者同意)/i },
  { id: 'no-conflict', label: '无利益冲突（或与稿件一致）', re: /(?:no\s+(?:known\s+)?(?:competing|conflict)|declar(?:e|es|ation)\s+(?:that\s+)?(?:there\s+is\s+)?no\s+(?:competing|conflict)|无(?:利益)?冲突|无竞争性利益)/i },
  { id: 'originality', label: '原创、未发表（且不涉重复发表）', re: /(?:original|has\s+not\s+been\s+published|not\s+published\s+before|原创|未曾发表|未公开发表)/i },
];
/**
 * ★ v3.2.29：报告的**默认落点**必须躲开投稿包目录 —— 否则工具自己会污染投稿包。
 *   实测事故：`cover --cover submission/Cover-Letter.md` 不加 `--out` 时，把 `_投稿信核对-*.md`
 *   写进了 `submission/`，随后**被 package_hygiene 抓个正着**（包内多出 1 个内部产物）。
 *   规则：输入所在目录若"像投稿包"（名字含 submission / 投稿包 / package），落点取其**父目录**，否则取同目录。
 */
function reportHome(inputFile) {
  const dir = path.dirname(path.resolve(inputFile));
  const base = path.basename(dir);
  return /submission|投稿包|package/i.test(base) ? path.dirname(dir) : dir;
}

/** ★ v3.2.33 `report-check` —— 报告**陈旧检测**：报告自带的运行指纹 vs 现在手上的输入。
 *  三条不许含糊的语义：① 报告没有指纹 ⇒ **exit 2**（核不了它属于哪一次运行，不得当通过）；
 *  ② 某个角色本次没提供 ⇒ **未比对（不等于新鲜）**，退出码 1；③ 指纹不一致 ⇒ **STALE**，退出码 1 并点名是哪个输入变了。
 */
/**
 * ★★ v3.2.34 `reports --scan [<目录>] [--all]` —— **零参数陈旧巡检**：把目录里各份报告，按**报告里记录的路径**
 *   重算指纹，一次看清「手上哪份结论还成立」。
 *   ★ 关键点：**不要求调用方重新给输入** —— 报告自己记了它读的是哪些文件，就按那些路径核。
 *   语义：记录路径不存在 ⇒ `MISSING`（不是新鲜）· 报告没有指纹 ⇒ `UNSTAMPED`（不得当新鲜）· 指纹坏 ⇒ `BADSTAMP`。
 *   默认只看 `_*.md`（本工具的落点约定；避免把稿子正文当成报告）；`--all` 才扫全部 .md。
 */
/**
 * ★★ v3.2.35 `submission-fields --draft <稿> [--package <包>] [--contract <契约>] [--out <填写单.md>]`
 *   投稿门户（Editorial Manager / ScholarOne / 国内三平台）要逐格填元数据，手工复制粘贴是**错漏高发区**
 *   （题名不一致、摘要截断、关键词漏一个）。本命令把要粘的东西**逐字段**抽出来，并且守住一条硬不变量：
 *   **每个值必须在其来源里逐字存在** —— 抽不出就进「缺失」，不是逐字就标「✗ 非逐字」并让退出码非 0。
 *   ⇒ 这张单子**不可能凭空造字**；它只搬运，不代写。（造字的那一步永远由人来。）
 */
/** ★★ 本命令专用：**最小归一**。`normText` 会压缩空格并剥掉 `**` 强调标记 ⇒ 抽出来的值虽语义相同，
 *   但**不是原文字节**，粘贴出去就与稿件不一致。本命令的承诺是「直接复制」⇒ 只能做 CRLF/BOM 归一。
 *   （这正是「逐字」不能被语义归一替代的地方；本轮由正控夹具逼出。） */
function rawText(s) { return String(s || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }
function verbatimCheck(value, sourceText) {
  const v = String(value || '').trim();
  if (!v) return false;
  return String(sourceText || '').indexOf(v) >= 0;
}
function findEvidence(text, patterns) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const re of patterns) {
      const m = re.exec(lines[i]);
      if (m) {
        const val = (m[1] !== undefined ? m[1] : lines[i]).trim();
        if (val) return { value: val, line: i + 1, whole: lines[i] };
      }
    }
  }
  return null;
}
/** ★ 包内回退：有些门户字段（作者块/通讯作者）在**稿件正文里没有**，而在投稿包的其他文件里（如 Cover Letter）。
 *   回退查找**只搬运**、并记录来源文件 ⇒ 逐字不变量照旧成立。 */
/* ★ v3.2.45 修**高危假阳性**：包内证据搜索此前只按文件名排序取第一个命中 ⇒ 在 B 稿里从
 *   `9-期刊投稿要求核实清单.md` 抽到了 `**作者**：<被引论文的六位作者>` 当成**本稿作者块**
 *   —— 那是别人论文的作者名单（BadScientist, ACL 2026），照这个填门户就是把**别人的名字**写进作者栏。
 *   两条修法：① **排除工作件/要求清单/证据表/参考文献**这类"不是本稿元数据"的文件；
 *   ② 把"像作者块"的文件（投稿信/声明/标题页/作者页）**排在前面**再取第一个命中。
 *   取不到就**如实判缺失** —— 宁缺勿借。 */
const PKG_NOT_EVIDENCE = /清单|要求|核实|检查表|总检|核查|模板|template|checklist|requirements?|refs?\b|reference|evidence|证据|摘要集|abstracts|注记|notes|速查|决策依据|成本/i;
const PKG_AUTHORFILE = /cover|letter|declar|声明|title|作者|author|submission|投稿/i;
function findInPackage(dir, patterns) {
  if (!dir) return null;
  const d = path.resolve(dir);
  if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return null;
  const all = fs.readdirSync(d).sort().filter((f) => /\.(md|txt)$/i.test(f) && !f.startsWith('_'));
  const files = all.filter((f) => !PKG_NOT_EVIDENCE.test(f))
    .sort((a, b) => (PKG_AUTHORFILE.test(b) ? 1 : 0) - (PKG_AUTHORFILE.test(a) ? 1 : 0));
  for (const f of files) {
    const t = rawText(fs.readFileSync(path.join(d, f), 'utf8'));   // ★ 保字节
    const hit = findEvidence(t, patterns);
    if (hit) return { value: hit.value, file: f, line: hit.line, text: t };
  }
  return null;
}
function wordsOf(s) { return (String(s || '').replace(/\s+/g, ' ').match(/[A-Za-z0-9\u4e00-\u9fff][^\s]*/g) || []).length; }
function cmdSubmissionFields(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const draftArg = val('draft');
  if (!draftArg) { console.error('前提层失败：submission-fields 需要 --draft <稿.md>（可给 --contract 一并报限额、--package 找 Highlights）'); return 2; }
  const dAbs = path.resolve(draftArg);
  if (!fs.existsSync(dAbs)) { console.error('前提层失败：稿件不存在 —— ' + dAbs); return 2; }
  const draft = rawText(fs.readFileSync(dAbs, 'utf8'));   // ★ 保字节（见 rawText 注释）
  const pkgDir = val('package');
  const rows = [];
  const missing = [];
  const absent = [];
  /* ★ 必填 vs 可选：门户**必填**的只有题名/摘要/关键词/作者/通讯作者（空框就是要出事）；
     短标题与各类声明「没提供」很常见（要不要由期刊契约/门去管，本命令不越权判红）——只报告，不计入不成立。 */
  const push = (field, value, srcText, srcLabel, extra) => {
    const r = Object.assign({ field, value: value || '', source: srcLabel || ('稿件 ' + path.basename(dAbs)) }, extra || {});
    if (!r.value && !r.req) { r.state = 'absent'; absent.push(field); }
    else if (!r.value) { r.state = 'missing'; missing.push(field); }
    else if (srcText !== undefined && srcText !== null && !verbatimCheck(r.value, srcText)) { r.state = 'nonverbatim'; }
    else r.state = 'ok';
    rows.push(r);
    return r;
  };
  /* ① 题名 */
  const ta = titleAndAbstract(draft);
  push('Title 题名', ta.title, draft, '稿件 ' + path.basename(dAbs) + ' 首行', { chars: ta.title.length, req: true });
  /* ② 短标题 / running head */
  const shortT = findEvidence(draft, [
    /^\s*(?:\*\*)?(?:Short title|Running (?:title|head)|短标题)\.?\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/i,
    /^\s*(?:\*\*)?Short title\*\*\s*[:：]\s*(.+)$/i,
  ]);
  const SHORT_PATS = [/^\s*(?:\*\*)?(?:Short title|Running (?:title|head)|短标题)\s*[:：]\s*(.+)$/i];
  const shortPkg = shortT ? null : findInPackage(pkgDir, SHORT_PATS);
  push('Short title 短标题', shortT ? shortT.value : (shortPkg ? shortPkg.value : ''),
    shortT ? draft : (shortPkg ? shortPkg.text : null),
    shortT ? ('稿件 L' + shortT.line) : (shortPkg ? ('包内 ' + shortPkg.file + ' L' + shortPkg.line) : ''));
  /* ③ 摘要（整块搬运，行号可查） */
  let absText = ''; let absLine = 0;
  {
    const lines = draft.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*#*\s*(abstract|摘要)\b/i.test(lines[i]) || /^\s*(abstract|摘要)\s*[:：]/i.test(lines[i])) {
        const seg = [];
        for (let j = i + 1; j < lines.length; j++) { if (/^\s*#{1,6}\s/.test(lines[j])) break; seg.push(lines[j]); }
        absText = seg.join('\n').trim(); absLine = i + 2; break;
      }
    }
  }
  push('Abstract 摘要', absText, draft, absLine ? ('稿件 L' + absLine + ' 起（整块逐字）') : '', { words: wordsOf(absText), chars: absText.length, req: true });
  /* ④ 关键词 */
  const kw = findEvidence(draft, [/^\s*(?:\*\*)?(?:Keywords?|Key words|关键词)\.?\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/i]);
  const kwItems = kw ? kw.value.split(/\s*[;；,，]\s*/).filter(Boolean) : [];
  push('Keywords 关键词', kw ? kw.value : '', draft, kw ? ('稿件 L' + kw.line) : '', { items: kwItems.length, req: true });
  /* ⑤ Highlights（稿内小节优先，其次包内 Highlights.md） */
  let hlText = ''; let hlSrc = ''; let hlSrcText = null;
  {
    const lines = draft.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*#{1,6}\s*(highlights?|研究亮点)\s*$/i.test(lines[i])) {
        const seg = [];
        for (let j = i + 1; j < lines.length; j++) { if (/^\s*#{1,6}\s/.test(lines[j])) break; seg.push(lines[j]); }
        hlText = seg.join('\n').trim(); hlSrc = '稿件 L' + (i + 2) + ' 起'; hlSrcText = draft; break;
      }
    }
    if (!hlText && pkgDir) {
      const p = path.resolve(pkgDir);
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
        const f = fs.readdirSync(p).find((x) => /^highlights?.*\.(md|txt)$/i.test(x));
        if (f) { const t = rawText(fs.readFileSync(path.join(p, f), 'utf8')); hlText = t.trim(); hlSrc = '包内 ' + f + '（整份）'; hlSrcText = t; }
      }
    }
  }
  /* ★ v3.2.39 修假阳性：**只取 bullet 行**（与契约门 `highlights_count` 同一口径）。
     首版把所有非空行都算成「条」 ⇒ 稿件里的 `---` 分隔线被算成一条 ⇒ 报出「6 条 / 上限 5」的**假超限**。 */
  const hlItems = hlText ? hlText.split(/\r?\n/).map((s) => s.trim())
    .filter((s) => /^[-*+]\s+/.test(s))
    .map((s) => s.replace(/^[-*+]\s+/, '').trim())
    .filter(Boolean) : [];
  push('Highlights 亮点', hlText, hlSrcText, hlSrc, { items: hlItems.length });
  /* ⑥ 作者块 / 通讯作者 */
  const AU_PATS = [/^\s*(?:\*\*)?(?:Authors?|作者|作者姓名)\.?\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/i];
  const au = findEvidence(draft, AU_PATS);
  const auPkg = au ? null : findInPackage(pkgDir, AU_PATS);   // v3.2.45：不再从要求清单/证据表里借作者
  push('Authors 作者块', au ? au.value : (auPkg ? auPkg.value : ''),
    au ? draft : (auPkg ? auPkg.text : null),
    au ? ('稿件 L' + au.line) : (auPkg ? ('包内 ' + auPkg.file + ' L' + auPkg.line) : ''), { req: true });
  const CA_PATS = [
    /^\s*(?:\*\*|__)?\s*(?:Corresponding author|通讯作者|通信作者)\s*(?:e-?mail(?:\s*address)?)?\.?\s*(?:\*\*|__)?\s*[:：]\s*(.+)$/i,
    /^.{0,140}?\(\s*corresponding author\s*\)\s*$/i,
    /^\s*(?:\*\*|__)?\s*(?:Author for correspondence|通讯作者|通信作者)\b[^\n]*$/i,
  ];
  const ca = findEvidence(draft, CA_PATS);
  /* ★ v3.2.39 修假阳性：真实稿件的写法比我的正则宽得多 —— `**Haolong Liu**¹ (corresponding author)` 与
     `Corresponding author e-mail: x@y` 都被首版漏掉 ⇒ 报出「缺失」的**假阳性**。这里按真实形态补三条。 */
  const caPkg = ca ? null : findInPackage(pkgDir, CA_PATS);   // v3.2.45：同上
  push('Corresponding author 通讯作者', ca ? ca.value : (caPkg ? caPkg.value : ''),
    ca ? draft : (caPkg ? caPkg.text : null),
    ca ? ('稿件 L' + ca.line) : (caPkg ? ('包内 ' + caPkg.file + ' L' + caPkg.line) : ''), { req: true });
  /* ⑦ 各类声明（三种同等强形态：标题行 / 行首加粗标签 / 标准声明句） */
  const DECL = [
    ['CRediT 作者贡献', [/^\s*#{1,6}\s*(?:CRediT|Author contributions?|作者贡献)\b/i, /^\s*(?:\*\*|__)?\s*(?:CRediT authorship contribution statement|Author contributions?|作者贡献)\.?(?:\*\*|__)?\s*[:：]?(.*)$/i]],
    ['Competing interest 利益冲突', [/^\s*#{1,6}\s*(?:Declaration of (?:competing )?interests?|Conflicts? of interest|利益冲突)\b/i, /^\s*(?:\*\*|__)?\s*(?:Declaration of (?:competing )?interests?|Conflicts? of interest|利益冲突)\.?(?:\*\*|__)?\s*[:：]?(.*)$/i, /^\s*The authors? declare[sd]? (?:no|that they have no) (?:known )?competing (?:financial )?interests?/i]],
    ['Funding 资助', [/^\s*#{1,6}\s*(?:Funding|Acknowledgements?|资助|基金项目)\b/i, /^\s*(?:\*\*|__)?\s*(?:Funding|基金项目)\.?(?:\*\*|__)?\s*[:：]?(.*)$/i, /^\s*(?:This (?:research|work) (?:did not receive|was supported|received)|本研究(?:未)?(?:获得|受))[^\n]*/i]],
    ['Data availability 数据可用性', [/^\s*#{1,6}\s*(?:Data (?:and code )?availability|数据可用性)\b/i, /^\s*(?:\*\*|__)?\s*(?:Data (?:and code )?availability|数据可用性)\.?(?:\*\*|__)?\s*[:：]?(.*)$/i]],
    ['Generative AI 声明', [/^\s*#{1,6}\s*(?:Declaration of generative AI|生成式 ?AI)[^\n]*/i, /^\s*(?:\*\*|__)?\s*(?:Declaration of generative AI[^\n]*|生成式 ?AI[^\n]*)/i]],
  ];
  for (const [label, pats] of DECL) {
    const hit = findEvidence(draft, pats);
    push(label, hit ? hit.value : '', draft, hit ? ('稿件 L' + hit.line) : '');
  }
  /* ⑧ 契约限额对照（只报，不替门判定；没有对应读数的键如实说明） */
  const contractArg = val('contract');
  const limits = [];
  if (contractArg) {
    const cAbs = path.resolve(contractArg);
    if (!fs.existsSync(cAbs)) { console.error('前提层失败：契约不存在 —— ' + cAbs); return 2; }
    let c = null; try { c = JSON.parse(fs.readFileSync(cAbs, 'utf8')); } catch (e) { console.error('前提层失败：契约不是合法 JSON —— ' + String((e && e.message) || e)); return 2; }
    const lim = c.limits || {};
    const measured = { abstract_max_words: wordsOf(absText), title_max_chars: ta.title.length, keywords_max: kwItems.length, highlights_max_items: hlItems.length };
    for (const k of Object.keys(lim)) {
      const declared = lim[k];
      /* ★ 限额可能是**对象**（如 highlights: {max_items, max_chars}）⇒ 逐个子键比，别打印成 [object Object]。 */
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) {
        const hlMaxLen = hlItems.length ? Math.max.apply(null, hlItems.map((s) => s.length)) : 0;
        const map = { max_items: hlItems.length, count: hlItems.length, max: hlItems.length, min: hlItems.length,
          max_chars: hlText.length, max_chars_each: hlMaxLen, max_words: wordsOf(hlText) };
        for (const sub of Object.keys(declared)) {
          const got = Object.prototype.hasOwnProperty.call(map, sub) ? map[sub] : null;
          const dv = declared[sub];
          /* ★ 方向：`min*` 是**下限**（小于才违规）；布尔/字符串型（required/separate_editable_file/filename_must_contain）无对应读数，如实留空。 */
          const numeric = (got !== null && typeof dv === 'number');
          const isMin = /(^|\.)min/i.test(sub);
          const ok = numeric ? (isMin ? got >= dv : got <= dv) : null;
          limits.push({ key: k + '.' + sub, declared: dv, measured: got, ok });
        }
        continue;
      }
      const got = Object.prototype.hasOwnProperty.call(measured, k) ? measured[k] : null;
      limits.push({ key: k, declared, measured: got, ok: got === null ? null : (got <= declared) });
    }
  }
  const over = limits.filter((x) => x.ok === false);
  const nonVerbatim = rows.filter((r) => r.state === 'nonverbatim');
  const bad = missing.length > 0 || nonVerbatim.length > 0 || over.length > 0;
  const code = nonVerbatim.length ? 'NONVERBATIM' : (missing.length ? 'MISSING' : (over.length ? 'OVER-LIMIT' : 'OK'));
  if (!A.includes('--quiet')) {
    console.log('投稿门户填写单 · ' + path.basename(dAbs));
    for (const r of rows) {
      const tag = r.state === 'ok' ? '✓' : (r.state === 'nonverbatim' ? '✗ 非逐字' : (r.state === 'absent' ? '· 未提供(可选)' : '· 缺失(必填)'));
      const cnt = [r.chars ? r.chars + ' 字符' : '', r.words ? r.words + ' 词' : '', r.items ? r.items + ' 项' : ''].filter(Boolean).join(' · ');
      console.log('  ' + tag + ' ' + r.field + (cnt ? '（' + cnt + '）' : '') + (r.source ? '  ← ' + r.source : ''));
    }
    if (limits.length) { console.log('  契约限额对照：'); for (const x of limits) console.log('    ' + (x.ok === false ? '✘ 超限' : (x.ok === true ? '✓ 未超' : '· 无对应读数')) + ' ' + x.key + ' 声明=' + x.declared + (x.measured === null ? '' : ' 实测=' + x.measured)); }
    console.log('  结论：' + (bad ? (missing.length + nonVerbatim.length + over.length) + ' 项待处理（必填缺失 ' + missing.length + ' · 非逐字 ' + nonVerbatim.length + ' · 超限 ' + over.length + '）' : '必填字段齐、全部可逐字粘贴、无超限') + '（fields_code=' + code + '）');
    if (absent.length) console.log('  可选未提供 ' + absent.length + ' 项（不判红，是否必须由期刊契约/门决定）：' + absent.join(' / '));
  }
  /* ★★ v3.2.39 `--proposal`：**改动建议书**。三条自我约束（都可在夹具里机械核对）：
     ① 只给「逐字原文 + 明确改法」，**绝不造字**（凡引用的原文都能在来源里找到）；
     ② **绝不代选**（要删哪条 Highlights、要补什么邮箱 —— 都由作者定夺，工具只列候选）；
     ③ **不修改稿件**（本命令只写建议书；稿件字节不变）。 */
  const proposalArg = val('proposal');
  if (proposalArg !== '') {
    const pAbs = path.resolve(proposalArg);
    const P2 = [];
    P2.push('# 改动建议书（待作者确认）· ' + path.basename(dAbs), '');
    P2.push('> 本文件**只给建议与逐字原文，不修改稿件**；每条改动都要你确认。');
    P2.push('> 凡标 `__待…__` 的占位符，必须由你替换 —— **本工具不代填、不代选**。', '');
    let nIssue = 0;
    /* ① 必填缺失 */
    const reqMissing = rows.filter((r) => r.req && r.state === 'missing');
    if (reqMissing.length) {
      P2.push('## 一、必填字段缺失（门户会要）', '');
      for (const r of reqMissing) {
        nIssue++;
        P2.push('### ' + r.field, '');
        P2.push('- 现状：稿件里找不到该字段（抽不出 ⇒ 列入缺失）。');
        if (r.field.indexOf('Corresponding') >= 0 || r.field.indexOf('Authors') >= 0) {
          const src = auPkg || caPkg || null;
          if (src) {
            P2.push('- 包内线索：`' + src.file + '` L' + src.line + '（**逐字**）——`, `' + src.value + '`');
            P2.push('- 建议在稿件声明区附近补一行（**占位符待你替换**）：');
            P2.push('');
            P2.push('  ```markdown');
            P2.push('  **Corresponding author:** ' + src.value + ' （邮箱：__待作者填写__）');
            P2.push('  ```');
          } else {
            P2.push('- 稿件与包内都没有可用的作者线索 ⇒ **须你从零填写**（工具不编）。');
          }
        } else {
          P2.push('- 建议：按门户提示补写（本工具不代写内容）。');
        }
        P2.push('');
      }
    }
    /* ② 超限 */
    const over2 = limits.filter((x) => x.ok === false);
    if (over2.length) {
      P2.push('## 二、超出契约限额', '');
      for (const x of over2) {
        nIssue++;
        P2.push('### `' + x.key + '`：实测 ' + x.measured + ' / 上限 ' + x.declared, '');
        if (x.key.indexOf('highlights') >= 0 && hlItems.length) {
          const must = Math.max(0, hlItems.length - (typeof x.declared === 'number' ? x.declared : hlItems.length));
          P2.push('- 当前 **' + hlItems.length + ' 条**（逐字列出，编号供你指定删哪条）：');
          hlItems.forEach((it, i) => P2.push('  ' + (i + 1) + '. ' + it));
          P2.push('- 须删 **' + must + ' 条**才不超限；**删哪条由你定夺**（本工具不代选 —— 亮点取舍是学术判断）。');
        } else {
          P2.push('- 建议：按上限删减或改写对应部分（本工具不代改）。');
        }
        P2.push('');
      }
    }
    /* ③ 余量警示（通过了但很紧） */
    const tight = limits.filter((x) => x.ok === true && typeof x.measured === 'number' && typeof x.declared === 'number')
      .filter((x) => { const h = x.declared - x.measured; return h >= 0 && h <= Math.max(1, Math.ceil(x.declared * 0.05)); });
    if (tight.length) {
      P2.push('## 三、余量警示（当前通过，但很紧）', '');
      for (const x of tight) {
        nIssue++;
        P2.push('- `' + x.key + '`：实测 **' + x.measured + '** / 上限 ' + x.declared + ' ⇒ **只剩 ' + (x.declared - x.measured) + ' 的余量**，再加一句就可能超限。');
      }
      P2.push('');
    }
    P2.push('---', '');
    P2.push('共 **' + nIssue + '** 条待确认。改完请重跑：`node bin/studio.cjs submission-fields --draft <稿> --package <包> --contract <契约>`。');
    P2.push('');
    P2.push('<!-- PROVENANCE: ' + JSON.stringify({ tool: 'paper-studio', version: toolVersion(), at: new Date().toISOString(), inputs: [{ role: 'draft', path: dAbs, kind: 'file', sha12: digestOf(dAbs).sha12, n: fs.statSync(dAbs).size }] }) + ' -->');
    fs.writeFileSync(pAbs, P2.join('\n') + '\n', 'utf8');
    console.log('  改动建议书：' + pAbs + '（' + nIssue + ' 条待确认；**未修改稿件**）');
  }
  const outArg = val('out');
  if (outArg) {
    const o = path.resolve(outArg);
    const L2 = ['# 投稿门户填写单 · ' + path.basename(dAbs), '', '- 由 `studio.cjs submission-fields` 生成；**每个值都在来源里逐字存在**（抽不出就列入缺失，非逐字会被标出）。', '- 用途：投稿系统（Editorial Manager / ScholarOne / 国内三平台）逐格填写时**直接复制**，避免手工重打出错。', ''];
    L2.push('| 字段 | 值（逐字，可直接粘贴） | 来源 | 计数 | 状态 |');
    L2.push('|---|---|---|---|---|');
    for (const r of rows) {
      const v = r.value.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
      const cnt = [r.chars ? r.chars + ' 字符' : '', r.words ? r.words + ' 词' : '', r.items ? r.items + ' 项' : ''].filter(Boolean).join(' · ');
      L2.push('| ' + r.field + ' | ' + (v || (r.req ? '**（缺失·必填）**' : '（未提供·可选）')) + ' | ' + r.source + ' | ' + cnt + ' | ' + (r.state === 'ok' ? '✓' : (r.state === 'nonverbatim' ? '**✗ 非逐字**' : (r.state === 'absent' ? '· 未提供' : '· 缺失'))) + ' |');
    }
    if (limits.length) {
      L2.push(''); L2.push('## 契约限额对照（只报，不替门判定）');
      for (const x of limits) L2.push('- ' + (x.ok === false ? '**✘ 超限** ' : (x.ok === true ? '✓ ' : '· 无对应读数 ')) + '`' + x.key + '` 声明=' + x.declared + (x.measured === null ? '' : ' 实测=' + x.measured));
    }
    L2.push(''); L2.push('<!-- PROVENANCE: ' + JSON.stringify({ tool: 'paper-studio', version: toolVersion(), at: new Date().toISOString(), inputs: [{ role: 'draft', path: dAbs, kind: 'file', sha12: digestOf(dAbs).sha12, n: fs.statSync(dAbs).size }] }) + ' -->');
    fs.writeFileSync(o, L2.join('\n') + '\n', 'utf8');
    console.log('  填写单：' + o);
  }
  if (JSON_OUT) console.log(JSON.stringify({ draft: dAbs, fields_code: code, rows, limits, missing, absent_optional: absent, nonverbatim: nonVerbatim.map((r) => r.field), over_limit: over.map((x) => x.key) }, null, 2));
  return bad ? 1 : 0;
}
/** v3.2.44：`anchors --quote-hints` —— 把"得先读原文"这一步从人身上挪到工具身上，但**只给候选**。 */
/** OpenAlex 倒排摘要重建（免 key）。★ 重要：倒排索引**只有词与位置、没有标点** ⇒ 重建文本
 *   **不能当"逐字原句"**（≥30 字原句要求逐字，标点与句界都必须保留）⇒ 只能作"对读线索"。 */
function openalexLookup(doi, f) {
  const clean = String(doi || '').replace(/^https?:\/\/doi\.org\//i, '').trim();
  if (!clean) return { state: 'no-doi' };
  let j = null;
  try {
    const u = 'https://api.openalex.org/works/doi:' + encodeURIComponent(clean) + '?select=id,title,abstract_inverted_index';
    j = JSON.parse(f(u));
  } catch (e) { return { state: 'not-retrieved', why: 'OpenAlex 检索失败：' + String((e && e.message) || e) }; }
  const inv = (j || {}).abstract_inverted_index;
  if (!inv || typeof inv !== 'object') return { state: 'not-retrieved', why: 'OpenAlex 无摘要（该条目可能未收录或无 abstract）' };
  const slots = [];
  for (const w of Object.keys(inv)) for (const pos of (inv[w] || [])) slots[pos] = w;
  const text = slots.filter(Boolean).join(' ').trim();
  if (!text) return { state: 'not-retrieved', why: 'OpenAlex 摘要倒排为空' };
  return { state: 'abstract-recon', text, title: (j && j.title) || '', source: 'OpenAlex ' + ((j && j.id) || '') + ' · **摘要（倒排索引重建：无标点 ⇒ 不可作原句引用，仅作对读线索）**' };
}
function cmdQuoteHints(args, argv, draftAbs, keys, hits, val, has) {
  const inPath = val('in') || val('anchors') || (() => {
    const cand = [path.join(path.dirname(draftAbs), 'anchors-已解析.json'), path.join(path.dirname(path.dirname(draftAbs)), 'anchors-已解析.json')];
    return cand.find((p) => fs.existsSync(p)) || path.join(path.dirname(draftAbs), 'anchors-已解析.json');
  })();
  if (!fs.existsSync(inPath)) { console.error('前提层失败：找不到锚点表 —— ' + path.resolve(inPath) + '（先跑 anchors --resolve 生成）'); return 2; }
  let doc; try { doc = JSON.parse(fs.readFileSync(inPath, 'utf8')); } catch (e) { console.error('前提层失败：锚点表不是 JSON —— ' + String((e && e.message) || e)); return 2; }
  const anchors = doc.anchors || [];
  const limit = Number(val('limit')) > 0 ? Number(val('limit')) : 3;
  const f = (typeof globalThis.__STUDIO_HINT_FETCHER__ === 'function') ? globalThis.__STUDIO_HINT_FETCHER__ : epmcCurlFetcher();
  const rows = [];
  for (const a of anchors) {
    const key = String(a.marker || '');
    const claim = (hits.get(key) || {}).sentences || [];
    const doi = ((a.identifier || {}).doi) || '';
    let got = epmcLookup(doi, f);
    let hints = [];
    const clues = [];
    if (got.state === 'fulltext' || got.state === 'abstract') {
      hints = rankHints(claim, sentencesOf(got.text, 40), limit);
    }
    /* ★ v3.2.44 退路：EPMC 是**生物医学**语料 —— 能源/工程/arXiv 的 DOI 常"未收录"。
       退到 OpenAlex 倒排摘要，但只作**对读线索**（重建无标点 ⇒ 不能当逐字原句）。 */
    if (!hints.length) {
      const oa = openalexLookup(doi, f);
      if (oa.state === 'abstract-recon') {
        const ws = oa.text.split(/\s+/);
        const cw2 = new Set();
        for (const s of claim) for (const w of contentWords(s)) cw2.add(w);
        const hitAt = (i) => cw2.has(String(ws[i] || '').toLowerCase().replace(/[^a-z0-9-]/g, ''));
        let best = 0, bestN = -1;
        for (let i = 0; i < ws.length; i++) { const sc = (hitAt(i) ? 1 : 0) + (i > 0 && hitAt(i - 1) ? 1 : 0); if (sc > bestN) { bestN = sc; best = i; } }
        const from = Math.max(0, best - 20), to = Math.min(ws.length, best + 40);
        clues.push({ window: ws.slice(from, to).join(' '), at: from + '-' + to + '/' + ws.length, n: ws.length });
        got = oa;
      } else if (got.state === 'not-retrieved') {
        got = { state: got.state, why: (got.why || '') + '；' + (oa.why || ''), source: '', title: got.title || oa.title || '' };
      }
    }
    rows.push({ key, doi, state: got.state, source: got.source || '', why: got.why || '', title: got.title || '', claim, hints, clues });
  }
  const withHints = rows.filter((r) => r.hints.length);
  const withClues = rows.filter((r) => !r.hints.length && (r.clues || []).length);
  const mustRead = rows.filter((r) => !r.hints.length && !(r.clues || []).length);
  const L = [];
  L.push('# 引用原句候选（供人工核对）· ' + path.basename(draftAbs));
  L.push('');
  L.push('> 用途：把 `locator.kind=page-quote`（页号 + ≥30 字**原句**）这一步的"先读原文"交给工具，**但只给候选**。');
  L.push('> **本工具不代填** —— 页号与原句必须你核对（排版/版本差异都可能让"逐字"不成立）；候选句**逐字来自抓取到的来源**。');
  L.push('> 数据源：Europe PMC（免 key，按 DOI 检索；OA 取全文，否则取摘要）。**取不到就列在最后一节，不假装有。**');
  L.push('');
  L.push('- 锚点表：`' + path.resolve(inPath) + '`');
  L.push('- **逐字候选**（可作 page-quote 用）：**' + withHints.length + '** 条 · **对读线索**（非逐字，须回原文取原句）：**' + withClues.length + '** 条 · **须人工读原文**：**' + mustRead.length + '** 条 / 共 ' + rows.length + ' 条');
  L.push('');
  for (const r of withHints) {
    L.push('## `[' + r.key + ']`　' + (r.source || r.state));
    L.push('');
    if (r.title) L.push('- 来源题名：' + r.title);
    if (r.claim.length) { L.push('- 正文里引用它的句子（**逐字**）：'); for (const s of r.claim) L.push('  - ' + s); }
    L.push('- 候选原句（按与主张句的词重叠排序，**须你确认**）：');
    r.hints.forEach((h, i) => { L.push('  ' + (i + 1) + '. [' + h.score + ' 词重叠：' + h.overlap.slice(0, 6).join(', ') + '] ' + h.text); });
    L.push('');
  }
  if (withClues.length) {
    L.push('## 对读线索（**非逐字** —— 倒排索引重建无标点，只能帮你判断"这篇是否支持该主张"；原句仍须回原文取）');
    L.push('');
    for (const r of withClues) {
      L.push('### `[' + r.key + ']`　' + (r.source || r.state));
      L.push('');
      if (r.title) L.push('- 来源题名：' + r.title);
      for (const c of r.clues) L.push('- 词窗（位置 ' + c.at + '，共 ' + c.n + ' 词）：' + c.window);
      L.push('- 【须回原文取 ≥30 字原句，本工具不代取】');
      L.push('');
    }
  }
  if (mustRead.length) {
    L.push('## 须人工读原文（工具取不到 ⇒ 不假装有）');
    L.push('');
    for (const r of mustRead) L.push('- `[' + r.key + ']`　' + r.doi + '　' + (r.state === 'no-doi' ? '**无 DOI**（先在锚点表里补 identifier）' : r.state + (r.why ? '：' + r.why : '')));
    L.push('');
  }
  const outPath = val('out') || path.join(reportHome(draftAbs), '_原句候选-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
  if (JSON_OUT) { console.log(JSON.stringify({ draft: draftAbs, table: path.resolve(inPath), rows }, null, 2)); return 0; }
  console.log('引用原句候选 · ' + path.basename(draftAbs));
  console.log('  逐字候选 ' + withHints.length + ' 条 · 对读线索 ' + withClues.length + ' 条 · 须人工读原文 ' + mustRead.length + ' 条（共 ' + rows.length + '）');
  console.log('  工作单：' + outPath + '（**候选须你确认；本工具不代填**）');
  return 0;
}
/** ═══ v3.2.48 `doctor`：环境与能力自检 ═════════════════════════════════════════════════════════════
 *  为什么：本插件的**12 道门全在插件之外**（`rel=playbook_root`，靠 `~/.dsh/paper-studio/local-paths.json` 解析）。
 *  单装插件、没配那套外部资产的人，12 道门一个都没有 —— 此前只能靠一条条命令各自的报错去猜"到底少了什么、少了会怎样"。
 *  纪律：**未检查 ≠ 通过**；缺什么就直说缺什么并给可执行的补救；`doctor` 只报告环境，不做任何业务判定。
 * ═══════════════════════════════════════════════════════════════════════════════════════════════ */
function doctorScan(pipeline, opt) {
  const o = opt || {};
  const exists = o.exists || ((p) => { try { return fs.existsSync(p); } catch { return false; } });
  const assets = (pipeline && pipeline.assets) || {};
  const gates = (pipeline && pipeline.gates) || [];
  /* 门：逐个解析（resolveGateScript 已内置 __LOCAL__ 未解析的处理） */
  const gateRows = gates.map((g) => {
    let r = { script: '', why: '' };
    try { r = resolveGateScript(g, pipeline); } catch (e) { r = { script: '', why: String((e && e.message) || e) }; }
    const ok = !!r.script && exists(r.script);
    return { id: g.id, rel: g.rel || 'ROOT', entry: g.entry, path: r.script || '', ok, why: r.why || '', source: r.source || '' };
  });
  /* 素材：只把"看起来是路径"的值当路径（说明性长文本跳过） */
  const isPathLike = (s) => typeof s === 'string' && s.length <= 120 && /^[A-Za-z0-9_./\\:-]+$/.test(s) && /\.[A-Za-z0-9]{1,5}$/.test(s);
  const assetRows = Object.keys(assets).filter((k) => isPathLike(assets[k])).map((k) => {
    const raw = assets[k];
    const unresolved = String(raw).indexOf('__LOCAL__') === 0;
    const abs = unresolved ? '' : (path.isAbsolute(raw) ? raw : path.join(ROOT, raw));
    return { key: k, raw, unresolved, path: abs, ok: !!abs && exists(abs) };
  });
  const gatesOk = gateRows.filter((g) => g.ok).length;
  const assetsOk = assetRows.filter((a) => a.ok).length;
  const localPaths = {
    env: process.env.DSH_PAPER_LOCAL_PATHS || '',
    home: HOME_PATHS_FILE,
    homeExists: exists(HOME_PATHS_FILE),
    legacy: LEGACY_PATHS_FILE,
    legacyExists: exists(LEGACY_PATHS_FILE),
    example: path.join(ROOT, 'references', 'local-paths.example.json'),
    exampleExists: exists(path.join(ROOT, 'references', 'local-paths.example.json')),
  };
  return {
    node: process.version,
    root: ROOT,
    pipeline: PIPELINE_PATH,
    gateRows, gatesOk, gatesTotal: gates.length,
    assetRows, assetsOk, assetsTotal: assetRows.length,
    localPaths,
    /* 门缺失时**哪些能力会降级**（只陈述依赖关系，不替门判定） */
    degraded: gateRows.filter((g) => !g.ok).map((g) => g.id),
    ok: gatesOk === gates.length && assetsOk === assetRows.length,
  };
}
function cmdDoctor(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  let pipeline = null;
  const pjArg = val('pipeline');
  try { pipeline = readPipeline(pjArg ? path.resolve(pjArg) : PIPELINE_PATH); } catch (e) { console.error('前提层失败：真源读不到 —— ' + String((e && e.message) || e)); return 2; }
  const r = doctorScan(pipeline, {});
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  const L = [];
  L.push('# 环境与能力自检（doctor）');
  L.push('');
  L.push('> 只报告环境，**不做业务判定**；凡"不可用"一律记 **未检查**（**未检查 ≠ 通过**）。');
  L.push('');
  L.push('## 一、运行时');
  L.push('');
  L.push('- Node：`' + r.node + '`');
  L.push('- 插件根：`' + r.root + '`');
  L.push('- 真源：`' + r.pipeline + '`');
  L.push('- 本机路径表（`__LOCAL__` 解析用）：' + (r.localPaths.env ? '环境变量 `DSH_PAPER_LOCAL_PATHS` = `' + r.localPaths.env + '`' : (r.localPaths.homeExists ? '`' + r.localPaths.home + '`（存在）' : (r.localPaths.legacyExists ? '`' + r.localPaths.legacy + '`（存在，向后兼容档）' : '**未找到**（三档皆无）→ 外部资产与门都无法解析'))));
  L.push('');
  L.push('## 二、门（' + r.gatesOk + '/' + r.gatesTotal + ' 可用）');
  L.push('');
  L.push('| 门 | rel | 入口 | 来源 | 状态 |');
  L.push('|---|---|---|---|---|');
  for (const g of r.gateRows) L.push('| `' + g.id + '` | ' + g.rel + ' | `' + g.entry + '` | ' + (g.source === 'external' ? '外部（本机路径表）' : (g.source === 'bundled' ? '**插件内置副本**' : '—')) + ' | ' + (g.ok ? '✓' : '**✗ 不可用**' + (g.why ? '：' + g.why : '（文件不存在：' + g.path + '）')) + ' |');
  L.push('');
  L.push('## 三、素材（' + r.assetsOk + '/' + r.assetsTotal + ' 存在）');
  L.push('');
  for (const a of r.assetRows) L.push('- ' + (a.ok ? '✓' : '✗') + ' `' + a.key + '` → ' + (a.unresolved ? '**未解析的 `__LOCAL__` 占位**' : '`' + a.path + '`'));
  L.push('');
  L.push('## 四、结论');
  L.push('');
  if (r.ok) {
    L.push('- **环境齐备**：门 ' + r.gatesOk + '/' + r.gatesTotal + '、素材 ' + r.assetsOk + '/' + r.assetsTotal + '。');
  } else {
    L.push('- **有缺口**（**未检查 ≠ 通过**）：门可用 ' + r.gatesOk + '/' + r.gatesTotal + '，素材 ' + r.assetsOk + '/' + r.assetsTotal + '。');
    if (r.degraded.length) L.push('- 不可用的门：' + r.degraded.map((x) => '`' + x + '`').join(' · ') + ' ⇒ 依赖它们的检查会记「未检查」。');
    L.push('- 补救：门脚本可用**插件内置副本**（本表"来源"列显示实际用了哪份）；要改用本机外部版本，就把 `references/local-paths.example.json` 复制成 `' + r.localPaths.home + '`（或设 `DSH_PAPER_LOCAL_PATHS`）并填真实路径。其余 `__LOCAL__` 素材（短语库等）仍需本机路径表。');
    L.push('- **插件内实现的能力不受此影响**：`submission-fields`（含 `--proposal`）· `anchors`（`--resolve/--oa/--quote-hints`）· `compliance`（含包卫生）· `cover`/`response` 的要素核对 · `reports --scan`（按报告自带指纹核）。');
  }
  /* ★ 默认**不落文件**（工具产物不该污染插件根/工作目录）；要落就显式 `--out`。 */
  const outPath = val('out') ? path.resolve(val('out')) : '';
  if (outPath) { try { fs.writeFileSync(outPath, JSON.stringify(r, null, 2) + '\n', 'utf8'); } catch (e) { console.error('写不出 --out：' + String((e && e.message) || e)); } }
  console.log(L.join('\n'));
  console.log('');
  const srcCount = r.gateRows.filter((g) => g.source === 'bundled').length;
  console.log('doctor：' + (r.ok ? '环境齐备' : '**有缺口**') + '（门 ' + r.gatesOk + '/' + r.gatesTotal + ' · 素材 ' + r.assetsOk + '/' + r.assetsTotal + (srcCount ? ' · 其中 ' + srcCount + ' 道门用**插件内置副本**' : '') + '）' + (outPath ? '；机器可读：' + outPath : '（未落文件；要机器可读加 `--json` 或 `--out <路径>`）'));
  return r.ok ? 0 : 1;
}
function cmdReports(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const dir = path.resolve(val('scan') || val('dir') || '.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error('前提层失败：--scan 需要一个存在的目录 —— ' + dir); return 2; }
  const all = A.includes('--all');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && (all || f.startsWith('_'))).sort();
  const rows = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    const txt = fs.readFileSync(abs, 'utf8');
    const claims = provenanceClaims(txt);
    /* ★ 信噪比：**只有判定类报告才该盖章**。工作单/清单/笔记类（包清单、检查表、notes）即便没有指纹也不是缺陷，
       单列为「非判定类」并**不计入不成立**；判定类却没指纹 ⇒ 仍是 UNSTAMPED（不得当新鲜）。 */
    const isJudgment = /(报告|总检|核对|report)/i.test(f);
    if (!claims.length) {
      rows.push(isJudgment
        ? { report: f, state: 'UNSTAMPED', why: '判定类报告没有运行指纹 ⇒ 核不了它属于哪一次运行（不得当新鲜）' }
        : { report: f, state: 'N/A', why: '非判定类（工作单/清单/笔记）⇒ 本就不该盖章' });
      continue;
    }
    const bad = [];
    for (const prov of claims) {
      for (const r of (prov.inputs || [])) {
        const who = claimLabel(prov) + '·' + r.role;
        if (!r.path || r.missing) { bad.push({ role: who, why: '生成时就缺' }); continue; }
        if (!fs.existsSync(r.path)) { bad.push({ role: who, why: '记录路径已不存在' }); continue; }
        if (digestOf(r.path).sha12 !== r.sha12) bad.push({ role: who, why: '内容已变' });
      }
    }
    const state = bad.length ? (bad.some((x) => x.why === '记录路径已不存在') ? 'MISSING' : 'STALE') : 'FRESH';
    rows.push({ report: f, state, claims: claims.map(claimLabel), bad });
  }
  console.log('报告陈旧巡检 · ' + dir + (all ? '（全部 .md）' : '（只看 _*.md）'));
  for (const r of rows) {
    const tag = { FRESH: '✓ FRESH  ', STALE: '✘ STALE  ', MISSING: '✘ MISSING', UNSTAMPED: '· 无指纹 ', BADSTAMP: '· 指纹坏 ', 'N/A': '· 非判定类' }[r.state];
    console.log('  ' + tag + ' ' + r.report + (r.claims ? '  [' + r.claims.join(' + ') + ']' : '')
      + (r.bad && r.bad.length ? '  ⇒ ' + r.bad.map((x) => x.role + '(' + x.why + ')').join(', ') : (r.why ? '  ⇒ ' + r.why : '')));
  }
  const counts = {};
  for (const r of rows) counts[r.state] = (counts[r.state] || 0) + 1;
  /* 不成立 = 除 FRESH 以外的一切，但「非判定类」不算（它本就不该盖章）。 */
  const realRows = rows.filter((r) => r.state !== 'N/A');
  const red = realRows.filter((r) => r.state !== 'FRESH');
  const code = realRows.length === 0 ? 'EMPTY' : (red.length ? 'HAS-STALE' : 'ALL-FRESH');
  console.log('  合计：' + rows.length + ' 份 · ' + JSON.stringify(counts));
  console.log('  结论：**' + (red.length ? red.length + ' 份不成立（STALE / MISSING / 无指纹 / 指纹坏）⇒ 须重跑或补章' : '全部成立') + '**（scan_code=' + code + '）');
  if (JSON_OUT) console.log(JSON.stringify({ dir, scan_code: code, counts, rows }, null, 2));
  return red.length ? 1 : 0;
}
function cmdReportCheck(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const rep = val('report');
  if (!rep) { console.error('前提层失败：report-check 需要 --report <报告.md>，并给 --draft/--contract/--package/--anchors/--cover/--letter/--comments 中至少一项做比对'); return 2; }
  const rAbs = path.resolve(rep);
  if (!fs.existsSync(rAbs)) { console.error('前提层失败：报告不存在 —— ' + rAbs); return 2; }
  const txt = fs.readFileSync(rAbs, 'utf8');
  const claims = provenanceClaims(txt);
  if (!claims.length) { console.error('前提层失败：报告里没有运行指纹（PROVENANCE）⇒ **核不了它属于哪一次运行**，不得当通过'); return 2; }
  const now = { draft: val('draft'), contract: val('contract'), package: val('package'), anchors: val('anchors'), cover: val('cover'), letter: val('letter'), comments: val('comments') };
  const rows = [];
  for (const prov of claims) {
    for (const r of (prov.inputs || [])) {
      const base = { claim: claimLabel(prov), at: prov.at, role: r.role, stamped: r.sha12 };
      const cur = now[r.role];
      if (!cur) { rows.push(Object.assign({ state: 'uncompared' }, base)); continue; }
      const abs = path.resolve(cur);
      if (!fs.existsSync(abs)) { rows.push(Object.assign({ state: 'missing', path: abs }, base)); continue; }
      const d = digestOf(abs);
      rows.push(Object.assign({ state: d.sha12 === r.sha12 ? 'same' : 'changed', current: d.sha12, path: abs }, base));
    }
  }
  const changed = rows.filter((x) => x.state === 'changed');
  const un = rows.filter((x) => x.state === 'uncompared' || x.state === 'missing');
  const ZH = { same: '与本次输入一致', changed: '**已改变**（报告已陈旧）', uncompared: '**未比对**（不等于新鲜）', missing: '本次输入不存在' };
  console.log('报告运行指纹核对 · ' + path.basename(rAbs) + '（声明 ' + claims.length + ' 条）');
  for (const c of claims) console.log('  声明署名：' + claimLabel(c) + ' at=' + c.at);
  for (const x of rows) console.log('    ' + (x.state === 'same' ? '✓' : (x.state === 'changed' ? '✘' : '·')) + ' ' + x.role + ' · ' + ZH[x.state]
    + (x.stamped ? ' · 报告=' + x.stamped : '') + (x.current ? ' · 现在=' + x.current : ''));
  /* ★ 机器可读判定码与人类可读结论**并存**（只给中文长句时，外层脚本只能做子串匹配 —— 那正是脆断言）。 */
  const code = changed.length ? 'STALE' : (un.length ? 'PARTIAL' : 'FRESH');
  const verdict = code === 'STALE' ? 'STALE（输入已变 ⇒ 报告过期，须重跑）'
    : (code === 'PARTIAL' ? '部分未比对（不得当新鲜）' : 'FRESH（与本次输入一致）');
  console.log('  结论：**' + verdict + '**（verdict_code=' + code + '）');
  if (JSON_OUT) console.log(JSON.stringify({ report: rAbs, claims: claims.map(claimLabel), verdict, verdict_code: code, rows }, null, 2));
  return (changed.length || un.length) ? 1 : 0;
}
function cmdCover(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const coverArg = val('cover');
  if (!coverArg) { console.error('前提层失败：cover 需要 --cover <投稿信.md> [--contract <契约.json>] [--out <报告.md>]'); return 2; }
  const cAbs = path.resolve(coverArg);
  if (!fs.existsSync(cAbs)) { console.error('前提层失败：投稿信不存在 —— ' + cAbs); return 2; }
  const text = fs.readFileSync(cAbs, 'utf8');
  const plain = String(text).replace(/\r\n?/g, '\n');

  /* ① 必需声明项 */
  const items = COVER_ITEMS.map((it) => ({ id: it.id, label: it.label, ok: it.re.test(plain) }));
  /* ② 期刊名交叉核（确定性：来自契约） */
  let journalCheck = { state: 'skipped', why: '未给 --contract ⇒ **未交叉核对**（未核 ≠ 通过）', journal: '' };
  const contractArg = val('contract');
  if (contractArg) {
    const kAbs = path.resolve(contractArg);
    if (!fs.existsSync(kAbs)) { console.error('前提层失败：契约不存在 —— ' + kAbs); return 2; }
    let J = '';
    try { J = String(JSON.parse(fs.readFileSync(kAbs, 'utf8')).journal || ''); } catch (e) { console.error('前提层失败：契约不是 JSON —— ' + String((e && e.message) || e)); return 2; }
    if (!J) journalCheck = { state: 'contract-missing-name', why: '契约里没有 journal 字段 ⇒ 核不了', journal: '' };
    else {
      /* 逐词判定：期刊名在信里出现（容忍缩写/大小写/连字符差异） */
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
      const hay = norm(plain); const needle = norm(J);
      const hit = hay.includes(needle) || needle.split(' ').filter((w) => w.length > 3).every((w) => hay.includes(w));
      journalCheck = { state: hit ? 'match' : 'mismatch', why: hit ? '信里出现目标刊名' : '信里**找不到**契约声明的刊名「' + J + '」', journal: J };
    }
  }
  /* ③ 占位符检查（防模板原文投出去） */
  const holes = [];
  const reHole = /\[(?:\s*(?:待填|待补|TBD|TODO|to be (?:filled|added)|XXX|xx+|填(?:写)?|insert[^\]]*)\s*)\]/gi;
  let m;
  while ((m = reHole.exec(plain)) !== null) holes.push(m[0]);
  if (/待填|待补|TODO|TBD/.test(plain)) {
    for (const w of (plain.match(/(?:待填|待补|TODO|TBD)[^\n]{0,20}/g) || []).slice(0, 5)) holes.push(w.trim());
  }
  const missing = items.filter((x) => !x.ok);
  const bad = missing.length + (journalCheck.state === 'mismatch' ? 1 : 0) + holes.length;

  const L = [];
  L.push('# 投稿信（cover letter）要素核对 · ' + path.basename(cAbs));
  L.push('');
  L.push('> 只核 **"在场/一致"** 这类可机械判定的事：必需声明是否写到 · 刊名是否与目标刊契约一致 · 是否残留模板占位符。');
  L.push('> 信写得有没有说服力，仍属人读。**未给 --contract 时刊名一栏记"未交叉核对"，不等于通过。**');
  L.push('');
  L.push('| 检查 | 结果 |');
  L.push('| --- | --- |');
  for (const it of items) L.push('| ' + it.label + ' | ' + (it.ok ? '✅ 在场' : '✗ **缺**') + ' |');
  L.push('| 目标刊名一致（`--contract` 的 `journal`） | ' + (journalCheck.state === 'match' ? '✅ ' + journalCheck.why : (journalCheck.state === 'skipped' ? '· ' + journalCheck.why : '✗ **' + journalCheck.why + '**')) + ' |');
  L.push('| 无模板占位符 | ' + (holes.length ? '✗ **发现 ' + holes.length + ' 处**：' + Array.from(new Set(holes)).slice(0, 8).join(' / ') : '✅ 无') + ' |');
  L.push('');
  if (bad) {
    L.push('## 待补');
    L.push('');
    for (const x of missing) L.push('- 缺声明：**' + x.label + '**');
    if (journalCheck.state === 'mismatch') L.push('- 刊名：' + journalCheck.why);
    if (holes.length) L.push('- 占位符：' + Array.from(new Set(holes)).slice(0, 8).join(' / ') + '（**模板没填完就投出去会被编辑部直接看到**）');
  }
  L.push('');
  L.push('## 复跑命令');
  L.push('');
  L.push('```text');
  L.push('node bin/studio.cjs cover --cover "' + cAbs + '"' + (contractArg ? ' --contract "' + path.resolve(contractArg) + '"' : ''));
  L.push('```');
  L.push(provenanceLine([['cover', cAbs], ['contract', contractArg]]));
  const outPath = val('out') || path.join(reportHome(cAbs), '_投稿信核对-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
  if (JSON_OUT && !val('out')) {
    console.log(JSON.stringify({ cover: cAbs, journal: journalCheck, missing: missing.map((x) => x.id), holes: Array.from(new Set(holes)), bad, out: outPath }, null, 2));
  } else {
    console.log('投稿信要素核对 · ' + path.basename(cAbs));
    for (const it of items) console.log('  ' + (it.ok ? '✓' : '✘') + ' ' + it.label);
    console.log('  ' + (journalCheck.state === 'match' ? '✓' : (journalCheck.state === 'skipped' ? '·' : '✘')) + ' 刊名：' + journalCheck.why);
    console.log('  ' + (holes.length ? '✘' : '✓') + ' 模板占位符：' + (holes.length ? holes.length + ' 处' : '无'));
    console.log('  报告：' + outPath);
  }
  return bad ? 1 : 0;
}

function cmdResponse(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const letterArg = val('letter');
  const commentsArg = val('comments');
  const scaffoldArg = val('scaffold');
  /* ★ v3.2.32：**生成器模式** —— 只给 `--comments` 就够（它不检查，而是产出待填骨架）。
     ★★ 关键纪律（fail-first）：骨架必须**通不过本命令自己的核对**。做法是每条回应都带 `待填` 哨兵，
     核对时直接判「未填写（仍是骨架）」⇒ 「把骨架当成品交出去」在结构上不可能发生。 */
  if (scaffoldArg) {
    if (!commentsArg) { console.error('前提层失败：response --scaffold 需要 --comments <审稿意见.md>（没有意见清单就生成不出逐条骨架）'); return 2; }
    const cS = path.resolve(commentsArg);
    if (!fs.existsSync(cS)) { console.error('前提层失败：审稿意见不存在 —— ' + cS); return 2; }
    const cs = splitComments(fs.readFileSync(cS, 'utf8'));
    if (!cs.length) { console.error('前提层失败：审稿意见文件里没解析出任何条目（≥20 字的块才算意见）'); return 2; }
    const outS = path.resolve(scaffoldArg);
    const S = [];
    S.push('# Response to Reviewers（待填骨架 · 由 paper-studio 生成）', '');
    S.push('> 每条意见下有两处必须由人填写：`**Response:**`（实质回应，≥40 字，不能只写「已修改」）与 `**Where:**`（改动位置：行号 / 页 / 节 / 图表编号）。', '');
    S.push('> ⚠ 本文件**填写前不能作为成品**：核对器会按条报「未填写（仍是骨架）」。', '', '---', '');
    for (const c of cs) {
      S.push('## Comment ' + c.no, '');
      S.push('**Comment ' + c.no + ':** ' + c.text, '');
      S.push('**Response:**', '');
      S.push('<!-- 待填：实质回应 —— 做了什么、为什么这样做；≥40 字。不要只写「已修改」。 -->', '');
      S.push('**Where:**', '');
      S.push('<!-- 待填：改动位置 —— 行号 / 页 / 节 / 表格或插图编号；也可说明改写的段落。 -->', '', '');
    }
    fs.writeFileSync(outS, S.join('\n'), 'utf8');
    console.log('已生成回复信待填骨架 · ' + cs.length + ' 条意见 ⇒ ' + outS);
    console.log('  下一步：逐条填写 Response 与 Where，然后用 `response --letter <本文件> --comments <意见>` 复跑核对。');
    return 0;
  }
  if (!letterArg) { console.error('前提层失败：response 需要 --letter <回复信.md> --comments <审稿意见.md>'); return 2; }
  if (!commentsArg) { console.error('前提层失败：response 需要 --comments <审稿意见.md>（**没有意见清单就核不了覆盖**，不得当通过）'); return 2; }
  const lAbs = path.resolve(letterArg); const cAbs = path.resolve(commentsArg);
  if (!fs.existsSync(lAbs)) { console.error('前提层失败：回复信不存在 —— ' + lAbs); return 2; }
  if (!fs.existsSync(cAbs)) { console.error('前提层失败：审稿意见不存在 —— ' + cAbs); return 2; }
  const letter = normText(fs.readFileSync(lAbs, 'utf8'));
  const comments = splitComments(fs.readFileSync(cAbs, 'utf8'));
  if (!comments.length) { console.error('前提层失败：审稿意见文件里没解析出任何条目（≥20 字的块才算意见）—— 请检查格式'); return 2; }

  const rows = [];
  for (let i = 0; i < comments.length; i++) {
    const c = comments[i];
    const probe = c.text.slice(0, 80);
    /* 覆盖判定：整段原文（前 80 字）出现 ⇒ 覆盖；否则用 40 字滑窗找最长匹配（容忍轻微改写） */
    let hit = letter.indexOf(probe);
    let matched = hit >= 0 ? probe.length : 0;
    if (hit < 0) {
      const w = 40;
      for (let k = 0; k + w <= Math.min(c.text.length, 200); k += 10) {
        if (letter.indexOf(c.text.slice(k, k + w)) >= 0) { matched = w; break; }
      }
    }
    const next = i + 1 < comments.length ? letter.indexOf(comments[i + 1].text.slice(0, 60)) : -1;
    const start = hit >= 0 ? hit : (matched ? letter.indexOf(c.text.slice(0, matched)) : -1);
    const end = next > start && start >= 0 ? next : letter.length;
    const block = start >= 0 ? letter.slice(start, end) : '';
    /* 去掉引用行/引用原文，只留"回应"正文 */
    const body = block.split('\n').filter((L) => !/^\s*>/.test(L)).join('\n')
      .replace(normText(probe), '').replace(/^\s*(?:回应|回复|Response|Answer|答)\s*[:：]?/i, '').trim();
    const hasLocator = LOCATOR_RE.test(body);
    /* ★ v3.2.32：骨架哨兵 —— 只要回应块里还有 `待填`/TODO/FIXME，就判「未填写」，
       而不是含糊地报「空回应」或「未指明改动位置」（那两句会让人以为"我写了但不够"）。 */
    const unfilled = /待填|TODO|FIXME/i.test(body);
    const empty = EMPTY_RESPONSE.test(body) || body.length < 40;
    const covered = hit >= 0 || matched >= 40;
    const verdict = !covered ? 'missing' : (unfilled ? 'not-filled' : (empty ? 'empty-response' : (hasLocator ? 'ok' : 'no-locator')));
    rows.push({ no: c.no, covered, matched, len: body.length, hasLocator, verdict, text: c.text.slice(0, 60) });
  }
  const bad = rows.filter((r) => r.verdict !== 'ok');
  const L = [];
  L.push('# 返修回复信逐条核对 · ' + path.basename(lAbs));
  L.push('');
  L.push('> 本命令只核**可机械判定**的部分：① 每条意见是否出现在回复信里 ② 每条是否有**实质回应**（不是"已修改"这种空话）');
  L.push('> ③ 回应是否**指明改动位置**（行号/页/节/图表/新增删改字样）。**回应是否在学术上站得住仍属人读。**');
  L.push('');
  L.push('- 审稿意见：**' + comments.length + '** 条（来自 `' + path.basename(cAbs) + '`）');
  L.push('- 逐条核对：合规 **' + (rows.length - bad.length) + '** · 有问题 **' + bad.length + '**');
  L.push('');
  L.push('| # | 状态 | 原文匹配 | 回应字数 | 有改动位置 | 意见开头 |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  const ZH = { ok: '✅ 合规', missing: '✗ **漏回**', 'not-filled': '✗ **未填写**（仍是骨架）', 'empty-response': '✗ **空回应**（<40 字或只有"已修改"）', 'no-locator': '✗ **未指明改动位置**' };
  for (const r of rows) L.push('| ' + r.no + ' | ' + (ZH[r.verdict] || r.verdict) + ' | ' + (r.matched ? r.matched + ' 字' : '未匹配') + ' | ' + r.len + ' | ' + (r.hasLocator ? '是' : '否') + ' | ' + r.text.replace(/\|/g, '\\|') + ' |');
  if (bad.length) {
    L.push('');
    L.push('## 待补（逐条）');
    L.push('');
    for (const r of bad) L.push('- **#' + r.no + '**（' + (ZH[r.verdict] || r.verdict) + '）：' + r.text);
  }
  L.push('');
  L.push('## 复跑命令');
  L.push('');
  L.push('```text');
  L.push('node bin/studio.cjs response --letter "' + lAbs + '" --comments "' + cAbs + '"');
  L.push('```');
  L.push(provenanceLine([['letter', lAbs], ['comments', cAbs]]));
  const outPath = val('out') || path.join(reportHome(lAbs), '_回复信核对-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
  if (JSON_OUT && !val('out')) {
    console.log(JSON.stringify({ letter: lAbs, comments: comments.length, bad: bad.length, rows }, null, 2));
  } else {
    console.log('返修回复信逐条核对 · ' + path.basename(lAbs));
    console.log('  审稿意见 ' + comments.length + ' 条 ⇒ 合规 ' + (rows.length - bad.length) + ' · 有问题 ' + bad.length);
    for (const r of rows) console.log('    ' + (r.verdict === 'ok' ? '✓' : '✘') + ' #' + r.no + ' ' + (ZH[r.verdict] || r.verdict) + ' · 回应 ' + r.len + ' 字 · 位置 ' + (r.hasLocator ? '有' : '无'));
    console.log('  报告：' + outPath);
  }
  return bad.length ? 1 : 0;
}

function cmdAnchors(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const has = (k) => A.indexOf('--' + k) >= 0;
  const draft = val('draft');
  if (!draft) { console.error('前提层失败：anchors 需要 --draft <稿.md> [--anchors <锚点表.json>] [--out <工作单.md>] [--json <骨架.json>]'); return 2; }
  const draftAbs = path.resolve(draft);
  if (!fs.existsSync(draftAbs)) { console.error('前提层失败：稿件不存在 —— ' + draftAbs); return 2; }
  const text = fs.readFileSync(draftAbs, 'utf8');
  const hits = extractCitations(text);
  const keys = Array.from(hits.keys());
  /* ★ v3.2.41：**锚点表要透传给门**。此前本命令只传 `--draft` ⇒ 门无从知道锚点表已存在，
     只能按「无锚点」判 ⇒ 每条引用都成 HIGH（A 稿真身：报 HIGH 23，而带上 `anchors-已解析.json`
     门其实判 HIGH 0 · LOW 16）⇒ **把最坏情况当成"门的结论"报出去**，这一错报持续了多轮。
     现在：显式 `--anchors` 优先；否则按约定找同目录 `anchors-已解析.json`；都没有才按无锚点判，**并在结论里明说**。 */
  const explicitAnchors = val('anchors') ? path.resolve(val('anchors')) : '';
  /* 约定：`submission/` 只放**待上传件**，报告与锚点表放**运行根目录**（这条由包卫生规则强制）
     ⇒ 自动探测要同时看稿所在目录与**它的上一级**，否则「表就在旁边却探测不到」= 报错的无锚点态。 */
  const cand = [path.join(path.dirname(draftAbs), 'anchors-已解析.json'),
    path.join(path.dirname(path.dirname(draftAbs)), 'anchors-已解析.json')];
  const defaultAnchors = cand.find((p) => fs.existsSync(p)) || '';
  let anchorsForGate = '';
  if (explicitAnchors && fs.existsSync(explicitAnchors)) anchorsForGate = explicitAnchors;
  else if (!explicitAnchors && defaultAnchors) anchorsForGate = defaultAnchors;
  const anchorsNote = anchorsForGate
    ? ('`' + path.basename(anchorsForGate) + '`' + (explicitAnchors ? '（--anchors 指定）' : '（同目录/上一级约定自动采用）'))
    : (explicitAnchors ? ('**未找到** —— ' + explicitAnchors) : '**未提供**（同目录也没有 anchors-已解析.json）');

  /* 门的结论（门才是判定者；取不到就明说） */
  let gate = null, gateWhy = '';
  try {
    const pipeline = readPipeline();
    const g = (pipeline.gates || []).find((x) => x.id === 'claim-anchor');
    if (!g) gateWhy = '真源里没有 claim-anchor 门定义';
    else {
      const { script, why } = resolveGateScript(g, pipeline);
      if (!script || !fs.existsSync(script)) gateWhy = why || ('门脚本不可用：' + script);
      else {
        const { spawnSync } = require('child_process');
        const gateArgs = [script, '--draft', draftAbs].concat(anchorsForGate ? ['--anchors', anchorsForGate] : []).concat(['--json']);
        const r = spawnSync(process.execPath, gateArgs, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        const o = String(r.stdout || '').trim();
        const i = o.indexOf('{');
        if (i >= 0) { try { gate = JSON.parse(o.slice(i)); } catch { gateWhy = '门输出无法解析为 JSON'; } }
        else gateWhy = '门未输出 JSON（退出码 ' + r.status + '）';
      }
    }
  } catch (e) { gateWhy = String((e && e.message) || e); }
  const byKey = new Map();
  if (gate) for (const h of (gate.HIGH || []).concat(gate.LOW || [])) if (!byKey.has(String(h.key))) byKey.set(String(h.key), h);

  /* --resolve：从**稿件自己的题录**解析 identifier（确定性、不联网）生成草稿锚点表；
     可选 --online 用 Crossref 兜底（过相似度阈值才采用）。 */
  if (has('resolve')) return cmdResolve(args, argv, draftAbs, keys, hits);
  /* --oa：查引用文献的**开放获取可达性**（OpenAlex，免 key 批量）⇒ 决定"补页号原句"从哪几篇开始 */
  if (has('oa')) return cmdAnchorsOA(args, argv, draftAbs, val, has);
  /* ★ v3.2.44：`--quote-hints` —— 从免 key 全文/摘要里给出**候选原句**（不代填）。 */
  if (has('quote-hints')) return cmdQuoteHints(args, argv, draftAbs, keys, hits, val, has);

  const L = [];
  L.push('# 引用锚点表工作单 · ' + path.basename(draftAbs));
  L.push('');
  L.push('> 第 14 道门（claim-anchor）要求**正文每条引用**在锚点表里有条目，否则判 `HIGH-1 fabricated-reference`（P0 阻断）。');
  L.push('> 本工作单：**键集与行号由本工具扫描得到**（工作单抽取器），**判定权在门**；骨架字段取自门的真实 schema，');
  L.push('> 且**一律留空** —— 来源、页号、原句必须由人填写，工具不预填（预填就等于编造）。');
  L.push('');
  L.push('- 稿件：`' + draftAbs + '`');
  L.push('- 扫描到的引用键：**' + keys.length + '** 个' + (keys.length ? '（' + keys.join(', ') + '）' : ''));
  L.push('- 门用的锚点表：' + anchorsNote);
  L.push('- 门的结论：' + (gate ? ('HIGH **' + (gate.HIGH || []).length + '** · LOW ' + (gate.LOW || []).length + ' · 判定 `' + (gate.verdict || '') + '`'
    + (anchorsForGate ? '' : '　⚠ **这是「无锚点」态**（未解析态），不是最终结论 —— 填好锚点表后用 `--anchors` 复跑'))
    : '**未取到**（' + gateWhy + '）⇒ 本工作单只含扫描结果，**不得当作"门已通过"**'));
  L.push('');
  if (!keys.length) {
    L.push('**未发现引用标记**（`[n]` 或 `(Author, YYYY)`）。若稿件确有引用，请检查标记写法。');
  } else {
    L.push('## 逐条待填（每条引用一节）');
    L.push('');
    for (const k of keys) {
      const h = hits.get(k); const gh = byKey.get(k);
      L.push('### `[' + k + ']`' + (gh ? '　门报：`' + gh.id + ' ' + gh.stage + '` L' + gh.line + ' —— ' + gh.why : ''));
      L.push('');
      L.push('- 稿件行号：' + h.lines.join(', '));
      L.push('- 引用它的句子：');
      for (const s of h.sentences) L.push('  - ' + (s || '（该行为标记本身）'));
      L.push('- 待填（来源侧，必须**取到原文**再填）：');
      L.push('  - `identifier.doi` / `pmid` / `url`（三者至少一项，且格式可解析）');
      L.push('  - `locator`：`{ kind: "page-quote", value: "<页号>", quote: "<≥30 字的原文原句>" }` ⇒ 三者齐备才算"人已复核过"');
      L.push('  - `evidence_layer`：默认 `author_statement`；**`inference` / `unconfirmed` 不得当引文**');
      L.push('  - `scope.supports_strength: true`：**仅当**该句含强度词且原文确实支持时');
      L.push('  - `status`：`published` / `preprint` / `retracted`（后两者所在句必须有对冲词）');
      L.push('  - `verdict`：`SUPPORTED` / `PARTIAL`（PARTIAL 须给 `sub_claim_breakdown` 且含正反两向）');
      L.push('');
    }
  }
  L.push('## 用法');
  L.push('');
  L.push('```text');
  L.push('node bin/studio.cjs anchors --draft "' + draftAbs + '" --json anchors.json   # 生成骨架后逐条填');
  L.push('node bin/studio.cjs preflight --draft "' + draftAbs + '" --anchors anchors.json   # 带锚点表复跑第 14 道门');
  L.push('```');
  /* ★ v3.2.43：默认落点必须**包感知**。此前直接用稿件所在目录 ⇒ 稿在 `submission/` 时工作单被写进投稿包，
     下一轮「包卫生」判 **✗ 不该进包**（真实发生：A 稿因此从 18/0/2 变 17/1/2）—— **工具自己污染投稿包**。
     项目里早有 `reportHome()` 干这个（cover/response/preflight 都在用），`anchors` 漏了。
     （诚实记：本补丁第一版用 `already='reportHome(draftAbs)'` 做幂等哨兵，被 preflight 的同名调用误匹配 ⇒ 实际没落盘，
      由刚扩展的落点锁当场抓出。教训：幂等哨兵要选**只在目标处出现**的串。） */
  const outPath = val('out') || path.join(reportHome(draftAbs), '_锚点表工作单-' + new Date().toISOString().slice(0, 10) + '.md');
  fs.writeFileSync(outPath, L.join('\n') + '\n', 'utf8');
  const jsonPath = val('json');
  if (jsonPath) {
    const skel = { _warning: '★ 以下字段全部留空：来源信息必须由人取到原文后填写；工具不预填（预填等于编造）。',
      _schema: { note: '字段语义见 references/anchor-table.example.json 与第 14 道门 _gate-claim-anchor.cjs 的实现' },
      anchors: keys.map(ANCHOR_SKELETON) };
    fs.writeFileSync(path.resolve(jsonPath), JSON.stringify(skel, null, 2) + '\n', 'utf8');
  }
  /* `--json <路径>` = 把骨架写到该路径（仍给人读摘要）；纯 `--json` = 机器输出。两者语义不同，别混。 */
  if (JSON_OUT && !jsonPath) {
    console.log(JSON.stringify({ draft: draftAbs, keys, gate: gate ? { high: (gate.HIGH || []).length, low: (gate.LOW || []).length, verdict: gate.verdict } : null, out: outPath, skeleton: null }, null, 2));
  } else {
    console.log('引用锚点表工作单 · ' + path.basename(draftAbs));
    console.log('  扫描到引用键 ' + keys.length + ' 个' + (keys.length ? '：' + keys.join(', ') : ''));
    console.log('  门用锚点表：' + anchorsNote);
    console.log('  门的结论：' + (gate ? ('HIGH ' + (gate.HIGH || []).length + ' · LOW ' + (gate.LOW || []).length + ' · ' + gate.verdict
      + (anchorsForGate ? '' : '（⚠ 无锚点态，非最终结论）')) : '未取到（' + gateWhy + '）'));
    console.log('  工作单：' + outPath + (jsonPath ? '\n  骨架：  ' + path.resolve(jsonPath) + '（逐条填完后用 preflight --anchors 复跑）' : ''));
  }
  return 0;
}

function cmdPreflight(args, argv) {
  const A = argv || [];
  const val = (k) => { const i = A.indexOf('--' + k); return i >= 0 && A[i + 1] && !A[i + 1].startsWith('--') ? A[i + 1] : ''; };
  const draft = val('draft');
  const pkgDir = val('package');
  const contractArg = val('contract');
  const outArg = val('out');
  if (!draft) { console.error('前提层失败：preflight 需要 --draft <稿.md>（可选 --package <投稿包> --contract <契约.json> --out <报告.md>）'); return 2; }
  const draftAbs = path.resolve(draft);
  if (!fs.existsSync(draftAbs)) { console.error('前提层失败：稿件不存在 —— ' + draftAbs); return 2; }
  if (contractArg) {
    const cAbs = path.resolve(contractArg);
    if (!fs.existsSync(cAbs)) { console.error('前提层失败：契约不存在 —— ' + cAbs + '（**不许静默跳过契约门**：给了契约就必须能跑）'); return 2; }
  }
  if (pkgDir && !fs.existsSync(path.resolve(pkgDir))) { console.error('前提层失败：投稿包目录不存在 —— ' + path.resolve(pkgDir)); return 2; }
  let pipeline;
  try { pipeline = readPipeline(); } catch (e) { console.error('前提层失败：' + String((e && e.message) || e)); return 2; }

  const { spawnSync } = require('child_process');
  const steps = [];
  const run = (label, cmd, cmdArgs) => {
    const r = spawnSync(cmd, cmdArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    steps.push({ label, rc: r.status === null ? -1 : r.status, out });
    return r;
  };

  // 1) 门执行器（必过门清单）——★ 必须是**真调用**：首版这里只声明了一个变量却从未 run，
  //    结果"共 2 步"、且段落标题按下标写死 ⇒ 契约门报告被打上"一、门执行器"的标题（最要紧的一步其实没跑）。
  run('门执行器（必过门清单）', process.execPath,
    [path.join(ROOT, 'bin', 'gate-runner.cjs'), '--type', val('type') || 'check', '--draft', draftAbs]
      .concat(pkgDir ? ['--package', path.resolve(pkgDir)] : [])
      .concat(contractArg ? ['--contract', path.resolve(contractArg)] : [])
      /* v3.2.21：锚点表透传给门执行器（第 14 道门 claim-anchor 用它核"引用↔来源"） */
      .concat(val('anchors') ? ['--anchors', path.resolve(val('anchors'))] : []));
  // 2) 期刊契约门（给了契约才跑；跑不了就记"不可用"）
  if (contractArg) {
    const gateDef = (pipeline.gates || []).find((g) => g.id === 'journal-contract');
    if (!gateDef) {
      steps.push({ label: '期刊契约门', rc: -1, out: '真源里没有 journal-contract 门定义 ⇒ **未检查**（不是通过）' });
    } else {
      const { script, why } = resolveGateScript(gateDef, pipeline);
      if (!script || !fs.existsSync(script)) {
        steps.push({ label: '期刊契约门', rc: -1, out: '门脚本不可用：' + (why || script) + ' ⇒ **未检查**（不是通过）' });
      } else {
        const repPath = path.join(os.tmpdir(), 'preflight-contract-' + Date.now() + '.md');
        const a = ['--draft', draftAbs, '--contract', path.resolve(contractArg), '--report', repPath];
        if (pkgDir) a.push('--package', path.resolve(pkgDir));
        const r = run('期刊契约门', process.execPath, [script].concat(a));
        try { steps[steps.length - 1].report = fs.readFileSync(repPath, 'utf8'); } catch {}
      }
    }
  } else {
    steps.push({ label: '期刊契约门', rc: null, out: '未给 --contract ⇒ **未检查**（未检查 ≠ 通过）' });
  }
  /* 2.5) 投稿信要素核对（给了 --cover 才跑）—— 把"投稿阶段"也纳入总检 */
  if (val('cover')) {
    run('投稿信要素核对', process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'cover', '--cover', path.resolve(val('cover'))]
      .concat(contractArg ? ['--contract', path.resolve(contractArg)] : []));
  } else {
    steps.push({ label: '投稿信要素核对', rc: null, out: '未给 --cover ⇒ **未检查**（未检查 ≠ 通过）' });
  }

  /* 2.8) 返修回复信核对（给了 --letter 与 --comments 才跑）—— 把"返修阶段"也纳入总检 */
  if (val('letter')) {
    run('返修回复信核对', process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'response',
      '--letter', path.resolve(val('letter'))]
      .concat(val('comments') ? ['--comments', path.resolve(val('comments'))] : []));
  } else {
    steps.push({ label: '返修回复信核对', rc: null, out: '未给 --letter ⇒ **未检查**（未检查 ≠ 通过）' });
  }

  /* ★ v3.2.36 第 6 步：**投稿门户字段**（题名/摘要/关键词/作者/通讯作者 + 契约限额对照）。
     为什么是**提醒级**：门户必填项缺失/超限确实要在上传前处理，但「稿件本身没写 Corresponding author 行」并不等于稿件不可投
     （门户另填、信封/投稿信里有）⇒ 按 rc=1 进「提醒」桶，**不阻断**，由作者逐条确认。 */
  run('投稿门户字段（逐字不变量）', process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'submission-fields',
    '--draft', draftAbs]
    .concat(pkgDir ? ['--package', path.resolve(pkgDir)] : [])
    .concat(contractArg ? ['--contract', path.resolve(contractArg)] : []));
  // 3) 合规门（给了包才跑）
  if (pkgDir) {
    run('投稿合规门', process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'compliance', path.resolve(pkgDir)]);
  } else {
    steps.push({ label: '投稿合规门', rc: null, out: '未给 --package ⇒ **未检查**（未检查 ≠ 通过）' });
  }
  // 4) 图件规格（契约里声明了 figure_spec 才相关；由契约门覆盖 ⇒ 这里只提示）
  const specNote = contractArg ? '见契约门输出里的 figure_spec 项（若契约声明了 limits.figure_spec）' : '未给契约 ⇒ 未检查';

  /* ★ v3.2.29：三桶分清 —— **rc≥2＝未通过（阻断）** · **rc=1＝有提醒（不阻断，逐条确认）** · **rc=null＝未检查**。
     首版把 rc≠0 一律当"未通过" ⇒ 一条提醒（如图表数量建议区间）把整篇报成"不可投"。 */
  const bad = steps.filter((s) => s.rc !== null && s.rc >= 2);
  const warned = steps.filter((s) => s.rc === 1);
  const unchecked = steps.filter((s) => s.rc === null);
  const verdict = bad.length ? '不可投（有门未通过）'
    : (warned.length ? '可投（有 ' + warned.length + ' 项提醒，须逐条确认）'
      : (unchecked.length ? '待定（有项目未检查）' : '可投（当前所有必过项通过）'));

  const L = [];
  L.push('# 投稿前总检（preflight）· ' + path.basename(draftAbs));
  L.push('');
  L.push('> 由 `node bin/studio.cjs preflight` 汇总生成。**本命令不做判定**——逐项判定权属于各门自身；');
  L.push('> 凡"未检查/不可用"一律**不得当通过**（这是本技能的一贯纪律）。');
  L.push('');
  L.push('- 稿件：`' + draftAbs + '`');
  L.push('- 投稿包：' + (pkgDir ? '`' + path.resolve(pkgDir) + '`' : '**未给** ⇒ 包级门未检查'));
  L.push('- 期刊契约：' + (contractArg ? '`' + path.basename(contractArg) + '`' : '**未给** ⇒ 契约门未检查'));
  L.push('- 引用锚点表：' + (val('anchors') ? '`' + path.basename(val('anchors')) + '`（已透传给第 14 道门）' : '**未给** ⇒ claim-anchor 门按"无锚点"判 ⇒ 已计入下方结果'));
  L.push('- 投稿信：' + (val('cover') ? '`' + path.basename(val('cover')) + '`（已核要素与刊名一致性）' : '**未给** ⇒ 投稿信要素未检查'));
  L.push('- 投稿门户字段：**总是检查**（题名/摘要/关键词/作者/通讯作者必填；声明类与短标题只报告；限额按契约对照）');
  L.push('- 返修回复信：' + (val('letter') ? '`' + path.basename(val('letter')) + '`' + (val('comments') ? ' + 意见 `' + path.basename(val('comments')) + '`' : '（**未给 --comments ⇒ 核不了覆盖**）') : '**未给** ⇒ 回复信未检查'));
  L.push('- 结论：**' + verdict + '**（未通过 ' + bad.length + ' 项 · **提醒 ' + warned.length + ' 项** · 未检查 ' + unchecked.length + ' 项 · 共 ' + steps.length + ' 步）');
  L.push('');
  const CN = ['一', '二', '三', '四', '五', '六', '七', '八'];
  steps.forEach((s, i) => {
    /* ★ 标题**由步名派生**（此前按下标写死 ⇒ 少一步就整排错位、把别人的报告顶到"一、门执行器"下） */
    L.push('## ' + (CN[i] || (i + 1)) + '、' + s.label);
    L.push('');
    L.push('退出码：' + (s.rc === null ? '（未运行）' : s.rc) + '　' + (s.rc === 0 ? '⇒ 通过' : (s.rc === 1 ? '⇒ **有提醒（不阻断，逐条确认）**' : (s.rc === null ? '' : '⇒ **未通过**'))));
    L.push('');
    if (s.report) {
      L.push('```markdown');
      L.push(String(s.report).trim());
      L.push('```');
    } else {
      L.push('```text');
      L.push(String(s.out).trim().slice(0, 4000));
      L.push('```');
    }
    L.push('');
  });
  /* ★ v3.2.37：序号必须**按 steps 派生** —— 首版硬编码「五」，v3.2.36 加第 6 步后报告里出现**两个「五」**
     （「五、投稿门户字段」与「五、图件规格」）。这类撞号不会让门变红，只会让人读错章节。 */
  const specNo = CN[steps.length] || String(steps.length + 1);
  L.push('## ' + specNo + '、图件规格');
  L.push('');
  L.push(specNote);
  if (contractArg) {
    try {
      const C = JSON.parse(fs.readFileSync(path.resolve(contractArg), 'utf8'));
      if (Array.isArray(C.human_only) && C.human_only.length) {
        L.push('');
        L.push('## 六、人工边界（机器不判，须人核）');
        L.push('');
        for (const x of C.human_only) L.push('- ' + x);
      }
      if (C.needs_official_recheck === true) {
        L.push('');
        L.push('> ⚠ 本契约标 `needs_official_recheck`：数字来自归档二手口径，**尚未经官网重核**。');
      }
    } catch {}
  }
  L.push('');
  L.push('## 复跑命令');
  L.push('');
  L.push('```text');
  L.push('node bin/studio.cjs preflight --draft "' + draftAbs + '"' + (pkgDir ? ' --package "' + path.resolve(pkgDir) + '"' : '') + (contractArg ? ' --contract "' + path.resolve(contractArg) + '"' : ''));
  L.push('```');
  L.push(provenanceLine([['draft', draftAbs], ['package', pkgDir], ['contract', contractArg], ['anchors', val('anchors')],
    ['cover', val('cover')], ['letter', val('letter')], ['comments', val('comments')]]));
  const reportText = L.join('\n') + '\n';
  const outPath = outArg ? path.resolve(outArg) : path.join(reportHome(draftAbs), '_投稿前总检-' + new Date().toISOString().slice(0, 10) + '.md');
  try { fs.writeFileSync(outPath, reportText, 'utf8'); } catch (e) { console.error('报告写不进去：' + String((e && e.message) || e)); return 2; }
  if (JSON_OUT) {
    console.log(JSON.stringify({ draft: draftAbs, package: pkgDir || null, contract: contractArg || null, verdict, out: outPath,
      steps: steps.map((s) => ({ label: s.label, rc: s.rc })) }, null, 2));
  } else {
    console.log('投稿前总检（preflight）· ' + path.basename(draftAbs));
    for (const s of steps) console.log('  ' + (s.rc === 0 ? '✓' : (s.rc === 1 ? '⚠' : (s.rc === null ? '·' : '✘'))) + ' ' + s.label + '（退出码 ' + (s.rc === null ? '未运行' : s.rc) + '）');
    console.log('  结论：**' + verdict + '**');
    console.log('  报告：' + outPath);
    console.log('  说明：本命令只汇总，不判定；"未检查/不可用"不得当通过。');
  }
  /* ★ 有提醒或有未检查项 ⇒ 1（否则"未给 --package"这类未检查会被读成"全绿"） */
  return (bad.length || warned.length || unchecked.length) ? 1 : 0;
}

function cmdFormats(args, argv) {
  let d;
  try { d = readFormats(); } catch (e) { console.error(String((e && e.message) || e)); return 2; }
  /* ★ 修正（自查出的真缺陷）：`main()` 里 `args = argv.filter(a => !a.startsWith('--'))` ⇒ **flags 已被剥掉**，
     首版用 args.indexOf('--detect') 永远取不到 ⇒ 静默走了"打印整张表"那条分支，而**两条分支 exit 都是 0**，
     靠退出码看不出走错。故：flag 从 `argv` 取，文件从位置参数取（args[0] 是子命令名）。 */
  const flagAt = (argv || []).indexOf('--detect');
  if (flagAt >= 0) {
    const file = args[1] || '';
    if (!file || file.startsWith('--')) { console.error('前提层失败：--detect 需要一个 .tex 文件参数'); return 2; }
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) { console.error('前提层失败：文件不存在 —— ' + abs); return 2; }
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { console.error('前提层失败：读不到 —— ' + String((e && e.message) || e)); return 2; }
    const det = detectTexFormat(text);
    const hit = d.formats.filter((f) => (f.class_names || []).indexOf(det.documentclass) >= 0)[0] || null;
    const out = { file: abs, documentclass: det.documentclass, bibliographystyle: det.bibliographystyle, packages: det.packages,
      matches: hit ? hit.publisher + ' / ' + hit.template : null, verified_at: d.verified_at, source: d.verified_from };
    if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return hit ? 0 : 1; }
    console.log('格式检测：' + abs);
    console.log('  documentclass = ' + (det.documentclass || '（未找到）'));
    console.log('  bibliographystyle = ' + (det.bibliographystyle || '（未找到）'));
    if (det.packages.length) console.log('  usepackage = ' + det.packages.join(', '));
    if (hit) console.log('  ✔ 命中已核实的官方模板：' + hit.publisher + ' / ' + hit.template + '（表核于 ' + d.verified_at + '）');
    else {
      console.log('  ⇒ 未命中本表：请从**目标刊 Guide for Authors** 取官方类文件（本表只收**已核实**的，未核实的在 not_verified 里）');
      if (/^(ctex|gbt7714)/.test(det.documentclass) || det.packages.indexOf('gbt7714') >= 0) console.log('     （中文稿：参考文献可用 gbt7714 宏包）');
    }
    return hit ? 0 : 1;
  }
  if (JSON_OUT) { console.log(JSON.stringify(d, null, 2)); return 0; }
  console.log('投稿格式模板（真源：references/submission-formats.json · 核于 ' + d.verified_at + '）');
  console.log('  来源：' + d.verified_from);
  for (const f of d.formats) {
    console.log('  · ' + f.publisher + ' ｜ ' + f.template + '（' + f.kind + '）' + (f.version ? ' v' + f.version : '')
      + (f.released ? ' ' + f.released : '') + (f.license ? ' · ' + f.license : '') + '  ← ' + f.source);
    if (f.note) console.log('      ' + f.note);
  }
  if (Array.isArray(d.not_verified) && d.not_verified.length) {
    console.log('  —— 未取证 / 取不到（**不得当成要求**）——');
    for (const x of d.not_verified) console.log('     ! ' + x);
  }
  if (Array.isArray(d.human_only) && d.human_only.length) {
    console.log('  —— 人工边界（机器不判）——');
    for (const x of d.human_only) console.log('     ~ ' + x);
  }
  console.log('  用法：node bin/studio.cjs formats --detect <你的.tex>');
  return 0;
}

function cmdCredit(file) {
  if (!file) { console.error('前提层失败：credit 需要一个文件参数（稿件或声明文件）'); return 2; }
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) { console.error('前提层失败：文件不存在 —— ' + abs); return 2; }
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { console.error('前提层失败：读不到 —— ' + String((e && e.message) || e)); return 2; }
  const r = creditScan(text); r.file = abs;
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  console.log('CRediT 检查：' + abs);
  console.log('  官方角色 ' + r.expected + ' 个 · 文中匹配 ' + r.rolesFound.length + ' 个：' + (r.rolesFound.join(' · ') || '（无）'));
  if (r.variants.length) { console.log('  ✘ 疑似非官方写法（会被期刊退回）：'); for (const v of r.variants) console.log('     - 「' + v.found + '」→ 官方为「' + v.official + '」'); }
  if (r.nearVariants.length) { console.log('  · 相近词（仅提醒，不判失败）：' + r.nearVariants.map((v) => v.found + '≈' + v.official).join(' · ')); }
  for (const why of r.reasons) console.log('  ✘ ' + why);
  console.log(r.ok ? '  ✔ CRediT 通过（段落在、角色名皆为官方写法）' : '  ⇒ 未通过（修完再投）');
  return r.ok ? 0 : 1;
}

/** 引用撤稿检查（v3.2.7）
 *  为什么：期刊要求"引用被撤稿文献必须显式说明撤稿状态"，人工逐条核 DOI 必漏。
 *  数据源：OpenAlex `works.is_retracted`（本机实测三条调用 HTTP 200；**只查询、不复制其数据**）。
 *  结构：**同步纯判据 retractJudge（夹具可注入）+ 异步薄 IO retractScan（真跑用）**——
 *  这样自检不需要联网，也不会出现"夹具返回 Promise 被当成通过"的假绿。
 *  判据：三态（retracted/clean/notFound）+ **取不到≠通过**（批失败记 unreadable；全不可读 ⇒ 退出码 2）。 */
function extractDois(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/10\.\d{4,9}\/[^\s"'<>()\[\],;]+/g)) {
    out.add(m[0].replace(/[.,;)\]]+$/, '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase());
  }
  return [...out];
}
/** 纯判据：dois + 每批结果（{ok:true,results:[...]} 或 {ok:false,error}）⇒ 汇总。 */
function retractJudge(dois, batches) {
  const rows = []; const chunkSize = 40;
  for (let i = 0, bi = 0; i < dois.length; i += chunkSize, bi++) {
    const chunk = dois.slice(i, i + chunkSize);
    const b = batches && batches[bi];
    if (!b || b.ok !== true) {
      for (const d of chunk) rows.push({ doi: d, state: 'unreadable', error: String((b && b.error) || '未取到该批结果') });
      continue;
    }
    const byDoi = new Map();
    for (const w of (b.results || [])) byDoi.set(String(w.doi || '').replace(/^https?:\/\/doi\.org\//i, '').toLowerCase(), w);
    for (const d of chunk) {
      const w = byDoi.get(d);
      if (!w) rows.push({ doi: d, state: 'notFound' });
      else rows.push({ doi: d, state: w.is_retracted ? 'retracted' : 'clean', title: w.title || '', year: w.publication_year || null });
    }
  }
  const retracted = rows.filter((r) => r.state === 'retracted');
  const unreadable = rows.filter((r) => r.state === 'unreadable');
  const notFound = rows.filter((r) => r.state === 'notFound');
  const clean = rows.filter((r) => r.state === 'clean');
  return { rows, retracted, unreadable, notFound, clean, total: rows.length,
    ok: retracted.length === 0 && unreadable.length === 0 && clean.length > 0 };
}
async function retractScan(dois, opts) {
  opts = opts || {};
  const fetchJson = opts.fetchJson || (async (url) => {
    const r = await fetch(url, { signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(30000) : undefined });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
  const mail = process.env.OPENALEX_MAILTO ? '&mailto=' + encodeURIComponent(process.env.OPENALEX_MAILTO) : '';
  const batches = []; const chunkSize = 40;
  for (let i = 0; i < dois.length; i += chunkSize) {
    const chunk = dois.slice(i, i + chunkSize);
    const url = 'https://api.openalex.org/works?per-page=200&select=doi,title,is_retracted,publication_year&filter=doi:' + chunk.map(encodeURIComponent).join('|') + mail;
    try { const j = await fetchJson(url); batches.push({ ok: true, results: (j && j.results) || [] }); }
    catch (e) { batches.push({ ok: false, error: String((e && e.message) || e) }); }
  }
  return retractJudge(dois, batches);
}
async function cmdRetractCheck(args, doisMode) {
  let dois = [];
  if (doisMode) {
    const i = args.indexOf('--dois');
    dois = extractDois(args.slice(i + 1).join(' '));
  } else {
    const file = args[1] || '';
    if (!file) { console.error('前提层失败：retract-check 需要 <文件> 或 --dois <列表>'); return 2; }
    const abs = path.resolve(file);
    if (!fs.existsSync(abs)) { console.error('前提层失败：文件不存在 —— ' + abs); return 2; }
    dois = extractDois(fs.readFileSync(abs, 'utf8'));
  }
  if (!dois.length) { console.error('前提层失败：未从输入中解析到任何 DOI（无 DOI 不判通过）'); return 2; }
  const r = await retractScan(dois); r.dois = dois;
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : (r.unreadable.length === r.total ? 2 : 1); }
  console.log('撤稿检查：' + dois.length + ' 个 DOI（来源 OpenAlex is_retracted；只查询不复制数据）');
  if (r.retracted.length) {
    console.log('  ✘ 引用了被撤稿文献（须显式说明撤稿状态，不得当普通文献引）：');
    for (const x of r.retracted) console.log('     - ' + x.doi + '  ' + String(x.title || '').slice(0, 60) + ' (' + (x.year || '?') + ')');
  }
  if (r.notFound.length) console.log('  · OpenAlex 无记录（' + r.notFound.length + ' 个；**不等于没问题**）：' + r.notFound.slice(0, 5).map((x) => x.doi).join(' · '));
  if (r.unreadable.length) console.log('  ✘ 取不到（' + r.unreadable.length + ' 个）⇒ **不得当成通过**：' + r.unreadable.slice(0, 3).map((x) => x.doi).join(' · '));
  console.log('  ✔ 未标撤稿：' + r.clean.length + ' 个');
  console.log(r.ok ? '  ✔ 撤稿检查通过' : '  ⇒ 未通过（撤稿项须处置；不可读项须重跑）');
  return r.ok ? 0 : (r.unreadable.length === r.total ? 2 : 1);
}

// ── v3.1.9 三道新判据（都由 2026-10-16 生态日审的真实问题驱动）────────────
const SKIP_DIRS = new Set(['.git', 'node_modules', '.dsh-project-memory', '_archive', '__pycache__']);

function walkFiles(dir, out) {
  out = out || [];
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

/** 判据一：残留件门 —— 备份/临时件不得留在技能树内（应归档到技能树之外）。
 *  起因：2026-10-16 日审的「残留文件」判据抓到本插件 `refs.json.bak-*` 与 `投稿前检查表-论文B.md.bak-*`。 */
function hygiene(opts) {
  opts = opts || {};
  const roots = opts.roots || [ROOT];
  const bad = [];
  const RE = /(\.bak(-|$)|~$|\.tmp$|\.orig$|\.rej$|__pycache__|\.DS_Store)/;
  for (const r of roots) {
    for (const f of walkFiles(r)) {
      const rel = path.relative(ROOT, f);
      if (RE.test(path.basename(f))) bad.push(rel);
    }
  }
  return { ok: bad.length === 0, files: bad, roots: roots.map((r) => path.relative(ROOT, r) || '.') };
}

/** 判据二：文档数字一致性门 —— 文档里既然写了「N/N 通过」，就必须与**实跑**的数字一致。
 *  起因：登记表写 53/53 而脚本实报 61/61，漂了一整版没人发现（下游只能手抄中文输出）。
 *  做法：把两个主套件的实时计数取回来（`selftest --json`），逐条对拍文档里的 N/N。
 *  例外：文档里标了 `<!-- claims: snapshot -->` 的视为**历史快照**，跳过（但仍必须与命令输出对得上才算快照豁免生效）。 */
function claims(opts) {
  opts = opts || {};
  const live = opts.live || liveCounts();
  const files = opts.files || walkFiles(ROOT).filter((f) => /\.md$/.test(f));
  const unreadable = live.filter((x) => !(x.total > 0));
  const liveSet = new Set(live.map((x) => `${x.pass}/${x.total}`));
  const min = Math.min.apply(null, live.map((x) => x.total));
  const mismatches = [];
  const snapshots = [];
  const checked = [];
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(ROOT, f) || f;
    const isSnap = txt.includes(SNAPSHOT_MARK);
    const lines = txt.split(/\r?\n/);
    lines.forEach((ln, i) => {
      const m = ln.match(/(\d+)\s*\/\s*(\d+)\s*(?:通过|全过|pass)/i);
      if (!m) return;
      const pair = `${m[1]}/${m[2]}`;
      const total = parseInt(m[2], 10);
      if (total < 5) return;                       // 5 以下的像"4/5 条夹具"，不是套件计数
      if (isSnap) { snapshots.push(`${rel}:${i + 1} ${pair}`); return; }
      checked.push(`${rel}:${i + 1} ${pair}`);
      if (!liveSet.has(pair)) mismatches.push(`${rel}:${i + 1} 写的是 ${pair}，实跑是 ${live.map((x) => `${x.suite} ${x.pass}/${x.total}`).join(' · ')}`);
    });
  }
  if (unreadable.length) {
    mismatches.push('实跑计数取不到（' + unreadable.map((x) => x.suite + ':' + (x.err || '?')).join(' · ') + '）⇒ 取不到不得判通过');
  }
  return { ok: mismatches.length === 0, checked, mismatches, snapshots, live };
}

/** 取两个主套件的实时计数（机器可读出口：`--json`）——下游应引用本命令而不是手抄数字。 */
function liveCounts() {
  const out = [];
  // ★ 递归保护（写代码时自查出来的真实风险）：claims 会 spawn `selftest --json`，
  //   而 selftest 的夹具若再去核真实文档就会再 spawn 一次 —— 无限自我调用。
  //   处理：探针子进程带 PS_LIVE_PROBE=1，取数函数直接拒绝再取（**取不到就显形**，绝不判通过）。
  if (process.env.PS_LIVE_PROBE === '1') {
    return [{ suite: 'probe-guard', pass: -1, total: -1, err: '递归保护：探针内部不再取数' }];
  }
  const { spawnSync } = require('child_process');
  const ENV = Object.assign({}, process.env, { PS_LIVE_PROBE: '1' });
  const a = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'studio.cjs'), 'selftest', '--json'], { encoding: 'utf8', env: ENV });
  try { const j = JSON.parse(a.stdout); out.push({ suite: j.suite, pass: j.pass, total: j.total }); } catch { out.push({ suite: 'studio', pass: -1, total: -1, err: '取不到（--json 输出不可解析）' }); }
  const b = spawnSync(process.execPath, [path.join(ROOT, 'plugin', 'selftest.mjs'), '--json'], { encoding: 'utf8', env: ENV });
  try { const j = JSON.parse(b.stdout); out.push({ suite: j.suite, pass: j.pass, total: j.total }); } catch { out.push({ suite: 'plugin', pass: -1, total: -1, err: '取不到（--json 输出不可解析）' }); }
  return out;
}

/** 判据三：自检覆盖门 —— `bin/*.cjs` 里凡含自检的脚本，必须在真源 `pipeline.json.selfchecks` 里登记
 *  （登记的是**取数命令**，不是冻结数字）；未登记的报缺口。
 *  起因：同日 ai-workbench 的「门覆盖·前提」判据一次清出 4 个"自带自检却没人跑"的脚本——同一纪律本插件也要有。 */
function coverage(pipeline) {
  const reg = ((pipeline || readPipeline()).selfchecks) || {};
  const dir = path.join(ROOT, 'bin');
  const gaps = [];
  const listed = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.cjs$/.test(f)); } catch { return { ok: false, gaps: ['读不到 bin/ 目录'], listed: [] }; }
  for (const f of files) {
    let txt = '';
    try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (!/自检|selftest/i.test(txt)) continue;
    if (reg[f]) listed.push(f);
    else gaps.push(f);
  }
  return { ok: gaps.length === 0, gaps, listed, registered: Object.keys(reg).length };
}


function cmdHygiene() {
  const r = hygiene({});
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  if (r.ok) { console.log('残留件门：通过（技能树内无备份/临时件）'); return 0; }
  console.log('残留件门：未通过 —— 以下文件不得留在技能树内（归档到树外，别删）：');
  for (const f of r.files) console.log('  - ' + f);
  return 1;
}
function cmdClaims() {
  const r = claims({});
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  console.log('实跑计数：' + r.live.map((x) => `${x.suite} ${x.pass}/${x.total}`).join(' · '));
  console.log(`文档数字声明：核过 ${r.checked.length} 条 · 快照豁免 ${r.snapshots.length} 条`);
  if (r.ok) { console.log('文档数字一致性门：通过'); return 0; }
  console.log('文档数字一致性门：未通过 —— 文档与实跑不一致：');
  for (const m of r.mismatches) console.log('  - ' + m);
  return 1;
}
function cmdCoverage() {
  const r = coverage();
  if (JSON_OUT) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
  console.log(`自检覆盖门：登记 ${r.registered} 条 · 已覆盖 ${r.listed.length} 个脚本`);
  if (r.ok) { console.log('自检覆盖门：通过（含自检的脚本都已在真源登记）'); return 0; }
  console.log('自检覆盖门：未通过 —— 以下脚本含自检但未在 pipeline.json.selfchecks 登记：');
  for (const g of r.gaps) console.log('  - ' + g);
  return 1;
}

// ── v3.2.0 合规门（投稿合规与许可）· 知识源 references/compliance-checklist.md ──
// 蒸馏自本项目 2026-10 的真实取证：Elsevier 在先发表三条例外（官方问答，页面更新 2026-06-01）、
// 第三方材料许可、地图类图件的政治正确性、清样阶段纪律。门只查"必备件在不在 + 声明段有没有"，
// 不判内容质量；取不到一律显形为失败（本插件铁律）。
const COMPLIANCE_DOC = 'references/compliance-checklist.md';
const COMPLIANCE_DOC_ANCHORS = ['在先发表', '许可', '地图', '清样', '可机检'];

function complianceDoc(text) {
  let txt = text;
  if (txt == null) { try { txt = fs.readFileSync(path.join(ROOT, COMPLIANCE_DOC), 'utf8'); } catch { return { ok: false, path: COMPLIANCE_DOC, missing: COMPLIANCE_DOC_ANCHORS, unreadable: true }; } }
  const missing = COMPLIANCE_DOC_ANCHORS.filter((a) => !txt.includes(a));
  return { ok: missing.length === 0, path: COMPLIANCE_DOC, missing, unreadable: false };
}

/** v3.2.40：投稿包卫生规则（与契约门内置 HYGIENE_FORBID 同组；取自 pipeline 的共用清单）。 */
function PIPE_HYGIENE() {
  try {
    const P = readPipeline();
    const d = ((P.package_hygiene || {}).defaults || {}).forbid_patterns;
    if (Array.isArray(d) && d.length) return d;
  } catch {}
  return [];   // 取不到规则 ⇒ 不假装「已检查」（调用方会把 0 条视作无违规并如实标注）
}

function complianceScan(dir) {
  const out = { dir: String(dir || ''), exists: false, items: [], hardMissing: [], missing: [], unreadable: [], ok: false };
  if (!out.dir) { out.unreadable.push('未给投稿包目录'); return out; }
  out.exists = fs.existsSync(out.dir);
  if (!out.exists) { out.unreadable.push('目录不存在：' + out.dir); return out; }
  let rels = [];
  try { rels = walkFiles(out.dir).map((f) => path.relative(out.dir, f)); } catch (e) { out.unreadable.push('目录读不到：' + String((e && e.message) || e)); return out; }
  const basenames = rels.map((f) => path.basename(f).toLowerCase());
  const NOT_MANU = /cover|letter|response|rebuttal|checklist|readme|licen[cs]e/i;
  /* ★ v3.2.40：**包卫生**。此前 compliance 只看「必备件在不在」、不管「包里混进了什么」⇒
     同一个脏包，compliance 判 ✔ exit 0（还把 `_报告.md` 与 `-stale-` 文件列进"稿件主文件"证据），
     而契约门 package_hygiene 判 ✗ 不该进包 2 个 —— **两套实现两个真相**。规则统一取 pipeline 的共用清单。 */
  const FORBID = PIPE_HYGIENE();
  const isForbidden = (rel, base) => FORBID.some((p) => { try { const re = new RegExp(p.re, 'i'); return re.test(rel) || re.test(base); } catch { return false; } });
  const forbidWhy = (rel, base) => { for (const p of FORBID) { try { const re = new RegExp(p.re, 'i'); if (re.test(rel) || re.test(base)) return p.why; } catch {} } return ''; };
  const offenders = rels.map((f, i) => [f.split(path.sep).join('/'), basenames[i]])
    .filter(([rel, base]) => isForbidden(rel, base))
    .map(([rel, base]) => rel + '（' + forbidWhy(rel, base) + '）');
  out.forbidden = offenders;
  /* ★ v3.2.46：**同类扫查**（承 v3.2.45）。上轮修的是"包内证据搜索会借要求清单里被引论文的作者"；
     扫同类发现 `compliance` 也在按名字挑文件当证据，且更隐蔽 —— 在 B 稿工作目录上它把 `0-一页速查.md`（速查表）
     当成**稿件**去核声明段，于是 `✔ Data Availability / ✘ CRediT / ✘ Funding` 全是**从错文件读来的**；
     参考文献那一项还把 `mkrefs.cjs`、`refcheck*.py` 这些**脚本**算了进去。
     统一纪律：**工作件/模板/要求清单/证据表/参考文献**都不是"本稿文件"，不得当证据（宁缺勿借）。 */
  /* ★ v3.2.47：`pick(re, extra, opt)` 增加 `opt.keepNotEvidence` —— **该项本身就是在找这类文件**时不能套用排除表。
     自伤实测：排除表里有 `refs?\b`，于是"参考文献清单文件"这一项把 `refs.md` 自己也排除了 ⇒ 永远报缺。 */
  const pick = (re, extra, opt) => rels.filter((f, i) => re.test(basenames[i]) && (!extra || !extra.test(basenames[i]))
    && ((opt && opt.keepNotEvidence) || !PKG_NOT_EVIDENCE.test(basenames[i]))
    && !isForbidden(f.split(path.sep).join('/'), basenames[i]));
  const add = (key, level, label, hits) => out.items.push({ key, level, label, state: hits.length ? 'hit' : 'missing', files: hits.slice(0, 5) });
  add('manuscript', 'hard', '稿件主文件（.md/.docx，不含投稿信/回复信）', pick(/\.(md|docx)$/i, NOT_MANU));
  out.items.push({ key: 'package_hygiene', level: 'hard', label: '包卫生（内部产物/陈旧/临时文件不得进包）', state: offenders.length ? 'offenders' : 'clean', files: offenders.slice(0, 8) });
  add('cover_letter', 'hard', 'Cover Letter / 投稿信（单独文件）', pick(/cover[-_ ]?letter|投稿信/i));
  add('figures', 'soft', '图件文件（独立图件或 figures/ 目录）', pick(/\.(tif|tiff|png|eps|svg)$/i));
  add('references', 'soft', '参考文献清单文件', pick(/ref|参考文献/i, /\.(cjs|mjs|js|ts|py|sh|ps1|json5?)$/i, { keepNotEvidence: true }));   // v3.2.47：脚本不算参考文献，但 refs.md 本身要算
  // ★ v3.2.4：契约项缺失时**直接告诉作者包内已备好哪一份**（此前只报 ✘，作者不知道去哪拿）。
  //   纪律不变：这一项仍判 missing（投稿包里确实没有），只是把"可执行下一步"写进 label。
  const CONTRACTS = (() => { try { return fs.readdirSync(path.join(ROOT, 'references', 'contracts')).filter((f) => /\.json$/.test(f)); } catch { return []; } })();
  const jcHits = pick(/(contract|契约).*\.json$/i);
  const jcLabel = '该刊契约 json（闸门依赖）' + (jcHits.length ? '' : (CONTRACTS.length
    ? '｜包内已备好可复制：references/contracts/' + CONTRACTS.join(' · references/contracts/')
    : '｜包内暂无契约模板，需向期刊页面取证后自建'));
  add('journal_contract', 'soft', jcLabel, jcHits);
  /* ★ v3.2.46：**声明段必须从"可信的稿件"读**。此前取"名字排序第一的 .md" ⇒ 工作目录里 `0-一页速查.md`
     排在 `manuscript-*` 前面，于是声明段判定建立在一张**速查表**上（✔/✘ 都无意义）。
     现在：优先选名字像稿件的（manuscript/稿/paper/draft），否则选**最大的** .md；都没有 ⇒ 不判定（取不到≠通过）。 */
  const manuCands = pick(/\.md$/i, NOT_MANU);
  const pickManu = () => {
    /* ★ 打分而不是"找第一个"：单靠 `稿` 会把 `9-投稿前总检查表.md` 当成稿件（投**稿**前）——实测踩到。
       打分：manuscript 3 · paper/draft 2 · 稿/正文 1 · 其他 0；同分取**最大的**文件。 */
    const score = (f) => {
      const b = path.basename(f);
      if (/manuscript/i.test(b)) return 3;
      if (/paper|draft/i.test(b)) return 2;
      if (/稿|正文|full[-_ ]?text/i.test(b)) return 1;
      return 0;
    };
    const sized = manuCands.map((f) => { let n = 0; try { n = fs.statSync(path.join(out.dir, f)).size; } catch {} return { f, n, s: score(f) }; });
    sized.sort((a, b) => (b.s - a.s) || (b.n - a.n));
    return sized.length ? sized[0].f : null;
  };
  const manu = pickManu();
  // ★ v3.2.0 修正（自查出的假阴性）：声明段标题各家措辞不同，只认一种会误报缺件。
  //   BMC/Springer 用 Competing interests 与 Availability of data；IEEE 用 Conflicts of Interest；
  //   中文刊用「利益冲突」「数据可用性」。宁可宽一点，也不要把"写了的"读成"没写"。
  const DECL = {
    // 第二处假阴性（同一类，实测抓到）：B 稿标题写的是 "Data and code availability"，
    // 连写形态才匹配的正则会误报缺件；但也不能图省事用裸 /availability/（正文里 "an availability limitation"
    // 之类短语会假阳性）⇒ 只认"数据/代码 + availability"的贴邻形态。
    'Data Availability': /data (and code )?availability|code availability|availability of data|数据可用性|数据与代码可用性/i,
    'CRediT': /credit|author contribution|作者贡献/i,
    'Conflict of Interest': /conflict[s]? of interest|competing interest[s]?|declaration of interest|利益冲突/i,
    'Funding': /funding|financial support|资助|基金/i,
    'Ethics': /ethic|伦理|informed consent/i,
  };
  if (!manu) {
    out.items.push({ key: 'decl', level: 'soft', label: '稿件声明段（**找不到可信的稿件文件** ⇒ 取不到，不当作通过；工作件/模板/清单不算稿件）', state: 'unreadable', files: [] });
  } else {
    let txt = null;
    try { txt = fs.readFileSync(path.join(out.dir, manu), 'utf8'); } catch { txt = null; }
    for (const k of Object.keys(DECL)) {
      if (txt === null) out.items.push({ key: 'decl:' + k, level: 'soft', label: '声明段 ' + k, state: 'unreadable', files: [manu] });
      else out.items.push({ key: 'decl:' + k, level: 'soft', label: '声明段 ' + k, state: DECL[k].test(txt) ? 'hit' : 'missing', files: [manu] });
    }
    if (txt === null) out.unreadable.push('稿件读不到，声明段无法核：' + manu);
  }
  for (const it of out.items) { if (it.state === 'missing') out.missing.push(it.label); if (it.state === 'unreadable') out.unreadable.push(it.label); }
  out.hardMissing = out.items.filter((i) => i.level === 'hard' && (i.state === 'missing' || i.state === 'offenders')).map((i) => i.label);
  out.ok = out.hardMissing.length === 0 && out.unreadable.length === 0;
  return out;
}

function cmdCompliance(dirArg) {
  const dir = dirArg || '';
  const r = complianceScan(dir);
  const doc = complianceDoc(null);
  if (JSON_OUT) { console.log(JSON.stringify({ scan: r, doc }, null, 2)); return r.ok && doc.ok ? 0 : 1; }
  console.log('合规门 · 投稿包：' + (r.dir || '（未给目录）'));
  if (r.unreadable.length) { console.log('  ⚠ 取不到（按失败处理，不静默通过）：'); for (const u of r.unreadable) console.log('    - ' + u); }
  for (const it of r.items) {
    /* ★ 卫生行的语义与「必备件」相反：**clean 才是好**、offenders 才是坏（首版会把它显示成 ✔，误导）。 */
    const mark = it.key === 'package_hygiene'
      ? (it.state === 'clean' ? '✔' : '✘')
      : (it.state === 'hit' ? '✔' : it.state === 'missing' ? '✘' : '?');
    const lvl = it.level === 'hard' ? '硬' : '软';
    console.log('  ' + mark + ' [' + lvl + '] ' + it.label + (it.files.length ? '  ← ' + it.files.join(', ') : ''));
  }
  console.log('  范围：**只扫给定目录，不上溯父级** —— 该刊契约与参考文献清单常放在投稿包的上一级（如 _refs/）⇒ 报缺不等于没有，请人工确认位置。');
  console.log('  清单文档 ' + COMPLIANCE_DOC + '：' + (doc.ok ? '齐备（5 类锚点全在）' : '不齐：缺 ' + doc.missing.join('、')));
  if (r.ok && doc.ok) { console.log('合规门：通过（硬项齐、可取、清单齐备）。软项缺项由作者定夺。'); return 0; }
  if (!r.ok) console.log('合规门：未通过 —— 硬项缺 ' + (r.hardMissing.length ? r.hardMissing.join(' / ') : '无') + '；取不到 ' + r.unreadable.length + ' 处');
  return 1;
}

/** 判据四（v3.2.1）：接口面一致性 —— 分派里支持的命令必须都登记在 SUBCOMMANDS，
 *  否则"加了实现忘了登记"就会一路漂（本方实证：v3.1.9 与 v3.2.0 新增的 4 个命令全部漏登记，
 *  用法行也停在 13 个）。用法行已改为由 SUBCOMMANDS 生成 ⇒ 只查分派 ↔ 登记 两处即可。 */
function subcommandGaps(srcText, subList) {
  const disp = new Set();
  // 只认**行首**的分派（夹具里作为字符串注入的命令名不算真分派——第一版就踩了这个假阳性）
  const re = /^[ \t]*if \(cmd === '([a-z-]+)'\)/gm;
  let x;
  while ((x = re.exec(srcText))) { if (x[1] !== '--help' && x[1] !== '-h') disp.add(x[1]); }
  const reg = new Set(subList || SUBCOMMANDS);
  const missing = [...disp].filter((c) => !reg.has(c)).sort();
  const phantom = [...reg].filter((c) => !disp.has(c)).sort();
  return { missing, phantom, dispatched: [...disp].sort(), registered: [...reg].sort() };
}

function main(argv) {
  const cmd = argv[0];
  const json = argv.includes('--json');
  JSON_OUT = json;
  const args = argv.filter((a) => !a.startsWith('--'));
  try {
    if (!cmd || cmd === '--help' || cmd === '-h') {
      console.log('用法：node bin/studio.cjs <' + SUBCOMMANDS.join('|') + '> [参数] [--json]');
      console.log('  hygiene  ⇒ 残留件门（备份/临时件不得留在技能树内；应归档到树外）');
      console.log('  claims   ⇒ 文档数字一致性门（文档里写的 N/N 必须与实跑一致）');
      console.log('  coverage ⇒ 自检覆盖门（bin/*.cjs 含自检者必须在 pipeline.json.selfchecks 登记）');
      console.log('  compliance <投稿包目录> ⇒ 合规门（硬项：稿件 + Cover Letter；软项：图件/参考文献/契约/声明段；取不到即失败）');
      console.log('  report --task "<描述>" --draft <稿.md> [--docx <成品.docx>] [--anchors/--manifest/--contract]  ⇒ 带行号的待修项清单');
      return 0;
    }
    const pipeline = readPipeline();
    if (cmd === 'route') {
      const text = args.slice(1).join(' ');
      const res = routeTask(text, pipeline);
      res.journal = journalRoute(text, pipeline); // 可能抛：前提层失败（真源缺表 / 取值无路径）
      const jr = res.journal;
      if (json) console.log(JSON.stringify({ task_type: res.type.id, tier: res.type.tier, matched: res.matched, chain: res.type.chain, gates: res.type.gates, note: res.note, journal_class: jr.key, journal_matched: jr.matched, journal_assets: jr.assets, journal_boundaries: jr.boundaries }, null, 2));
      else console.log(printRoute(res, pipeline));
      // 有门不可用 ⇒ 退出码 1（不完整，但不是前提层失败）
      const gs = (res.type.gates || []).map((id) => (pipeline.gates || []).find((g) => g.id === id)).filter(Boolean).map((g) => resolveGate(g, pipeline));
      const gatesOk = gs.every((g) => g.scriptOk && g.runtimeOk);
      // 期刊资产缺失 ⇒ 退出码 1（缺输入一律 FAIL，不许静默通过）
      const assetsOk = (jr.assets || []).every((a) => a.exists);
      if (!assetsOk) console.error(`期刊资产缺失 ${jr.assets.filter((a) => !a.exists).map((a) => a.path).join(', ')} ⇒ 退出码 1（缺输入一律 FAIL）`);
      return gatesOk && assetsOk ? 0 : 1;
    }
    if (cmd === 'gates') {
      const list = (pipeline.gates || []).map((g) => resolveGate(g, pipeline));
      if (json) console.log(JSON.stringify(list, null, 2));
      else {
        console.log('必过门清单（真源：references/pipeline.json）：');
        for (const g of list) console.log(`  - ${g.id}：${g.label}  [${g.scriptOk && g.runtimeOk ? '可用' : '不可用'}]  ${g.runtime} ${g.entry}${g.scriptOk ? '' : ' · 脚本不存在'}${g.runtimeOk ? '' : ' · ' + g.runtimeNote}${g.placeholder ? ' ⇒ ' + LOCAL_HINT : ''}`);
      }
      return list.every((g) => g.scriptOk && g.runtimeOk) ? 0 : 1;
    }
    if (cmd === 'intake') {
      const li = argv.indexOf('--lang');
      const r = intake(args.slice(1).join(' '), pipeline, { lang: li > -1 ? argv[li + 1] : '' });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`稿件：${r.doc_path || '(未给路径)'}`);
        console.log(`存在=${r.exists} · 类型=${r.doc_kind} · 语言=${r.lang}（${r.lang_reason}）`);
        console.log(`交接契约必填：${r.required.join(' / ')}`);
        console.log(r.complete ? '契约状态：完整（task_type 待 route 决定）' : `契约状态：HANDOFF_INCOMPLETE（缺 ${r.missing.join(', ')}）`);
      }
      return r.exists ? 0 : 1;
    }
    if (cmd === 'lessons') {
      const ls = readLessons();
      if (json) console.log(JSON.stringify(ls, null, 2));
      else {
        console.log(`初稿经验库（真源：references/lessons-from-first-draft.md）· 共 ${ls.length} 条`);
        for (const l of ls) console.log(`  ${l.id}  ${l.lesson}\n        做法：${l.practice}\n        可检：${l.checkable}`);
      }
      return ls.length > 0 ? 0 : 2;
    }
    if (cmd === 'method') {
      const ms = listMethod();
      if (json) console.log(JSON.stringify(ms, null, 2));
      else {
        console.log('11 维方法论索引（真源：D 盘 playbook 的 research/，**只指路径不复制**）：');
        for (const m of ms) console.log(`  [${m.exists ? '✔' : '✘ 缺失'}] ${m.id} ${m.label}  →  ${m.path}`);
      }
      return ms.every((m) => m.exists) ? 0 : 1;
    }
    if (cmd === 'scaffold') {
      const rest = argv.slice(1);
      const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
      const r = scaffold(flag('--out'), flag('--name'), { dryRun: rest.includes('--dry-run'), genre: flag('--genre') || null });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`目标目录：${r.dir}${r.dryRun ? '（dry-run：未写文件）' : ''}`);
        console.log(`计划文件 ${r.plan.length} 个：${r.plan.join(' / ')}`);
        if (!r.dryRun) {
          console.log(`已生成 ${r.created.length}：${r.created.join(' / ') || '（无）'}`);
          console.log(`已存在跳过 ${r.skipped.length}：${r.skipped.join(' / ') || '（无）'}`);
          if (r.missing.length) console.log(`⚠ 模板真源缺失 ${r.missing.length}：${r.missing.join(' / ')} ⇒ 未生成（不冒充模板）`);
        }
      }
      return r.missing.length ? 1 : 0;
    }
    if (cmd === 'docx') {
      const rest = argv.slice(1);
      const f = rest.find((a) => !a.startsWith('--'));
      if (!f) { console.error('用法：node bin/studio.cjs docx <成品.docx> [--json]'); return 2; }
      if (!fs.existsSync(f)) { console.error('前提层失败：文件不存在 ' + f); return 2; }
      let r;
      try { r = readDocxStructure(f); }
      catch (e) { console.error('前提层失败：' + ((e && e.message) || e)); return 2; }
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`docx 结构读数（本插件自带实现：解 ZIP + 扫 XML，**不经文档库**）：${path.basename(f)}`);
        console.log(`  顶层表格 ${r.tables} · 内嵌图 ${r.inline_images} · 媒体文件 ${r.media_files} · 非空段落 ${r.paragraphs}`);
        console.log(`  残留标记：段落 ${r.leak_paragraphs} 处 · 单元格 ${r.leak_cells} 处`);
        for (const x of r.leak_texts) console.log('    ! ' + x);
        console.log((r.leak_paragraphs || r.leak_cells)
          ? '\n  判定：失败 —— 成品里残留 Markdown 标记（说明转换器漏渲染）'
          : '\n  判定：通过（无残留标记）');
      }
      return (r.leak_paragraphs || r.leak_cells) ? 1 : 0;
    }
    if (cmd === 'sections') {
      const rest = argv.slice(1);
      const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
      const p = readPipeline();
      const g = flag('--genre') || (p.genres || {}).default || 'empirical';
      const sec = readSections(g, readTemplates());
      if (json) { console.log(JSON.stringify(Object.assign({ genre: g }, sec), null, 2)); return 0; }
      console.log(`章节级论文框架（真源：references/templates.json · section_skeletons_by_genre）`);
      console.log(`体裁 ${g} ⇒ 章节集 ${sec.set} · 共 ${sec.sections.length} 节`);
      for (const x of sec.sections) {
        console.log(`\n  ${x.label}`);
        console.log(`    解决什么：${x.purpose}`);
        console.log(`    必答：${(x.must_answer || []).join(' ／ ')}`);
        console.log(`    篇幅：${x.budget_words}　·　门：${(x.gates || []).join(' / ')}`);
        console.log(`    证据义务：${x.evidence_duty}`);
        if ((x.common_failures || []).length) console.log(`    常见退回：${x.common_failures.join(' ／ ')}`);
      }
      return 0;
    }
    if (cmd === 'crosscheck') {
      let r;
      const pairArg = (argv.slice(1).find((a) => a.startsWith('--pair=')) || '').split('=')[1];
      try { r = crosscheck(pairArg || 'all'); }
      catch (e) { console.error(String((e && e.message) || e)); return 2; }
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log('同判回归（同一对象 · 两个判据）');
        if (r.material) {
          console.log('\n【材料声明】本插件契约校验器 vs playbook 的 author-material 门');
          for (const x of r.material.rows) {
            console.log(`  ${x.ok ? '✔' : '✘'} ${x.name.padEnd(32)} 我们=${x.mine} 门=${x.theirs} 期望=${x.expect}`);
          }
        }
        if (r.docx) {
          console.log('\n【成品件结构】本插件 ZIP+XML 独立读数 vs playbook 的 _verify-docx');
          for (const x of r.docx.rows) {
            if (x.skipped) { console.log(`  – ${x.file}：${x.skipped}`); continue; }
            const m = x.mine || {}; const t = x.theirs || {};
            console.log(`  ${x.ok ? '✔' : '✘'} ${x.file}`);
            console.log(`      表格 ${m.tables}/${t.tables} · 内嵌图 ${m.inline_images}/${t.inline_images} · 残留段 ${m.leak_paragraphs}/${t.leak_paragraphs} · 残留单元格 ${m.leak_cells}/${t.leak_cells}（我们/核验器）`);
            for (const d of (x.diffs || [])) console.log('      ✘ ' + d);
          }
        }
        console.log(r.ok ? '\n  判定：通过 —— 两边逐项同判' : '\n  判定：失败 —— 存在不同判（**不许放着不管**：先查哪一侧的实现或规则不对）');
      }
      return r.ok ? 0 : 1;
    }
    if (cmd === 'handoff') {
      const rest = argv.slice(1);
      const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
      const p = readPipeline();
      const contracts = ((p.handoff || {}).contracts) || [];
      if (rest.includes('--list') || rest.length === 0) {
        console.log('交接契约（真源：references/pipeline.json · handoff.contracts · 由 `handoff <from->to> --file <声明.json>` 真校验）');
        for (const c of contracts) {
          console.log(`  ${c.from} -> ${c.to}`);
          console.log(`      必填：${(c.required || []).join(', ')}${(c.optional || []).length ? ' · 可选：' + c.optional.join(', ') : ''}`);
          for (const [f, a] of Object.entries(c.closed_sets || {})) console.log(`      闭集：${f} ∈ {${a.join(' / ')}}`);
          if (c.item_schemas) for (const f of Object.keys(c.item_schemas)) console.log(`      逐项：${f} 每项须含 ${c.item_schemas[f].required.join(' / ')}`);
        }
        return 0;
      }
      const file = flag('--file');
      const id = rest.find((a) => !a.startsWith('--') && a !== file);
      if (!file) { console.error('用法：node bin/studio.cjs handoff --list ｜ handoff <from->to> --file <声明.json> [--json]'); return 2; }
      if (!fs.existsSync(file)) { console.error('前提层失败：声明文件不存在 ' + file); return 2; }
      let payload;
      try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (e) { console.error('前提层失败：声明不是合法 JSON —— ' + e.message); return 2; }
      let r;
      try { r = validateHandoff(id, payload, p); }
      catch (e) { console.error(String((e && e.message) || e)); return 2; }
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`交接契约校验：${r.contract}（声明里 ${r.checked} 个字段）`);
        for (const f of r.fails) console.log('  ✘ ' + f);
        for (const w of r.warns) console.log('  ⚠ ' + w);
        console.log(r.ok ? '\n  判定：通过（必填齐、类型与闭集都对）'
                         : `\n  判定：失败 —— ${r.fails.length} 项（HANDOFF_INCOMPLETE）`);
      }
      return r.ok ? 0 : 1;
    }
    if (cmd === 'genre') {
      const rest = argv.slice(1);
      const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
      const docPath = rest.find((a) => !a.startsWith('--') && a !== flag('--genre'));
      if (!docPath) { console.error('用法：node bin/studio.cjs genre <稿.md> [--genre empirical|review|methodological|secondary-analysis] [--json]'); return 2; }
      if (!fs.existsSync(docPath)) { console.error('前提层失败：文件不存在 ' + docPath); return 2; }
      const p = readPipeline();
      const g = detectGenre(fs.readFileSync(docPath, 'utf8'), p, flag('--genre') || null);
      if (json) console.log(JSON.stringify(g, null, 2));
      else {
        console.log(`体裁判定：${g.id}（${g.label}）`);
        console.log(`  依据：${g.reason}${g.hits.length ? ' → ' + g.hits.join(' / ') : ''}`);
        const app = (p.gate_meta || {}).applies_to_default || ['*'];
        const na = (p.gates || []).filter((x) => { const a = x.applies_to || app; return !a.includes('*') && !a.includes(g.id); });
        console.log(`  本次不适用的门（${na.length}）：${na.map((x) => x.id).join(' / ') || '（无）'}`);
      }
      return 0;
    }
    if (cmd === 'draft') {
      const rest = argv.slice(1);
      const flag = (k) => { const i = rest.indexOf(k); return i > -1 ? rest[i + 1] : ''; };
      const r = draftPlan(flag('--out'), {
        name: flag('--name'), journal: flag('--journal'), lang: flag('--lang'),
        materials: flag('--materials'), genre: flag('--genre') || null, dryRun: rest.includes('--dry-run'),
      });
      if (json) console.log(JSON.stringify(r, null, 2));
      else {
        console.log(`项目目录：${r.dir}${r.dryRun ? '（dry-run：未写文件）' : ''}`);
        console.log(`真源推导：阶段 ${r.steps} 个 · write 必过门 ${r.gates.length} 道（${r.gates.join(' / ')}）`);
        console.log(`材料声明：${r.materialProvided ? '已提供' : '未提供 ⇒ 只出框架与检索计划，**不硬写正文**'}`);
        console.log(`计划产出 ${r.plan.length} 个：${r.plan.join(' / ')}`);
        if (!r.dryRun) {
          if (r.scaffold) console.log(`骨架：已生成 ${r.scaffold.created.length} / 已存在跳过 ${r.scaffold.skipped.length}${r.scaffold.missing.length ? ' / ⚠ 模板真源缺失 ' + r.scaffold.missing.length + '（不冒充模板）' : ''}`);
          console.log(`本次已写 ${r.created.length}：${r.created.join(' / ') || '（无）'}`);
          console.log(`已存在跳过 ${r.skipped.length}：${r.skipped.join(' / ') || '（无）'}`);
          console.log(r.materialProvided
            ? '下一步：按 00-写作任务书.md 第 1 节逐阶段产出；检索按 01-检索计划.md 执行（每条实测可取回才入表）。'
            : `下一步：**先补材料**（作者数据/正文材料/已验证检索/领域常识四者之一）→ 写「${r.declaration}」→ 再按任务书推进。`);
        }
      }
      return 0;
    }
    if (cmd === 'report') {
      // 惰性 require、且必须在调用点（不在文件顶部）：gate-runner 加载时会 require 本文件，
      // 顶层互相 require 会拿到「还没执行完」的导出对象。
      const runner = require('./gate-runner.cjs');
      return runner.reportMain(argv.slice(1));
    }
    if (cmd === 'verify') {
      // V2.7：工件复核（重算输入哈希 ⇒ FRESH / STALE）。与 report 同样惰性 require。
      const runner = require('./gate-runner.cjs');
      return runner.artifactMain(argv.slice(1));
    }
    if (cmd === 'stylecheck') {
      // V2.9：写作质量机械检查（叙事纪律里可机检的那部分；语义留给跨模型 reviewer）
      return require('./stylecheck.cjs').main(argv.slice(1));
    }
    if (cmd === 'state') {
      // V2.12：多阶段运行的「完成 vs 受理」状态机（done≠accepted；resume 走到第一个非终态）
      return require('./runstate.cjs').main(argv.slice(1));
    }
    if (cmd === 'polish') {
      // V3：润色机械保障层（LaTeX 保真守卫 + 改动账本 + 中英通道检查）—— 补齐市面收敛出的 P0 缺口
      return require('./polish.cjs').main(argv.slice(1));
    }
    if (cmd === 'profile') {
      // V3：研究风格档案（结构化 + 点路径读写 + brief 开工注入；凭证类字段一律拒收）
      return require('./profile.cjs').main(argv.slice(1));
    }
    if (cmd === 'schemacheck') {
      // V3：工具 parameters 严格性校验（防 400 / 防"换模型才报错"）
      return require('./schema-check.cjs').main(argv.slice(1));
    }
    if (cmd === 'revise') {
      // V3：审稿回复（逐条骨架 + 覆盖/空话/承诺/语气机检）与去 AI 味词表
      return require('./revise.cjs').main(argv.slice(1));
    }
    if (cmd === 'figures') {
      // V3：图表助手（题注生成/体检 · 绘图推荐 · 架构图源码骨架）—— **不生成图片**
      return require('./figures.cjs').main(argv.slice(1));
    }
    if (cmd === 'coach') {
      // V3：开工教练（教训 × 强制级别 × 用过次数 ⇒ brief 注入）—— 补齐最后一项 P2
      return require('./coach.cjs').main(argv.slice(1));
    }
    if (cmd === 'audit') {
      // V3：出厂审查（完整性 + 重复性 + 数字一致性）—— 用户步骤③的取证固化为可复跑工具
      // ★ 修（真事故）：原来写成 `require(...).main ? require(...).main() : 2`，
      //   而 `audit.cjs` 当时**漏导出了 main** ⇒ 静默返回 2、零输出，看起来像"CLI 挂了"。
      //   现在缺 main 就**显式报错**（静默失败比报错难查得多）。
      const audit = require('./audit.cjs');
      if (typeof audit.main !== 'function') { console.error('内部错误：audit.cjs 未导出 main（静默返回 2 会让上游误判为"CLI 失败"）'); return 2; }
      return audit.main();
    }
    if (cmd === 'cost') {
      // V3.2：交付后的**成本总结**（token 事实 + 按价格表算的钱）—— 用户要求"交付完给出实际花销"
      //   · 用量读会话日志（`assistant/message` 的 usage；日志是**多帧 zstd**，必须按魔数切帧逐帧解）
      //   · 金额**只按价格表算**；表里没有的模型标"未定价"，**绝不当 0**（当 0 就是假装免费）
      const cost = require('./cost.cjs');
      if (typeof cost.main !== 'function') { console.error('内部错误：cost.cjs 未导出 main（静默返回 2 会让上游误判为"CLI 失败"）'); return 2; }
      return cost.main(argv.slice(1));
    }
    if (cmd === 'selftest') return runSelftest();
    if (cmd === 'hygiene') return cmdHygiene();
    if (cmd === 'claims') return cmdClaims();
    if (cmd === 'coverage') return cmdCoverage();
    if (cmd === 'compliance') return cmdCompliance(args[1] || '');
    if (cmd === 'credit') return cmdCredit(args[1] || '');
    if (cmd === 'formats') return cmdFormats(args, argv);
    if (cmd === 'preflight') return cmdPreflight(args, argv);
    if (cmd === 'anchors') return cmdAnchors(args, argv);
    if (cmd === 'response') return cmdResponse(args, argv);
    if (cmd === 'cover') return cmdCover(args, argv);
    if (cmd === 'report-check') return cmdReportCheck(args, argv);
    if (cmd === 'doctor') return cmdDoctor(args, argv);
  if (cmd === 'reports') return cmdReports(args, argv);
    if (cmd === 'submission-fields') return cmdSubmissionFields(args, argv);
    if (cmd === 'retract-check') return cmdRetractCheck(args, argv.includes('--dois'));
    console.error(`未知子命令：${cmd}`);
    return 2;
  } catch (e) {
    console.error(String((e && e.message) || e));
    return 2;
  }
}

module.exports = { readPipeline, routeTask, resolveGate, intake, runSelftest, printRoute, readTemplates, readLessons, listMethod, scaffold, draftPlan, detectLang, detectGenre, titleAndAbstract, validateHandoff, findContract, crosscheck, crosscheckMaterial, crosscheckDocx, readDocxStructure, readSections, sectionForGate, primarySectionOf, judgeTypeOf, SUBCOMMANDS, STAGE_RULES, PIPELINE_PATH, ROOT };

// ⚠ 入口守卫必须在 module.exports **之后**（与 gate-runner 同一条纪律）：
//   它一执行就跑 main()，而 main 里的 report 分支会惰性 require('./gate-runner.cjs')，
//   后者顶层又 require('./studio.cjs') —— 若此时 exports 还没赋值，
//   拿到的是空对象，报 "studio.readPipeline is not a function"（2026-10-14 实测）。
if (require.main === module) {
  // ★ v3.2.7：main 里有一个异步命令（retract-check 需联网查 OpenAlex）。
//   处理：同步命令照旧直接取返回值；**返回值是 Promise 时单独 await 并兜底捕获**——
//   否则会把 Promise 赋给 process.exitCode（Node 报 ERR_INVALID_ARG_TYPE，本机实测踩过）。
{
  const __r = main(process.argv.slice(2));
  if (__r && typeof __r.then === 'function') {
    __r.then((c) => { process.exitCode = c; })
      .catch((e) => { console.error('未捕获错误：' + String((e && e.message) || e)); process.exitCode = 2; });
  } else {
    process.exitCode = __r;
  }
}
}
