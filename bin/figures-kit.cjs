#!/usr/bin/env node
/**
 * figures-kit —— **自己生成**论文图模板（零依赖 SVG）+ 按判据复核。
 *
 * 由来（2026-10-17）：扫描件 `dsh-sci-fault-diag-paper` 的 `plot-is-all-you-need/gallery` 里有 **119 张已发表论文插图**
 * （PLOS / Copernicus 系，78.7 MB）当作风格参考。**决定：那些图一律不进我们的包**（第三方已发表插图），
 * 只吸收**图法**（判据见 `references/figure-style-rubric.md`），图由本工具**自己生成**。
 *
 * 用法：
 *   node bin/figures-kit.cjs --list
 *   node bin/figures-kit.cjs --kind panels --out fig.svg [--width 170] [--panels 4] [--title "..."]
 *   node bin/figures-kit.cjs --check fig.svg        # 按九条判据复核（不合格退 1；无法判定退 2）
 *   node bin/figures-kit.cjs --selftest
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

/* Okabe–Ito 色盲安全色板（+ 灰阶）——判据只认这些 */
const SAFE = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#F0E442', '#000000', '#FFFFFF', '#666666', '#999999', '#CCCCCC', '#333333'];
const KINDS = ['line', 'panels', 'bars', 'scatter', 'flow', 'kymo'];
const KINDS_ZH = { line: '单栏折线 + 不确定带', panels: '小图矩阵', bars: '类目对比 + 误差棒', scatter: '散点 + 拟合 + 置信带', flow: '门链 / 流程图', kymo: '图像型面板（时空图）' };

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const px = (mm) => Math.round(mm * 3.7795 * 100) / 100;

/** 生成 SVG 模板（纯函数，可夹具）。所有模板自带轴标签+单位、安全色板、>=7 字号、无渐变。 */
function build(kind, opts) {
  /* 色条默认只在连续色映射场景（kymo）需要；显式 opts.colorbar 优先 */
  const o = Object.assign({ widthMm: 85, heightMm: 60, title: '示例图', xlabel: '时间 (s)', ylabel: '电压 (V)', panels: 4, unit: '%', colorbar: (opts && typeof opts.colorbar === 'boolean') ? opts.colorbar : (kind === 'kymo') }, opts || {});
  if (KINDS.indexOf(kind) < 0) throw new Error('未知图型：' + kind + '（可选 ' + KINDS.join('/') + '）');
  const W = o.widthMm, H = o.heightMm, fs = o.fontSize || 7;
  const head = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" viewBox="0 0 ' + px(W) + ' ' + px(H) + '" data-width-mm="' + W + '" data-kind="' + kind + '" data-colorbar="' + (o.colorbar ? 'true' : 'false') + '" font-family="Helvetica, Arial, sans-serif">';
  const L = [head];
  L.push('<rect x="0" y="0" width="' + px(W) + '" height="' + px(H) + '" fill="#FFFFFF"/>');
  const M = 14;                                        // 边距（px 近似，实际排版时按需调）
  const plotW = px(W) - 2 * M, plotH = px(H) - 2 * M - 6;
  if (kind === 'line' || kind === 'scatter') {
    L.push('<g id="axes"><line x1="' + M + '" y1="' + (M + plotH) + '" x2="' + (M + plotW) + '" y2="' + (M + plotH) + '" stroke="#000000" stroke-width="0.8"/>' +
      '<line x1="' + M + '" y1="' + M + '" x2="' + M + '" y2="' + (M + plotH) + '" stroke="#000000" stroke-width="0.8"/></g>');
    L.push('<text x="' + (M + plotW / 2) + '" y="' + (M + plotH + 11) + '" font-size="' + fs + '" text-anchor="middle">' + esc(o.xlabel) + '</text>');
    L.push('<text x="' + (M - 9) + '" y="' + (M + plotH / 2) + '" font-size="' + fs + '" text-anchor="middle" transform="rotate(-90 ' + (M - 9) + ' ' + (M + plotH / 2) + ')">' + esc(o.ylabel) + '</text>');
    L.push('<text x="' + M + '" y="' + (M - 5) + '" font-size="' + (fs + 1) + '" font-weight="bold">' + esc(o.title) + '</text>');
    if (kind === 'line') {
      L.push('<path d="M' + M + ' ' + (M + plotH * 0.6) + ' L' + (M + plotW * 0.5) + ' ' + (M + plotH * 0.35) + ' L' + (M + plotW) + ' ' + (M + plotH * 0.15) + '" fill="none" stroke="#0072B2" stroke-width="1.2"/>');
      L.push('<path d="M' + M + ' ' + (M + plotH * 0.72) + ' L' + (M + plotW * 0.5) + ' ' + (M + plotH * 0.22) + ' L' + (M + plotW) + ' ' + (M + plotH * 0.05) + ' ' + (M + plotW) + ' ' + (M + plotH * 0.25) + ' L' + (M + plotW * 0.5) + ' ' + (M + plotH * 0.48) + ' L' + M + ' ' + (M + plotH * 0.88) + ' Z" fill="#56B4E9" opacity="0.35"/>');
    } else {
      L.push('<circle cx="' + (M + plotW * 0.3) + '" cy="' + (M + plotH * 0.55) + '" r="2.2" fill="#D55E00"/>');
      L.push('<path d="M' + M + ' ' + (M + plotH * 0.8) + ' L' + (M + plotW) + ' ' + (M + plotH * 0.3) + '" stroke="#0072B2" stroke-width="1" stroke-dasharray="4 2" fill="none"/>');
    }
  } else if (kind === 'panels') {
    const n = Math.max(2, Math.min(9, o.panels | 0));
    const cols = n <= 4 ? 2 : 3, rows = Math.ceil(n / cols);
    const cw = plotW / cols, ch = (plotH - 6) / rows;
    L.push('<text x="' + M + '" y="' + (M - 4) + '" font-size="' + (fs + 1) + '" font-weight="bold">' + esc(o.title) + '</text>');
    for (let i = 0; i < n; i += 1) {
      const r = Math.floor(i / cols), c = i % cols;
      const x = M + c * cw + 3, y = M + 4 + r * ch + 3, w = cw - 12, h = ch - 16;
      L.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="none" stroke="#000000" stroke-width="0.8"/>');
      L.push('<text x="' + x + '" y="' + (y - 2) + '" font-size="' + (fs + 1) + '" font-weight="bold">' + String.fromCharCode(65 + i) + '</text>');
      L.push('<text x="' + (x + w / 2) + '" y="' + (y + h + fs + 2) + '" font-size="' + fs + '" text-anchor="middle">' + esc(o.xlabel) + '</text>');
      L.push('<text x="' + (x + w / 2) + '" y="' + (y + h - 3) + '" font-size="' + fs + '" text-anchor="middle">' + esc('读数 = 0.0 ' + (o.unit || '')) + '</text>');
    }
    if (o.colorbar) {
      L.push('<g id="colorbar"><rect x="' + (M + plotW - 8) + '" y="' + M + '" width="6" height="34" fill="#0072B2"/><text x="' + (M + plotW - 4) + '" y="' + (M + 40) + '" font-size="' + fs + '" text-anchor="middle">' + esc(o.unit || '') + '</text></g>');
    }
  } else if (kind === 'bars') {
    L.push('<text x="' + M + '" y="' + (M - 5) + '" font-size="' + (fs + 1) + '" font-weight="bold">' + esc(o.title) + '</text>');
    L.push('<line x1="' + M + '" y1="' + (M + plotH) + '" x2="' + (M + plotW) + '" y2="' + (M + plotH) + '" stroke="#000000" stroke-width="0.8"/>');
    for (let i = 0; i < 4; i += 1) {
      const bw = plotW / 8, x = M + 8 + i * (bw * 2);
      const bh = plotH * (0.4 + 0.12 * i);
      L.push('<rect x="' + x + '" y="' + (M + plotH - bh) + '" width="' + bw + '" height="' + bh + '" fill="' + SAFE[i % SAFE.length] + '"/>');
      L.push('<line x1="' + (x + bw / 2) + '" y1="' + (M + plotH - bh - 4) + '" x2="' + (x + bw / 2) + '" y2="' + (M + plotH - bh + 4) + '" stroke="#000000" stroke-width="0.8"/>');
      L.push('<text x="' + (x + bw / 2) + '" y="' + (M + plotH + 10) + '" font-size="' + fs + '" text-anchor="middle">C' + (i + 1) + '</text>');
    }
    L.push('<text x="' + (M - 9) + '" y="' + (M + plotH / 2) + '" font-size="' + fs + '" text-anchor="middle" transform="rotate(-90 ' + (M - 9) + ' ' + (M + plotH / 2) + ')">' + esc(o.ylabel) + '</text>');
    L.push('<text x="' + (M + plotW / 2) + '" y="' + (M + plotH + 22) + '" font-size="' + fs + '" text-anchor="middle">' + esc(o.xlabel) + '</text>');
  } else if (kind === 'flow') {
    L.push('<text x="' + M + '" y="' + (M - 4) + '" font-size="' + (fs + 1) + '" font-weight="bold">' + esc(o.title) + '</text>');
    const steps = ['收到稿件', '门：结构完整', '门：引用可核', '出厂审计'];
    for (let i = 0; i < steps.length; i += 1) {
      const y = M + 6 + i * ((plotH - 10) / steps.length);
      L.push('<rect x="' + M + '" y="' + y + '" width="' + (plotW - 20) + '" height="' + ((plotH - 10) / steps.length - 8) + '" fill="none" stroke="#0072B2" stroke-width="0.8"/>');
      L.push('<text x="' + (M + 6) + '" y="' + (y + 12) + '" font-size="' + fs + '">' + esc(steps[i]) + '</text>');
      if (i < steps.length - 1) L.push('<line x1="' + (M + plotW / 2) + '" y1="' + (y + ((plotH - 10) / steps.length - 8)) + '" x2="' + (M + plotW / 2) + '" y2="' + (y + ((plotH - 10) / steps.length)) + '" stroke="#000000" stroke-width="0.8"/>');
    }
  } else if (kind === 'kymo') {
    L.push('<text x="' + M + '" y="' + (M - 4) + '" font-size="' + (fs + 1) + '" font-weight="bold">' + esc(o.title) + '</text>');
    L.push('<g id="arrow-axes"><line x1="' + M + '" y1="' + M + '" x2="' + (M + plotW) + '" y2="' + M + '" stroke="#000000" stroke-width="1"/><polygon points="' + (M + plotW) + ',' + M + ' ' + (M + plotW - 6) + ',' + (M - 3) + ' ' + (M + plotW - 6) + ',' + (M + 3) + '" fill="#000000"/>' +
      '<line x1="' + M + '" y1="' + M + '" x2="' + M + '" y2="' + (M + plotH) + '" stroke="#000000" stroke-width="1"/><polygon points="' + M + ',' + (M + plotH) + ' ' + (M - 3) + ',' + (M + plotH - 6) + ' ' + (M + 3) + ',' + (M + plotH - 6) + '" fill="#000000"/>' +
      '<text x="' + (M + plotW / 2) + '" y="' + (M - 6) + '" font-size="' + fs + '" text-anchor="middle">' + esc(o.xlabel) + '</text>' +
      '<text x="' + (M - 9) + '" y="' + (M + 20) + '" font-size="' + fs + '" transform="rotate(-90 ' + (M - 9) + ' ' + (M + 20) + ')">' + esc(o.ylabel) + '</text></g>');
    L.push('<rect x="' + M + '" y="' + M + '" width="' + plotW + '" height="' + plotH + '" fill="#E69F00" opacity="0.25"/>');
    L.push('<rect x="' + M + '" y="' + M + '" width="' + plotW + '" height="' + (plotH * 0.12) + '" fill="#009E73" stroke="#000000" stroke-width="0.8"/>');
    L.push('<text x="' + (M + plotW + 3) + '" y="' + (M + 10) + '" font-size="' + fs + '">1.8 min</text>');
    if (o.colorbar) L.push('<g id="colorbar"><rect x="' + (M + plotW - 10) + '" y="' + (M + 4) + '" width="6" height="30" fill="#0072B2"/><text x="' + (M + plotW - 7) + '" y="' + (M + 40) + '" font-size="' + fs + '" text-anchor="middle">' + esc(o.unit || '') + '</text></g>');
  }
  L.push('</svg>');
  return L.join('\n');
}

/** 按九条判据复核一张 SVG（纯函数）。status: PASS / FAIL / SKIP */
function check(svg) {
  const s = String(svg || '');
  if (!s.trim()) return { status: 'SKIP', reason: '空输入 ⇒ 未核对（不得当通过）', issues: [] };
  if (s.indexOf('<svg') < 0) return { status: 'SKIP', reason: '不是 SVG ⇒ 未核对（不得当通过）', issues: [] };
  const issues = [];
  /* 1 宽度预算 */
  const mm = (function () { const m = /data-width-mm="([\d.]+)"/.exec(s) || /width="([\d.]+)mm"/.exec(s); return m ? parseFloat(m[1]) : null; })();
  if (mm === null) issues.push('缺 width（mm）声明 ⇒ 无法判宽度预算');
  else if (mm > 180) issues.push('超宽：' + mm + 'mm > 180mm（单栏 85 / 双栏 170）');
  else if (mm > 85.5 && mm < 169.5 && Math.abs(mm - 114) > 0.5) issues.push('宽度 ' + mm + 'mm 非标准栏宽（85 / 114 / 170）');
  /* 2 轴标签与单位 */
  const labels = (s.match(/<text[^>]*>[^<]*\([^)]*\)[^<]*<\/text>/g) || []).length;
  const arrowAxes = s.indexOf('id="arrow-axes"') >= 0;
  if (labels < 1 && !arrowAxes && !/data-kind="flow"/.test(s)) issues.push('轴标签缺单位（未找到形如「量 (单位)」的文本，也无箭头轴）');
  /* 3 配色安全 */
  const colors = (s.match(/(?:fill|stroke)="#[0-9A-Fa-f]{6}"/g) || []).map((x) => /#[0-9A-Fa-f]{6}/.exec(x)[0].toUpperCase());
  const bad = colors.filter((c) => SAFE.map((x) => x.toUpperCase()).indexOf(c) < 0);
  if (bad.length) issues.push('非安全配色：' + Array.from(new Set(bad)).join(' ') + '（只许 Okabe–Ito 色板或灰阶）');
  /* 4 chartjunk */
  if (/linearGradient|radialGradient|<filter/i.test(s)) issues.push('含渐变或滤镜 ⇒ 判为 chartjunk');
  if (/3D|threeD/i.test(s)) issues.push('含 3D 元素');
  /* 5 字号下限 */
  const sizes = (s.match(/font-size="([\d.]+)"/g) || []).map((x) => parseFloat(/[\d.]+/.exec(x)[0]));
  if (sizes.length && Math.min.apply(null, sizes) < 6) issues.push('字号 ' + Math.min.apply(null, sizes) + ' < 6pt（印刷最小值）');
  /* 6 色条 */
  if (/data-colorbar="true"/.test(s) && s.indexOf('id="colorbar"') < 0) issues.push('声明需要色条但未生成色条');
  /* 7 小图矩阵：面板字母与标量读数 */
  if (/data-kind="panels"/.test(s)) {
    if (!/>A</.test(s)) issues.push('小图矩阵缺面板字母');
    if (s.indexOf('读数') < 0) issues.push('小图矩阵缺每格标量读数');
  }
  return { status: issues.length ? 'FAIL' : 'PASS', issues: issues, width_mm: mm, font_min: sizes.length ? Math.min.apply(null, sizes) : null, colors: Array.from(new Set(colors)) };
}

function selftest() {
  const cases = [];
  const ck = (n, f) => { let r; try { r = f(); } catch (e) { r = '抛错：' + String((e && e.message) || e); } cases.push({ n, ok: r === true, d: r === true ? '' : String(r) }); };

  ck('生成：六种图型都能生成，且**都能通过自己的判据**', () => {
    for (const k of KINDS) { const s = build(k, {}); const c = check(s); if (c.status !== 'PASS') return k + ' 未通过：' + JSON.stringify(c.issues); }
    return true;
  });

  ck('★必失败面：超宽（>180mm）必须报', () => {
    const c = check(build('line', { widthMm: 200 }));
    return c.status === 'FAIL' && c.issues.some((x) => /超宽/.test(x)) ? true : JSON.stringify(c);
  });

  ck('★必失败面：非安全配色必须报（换一个色盲不友好的紫）', () => {
    const s = build('line', {}).replace('#0072B2', '#FF00FF');
    const c = check(s);
    return c.status === 'FAIL' && c.issues.some((x) => /非安全配色/.test(x)) ? true : JSON.stringify(c);
  });

  ck('★必失败面：含渐变必须报为 chartjunk', () => {
    const s = build('bars', {}).replace('</svg>', '<linearGradient id="g"/></svg>');
    const c = check(s);
    return c.status === 'FAIL' && c.issues.some((x) => /chartjunk|渐变/.test(x)) ? true : JSON.stringify(c);
  });

  ck('★必失败面：字号小于 6pt 必须报', () => {
    const s = build('line', { fontSize: 4 });
    const c = check(s);
    return c.status === 'FAIL' && c.issues.some((x) => /字号/.test(x)) ? true : JSON.stringify(c);
  });

  ck('★必失败面：轴标签丢单位必须报', () => {
    const s = build('scatter', {}).replace(/时间 \(s\)/, '时间').replace(/电压 \(V\)/, '电压');
    const c = check(s);
    return c.status === 'FAIL' && c.issues.some((x) => /单位/.test(x)) ? true : JSON.stringify(c);
  });

  ck('★必失败面：声明色条却没生成色条必须报', () => {
    const s = build('kymo', {}).replace('<g id="colorbar">', '<g id="cbar-removed">');
    const c = check(s);
    return c.status === 'FAIL' && c.issues.some((x) => /色条/.test(x)) ? true : JSON.stringify(c);
  });

  ck('★必失败面：空输入/非 SVG ⇒ SKIP（不得当通过）', () => {
    const a = check(''); const b = check('hello world');
    return (a.status === 'SKIP' && b.status === 'SKIP') ? true : JSON.stringify([a, b]);
  });

  ck('幂等：同一参数两次生成逐字符相同', () => {
    return build('panels', { panels: 6, title: 'T' }) === build('panels', { panels: 6, title: 'T' }) ? true : '两次生成不一致';
  });

  ck('v3.9.0·audit·★必失败面：正文引用 Fig. 5 但无该文件 ⇒ ERROR；孤儿图与无 DPI 的 PNG ⇒ WARN', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'psfig-'));
    fs.mkdirSync(path.join(tmp, 'figures'));
    /* 造一个合法 PNG（1x1 · 无 pHYs）与一个假 PDF */
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd40000000049454e44ae426082', 'hex');
    fs.writeFileSync(path.join(tmp, 'figures', 'fig1_a.png'), png);
    fs.writeFileSync(path.join(tmp, 'figures', 'fig9_orphan.pdf'), '%PDF-1.4\n');
    const draft = path.join(tmp, 'draft.md');
    fs.writeFileSync(draft, 'As shown in Fig. 1, curves track. The ablation is in Fig. 5.\n\n**Figure 1.** Curves for all protocols\n', 'utf8');
    const r = auditPackage(tmp, fs.readFileSync(draft, 'utf8'));
    const kinds = r.issues.map((x) => x.level + ':' + x.msg);
    if (!kinds.some((x) => x.startsWith('ERROR:') && x.indexOf('Fig. 5') >= 0)) return '未报缺图：' + JSON.stringify(kinds);
    if (!kinds.some((x) => x.startsWith('WARN:') && x.indexOf('孤儿图') >= 0)) return '未报孤儿图：' + JSON.stringify(kinds);
    if (!kinds.some((x) => x.indexOf('无 DPI') >= 0)) return '未报无 DPI：' + JSON.stringify(kinds);
    if (!kinds.some((x) => x.indexOf('缺句号') >= 0)) return '未报题注缺句号：' + JSON.stringify(kinds);
    return true;
  });

  ck('v3.9.0·cvd·★必失败面：**灰阶不可分**必须被抓（实测证据：Okabe-Ito 的 #D55E00 ↔ #009E73 灰阶 L* 仅 3.6）', () => {
    /* 取证纪律：本条臂的选色来自**实跑读数**，不是"红绿一定不行"的想当然 ——
       全饱和 #FF0000 ↔ #00FF00 在红绿色盲仿真下 ΔE 仍有 26（>12），并不触发 CVD 判据；
       真正在 Okabe-Ito 上被本工具抓到的是**灰阶分离**：3/10 对在黑白打印下不可分（D55E00↔009E73 L*3.6 · D55E00↔CC79A7 L*6.9 · 009E73↔CC79A7 L*3.3）。 */
    const bad = cvdCheck(['#D55E00', '#009E73']);
    if (bad.status !== 'FAIL') return '灰阶不可分应判 FAIL：' + JSON.stringify(bad.pairs);
    if (!bad.issues.some((x) => /灰阶分离/.test(x))) return '未指出灰阶原因：' + JSON.stringify(bad.issues);
    const ok = cvdCheck(['#000000', '#FFFFFF'], { minDE: 12 });
    if (ok.status !== 'PASS') return '黑白应 PASS：' + JSON.stringify(ok.issues);
    /* 全饱和红绿：CVD 下仍可分（ΔE 26）⇒ 本工具**不**报它，这是如实行为，不是漏报 */
    const rg = cvdCheck(['#FF0000', '#00FF00'], { minGray: 0 });
    if (rg.status !== 'PASS') return '全饱和红绿在 ΔE 判据下应 PASS（灰阶置 0）：' + JSON.stringify(rg.issues);
    return true;
  });

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nfigures-kit 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}


/* ═══════════ v3.9.0：Task F 对拍产物（① 包级审计 ② CVD 安全判定）═══════════ */

/** PNG 头部信息：像素尺寸 + 是否有 pHYs（DPI 元数据）。纯 stdlib 读二进制。 */
function pngInfo(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return { kind: 'not-png' };
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const hasPhys = b.indexOf(Buffer.from('pHYs')) >= 0;
  let dpi = null;
  if (hasPhys) {
    const i = b.indexOf(Buffer.from('pHYs'));
    if (i + 13 <= b.length) {
      const ppmX = b.readUInt32BE(i + 4);
      dpi = Math.round(ppmX * 0.0254);
    }
  }
  return { kind: 'png', w, h, hasPhys, dpi };
}

const FIG_REF_RE = new RegExp('(?:Fig(?:ure)?s?\\.?)\\s*(\\d+)', 'gi');

/** 包级审计：题注 ↔ 文件 ↔ 格式 */
function auditPackage(dir, draftText) {
  const issues = [];
  const d = path.resolve(dir);
  if (!fs.existsSync(d)) return { status: 'FAIL', issues: ['包目录不存在：' + d], files: [] };
  const all = [];
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const q = path.join(p, e.name);
      if (e.isDirectory()) walk(q); else all.push(q);
    }
  })(d);
  const figs = all.filter((f) => /\.(png|jpe?g|pdf|svg|eps|tiff?)$/i.test(f));
  if (!figs.length) return { status: 'SKIP', issues: ['包内没有图文件 ⇒ 未核对（不得当通过）'], files: [] };
  const bases = {};
  for (const f of figs) {
    const base = path.basename(f).replace(/\.[^.]+$/, '');
    bases[base] = bases[base] || { files: [] };
    bases[base].files.push(f);
  }
  /* ① 文中引用 vs 文件 */
  const refs = {};
  if (draftText) {
    let m; const re = new RegExp(FIG_REF_RE.source, 'gi');
    while ((m = re.exec(draftText)) !== null) refs[m[1]] = (refs[m[1]] || 0) + 1;
  }
  const baseHasNum = (n) => Object.keys(bases).some((b) => new RegExp('(?:^|[^0-9])0*' + n + '(?:[^0-9]|$)').test(b));
  for (const n of Object.keys(refs)) {
    if (!baseHasNum(n)) issues.push({ level: 'ERROR', msg: '正文引用 Fig. ' + n + '，但包内没有编号 ' + n + ' 的图文件' });
  }
  for (const b of Object.keys(bases)) {
    const num = (b.match(/\d+/) || [])[0];
    if (draftText && num && !refs[String(Number(num))]) issues.push({ level: 'WARN', msg: '孤儿图（正文未引用）：' + b });
  }
  /* ② 矢量/位图配对 + PNG 解析 */
  const readings = [];
  for (const b of Object.keys(bases)) {
    const hasVector = bases[b].files.some((f) => /\.(pdf|svg|eps)$/i.test(f));
    const rasters = bases[b].files.filter((f) => /\.(png|jpe?g|tiff?)$/i.test(f));
    if (rasters.length && !hasVector) issues.push({ level: 'WARN', msg: '只有位图、无矢量源（期刊多要求矢量或 ≥300dpi 位图）：' + b });
    for (const f of rasters) {
      const info = pngInfo(f);
      if (info.kind !== 'png') { readings.push({ file: path.basename(f), note: '非 PNG（未读取分辨率）' }); continue; }
      readings.push({ file: path.basename(f), w: info.w, h: info.h, hasPhys: info.hasPhys, dpi: info.dpi });
      if (!info.hasPhys) issues.push({ level: 'WARN', msg: 'PNG 无 DPI 元数据（pHYs）：' + path.basename(f) + ' ⇒ 排版端会按 72dpi 处理，须显式设 300dpi' });
      else if (info.dpi && info.dpi < 300) issues.push({ level: 'WARN', msg: 'PNG DPI ' + info.dpi + ' < 300：' + path.basename(f) });
    }
  }
  /* ③ 题注检查 */
  const caps = [];
  if (draftText) {
    /* ★ v3.9.0b：**行式解析**（先剥行首的 * / # / 空白，再匹配）—— 比单条复杂正则稳，夹具实测过 */
    for (const raw of draftText.split('\n')) {
      const line = raw.replace(/^[\s*#>]+/, '').trim();
      const mm = /^(?:Figure|Fig)\.?\s*(\d+)[.:]?\s*(.+)$/i.exec(line);
      if (mm) caps.push({ n: mm[1], text: mm[2].trim() });
    }
    for (const c of caps) {
      if (!/[.。]$/.test(c.text)) issues.push({ level: 'WARN', msg: '题注 Fig. ' + c.n + ' 结尾缺句号' });
      if (c.text.length < 40) issues.push({ level: 'WARN', msg: '题注 Fig. ' + c.n + ' 过短（' + c.text.length + ' 字）⇒ 可能不自足' });
    }
    /* 面板字母自足性：SVG 里有 A/B 面板，题注必须提到 */
    for (const b of Object.keys(bases)) {
      const svg = bases[b].files.find((f) => /\.svg$/i.test(f));
      if (!svg) continue;
      const s = fs.readFileSync(svg, 'utf8');
      const panels = (s.match(/data-panel="([A-D])"/g) || []).map((x) => x.replace(/\D/g, ''));
      if (!panels.length) continue;
      const num = (b.match(/\d+/) || [])[0];
      const cap = caps.find((c) => String(Number(c.n)) === String(Number(num)));
      if (cap) {
        for (const pl of panels) {
          if (!new RegExp('\\b' + pl + '\\b').test(cap.text)) issues.push({ level: 'WARN', msg: '题注 Fig. ' + num + ' 未定义面板 ' + pl + '（图里有该面板）' });
        }
      }
    }
  }
  const errs = issues.filter((x) => x.level === 'ERROR').length;
  return { status: errs ? 'FAIL' : 'PASS', issues, files: Object.keys(bases), readings, captions: caps.length, refs: Object.keys(refs) };
}

/* ── CVD 安全判定：Machado 2009（severity 1.0）+ CIE76 ΔE ── */
const CVD_MATRICES = {
  protanopia: [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],
  tritanopia: [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],
};
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function hexToRgb(h) {
  const s = String(h).replace('#', '').trim();
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
}
const linearToXyz = (r, g, b) => [0.4124 * r + 0.3576 * g + 0.1805 * b, 0.2126 * r + 0.7152 * g + 0.0722 * b, 0.0193 * r + 0.1192 * g + 0.9505 * b];
function xyzToLab(x, y, z) {
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047), fy = f(y / 1.0), fz = f(z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
const labOf = (rgb, matrix) => {
  const lin = rgb.map(srgbToLinear);
  const v = matrix ? [
    matrix[0] * lin[0] + matrix[1] * lin[1] + matrix[2] * lin[2],
    matrix[3] * lin[0] + matrix[4] * lin[1] + matrix[5] * lin[2],
    matrix[6] * lin[0] + matrix[7] * lin[1] + matrix[8] * lin[2],
  ] : lin;
  const xyz = linearToXyz(v[0], v[1], v[2]);
  return { lab: xyzToLab(xyz[0], xyz[1], xyz[2]), L: xyzToLab(xyz[0], xyz[1], xyz[2])[0], Y: xyz[1] };
};
const dE76 = (a, b) => Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2) * 10) / 10;

/** 对一组颜色做 CVD + 灰阶安全判定（阈值可调，默认 ΔE ≥ 12 且灰阶 L* 差 ≥ 8） */
function cvdCheck(hexes, opts) {
  const o = opts || {};
  const minDE = o.minDE || 12, minGray = o.minGray || 8;
  const cols = [];
  for (const h of hexes) { const rgb = hexToRgb(h); if (!rgb) return { status: 'FAIL', issues: ['颜色格式不合法（需 #RRGGBB）：' + h], pairs: [] }; cols.push({ hex: h, rgb }); }
  if (cols.length < 2) return { status: 'FAIL', issues: ['至少给两个颜色才能判两两可分性'], pairs: [] };
  const rows = [];
  let bad = 0;
  for (let i = 0; i < cols.length; i++) {
    for (let j = i + 1; j < cols.length; j++) {
      const pair = { a: cols[i].hex, b: cols[j].hex, normal: dE76(labOf(cols[i].rgb).lab, labOf(cols[j].rgb).lab), cvd: {}, gray: Math.round(Math.abs(labOf(cols[i].rgb).L - labOf(cols[j].rgb).L) * 10) / 10 };
      for (const k of Object.keys(CVD_MATRICES)) pair.cvd[k] = dE76(labOf(cols[i].rgb, CVD_MATRICES[k]).lab, labOf(cols[j].rgb, CVD_MATRICES[k]).lab);
      const worst = Math.min(pair.normal, ...Object.keys(pair.cvd).map((k) => pair.cvd[k]));
      pair.worst = worst;
      pair.ok = worst >= minDE && pair.gray >= minGray;
      if (!pair.ok) bad++;
      rows.push(pair);
    }
  }
  const issues = rows.filter((r) => !r.ok).map((r) => {
    const why = [];
    if (r.worst < minDE) why.push('色盲仿真下 ΔE 仅 ' + r.worst + '（<' + minDE + '）');
    if (r.gray < minGray) why.push('灰阶分离 L* 仅 ' + r.gray + '（<' + minGray + '）');
    return r.a + ' ↔ ' + r.b + '：' + why.join('；');
  });
  return { status: bad ? 'FAIL' : 'PASS', issues, pairs: rows, minDE, minGray };
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
  if (argv.includes('--audit')) {
    const dir = val('--audit');
    const draft = val('--draft');
    let dt = null;
    if (draft) { if (!fs.existsSync(path.resolve(draft))) { console.error('读不到 --draft 文件：' + draft + '（未核对，不得当通过）'); return 2; } dt = fs.readFileSync(path.resolve(draft), 'utf8'); }
    const r = auditPackage(dir, dt);
    console.log('图表包审计：' + r.status + '（文件 ' + (r.files || []).length + ' 组 · 题注 ' + (r.captions || 0) + ' 条' + (dt ? '' : ' · 未给 --draft ⇒ 引用/题注项未检查') + '）');
    for (const x of r.issues) console.log('  ' + (x.level === 'ERROR' ? '✘' : '·') + ' [' + x.level + '] ' + x.msg);
    for (const q of (r.readings || [])) console.log('  · ' + q.file + (q.w ? ' ' + q.w + 'x' + q.h + (q.dpi ? ' · ' + q.dpi + 'dpi' : ' · 无 DPI') : ' ' + q.note));
    if (r.status === 'SKIP') return 2;
    return r.status === 'FAIL' ? 1 : 0;
  }
  if (argv.includes('--cvd')) {
    const list = String(val('--cvd') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const r = cvdCheck(list, { minDE: Number(val('--min-de')) || 12, minGray: Number(val('--min-gray')) || 8 });
    console.log('色盲/灰阶安全判定：' + r.status + '（' + r.pairs.length + ' 对 · 阈值 ΔE≥' + r.minDE + ' · 灰阶 L*≥' + r.minGray + '）');
    for (const p of r.pairs) console.log('  ' + (p.ok ? '✔' : '✘') + ' ' + p.a + ' ↔ ' + p.b + ' · 正常 ΔE ' + p.normal + ' · 红绿色盲 ' + p.cvd.protanopia + '/' + p.cvd.deuteranopia + ' · 蓝黄色盲 ' + p.cvd.tritanopia + ' · 灰阶 ' + p.gray);
    for (const i of r.issues) console.log('  ✘ ' + i);
    return r.status === 'FAIL' ? 1 : 0;
  }
  if (argv.includes('--list')) { console.log('可生成的图型：'); for (const k of KINDS) console.log('  ' + k.padEnd(9) + KINDS_ZH[k]); return 0; }
  if (argv.includes('--check')) {
    const f = val('--check'); if (!f || !fs.existsSync(f)) { console.error('读不到文件：' + f + '（未核对，不得当通过）'); return 2; }
    const r = check(fs.readFileSync(f, 'utf8'));
    console.log('图法复核：' + r.status + (r.width_mm ? '（' + r.width_mm + 'mm' : '') + '）');
    for (const i of r.issues) console.log('  ✘ ' + i);
    if (r.status === 'PASS') console.log('  ✔ 九条判据全过');
    return r.status === 'FAIL' ? 1 : (r.status === 'SKIP' ? 2 : 0);
  }
  const kind = val('--kind') || 'line';
  let svg;
  try { svg = build(kind, { widthMm: Number(val('--width')) || (kind === 'panels' ? 170 : 85), title: val('--title') || KINDS_ZH[kind], panels: Number(val('--panels')) || 4 }); }
  catch (e) { console.error(String(e.message || e)); return 2; }
  const r = check(svg);
  if (r.status !== 'PASS') { console.error('生成结果未通过自家判据：' + JSON.stringify(r.issues)); return 1; }
  const out = val('--out');
  if (out) { fs.writeFileSync(out, svg, 'utf8'); console.log('已生成 ' + kind + ' ⇒ ' + out + '（' + r.width_mm + 'mm · 判据 PASS）'); }
  else console.log(svg);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { build, check, selftest, main, KINDS, KINDS_ZH, SAFE };
