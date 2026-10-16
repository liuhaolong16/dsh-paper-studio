#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_gate-declaration-set.py —— **声明四件套门（L-2）**：投稿硬项缺一即红。

立门理由（方法论，别删）：
  声明是**投稿硬项**，不是礼貌性附件：竞争利益 / CRediT 作者贡献 / 资助（或"无资助"）/
  **AI 使用声明**（Elsevier 自 2023 起硬性要求）。第一稿的经验（L-2）是：
  漏了会被编辑部退回补充，白白多一轮往返。
  本门只查**四段在不在**，不查写得对不对（后者是人读项）——把"存在性"机械化，
  是为了让人的注意力留给内容。

**红线（写进本门，防被误用）**：本门只做"有没有"，**不提供任何规避 AI 检测的措辞**；
  AI 使用声明必须写**实际使用范围**，禁"未用 AI"式不实声明。

判据（四段各自的关键词组，中英双语；命中任一组即算该段存在）：
  1. 竞争利益：competing interest(s) / conflict(s) of interest / declaration of interest / 竞争利益 / 利益冲突
  2. 作者贡献：CRediT / author contribution(s) / authorship statement / 作者贡献
  3. 资助：funding / financial support / grant / 资助 / 基金 / 无资助(no specific funding)
  4. AI 使用声明：generative AI / AI-assisted / AI use / large language model + 声明语境词
     （declaration / statement / 声明 / 使用 / assistance）。**只写 "AI" 两个字不算**——
     必须出现生成式 AI 语境词，避免正文里聊 AI 的方法段被误当声明。

用法：
  python _gate-declaration-set.py --draft <稿.md> [--docx <成品.docx>] [--json]
  python _gate-declaration-set.py --selftest     # 夹具：四段齐全必过 / 缺 AI 必红 / 缺两段必红 / 空文件必红不崩

退出码：0 四段齐全 / 1 有缺段（逐段列出缺哪个） / 2 前提层失败（文件不存在或参数错）
"""
import argparse
import json
import os
import re
import shutil
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

DECLS = [
    ("竞争利益", [
        re.compile(r"competing\s+interests?", re.I),
        re.compile(r"conflicts?\s+of\s+interest", re.I),
        re.compile(r"declaration\s+of\s+(?:competing\s+)?interests?", re.I),
        re.compile(r"竞争利益|利益冲突|无利益冲突"),
    ]),
    ("作者贡献", [
        re.compile(r"CRediT", re.I),
        re.compile(r"author\s+contributions?", re.I),
        re.compile(r"authorship\s+statement", re.I),
        re.compile(r"作者贡献|贡献声明"),
    ]),
    ("资助", [
        re.compile(r"\bfunding\b", re.I),
        re.compile(r"financial\s+support", re.I),
        re.compile(r"\bgrant\b", re.I),
        re.compile(r"资助|基金|无资助|无经费"),
    ]),
    ("AI使用声明", [
        # 必须同时出现「生成式 AI 语境词」与「声明语境词」，避免把方法段的 AI 讨论当声明
        re.compile(r"(generative\s+AI|AI[- ]assisted|AI\s+use|AI\s+usage|large\s+language\s+model|LLM|ChatGPT|生成式\s*AI|人工智能使用|大语言模型)"
                   r"[^\n]{0,120}?(declaration|statement|声明|使用|辅助|assistance)", re.I),
        re.compile(r"(declaration|声明)[^\n]{0,60}?(generative\s+AI|AI[- ]assisted|AI\s+use|large\s+language\s+model|生成式\s*AI|人工智能|大语言模型)", re.I),
    ]),
]


WEAK_LINE = re.compile(r"关键词|keywords", re.I)


def _is_weak(ln):
    """「关键词行」等各种并列短项行：同一行里凑巧同时出现 AI 词与「使用」二字，但它不是声明。

    ★ 这条修的是一个真实误报类：中文稿的「关键词：大语言模型智能体；…；工具使用」被 pattern 1
      命中（LLM…使用 同处 120 字内），于是**真声明段（# 生成式人工智能使用声明）反而没被采用** ——
      判定侥幸正确，证据行错位。现在：弱证据只在没有强证据时**显示**，**不计入「有」**。
    """
    return bool(WEAK_LINE.search(ln)) or ln.count('；') >= 2 or ln.count(';') >= 2


def scan(text):
    """返回 {段名: {best, weak_only, weak}}：best = 择优后的强证据（带行号），不再「首个匹配即定」。"""
    lines = text.splitlines()
    found = {}
    for name, pats in DECLS:
        strong, weak = [], []
        for pi, rx in enumerate(pats):
            for i, ln in enumerate(lines, 1):
                m = rx.search(ln)
                if not m:
                    continue
                item = {"evidence": m.group(0)[:80].strip(), "line": i, "pattern": pi + 1,
                        "text": ln.strip()[:120]}
                (weak if _is_weak(ln) else strong).append(item)
        # 择优（v2 修正）：**小标题 > 声明方向(pattern2) > 含声明名词 > 更短的行**。
        #   ★ 第一版用「匹配越长越好」，结果中文稿选到了正文里一段含「使用」的长句（L51），
        #     真声明小标题（# 生成式人工智能使用声明）反而落选 —— 声明通常是**短标题**，
        #     不是长句；这条启发式因此反过来写。
        def _rank(c):
            ln = c["text"]
            is_head = bool(re.match(r"^\s{0,3}#{1,6}\s", ln)) or (len(ln) <= 40 and bool(re.search(r"声明|statement|declaration", ln, re.I)))
            has_noun = bool(re.search(r"声明|declaration|statement", ln, re.I))
            return (1 if is_head else 0, 1 if c["pattern"] == 2 else 0, 1 if has_noun else 0, -len(ln))
        strong.sort(key=_rank, reverse=True)
        found[name] = {"best": (strong[0] if strong else None),
                       "weak_only": (not strong and bool(weak)), "weak": weak[:2]}
    return found


def check(draft, docx=None):
    if not draft or not os.path.exists(draft):
        return 2, {"error": "源稿不存在：%s" % draft}
    text = open(draft, encoding='utf-8', errors='replace').read()
    notes = []
    if docx:
        if not os.path.exists(docx):
            return 2, {"error": "成品件不存在：%s" % docx}
        try:
            from docx import Document
            d = Document(docx)
            text += "\n" + "\n".join(p.text for p in d.paragraphs)
            text += "\n" + "\n".join(c.text for t in d.tables for r in t.rows for c in r.cells)
        except Exception as e:
            notes.append("成品件未扫（python-docx 不可用或读取失败）：%s" % e)
    found = scan(text)
    missing = [k for k, v in found.items() if not v["best"]]
    weak_only = [k for k, v in found.items() if v["weak_only"]]
    present = {k: v["best"] for k, v in found.items() if v["best"]}
    for k in weak_only:
        notes.append("%s：只在「关键词/并列短项行」上出现过迹象，**不算声明**（可能是关键词行凑巧命中）"
                     "—— 若确已写声明，请把它写成独立段落或小标题。" % k)
    return (1 if missing else 0), {"schema": "declaration_set.v2", "draft": draft, "docx": docx or "",
                                  "present": present, "missing": missing, "weak_only": weak_only,
                                  "weak_evidence": {k: found[k]["weak"] for k in weak_only},
                                  "notes": notes,
                                  "verdict": "FAIL" if missing else "PASS"}


def selftest():
    tmp = tempfile.mkdtemp(prefix='decl-')
    cases = []
    full = os.path.join(tmp, 'full.md')
    open(full, 'w', encoding='utf-8').write(
        "# Paper\n\n## Declaration of competing interests\nThe authors declare no competing interests.\n\n"
        "## CRediT authorship contribution statement\nAuthor A: writing; Author B: analysis.\n\n"
        "## Funding\nThis work received no specific funding.\n\n"
        "## Declaration of generative AI and AI-assisted technologies\n"
        "During the preparation of this work the authors used a large language model for language polishing. "
        "The authors reviewed and edited the content and take full responsibility.\n")
    noai = os.path.join(tmp, 'noai.md')
    open(noai, 'w', encoding='utf-8').write(
        "## Declaration of competing interests\nnone\n\n## CRediT authorship contribution statement\nA did it\n\n## Funding\nno funding\n")
    two = os.path.join(tmp, 'two.md')
    open(two, 'w', encoding='utf-8').write("## Declaration of competing interests\nnone\n")
    empty = os.path.join(tmp, 'empty.md')
    open(empty, 'w', encoding='utf-8').write("")
    # ① 四段齐全必过（负控）
    c1, p1 = check(full)
    cases.append(('① 四段齐全必过（负控）', c1 == 0, "code=%s missing=%s" % (c1, p1.get("missing"))))
    # ② 缺 AI 声明必红，且只报 AI 那一段
    c2, p2 = check(noai)
    cases.append(('② 缺 AI 声明必红且只报该段', c2 == 1 and p2["missing"] == ["AI使用声明"], "code=%s missing=%s" % (c2, p2.get("missing"))))
    # ③ 缺两段必红
    c3, p3 = check(two)
    cases.append(('③ 缺两段必红', c3 == 1 and len(p3["missing"]) == 3, "code=%s missing=%s" % (c3, p3.get("missing"))))
    # ④ 空文件必红且不崩（防"没内容=没问题"）
    c4, p4 = check(empty)
    cases.append(('④ 空文件必红（不许读成通过）', c4 == 1 and len(p4["missing"]) == 4, "code=%s missing=%s" % (c4, p4.get("missing"))))
    # ⑤ 必失败：只聊 AI 的方法段不得被当成 AI 声明（防过宽）
    meth = os.path.join(tmp, 'meth.md')
    open(meth, 'w', encoding='utf-8').write("We trained a large language model baseline for comparison.\n")
    c5, p5 = check(meth)
    cases.append(('⑤ 方法段提到 LLM 不得当 AI 声明', "AI使用声明" in p5["missing"], "missing=%s" % p5.get("missing")))
    # ⑥ 缺文件 ⇒ 前提层失败
    c6, _ = check(os.path.join(tmp, '__nope__.md'))
    cases.append(('⑥ 缺文件 ⇒ 退出码 2（前提层）', c6 == 2, "code=%s" % c6))
    # ⑦ 证据行必须取到真声明段，而不是前面的关键词行（修的就是中文稿那次错位）
    kw = os.path.join(tmp, 'kw.md')
    open(kw, 'w', encoding='utf-8').write(
        "# 论文\n\n关键词：大语言模型智能体；评测可复现性；工具使用\n\n其他正文。\n\n"
        "## 竞争利益\n无。\n\n## 作者贡献\nA 写、B 算。\n\n## 资助\n无资助。\n\n"
        "# 生成式人工智能使用声明\n在撰写本稿件过程中，作者使用了生成式人工智能（大语言模型）工具辅助文字起草与语言润色。\n")
    c7, p7 = check(kw)
    ev7 = (p7.get("present", {}).get("AI使用声明") or {})
    cases.append(('⑦ 证据行必须落在真声明段（不取关键词行）',
                  c7 == 0 and isinstance(ev7, dict) and ev7.get("line") and ev7["line"] >= 11,
                  "code=%s line=%s ev=%s" % (c7, ev7.get("line"), ev7.get("evidence"))))
    # ⑧ 必失败：**只有**关键词行出现「LLM…使用」⇒ 必须判「缺」（不许把关键词行当声明）
    kwonly = os.path.join(tmp, 'kwonly.md')
    open(kwonly, 'w', encoding='utf-8').write(
        "# 论文\n\n关键词：大语言模型智能体；评测可复现性；工具使用\n\n"
        "## 竞争利益\n无。\n\n## 作者贡献\nA 写、B 算。\n\n## 资助\n无资助。\n")
    c8, p8 = check(kwonly)
    cases.append(('⑧ 必失败：只有关键词行出现过迹象 ⇒ 必须判缺',
                  c8 == 1 and "AI使用声明" in p8["missing"] and "AI使用声明" in p8.get("weak_only", []),
                  "code=%s missing=%s weak=%s" % (c8, p8.get("missing"), p8.get("weak_only"))))
    shutil.rmtree(tmp, ignore_errors=True)
    print("════ _gate-declaration-set --selftest ════")
    bad = 0
    for name, ok, detail in cases:
        if not ok:
            bad += 1
        print("  %s %s%s" % ("✔" if ok else "✘", name, "" if ok else "  ← " + detail))
    print("\n  %s" % ("✔ 夹具 %d/%d 判别正确（2 负控 + 5 注入 + 1 前提）" % (len(cases), len(cases)) if not bad
                      else "✘ 夹具失败 %d/%d —— 本门当前不可信" % (bad, len(cases))))
    return 1 if bad else 0


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('--draft')
    ap.add_argument('--docx')
    ap.add_argument('--json', action='store_true')
    ap.add_argument('--selftest', action='store_true')
    a = ap.parse_args()
    if a.selftest:
        sys.exit(selftest())
    if not a.draft:
        print('用法：--draft <稿.md> [--docx <成品.docx>] [--json] ｜ --selftest')
        sys.exit(2)
    code, payload = check(a.draft, a.docx)
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        sys.exit(code)
    if code == 2:
        print("前提层失败：%s" % payload.get("error"))
        sys.exit(2)
    print("════ 声明四件套门（L-2） ════")
    for k, v in payload["present"].items():
        loc = ("L%s" % v["line"]) if isinstance(v, dict) else "?"
        ev = v["evidence"] if isinstance(v, dict) else v
        print("  有  %s：%s  %s" % (loc, k, ev))
    for k in payload["missing"]:
        print("  缺  %s" % k)
    for n in payload.get("notes", []):
        print("  ⚠ %s" % n)
    if payload["missing"]:
        print("\n  判定：失败 —— 缺 %d 段；投稿硬项缺一即会被退回补充（L-2）。"
              "注意本门只判「有没有」，AI 使用声明必须写实际使用范围。" % len(payload["missing"]))
    else:
        print("\n  判定：通过（四段都在；内容是否属实仍属人读项）")
    sys.exit(code)


if __name__ == '__main__':
    main()
