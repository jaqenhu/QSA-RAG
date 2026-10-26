import sys
import json
import zipfile
import openpyxl
from hashlib import sha256
from xml.etree import ElementTree as ET

sys.path.insert(0, str(__import__('pathlib').Path(__file__).resolve().parents[1] / 'backend'))
from assessment_workbook import shift_formula
assert shift_formula('D3+$A$3', '审核检查单', {'审核检查单'}) == 'F3+$A$3'
assert shift_formula("'审核检查单'!$D$3", '备注', {'审核检查单'}) == "'审核检查单'!$F$3"
assert shift_formula('SUM(D:F)+FOO', '审核检查单', {'审核检查单'}) == 'SUM(F:H)+FOO'
assert shift_formula('备注!D3', '审核检查单', {'审核检查单'}) == '备注!D3'

source, output, expected_file = sys.argv[1:4]
expected = json.load(open(expected_file, encoding='utf-8'))
with zipfile.ZipFile(source) as original, zipfile.ZipFile(output) as exported:
    assert set(original.namelist()) == set(exported.namelist())
    for part in original.namelist():
        if part not in ('xl/worksheets/sheet1.xml','xl/styles.xml'):
            assert sha256(original.read(part)).digest() == sha256(exported.read(part)).digest(), part
    ns = {'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    old_styles = ET.fromstring(original.read('xl/styles.xml'))
    new_styles = ET.fromstring(exported.read('xl/styles.xml'))
    for old_xf,new_xf in zip(old_styles.find('s:cellXfs',ns),new_styles.find('s:cellXfs',ns)):
        assert ET.tostring(old_xf)==ET.tostring(new_xf)
workbook = openpyxl.load_workbook(output, data_only=False)
sheet = workbook['审核检查单']
assert 'C3:C4' not in {str(m) for m in sheet.merged_cells.ranges}
assert 'A6:C6' in {str(m) for m in sheet.merged_cells.ranges}
assert sheet['F3'].value == '=1+2'
assert sheet['D1'].value == '依据'
assert sheet['E1'].value == '详细说明'
assert sheet['G1'].value == '来源'
assert sheet['C4'].style_id == sheet['C3'].style_id
assert sheet['C3'].alignment.wrap_text is True
assert sheet['C4'].alignment.wrap_text is True
for row in expected['results']:
    value = row['answer']
    assert sheet[row['answerCell']].value == value, row['answerCell']
    assert sheet[f"D{row['line']}"].value == row['basis']
    assert sheet[f"E{row['line']}"].value == row['details']
    for evidence in row['sources']:
        assert evidence['sheet'] in sheet[f"G{row['line']}"].value
        assert f"第 {evidence['line']} 行" in sheet[f"G{row['line']}"].value
print('逐题答案、来源、合并、公式、样式和未修改部件验证通过')
