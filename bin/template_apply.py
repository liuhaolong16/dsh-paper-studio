# -*- coding: utf-8 -*-
"""按期刊 spec 重写 docx 版面：页面、页边距、默认字体字号、行距、命名样式。

用法：python template_apply.py <in.docx> <spec.json> <out.docx>

只改“版式层”，不动正文内容。修改项：
- 每个 section 的纸张尺寸与四边页边距（cm）
- Normal 样式的西文字体 / 字号 / 行距 / eastAsia 字体
- spec.docx.styleMap 指定角色的字号、加粗、颜色
"""
import json
import sys

from docx import Document
from docx.shared import Cm, Pt, RGBColor
from docx.oxml.ns import qn


def set_east_asia(style, name):
    rpr = style.element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = rpr.makeelement(qn("w:rFonts"), {})
        rpr.append(rfonts)
    rfonts.set(qn("w:eastAsia"), name)


def main():
    if len(sys.argv) != 4:
        print("usage: template_apply.py <in.docx> <spec.json> <out.docx>", file=sys.stderr)
        return 2
    src, spec_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
    spec = json.load(open(spec_path, encoding="utf-8"))
    d = spec.get("docx") or {}
    doc = Document(src)

    page = d.get("page") or {}
    margins = d.get("margins_cm") or {}
    for sec in doc.sections:
        if page.get("width_cm"):
            sec.page_width = Cm(page["width_cm"])
        if page.get("height_cm"):
            sec.page_height = Cm(page["height_cm"])
        if margins.get("top") is not None:
            sec.top_margin = Cm(margins["top"])
        if margins.get("bottom") is not None:
            sec.bottom_margin = Cm(margins["bottom"])
        if margins.get("left") is not None:
            sec.left_margin = Cm(margins["left"])
        if margins.get("right") is not None:
            sec.right_margin = Cm(margins["right"])

    normal = doc.styles["Normal"]
    df = d.get("default_font") or {}
    if df.get("ascii"):
        normal.font.name = df["ascii"]
    if df.get("size_pt"):
        normal.font.size = Pt(df["size_pt"])
    if df.get("eastAsia"):
        set_east_asia(normal, df["eastAsia"])
    if d.get("line_spacing"):
        normal.paragraph_format.line_spacing = d["line_spacing"]

    style_map = d.get("styleMap") or {}
    styles = d.get("styles") or {}
    for role, style_id in style_map.items():
        want = styles.get(role) or {}
        if not want:
            continue
        try:
            st = doc.styles[style_id]
        except KeyError:
            # 模板样式在本稿里不存在：补建一个同名段落样式（id 由 Word 按名称生成）
            from docx.enum.style import WD_STYLE_TYPE
            st = doc.styles.add_style(style_id, WD_STYLE_TYPE.PARAGRAPH)
            print("add style " + style_id, file=sys.stderr)
        if want.get("size_pt"):
            st.font.size = Pt(want["size_pt"])
        if want.get("bold") is not None:
            st.font.bold = bool(want["bold"])
        if want.get("color"):
            st.font.color.rgb = RGBColor.from_string(str(want["color"]).replace("#", "").upper())

    doc.save(out)
    print("applied: " + out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
