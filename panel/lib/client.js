// dsh-paper-keys —— 客户端半体（Client half · 面板设置节）
//
// 形态：`window.__ModuleLoader__` 包壳 + **纯具名导出**（apply / inject），与本机既有插件（quote-reply /
//   hot-refresh / auto-continue）同一套写法。宿主侧 API 口径取自真实契约：
//   · `ctx.slots.inject(slot, cb)` + `ctx.slots.register({name,id,order,label}, Component)`（Slots 探针实测）
//   · `settings.section` 是 list 槽，注册项＝{id, order, label}，**replaceRisk: none**（新增一节，不替换任何人）
//   · 与宿主通信走**同源 fetch**（本包宿主半体注册的 /api/paper-keys/*）—— 这是本机插件的既有做法
//
// 安全（用户硬要求）：
//   · 面板**只显示掩码**；明文只在"用户刚敲进去的那一次"存在于组件内，提交后立刻清空，绝不回显
//   · apply 全程护栏：`ctx` 残缺 / slots 缺失 / fetch 失败 ⇒ 只记日志与占位文案，**绝不抛**（不许白屏）
//   · 不注册任何路由、不覆盖任何既有槽位（只往 settings.section 这一列表里加自己一格）
window.__ModuleLoader__.load({
  id: 'dsh-paper-keys',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');
    var h = React.createElement;

    var SECTION_ID = 'paper-keys';
    var SECTION_ORDER = 36;               // 介于 im-assistant(28) 与 market(40) 之间
    var SECTION_LABEL = '论文插件外置 key 连接器';
    var API = '/api/paper-keys';
    var CSS_ID = 'dsh-paper-keys/styles';
    var VERSION = '0.1.0';

    var CSS = [
      '.pk-wrap{box-sizing:border-box;padding:14px 16px;color:var(--dsw-alias-label-primary,inherit);font-size:13px;line-height:20px}',
      '.pk-title{font-size:15px;font-weight:600;margin:0 0 4px}',
      '.pk-sub{color:var(--dsw-alias-label-tertiary,inherit);font-size:12px;margin:0 0 12px}',
      '.pk-card{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:var(--dsw-radius-md,8px);margin:0 0 8px;overflow:hidden}',
      '.pk-row{display:flex;align-items:center;gap:8px;padding:9px 10px}',
      '.pk-name{font-weight:500;flex:0 0 auto}',
      '.pk-chip{flex:0 0 auto;font-size:11px;padding:1px 7px;border-radius:999px;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));color:var(--dsw-alias-label-secondary,inherit)}',
      '.pk-chip.on{color:var(--dsw-alias-state-business-primary,#3b82f6);border-color:currentColor}',
      '.pk-chip.off{color:var(--dsw-alias-label-tertiary,inherit)}',
      '.pk-mask{flex:1 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,inherit);font-family:ui-monospace,Consolas,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pk-acts{flex:0 0 auto;display:flex;gap:6px}',
      '.pk-btn{border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;font-size:12px;padding:3px 9px}',
      '.pk-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.pk-btn:disabled{opacity:.5;cursor:default}',
      '.pk-btn.danger:hover{color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.pk-form{display:flex;gap:6px;padding:0 10px 10px}',
      '.pk-input{flex:1 1 auto;min-width:0;border:.5px solid var(--dsw-alias-border-l2,rgba(127,127,127,.35));border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;padding:4px 8px;font-size:12px;font-family:ui-monospace,Consolas,monospace}',
      '.pk-note{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;line-height:16px;margin:10px 0 0}',
      '.pk-msg{font-size:12px;margin:8px 0 0}',
      '.pk-msg.bad{color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.pk-msg.good{color:var(--dsw-alias-state-business-primary,#3b82f6)}',
      '.pk-path{font-family:ui-monospace,Consolas,monospace;word-break:break-all}',
    ].join('\n');

    function ensureCss() {
      try {
        if (typeof document === 'undefined') return;
        if (document.getElementById(CSS_ID)) return;
        var s = document.createElement('style');
        s.id = CSS_ID;
        s.textContent = CSS;
        (document.head || document.documentElement).appendChild(s);
      } catch (e) { /* 样式失败不影响功能 */ }
    }

    // ───────────────────────── 纯函数（可夹具，无副作用）─────────────────────────

    function stateOf(it) {
      if (!it) return '未录入';
      if (!it.present) return '未录入';
      return it.enabled === false ? '已停用（保留）' : '已连接';
    }

    function actionBody(provider, extra) {
      var o = { provider: provider };
      if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
      return JSON.stringify(o);
    }

    function post(path, body) {
      return fetch(API + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status + '（响应不是 JSON）' } }) })
        .catch(function (e) { return { ok: false, error: '请求失败：' + String((e && e.message) || e) } });
    }

    function getList() {
      return fetch(API + '/list', { method: 'GET' })
        .then(function (r) { return r.json().catch(function () { return { ok: false, error: 'HTTP ' + r.status } }) })
        .catch(function (e) { return { ok: false, error: '请求失败：' + String((e && e.message) || e) } });
    }

    // ───────────────────────── 视图 ─────────────────────────

    function ProviderRow(props) {
      var it = props.it;
      var st = React.useState(false);            // 折叠的录入框
      var open = st[0], setOpen = st[1];
      var ks = React.useState('');               // 明文只在这一处、且提交后立刻清空
      var key = ks[0], setKey = ks[1];
      var bs = React.useState('');               // 忙碌标记
      var busy = bs[0], setBusy = bs[1];

      var state = stateOf(it);
      var run = function (path, extra, label) {
        setBusy(label);
        return post(path, actionBody(it.id, extra)).then(function (r) {
          setBusy('');
          props.onResult(r, label);
          return r;
        });
      };

      var acts = [];
      if (!it.present) {
        acts.push(h('button', { key: 'add', className: 'pk-btn', type: 'button', disabled: !!busy, onClick: function () { setOpen(!open) } }, open ? '取消' : '录入 token'));
      } else {
        acts.push(h('button', { key: 'test', className: 'pk-btn', type: 'button', disabled: !!busy, onClick: function () { run('/test', null, '连接测试') } }, busy === '连接测试' ? '测试中…' : '连接'));
        acts.push(h('button', { key: 'tog', className: 'pk-btn', type: 'button', disabled: !!busy, onClick: function () { run(it.enabled === false ? '/enable' : '/disable', null, it.enabled === false ? '启用' : '停用') } }, it.enabled === false ? '启用' : '停用'));
        acts.push(h('button', { key: 'upd', className: 'pk-btn', type: 'button', disabled: !!busy, onClick: function () { setOpen(!open) } }, '换 key'));
        acts.push(h('button', { key: 'del', className: 'pk-btn danger', type: 'button', disabled: !!busy, onClick: function () { run('/remove', null, '删除') } }, '删除'));
      }

      var form = open ? h('div', { className: 'pk-form' },
        h('input', {
          className: 'pk-input', type: 'password', value: key, placeholder: '粘贴 token（只提交到本机，不写日志、不写仓库）',
          autoComplete: 'off', spellCheck: false,
          onChange: function (e) { setKey(e.target.value) },
          onKeyDown: function (e) { if (e.key === 'Enter' && key) submit() },
        }),
        h('button', {
          className: 'pk-btn', type: 'button', disabled: !key || !!busy,
          onClick: function () { submit() },
        }, busy === '保存' ? '保存中…' : '保存'),
      ) : null;

      function submit() {
        var extra = { key: key, confirm_overwrite: true };
        run('/set', extra, '保存').then(function (r) { if (r && r.ok) { setKey(''); setOpen(false) } });
      }

      return h('div', { className: 'pk-card' },
        h('div', { className: 'pk-row' },
          h('span', { className: 'pk-name' }, it.label || it.id),
          h('span', { className: 'pk-chip ' + (state === '已连接' ? 'on' : 'off') }, state),
          h('span', { className: 'pk-mask', title: it.key_masked || '' }, it.key_masked || (it.present ? '（已停用，凭据保留）' : '（未录入）')),
          h('span', { className: 'pk-acts' }, acts),
        ),
        form,
        (it.last_test && it.last_test.at) ? h('div', { className: 'pk-note' },
          '上次测试：' + (it.last_test.ok ? '✔ 连通' : '✘ 不通') + ' · ' + String(it.last_test.at) + (it.last_test.note ? (' · ' + it.last_test.note) : ''),
        ) : null,
      );
    }

    function PaperKeysSection() {
      var vs = React.useState(null);
      var view = vs[0], setView = vs[1];
      var ms = React.useState(null);
      var msg = ms[0], setMsg = ms[1];

      var refresh = function () {
        return getList().then(function (v) { setView(v); return v });
      };
      React.useEffect(function () { refresh(); }, []);

      var onResult = function (r, label) {
        if (r && r.ok) {
          setMsg({ kind: 'good', text: label + '成功' + (r.masked ? ('：' + r.masked) : '') });
          if (r.view) setView(r.view); else refresh();
        } else {
          setMsg({ kind: 'bad', text: label + '未成功：' + ((r && r.error) || '未知原因') });
        }
      };

      if (!view) return h('div', { className: 'pk-wrap' }, h('p', { className: 'pk-title' }, SECTION_LABEL), h('p', { className: 'pk-sub' }, '正在读取本机凭据状态…'));
      if (view.ok === false && view.wired === false) {
        return h('div', { className: 'pk-wrap' },
          h('p', { className: 'pk-title' }, SECTION_LABEL),
          h('p', { className: 'pk-msg bad' }, view.reason || '未接线'),
          h('p', { className: 'pk-note' }, '未接线时本面板**不改动任何文件**：装上 paper-studio 或设好 DSH_PAPER_STUDIO_ROOT 后回来刷新即可。'),
        );
      }

      return h('div', { className: 'pk-wrap' },
        h('p', { className: 'pk-title' }, SECTION_LABEL),
        h('p', { className: 'pk-sub' }, '在这里录入各家模型的 token：**凭据只写本机**（不进仓库、不进日志、不在对话里回显）；面板只显示掩码。启用与否同时决定 CLI（`studio model …`）能不能用到它。'),
        (view.providers || []).map(function (it) { return h(ProviderRow, { key: it.id, it: it, onResult: onResult }) }),
        view.file_ok === false ? h('p', { className: 'pk-msg bad' }, '凭据文件有问题：' + (view.file_reason || '不可读') + '（内容原样保留，未改动）') : null,
        msg ? h('p', { className: 'pk-msg ' + msg.kind }, msg.text) : null,
        h('p', { className: 'pk-note' },
          '存储位置：', h('span', { className: 'pk-path' }, String(view.path || '（未知）')),
          view.updated_at ? h('span', null, ' · 最近写入 ' + String(view.updated_at)) : null,
        ),
        h('p', { className: 'pk-note' }, '规则：**停用优先于环境变量** —— 这里点停用，就等于停用（环境变量里的同名 key 不会被偷偷拿来用）；要用回环境变量请删掉本面板里的这一条。'),
      );
    }

    // ───────────────────────── apply（护栏：任何异常都不许冒泡到宿主）─────────────────────────

    var inject = ['slots'];

    function safe(fn, label) {
      try { return fn() } catch (e) {
        try { console.error('[paper-keys] ' + label + ' 失败：' + String((e && e.message) || e)) } catch (_) { /* noop */ }
        return null;
      }
    }

    function apply(ctx) {
      safe(ensureCss, '注入样式');
      var slots = safe(function () { return ctx && ctx.slots }, 'ctx.slots');
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        try { console.error('[paper-keys] ctx.slots 不可用 ⇒ 本插件不注册（宿主不受影响，不会白屏）') } catch (_) { /* noop */ }
        return function () {};
      }
      var disposer = safe(function () {
        return slots.inject('settings.section', function () {
          return slots.register({ name: 'settings.section', id: SECTION_ID, order: SECTION_ORDER, label: function () { return SECTION_LABEL } }, PaperKeysSection);
        });
      }, '注册设置节');
      return function () { try { if (typeof disposer === 'function') disposer() } catch (_) { /* noop */ } };
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__paperKeys = {
      VERSION: VERSION, SECTION_ID: SECTION_ID, SECTION_LABEL: SECTION_LABEL, API: API, CSS: CSS,
      stateOf: stateOf, actionBody: actionBody, PaperKeysSection: PaperKeysSection,
    };
    return module.exports;
  },
});
