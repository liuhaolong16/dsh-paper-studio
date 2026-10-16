#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
_phrase-lint.py -- 学术语言与措辞核查门（把「学术语料库」真正用到稿子上）

来源：语料库 E2（禁用绝对化副词）/ E1（判断动词分级）/ C3（未测不报）/ B5（二次数据措辞）
      + 术语与格式一致性。语料库索引见 %s

用法:
    python _phrase-lint.py --draft <稿件.md> [--report <out.md>] [--json <out.json>] [--selftest]

判据分级（与引用门同源）：
    HIGH = 违反语料库明写的禁令（绝对化副词 / 未测却作断言）
    LOW  = 措辞可改进（二次数据未标注 / 弱化动词缺失 / 术语或格式不一致）
    INFO = 统计信息，不构成问题

退出码：0 = 无 HIGH / 1 = 有 LOW / 2 = 有 HIGH

纪律：**只报可机械判定的**；不评判论证质量，也不改写作者的声音。
""" % "references/phrase-bank.json（由 build-phrase-index.cjs 从语料库源 md 生成）"

import argparse
import json
import os
import re
import sys

# ── 语料库 E2：禁用绝对化副词（本稿应零出现）──
# 2026-10-13 对抗测试补入：原表只收**副词**，结果一份故意写满绝对化断言的样稿只被抓到 7/13，
# 漏掉的全是**绝对化动词/短语/最高级**（completely eliminates / definitively establishes /
# well known / no other explanation / fully understood / guaranteed / in all cases / the best ...）
# ⇒ 同类不同形，词表必须按"绝对化强度"而非"词性"来收。
BOOSTERS = ["proves", "prove that", "clearly", "definitely", "obviously", "certainly",
            "undoubtedly", "without doubt", "always", "never fails",
            "definitively", "completely eliminates", "fully eliminates", "eliminates the problem",
            "well known", "it is well known", "no other explanation", "fully understood",
            "guaranteed", "is guaranteed", "in all cases", "under all conditions",
            "best available", "the best possible"]

# ── 语料库 E1：判断动词分级 ──
STRONG_VERBS = ["show", "shows", "establish", "establishes", "account for", "accounts for", "demonstrate"]
MEDIUM_VERBS = ["found that", "reported that", "showed that", "demonstrated that", "noted that",
                "argued that", "proposed", "introduced", "described", "surveyed", "observed"]
WEAK_VERBS = ["is unlikely to", "appears to", "seems to", "we refrain from asserting",
              "we do not claim", "we explicitly do not claim", "may", "might", "could"]

# ── 语料库 C3/B5：二次数据与未测不报的必备措辞 ──
SECONDARY_MARKERS = ["as reported", "reported by", "reported in", "as published", "taken from"]
UNMEASURED_MARKERS = ["we refrain from asserting", "we do not claim", "not measured", "cannot be established"]

NUM_RE = re.compile(r"(\d+\.\d+\s*%|\d+\s*%|R²\s*=\s*-?\d|\b\d+\.\d{1,4}\b|\b\d+\s*(?:μmol|Ah|cycles?)\b)")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    if "--selftest" in sys.argv:
        return selftest()

    ap = argparse.ArgumentParser()
    ap.add_argument("--draft", required=True)
    ap.add_argument("--report", default="")
    ap.add_argument("--json", default="")
    ap.add_argument("--phrases", default="E:\\DeepSeek\\skills\\ai-workbench\\references\\phrase-bank.json")
    a = ap.parse_args()

    md = read(a.draft)
    # 去掉顶部工作元数据注释块与代码块，避免把注记与脚本算进语言核查
    body = re.sub(r"<!--.*?-->", "", md, flags=re.S)
    body = re.sub(r"```.*?```", "", body, flags=re.S)
    # **只查作者正文**：参考文献段是被引论文的逐字标题，术语写法必须服从原文，不能被本门要求统一
    # （实测教训：Li-ion 与 data set 曾全部命中参考文献标题，属误报；术语一致性判据只对 prose 成立）
    cut = body.find("\n## References")
    if cut > 0:
        body = body[:cut]
    lines = body.split("\n")

    problems = []
    stats = {"boosters": 0, "secondary_number_sentences": 0, "secondary_marked": 0,
             "strong": 0, "medium": 0, "weak": 0, "sentences": 0}

    # 句子切分（按句号/换行；够用即可）
    sentences = []
    for i, ln in enumerate(lines):
        if not ln.strip() or ln.strip().startswith((">", "|", "#", "-", "*", "!", "1.", "2.", "3.")):
            continue
        for s in re.split(r"(?<=[.!?])\s+", ln):
            if len(s.strip()) > 15:
                sentences.append((i + 1, s.strip()))
    stats["sentences"] = len(sentences)

    # ① 绝对化副词（HIGH）
    for i, ln in enumerate(lines):
        low = ln.lower()
        for b in BOOSTERS:
            for m in re.finditer(r"\b" + re.escape(b) + r"\b", low):
                problems.append({"level": "HIGH", "line": i + 1, "kind": "booster",
                                 "msg": "绝对化用语 %r（语料库 E2 明令禁用）" % b,
                                 "fix": "换成证据分级动词：show/report，或加限定（in this dataset）"})
                stats["boosters"] += 1

    # ② 二次数据措辞（LOW）：句子含引用标记 + 数字，但没有标注来源口吻
    for ln, s in sentences:
        if re.search(r"\[\d+", s) and NUM_RE.search(s):
            stats["secondary_number_sentences"] += 1
            if any(m in s.lower() for m in SECONDARY_MARKERS):
                stats["secondary_marked"] += 1
            elif re.search(r"\bwe\s+(found|measured|obtained|computed)\b", s, re.I):
                problems.append({"level": "LOW", "line": ln, "kind": "secondary",
                                 "msg": "引用他人文献的数字却用了第一人称测量口吻",
                                 "fix": "改为 as reported by the source studies（语料库 B4/B5）"})

    # ③ 弱化动词与判断分级（INFO 统计 + LOW 提示）
    low_all = body.lower()
    for v in STRONG_VERBS:
        stats["strong"] += len(re.findall(r"\b" + re.escape(v) + r"\b", low_all))
    for v in MEDIUM_VERBS:
        stats["medium"] += len(re.findall(r"\b" + re.escape(v) + r"\b", low_all))
    for v in WEAK_VERBS:
        stats["weak"] += len(re.findall(r"\b" + re.escape(v) + r"\b", low_all))
    if stats["strong"] > 0 and stats["weak"] == 0:
        problems.append({"level": "LOW", "line": 0, "kind": "hedging",
                         "msg": "全文有强断言动词但没有任何弱化表述",
                         "fix": "按语料库 E1 给未直接测量的推断加弱化（is unlikely to / we refrain from asserting）"})

    # ④ 未测不报模板（LOW）：Limitations 节应出现未测不报措辞
    if "Limitation" in body or "limitation" in body:
        if not any(m in low_all for m in UNMEASURED_MARKERS):
            problems.append({"level": "LOW", "line": 0, "kind": "unmeasured",
                             "msg": "有 Limitations 节，但未见未测不报模板措辞",
                             "fix": "补 we refrain from asserting / cannot be established（语料库 C3）"})

    # ⑤ 术语一致性（LOW）：同一概念的两种写法。**大小写敏感**——专有名词（如 Battery Data Set）不参与
    pairs = [("state-of-health", "state of health"), ("cross-temperature", "cross temperature"),
             ("Li-ion", "lithium-ion"), ("dataset", "data set")]
    for x, y in pairs:
        cx = len(re.findall(re.escape(x), body))
        # y 一律按**精确大小写**匹配：避免把专有名词（Battery Data Set）算成小写变体
        cy = len(re.findall(r"(?<![A-Za-z])" + re.escape(y) + r"(?![A-Za-z])", body))
        if cx and cy:
            problems.append({"level": "LOW", "line": 0, "kind": "terminology",
                             "msg": "同概念两种写法混用：%r(%d) 与 %r(%d)" % (x, cx, y, cy),
                             "fix": "投稿前统一，建议以摘要里的写法为准（语料库 F1 术语表）"})

    # ⑥ 数字/单位格式一致性（LOW）
    for pat, name, want in [(r"\d\s*°C", "摄氏度空格", "4 °C（数字与单位间一个空格）"),
                            (r"\d+\.\d+\s*Ah", "Ah 空格", "2.379 Ah")]:
        forms = {}
        for m in re.finditer(pat, body):
            forms[m.group(0)] = forms.get(m.group(0), 0) + 1
        spaced = [k for k in forms if " " in k]
        tight = [k for k in forms if " " not in k]
        if spaced and tight:
            problems.append({"level": "LOW", "line": 0, "kind": "format",
                             "msg": "%s 写法混用：%s vs %s" % (name, spaced[:3], tight[:3]),
                             "fix": "统一为 %s" % want})

    # ── 输出 ──
    highs = [p for p in problems if p["level"] == "HIGH"]
    lows = [p for p in problems if p["level"] == "LOW"]
    print("\n════ 语言与措辞核查（学术语料库判据）════")
    print("  句 %d · 强断言动词 %d · 转述动词 %d · 弱化表述 %d"
          % (stats["sentences"], stats["strong"], stats["medium"], stats["weak"]))
    print("  含引用+数字的句子 %d（其中已标注来源口吻 %d）"
          % (stats["secondary_number_sentences"], stats["secondary_marked"]))
    for p in problems:
        print("  %-4s L%-5s [%s] %s" % (p["level"], p["line"] or "-", p["kind"], p["msg"]))
        print("        建议：%s" % p["fix"])
    print("\n  判定：HIGH %d · LOW %d" % (len(highs), len(lows)))

    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump({"stats": stats, "problems": problems}, f, ensure_ascii=False, indent=2)
    if a.report:
        with open(a.report, "w", encoding="utf-8") as f:
            f.write("# 语言与措辞核查报告（学术语料库判据）\n\n")
            f.write("> 判据来源：学术语料库（%s）之 E1 判断动词分级 / E2 禁用绝对化副词 / "
                    "C3 未测不报 / B4·B5 二次数据措辞 / F1 术语表。\n" % a.phrases)
            f.write("> 本门**只报可机械判定**的问题；不改写作者声音、不评判论证质量。\n\n")
            f.write("| 统计 | 值 |\n|---|---|\n")
            for k, v in stats.items():
                f.write("| %s | %s |\n" % (k, v))
            f.write("\n## 问题清单\n\n")
            if not problems:
                f.write("无。\n")
            for p in problems:
                f.write("- **%s**（L%s，%s）：%s\n  - 建议：%s\n"
                        % (p["level"], p["line"] or "-", p["kind"], p["msg"], p["fix"]))
        print("  报告已写: %s" % a.report)

    return 2 if highs else (1 if lows else 0)


def selftest():
    """必失败自检：注入三类违规，检查必须全部抓到。
    注意：术语/格式混用必须放在 References **之前**——本门按设计只查作者正文，
    References 段之后的文字会被截掉（夹具曾因此整条失效，是自检把这个交互抓出来的）。
    """
    import tempfile
    bad = """# T
## Abstract
This clearly proves that the model always works. We found that R² = 0.874 [2] in the earlier study.
Our approach definitively eliminates the problem and is guaranteed to hold under all conditions.
state-of-health and state of health are both used here. 4 °C and 4°C both appear too.
## Limitations
The dataset is small.
## References
**[1]** Someone. *A title.* Journal, 2026.
"""
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "bad.md")
        with open(p, "w", encoding="utf-8") as f:
            f.write(bad)
        import subprocess
        r = subprocess.run([sys.executable, os.path.abspath(__file__), "--draft", p],
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
        out = (r.stdout or "") + (r.stderr or "")
        checks = [
            ("绝对化副词被抓", "booster" in out),
            # 2026-10-13 新增：只补词表而不补夹具 = 假绿（新词是否真的进检测路径，必须有夹具证明）
            ("新补的绝对化动词/短语被抓（definitively / guaranteed / under all conditions）",
             ("definitively" in out) and ("guaranteed" in out) and ("under all conditions" in out)),
            ("二次数据措辞被抓", "secondary" in out),
            ("未测不报缺失被抓", "unmeasured" in out),
            ("术语混用被抓", "terminology" in out),
            ("退出码非 0（有 HIGH）", r.returncode != 0),
        ]
        ok = True
        print("\n=== 语言门必失败自检 ===")
        for name, passed in checks:
            print("  %s %s" % ("PASS" if passed else "FAIL", name))
            ok = ok and passed
        print("\n" + ("  自检通过：注入的违规全部被检出" if ok else "  自检失败：门无区分力"))
        return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
