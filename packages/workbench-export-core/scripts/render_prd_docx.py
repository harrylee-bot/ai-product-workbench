#!/usr/bin/env python3
"""Render a validated PRD v2 into the retained requirement-document template.

The TypeScript entry point validates the complete source contract. This renderer
preserves the template's page/style/header/footer definitions, replaces its sample
body, and checks source text coverage before returning a file.
"""
from __future__ import annotations

import argparse
from collections import defaultdict, deque
from copy import deepcopy
import json
from hashlib import sha256
import math
import os
from pathlib import Path
import re
import sys
from urllib.parse import urljoin, urlsplit
import zipfile

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor, Twips
from docx.table import Table
from PIL import Image, ImageDraw, ImageFont


FONT_CANDIDATES = [
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"),
    ("/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"),
    ("/usr/share/fonts/noto/NotoSansCJK-Regular.ttc", "Noto Sans CJK SC"),
    ("/System/Library/Fonts/Supplemental/Songti.ttc", "Songti SC"),
    ("/System/Library/Fonts/STHeiti Light.ttc", "Heiti SC"),
]
CHANNELS = {"inApp": "端内渠道", "wapH5": "WAP/H5端外渠道", "miniProgram": "小程序"}
PRIORITIES = {"primary": "主要", "secondary": "次要", "must": "必须", "should": "应当", "could": "可选", "wont": "本期不做"}
LEVELS = {"low": "低", "medium": "中", "high": "高"}
ASSUMPTION_STATUS = {"open": "尚未验证", "validated": "已验证", "rejected": "已否定"}
REVISION_STATUS = {"draft": "草稿", "inReview": "评审中", "approved": "已通过"}
TONES = {"info": "说明", "warning": "注意", "success": "完成条件", "critical": "重要约束"}


def choose_font():
    custom = os.environ.get("WORKBENCH_EXPORT_CJK_FONT_PATH")
    if custom and Path(custom).is_file():
        return custom, os.environ.get("WORKBENCH_EXPORT_CJK_FONT_NAME", "Noto Sans CJK SC")
    for path, name in FONT_CANDIDATES:
        if Path(path).is_file():
            return path, name
    raise RuntimeError("An installed CJK font is required for PRD document export")


def set_font(run, family, size=None):
    run.font.name = family
    if size is not None:
        run.font.size = Pt(size)
    fonts = run._element.get_or_add_rPr().get_or_add_rFonts()
    for key in ("ascii", "hAnsi", "eastAsia", "cs"):
        fonts.set(qn(f"w:{key}"), family)


def paragraph_format(p, *, after=6, before=0, keep=False):
    p.paragraph_format.space_after = Pt(after)
    p.paragraph_format.space_before = Pt(before)
    p.paragraph_format.line_spacing = 1.2
    p.paragraph_format.keep_with_next = keep
    p.paragraph_format.widow_control = True
    # The legacy template carries a character/line grid. Let explicit paragraph
    # spacing govern new content; otherwise CJK fallback fonts expand each line
    # to several grid intervals in LibreOffice.
    ppr = p._p.get_or_add_pPr()
    for child in list(ppr):
        if child.tag == qn("w:snapToGrid"):
            ppr.remove(child)
    snap = OxmlElement("w:snapToGrid")
    snap.set(qn("w:val"), "0")
    ppr.insert_element_before(
        snap, "w:spacing", "w:ind", "w:contextualSpacing", "w:mirrorIndents",
        "w:suppressOverlap", "w:jc", "w:textDirection", "w:textAlignment",
        "w:textboxTightWrap", "w:outlineLvl", "w:divId", "w:cnfStyle",
        "w:rPr", "w:sectPr", "w:pPrChange",
    )


def append_bookmark(p, name, number):
    start = OxmlElement("w:bookmarkStart")
    start.set(qn("w:id"), str(number))
    start.set(qn("w:name"), name)
    end = OxmlElement("w:bookmarkEnd")
    end.set(qn("w:id"), str(number))
    ppr = p._p.pPr
    if ppr is not None:
        ppr.addnext(start)
    else:
        p._p.insert(0, start)
    p._p.append(end)


def append_link(p, text, family, href=None, anchor=None):
    link = OxmlElement("w:hyperlink")
    if href is not None:
        rel_id = p.part.relate_to(
            href, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            is_external=True,
        )
        link.set(qn("r:id"), rel_id)
    if anchor:
        link.set(qn("w:anchor"), anchor)
    run = OxmlElement("w:r")
    props = OxmlElement("w:rPr")
    fonts = OxmlElement("w:rFonts")
    for key in ("ascii", "hAnsi", "eastAsia"):
        fonts.set(qn(f"w:{key}"), family)
    props.append(fonts)
    color = OxmlElement("w:color")
    color.set(qn("w:val"), "174A7E")
    props.append(color)
    run.append(props)
    node = OxmlElement("w:t")
    node.text = text
    run.append(node)
    link.append(run)
    p._p.append(link)


def export_link_target(href):
    # Absolute source links retain their original destination. Relative links
    # need the website origin because a downloaded document has no website base.
    if re.match(r"^(?:https?://|mailto:)", href, re.IGNORECASE):
        return href
    if not href.startswith("/"):
        return None
    try:
        origin = os.environ.get("WORKBENCH_WEB_ORIGIN", "").strip()
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in ("http", "https") or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment
        ):
            return None
        return urljoin(origin.rstrip("/") + "/", href)
    except ValueError:
        return None


class Renderer:
    def __init__(self, source, template, output):
        self.source = source
        self.output = output
        self.doc = Document(template)
        self.font_path, self.font = choose_font()
        self.table_templates = [deepcopy(t._tbl) for t in self.doc.tables[:3]]
        if len(self.table_templates) != 3:
            raise RuntimeError("The requirement template must contain its three standard tables")
        self.safety_rows = [[c.text for c in row.cells] for row in self.doc.tables[2].rows]
        self.content_width = self.doc.sections[0].page_width - self.doc.sections[0].left_margin - self.doc.sections[0].right_margin
        # Body sample paragraphs, sample tables and drawings are all replaced.
        for child in list(self.doc._element.body):
            if child.tag != qn("w:sectPr"):
                self.doc._element.body.remove(child)
        for style in self.doc.styles:
            if style.type == 1 or style.type == 2:
                style.font.name = self.font
                fonts = style.element.get_or_add_rPr().get_or_add_rFonts()
                for key in ("ascii", "hAnsi", "eastAsia", "cs"):
                    fonts.set(qn(f"w:{key}"), self.font)
        self.doc.styles["Normal"].font.size = Pt(10.5)
        # Avoid template numbering being reapplied to already-numbered source headings.
        for name in ("Heading 1", "Heading 2", "Heading 3"):
            style = self.doc.styles[name]
            num = style.element.find(qn("w:pPr"))
            if num is not None:
                for child in list(num):
                    if child.tag == qn("w:numPr"):
                        num.remove(child)
        self.bookmark_number = 0

    def p(self, text=None, *, style=None, bold=None, size=None, keep=False):
        p = self.doc.add_paragraph(style=style)
        paragraph_format(p, keep=keep)
        if text is not None:
            run = p.add_run(str(text))
            set_font(run, self.font, size)
            if bold is not None:
                run.bold = bold
        return p

    def inlines(self, p, content):
        for item in content:
            kind = item["type"]
            if kind == "link":
                target = export_link_target(item["href"])
                if target is None:
                    set_font(p.add_run(item["text"]), self.font)
                else:
                    append_link(p, item["text"], self.font, href=target)
                # Keep the destination readable in PDF and printed copies as well.
                if item["href"] != item["text"]:
                    set_font(p.add_run(f"（{item['href']}）"), self.font)
            elif kind == "text":
                run = p.add_run(item["text"])
                set_font(run, self.font)
                marks = item.get("marks", [])
                run.bold = "strong" in marks
                run.italic = "emphasis" in marks
                run.font.strike = "strikethrough" in marks
                if "code" in marks:
                    run.font.name = "DejaVu Sans Mono"
                    shade = OxmlElement("w:shd")
                    shade.set(qn("w:fill"), "F2F2F2")
                    run._element.get_or_add_rPr().append(shade)
            elif kind == "citation":
                label = item.get("label")
                text = f"[{label}；{item['citationId']}]" if label else f"[{item['citationId']}]"
                set_font(p.add_run(text), self.font)
            elif kind == "reference":
                label = item.get("label")
                text = f"{label}（{item['targetId']}）" if label else item["targetId"]
                set_font(p.add_run(text), self.font)
            else:
                raise RuntimeError("Unsupported PRD inline type")
        return p

    def labelled(self, label, value):
        p = self.p()
        set_font(p.add_run(label), self.font)
        p.runs[-1].bold = True
        if isinstance(value, list):
            self.inlines(p, value)
        else:
            set_font(p.add_run(str(value)), self.font)
        return p

    def heading(self, title, level, anchor=None):
        p = self.p(title, style=f"Heading {level}", keep=True)
        p.paragraph_format.space_before = Pt(12 if level == 1 else 8)
        p.paragraph_format.space_after = Pt(6)
        p.paragraph_format.page_break_before = False
        p._p.get_or_add_pPr().get_or_add_numPr().get_or_add_numId().val = 0
        if anchor:
            self.bookmark_number += 1
            append_bookmark(p, anchor, self.bookmark_number)
        return p

    def cell(self, cell, value, *, header=False, size=10):
        cell.text = ""
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = cell.paragraphs[0]
        paragraph_format(p, after=3, before=3)
        if isinstance(value, list):
            self.inlines(p, value)
        else:
            p.add_run(str(value))
        for run in p.runs:
            set_font(run, self.font, size)
            if header:
                run.bold = True
        return p

    def format_table(self, table, widths=None):
        table.autofit = False
        count = len(table.columns)
        widths = widths or [1] * count
        width_twips = int(self.content_width / 635)
        sizes = [int(width_twips * w / sum(widths)) for w in widths]
        for col, size in zip(table.columns, sizes):
            col.width = Twips(size)
        props = table._tbl.tblPr
        old_borders = props.find(qn("w:tblBorders"))
        if old_borders is not None:
            props.remove(old_borders)
        borders = OxmlElement("w:tblBorders")
        for side in ("top", "left", "bottom", "right", "insideH", "insideV"):
            border = OxmlElement(f"w:{side}")
            border.set(qn("w:val"), "single")
            border.set(qn("w:sz"), "4")
            border.set(qn("w:color"), "AAB6C2")
            borders.append(border)
        props.append(borders)
        tbl_width = props.find(qn("w:tblW"))
        if tbl_width is not None:
            tbl_width.set(qn("w:w"), str(width_twips))
            tbl_width.set(qn("w:type"), "dxa")
        for index, row in enumerate(table.rows):
            row.height = None
            # Long source rows may span pages, rather than overflowing the page.
            trpr = row._tr.get_or_add_trPr()
            for child in list(trpr):
                if child.tag in (qn("w:cantSplit"), qn("w:trHeight")):
                    trpr.remove(child)
            if sum(len(cell.text) for cell in row.cells) <= 1500:
                trpr.append(OxmlElement("w:cantSplit"))
            if index == 0:
                repeat = OxmlElement("w:tblHeader")
                trpr.append(repeat)
            for cell, size in zip(row.cells, sizes):
                cell.width = Twips(size)
                for p in cell.paragraphs:
                    paragraph_format(p, after=3, before=3, keep=index == 0)
                    for run in p.runs:
                        set_font(run, self.font, 10)
                        if index == 0:
                            run.bold = True
                if index == 0:
                    shade = OxmlElement("w:shd")
                    shade.set(qn("w:fill"), "E9EEF3")
                    cell._tc.get_or_add_tcPr().append(shade)
        self.p()
        return table

    def standard_table(self, index, rows, widths=None):
        tbl = deepcopy(self.table_templates[index])
        self.doc._element.body.insert(len(self.doc._element.body) - 1, tbl)
        table = Table(tbl, self.doc._body)
        while len(table.rows) > 1:
            table._tbl.remove(table.rows[-1]._tr)
        for values in rows:
            row = table.add_row()
            for cell, value in zip(row.cells, values):
                self.cell(cell, value)
        return self.format_table(table, widths)

    def table(self, headers, rows, widths=None):
        # Use the template channel-table properties for all additional tables.
        table = self.doc.add_table(rows=1, cols=len(headers))
        inherited = deepcopy(self.table_templates[1].tblPr)
        table._tbl.remove(table._tbl.tblPr)
        table._tbl.insert(0, inherited)
        for cell, value in zip(table.rows[0].cells, headers):
            self.cell(cell, value, header=True)
        for values in rows:
            cells = table.add_row().cells
            for cell, value in zip(cells, values):
                self.cell(cell, value)
        return self.format_table(table, widths)

    def block(self, b):
        kind = b["type"]
        if kind == "paragraph":
            self.inlines(self.p(), b["content"])
        elif kind == "heading":
            # Source headings are subordinate to the fixed PRD section hierarchy.
            self.inlines(self.heading("", 3), b["content"])
        elif kind in ("bulletList", "orderedList"):
            for index, item in enumerate(b["items"], 1):
                p = self.p()
                p.paragraph_format.left_indent = Inches(0.16)
                p.paragraph_format.first_line_indent = Inches(-0.16)
                p.add_run(f"{index}. " if kind == "orderedList" else "• ")
                self.inlines(p, item["content"])
        elif kind == "table":
            # The contract permits 30 columns. Split wide tables into readable
            # panels, repeat the first column, and preserve every cell.
            columns = b["columns"]
            panels = [columns] if len(columns) <= 5 else [
                [columns[0], *columns[i:i + 4]] for i in range(1, len(columns), 4)
            ]
            for panel_index, panel in enumerate(panels):
                if len(panels) > 1:
                    self.p(f"表格 {b['id']}（第 {panel_index + 1}/{len(panels)} 部分）", keep=True)
                rows = []
                for row in b["rows"]:
                    by_column = {cell["columnId"]: cell["content"] for cell in row["cells"]}
                    rows.append([by_column.get(c["id"], "") for c in panel])
                self.table([c["label"] for c in panel], rows)
        elif kind == "callout":
            label = TONES[b["tone"]]
            self.labelled(f"{label}：", b["title"] or label)
            self.inlines(self.p(), b["content"])
        elif kind == "goal":
            self.p(f"目标：{b['title']}（{b['id']}）", bold=True, keep=True)
            self.inlines(self.p(), b["description"])
            self.labelled("成功衡量：", b["successMetric"])
            self.labelled("优先级：", PRIORITIES[b["priority"]])
        elif kind == "persona":
            self.p(f"用户角色：{b['name']}（{b['id']}）", bold=True, keep=True)
            self.inlines(self.p(), b["description"])
            for value in b["needs"]:
                self.labelled("用户需要：", value)
            for value in b["painPoints"]:
                self.labelled("现有问题：", value)
        elif kind == "requirement":
            self.p(f"需求：{b['title']}（{b['id']}）", bold=True, keep=True)
            self.inlines(self.p(), b["description"])
            self.labelled("优先级：", PRIORITIES[b["priority"]])
            self.labelled("关联目标：", "、".join(b["goalIds"]))
            self.labelled("关联验收标准：", "、".join(b["acceptanceCriterionIds"]))
        elif kind == "acceptanceCriterion":
            self.p(f"验收项：{b['id']}", bold=True, keep=True)
            self.labelled("关联需求：", "、".join(b["requirementIds"]))
            self.labelled("前置条件（Given）：", b["given"])
            self.labelled("触发操作（When）：", b["when"])
            self.labelled("可观察结果（Then）：", b["then"])
        elif kind == "flow":
            self.p(f"流程：{b['title']}（{b['id']}）", bold=True, keep=True)
            self.labelled("参与角色：", b["actor"])
            self.labelled("触发条件：", b["trigger"])
            for index, step in enumerate(b["steps"], 1):
                self.p(f"{index}. {step['text']}")
                self.p(f"步骤 {step['id']}；关联需求：{'、'.join(step['requirementIds'])}", size=9)
            self.labelled("完成结果：", b["outcome"])
        elif kind == "risk":
            self.p(f"风险：{b['id']}（发生概率：{LEVELS[b['likelihood']]}；影响：{LEVELS[b['impact']]}）", bold=True, keep=True)
            self.inlines(self.p(), b["description"])
            self.labelled("应对措施：", b["mitigation"])
        else:
            raise RuntimeError("Unsupported PRD block type")

    def section(self, section, anchor):
        self.heading(section["title"], 2, anchor)
        blocks = section["blocks"]
        if blocks[0]["type"] in ("heading", "table"):
            # A concise, source-derived introduction also makes table-only
            # sections accessible to consumers reading paragraph text.
            if blocks[0]["type"] == "table":
                labels = "、".join(c["label"] for c in blocks[0]["columns"])
                self.p(f"本节按“{labels}”列示具体要求。")
            else:
                self.p(f"本节内容：{section['title']}。")
        for block in blocks:
            self.block(block)

    def draw_diagram(self, diagram):
        """Render real directed edges and readable nodes, with continuation panels.

        Edge numbers map to the complete relation table in the document; all
        connections are drawn, including arrows entering/leaving another panel.
        No text is truncated to make it fit.
        """
        nodes, edges = diagram["nodes"], diagram["edges"]
        indices = {n["id"]: i for i, n in enumerate(nodes)}
        # Derive layers from the graph rather than inventing a linear flow.
        outgoing, indegree = defaultdict(list), defaultdict(int)
        for edge in edges:
            outgoing[edge["from"]].append(edge["to"])
            indegree[edge["to"]] += 1
        roots = [n["id"] for n in nodes if indegree[n["id"]] == 0] or [nodes[0]["id"]]
        ranks, queue = {key: 0 for key in roots}, deque(roots)
        while queue:
            current = queue.popleft()
            for target in outgoing[current]:
                if target not in ranks:
                    ranks[target] = ranks[current] + 1
                    queue.append(target)
        for node in nodes:
            if node["id"] not in ranks:
                ranks[node["id"]] = max(ranks.values(), default=-1) + 1
        layers = defaultdict(list)
        for node in nodes:
            layers[ranks[node["id"]]].append(node)
        rows = []
        for rank in sorted(layers):
            group = layers[rank]
            rows.extend(group[i:i + 3] for i in range(0, len(group), 3))
        font = ImageFont.truetype(self.font_path, 32)
        small = ImageFont.truetype(self.font_path, 25)
        line_height = 42
        measure = ImageDraw.Draw(Image.new("RGB", (1, 1)))

        def wrap(text, width):
            result, line = [], ""
            for character in str(text):
                if character == "\n":
                    result.append(line)
                    line = ""
                elif line and measure.textlength(line + character, font=font) > width:
                    result.append(line)
                    line = character
                else:
                    line += character
            return [*result, line]

        prepared_rows = []
        for row in rows:
            width = min(650, (1220 - (len(row) - 1) * 65) / len(row))
            row_lines = {
                node["id"]: wrap(f"N{indices[node['id']] + 1}  {node['label']}", width - 36)
                for node in row
            }
            height = max(len(lines) * line_height + 44 for lines in row_lines.values())
            prepared_rows.append((row, width, row_lines, height))
        panels, current, current_height = [], [], 80
        for row in prepared_rows:
            required = row[3] + 125
            if current and (len(current) == 5 or current_height + required > 1750):
                panels.append(current)
                current, current_height = [], 80
            current.append(row)
            current_height += required
        if current:
            panels.append(current)

        def arrow(draw, points, color="#456078"):
            draw.line(points, fill=color, width=4, joint="curve")
            a, b = points[-2], points[-1]
            angle = math.atan2(b[1] - a[1], b[0] - a[0])
            head = [(b[0] - 17 * math.cos(angle - math.pi / 6), b[1] - 17 * math.sin(angle - math.pi / 6)),
                    b, (b[0] - 17 * math.cos(angle + math.pi / 6), b[1] - 17 * math.sin(angle + math.pi / 6))]
            draw.polygon(head, fill=color)

        for panel_index, panel in enumerate(panels):
            positions, contents = {}, {}
            y = 70
            for row, width, row_lines, height in panel:
                start_x = (1500 - (width * len(row) + 65 * (len(row) - 1))) / 2
                for column, node in enumerate(row):
                    x = start_x + column * (width + 65)
                    positions[node["id"]] = (x, y, x + width, y + height)
                    contents[node["id"]] = row_lines[node["id"]]
                y += height + 125
            image = Image.new("RGB", (1500, int(y + 10)), "white")
            draw = ImageDraw.Draw(image)
            for edge_index, edge in enumerate(edges):
                a, b = positions.get(edge["from"]), positions.get(edge["to"])
                if not a and not b:
                    continue
                label = f"E{edge_index + 1}"
                if a and b:
                    ax, ay = (a[0] + a[2]) / 2, (a[1] + a[3]) / 2
                    bx, by = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                    if edge["from"] == edge["to"]:
                        points = [(a[2], ay), (a[2] + 42, ay), (a[2] + 42, a[1] - 28), (ax, a[1] - 28), (ax, a[1])]
                    elif abs(ay - by) < 2:
                        points = [(a[2] if bx > ax else a[0], ay), (b[0] if bx > ax else b[2], by)]
                    elif by > ay and b[1] - a[3] <= 126:
                        points = [(ax, a[3]), (ax, (a[3] + b[1]) / 2), (bx, (a[3] + b[1]) / 2), (bx, b[1])]
                    else:
                        rail = 35 + (edge_index % 5) * 20
                        if edge_index % 2:
                            rail = 1500 - rail
                        side_a = a[0] if rail < 750 else a[2]
                        side_b = b[0] if rail < 750 else b[2]
                        points = [(side_a, ay), (rail, ay), (rail, by), (side_b, by)]
                elif a:
                    ax, ay = (a[0] + a[2]) / 2, a[3]
                    points = [(ax, ay), (ax, ay + 58)]
                    label += f" → N{indices[edge['to']] + 1}"
                else:
                    bx, by = (b[0] + b[2]) / 2, b[1]
                    points = [(bx, by - 58), (bx, by)]
                    label += f" ← N{indices[edge['from']] + 1}"
                arrow(draw, points)
                midpoint = points[len(points) // 2]
                box = draw.textbbox((0, 0), label, font=small)
                lx, ly = midpoint[0] + 9, midpoint[1] - 29
                lx = min(max(4, lx), 1490 - (box[2] - box[0]))
                draw.rectangle((lx - 3, ly, lx + box[2] - box[0] + 5, ly + 32), fill="white")
                draw.text((lx, ly), label, font=small, fill="#32485C")
            for node_id, (x1, y1, x2, y2) in positions.items():
                draw.rounded_rectangle((x1, y1, x2, y2), radius=14, fill="#F2F6F9", outline="#40647F", width=3)
                lines = contents[node_id]
                ty = y1 + (y2 - y1 - len(lines) * line_height) / 2
                for line in lines:
                    length = draw.textlength(line, font=font)
                    draw.text(((x1 + x2 - length) / 2, ty), line, font=font, fill="#183549")
                    ty += line_height
            image_key = sha256(diagram["id"].encode("utf-8")).hexdigest()[:20]
            path = self.output.parent / f"diagram-{image_key}-{panel_index + 1}.png"
            image.save(path)
            if len(panels) > 1:
                self.p(f"{diagram['title']}（第 {panel_index + 1}/{len(panels)} 部分；N 为节点，E 为关系）", keep=True)
            p = self.p()
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER
            # Fit to both page width and page height without distorting the image.
            width = min(self.content_width, int(Inches(7.3) * image.width / image.height))
            picture = p.add_run().add_picture(str(path), width=width)
            picture._inline.docPr.set("descr", f"{diagram['title']}；各箭头关系详见紧随图后的关系表。")
        self.p(f"{diagram['title']}节点（图示标识：{diagram['id']}）", bold=True, keep=True)
        self.table(["节点", "名称", "分组"], [
            [f"N{i + 1} · {n['id']}", n["label"], n["group"] or "—"] for i, n in enumerate(nodes)
        ], [1.25, 2, 1])
        self.p(f"{diagram['title']}关系", bold=True, keep=True)
        self.table(["关系", "起点 → 终点", "条件 / 含义"], [
            [f"E{i + 1} · {e['id']}",
             f"N{indices[e['from']] + 1} {e['from']} → N{indices[e['to']] + 1} {e['to']}",
             e["label"] or "—"] for i, e in enumerate(edges)
        ], [1.15, 2, 1.15])

    def render(self):
        s, intro, biz = self.source, self.source["sections"]["introduction"], self.source["sections"]["businessRequirements"]
        cover = self.p(s["cover"]["title"], style="Normal0", bold=True, size=26)
        cover.alignment = WD_ALIGN_PARAGRAPH.CENTER
        cover.paragraph_format.space_before = Pt(120)
        cover.paragraph_format.space_after = Pt(42)
        self.p(s["cover"]["workOrderName"], size=16).alignment = WD_ALIGN_PARAGRAPH.CENTER
        self.p(f"修订 {s['revision']['number']} · {REVISION_STATUS[s['revision']['status']]}", size=11).alignment = WD_ALIGN_PARAGRAPH.CENTER
        self.doc.add_page_break()
        self.p("版 本 历 史", size=16, bold=True, keep=True)
        self.standard_table(0, [[v["status"], v["author"], "、".join(v["participants"]),
                                 f"{v['startDate']} — {v['endDate']}", v["notes"]] for v in s["versionHistory"]],
                            [1, 0.8, 1.1, 1.3, 2.3])
        self.doc.add_page_break()
        self.p(s["tableOfContents"]["title"], bold=True, size=16, keep=True)
        for index, entry in enumerate(s["tableOfContents"]["entries"]):
            p = self.p(style="toc 2" if re.match(r"^\d+\.\d", entry) else "toc 1")
            append_link(p, entry, self.font, anchor=f"prd_section_{index}")
        self.doc.add_page_break()
        def heading_key(title):
            return re.sub(r"^\d+(?:\.\d+)*\.?", "", re.sub(r"\s+", "", title))
        toc = {heading_key(title): f"prd_section_{index}" for index, title in enumerate(s["tableOfContents"]["entries"])}
        anchor_for = lambda title: toc.get(heading_key(title))
        self.heading(intro["title"], 1, anchor_for(intro["title"]))
        self.section(intro["background"], anchor_for(intro["background"]["title"]))
        self.section(intro["scope"], anchor_for(intro["scope"]["title"]))
        self.section(intro["usageScenarios"], anchor_for(intro["usageScenarios"]["title"]))
        channels = intro["usageScenarios"]["channelTable"]
        self.p(channels["title"], bold=True, keep=True)
        self.standard_table(1, [[row["sequence"], CHANNELS[row["channel"]], "☑是 □否" if row["enabled"] else "□是 ☑否"]
                                for row in channels["rows"]], [0.6, 3, 1.5])
        self.heading(biz["title"], 1, anchor_for(biz["title"]))
        self.inlines(self.p(), biz["summary"])
        for key in ("pageLinks", "coreRules", "flowAndPages", "acceptanceCriteria"):
            self.section(biz[key], anchor_for(biz[key]["title"]))
            if key == "flowAndPages":
                for diagram in biz[key]["diagrams"]:
                    self.p(diagram["title"], bold=True, size=12, keep=True)
                    self.p(diagram["description"], keep=True)
                    self.draw_diagram(diagram)
        for section in biz["additionalSections"]:
            self.section(section, anchor_for(section["title"]))
        degradation = s["sections"]["degradation"]
        self.heading(degradation["title"], 1, anchor_for(degradation["title"]))
        self.inlines(self.p(), degradation["content"])
        safety = s["sections"]["safetyBaseline"]
        self.heading(safety["title"], 1, anchor_for(safety["title"]))
        self.p(safety["intro"])
        safety_values = []
        for row in safety["rows"]:
            original = self.safety_rows[row["sequence"]]
            requirement = original[1]
            if row["remarks"]:
                requirement += f"\n说明：{row['remarks']}"
            safety_values.append([row["sequence"], requirement, original[2], row["applicability"]])
        self.standard_table(2, safety_values, [0.45, 3.8, 1.25, 0.65])
        if s["assumptions"]:
            self.heading("附录 A 业务假设", 1)
            for assumption in s["assumptions"]:
                self.p(f"{assumption['id']} · {ASSUMPTION_STATUS[assumption['status']]}", bold=True, keep=True)
                self.p(assumption["statement"])
                self.p(f"影响：{LEVELS[assumption['impact']]}；引入修订：{assumption['introducedInRevision']}" +
                       (f"；负责人：{assumption['owner']}" if assumption["owner"] else ""))
                if assumption["citationIds"]:
                    self.p("来源：" + "、".join(assumption["citationIds"]))
        if s["citations"]:
            self.heading("附录 B 引用来源", 1)
            for citation in s["citations"]:
                self.p(f"[{citation['id']}] {citation['title'] or citation['sourcePath']}", bold=True, keep=True)
                self.p(citation["sourcePath"])
                self.p(f"文档：{citation['documentId']}；片段：{citation['chunkId']}", size=9)
                locator = citation["locator"]
                if locator["heading"]:
                    self.p("来源章节：" + locator["heading"])
                if locator["startLine"] is not None or locator["endLine"] is not None:
                    self.p(f"来源行号：{locator['startLine'] or '—'} — {locator['endLine'] or '—'}")
                if citation["quote"]:
                    self.p(citation["quote"])
        self.heading("文档修订信息", 1)
        self.p(s["title"])
        self.p(f"文档标识：{s['documentId']}；修订：{s['revision']['number']}；状态：{REVISION_STATUS[s['revision']['status']]}")
        self.p(s["revision"]["summary"])
        self.p(f"更新时间：{s['revision']['changedAt']}")
        if s["revision"]["changedById"]:
            self.p(f"修订人：{s['revision']['changedById']}")
        self.doc.core_properties.title = s["title"]
        self.doc.core_properties.subject = s["cover"]["workOrderName"]
        self.doc.core_properties.author = s["versionHistory"][-1]["author"]
        used_images = {node.get(qn("r:embed")) for node in self.doc._element.iter(qn("a:blip"))}
        for rel_id, relation in list(self.doc.part.rels.items()):
            if relation.reltype.endswith("/image") and rel_id not in used_images:
                self.doc.part.drop_rel(rel_id)
        self.doc.save(self.output)
        self.verify_coverage()

    def verify_coverage(self):
        # Independent recursive coverage walk; adding a block type without a
        # renderer cannot silently drop its prose or table/diagram labels.
        source_keys = {
            "text", "label", "title", "workOrderName", "summary", "author", "participants",
            "startDate", "endDate", "notes", "statement", "owner", "sourcePath", "quote",
            "heading", "description", "successMetric", "name", "needs", "painPoints",
            "actor", "trigger", "outcome", "remarks", "intro", "changedAt", "changedById",
            "group", "href",
        }
        expected = []

        def visit(value, key=None):
            if isinstance(value, dict):
                for child_key, child in value.items():
                    visit(child, child_key)
            elif isinstance(value, list):
                for child in value:
                    visit(child, key)
            elif isinstance(value, str) and key in source_keys:
                expected.append(value)

        visit(self.source)
        from lxml import etree
        with zipfile.ZipFile(self.output) as archive:
            root = etree.fromstring(archive.read("word/document.xml"))
            text = "".join(root.xpath("//w:t/text()", namespaces={"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}))
        compact = lambda value: re.sub(r"\s+", "", value)
        rendered = compact(text)
        missing = [value for value in expected if compact(value) not in rendered]
        if missing:
            self.output.unlink(missing_ok=True)
            # Do not echo production content into logs.
            raise RuntimeError(f"PRD export omitted {len(missing)} source text values")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--template", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    source = json.loads(args.source.read_text(encoding="utf-8"))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Renderer(source, args.template, args.output).render()
    print("PRD DOCX rendered with complete source text coverage")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PRD rendering failed: {type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
