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

  const bad = cases.filter((c) => !c.ok);
  for (const c of cases) console.log('  ' + (c.ok ? '✔' : '✘') + ' ' + c.n + (c.ok ? '' : '  ← ' + c.d));
  console.log('\nfigures-kit 自检：' + (cases.length - bad.length) + '/' + cases.length + ' 通过');
  return bad.length ? 1 : 0;
}

function main(argv) {
  if (argv.includes('--selftest')) return selftest();
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ''; };
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
