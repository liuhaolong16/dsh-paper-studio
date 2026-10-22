#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""_gate-prereg-claim.py —— 预注册声称门（L-23）。

判据：论文若用「pre-registered / pre-registration / pre-register」这类**隐含外部登记**的词，
必须同时给出可核对的证据 —— ① 登记平台+链接+日期（osf.io / aspredicted / clinicaltrials / registry），
或 ② 仓库里的 protocol.md（"fixed a priori + documented in the repository" 的诚实替代）。

有声称无证据 ⇒ FAIL（建议：改措辞为 "fixed a priori" + 补 protocol.md 佐证，或补登记链接+日期）。
无「pre-register」字样 ⇒ 通过（不适用，非失败，也不阻断）。

红线：本门**绝不在无证据时替作者补一个登记链接/日期**（那是伪造时间线，比没有预注册严重得多）。

用法：
  python _gate-prereg-claim.py --draft <稿.md> [--json]
  python _gate-prereg-claim.py --selftest

退出码：0 通过（无声称 / 有声称且有证据）· 1 有声称无证据 · 2 前提层失败。
"""
import json
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

# 登记平台 / 诚实替代（protocol.md）的证据标记。刻意不含 "registration" 本身，
# 因为 "pre-registered" 里就带 "registered"，会自匹配。
EVIDENCE_MARKERS = [
    "osf.io", "aspredicted", "clinicaltrials", "registry", "anonymized",
    "protocol.md", "protocol/", "pre-registration.md",
    "http://", "https://", "doi", "registered at",
    "registration number", "registration doi",
]

CLAIM_RE = re.compile(r"pre-?regist", re.IGNORECASE)


def judge(text):
    """返回 (verdict, claim_lines, evidence_found, note)。"""
    lines = text.splitlines()
    claim_lines = [(n, ln.strip()) for n, ln in enumerate(lines, 1) if CLAIM_RE.search(ln)]
    if not claim_lines:
        return "pass", [], [], "无 pre-register 声称"
    low = text.lower()
    evidence = [m for m in EVIDENCE_MARKERS if m.lower() in low]
    if evidence:
        return "pass", claim_lines, evidence, "有声称且有证据标记：" + ", ".join(evidence)
    return ("fail", claim_lines, [],
            "有 pre-registered 声称但无证据（无登记平台/链接/protocol.md）—— 改措辞为 fixed a priori + protocol.md 佐证，或补登记链接+日期")


def emit(verdict, claim_lines, note, as_json):
    if as_json:
        print(json.dumps({
            "verdict": verdict,
            "claim_lines": [{"line": n, "text": t} for n, t in claim_lines],
            "note": note,
        }, ensure_ascii=False))
    else:
        print(f"[{verdict}] {note}")
        for n, t in claim_lines:
            print(f"  L{n}: {t}")


def selftest():
    """必失败面：三组夹具，必须全部按预期出判定。"""
    cases = [
        # (name, text, expect_verdict)
        ("有声称无证据 ⇒ fail", "We used a pre-registered criterion R2 > -1.", "fail"),
        ("有声称 + protocol.md ⇒ pass", "A pre-registered criterion (see protocol.md in the repository).", "pass"),
        ("无声称 ⇒ pass", "We used a fixed criterion decided a priori.", "pass"),
    ]
    fails = 0
    for name, text, expect in cases:
        verdict, _, _, _ = judge(text)
        ok = verdict == expect
        print(f"{'PASS' if ok else 'FAIL'}  {name}  (期望 {expect}，实测 {verdict})")
        if not ok:
            fails += 1
    # 必失败面：第 1 条夹具期望「fail」——若门坏了（对无证据声称也判 pass），fails>0 ⇒ selftest 变红。
    return 0 if fails == 0 else 1


def main(argv):
    if "--selftest" in argv:
        return selftest()
    as_json = "--json" in argv
    draft = None
    i = 0
    while i < len(argv):
        if argv[i] == "--draft" and i + 1 < len(argv):
            draft = argv[i + 1]
            i += 2
        else:
            i += 1
    if not draft:
        pos = [a for a in argv if not a.startswith("--")]
        if pos:
            draft = pos[0]
    if not draft:
        emit("precondition", [], "缺 --draft", as_json)
        return 2
    try:
        text = open(draft, encoding="utf-8").read()
    except OSError as e:
        emit("precondition", [], f"读不到 {draft}: {e}", as_json)
        return 2
    verdict, claim_lines, _, note = judge(text)
    emit(verdict, claim_lines, note, as_json)
    return 0 if verdict == "pass" else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
