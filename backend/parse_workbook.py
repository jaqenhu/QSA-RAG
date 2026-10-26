"""Read B/C question pairs without executing formulas or using obsolete D notes."""
import json
import re
import sys
import warnings
import zipfile
from collections import Counter

MAX_ROWS = 50000
MAX_CELLS = 500000
MAX_XML_BYTES = 100 * 1024 * 1024
QUESTION_HEADERS = {"审核项目", "检查内容", "检查项目", "审核内容"}
ANSWER_HEADERS = {"自评说明", "自评内容", "自评结果"}


def text(value):
    return "" if value is None else str(value).replace("\r\n", "\n").replace("\r", "\n").strip()


def normalize(value):
    return re.sub(r"[\s：:（）()]+", "", text(value))


def inspect_archive(path):
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ValueError("文件不是有效的 .xlsx 工作簿，或文件已损坏。") from exc
    with archive:
        entries = archive.infolist()
        if len(entries) > 3000 or sum(e.file_size for e in entries) > MAX_XML_BYTES:
            raise ValueError("工作簿解压后过大，请拆分后上传。")
        if len({e.filename for e in entries}) != len(entries):
            raise ValueError("工作簿包含重复的内部文件，请另存为 .xlsx 后上传。")
        names = set(archive.namelist())
        if not {"xl/workbook.xml", "[Content_Types].xml"}.issubset(names):
            raise ValueError("文件缺少 Excel 工作簿结构，请另存为 .xlsx 后上传。")
        if any("vbaproject" in n.lower() for n in names):
            raise ValueError("不支持包含宏的文件，请另存为无宏 .xlsx。")
        # Explicitly reject DTD/entity declarations before any XML library reads it.
        for entry in entries:
            if entry.flag_bits & 1:
                raise ValueError("不支持加密工作簿，请移除密码后上传。")
            if entry.filename.endswith((".xml", ".rels")):
                xml = archive.read(entry)
                compact = xml.replace(b"\x00", b"").upper()
                if b"<!DOCTYPE" in compact or b"<!ENTITY" in compact:
                    raise ValueError("工作簿包含不受支持的 XML 声明。")


def parse_workbook(path):
    inspect_archive(path)
    try:
        import openpyxl
    except ImportError as exc:
        raise RuntimeError("缺少 Excel 解析依赖，请按 README 安装 requirements.txt。") from exc
    warnings.filterwarnings("ignore", category=UserWarning, module="openpyxl")
    workbook = openpyxl.load_workbook(path, data_only=False, keep_links=False)
    cached = None
    records, sheets, diagnostics = [], [], []
    counts = Counter()
    if len(workbook.worksheets) > 100:
        workbook.close()
        raise ValueError("工作表超过 100 张，请拆分后上传。")
    if sum(s.max_row * s.max_column for s in workbook) > MAX_CELLS:
        workbook.close()
        raise ValueError("工作簿单元格范围过大，请清除多余格式或拆分后上传。")

    def issue(sheet, row, reason):
        counts[reason] += 1
        diagnostics.append({"sheet": sheet, "row": row, "reason": reason})

    try:
        for sheet in workbook:
            if sheet.max_row > MAX_ROWS:
                raise ValueError("单张工作表超过 50,000 行，请拆分后上传。")
            header = next((r for r in range(1, min(sheet.max_row, 50) + 1)
                           if normalize(sheet.cell(r, 2).value) in QUESTION_HEADERS
                           and normalize(sheet.cell(r, 3).value) in ANSWER_HEADERS), None)
            stat = {"name": sheet.title, "rows": sheet.max_row, "headerRow": header,
                    "questionCount": 0, "answeredCount": 0, "missingCount": 0,
                    "skippedCount": 0, "hidden": sheet.sheet_state != "visible"}
            sheets.append(stat)
            if header is None:
                issue(sheet.title, None, "未识别到 B 列问题 / C 列自评说明表头，整表跳过")
                stat["skippedCount"] = sheet.max_row
                continue
            # Horizontal merged headings are not questions. Vertical answer merges
            # retain their anchor coordinates instead of silently losing sources.
            section_rows, merges = set(), {"B": {}, "C": {}}
            for merged in sheet.merged_cells.ranges:
                if merged.min_col <= 2 <= merged.max_col and merged.min_col != merged.max_col:
                    section_rows.update(range(merged.min_row, merged.max_row + 1))
                elif merged.min_col == merged.max_col and merged.min_col in (2, 3):
                    column = "B" if merged.min_col == 2 else "C"
                    for r in range(merged.min_row, merged.max_row + 1):
                        merges[column][r] = merged.min_row
            chapter = ""
            for row in range(1, sheet.max_row + 1):
                a = text(sheet.cell(row, 1).value)
                raw_b = sheet.cell(row, 2).value
                raw_c = sheet.cell(row, 3).value
                if row <= header:
                    issue(sheet.title, row, "表头或表头前标题")
                    stat["skippedCount"] += 1
                    continue
                if row in section_rows:
                    chapter = a or text(raw_b) or chapter
                    issue(sheet.title, row, "章节标题")
                    stat["skippedCount"] += 1
                    continue
                if normalize(raw_b) in QUESTION_HEADERS and normalize(raw_c) in ANSWER_HEADERS:
                    issue(sheet.title, row, "重复表头")
                    stat["skippedCount"] += 1
                    continue
                if not text(raw_b):
                    reason = "问题列合并续行" if row in merges["B"] else "缺少问题，未导入" if text(raw_c) else "章节标题" if a else "空白行"
                    if reason == "章节标题":
                        chapter = a
                    issue(sheet.title, row, reason)
                    stat["skippedCount"] += 1
                    continue
                cells, values = {}, {}
                for col, number in (("B", 2), ("C", 3)):
                    anchor = merges[col].get(row, row)
                    cell = sheet.cell(anchor, number)
                    cells[col] = f"{col}{anchor}"
                    if cell.data_type == "f":
                        if cached is None:
                            cached = openpyxl.load_workbook(path, data_only=True, keep_links=False)
                        values[col] = text(cached[sheet.title].cell(anchor, number).value)
                        issue(sheet.title, row, f"{col} 列公式使用缓存值" if values[col] else f"{col} 列公式无缓存值")
                    elif cell.data_type == "e":
                        values[col] = ""
                        issue(sheet.title, row, f"{col} 列为 Excel 错误值")
                    else:
                        values[col] = text(cell.value)
                    if anchor != row:
                        issue(sheet.title, row, f"{col} 列沿用合并单元格 {cells[col]}")
                if not values["B"]:
                    stat["skippedCount"] += 1
                    issue(sheet.title, row, "问题无有效文本，未导入")
                    continue
                missing = not values["C"]
                if missing:
                    issue(sheet.title, row, "缺少自评说明")
                stat["questionCount"] += 1
                stat["missingCount"] += int(missing)
                stat["answeredCount"] += int(not missing)
                records.append({"sheet": sheet.title, "line": row, "chapter": chapter,
                                "question": values["B"], "answer": values["C"],
                                "questionCell": cells["B"], "answerCell": cells["C"],
                                "status": "missing" if missing else "answered"})
        if not records:
            raise ValueError("未找到可导入的问题，请检查 B 列问题和 C 列自评说明的表头及内容。")
        return {"sheets": sheets, "records": records, "diagnostics": diagnostics,
                "summary": {"sheetCount": len(sheets), "questionCount": len(records),
                            "answeredCount": sum(s["answeredCount"] for s in sheets),
                            "missingCount": sum(s["missingCount"] for s in sheets),
                            "skippedCount": sum(s["skippedCount"] for s in sheets),
                            "reasons": dict(counts)}}
    finally:
        workbook.close()
        if cached is not None:
            cached.close()


if __name__ == "__main__":
    try:
        result = parse_workbook(sys.argv[1])
        print(json.dumps({"ok": True, "data": result}, ensure_ascii=False))
    except Exception as exc:
        known = isinstance(exc, (ValueError, RuntimeError))
        print(json.dumps({"ok": False, "error": str(exc) if known else
                          "无法解析工作簿，请确认文件可在 Excel 中打开并另存为 .xlsx。"}, ensure_ascii=False))
        sys.exit(1)
