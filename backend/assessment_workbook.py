"""Assessment input mapping and minimal OOXML copy export (never overwrite source)."""
import sys
import json
import re
import math
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape
from html import unescape
# The embedded runtime isolates sys.path; explicitly allow our sibling helper.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse_workbook import parse_workbook, inspect_archive

NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}

def shift_formula(formula, sheet_name, affected):
    from openpyxl.formula.tokenizer import Tokenizer
    from openpyxl.utils import column_index_from_string, get_column_letter
    original = unescape(formula)
    try:
        tokens = Tokenizer('=' + original).items
        for token in tokens:
            if token.type != 'OPERAND' or token.subtype != 'RANGE':
                continue
            value = token.value
            owner, delimiter, address = value.rpartition('!')
            owner_name = owner.strip("'").replace("''", "'") if delimiter else sheet_name
            if ':' in owner_name and any(name in owner_name for name in affected):
                raise ValueError('暂不支持插入列时调整跨工作表范围公式。')
            if '[' in owner_name or owner_name not in affected:
                continue
            if not delimiter:
                address = value
            if not re.fullmatch(r'\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}', address):
                continue
            def column(match):
                number = column_index_from_string(match.group(2))
                if number >= 16383:
                    raise ValueError('公式列引用超出可插入范围。')
                return match.group(1) + get_column_letter(number + 2 if number >= 4 else number)
            address = re.sub(r'(\$?)([A-Z]{1,3})(?=\$?\d|:|$)', column, address)
            token.value = owner + '!' + address if delimiter else address
        return escape(''.join(token.value for token in tokens))
    except Exception as error:
        raise ValueError('原表含无法安全调整引用的公式，未导出，请检查附加列公式。') from error


def parse_input(path):
    import openpyxl
    parsed = parse_workbook(path, strict_headers=False)
    workbook = openpyxl.load_workbook(path, data_only=False, keep_links=False)
    try:
        if len(parsed["records"]) > 5000:
            raise ValueError("待填表超过 5,000 项，请拆分后上传。")
        merges = []
        for stat in parsed["sheets"]:
            sheet = workbook[stat["name"]]
            rows = {r["line"] for r in parsed["records"] if r["sheet"] == sheet.title}
            if stat["questionCount"] and sheet.protection.sheet:
                raise ValueError(f"{sheet.title} 已受保护，请先移除工作表保护。")
            stat["basisColumn"] = 'D'
            stat["detailsColumn"] = 'E'
            stat["sourceColumn"] = openpyxl.utils.get_column_letter(sheet.max_column + 3)
            if sheet.max_column > 16381:
                raise ValueError("工作表没有可新增来源的列。")
            for merged in sheet.merged_cells.ranges:
                if merged.min_col <= 3 <= merged.max_col and any(r in rows for r in range(merged.min_row, merged.max_row + 1)):
                    if merged.min_col != 3 or merged.max_col != 3:
                        raise ValueError(f"{sheet.title} 的 {merged} 跨越答案列与其他列，请先调整后上传。")
                    merges.append({"sheet": sheet.title, "range": str(merged), "questionCount": sum(r in rows for r in range(merged.min_row, merged.max_row + 1))})
        for index, record in enumerate(parsed["records"]):
            if len(record["question"]) > 2000:
                raise ValueError(f"{record['sheet']} 第 {record['line']} 行问题超过 2,000 字，请拆分。")
            record.update({"id": f"q{index + 1}", "position": index + 1, "originalAnswerCell": record["answerCell"], "answerCell": f"C{record['line']}"})
        parsed["answerMerges"] = merges
        parsed["summary"].update({"mergeCount": len(merges), "mergedQuestionCount": sum(m["questionCount"] for m in merges)})
        return parsed
    finally:
        workbook.close()


def patch_cell(xml, address, value, style=""):
    # Inline strings prevent formula injection and leave shared strings untouched.
    value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(value))
    if len(value) > 32767:
        raise ValueError("答案或来源超过 Excel 单元格字符上限，未导出。")
    cell = f'<c r="{address}"{style} t="inlineStr"><is><t xml:space="preserve">{escape(value)}</t></is></c>'
    # Match a whole cell, including self-closing blanks.
    pattern = rf'<c\b(?=[^>]*\br="{address}")[^>]*?(?:/>|>.*?</c>)'
    if re.search(pattern, xml, re.S):
        return re.sub(pattern, lambda _: cell, xml, count=1, flags=re.S)
    row_number = re.search(r"\d+$", address).group()
    row_pattern = rf'(<row\b(?=[^>]*\br="{row_number}")[^>]*>)(.*?)(</row>)'
    matched = re.search(row_pattern, xml, re.S)
    if not matched:
        raise ValueError(f"原表缺少 {address} 的行结构，未导出。")
    body = matched.group(2)
    # C comes before existing D/E etc.; newly appended source comes last.
    def col_index(ref):
        total = 0
        for char in re.match(r"[A-Z]+", ref).group():
            total = total * 26 + ord(char) - 64
        return total
    target_col = col_index(address)
    following = next((m for m in re.finditer(r'<c\b[^>]*\br="([A-Z]+\d+)"', body) if col_index(m.group(1)) > target_col), None)
    position = following.start() if following else len(body)
    new_body = body[:position] + cell + body[position:]
    return xml[:matched.start(2)] + new_body + xml[matched.end(2):]


def export_copy(path, output, payload):
    if Path(path).resolve() == Path(output).resolve():
        raise ValueError("导出不得覆盖原文件。")
    inspect_archive(path)
    parsed = parse_input(path)
    expected = {(r["sheet"], r["line"]): r for r in parsed["records"]}
    results = payload["results"]
    if len({(r["sheet"], r["line"]) for r in results}) != len(results):
        raise ValueError("导出存在重复行，已停止。")
    for result in results:
        original = expected.get((result["sheet"], result["line"]))
        if not original or result["question"] != original["question"] or result["answerCell"] != original["answerCell"]:
            raise ValueError("答案与原始问题行不一致，已停止导出。")
    by_row = {(r["sheet"], r["line"]): r for r in results}
    with zipfile.ZipFile(path) as source:
        if any(n.startswith("_xmlsignatures/") for n in source.namelist()):
            raise ValueError("不支持修改已数字签名的工作簿，请另存无签名副本。")
        workbook = ET.fromstring(source.read("xl/workbook.xml"))
        relationships = ET.fromstring(source.read("xl/_rels/workbook.xml.rels"))
        targets = {r.attrib["Id"]: r.attrib["Target"] for r in relationships}
        affected = {stat['name'] for stat in parsed['sheets'] if stat['questionCount']}
        patches = {}
        styles_xml = source.read('xl/styles.xml').decode('utf-8')
        style_section = re.search(r'<cellXfs\b[^>]*>(.*?)</cellXfs>', styles_xml, re.S)
        if not style_section:
            raise ValueError('原表缺少单元格样式，未导出。')
        original_xfs = re.findall(r'<xf\b[^>]*?(?:/>|>.*?</xf>)', style_section.group(1), re.S)
        added_xfs, wrap_mapping = [], {}
        def wrapped_style(style):
            index = int(re.search(r'\d+', style).group()) if style else 0
            if index >= len(original_xfs):
                raise ValueError('原表样式索引无效，未导出。')
            original_xf = original_xfs[index]
            if re.search(r'<alignment\b[^>]*\bwrapText="(?:1|true)"', original_xf):
                return style
            if index not in wrap_mapping:
                clone = original_xf
                if re.search(r'<alignment\b', clone):
                    def wrap_alignment(match):
                        tag = re.sub(r'\s+wrapText="[^"]*"', '', match.group())
                        end = '/>' if tag.endswith('/>') else '>'
                        return tag[:-len(end)] + ' wrapText="1"' + end
                    clone = re.sub(r'<alignment\b[^>]*>', wrap_alignment, clone, count=1)
                elif clone.endswith('/>'):
                    clone = clone[:-2] + '><alignment wrapText="1"/></xf>'
                else:
                    clone = clone.replace('</xf>', '<alignment wrapText="1"/></xf>', 1)
                clone = re.sub(r'\s+applyAlignment="[^"]*"', '', clone)
                clone = clone.replace('<xf', '<xf applyAlignment="1"', 1)
                wrap_mapping[index] = len(original_xfs) + len(added_xfs)
                added_xfs.append(clone)
            return f' s="{wrap_mapping[index]}"'
        for sheet in workbook.find("s:sheets", NS):
            title = sheet.attrib["name"]
            stat = next(s for s in parsed["sheets"] if s["name"] == title)
            if not stat["questionCount"]:
                continue
            target = targets[sheet.attrib["{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"]]
            part = target.lstrip("/") if target.startswith("/") else "xl/" + target
            xml = source.read(part).decode("utf-8")
            original_xml = xml
            if stat['sourceColumn'] != 'F' and re.search(r'<(?:drawing|tableParts)\b', xml):
                raise ValueError('含附加列及图表或结构化表的待填表暂不支持插入依据列，请使用审核表副本。')
            # New D/E columns precede any existing ancillary columns.
            from openpyxl.utils import column_index_from_string, get_column_letter
            def shifted_reference(match):
                address = match.group()
                column_match = re.match(r'(\$?)([A-Z]{1,3})(\$?\d*)$', address)
                if not column_match:
                    return address
                number = column_index_from_string(column_match.group(2))
                return column_match.group(1) + get_column_letter(number + 2 if number >= 4 else number) + column_match.group(3)
            def shift_range(value):
                return re.sub(r'\$?[A-Z]{1,3}\$?\d*', shifted_reference, value)
            # Cell/range metadata changes only in the filled sheet. Original A-C stay put.
            xml = re.sub(r'\b(r|ref|sqref)="([^"]*)"', lambda m: m.group(1) + '="' + shift_range(m.group(2)) + '"', xml)
            def shift_columns(match):
                tag = match.group()
                low = int(re.search(r'\bmin="(\d+)"', tag).group(1)); high = int(re.search(r'\bmax="(\d+)"', tag).group(1))
                if high < 4:
                    return tag
                if low < 4:
                    left = re.sub(r'\bmax="\d+"', 'max="3"', tag)
                    right = re.sub(r'\bmin="\d+"', 'min="6"', re.sub(r'\bmax="\d+"', f'max="{high + 2}"', tag))
                    return left + right
                return re.sub(r'\bmin="\d+"', f'min="{low + 2}"', re.sub(r'\bmax="\d+"', f'max="{high + 2}"', tag))
            xml = re.sub(r'<col\b[^>]*/>', shift_columns, xml)
            source_column = stat["sourceColumn"]
            # Reuse the answer header style; keep all existing styles/package parts.
            header_cell = re.search(rf'<c\b(?=[^>]*\br="C{stat["headerRow"]}")[^>]*>', xml)
            header_style = re.search(r'\bs="\d+"', header_cell.group() if header_cell else "")
            for column_name, label in [('D', '依据'), ('E', '详细说明'), (source_column, '来源')]:
                xml = patch_cell(xml, f'{column_name}{stat["headerRow"]}', label, " " + header_style.group() if header_style else "")
            merges = [m["range"] for m in parsed["answerMerges"] if m["sheet"] == title]
            for merged in merges:
                xml = re.sub(rf'<mergeCell\b[^>]*\bref="{re.escape(merged)}"[^>]*/>', "", xml)
            def remaining_merges(match):
                content = match.group(1)
                count = len(re.findall(r'<mergeCell\b', content))
                return f'<mergeCells count="{count}">{content}</mergeCells>' if count else ''
            xml = re.sub(r'<mergeCells\b[^>]*>(.*?)</mergeCells>', remaining_merges, xml, flags=re.S)
            for (name, line), original in expected.items():
                if name != title:
                    continue
                result = by_row.get((name, line))
                answer = result["answer"] if result else "未生成（本次未选择）。"
                basis = result.get('basis') or {'direct': '可直接复用', 'partial': '部分有依据', 'missing': '无相关信息', 'failed': '调用失败'}.get(result.get('status'), '') if result else ''
                details = ('/' if result['status'] == 'direct' else result.get('gap', '') if result['status'] == 'partial' else '没有搜索到相关信息' if result['status'] == 'missing' else basis if result['status'] == 'failed' else '') if result else '未生成（本次未选择）。'
                sources = result.get("sourceText", "") if result else ""
                original_cell = re.search(rf'<c\b(?=[^>]*\br="{original["originalAnswerCell"]}")[^>]*>', original_xml)
                style_match = re.search(r'\bs="\d+"', original_cell.group() if original_cell else "")
                style = " " + style_match.group() if style_match else ""
                style = wrapped_style(style)
                xml = patch_cell(xml, f"C{line}", answer, style)
                xml = patch_cell(xml, f"D{line}", basis, style)
                xml = patch_cell(xml, f"E{line}", details, style)
                xml = patch_cell(xml, f"{source_column}{line}", sources or "无引用来源", style)
                # Allow multiline answers and source labels to be read without shrink-to-fit.
                height = min(409, max(45, (max(sum(max(1, math.ceil(len(t) / 27)) for t in answer.splitlines()), sum(max(1, math.ceil(len(t) / 22)) for t in sources.splitlines()), sum(max(1, math.ceil(len(t) / 22)) for t in details.splitlines()), sum(max(1, math.ceil(len(t) / 22)) for t in original['question'].splitlines())) + 1) * 15))
                def resize(m):
                    previous = re.search(r'\bht="([0-9.]+)"', m.group())
                    actual_height = max(height, float(previous.group(1)) if previous else 0)
                    attrs = re.sub(r'\s+(?:ht|customHeight)="[^"]*"', '', m.group())
                    return attrs[:-1] + f' ht="{actual_height}" customHeight="1">'
                xml = re.sub(rf'<row\b(?=[^>]*\br="{line}")[^>]*>', resize, xml, count=1)
            # Extend used dimension and source width without moving existing columns.
            xml = re.sub(r'<dimension\b[^>]*/>', f'<dimension ref="A1:{source_column}{stat["rows"]}"/>', xml, count=1)
            from openpyxl.utils import column_index_from_string
            source_number = column_index_from_string(source_column)
            column = '<col min="4" max="4" width="18" customWidth="1"/><col min="5" max="5" width="48" customWidth="1"/>' + f'<col min="{source_number}" max="{source_number}" width="48" customWidth="1"/>'
            # The blank input's C column can be too narrow for real answers.
            # Split only a column definition that covers C, preserving all neighbors.
            def widen_answer(m):
                tag = m.group()
                first = int(re.search(r'\bmin="(\d+)"', tag).group(1))
                last = int(re.search(r'\bmax="(\d+)"', tag).group(1))
                if not first <= 3 <= last:
                    return tag
                pieces = []
                if first < 3:
                    pieces.append(re.sub(r'\bmax="\d+"', 'max="2"', tag))
                center = re.sub(r'\bmin="\d+"', 'min="3"', re.sub(r'\bmax="\d+"', 'max="3"', tag))
                center = re.sub(r'\s+(?:width|customWidth)="[^"]*"', '', center)
                pieces.append(center[:-2] + ' width="60" customWidth="1"/>')
                if last > 3:
                    pieces.append(re.sub(r'\bmin="\d+"', 'min="4"', tag))
                return ''.join(pieces)
            has_answer_column = any(int(m.group(1)) <= 3 <= int(m.group(2)) for m in re.finditer(r'<col\b[^>]*\bmin="(\d+)"[^>]*\bmax="(\d+)"', xml))
            xml = re.sub(r'<col\b[^>]*/>', widen_answer, xml)
            if not has_answer_column:
                column = '<col min="3" max="3" width="60" customWidth="1"/>' + column
            if '</cols>' in xml:
                xml = xml.replace('</cols>', column + '</cols>', 1)
            else:
                xml = xml.replace('<sheetData', '<cols>' + column + '</cols><sheetData', 1)
            # Expand print area separately only if the workbook already defines one.
            ET.fromstring(xml)
            patches[part] = xml.encode("utf-8")
        # Shift references in both filled sheets and formulas on other sheets.
        for sheet in workbook.find('s:sheets', NS):
            target = targets[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
            part = target.lstrip('/') if target.startswith('/') else 'xl/' + target
            before = patches.get(part, source.read(part))
            xml = before.decode('utf-8')
            xml = re.sub(r'(<f\b[^>]*>)(.*?)(</f>)', lambda m: m.group(1) + shift_formula(m.group(2), sheet.attrib['name'], affected) + m.group(3), xml, flags=re.S)
            if xml.encode('utf-8') != before:
                patches[part] = xml.encode('utf-8')
        workbook_xml = source.read('xl/workbook.xml').decode('utf-8')
        sheet_names = [sheet.attrib['name'] for sheet in workbook.find('s:sheets', NS)]
        def shift_defined_name(match):
            local = re.search(r'\blocalSheetId="(\d+)"', match.group(1))
            owner = sheet_names[int(local.group(1))] if local else ''
            return match.group(1) + shift_formula(match.group(2), owner, affected) + match.group(3)
        workbook_xml = re.sub(r'(<definedName\b[^>]*>)(.*?)(</definedName>)', shift_defined_name, workbook_xml, flags=re.S)
        if workbook_xml.encode('utf-8') != source.read('xl/workbook.xml'):
            patches['xl/workbook.xml'] = workbook_xml.encode('utf-8')
        if added_xfs:
            def extend_styles(match):
                tag = re.sub(r'\s+count="\d+"', '', match.group(1))
                return tag[:-1] + f' count="{len(original_xfs) + len(added_xfs)}">' + match.group(2) + ''.join(added_xfs) + '</cellXfs>'
            styles_xml = re.sub(r'(<cellXfs\b[^>]*>)(.*?)</cellXfs>', extend_styles, styles_xml, count=1, flags=re.S)
            ET.fromstring(styles_xml)
            patches['xl/styles.xml'] = styles_xml.encode('utf-8')
        with zipfile.ZipFile(output, "x", zipfile.ZIP_DEFLATED) as destination:
            for info in source.infolist():
                destination.writestr(info, patches.get(info.filename, source.read(info.filename)))
    return {"written": len(results), "questionCount": len(expected), "mergesRemoved": len(parsed["answerMerges"]), "modifiedParts": list(patches)}


if __name__ == "__main__":
    try:
        action, path = sys.argv[1:3]
        data = parse_input(path) if action == "parse" else export_copy(path, sys.argv[3], json.load(sys.stdin))
        print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error) if isinstance(error, (ValueError, RuntimeError)) else "待填表处理失败，请确认文件格式后重试。"}, ensure_ascii=False))
        sys.exit(1)
