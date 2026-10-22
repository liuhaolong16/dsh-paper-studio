# -*- coding: utf-8 -*-
"""从 Markdown 按期刊 spec 生成 docx（版式优先，不做复杂排版）。

用法：python template_build.py <draft.md> <spec.json> <out.docx>

Markdown 映射：
- `# `   → Title
- `## `  → Heading1
- `### ` → Heading2
- `#### `→ Heading3
- `- `   → List Bullet
- 其余非空行 → 正文段落（Normal）
"""
import json
import re
import sys

from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn

ROLE_BUILTIN = {
    "Title": "Title",
    "Heading1": "Heading 1",
    "Heading2": "Heading 2",
    "Heading3": "Heading 3",
    "References": "References",
}


def set_east_asia(style, name):
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)


def get_or_add_style(doc, role, spec_id=None):
    # 优先用 spec 里的真实 styleId（如 MDPI12title）；没有再用内置样式名
    name = spec_id or ROLE_BUILTIN.get(role) or role
    try:
        return doc.styles[name]
    except KeyError:
        return doc.styles.add_style(name, WD_STYLE_TYPE.PARAGRAPH)


def main():
    if len(sys.argv) != 4:
        print("usage: template_build.py <draft.md> <spec.json> <out.docx>", file=sys.stderr)
        return 2
    md_path, spec_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    spec = json.load(open(spec_path, encoding="utf-8"))
    d = spec.get("docx") or {}
    page = d.get("page") or {}
    margins = d.get("margins_cm") or {}
    df = d.get("default_font") or {}
    style_map = d.get("styleMap") or {}
    styles = d.get("styles") or {}

    doc = Document()
    for sec in doc.sections:
        if page.get("width_cm"):
            sec.page_width = Cm(page["width_cm"])
        if page.get("height_cm"):
            sec.page_height = Cm(page["height_cm"])
        for k in ("top", "bottom", "left", "right"):
            if margins.get(k) is not None:
                setattr(sec, k + "_margin", Cm(margins[k]))

    normal = doc.styles["Normal"]
    if df.get("ascii"):
        normal.font.name = df["ascii"]
    if df.get("size_pt"):
        normal.font.size = Pt(df["size_pt"])
    if df.get("eastAsia"):
        set_east_asia(normal, df["eastAsia"])
    if d.get("line_spacing"):
        normal.paragraph_format.line_spacing = d["line_spacing"]

    role_style = {}
    for role, style_id in style_map.items():
        want = styles.get(role) or {}
        st = get_or_add_style(doc, role, style_id)
        if df.get("ascii"):
            st.font.name = df["ascii"]
        if want.get("size_pt"):
            st.font.size = Pt(want["size_pt"])
        if want.get("bold") is not None:
            st.font.bold = bool(want["bold"])
        if want.get("color"):
            st.font.color.rgb = RGBColor.from_string(str(want["color"]).replace("#", "").upper())
        role_style[role] = st

    text = open(md_path, encoding="utf-8").read()
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        if line.startswith("# "):
            doc.add_paragraph(line[2:].strip(), style=(role_style.get("Title") or "Title"))
        elif line.startswith("## "):
            doc.add_paragraph(line[3:].strip(), style=(role_style.get("Heading1") or "Heading 1"))
        elif line.startswith("### "):
            doc.add_paragraph(line[4:].strip(), style=(role_style.get("Heading2") or "Heading 2"))
        elif line.startswith("#### "):
            doc.add_paragraph(line[5:].strip(), style=(role_style.get("Heading3") or "Heading 3"))
        elif line.startswith("- "):
            doc.add_paragraph(line[2:].strip(), style="List Bullet")
        else:
            doc.add_paragraph(re.sub(r"\*\*(.+?)\*\*", r"\1", line).strip())

    doc.save(out)
    print("built: " + out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
