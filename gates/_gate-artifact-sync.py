#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_gate-artifact-sync.py —— **成品件同步门**：源稿改了、成品没跟着改，必须被抓。

为什么要有这道门（方法论，别删）：
  「源文件全绿 ≠ 成品全绿」（_verify-docx.py 的立门理由）只解决了一半；另一半是
  **时间上的不同步**：改了 .md 却忘了重新生成 .docx —— 此时源稿上一道门全过，
  而交给出版社的成品还是旧内容的。本门把这两件事一起断言。

判据（三条，全部可数）：
  1. **新鲜度**：docx 的 mtime 必须 **≥** md 的 mtime（否则成品落后于源稿 ⇒ FAIL）
  2. **表格数一致**：docx 原生表格数 == 源稿里的 Markdown 表格数（期望值**从源稿推导**，
     不硬编码 —— 源稿合法增表时本门不会误红，但"增了表而成品没变"仍会被抓）
  3. **图片数一致**：docx 嵌入图片数 == 源稿里的 `![...](...)` 个数
  另外沿用 _verify-docx.py 的通用不变量：成品里不得残留 Markdown 标记。

用法：
  python _gate-artifact-sync.py --md <源稿.md> --docx <成品.docx> [--verify _verify-docx.py]
  python _gate-artifact-sync.py --selftest        # 三组夹具：干净必过 / 落后必红 / 计数不符必红
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable
# ⚠ Windows 默认控制台是 GBK：直接打印 ✅/—/⇒ 会 UnicodeEncodeError 崩掉本门
#   （2026-10-13 实测：真件核验前半段已通过，却死在打印那一行）⇒ 强制 UTF-8。
try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass


def norm(t):
    return t.replace('\r\n', '\n')


def derive_expectations(md_text):
    """从源稿推导期望值：Markdown 表格数（分隔行 `|---`）与图片数（`![...](...)`）。"""
    tables = len(re.findall(r'^\s*\|[\s:|-]+\|\s*$', norm(md_text), re.M))
    images = len(re.findall(r'!\[[^\]]*\]\([^)]+\)', md_text))
    return tables, images


def run_verify(verify_py, docx, exp_tables, exp_images):
    # ⚠ 子进程默认按**系统 locale（GBK）**输出，父进程按 utf-8 解码 ⇒ 中文全变 U+FFFD（乱码）。
    #   实测：判定与退出码都对，但门尾行整段损坏 ⇒ 显式给子进程指定 UTF-8 I/O。
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    r = subprocess.run([PY, verify_py, docx, '--expect-tables', str(exp_tables), '--expect-images', str(exp_images)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace', env=env)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


# ── 前提层 vs 断言层：**子进程崩了不等于同步失败** ──────────────────────────
# 事故（2026-10-14 实测）：venv 缺 python-docx ⇒ `_verify-docx.py` 一 import 就崩（rc=1），
# 本门把那次 rc≠0 读成「成品落后于源稿」，于是产出一条**看起来很像真的假发现**
# （"你的 docx 与 md 不同源，投稿前要重新生成"）。真相是环境缺件。
# 判定纪律：崩溃/缺件/参数错 ⇒ 前提层失败（退出码 2），绝不折成断言失败（退出码 1）。
PRE_SIGNS = ('ModuleNotFoundError', 'ImportError', 'Traceback (most recent call last)',
             'No module named', 'command not found', 'SyntaxError')


def classify_verify(code, txt):
    """返回 'ok' | 'assert' | 'pre'。"""
    if code == 0:
        return 'ok'
    if code == 10 or any(s in txt for s in PRE_SIGNS):
        return 'pre'
    return 'assert'


def check(md, docx, verify_py, exp_tables_override=None, exp_images_override=None):
    """返回 (ok, 逐条结果列表, precondition)。

    precondition=True 表示「环境/输入不成立」，调用方必须按前提层失败处理（退出码 2），
    不得折成「成品与源稿不一致」这种断言失败 —— 见 classify_verify 的事故说明。
    """
    out = []
    ok = True
    if not verify_py or not os.path.exists(verify_py):
        return False, [('PRE', '核验器不存在：%s ⇒ 前提层失败（不是同步失败）' % verify_py)], True
    if not os.path.exists(md):
        return False, [('PRE', '源稿不存在：%s ⇒ 前提层失败' % md)], True
    if not os.path.exists(docx):
        return False, [('PRE', '成品不存在：%s ⇒ 前提层失败' % docx)], True

    t_md, t_docx = os.path.getmtime(md), os.path.getmtime(docx)
    fresh = t_docx >= t_md
    ok &= fresh
    out.append(('PASS' if fresh else 'FAIL',
                '新鲜度：成品 %s vs 源稿 %s（%s）' % (
                    time.strftime('%m-%d %H:%M:%S', time.localtime(t_docx)),
                    time.strftime('%m-%d %H:%M:%S', time.localtime(t_md)),
                    '成品不旧于源稿' if fresh else '**成品落后于源稿 ⇒ 必须重新生成**')))

    md_text = open(md, encoding='utf-8', errors='replace').read()
    e_tab, e_img = derive_expectations(md_text)
    if exp_tables_override is not None:
        e_tab = exp_tables_override
    if exp_images_override is not None:
        e_img = exp_images_override
    out.append(('PASS', '期望值（从源稿推导）：表格 %d · 图片 %d' % (e_tab, e_img)))

    code, txt = run_verify(verify_py, docx, e_tab, e_img)
    kind = classify_verify(code, txt)
    if kind == 'pre':
        return False, [('PRE', '核验器未能给出结论（rc=%s）⇒ 前提层失败，**不得读成同步失败**：%s'
                        % (code, txt.strip().splitlines()[-1] if txt.strip() else '（无输出）'))], True
    good = kind == 'ok'
    ok &= good
    for line in txt.split('\n'):
        if re.search(r'表格|图片|Markdown|判定', line):
            out.append(('PASS' if good else 'FAIL', line.strip()))
    return ok, out, False


def selftest():
    """三组夹具：① 干净必过 ② 成品落后必红 ③ 计数不符必红（负控 + 两个注入）。"""
    cases = []
    tmp = tempfile.mkdtemp(prefix='artifactsync-')
    md = os.path.join(tmp, 'src.md')
    docx = os.path.join(tmp, 'out.docx')
    verify = os.path.join(HERE, '_verify-docx.py')
    # 造一个真实小成品：用 _md2docx 生成（这样表格/图片计数是真的）
    fig = os.path.join(tmp, 'fig.png')
    try:
        from PIL import Image
        Image.new('RGB', (40, 30), 'white').save(fig)
    except Exception:
        open(fig, 'wb').write(b'\x89PNG\r\n\x1a\n' + b'\x00' * 60)
    open(md, 'w', encoding='utf-8').write(
        '# T\n\n![Figure 1](%s)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' % fig)
    md2docx = os.path.join(HERE, '_md2docx.py')
    r = subprocess.run([PY, md2docx, md, docx], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if not os.path.exists(docx):
        print('  ⚠ 夹具前提不成立：_md2docx 未能生成成品（%s）⇒ 自检跳过' % (r.stderr or '')[:80])
        return 2

    # ① 干净
    os.utime(docx, (time.time(), time.time()))
    os.utime(md, (time.time() - 10, time.time() - 10))
    ok, rows, pre = check(md, docx, verify)
    cases.append(('① 干净件必须过', ok and not pre, ok and not pre))
    # ② 成品落后（把源稿 mtime 拨到成品之后）
    os.utime(md, (time.time() + 5, time.time() + 5))
    ok2, rows2, pre2 = check(md, docx, verify)
    cases.append(('② 成品落后必红（断言失败，非前提层）', (not ok2) and (not pre2), not ok2))
    os.utime(md, (time.time() - 10, time.time() - 10))
    # ③ 计数不符（故意要 99 张表 —— 检查路径必须报红）
    ok3, rows3, pre3 = check(md, docx, verify, exp_tables_override=99)
    cases.append(('③ 计数不符必红（断言失败，非前提层）', (not ok3) and (not pre3), not ok3))
    # ④ 前提层：核验器不存在 ⇒ 必须是「前提层失败」，**不得读成同步失败**
    #    （2026-10-14 事故：venv 缺 python-docx 让核验器崩，本门却报「成品落后」⇒ 假发现）
    ok4, rows4, pre4 = check(md, docx, os.path.join(HERE, '__no_such_verifier__.py'))
    cases.append(('④ 核验器缺失 ⇒ 前提层失败（不是同步失败）', (not ok4) and pre4, True))

    print('════ _gate-artifact-sync --selftest ════')
    bad = 0
    for name, got, want in cases:
        good = (got == want)
        if not good:
            bad += 1
        print('  %s %s' % ('✅' if good else '❌', name))
    print('\n  %s' % ('✅ 夹具 %d/%d 判别正确（1 干净作负控 + 2 注入 + 1 前提层）' % (len(cases), len(cases)) if not bad
                      else '❌ 夹具判别失败 %d/%d —— 本门当前不可信' % (bad, len(cases))))
    shutil.rmtree(tmp, ignore_errors=True)
    return 2 if bad else 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--md')
    ap.add_argument('--docx')
    ap.add_argument('--verify', default=os.path.join(HERE, '_verify-docx.py'))
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if not a.md or not a.docx:
        print('用法：--md <源稿.md> --docx <成品.docx> ｜ --selftest')
        sys.exit(3)
    ok, rows, pre = check(a.md, a.docx, a.verify)
    print('════ 成品件同步门 ════')
    for tag, line in rows:
        print('  %s %s' % (tag, line))
    if pre:
        print('\n  判定：**前提层失败**（退出码 2）—— 环境或输入不成立；'
              '这不是「成品与源稿不一致」，不要照着它去重新生成成品。')
        sys.exit(2)
    print('\n  判定：%s' % ('通过（成品与源稿一致）' if ok else '不通过 —— 见上面 FAIL 行'))
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
