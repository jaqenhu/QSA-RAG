import sys
from pathlib import Path
from openpyxl import Workbook

folder = Path(sys.argv[1])
folder.mkdir(parents=True, exist_ok=True)
for version in (1, 2):
    w = Workbook()
    s = w.active
    s.title = '质量"测试'
    s.append(["测试清单"])
    s.append(["序号", "检查内容", "自评说明", "旧备注"])
    s.append(["章节一"])
    s.merge_cells("A3:C3")
    s.append([1, "是否有质量手册？", f"已建立质量手册 v{version}", "过时：没有手册"])
    s.append([None, "是否由负责人批准？", None, "过时备注不能充当答案"])
    s.append([None, "是否设置质量目标？", "有质量目标"])
    s.append([None, "是否统计目标？", None])
    s.merge_cells("C6:C7")
    s.append([None, "检查内容", "自评说明"])
    s.append([None, "公式问题", "=1+1"])
    s.append([None, "错误值问题", "#REF!"])
    s.append([None, '<img src=x onerror="alert(1)">', "文本<script>原文</script>"])
    for n in range(12, 52):
        s.cell(n, 2, f"记录 {n}")
        s.cell(n, 3, f"说明 {n}")
    hidden = w.create_sheet("隐藏表")
    hidden.sheet_state = "hidden"
    hidden.append(["序号", "审核项目", "自评说明"])
    hidden.append([None, "隐藏表问题", "隐藏表说明"])
    other = w.create_sheet("无表头")
    other.append([1, "不能无表头猜测导入", "值"])
    w.save(folder / f"v{version}.xlsx")
w = Workbook()
w.active.append([1, "没有有效表头", "说明"])
w.save(folder / "invalid.xlsx")
