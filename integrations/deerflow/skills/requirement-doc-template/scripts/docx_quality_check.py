#!/usr/bin/env python3
"""Check generated Chinese requirement DOCX files against the user's baseline rules."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from docx import Document


PLACEHOLDER_PATTERNS = [
    r"更新此内容",
    r"删除此内容",
    r"最后记得",
    r"仅提醒",
    r"需要各位业务大大",
    r"业务大大名字",
    r"XXX/XXXXX",
    r"xxxx年xx月xx日",
    r"例子：",
    r"提醒：",
    r"待确认",
    r"以实际为准",
    r"以实际上线地址为准",
]

PROHIBITED_WEAK_PATTERNS = [
    r"与.+逻辑相同",
    r"在.+基础上",
]

REQUIRED_HEADING_GROUPS = [
    ["引言"],
    ["项目背景"],
    ["文档范围"],
    ["使用场景", "使用场景（必填）"],
    ["业务需求"],
    ["页面链接", "页面入口与页面链接"],
    ["核心业务规则/功能说明"],
    ["核心流程/状态/页面要求"],
    ["验收标准"],
    ["业务降级方案", "业务降级方案（必填）"],
    ["需求安全基线要求", "需求安全基线要求（必填）"],
]

VERSION_HEADERS = ["版本/状态", "作者", "参与者", "起止日期", "备注"]
CHANNEL_HEADERS = ["序号", "活动投放", "是否投放"]
SAFETY_HEADERS = ["序号", "需求安全基线内容", "范围", "是否涉及"]
ALLOWED_SAFETY_VALUES = {"是", "否", "不涉及"}


def clean_text(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def normalize_title(text: str) -> str:
    text = re.sub(r"\s+", "", text or "")
    text = re.sub(r"^\d+(\.\d+)*\.?", "", text)
    return text.strip()


def paragraph_texts(doc: Document) -> list[str]:
    return [clean_text(p.text) for p in doc.paragraphs if clean_text(p.text)]


def all_document_text(doc: Document) -> str:
    parts: list[str] = paragraph_texts(doc)
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                value = clean_text(cell.text)
                if value:
                    parts.append(value)
    return "\n".join(parts)


def table_rows(table) -> list[list[str]]:
    return [[clean_text(cell.text) for cell in row.cells] for row in table.rows]


def row_has_headers(row: list[str], headers: list[str]) -> bool:
    return all(any(header in cell for cell in row) for header in headers)


def find_tables(doc: Document, headers: list[str]):
    matches = []
    for table in doc.tables:
        rows = table_rows(table)
        if rows and row_has_headers(rows[0], headers):
            matches.append((table, rows))
    return matches


def find_table(doc: Document, headers: list[str]):
    matches = find_tables(doc, headers)
    return matches[0] if matches else (None, [])


def heading_paragraphs(doc: Document) -> list[tuple[int, str, str]]:
    result: list[tuple[int, str, str]] = []
    for i, paragraph in enumerate(doc.paragraphs):
        text = clean_text(paragraph.text)
        if text and paragraph.style and paragraph.style.name.startswith("Heading"):
            result.append((i, paragraph.style.name, text))
    return result


def collect_until_next_heading(doc: Document, start_index: int) -> str:
    parts: list[str] = []
    for paragraph in doc.paragraphs[start_index + 1 :]:
        text = clean_text(paragraph.text)
        if not text:
            continue
        if paragraph.style and paragraph.style.name.startswith("Heading"):
            break
        parts.append(text)
    return clean_text(" ".join(parts))


def add_placeholder_findings(text: str, errors: list[str], warnings: list[str], allow: bool) -> None:
    target = warnings if allow else errors
    for pattern in PLACEHOLDER_PATTERNS:
        if re.search(pattern, text):
            target.append(f"发现模板占位/提醒文字：{pattern}")


def check_required_headings(doc: Document, errors: list[str], allow_template: bool) -> None:
    normalized = [normalize_title(text) for _, _, text in heading_paragraphs(doc)]
    final_only = {"核心业务规则/功能说明", "核心流程/状态/页面要求", "验收标准"}
    groups = [group for group in REQUIRED_HEADING_GROUPS if not allow_template or group[0] not in final_only]
    for group in groups:
        normalized_group = [normalize_title(item) for item in group]
        if not any(any(item in heading for heading in normalized) for item in normalized_group):
            errors.append(f"缺少必需标题：{'/'.join(group)}")


def check_toc_matches_headings(doc: Document, warnings: list[str]) -> None:
    toc_entries = [
        normalize_title(re.sub(r"\s+\d+$", "", clean_text(p.text)))
        for p in doc.paragraphs
        if clean_text(p.text) and p.style and p.style.name.lower().startswith("toc")
    ]
    headings = [normalize_title(text) for _, _, text in heading_paragraphs(doc)]
    if not toc_entries:
        warnings.append("未检测到目录条目")
        return
    missing = [entry for entry in toc_entries if entry and not any(entry in heading for heading in headings)]
    if missing:
        warnings.append("目录条目与正文标题不一致：" + "、".join(missing[:8]))


def check_tables(doc: Document, errors: list[str], warnings: list[str], allow_template: bool) -> None:
    _, version_rows = find_table(doc, VERSION_HEADERS)
    if not version_rows:
        errors.append("缺少版本历史表，或表头不符合模板")
    elif len(version_rows) > 1:
        first = version_rows[1]
        author = first[1] if len(first) > 1 else ""
        date = first[3] if len(first) > 3 else ""
        if not allow_template and (not author or "必填" in author):
            errors.append("版本历史第一行作者未填写或仍为模板占位")
        if not date:
            errors.append("版本历史第一行日期未填写")

    channel_tables = find_tables(doc, CHANNEL_HEADERS)
    if not channel_tables:
        errors.append("缺少使用场景/投放渠道表，或表头不符合模板")
    elif len(channel_tables) != 1:
        errors.append(f"使用场景只能保留一份投放渠道表，当前为 {len(channel_tables)} 份")
    else:
        _, channel_rows = channel_tables[0]
        if len(channel_rows) != 4:
            errors.append(f"投放渠道表应为 4 行（含表头），当前为 {len(channel_rows)} 行")
        for row_number, row in enumerate(channel_rows[1:], start=2):
            value = row[2] if len(row) > 2 else ""
            if value not in {"☑是 □否", "□是 ☑否"}:
                errors.append(f"投放渠道表第 {row_number} 行必须明确且唯一勾选是/否，当前为：{value or '空'}")

    safety_tables = find_tables(doc, SAFETY_HEADERS)
    if not safety_tables:
        errors.append("缺少需求安全基线表，或表头不符合模板")
        return
    if len(safety_tables) != 1:
        errors.append(f"需求安全基线表只能保留一份，当前为 {len(safety_tables)} 份")
    _, safety_rows = safety_tables[0]
    if len(safety_rows) != 22:
        errors.append(f"需求安全基线表应为 22 行（含表头），当前为 {len(safety_rows)} 行")
    header = safety_rows[0]
    try:
        status_index = next(i for i, cell in enumerate(header) if "是否涉及" in cell)
    except StopIteration:
        errors.append("需求安全基线表缺少“是否涉及”列")
        return
    for row_number, row in enumerate(safety_rows[1:], start=2):
        value = row[status_index] if status_index < len(row) else ""
        if value not in ALLOWED_SAFETY_VALUES:
            errors.append(f"安全基线表第 {row_number} 行“是否涉及”只能为 是/否/不涉及，当前为：{value or '空'}")
    if any(row[status_index] == "否" for row in safety_rows[1:] if status_index < len(row)):
        warnings.append("安全基线存在“否”，需在正文补充安全改造需求并走安全评审")

    if allow_template:
        return

    safety_table = safety_tables[0][0]
    evidence_parts = paragraph_texts(doc)
    selected_channels: list[str] = []
    if channel_tables:
        for row in channel_tables[0][1][1:]:
            if len(row) > 2 and row[2] == "☑是 □否":
                selected_channels.append(row[1])
    for table in doc.tables:
        if table._tbl is safety_table._tbl:
            continue
        for row in table_rows(table):
            evidence_parts.extend(cell for cell in row if cell)
    evidence_text = "\n".join([*evidence_parts, *selected_channels])
    explicit_evidence = {
        "12": r"APP|小程序",
        "13": r"身份证|银行卡|生物识别",
        "14": r"免密|一键登录",
        "15": r"第三方.{0,12}(跳转|页面|应用)|跳转.{0,12}第三方",
        "16": r"第三方.{0,12}(接口|数据交互|对接)|(?:接口|数据交互|对接).{0,12}第三方",
        "19": r"(?:用户信息|重要数据).{0,12}(?:存储|落库)|(?:存储|落库).{0,12}(?:用户信息|重要数据)",
    }
    rows_by_index = {row[0]: row for row in safety_rows[1:] if row}
    for index, pattern in explicit_evidence.items():
        row = rows_by_index.get(index)
        if row and status_index < len(row) and row[status_index] == "是" and not re.search(pattern, evidence_text, re.I):
            errors.append(f"安全基线第 {index} 行标记为“是”，但正文未找到明确业务依据")


def check_required_markers(doc: Document, errors: list[str], allow_template: bool) -> None:
    if allow_template:
        return
    full_text = all_document_text(doc)
    for marker in ["产品流程图", "产品架构图"]:
        if marker not in full_text:
            errors.append(f"缺少必需内容：{marker}")
    if re.search(r"本需求涉及新增/修改的接口|(^|\n)\s*(接口设计|API\s*清单)\s*($|\n)", full_text, re.I):
        errors.append("包含已禁用的独立接口/API章节")


def check_heading_bodies(doc: Document, errors: list[str]) -> None:
    headings = heading_paragraphs(doc)
    for index, style_name, text in headings:
        if style_name == "Heading 2":
            body = collect_until_next_heading(doc, index)
            if not body:
                errors.append(f"标题下缺少正文：{text}")


def check_degradation(doc: Document, errors: list[str], warnings: list[str]) -> None:
    for index, _, text in heading_paragraphs(doc):
        if "业务降级方案" not in normalize_title(text):
            continue
        body = collect_until_next_heading(doc, index)
        if not body:
            errors.append("业务降级方案未填写")
        elif body != "不涉及" and len(re.sub(r"\s+", "", body)) < 100:
            warnings.append("业务降级方案非“不涉及”时建议不少于 100 个中文字符")
        return
    errors.append("缺少业务降级方案标题")


def main() -> int:
    parser = argparse.ArgumentParser(description="Check a requirement DOCX against template and quality rules.")
    parser.add_argument("docx", type=Path)
    parser.add_argument(
        "--allow-template-placeholders",
        action="store_true",
        help="Allow placeholder/reminder text when validating the bundled template itself.",
    )
    args = parser.parse_args()

    if not args.docx.exists():
        print(f"ERROR: 文件不存在：{args.docx}", file=sys.stderr)
        return 2

    doc = Document(str(args.docx))
    errors: list[str] = []
    warnings: list[str] = []
    texts = paragraph_texts(doc)
    full_text = all_document_text(doc)

    if not texts:
        errors.append("文档没有可读取正文")
    elif not texts[0].endswith("需求说明书"):
        errors.append("封面首行应为“<工单名称>需求说明书”")

    add_placeholder_findings(full_text, errors, warnings, args.allow_template_placeholders)
    check_required_headings(doc, errors, args.allow_template_placeholders)
    check_toc_matches_headings(doc, warnings)
    check_tables(doc, errors, warnings, args.allow_template_placeholders)
    check_required_markers(doc, errors, args.allow_template_placeholders)
    check_heading_bodies(doc, errors)
    check_degradation(doc, errors, warnings)

    for pattern in PROHIBITED_WEAK_PATTERNS:
        if re.search(pattern, full_text):
            warnings.append(f"发现可能不够具体的引用式描述：{pattern}")
    if re.search(r"https?://|www\.", full_text):
        warnings.append("文档包含链接，请确认链接没有替代具体需求描述")

    if errors:
        print("DOCX quality check failed:")
        for item in errors:
            print(f"ERROR: {item}")
    else:
        print("DOCX quality check passed.")
    for item in warnings:
        print(f"WARN: {item}")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
