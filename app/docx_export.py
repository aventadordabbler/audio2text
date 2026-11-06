"""Render saved Markdown meeting minutes as a readable Word document."""
from __future__ import annotations

from io import BytesIO
import re

from docx import Document
from docx.enum.style import WD_STYLE_TYPE
from docx.oxml.ns import qn
from docx.shared import Inches, Pt


_INLINE = re.compile(
    r"(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*]+\*|_[^_]+_|\[[^\]]+\]\([^)]*\))"
)
_TABLE_SEPARATOR = re.compile(r"^:?-{3,}:?$")


def _set_font(target: object, name: str, size: float | None = None) -> None:
    font = target.font  # type: ignore[attr-defined]
    font.name = name
    if size is not None:
        font.size = Pt(size)
    rpr = target._element.get_or_add_rPr()  # type: ignore[attr-defined]
    rfonts = rpr.get_or_add_rFonts()
    rfonts.set(qn("w:ascii"), name)
    rfonts.set(qn("w:hAnsi"), name)
    rfonts.set(qn("w:eastAsia"), name)


def _add_run(paragraph: object, text: str, *, bold: bool = False, italic: bool = False, code: bool = False) -> None:
    if not text:
        return
    run = paragraph.add_run(text)  # type: ignore[attr-defined]
    run.bold = bold
    run.italic = italic
    if code:
        _set_font(run, "Courier New", 9.5)


def _add_inline(paragraph: object, text: str) -> None:
    cursor = 0
    for match in _INLINE.finditer(text):
        _add_run(paragraph, text[cursor : match.start()])
        token = match.group(0)
        if token.startswith(("**", "__")):
            _add_run(paragraph, token[2:-2], bold=True)
        elif token.startswith(("*", "_")):
            _add_run(paragraph, token[1:-1], italic=True)
        elif token.startswith("`"):
            _add_run(paragraph, token[1:-1], code=True)
        else:
            _add_run(paragraph, token[1 : token.index("]")])
        cursor = match.end()
    _add_run(paragraph, text[cursor:])


def _split_table_row(line: str) -> list[str]:
    value = line.strip()
    if value.startswith("|"):
        value = value[1:]
    if value.endswith("|"):
        value = value[:-1]
    return [cell.strip() for cell in value.split("|")]


def _is_table_separator(line: str) -> bool:
    cells = _split_table_row(line)
    return len(cells) >= 1 and all(_TABLE_SEPARATOR.fullmatch(cell) for cell in cells)


def _add_table(document: Document, header: list[str], rows: list[list[str]]) -> None:
    columns = len(header)
    table = document.add_table(rows=1, cols=columns)
    table.style = "Table Grid"
    for cell, value in zip(table.rows[0].cells, header):
        paragraph = cell.paragraphs[0]
        _add_inline(paragraph, value)
        for run in paragraph.runs:
            run.bold = True
    for row in rows:
        cells = table.add_row().cells
        for index, cell in enumerate(cells):
            _add_inline(cell.paragraphs[0], row[index] if index < len(row) else "")


def _configure_document(document: Document) -> None:
    _set_font(document.styles["Normal"], "Microsoft YaHei", 10.5)
    for name in ("Title", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"):
        _set_font(document.styles[name], "Microsoft YaHei")
    if "Code Block" not in document.styles:
        code_style = document.styles.add_style("Code Block", WD_STYLE_TYPE.PARAGRAPH)
        _set_font(code_style, "Courier New", 9.5)
        code_style.paragraph_format.left_indent = Inches(0.25)
        code_style.paragraph_format.space_after = Pt(4)
    for section in document.sections:
        section.top_margin = Inches(0.8)
        section.bottom_margin = Inches(0.8)
        section.left_margin = Inches(0.85)
        section.right_margin = Inches(0.85)


def build_docx(title: str, markdown: str) -> bytes:
    document = Document()
    _configure_document(document)
    document.core_properties.title = title
    document.core_properties.subject = "会议纪要"
    document.add_heading(title or "会议纪要", level=0)

    lines = markdown.splitlines()
    fenced = False
    index = 0
    while index < len(lines):
        line = lines[index]
        if line.strip().startswith("```"):
            fenced = not fenced
            index += 1
            continue
        if fenced:
            paragraph = document.add_paragraph(style="Code Block")
            _add_run(paragraph, line, code=True)
            index += 1
            continue

        if index + 1 < len(lines) and "|" in line and _is_table_separator(lines[index + 1]):
            header = _split_table_row(line)
            rows: list[list[str]] = []
            index += 2
            while index < len(lines) and lines[index].strip() and "|" in lines[index]:
                rows.append(_split_table_row(lines[index]))
                index += 1
            _add_table(document, header, rows)
            continue

        heading = re.match(r"^\s*(#{1,6})\s+(.+?)\s*$", line)
        if heading:
            paragraph = document.add_heading(level=min(len(heading.group(1)), 6))
            _add_inline(paragraph, heading.group(2))
        else:
            bullet = re.match(r"^\s*[-*+]\s+(.+)$", line)
            ordered = re.match(r"^\s*\d+[.)]\s+(.+)$", line)
            if bullet:
                paragraph = document.add_paragraph(style="List Bullet")
                _add_inline(paragraph, bullet.group(1))
            elif ordered:
                paragraph = document.add_paragraph(style="List Number")
                _add_inline(paragraph, ordered.group(1))
            elif line.strip():
                paragraph = document.add_paragraph()
                _add_inline(paragraph, line)
        index += 1

    output = BytesIO()
    document.save(output)
    return output.getvalue()
