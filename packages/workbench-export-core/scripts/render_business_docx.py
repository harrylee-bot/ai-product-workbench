#!/usr/bin/env python3
"""Render a validated plain business document without fetching links or executing markup."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor
from render_prd_docx import append_link, choose_font, set_font, paragraph_format


def safe_link(value):
    if not isinstance(value, str) or any(ord(char) < 32 for char in value):
        return None
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme.lower() in ("http", "https") and parsed.hostname and not parsed.username and not parsed.password:
        return value
    if parsed.scheme.lower() == "mailto" and parsed.path:
        return value
    return None


class MarkdownRenderer:
    """Render the server-parsed CommonMark/GFM tree; never load remote assets."""

    def __init__(self, document, family, tree):
        self.document = document
        self.family = family
        self.definitions = {}
        self.footnotes = {}
        pending = list(reversed(tree.get("children", [])))
        while pending:
            node = pending.pop()
            if node["type"] == "definition":
                self.definitions.setdefault(node["identifier"], node["url"])
            elif node["type"] == "footnoteDefinition":
                self.footnotes.setdefault(node["identifier"], node)
            pending.extend(reversed(node.get("children", [])))

    def plain(self, node):
        return node.get("value", node.get("alt", "")) or "".join(self.plain(child) for child in node.get("children", []))

    def inlines(self, paragraph, nodes, marks=()):
        for node in nodes:
            kind = node["type"]
            if kind in ("strong", "emphasis", "delete"):
                self.inlines(paragraph, node.get("children", []), (*marks, kind))
            elif kind == "break":
                paragraph.add_run().add_break()
            elif kind in ("link", "linkReference", "image", "imageReference"):
                href = node.get("url") or self.definitions.get(node.get("identifier"))
                text = self.plain(node) or href or "图片"
                # Images remain labelled references: exporting must not fetch arbitrary URLs.
                if kind.startswith("image"):
                    text = f"[图片：{text}]"
                if safe_link(href):
                    append_link(paragraph, text, self.family, href=href)
                else:
                    self.inlines(paragraph, [{"type": "text", "value": text}], marks)
            elif kind == "footnoteReference":
                self.inlines(paragraph, [{"type": "text", "value": f"[{node['identifier']}]"}], marks)
            elif "children" in node:
                self.inlines(paragraph, node["children"], marks)
            else:
                run = paragraph.add_run(node.get("value", ""))
                set_font(run, self.family)
                if "strong" in marks:
                    run.bold = True
                if "emphasis" in marks:
                    run.italic = True
                if "delete" in marks:
                    run.font.strike = True
                if kind == "inlineCode":
                    set_font(run, "Courier New", 10)

    def list_numbering(self, ordered, start):
        root = self.document.part.numbering_part.element
        ids = [int(node.get(qn("w:abstractNumId"))) for node in root.findall(qn("w:abstractNum"))]
        abstract_id = max(ids, default=-1) + 1
        abstract = OxmlElement("w:abstractNum")
        abstract.set(qn("w:abstractNumId"), str(abstract_id))
        level = OxmlElement("w:lvl")
        level.set(qn("w:ilvl"), "0")
        for tag, value in (("start", str(start)), ("numFmt", "decimal" if ordered else "bullet"),
                           ("lvlText", "%1." if ordered else "•"), ("lvlJc", "left")):
            element = OxmlElement(f"w:{tag}")
            element.set(qn("w:val"), value)
            level.append(element)
        abstract.append(level)
        root.insert_element_before(abstract, "w:num", "w:numIdMacAtCleanup")
        return root.add_num(abstract_id).numId

    def paragraph(self, container, children, *, depth=0, quote=False, heading=None):
        paragraph = container.add_heading("", heading) if heading else container.add_paragraph()
        paragraph_format(paragraph, before=8 if heading else 0, keep=bool(heading))
        if depth or quote:
            paragraph.paragraph_format.left_indent = Inches(0.25 * (depth + int(quote)))
        self.inlines(paragraph, children)
        return paragraph

    def blocks(self, nodes, container=None, depth=0, quote=False):
        container = container or self.document
        for node in nodes:
            kind = node["type"]
            if kind in ("paragraph", "heading"):
                self.paragraph(container, node.get("children", []), depth=depth, quote=quote,
                               heading=min(node.get("depth", 0), 6) or None)
            elif kind == "list":
                start = node.get("start")
                num_id = self.list_numbering(node.get("ordered", False), 1 if start is None else start)
                for item in node.get("children", []):
                    children = item.get("children", [])
                    if children and children[0]["type"] == "paragraph":
                        content = children[0].get("children", [])
                        if item.get("checked") is not None:
                            content = [{"type": "text", "value": "☑ " if item["checked"] else "☐ "}, *content]
                        paragraph = self.paragraph(container, content, depth=depth + 1, quote=quote)
                        numpr = paragraph._p.get_or_add_pPr().get_or_add_numPr()
                        numpr.get_or_add_ilvl().val = 0
                        numpr.get_or_add_numId().val = num_id
                        paragraph.paragraph_format.first_line_indent = Inches(-0.18)
                        children = children[1:]
                    self.blocks(children, container, depth + 1, quote)
            elif kind == "table":
                rows = node.get("children", [])
                columns = max((len(row.get("children", [])) for row in rows), default=0)
                if not columns:
                    continue
                table = container.add_table(rows=len(rows), cols=columns)
                table.style = "Table Grid"
                for row_index, row in enumerate(rows):
                    for column, cell in enumerate(row.get("children", [])):
                        paragraph = table.cell(row_index, column).paragraphs[0]
                        self.inlines(paragraph, cell.get("children", []), ("strong",) if row_index == 0 else ())
                        alignments = node.get("align") or []
                        alignment = alignments[column] if column < len(alignments) else None
                        paragraph.alignment = {"left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
                                               "right": WD_ALIGN_PARAGRAPH.RIGHT}.get(alignment)
                    if row_index == 0:
                        header = OxmlElement("w:tblHeader")
                        table.rows[0]._tr.get_or_add_trPr().append(header)
            elif kind == "blockquote":
                self.blocks(node.get("children", []), container, depth, True)
            elif kind == "code":
                paragraph = self.paragraph(container, [], depth=depth, quote=quote)
                set_font(paragraph.add_run(node.get("value", "")), "Courier New", 10)
            elif kind == "thematicBreak":
                paragraph = container.add_paragraph()
                border = OxmlElement("w:pBdr")
                bottom = OxmlElement("w:bottom")
                for key, value in (("val", "single"), ("sz", "4"), ("color", "999999")):
                    bottom.set(qn(f"w:{key}"), value)
                border.append(bottom)
                paragraph._p.get_or_add_pPr().append(border)
            elif kind not in ("definition", "footnoteDefinition"):
                # Raw HTML and unknown literals are text, never active content.
                self.paragraph(container, [{"type": "text", "value": self.plain(node)}], depth=depth, quote=quote)

    def render(self, tree):
        self.blocks(tree.get("children", []))
        for identifier, note in self.footnotes.items():
            self.paragraph(self.document, [{"type": "text", "value": f"[{identifier}]"}])
            self.blocks(note.get("children", []))


def render(source, output):
    document = Document()
    section = document.sections[0]
    section.top_margin = section.bottom_margin = Inches(0.8)
    section.left_margin = section.right_margin = Inches(0.9)
    _, family = choose_font()
    for name, size in [("Normal", 11), ("Title", 20), ("Heading 1", 14),
                       ("Heading 2", 12), ("Heading 3", 11), ("Heading 4", 11),
                       ("Heading 5", 11), ("Heading 6", 11)]:
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
    if "markdown" in source:
        tree = source.get("markdownAst")
        if not isinstance(tree, dict) or tree.get("type") != "root":
            raise ValueError("Markdown export requires a parsed document tree")
        MarkdownRenderer(document, family, tree).render(tree)
    else:
        for line in source["text"].splitlines():
            paragraph = document.add_paragraph(line)
            paragraph_format(paragraph)
            for run in paragraph.runs:
                set_font(run, family, 11)
    document.save(output)
    if Path(output).stat().st_size == 0:
        raise RuntimeError("Empty document export")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    render(json.loads(Path(args.source).read_text(encoding="utf-8")), args.output)
