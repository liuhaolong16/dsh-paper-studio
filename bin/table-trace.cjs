#!/usr/bin/env node
'use strict';

/**
 * 综述对比表 · 引用溯源机检（table-trace）
 *
 * 判据（与 references/survey-table/README.md 同口径）：
 *   1) 每个数值格必须有引用；每个引用必须能落到 DOI/URL + 页码或定位 + ≥20 字原文片段。
 *   2) 登记过的每条文献都必须被至少一个格子引用（死引用也算失败）。
 *   3) 表格行列必须与 metadata 一致，表注必须存在；全文条目必须声明已对照原始 PDF。
 *
 * 用法：
 *   node bin/table-trace.cjs <manifest.json> [--json]
 *   node bin/table-trace.cjs --example
 *   node bin/table-trace.cjs --selftest
 *
 * 退出码：0 = 全过；1 = 有失败项；2 = 用法/读取错误。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const EXAMPLE = path.join(ROOT, 'references', 'survey-table', 'examples', 'demo', 'manifest.json');
const MIN_QUOTE = 20;
const MIN_NOTE = 10;

function problem(code, message) {
  return { code, message };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function checkManifest(manifestPath) {
  const problems = [];
  const manifestAbs = path.resolve(manifestPath);
  if (!fs.existsSync(manifestAbs)) {
    return [problem('E_FILE_MISSING', 'manifest 不存在：' + manifestPath)];
  }
  const base = path.dirname(manifestAbs);
  let manifest;
  try {
    manifest = readJson(manifestAbs);
  } catch (error) {
    return [problem('E_JSON', 'manifest 解析失败：' + error.message)];
  }

  for (const item of manifest.fulltext || []) {
    if (!isText(item.file)) {
      problems.push(problem('E_FULLTEXT_NO_FILE', 'fulltext 条目缺 file'));
      continue;
    }
    if (!fs.existsSync(path.resolve(base, item.file))) {
      problems.push(problem('E_FILE_MISSING', 'fulltext 不存在：' + item.file));
    }
    if (item.checkedAgainstPdf !== true) {
      problems.push(problem('E_FULLTEXT_UNCHECKED', 'fulltext 未声明已对照原始 PDF：' + item.file));
    }
  }

  for (const table of manifest.tables || []) {
    const tableId = table.id || '(no-id)';
    const metaPath = table.metadata ? path.resolve(base, table.metadata) : '';
    const citPath = table.citations ? path.resolve(base, table.citations) : '';
    if (!metaPath || !fs.existsSync(metaPath)) {
      problems.push(problem('E_META_MISSING', tableId + ': metadata 不存在：' + (table.metadata || '(缺字段)')));
      continue;
    }
    if (!citPath || !fs.existsSync(citPath)) {
      problems.push(problem('E_CIT_MISSING', tableId + ': citations 不存在：' + (table.citations || '(缺字段)')));
      continue;
    }

    let meta;
    let cit;
    try {
      meta = readJson(metaPath);
    } catch (error) {
      problems.push(problem('E_JSON', tableId + ': metadata 解析失败：' + error.message));
      continue;
    }
    try {
      cit = readJson(citPath);
    } catch (error) {
      problems.push(problem('E_JSON', tableId + ': citations 解析失败：' + error.message));
      continue;
    }

    const columns = new Map((meta.columns || []).map((column) => [column.id, column]));
    const rows = (meta.rows || []).map((row) => row.id).filter(isText);

    if (!isText(meta.note) || meta.note.trim().length < MIN_NOTE) {
      problems.push(problem('E_NOTE_MISSING', tableId + ': 表注缺失或过短（需说明条件边界）'));
    }

    const sources = cit.sources || {};
    for (const [key, source] of Object.entries(sources)) {
      if (!isText(source.doi) && !isText(source.url)) {
        problems.push(problem('E_SOURCE_NO_ID', tableId + '/' + key + ': 缺 DOI 或 URL'));
      }
      if (!isText(source.page) && !isText(source.locator)) {
        problems.push(problem('E_SOURCE_NO_LOC', tableId + '/' + key + ': 缺页码或定位（page/locator）'));
      }
      if (!isText(source.quote) || source.quote.trim().length < MIN_QUOTE) {
        problems.push(problem('E_SOURCE_NO_QUOTE', tableId + '/' + key + ': 缺 ≥' + MIN_QUOTE + ' 字原文片段'));
      }
      if (isText(source.file) && !fs.existsSync(path.resolve(base, source.file))) {
        problems.push(problem('E_FILE_MISSING', tableId + '/' + key + ': quote 所在全文不存在：' + source.file));
      }
    }

    const used = new Set();
    const cells = cit.cells || {};
    for (const [rowId, rowCells] of Object.entries(cells)) {
      if (!rows.includes(rowId)) {
        problems.push(problem('E_ROW_UNKNOWN', tableId + ': 引用里的行 ' + rowId + ' 不在 metadata.rows'));
      }
      for (const [columnId, refs] of Object.entries(rowCells || {})) {
        if (!columns.has(columnId)) {
          problems.push(problem('E_COL_UNKNOWN', tableId + ': 引用里的列 ' + columnId + ' 不在 metadata.columns'));
          continue;
        }
        if (!Array.isArray(refs) || refs.length === 0) {
          if (columns.get(columnId).type === 'numeric') {
            problems.push(problem('E_NUM_UNSOURCED', tableId + '/' + rowId + '/' + columnId + ': 数值格没有引用'));
          }
          continue;
        }
        for (const ref of refs) {
          const key = ref && ref.source;
          if (!isText(key) || !sources[key]) {
            problems.push(problem('E_SOURCE_UNKNOWN', tableId + '/' + rowId + '/' + columnId + ': 引用了未登记的文献 ' + (key || '(空)')));
          } else {
            used.add(key);
          }
        }
      }
    }

    for (const rowId of rows) {
      const rowCells = cells[rowId] || {};
      for (const column of meta.columns || []) {
        if (column.type !== 'numeric') continue;
        if (!Array.isArray(rowCells[column.id]) || rowCells[column.id].length === 0) {
          problems.push(problem('E_NUM_CELL_MISSING', tableId + '/' + rowId + '/' + column.id + ': 数值列缺格或缺引用'));
        }
      }
    }

    for (const key of Object.keys(sources)) {
      if (!used.has(key)) {
        problems.push(problem('E_SOURCE_UNUSED', tableId + '/' + key + ': 登记了但没有任何格子引用'));
      }
    }
  }

  return problems;
}

// ---------- selftest ----------

function writeFixture(dir, overrides) {
  const file = (name, data) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(dir, 'fulltext'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'fulltext', 'demo.md'), '# demo fulltext\n\nAt 750 C in dry H2 the ASR was 0.22 ohm cm2.\n', 'utf8');

  const manifest = {
    paper: { id: 'p1', title: 'demo' },
    fulltext: [{ file: 'fulltext/demo.md', checkedAgainstPdf: true }],
    tables: [{ id: 'table-1', metadata: 't1-meta.json', citations: 't1-cit.json' }],
  };
  const meta = {
    tableId: 'table-1',
    title: 'demo table',
    note: 'Entries stay bound to the stated conditions; the +/- is not a cross-study ranking.',
    columns: [
      { id: 'material', label: 'Material', type: 'text' },
      { id: 'temperature', label: 'Temperature', type: 'numeric', unit: 'C', condition: true },
    ],
    rows: [{ id: 'r1' }, { id: 'r2' }],
  };
  const cit = {
    tableId: 'table-1',
    sources: {
      'zotero:AAAA1111': {
        doi: '10.1000/demo',
        page: 'p.1',
        locator: 'L3',
        quote: 'At 750 C in dry H2 the ASR was 0.22 ohm cm2.',
        file: 'fulltext/demo.md',
      },
    },
    cells: {
      r1: { material: [{ source: 'zotero:AAAA1111' }], temperature: [{ source: 'zotero:AAAA1111' }] },
      r2: { material: [{ source: 'zotero:AAAA1111' }], temperature: [{ source: 'zotero:AAAA1111' }] },
    },
  };

  file('manifest.json', overrides && overrides.manifest ? overrides.manifest(manifest) : manifest);
  file('t1-meta.json', overrides && overrides.meta ? overrides.meta(meta) : meta);
  file('t1-cit.json', overrides && overrides.cit ? overrides.cit(cit) : cit);
  return path.join(dir, 'manifest.json');
}

function runCase(name, overrides, expectedCodes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-trace-'));
  const manifestPath = writeFixture(dir, overrides);
  const codes = checkManifest(manifestPath).map((item) => item.code);
  const missing = expectedCodes.filter((code) => !codes.includes(code));
  return { name, ok: missing.length === 0, codes, missing };
}

function selftest() {
  const cases = [
    runCase('good fixture must pass', {}, []),
    runCase('missing DOI must fail', { cit: (cit) => { delete cit.sources['zotero:AAAA1111'].doi; return cit; } }, ['E_SOURCE_NO_ID']),
    runCase('short quote must fail', { cit: (cit) => { cit.sources['zotero:AAAA1111'].quote = 'too short'; return cit; } }, ['E_SOURCE_NO_QUOTE']),
    runCase('unused source must fail', { cit: (cit) => { cit.sources['zotero:BBBB2222'] = { doi: '10.1000/x', page: 'p.2', quote: 'x'.repeat(30) }; return cit; } }, ['E_SOURCE_UNUSED']),
    runCase('numeric cell without citation must fail', { cit: (cit) => { cit.cells.r1.temperature = []; return cit; } }, ['E_NUM_UNSOURCED', 'E_NUM_CELL_MISSING']),
    runCase('unknown source key must fail', { cit: (cit) => { cit.cells.r1.temperature = [{ source: 'zotero:NOPE' }]; return cit; } }, ['E_SOURCE_UNKNOWN']),
    runCase('missing note must fail', { meta: (meta) => { meta.note = ''; return meta; } }, ['E_NOTE_MISSING']),
    runCase('unchecked fulltext must fail', { manifest: (manifest) => { manifest.fulltext[0].checkedAgainstPdf = false; return manifest; } }, ['E_FULLTEXT_UNCHECKED']),
  ];

  let failed = 0;
  for (const item of cases) {
    const status = item.ok ? 'PASS' : 'FAIL';
    console.log(status + '  ' + item.name + (item.ok ? '' : '  missing=' + item.missing.join(',') + ' got=' + item.codes.join(',')));
    if (!item.ok) failed += 1;
  }
  console.log('\nselftest: ' + (cases.length - failed) + '/' + cases.length + ' 通过');
  return failed === 0 ? 0 : 1;
}

// ---------- CLI ----------

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--selftest')) {
    process.exitCode = selftest();
    return;
  }
  const asJson = args.includes('--json');
  let target = args.find((arg) => !arg.startsWith('--'));
  if (args.includes('--example')) target = EXAMPLE;
  if (!target) {
    console.error('用法：node bin/table-trace.cjs <manifest.json> [--json] | --example | --selftest');
    process.exitCode = 2;
    return;
  }
  const problems = checkManifest(target);
  if (asJson) {
    console.log(JSON.stringify({ target, passed: problems.length === 0, count: problems.length, problems }, null, 2));
  } else if (problems.length === 0) {
    console.log('通过：' + target + '（0 个问题）');
  } else {
    console.log('未通过：' + target + '（' + problems.length + ' 个问题）');
    for (const item of problems) console.log('  [' + item.code + '] ' + item.message);
  }
  process.exitCode = problems.length === 0 ? 0 : 1;
}

main(process.argv);
