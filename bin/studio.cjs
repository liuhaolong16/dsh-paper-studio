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
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PIPELINE_PATH = path.join(ROOT, 'references', 'pipeline.json');

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
      if (!runtimeOk) { runtimeNote = '未找到真 python 解释器；已试：' + tried.join(' | '); }
    }
  } catch (e) {
    runtimeOk = false;
    runtimeNote = String(e.message || e);
  }
  return { id: gate.id, label: gate.label, runtime: gate.runtime, entry: full, scriptOk, runtimeOk, runtimeNote };
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
    lines.push(`  - ${g.id}：${g.label}  [${ok ? '可用' : '不可用'}]  (${g.runtime} ${r.entry}${r.scriptOk ? '' : ' · 脚本不存在'}${r.runtimeOk ? '' : ' · 运行时不可用：' + r.runtimeNote})`);
  }
  if (t.precondition) lines.push(`前置条件：${t.precondition}`);
  lines.push(`产出：${(t.outputs || []).join(' · ')}`);
  return lines.join('\n');
}

// ── 经验库 / 方法论索引 / 骨架生成 ───────────────────────────────
const os = require('os');
const TEMPLATES_PATH = path.join(ROOT, 'references', 'templates.json');
const LESSONS_PATH = path.join(ROOT, 'references', 'lessons-from-first-draft.md');

function readTemplates(p = TEMPLATES_PATH) {
  if (!fs.existsSync(p)) { const e = new Error(`前提层失败：找不到模板清单 ${p}`); e.code = 'TEMPLATES_MISSING'; throw e; }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
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
const SUBCOMMANDS = ['route', 'gates', 'intake', 'lessons', 'coach', 'method', 'scaffold', 'draft', 'report', 'verify', 'stylecheck', 'polish', 'profile', 'schemacheck', 'revise', 'figures', 'audit', 'state', 'genre', 'sections', 'docx', 'handoff', 'crosscheck', 'cost', 'selftest'];
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
  if (!py || !fs.existsSync(py)) { const e = new Error('前提层失败：真源里没有可用的 python_exe：' + py); e.code = 'NO_PY'; throw e; }
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
  if (!py || !fs.existsSync(py)) { const e = new Error('前提层失败：真源里没有可用的 python_exe：' + py); e.code = 'NO_PY'; throw e; }
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
  for (const r of results) console.log(`${r.ok ? '  ✔' : '  ✘'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`);
  console.log(`\n自检：${results.length - failed.length}/${results.length} 通过`);
  return failed.length === 0 ? 0 : 1;
}

function main(argv) {
  const cmd = argv[0];
  const json = argv.includes('--json');
  const args = argv.filter((a) => !a.startsWith('--'));
  try {
    if (!cmd || cmd === '--help' || cmd === '-h') {
      console.log('用法：node bin/studio.cjs <route|gates|intake|lessons|method|scaffold|draft|genre|report|selftest> [参数] [--json]');
      console.log('  report --task "<描述>" --draft <稿.md> [--docx <成品.docx>] [--anchors/--manifest/--contract]  ⇒ 带行号的待修项清单');
      return 0;
    }
    const pipeline = readPipeline();
    if (cmd === 'route') {
      const res = routeTask(args.slice(1).join(' '), pipeline);
      if (json) console.log(JSON.stringify({ task_type: res.type.id, tier: res.type.tier, matched: res.matched, chain: res.type.chain, gates: res.type.gates, note: res.note }, null, 2));
      else console.log(printRoute(res, pipeline));
      // 有门不可用 ⇒ 退出码 1（不完整，但不是前提层失败）
      const gs = (res.type.gates || []).map((id) => (pipeline.gates || []).find((g) => g.id === id)).filter(Boolean).map((g) => resolveGate(g, pipeline));
      return gs.every((g) => g.scriptOk && g.runtimeOk) ? 0 : 1;
    }
    if (cmd === 'gates') {
      const list = (pipeline.gates || []).map((g) => resolveGate(g, pipeline));
      if (json) console.log(JSON.stringify(list, null, 2));
      else {
        console.log('必过门清单（真源：references/pipeline.json）：');
        for (const g of list) console.log(`  - ${g.id}：${g.label}  [${g.scriptOk && g.runtimeOk ? '可用' : '不可用'}]  ${g.runtime} ${g.entry}${g.scriptOk ? '' : ' · 脚本不存在'}${g.runtimeOk ? '' : ' · ' + g.runtimeNote}`);
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
  process.exitCode = main(process.argv.slice(2));
}
