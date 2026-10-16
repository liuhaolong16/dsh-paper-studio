#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""综述/审计类稿件的「方法完整性门」（paper-studio 第 10 道门 · V1.4）

为什么有这道门：此前九道门都假设稿件是**实证稿**（结果/图表/引用锚点/声明）。
而"二次研究"（系统综述 / 范围综述 / 元分析 / 报道规范审计）有**另一套方法要件**：
检索来源与时间窗、检索式、纳排标准、二次数据标注、可得性与可重采、"没测就不下结论"、
下界口径、局限节。缺哪一条，审稿人都会要求补 —— 本门把它们变成可机检的判据。

★ **不适用对象（重要）**：非综述类稿件判「不适用」并**退出码 0**，绝不判失败。
  适用性判定（避免被参考文献里的 review 字样误触发）：
    (a) **标题或前 40 行**内出现综述词；或
    (b) 正文同时出现「检索式词」与「纳排词」。
  —— 这是"判据必须标明不适用对象"的具体落地（同一条纪律我上一轮才与同行对拍过）。

判据（适用时）：① 检索来源+时间窗 ② 检索式/词族 ③ 纳排标准 ④ 二次数据标注
             ⑤ 可得性/可重采 ⑥ "未测不报"显式表述 ⑦ 下界口径 ⑧ 局限节
退出码：0 = 全部命中（或不适用）；1 = 有缺项（逐条列出）；2 = 前提层失败（文件缺失/参数错）

用法：python _gate-review-protocol.py --draft <稿.md> [--json] [--selftest]
"""
import argparse
import json
import os
import re
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                             # noqa: BLE001
    pass

HEAD_LINES = 40          # 只看标题/摘要区，避免参考文献里的 review 字样误触发

REVIEW_WORDS = re.compile(
    r"systematic review|scoping review|meta-?analysis|literature review|review of|audit of|"
    r"系统综述|文献综述|范围综述|元分析|荟萃分析|系统评价|综述|审查", re.I)
SEARCH_SOURCE = re.compile(
    r"arXiv|ACL Anthology|ACM Digital Library|Google Scholar|Web of Science|Scopus|PubMed|"
    r"IEEE Xplore|SpringerLink|CNKI|万方|知网|维普|arXiv\s*API", re.I)
TIME_WINDOW = re.compile(
    r"20\d{2}\s*[-–—~至到]\s*20\d{2}|between\s+(January\s+)?20\d{2}\s+and\s+|"
    r"from\s+20\d{2}\s+to\s+20\d{2}|20\d{2}\s*年\s*[-–—~至到]\s*20\d{2}\s*年", re.I)
QUERY_TERMS = re.compile(
    r"query famil|search terms?|search strateg|boolean|检索式|检索词|检索策略|查询族|关键词族", re.I)
ELIGIBILITY = re.compile(
    r"inclusion criteri|exclusion criteri|eligible if|eligibility|we excluded|"
    r"纳入标准|排除标准|纳排|纳入与排除|纳入条件", re.I)
SECONDARY = re.compile(
    r"as reported by|reported by the source|per the source|secondary data|re-?stat(e|ement) of the cited|"
    r"转述自|引自|二次数据|由来源研究报告|按来源研究报告", re.I)
AVAILABILITY = re.compile(
    r"data availability|online resource|supplementary material|supplementary_S|collection script|collect_data|"
    r"re-?collect|数据可得性|补充材料|采集脚本|可重采|可复算", re.I)
NOT_MEASURED = re.compile(
    r"refrain from asserting|cannot be established|not measured|we do not report|we did not measure|"
    r"we do not claim to have audited|未测量|未做该项测量|不下结论|不做结论|未加测量", re.I)
LOWER_BOUND = re.compile(
    r"lower bound|at least\s+\d|≥\s*\d|下界|至少\s*\d|不少于\s*\d", re.I)
LIMITATIONS = re.compile(
    r"limitations|threats to validity|局限|研究局限|不足之处", re.I)
# ── V1.6 按 PRISMA 2020 补齐的四条（条目号见括号；清单为 CC BY 4.0）──
SEARCH_DATE = re.compile(
    r"last searched|last search|searched on\s+\d|as of\s+20\d{2}|检索日期|最后检索|截至\s*20\d{2}", re.I)
SCREEN_COUNTS = re.compile(
    r"records identified|identified\s+\d|\d[\d,]*\s+records|\d[\d,]*\s+studies were included|"
    r"records screened|studies included|"
    r"(初检|检索到|筛选|去重后|全文评估|最终纳入)\s*[:：]?\s*[\d,]+|[\d,]+\s*篇\s*(?:被)?纳入", re.I)
# ★ 收紧过一次：原来写成 `protocol (is|was|can be|available)`，被正文里的 "protocol-driven" 蒙中
#   （实测命中词是那个 `is`）⇒ 现在要求**注册/协议的明确状态**（登记在哪 / 明确未注册 / 协议是否准备好），
#   这才是 PRISMA #24a/b 真正要的东西。
REGISTRATION = re.compile(
    r"PROSPERO|OSF Registr|registered (?:in|with|at|on)|registration (?:number|record|in)|"
    r"not registered|was not registered|未注册|注册号|注册库|预注册|"
    r"(?:review )?protocol (?:was|is) (?:not )?(?:prepared|available|registered|published)", re.I)
RISK_OF_BIAS = re.compile(
    r"risk of bias|risk-of-bias|quality assessment|偏倚风险|质量评价|方法学质量", re.I)

ITEMS = [
    ("search-source-window", "检索来源 + 时间窗（谁，什么时候）", SEARCH_SOURCE, TIME_WINDOW),
    ("search-query", "检索式 / 词族（可被复算的检索策略）", QUERY_TERMS, None),
    ("search-date", "各来源的最后检索日期（PRISMA #6）", SEARCH_DATE, None),
    ("eligibility", "纳排标准（纳入/排除，缺一即不可复算）", ELIGIBILITY, None),
    ("screening-counts", "筛选流程计数（PRISMA #16a：记录数 → 纳入数）", SCREEN_COUNTS, None),
    ("risk-of-bias", "偏倚风险评估方法与工具（PRISMA #11）", RISK_OF_BIAS, None),
    ("registration", "注册与协议状态（PRISMA #24a/b，**明确写「未注册」也算**）", REGISTRATION, None),
    ("secondary-data", "二次数据标注（他人数字须标 as reported by）", SECONDARY, None),
    ("availability", "可得性 / 可重采（数据、编码表、脚本）", AVAILABILITY, None),
    ("not-measured", "「没测就不下结论」的显式表述", NOT_MEASURED, None),
    ("lower-bound", "下界口径（at least / 下界 而非精确数）", LOWER_BOUND, None),
    ("limitations", "局限节（逐条 + 对结论的影响）", LIMITATIONS, None),
]


def _lines(text):
    return text.splitlines()


def _title_and_abstract(text):
    """标题 = 首个非空行（去 markdown 井号）；摘要区 = 含 Abstract/摘要 的行起 12 行。

    ★ 为什么要"标题 + 摘要区"而不是"前 N 行"：短文档（或正文里偶发出现 review 字样的实证稿）里，
      "前 40 行"会把**参考文献列表 / 正文引用**也圈进来，于是 (see review of Smith et al., 2024)
      这种行会误触发综述判定。范围收紧到标题与摘要区后，误触发消失，而真综述稿
      （标题或摘要里就写明 systematic review / 系统综述）仍然命中。
    """
    lines = text.splitlines()
    title = ""
    for l in lines:
        s = l.strip()
        if not s or s in ("---", "...") or s.startswith("<!--"):
            continue
        title = s.lstrip("#").strip()
        break
    abs_block = ""
    for i, l in enumerate(lines):
        if re.match(r"^\s*#*\s*(abstract|摘要)\b|^\s*(abstract|摘要)\s*[:：]", l, re.I):
            seg = []
            for j in range(i, min(i + 12, len(lines))):
                if j > i and re.match(r"^\s*#{1,6}\s", lines[j]):   # 下一个标题处结束
                    break
                seg.append(lines[j])
            abs_block = "\n".join(seg)
            break
    return title, abs_block


def is_applicable(text):
    title, abs_block = _title_and_abstract(text)
    if REVIEW_WORDS.search(title):
        return True, "标题内含综述词：%s" % title[:60]
    if abs_block and REVIEW_WORDS.search(abs_block):
        return True, "摘要区内含综述词"
    body = "\n".join(text.splitlines())
    if QUERY_TERMS.search(body) and ELIGIBILITY.search(body):
        return True, "正文同时含检索式词与纳排词"
    return False, "标题与摘要区均无综述词，且正文不同时含检索式词与纳排词 ⇒ 判为实证稿"


def check(draft):
    """返回 (verdict, applicable, rows, precondition, summary)"""
    if not draft or not os.path.exists(draft):
        return ("precondition", False, [], True, "稿件不存在或未提供：%s" % draft)
    try:
        with open(draft, "r", encoding="utf-8-sig") as fh:
            text = fh.read()
    except Exception as e:                                    # noqa: BLE001
        return ("precondition", False, [], True, "稿件读取失败：%s" % e)
    if not text.strip():
        return ("precondition", False, [], True, "稿件为空")
    applicable, why = is_applicable(text)
    if not applicable:
        return ("pass", False, [], False, "不适用（非综述/审计类稿件）：%s" % why)

    lines = _lines(text)
    rows = []
    for item_id, label, rx1, rx2 in ITEMS:
        hit = None
        for i, ln in enumerate(lines, 1):
            if not rx1.search(ln):
                continue
            if rx2 is not None and not rx2.search(ln):
                continue
            hit = (i, ln.strip()[:120])
            break
        if hit is None:
            # 允许"跨行命中"：两个正则分别在不同行出现（如来源在一行、时间窗在另一行）
            if rx2 is not None:
                l1 = next((i for i, ln in enumerate(lines, 1) if rx1.search(ln)), None)
                l2 = next((i for i, ln in enumerate(lines, 1) if rx2.search(ln)), None)
                if l1 and l2:
                    hit = (min(l1, l2), "（跨行命中：来源 L%d / 时间窗 L%d）" % (l1, l2))
        rows.append({"item": item_id, "label": label, "hit": hit})
    missing = [r for r in rows if r["hit"] is None]
    hits = [r for r in rows if r["hit"] is not None]
    if missing:
        return ("fail", True, rows, False,
                "综述类稿件方法要件缺 %d 条（共 %d 条）：%s" % (len(missing), len(rows), ' / '.join(m['item'] for m in missing)))
    return ("pass", True, rows, False, "综述类稿件方法要件 %d/%d 全命中" % (len(hits), len(rows)))


def main(argv=None):
    ap = argparse.ArgumentParser(description="综述/审计类稿件的方法完整性门（第 10 道）")
    ap.add_argument("--draft", help="待判稿件（md/txt）")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    if a.selftest:
        return selftest()

    verdict, applicable, rows, pre, summary = check(a.draft)
    if a.json:
        print(json.dumps({
            "gate": "review-protocol",
            "ok": verdict == "pass",
            "applicable": applicable,
            "precondition": pre,
            "count": len([r for r in rows if r["hit"] is None]),
            "summary": summary,
            "findings": [
                {"line": None, "rule": r["item"], "why": "缺方法要件：" + r["label"], "text": r["item"]}
                for r in rows if r["hit"] is None
            ],
            "notes": ["命中 %s ← L%d" % (r["item"], r["hit"][0]) for r in rows if r["hit"]],
        }, ensure_ascii=False, indent=2))
    else:
        print("════ 综述/审计类稿件 · 方法完整性门（第 10 道）════")
        print("  适用性：%s" % ("适用" if applicable else "不适用"))
        for r in rows:
            if r["hit"]:
                print("  有  %-22s L%-5d %s" % (r["item"], r["hit"][0], r["hit"][1][:70]))
            else:
                print("  缺  %-22s %s" % (r["item"], r["label"]))
        print("\n  判定：%s" % summary)
    if pre:
        return 2
    return 0 if verdict == "pass" else 1


# ------------------------------------------------------------------ selftest
FULL = """# A systematic review of widget evaluation practices
Authors: A, B
Abstract: We report a systematic review covering 2023-2026.
# 3. Methods
We searched arXiv, the ACL Anthology, the ACM Digital Library and Google Scholar.
Each source was last searched on 12 October 2026.
Eligibility: a study was eligible if it reported a quantitative result; exclusion criteria applied to opinion pieces.
We used the query families below (Boolean, with filters); the full search strategies are in S1.
The review was not registered and no protocol was prepared.
Records identified: 1,204; records screened: 318; studies included: 35.
We assessed risk of bias with a published tool; two reviewers screened independently.
All benchmark numbers cited are secondary data reported by the source studies.
The collection script and coding sheets are provided as supplementary material and can be re-collected.
Whether seeds were reported cannot be established from abstracts; we refrain from asserting a figure we did not measure.
Counts are lower bounds: each feature was recorded only when verifiable (at least 9 of 17).
# 5. Limitations
Our review has limitations that we state plainly.
"""
EMPIRICAL = """# Cross-temperature generalisation of battery SOH prediction
Abstract: We measured 6 cells and report a mean absolute error of 0.8%.
# 2. Method
We collected 1,980 instances and trained three backbones.
# 4. Results
The proposed model outperforms the baseline (Table 2).
# 5. Limitations
Our study has limitations.
"""
REFONLY_REVIEW = """# A new attention mechanism for tabular data
Abstract: We propose a new attention block.
# 2. Related work
Several surveys provide an overview of the field (see review of Smith et al., 2024).
# 3. Method
We train on 10 datasets.
"""
SCATTERED = """# Predicting remaining useful life with transformers
Abstract: We evaluate transformers on battery data.
# 1. Introduction
Our review has limitations that we state plainly.
# 2. Method
We split the data 70/30.
"""


def selftest():
    import tempfile
    tmp = tempfile.mkdtemp(prefix="ps-review-")

    def w(name, body):
        p = os.path.join(tmp, name)
        with open(p, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(body)
        return p

    def drop(body, *needles):
        out = body
        for n in needles:
            for ln in list(out.splitlines()):
                if n.lower() in ln.lower():
                    out = out.replace(ln + "\n", "")
        return out

    cases = [
        ("① 完整的综述稿必须过（负控）", w("a.md", FULL), "pass", True),
        ("② ★反向控制：实证稿必须判「不适用」而不是失败", w("b.md", EMPIRICAL), "pass", False),
        ("③ 综述缺纳排标准 ⇒ 失败且只报该条", w("c.md", drop(FULL, "Eligibility:")), "fail", True),
        ("④ 综述缺检索式 ⇒ 失败", w("d.md", drop(FULL, "query families")), "fail", True),
        ("⑤ 综述缺二次数据标注 ⇒ 失败", w("e.md", drop(FULL, "secondary data")), "fail", True),
        ("⑥ 综述缺可得性/可重采 ⇒ 失败", w("f.md", drop(FULL, "supplementary material")), "fail", True),
        ("⑦ 综述缺「没测不报」表述 ⇒ 失败", w("g.md", drop(FULL, "cannot be established")), "fail", True),
        ("⑧ 综述缺局限节 ⇒ 失败", w("h.md", drop(FULL, "Our review has limitations", "5. Limitations")), "fail", True),
        ("⑨ ★反向控制：只有参考文献里出现 review 字样 ⇒ 不适用（不得误触发）", w("i.md", REFONLY_REVIEW), "pass", False),
        ("⑩ ★反向控制：正文零散出现 review/limitations ⇒ 仍不适用", w("j.md", SCATTERED), "pass", False),
        ("⑪ 缺文件 ⇒ 前提层失败（不是断言失败）", None, "precondition", False),
        # ── V1.6 新增：PRISMA 补齐的四条 + 一条反向控制 ──
        ("⑫ 缺各来源最后检索日期 ⇒ 失败（PRISMA #6）", w("k.md", drop(FULL, "last searched on")), "fail", True),
        ("⑬ 缺筛选流程计数 ⇒ 失败（PRISMA #16a）", w("l.md", drop(FULL, "Records identified")), "fail", True),
        ("⑭ 缺注册/协议声明 ⇒ 失败（PRISMA #24a/b）", w("m.md", drop(FULL, "was not registered")), "fail", True),
        ("⑮ 缺偏倚风险方法 ⇒ 失败（PRISMA #11）", w("n.md", drop(FULL, "risk of bias with")), "fail", True),
        ("⑯ ★反向控制：明确写「未注册」也必须算命中（PRISMA 允许如实声明未注册）",
         w("o.md", FULL.replace("The review was not registered and no protocol was prepared.", "Registration: this review was not registered.")), "pass", True),
        # ── V2.0（判据回灌）：补**正向控制** —— 此前这一门只有"必失败"一侧，
        #    于是"该命中时没命中"（漏报命中＝假阴性）在自检里没有任何东西能发现。
        ("⑰ ★正向控制：只缺检索日期时，**其余条目必须逐条留下命中记录**（不许靠「没报缺」混过）",
         w("p.md", drop(FULL, "last searched on")), "fail", True),
    ]
    print("════ _gate-review-protocol --selftest ════")
    bad = 0
    for name, path, want, want_app in cases:
        got, app, rows, pre, summary = check(path)
        ok = (got == want and app == want_app)
        print("  %s %s" % ("✔" if ok else "✘", name))
        if not ok:
            bad += 1
            print("      期望 %s(applicable=%s) 实得 %s(applicable=%s) | %s" % (want, want_app, got, app, summary))

    # ── 跨用例不变量 1：**判 pass ⇒ 必须逐条命中**；且每个适用条目恰好落在"命中"或"缺项"之一 ──
    #    由来（2026-10-14 V2.0）：报告侧曾把"说明桶"当待修项、把条目整条丢掉过；同一形状在门里
    #    表现为"条目从两个桶里同时消失"，只断言 verdict 永远发现不了 —— 必须断言**条目守恒**。
    inv = []
    for name, path, want, want_app in cases:
        if path is None or want == "precondition":
            continue
        got, app, rows, pre, summary = check(path)
        hits = [r for r in rows if r["hit"] is not None]
        miss = [r for r in rows if r["hit"] is None]
        if not app:
            continue
        if len(hits) + len(miss) != len(rows):
            inv.append("%s：命中 %d + 缺项 %d ≠ 条目 %d（条目守恒被破坏）" % (name[:14], len(hits), len(miss), len(rows)))
        if got == "pass" and miss:
            inv.append("%s：判 pass 却有 %d 条缺项" % (name[:14], len(miss)))
        if got == "pass" and len(hits) != len(rows):
            inv.append("%s：判 pass 但只命中 %d/%d" % (name[:14], len(hits), len(rows)))
        if got == "fail" and not miss:
            inv.append("%s：判 fail 却没有任何缺项（无法归因）" % name[:14])
    if inv:
        bad += 1
    print("  %s ⑱ 跨用例不变量：判 pass ⇒ 逐条命中；且「命中 + 缺项 = 全部适用条目」（条目守恒）"
          % ("✔" if not inv else "✘"))
    for x in inv[:4]:
        print("      " + x)

    # ── 跨用例不变量 2：单条定向 —— 只缺一条时，**缺项必须恰好只有那一条**（不许多报也不许漏报命中） ──
    _, _, rows17, _, _ = check(os.path.join(tmp, "p.md"))
    miss17 = sorted(r["item"] for r in rows17 if r["hit"] is None)
    hit17 = sorted(r["item"] for r in rows17 if r["hit"] is not None)
    pos_ok = (miss17 == ["search-date"] and len(hit17) >= 4)
    if not pos_ok:
        bad += 1
    print("  %s ⑲ 正向定向：只缺检索日期 ⇒ 缺项恰好 = [search-date]，其余 %d 条全部留命中记录"
          % ("✔" if pos_ok else "✘", len(hit17)))
    if not pos_ok:
        print("      实得 缺项=%s 命中=%s" % (miss17, hit17))

    total = len(cases) + 2
    print("\n  %s" % ("✔ 夹具 %d/%d 判别正确（用例 %d + 跨用例断言 2：条目守恒 / 正向定向）"
                      % (total - bad, total, len(cases)) if not bad
                      else "✘ 夹具失败 %d/%d —— 本门当前不可信" % (bad, total)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
