#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""作者材料前提门（paper-studio · write 链路）

判据：`write`（起草辅助）任务**必须**有材料前提三者之一 —— 作者材料 / 已验证检索 / 领域常识。
本门把 pipeline.json 里 `task_types[write].precondition` 与 `handoff.contracts[material-check→paper-writer]`
的**必填字段**变成可机械判定的东西。

输入：一份**材料声明 JSON**（就是那个交接契约的实例）：
    {
      "material_kind": "author_data" | "author_text" | "verified_retrieval" | "field_common_knowledge",
      "material_path_or_note": "<路径 或 说明文字>",
      "claim_policy": "materials_only" | "verified_retrieval" | "field_common_knowledge"
    }

判定分层（沿用 L-13 的纪律：前提层与断言层必须分开）：
  - 退出码 2 = **前提层失败**（文件不存在 / JSON 解析失败 / 参数错）——「没法判」，不是「判为否」。
  - 退出码 1 = **断言失败**（声明在，但内容不达标）——逐条列出是哪个字段、为什么不合格。
  - 退出码 0 = 前提成立。

明确**不做**（避免与既有门重叠 —— L-12 的教训）：
  - 不扫正文里的工作注记/占位符（那是 `_gate-worknote-leak.py` 的活）；
  - 不判断材料里的**科学内容**对不对（人读项）；
  - 不提供任何"规避 AI 检测"的措辞。
"""
import argparse
import json
import os
import re
import sys
import tempfile

# 本机 PowerShell 5.1 的控制台编码可能是 GBK ⇒ 打印 ✔/✘ 会 UnicodeEncodeError。
# 显式把 stdout/stderr 重编成 UTF-8（errors=replace 保证绝不因打印而崩）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:                                             # noqa: BLE001
    pass

MATERIAL_KINDS = {"author_data", "author_text", "verified_retrieval", "field_common_knowledge"}
CLAIM_POLICIES = {"materials_only", "verified_retrieval", "field_common_knowledge"}
REQUIRED = ["material_kind", "material_path_or_note", "claim_policy"]

MIN_NOTE_CHARS = 40          # 说明文字太短 = 没真说清（如「见附件」「同上」）
MIN_FILE_BYTES = 512         # 材料文件太小 = 空壳（真材料极少低于半 KB）
# 占位符：这些是"还没做"，不是"材料"
# ★ 2026-10-14 修一处**严重假阳性**（由 `studio crosscheck` 同判回归抓出）：
#   原来写成 `N/?A` 且带 re.I ⇒ 会匹配**任何含 "na" 的英文词**（OpenAlex / analysis / final / nature…），
#   `略` 同理会匹配「策略」「省略」。这会让绝大多数英文说明被判成"占位符"。
#   现在：短英文标记要求词边界；`略` 只认括号形式或独占一行。
PLACEHOLDER = re.compile(
    r"(待补|待填|待定|待确认|待提供|见附件|同上|稍后|以后再说|\?\?\?)"
    r"|(?<![A-Za-z])(?:TBD|TODO|FIXME|XXX)(?![A-Za-z])"
    r"|(?<![A-Za-z])N/?A(?![A-Za-z])"
    r"|[（(]略[）)]|^略$",
    re.I,
)
PATHISH = re.compile(r"^([A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])|\.(md|txt|csv|xlsx|docx|pdf|json|py|png|jpg|jpeg|svg)$", re.I)


def _norm(s):
    return (s or "").strip()


def _looks_like_path(v):
    return bool(PATHISH.search(_norm(v)))


def _resolve(v, root):
    v = _norm(v)
    if v.lower().startswith("file:"):
        v = v[5:].strip()
    if os.path.isabs(v):
        return v
    return os.path.normpath(os.path.join(root or ".", v))


def _size_of(p):
    """文件或目录的体积（目录 = 内部普通文件字节合计）。返回 (exists, bytes, err)"""
    if not os.path.exists(p):
        return (False, 0, "路径不存在")
    if os.path.isdir(p):
        total, n = 0, 0
        for dirpath, _dirs, files in os.walk(p):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(dirpath, f))
                    n += 1
                except OSError:
                    pass
        if n == 0:
            return (True, 0, "目录里没有任何文件")
        return (True, total, None)
    try:
        return (True, os.path.getsize(p), None)
    except OSError as e:
        return (True, 0, "读不到体积：%s" % e)


def check(decl_path, materials_root=None):
    """返回 (verdict, rows, precondition, summary)
    verdict: 'pass' | 'fail' | 'precondition'
    rows: [{field, why, level}]  level ∈ {'fail','note'}
    """
    rows = []
    if not decl_path or not os.path.exists(decl_path):
        return ("precondition", [], True, "材料声明不存在或未提供（缺输入 ⇒ 不许硬写）")
    try:
        with open(decl_path, "r", encoding="utf-8-sig") as fh:
            doc = json.load(fh)
    except Exception as e:                                    # noqa: BLE001
        return ("precondition", [], True, "材料声明无法解析为 JSON：%s" % e)
    if not isinstance(doc, dict):
        return ("precondition", [], True, "材料声明的顶层必须是对象（JSON object）")

    # ① 三个必填字段（来自 handoff.contracts 的 required）
    for k in REQUIRED:
        if k not in doc or doc.get(k) in (None, "", [], {}):
            rows.append({"field": k, "why": "必填字段缺失或为空（交接契约 material-check→paper-writer 要求必填）", "level": "fail"})

    kind = _norm(doc.get("material_kind"))
    policy = _norm(doc.get("claim_policy"))
    mpn = doc.get("material_path_or_note")

    # ② 取值域
    if kind and kind not in MATERIAL_KINDS:
        rows.append({"field": "material_kind", "why": "取值不在闭集内：%s（合法：%s）" % (kind, " / ".join(sorted(MATERIAL_KINDS))), "level": "fail"})
    if policy and policy not in CLAIM_POLICIES:
        rows.append({"field": "claim_policy", "why": "取值不在闭集内：%s（合法：%s）" % (policy, " / ".join(sorted(CLAIM_POLICIES))), "level": "fail"})

    # ③ 材料在场性：路径 ⇒ 必须真的存在且不是空壳；说明 ⇒ 必须够长且不是占位符
    if isinstance(mpn, str) and _norm(mpn):
        v = _norm(mpn)
        if _looks_like_path(v):
            p = _resolve(v, materials_root)
            ok, size, err = _size_of(p)
            if not ok:
                rows.append({"field": "material_path_or_note", "why": "声明的材料路径不存在：%s" % p, "level": "fail"})
            elif size < MIN_FILE_BYTES:
                rows.append({"field": "material_path_or_note", "why": "材料是空壳：%s 仅 %d 字节（门槛 %d）%s" % (p, size, MIN_FILE_BYTES, ("；" + err) if err else ""), "level": "fail"})
            else:
                rows.append({"field": "material_path_or_note", "why": "材料在场：%s（%d 字节）" % (p, size), "level": "note"})
        else:
            if len(v) < MIN_NOTE_CHARS:
                rows.append({"field": "material_path_or_note", "why": "说明太短（%d 字，门槛 %d）——不能只说「见附件」这类话" % (len(v), MIN_NOTE_CHARS), "level": "fail"})
            elif PLACEHOLDER.search(v):
                rows.append({"field": "material_path_or_note", "why": "说明里含占位符（待补/TBD/见附件…）⇒ 这是「还没做」，不是材料", "level": "fail"})
            else:
                rows.append({"field": "material_path_or_note", "why": "说明在场：%d 字" % len(v), "level": "note"})

    # ④ 口径自洽：材料只含作者提供时，声明不能挂在检索/常识上
    if policy == "materials_only" and kind and kind not in ("author_data", "author_text"):
        rows.append({"field": "claim_policy", "why": "口径不自洽：claim_policy=materials_only 只能配 author_data / author_text（当前 material_kind=%s）" % kind, "level": "fail"})

    # ④b 口径与材料**形态**必须匹配：materials_only ⇒ 必须给出真实存在的路径，不能是一段文字说明
    #     ★ 2026-10-14 由 `studio crosscheck`（同判回归）抓出：此前 ③ 只看"像不像路径"，不像就只查长度，
    #       于是「claim_policy=materials_only + 一段够长的文字说明」会被判**过** —— 这正是
    #       "声称有作者材料、却指不到任何材料"的洞（本门存在的理由就是堵这个洞）。
    if policy == "materials_only" and isinstance(mpn, str) and _norm(mpn) and not _looks_like_path(_norm(mpn)):
        rows.append({"field": "material_path_or_note",
                     "why": "口径为 materials_only 时必须给出**真实存在的路径**，不能是文字说明（否则等于没有材料就硬写）",
                     "level": "fail"})

    # ⑤ 未知字段：宽容（不判失败），只记一笔 —— 反向控制：多写字段不得因此变红
    unknown = [k for k in doc.keys() if k not in REQUIRED]
    if unknown:
        rows.append({"field": "(未知字段)", "why": "宽容放行（不判失败）：%s" % ", ".join(sorted(unknown)), "level": "note"})

    fails = [r for r in rows if r["level"] == "fail"]
    if fails:
        return ("fail", rows, False, "材料前提不成立：%d 条不合格（**不许就此硬写正文**）" % len(fails))
    return ("pass", rows, False, "材料前提成立（material_kind=%s · claim_policy=%s）" % (kind, policy))


def main(argv=None):
    ap = argparse.ArgumentParser(description="作者材料前提门（write 链路）")
    ap.add_argument("--declaration", help="材料声明 JSON 路径（交接契约 material-check→paper-writer 的实例）")
    ap.add_argument("--materials-root", help="相对材料路径的解析根（可选）")
    ap.add_argument("--json", action="store_true", help="输出 JSON（给 report 用）")
    ap.add_argument("--selftest", action="store_true", help="跑夹具自检")
    a = ap.parse_args(argv)

    if a.selftest:
        return selftest()

    verdict, rows, pre, summary = check(a.declaration, a.materials_root)
    if a.json:
        print(json.dumps({
            "gate": "author-material",
            "ok": verdict == "pass",
            "precondition": pre,
            "count": len([r for r in rows if r["level"] == "fail"]),
            "summary": summary,
            "findings": [
                {"line": None, "rule": "author-material", "why": r["why"], "text": r["field"]}
                for r in rows if r["level"] == "fail"
            ],
            "notes": [r["why"] for r in rows if r["level"] == "note"],
        }, ensure_ascii=False, indent=2))
    else:
        print("════ 作者材料前提门 ════")
        for r in rows:
            print("  %-4s %-24s %s" % ("FAIL" if r["level"] == "fail" else "note", r["field"], r["why"]))
        print("\n  判定：%s" % summary)

    if pre:
        return 2
    return 0 if verdict == "pass" else 1


# ---------------------------------------------------------------- selftest
def selftest():
    tmp = tempfile.mkdtemp(prefix="ps-material-")
    good_file = os.path.join(tmp, "材料-分析集说明.md")
    with open(good_file, "w", encoding="utf-8") as fh:
        fh.write("# 分析集说明\n" + "真实测量数据，含 6 张表与 4 张图的原始来源。\n" * 20)
    shell_file = os.path.join(tmp, "空壳.md")
    with open(shell_file, "w", encoding="utf-8") as fh:
        fh.write("x")

    def w(name, obj):
        p = os.path.join(tmp, name)
        with open(p, "w", encoding="utf-8") as fh:
            if isinstance(obj, str):
                fh.write(obj)
            else:
                json.dump(obj, fh, ensure_ascii=False)
        return p

    ok_decl = {"material_kind": "author_data", "material_path_or_note": good_file, "claim_policy": "materials_only"}
    cases = [
        ("① 合格声明必须过（负控）", w("a.json", ok_decl), "pass", False),
        ("② 必填字段缺失 ⇒ 断言失败", w("b.json", {"material_kind": "author_data"}), "fail", False),
        ("③ 取值域越界（material_kind）⇒ 断言失败", w("c.json", dict(ok_decl, material_kind="vibes")), "fail", False),
        ("④ 声明路径不存在 ⇒ 断言失败", w("d.json", dict(ok_decl, material_path_or_note=os.path.join(tmp, "nope.md"))), "fail", False),
        ("⑤ 材料是空壳（1 字节）⇒ 断言失败", w("e.json", dict(ok_decl, material_path_or_note=shell_file)), "fail", False),
        ("⑥ 说明是占位符（见附件/TBD）⇒ 断言失败", w("f.json", {"material_kind": "verified_retrieval", "material_path_or_note": "见附件", "claim_policy": "verified_retrieval"}), "fail", False),
        ("⑦ 口径不自洽（materials_only + 检索）⇒ 断言失败", w("g.json", {"material_kind": "verified_retrieval", "material_path_or_note": good_file, "claim_policy": "materials_only"}), "fail", False),
        ("⑧ 坏 JSON / 缺文件 ⇒ 前提层失败（不是断言失败）", w("h.json", "{ this is not json"), "precondition", True),
        ("⑨ 缺声明（None）⇒ 前提层失败", None, "precondition", True),
        # 反向控制：多写了未知字段，**不得**因此判失败（宽容未知字段）
        ("⑩ 反向控制：多余字段不得导致失败", w("i.json", dict(ok_decl, note="作者口头补充", deadline="2026-11-01")), "pass", False),
        # 反向控制：够长的正常说明（不是路径）必须过
        ("⑪ 反向控制：正常的文字说明必须过", w("j.json", {"material_kind": "field_common_knowledge", "material_path_or_note": "本组此前三篇同题论文的实测口径与失败模式，可直接引用其中的实验设置、仪器参数与失效判据（均已在本机留档，随时可核）。", "claim_policy": "field_common_knowledge"}), "pass", False),
        # ★ 2026-10-14 新增三条：锁住"短标记必须带词边界"这个修（原 `N/?A` 会匹配 OpenAlex/analysis/final…）
        ("⑫ 反向控制：说明含 OpenAlex / final analysis / nature ⇒ 不得当占位符",
         w("k.json", {"material_kind": "verified_retrieval", "claim_policy": "verified_retrieval",
                      "material_path_or_note": "已用 OpenAlex 实测取回三篇；final analysis 与 nature 关键词的检索式与日期均记录在台账里，可复算。"}), "pass", False),
        ("⑬ 反向控制：说明含「策略」「省略」⇒ 不得当占位符（原来 `略` 会误命中）",
         w("l.json", {"material_kind": "verified_retrieval", "claim_policy": "verified_retrieval",
                      "material_path_or_note": "检索策略与筛选策略逐条写明，省略号之外的限定词也全部列出（含年份与语种限制），任何人照抄这段都能把同一批文献重新检索出来。"}), "pass", False),
        ("⑭ 必失败：真的 N/A 标记仍须判占位符（修词边界不许放走真占位符）",
         w("m.json", {"material_kind": "verified_retrieval", "claim_policy": "verified_retrieval",
                      "material_path_or_note": "本次材料的检索台账尚未整理，相关条目暂记为 N/A，稍后再补。"}), "fail", False),
        ("⑮ 必失败：口径 materials_only 却给文字说明（指不到材料）—— 本轮同判回归抓出的洞",
         w("n.json", {"material_kind": "author_data", "claim_policy": "materials_only",
                      "material_path_or_note": "作者手上有完整的原始测量记录与仪器参数表，这批材料足以支撑全文的所有实验结论，需要时再提供给编辑部。"}), "fail", False),
    ]
    print("════ _gate-author-material --selftest ════")
    bad = 0
    for name, decl, want, want_pre in cases:
        got, rows, pre, summary = check(decl, materials_root=tmp)
        got_pre = pre
        good = (got == want and got_pre == want_pre)
        print("  %s %s" % ("✔" if good else "✘", name))
        if not good:
            bad += 1
            print("      期望 %s(pre=%s) 实得 %s(pre=%s) | %s" % (want, want_pre, got, got_pre, summary))
    print("\n  ✔ 夹具 %d/%d 判别正确（5 反向控制/负控 + 8 注入 + 2 前提）" % (len(cases) - bad, len(cases)))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
