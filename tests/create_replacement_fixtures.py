"""Distinct replacement input: new filename, sheets, rows, questions and merges."""
import sys
from pathlib import Path
import openpyxl

directory = Path(sys.argv[1])
workbook = openpyxl.Workbook()
sheet = workbook.active
sheet.title = '替换审核表'
sheet.append(['序号', '审核项目', '自评说明'])
sheet.append(['新章节'])
sheet.append([None, '替换问题：是否建立质量手册？'])
sheet.append([None, '替换问题：质量目标是否统计？'])
other = workbook.create_sheet('补充检查')
other.append(['序号', '审核项目', '自评说明'])
other.append([None, '替换问题：火星基地如何休息？'])
other.append([None, '替换问题：是否由负责人批准质量手册？'])
workbook.save(directory / 'replacement.xlsx')
workbook.close()
(directory / 'renamed.xlsx').write_bytes((directory / 'replacement.xlsx').read_bytes())
(directory / 'invalid.xlsx').write_bytes(b'invalid workbook')
