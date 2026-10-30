#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
md2docx.py —— 把 docs/*.md 转成排版好的 Word（.docx）。

为什么自己写：本机没有 pandoc，也不希望为了一个转换去引一堆依赖。
只支持本项目文档实际用到的 Markdown 子集：
  标题 # ~ #### ｜ 段落（**粗体** `等宽` [链接](url)）｜ 表格（含表头分隔行）
  围栏代码块 ``` ｜ 引用 > ｜ 有序/无序列表（2 空格缩进）｜ 分隔线 ---

用法：
  python tools/md2docx.py docs/作品信息.md 作品信息.docx
  python tools/md2docx.py docs/作品信息.md --keep-placeholder   # 保留 __REPO_URL__ 便于校验
"""

import os
import re
import sys

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# ---------------------------------------------------------------- 设计变量
CN_BODY = "宋体"
CN_HEAD = "黑体"
MONO = "Consolas"
NAVY = RGBColor(0x0F, 0x2A, 0x4A)
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
GREY = RGBColor(0x59, 0x59, 0x59)
CODE_BG = "F4F6F8"
HEAD_BG = "12304F"
ZEBRA_BG = "F7F9FB"


# ---------------------------------------------------------------- 底层工具
def set_font(run, name, size=None, bold=None, color=None, italic=None):
    run.font.name = name
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), name)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color is not None:
        run.font.color.rgb = color


def shade(element, fill):
    """给段落或单元格加底色"""
    pr = element._element.get_or_add_tcPr() if hasattr(element._element, "get_or_add_tcPr") else element._element.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    pr.append(shd)


def para_border(paragraph, edge="bottom", color="1F4E79", sz=6, space=2):
    pPr = paragraph._element.get_or_add_pPr()
    borders = pPr.find(qn("w:pBdr"))
    if borders is None:
        borders = OxmlElement("w:pBdr")
        pPr.append(borders)
    el = OxmlElement(f"w:{edge}")
    el.set(qn("w:val"), "single")
    el.set(qn("w:sz"), str(sz))
    el.set(qn("w:space"), str(space))
    el.set(qn("w:color"), color)
    borders.append(el)


def cell_borders(cell, color="D6DCE4", sz=4):
    tcPr = cell._element.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(sz))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        borders.append(el)
    tcPr.append(borders)


def cell_margins(table, top=60, bottom=60, left=90, right=90):
    tblPr = table._element.tblPr
    mar = OxmlElement("w:tblCellMar")
    for edge, val in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:w"), str(val))
        el.set(qn("w:type"), "dxa")
        mar.append(el)
    tblPr.append(mar)


def add_page_number(section):
    p = section.footer.paragraphs[0]
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("— ")
    set_font(r, CN_BODY, 9, color=GREY)
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    inner = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "1"
    inner.append(t)
    fld.append(inner)
    p._p.append(fld)
    r2 = p.add_run(" —")
    set_font(r2, CN_BODY, 9, color=GREY)


def no_split(row, header=False):
    """行内禁止跨页断开；表头行同时设为跨页重复"""
    trPr = row._tr.get_or_add_trPr()
    cant = OxmlElement("w:cantSplit")
    trPr.append(cant)
    if header:
        th = OxmlElement("w:tblHeader")
        th.set(qn("w:val"), "true")
        trPr.append(th)


# ---------------------------------------------------------------- 行内解析
TOKEN = re.compile(r"(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))")


def add_inline(paragraph, text, size=10.5, color=None, bold_all=False):
    """把 **粗体** / `代码` / [文字](链接) 拆成 run"""
    for part in TOKEN.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            r = paragraph.add_run(part[2:-2])
            set_font(r, CN_BODY, size, bold=True, color=color)
        elif part.startswith("`") and part.endswith("`") and len(part) > 2:
            r = paragraph.add_run(part[1:-1])
            set_font(r, MONO, size - 0.5, color=RGBColor(0xB0, 0x30, 0x20))
        else:
            m = re.fullmatch(r"\[([^\]]+)\]\(([^)]+)\)", part)
            if m:
                r = paragraph.add_run(m.group(1))
                set_font(r, CN_BODY, size, color=ACCENT, bold=bold_all)
                r.font.underline = True
            else:
                r = paragraph.add_run(part)
                set_font(r, CN_BODY, size, bold=bold_all or None, color=color)


# ---------------------------------------------------------------- 主转换
def convert(md_path, docx_path):
    with open(md_path, "r", encoding="utf-8") as f:
        lines = f.read().replace("\r\n", "\n").split("\n")

    doc = Document()

    # 页面：A4，页边距
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)
    sec.top_margin = Cm(2.2)
    sec.bottom_margin = Cm(2.0)
    sec.left_margin = Cm(2.4)
    sec.right_margin = Cm(2.4)

    normal = doc.styles["Normal"]
    normal.font.name = CN_BODY
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), CN_BODY)
    pf = normal.paragraph_format
    pf.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
    pf.line_spacing = 1.45
    pf.space_after = Pt(6)

    add_page_number(sec)

    i = 0
    n = len(lines)
    first_h1_done = False

    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        # 空行
        if not stripped:
            i += 1
            continue

        # 围栏代码块
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i].rstrip("\n"))
                i += 1
            i += 1
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(4)
            p.paragraph_format.space_after = Pt(8)
            p.paragraph_format.line_spacing = 1.02
            p.paragraph_format.left_indent = Cm(0.3)
            shade(p, CODE_BG)
            para_border(p, "left", "1F4E79", 12, 6)
            for k, code_line in enumerate(buf):
                r = p.add_run(code_line if code_line else "")
                set_font(r, MONO, 8.5, color=RGBColor(0x24, 0x29, 0x2E))
                if k < len(buf) - 1:
                    r.add_break()
            continue

        # 分隔线
        if re.fullmatch(r"-{3,}", stripped):
            p = doc.add_paragraph()
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.space_after = Pt(10)
            para_border(p, "bottom", "D6DCE4", 6, 1)
            i += 1
            continue

        # 表格
        if stripped.startswith("|") and i + 1 < n and re.fullmatch(r"\|[\s:\-|]+\|", lines[i + 1].strip()):
            header = [c.strip() for c in stripped.strip("|").split("|")]
            i += 2
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append([c.strip() for c in lines[i].strip().strip("|").split("|")])
                i += 1
            add_table(doc, header, rows)
            continue

        # 标题
        m = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if m:
            level = len(m.group(1))
            text = m.group(2).strip()
            add_heading(doc, text, level, first_h1_done)
            if level == 1:
                first_h1_done = True
            i += 1
            continue

        # 引用
        if stripped.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.5)
            p.paragraph_format.space_before = Pt(4)
            p.paragraph_format.space_after = Pt(8)
            para_border(p, "left", "C9D4E0", 18, 8)
            shade(p, "FAFBFC")
            for k, t in enumerate(buf):
                if k:
                    p.add_run().add_break()
                add_inline(p, t, 10, color=GREY)
            continue

        # 有序列表
        m = re.match(r"^(\s*)(\d+)\.\s+(.*)$", line)
        if m:
            indent = len(m.group(1))
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.75 + 0.6 * (indent // 2))
            p.paragraph_format.first_line_indent = Cm(-0.55)
            p.paragraph_format.space_after = Pt(3)
            r = p.add_run(f"{m.group(2)}. ")
            set_font(r, CN_BODY, 10.5, bold=True, color=ACCENT)
            add_inline(p, m.group(3))
            i += 1
            continue

        # 无序列表
        m = re.match(r"^(\s*)[-*]\s+(.*)$", line)
        if m:
            indent = len(m.group(1))
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Cm(0.75 + 0.6 * (indent // 2))
            p.paragraph_format.first_line_indent = Cm(-0.42)
            p.paragraph_format.space_after = Pt(3)
            r = p.add_run("· ")
            set_font(r, CN_BODY, 10.5, bold=True, color=ACCENT)
            add_inline(p, m.group(2))
            i += 1
            continue

        # 普通段落（合并连续行）
        buf = [stripped]
        i += 1
        while i < n and lines[i].strip() and not re.match(r"^(#{1,4}\s|```|\||>|\s*[-*]\s|\s*\d+\.\s|-{3,}$)", lines[i].strip()):
            buf.append(lines[i].strip())
            i += 1
        p = doc.add_paragraph()
        p.paragraph_format.first_line_indent = Cm(0)
        add_inline(p, " ".join(buf))

    doc.save(docx_path)
    return docx_path


def add_heading(doc, text, level, compact=False):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.keep_with_next = True
    if level == 1:
        pf.space_before = Pt(0 if not compact else 14)
        pf.space_after = Pt(6)
        r = p.add_run(text)
        set_font(r, CN_HEAD, 20, bold=True, color=NAVY)
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        para_border(p, "bottom", "12304F", 10, 6)
    elif level == 2:
        pf.space_before = Pt(16)
        pf.space_after = Pt(7)
        r = p.add_run(text)
        set_font(r, CN_HEAD, 14, bold=True, color=NAVY)
        para_border(p, "left", "12304F", 18, 8)
        pf.left_indent = Cm(0.2)
    elif level == 3:
        pf.space_before = Pt(11)
        pf.space_after = Pt(5)
        r = p.add_run(text)
        set_font(r, CN_HEAD, 11.5, bold=True, color=ACCENT)
    else:
        pf.space_before = Pt(8)
        pf.space_after = Pt(4)
        r = p.add_run(text)
        set_font(r, CN_HEAD, 10.5, bold=True, color=RGBColor(0x33, 0x33, 0x33))


def add_table(doc, header, rows):
    cols = len(header)
    table = doc.add_table(rows=1, cols=cols)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    cell_margins(table)

    hdr = table.rows[0]
    no_split(hdr, header=True)
    for j, txt in enumerate(header):
        cell = hdr.cells[j]
        cell.text = ""
        p = cell.paragraphs[0]
        p.paragraph_format.space_after = Pt(2)
        p.paragraph_format.space_before = Pt(2)
        p.paragraph_format.line_spacing = 1.15
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        add_inline(p, txt, 9, color=RGBColor(0xFF, 0xFF, 0xFF), bold_all=True)
        shade(cell, HEAD_BG)
        cell_borders(cell, "12304F")

    for k, row in enumerate(rows):
        r_obj = table.add_row()
        no_split(r_obj)
        cells = r_obj.cells
        for j in range(cols):
            cell = cells[j]
            txt = row[j] if j < len(row) else ""
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
            p.paragraph_format.line_spacing = 1.15
            if re.fullmatch(r"[#\d.,%¥$\s]+|STEPUP|ALLOW|CLARIFY|MIT", txt):
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                p.alignment = WD_ALIGN_PARAGRAPH.LEFT
            add_inline(p, txt, 9)
            cell_borders(cell)
            if k % 2 == 1:
                shade(cell, ZEBRA_BG)

    # 表后留白
    tail = doc.add_paragraph()
    tail.paragraph_format.space_after = Pt(2)
    tail.paragraph_format.line_spacing = 0.6


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        print(__doc__)
        sys.exit(1)
    src = args[0]
    dst = args[1] if len(args) > 1 else os.path.splitext(src)[0] + ".docx"
    convert(src, dst)
    print(f"已生成：{dst}")


if __name__ == "__main__":
    main()
