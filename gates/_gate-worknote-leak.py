#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_gate-worknote-leak.py —— **工作注记泄漏门（L-1）**：主稿里不得混进工作过程标记。

立门理由（方法论，别删）：
  第一稿的真实事故：交给出版社的 **Word 手稿正文里混进了 11 处工作标记**
  （`⚠` / `Must be confirmed` / `TO BE COMPLETED` / `Verification …`）。
  这些标记在写作期是**合法的工作痕迹**，在投稿期是**不合格的正文**——
  所以判据不是「有没有写过注记」，而是「注记有没有越界进正文」。
  主稿与工作注记**物理分开**维护（见 L-1 做法），本门负责在投稿前把它扫出来。

判据（可数，不靠肉眼）：
  · 正文（含 Markdown 表格单元格）不得出现工作注记标记表里的任何一项；
  · 命中即逐条报 **行号 + 标记 + 原文片段**（行号供 report 子命令直接消费）；
  · 给了 --docx 时**同时扫成品件**（docx 里没有行号，报段落号）——
  L-1 的事故正是发生在成品件里，只扫 md 会漏。

用法：
  python _gate-worknote-leak.py --draft <稿.md> [--docx <成品.docx>] [--json] [--quiet]
  python _gate-worknote-leak.py --selftest        # 夹具：干净必过 / 注释标记必红 / 注入必红

退出码：0 通过 / 1 有泄漏（逐条带行号） / 2 前提层失败（文件不存在或参数错）
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile

try:  # Windows 控制台默认 GBK：不强制 UTF-8 会在打印中文时崩（本仓已踩过）
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

# ── 标记表：每条给 (名字, 正则, 说明)。**大小写与上下文敏感**，宁可窄也不要误报正文 ──
# 原则：只收「写作过程标记」，不收正常的学术用语。
#   · `Verification` 单字太宽（正文里 "verification of the model" 合法）⇒ 只在**行首**
#     或紧跟冒号/破折号、或包在 ** 里时才算标记（事故原文正是行首的 "Verification …"）。
MARKERS = [
    ("警告符", re.compile(r"⚠"), "工作注记常用的警告符"),
    ("待确认(英)", re.compile(r"Must be confirmed", re.I), "L-1 事故原文之一"),
    ("待完成(英)", re.compile(r"TO BE COMPLETED", re.I), "L-1 事故原文之一"),
    ("核查标记(英)", re.compile(r"(?m)^\s*(?:[*_]{0,2})(Verification|Verif(?:y|ied))\b\s*[:：\-—]"), "L-1 事故原文之一（只在行首/带冒号时判定，避免误报正文里的 verification）"),
    ("待办(英)", re.compile(r"\b(TODO|TBD|FIXME|XXX)\b"), "开发/写作待办标记"),
    ("尖括号占位", re.compile(r"<<<|>>>|<<[^<>]{1,40}>>"), "未替换的占位形状"),
    ("花括号占位", re.compile(r"\{\{[^{}]{1,40}\}\}"), "未替换的模板占位"),
    ("待补/待确认(中)", re.compile(r"待\s*(?:补|填|确认|核实|定|查|更新|完成)"), "中文工作注记"),
    ("注记字样(中)", re.compile(r"工作注记|内部注记|写作注记|工作元数据|稿件元数据|留给作者|作者确认|待人工确认|需人工确认|草稿注"),
     "把工作注记的标题词写进了正文（真稿实测形状：`工作元数据（非稿件内容，投稿时整段删除）`、`待人工确认：`）"),
    ("方括号待办(中)", re.compile(r"\[\s*待[^\]]{0,20}\]"), "方括号待办占位"),
]

# 负控白名单：这些行即便命中也不报（正文里合法的用法）。目前只放「参考文献里的 XXX 期刊缩写」类；留空也合法。
WHITELIST_LINE = [
    re.compile(r"^\s*\[\d+\]"),  # 参考文献条目行（引用里可能出现 XXX 之类）
]


def scan_text(text, origin, base_line=1):
    """返回 hits 列表；行号 = base_line + 行内序号 - 1。

    `in_comment` 标记该命中是否位于 HTML 注释体（`<!-- … -->`）内 —— 两者性质不同：
      · 注释体内：渲染时不显示、本仓 md→docx 实测也**不带出**，但按约定投稿前仍应整段删除；
      · 正文字：会被读者/审稿人看见，属必须修。
    门必须把这两类分开报，否则就是喊狼来了（2026-10-14 对真稿实测得到的教训）。
    """
    hits = []
    lines = text.replace('\r\n', '\n').split('\n')
    in_comment = False
    for i, line in enumerate(lines, start=base_line):
        starts_in_comment = in_comment
        # 同一行可能开又闭（<!-- ... -->）：按出现顺序推进状态
        toks = re.findall(r"<!--|-->", line)
        for t in toks:
            in_comment = (t == '<!--') if t == '<!--' else False
        if any(w.search(line) for w in WHITELIST_LINE):
            continue
        for name, rx, why in MARKERS:
            m = rx.search(line)
            if m:
                hits.append({
                    "where": origin,
                    "line": i,
                    "marker": name,
                    "hit": m.group(0)[:40],
                    "why": why,
                    "in_comment": bool(starts_in_comment),
                    "text": line.strip()[:100],
                })
    return hits


def scan_docx(path):
    """扫成品件正文 + 表格单元格。docx 没有源行号，报段落序号（1 基）。"""
    try:
        from docx import Document
    except Exception as e:  # 前提层：解释器里没有 python-docx
        return None, "python-docx 不可用（%s）" % e
    hits = []
    d = Document(path)
    for idx, p in enumerate(d.paragraphs, start=1):
        if not p.text.strip():
            continue
        for name, rx, why in MARKERS:
            m = rx.search(p.text)
            if m:
                hits.append({"where": "docx段落#%d" % idx, "line": idx, "marker": name,
                             "hit": m.group(0)[:40], "why": why, "text": p.text.strip()[:100]})
    for ti, t in enumerate(d.tables, start=1):
        for ri, row in enumerate(t.rows, start=1):
            for ci, cell in enumerate(row.cells, start=1):
                for name, rx, why in MARKERS:
                    m = rx.search(cell.text)
                    if m:
                        hits.append({"where": "docx表格%d.r%d.c%d" % (ti, ri, ci), "line": ti,
                                     "marker": name, "hit": m.group(0)[:40], "why": why,
                                     "text": cell.text.strip()[:100]})
    return hits, ""


def check(draft, docx=None, allow_comments=False):
    """返回 (code, payload)。code: 0 通过 / 1 有泄漏 / 2 前提层失败。

    allow_comments=True：注解体内的命中降级为「提示」（不计入阻断），用于作者有意把
    工作元数据留到最终导出前的流程；信息仍逐条保留在 comment_hits 里，**不丢**。
    """
    if not draft or not os.path.exists(draft):
        return 2, {"error": "源稿不存在：%s" % draft}
    all_hits = scan_text(open(draft, encoding='utf-8', errors='replace').read(), "md")
    notes = []
    if docx:
        if not os.path.exists(docx):
            return 2, {"error": "成品件不存在：%s" % docx}
        dh, err = scan_docx(docx)
        if dh is None:
            notes.append("成品件未扫：%s" % err)
        else:
            for h in dh:
                h["in_comment"] = False
            all_hits += dh
    blocking = [h for h in all_hits if not h.get("in_comment")]
    comments = [h for h in all_hits if h.get("in_comment")]
    # 默认**严格**：注释体内的命中同样算待办（作者自己的约定就是「投稿时整段删除」）；
    # --allow-comments 才降级为提示。两类始终分开列，不混成一句「越界进正文」。
    code = 1 if (blocking or (comments and not allow_comments)) else 0
    return code, {"schema": "worknote_leak.v1", "draft": draft, "docx": docx or "",
                  "count": len(blocking), "hits": blocking,
                  "comment_count": len(comments), "comment_hits": comments,
                  "allow_comments": bool(allow_comments), "notes": notes,
                  "verdict": "FAIL" if code else "PASS"}


def selftest():
    tmp = tempfile.mkdtemp(prefix='worknote-')
    cases = []
    clean = os.path.join(tmp, 'clean.md')
    open(clean, 'w', encoding='utf-8').write(
        "# 标题\n\n本文研究了电池 SOH 的跨温度迁移问题，verification of the model 在正文里是合法用法。\n\n"
        "The results are consistent with [1].\n\n[1] Author A. XXX Journal, 2024.\n")
    dirty = os.path.join(tmp, 'dirty.md')
    open(dirty, 'w', encoding='utf-8').write(
        "# 标题\n\n第一段正常。\n\n⚠ 这里要核实\n\nTO BE COMPLETED: 补实验\n\n待补：温度口径\n\nVerification: 数据来源待核\n")
    # ① 干净件必须过（负控：防本门永远红）
    c1, p1 = check(clean)
    cases.append(('① 干净件必须过（负控）', c1 == 0 and p1["count"] == 0, "code=%s count=%s" % (c1, p1.get("count"))))
    # ② 注入 4 个标记必须红，且逐条带行号
    c2, p2 = check(dirty)
    lines = sorted({h["line"] for h in p2.get("hits", [])})
    cases.append(('② 注入标记必红且带行号', c2 == 1 and p2["count"] >= 4 and len(lines) >= 4, "code=%s count=%s lines=%s" % (c2, p2.get("count"), lines)))
    # ③ 必失败：行首 + 冒号的 Verification 必须被抓（L-1 事故的真实形状）
    #    ⚠ 本夹具本身踩过一次：初版写成「Verification of the dataset was done.」——
    #      那是**正文句**，不是工作注记；门不报它是**对的**。夹具必须贴着事故形状写。
    vf = os.path.join(tmp, 'v.md')
    open(vf, 'w', encoding='utf-8').write("Verification: dataset provenance still pending\n")
    c3, p3 = check(vf)
    cases.append(('③ 行首 Verification: 必红（事故形状）', c3 == 1, "code=%s count=%s" % (c3, p3.get("count"))))
    # ④ 必失败（反向控制）：行首的**正文句** Verification of … 不得误报 —— 这条规则最容易过宽
    vf2 = os.path.join(tmp, 'v2.md')
    open(vf2, 'w', encoding='utf-8').write("Verification of the dataset was done on the full mirror.\n")
    c4b, p4b = check(vf2)
    cases.append(('④ 行首正文句 Verification of… 不得误报', c4b == 0, "code=%s count=%s" % (c4b, p4b.get("count"))))
    # ⑤ 必失败：正文里的 verification 小写不得误报（防过宽）
    low = os.path.join(tmp, 'low.md')
    open(low, 'w', encoding='utf-8').write("We performed verification of the model on the test set.\n")
    c4, p4 = check(low)
    cases.append(('⑤ 正文小写 verification 不得误报', c4 == 0, "code=%s count=%s" % (c4, p4.get("count"))))
    # ⑥ 必失败：文件不存在 ⇒ 前提层失败 2（不许当通过）
    c5, _ = check(os.path.join(tmp, '__nope__.md'))
    cases.append(('⑥ 缺文件 ⇒ 退出码 2（前提层）', c5 == 2, "code=%s" % c5))
    # ⑦ 注释体内命中：必须与正文命中区分（真稿实测形状），且 --allow-comments 只降级不丢信息
    com = os.path.join(tmp, 'com.md')
    open(com, 'w', encoding='utf-8').write("<!--\n工作元数据（非稿件内容，投稿时整段删除）\n本轮改动：待人工确认\n-->\n\n# Title\n\nBody text.\n")
    c7, p7 = check(com)
    c7b, p7b = check(com, allow_comments=True)
    cases.append(('⑦ 注释体内命中：默认仍阻断且标 in_comment',
                  c7 == 1 and p7["count"] == 0 and p7["comment_count"] >= 1 and all(h["in_comment"] is True for h in p7["comment_hits"]),
                  "code=%s block=%s comment=%s" % (c7, p7.get("count"), p7.get("comment_count"))))
    cases.append(('⑧ --allow-comments 只降级不丢信息',
                  c7b == 0 and p7b["comment_count"] == p7["comment_count"] and p7b["comment_count"] >= 1,
                  "code=%s comment=%s（严格时 %s）" % (c7b, p7b.get("comment_count"), p7.get("comment_count"))))
    shutil.rmtree(tmp, ignore_errors=True)
    print("════ _gate-worknote-leak --selftest ════")
    bad = 0
    for name, ok, detail in cases:
        if not ok:
            bad += 1
        print("  %s %s%s" % ("✔" if ok else "✘", name, "" if ok else "  ← " + detail))
    print("\n  %s" % ("✔ 夹具 %d/%d 判别正确（1 负控 + 3 注入 + 1 前提）" % (len(cases), len(cases)) if not bad
                      else "✘ 夹具失败 %d/%d —— 本门当前不可信" % (bad, len(cases))))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--draft')
    ap.add_argument('--docx')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--quiet', action='store_true')
    ap.add_argument('--allow-comments', action='store_true',
                    help='HTML 注释体内的命中降级为提示（信息保留在 comment_hits；正文命中照旧阻断）')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if not a.draft:
        print('用法：--draft <稿.md> [--docx <成品.docx>] [--json] [--allow-comments] ｜ --selftest')
        sys.exit(2)
    code, payload = check(a.draft, a.docx, allow_comments=a.allow_comments)
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        sys.exit(code)
    if code == 2:
        print("前提层失败：%s" % payload.get("error"))
        sys.exit(2)
    print("════ 工作注记泄漏门（L-1） ════")
    print("  扫描：%s%s" % (payload["draft"], (" + " + payload["docx"]) if payload.get("docx") else "（仅源稿）"))
    for n in payload.get("notes", []):
        print("  ⚠ %s" % n)
    for h in payload["hits"]:
        print("  %s:%s  [%s] %s" % (h["where"], h["line"], h["marker"], h["text"]))
    if payload["count"]:
        print("\n  判定：失败 —— 共 %d 处工作注记越界进正文；主稿与工作注记必须物理分开（L-1）" % payload["count"])
    elif payload.get("comment_count") and not payload.get("allow_comments"):
        print("\n  判定：失败（**仅注释体内**）—— 正文干净，但有 %d 处工作注记留在注释块里；"
              "按作者自己的约定（如「投稿时整段删除」）仍属投稿前待办。"
              "若你的流程允许留到最终导出，加 --allow-comments 可只提示不阻断。" % payload["comment_count"])
    else:
        print("  判定：通过（正文里没有工作注记标记）")
    if payload.get("comment_count"):
        print("\n  ── 注释体内的命中 %d 处（性质不同，单独列）──" % payload["comment_count"])
        for h in payload["comment_hits"][:10]:
            print("  %s:%s  [%s] %s" % (h["where"], h["line"], h["marker"], h["text"]))
        print("  说明：注释体渲染时不显示、本仓 md→docx 实测不带出；按作者自己的约定"
              "（如「投稿时整段删除」）仍属投稿前待办。用 --allow-comments 可只提示不阻断。")
    sys.exit(code)


if __name__ == '__main__':
    main()
