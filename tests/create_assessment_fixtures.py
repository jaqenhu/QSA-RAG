import sys
import zipfile
from pathlib import Path

directory = Path(sys.argv[1])
directory.mkdir(parents=True, exist_ok=True)
namespace = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
sheet = f'''<worksheet xmlns="{namespace}"><dimension ref="A1:D9"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols><col min="2" max="3" width="60" customWidth="1"/></cols><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>序号</t></is></c><c r="B1" s="1" t="inlineStr"><is><t>检查内容</t></is></c><c r="C1" s="1" t="inlineStr"><is><t>自评说明</t></is></c><c r="D1" t="inlineStr"><is><t>保留字段</t></is></c></row>
<row r="2"><c r="A2" t="inlineStr"><is><t>质量体系</t></is></c></row>
<row r="3" ht="30" customHeight="1"><c r="A3"><v>1</v></c><c r="B3" t="inlineStr"><is><t>是否建立质量手册？</t></is></c><c r="C3" s="0" t="inlineStr"><is><t>旧答案</t></is></c><c r="D3"><f>1+2</f><v>3</v></c></row>
<row r="4"><c r="B4" t="inlineStr"><is><t>质量目标是否统计，今年达成值是多少？</t></is></c><c r="C4" s="1"/></row>
<row r="5"><c r="B5" t="inlineStr"><is><t>火星基地如何休息？</t></is></c></row>
<row r="6"><c r="A6" t="inlineStr"><is><t>备注章节</t></is></c><c r="B6" t="inlineStr"><is><t>不是问题的合并标题</t></is></c></row>
<row r="7"><c r="A7"><v>7</v></c></row>
<row r="8"><c r="A8" t="inlineStr"><is><t>末尾</t></is></c></row>
<row r="9"><c r="A9"><v>9</v></c></row>
</sheetData><mergeCells count="2"><mergeCell ref="C3:C4"/><mergeCell ref="A6:C6"/></mergeCells><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'''
parts = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': f'<workbook xmlns="{namespace}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="审核检查单" sheetId="1" r:id="r1"/><sheet name="备注" sheetId="2" r:id="r2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="r2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="r3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet,
    'xl/worksheets/sheet2.xml': f'<worksheet xmlns="{namespace}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>保留的其他工作表</t></is></c></row></sheetData></worksheet>',
    'xl/styles.xml': f'<styleSheet xmlns="{namespace}"><fonts count="1"><font><sz val="11"/><name val="Arial"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
}
with zipfile.ZipFile(directory / 'input.xlsx', 'w', zipfile.ZIP_DEFLATED) as archive:
    for name, text in parts.items():
        archive.writestr(name, text.encode('utf-8'))
