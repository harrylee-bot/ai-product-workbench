#!/usr/bin/env python3
"""Render a validated plain business document without fetching links or executing markup."""
import argparse
import json
import re
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from render_prd_docx import choose_font, set_font, paragraph_format


def render(source, output):
    document = Document()
    section = document.sections[0]
    section.top_margin = section.bottom_margin = Inches(0.8)
    section.left_margin = section.right_margin = Inches(0.9)
    _, family = choose_font()
    for name, size in [("Normal", 11), ("Title", 20), ("Heading 1", 14),
                       ("Heading 2", 12), ("Heading 3", 11), ("Heading 4", 11)]:
        style = document.styles[name]
        style.font.name = family
        style.font.size = Pt(size)
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.font.underline = False
        for border in style.element.xpath("./w:pPr/w:pBdr"):
            border.getparent().remove(border)
        fonts = style.element.get_or_add_rPr().get_or_add_rFonts()
        for key in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            fonts.attrib.pop(qn(f"w:{key}"), None)
        for key in ("ascii", "hAnsi", "eastAsia", "cs"):
            fonts.set(qn(f"w:{key}"), family)
    title = document.add_heading(source["title"], 0)
    paragraph_format(title, after=12, keep=True)
    for run in title.runs:
        set_font(run, family)
    text = source.get("text") or source["markdown"]
    for line in text.splitlines():
        heading = re.fullmatch(r"(#{1,6})\s+(.+)", line) if "markdown" in source else None
        if heading:
            paragraph = document.add_heading(heading.group(2), min(len(heading.group(1)), 4))
        else:
            paragraph = document.add_paragraph(line)
        paragraph_format(paragraph, before=8 if heading else 0, keep=bool(heading))
        for run in paragraph.runs:
            set_font(run, family, None if heading else 11)
    document.save(output)
    if Path(output).stat().st_size == 0:
        raise RuntimeError("Empty document export")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    render(json.loads(Path(args.source).read_text(encoding="utf-8")), args.output)
