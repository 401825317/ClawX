# 创建操作参考 — DOCX/XLSX/PPTX

> 所有代码已通过 PPAP 验证 (2026-07-01, Win10 + Python 3.13 + WPS)
> 更新: 2026-07-02 — 模板骨架 + 公式支持 + 财务色系

---

## XLSX 创建 (模板骨架 + 公式 + 财务色系 + 多工作表)

**设计原则:** 从 `templates/minimal_xlsx/` 预验证骨架复制，仅修改数据部分。不再从零手写固定 XML。

### 风格位速查 (13 个预置位)

| `s` | 语义 | 颜色 | 格式 |
|:---:|------|------|------|
| 0 | 默认 | 黑 | 常规 |
| 1 | 输入/假设值 | **蓝** 0000FF | 常规 |
| 2 | 公式/计算结果 | **黑** 000000 | 常规 |
| 3 | 跨表引用 | **绿** 008000 | 常规 |
| 4 | 表头 | 黑加粗 | 常规 |
| 5 | 货币输入 | **蓝** | ¥#,##0 |
| 6 | 货币公式 | **黑** | ¥#,##0 |
| 7 | 百分比输入 | **蓝** | 0.0% |
| 8 | 百分比公式 | **黑** | 0.0% |
| 9 | 整数输入 | **蓝** | #,##0 |
| 10 | 整数公式 | **黑** | #,##0 |
| 11 | 年份 | **蓝** | 整数无逗号 |
| 12 | 关键假设 | **蓝字黄底** | 常规 |

> 蓝=人工输入 · 黑=公式计算 · 绿=跨表引用

### 数据格式 (支持3种)

```python
# 普通值: str | int | float | bool | None
data = [['姓名', '年龄'], ['张三', 25]]

# 公式单元格 (dict 格式)
data = [['科目', '分数', '等级'],
        ['数学', 85, {'formula': 'IF(B2>=90,"A",IF(B2>=80,"B","C"))', 'style': 2}]]

# 跨表引用 (绿色)
data = [['汇总'], ['合计', {'formula': "SUM(Data!C2:C100)", 'style': 3}]]
```

### 核心函数

```python
import zipfile, os, shutil
from pathlib import Path
from datetime import datetime, timezone

# 模板路径 — 相对于 skill 根目录
_TEMPLATE = Path(os.path.dirname(__file__)).parent / 'templates' / 'minimal_xlsx'

def _col_letter(n):
    """1→A, 2→B, ..., 27→AA"""
    r = ''
    while n > 0:
        n, rem = divmod(n - 1, 26)
        r = chr(65 + rem) + r
    return r

def _xml_escape(s):
    return str(s).replace('&','&amp;').replace('<','&lt;').replace('>','&gt;').replace('"','&quot;')

def create_xlsx(output_path, data=None, sheet_name='Sheet1',
                sheets=None, col_widths=None, freeze_row=None):
    """
    从预验证模板骨架创建 XLSX。支持公式、13种财务风格位、多工作表。

    Args:
        output_path: 输出路径 (str)
        data: 二维数据 (list[list]) — 单表模式
              单元格可以是:
                - str/int/float/bool/None (普通值)
                - dict: {'formula': 'SUM(B2:B5)', 'style': 2}  (公式)
                - dict: {'value': 100, 'style': 5}  (带风格的普通值)
        sheet_name: 工作表名 (str) — 单表模式
        sheets: 多表模式 list of (name, data) — 提供后覆盖 data/sheet_name
                例: [('成绩单', data1), ('汇总', data2)]
        col_widths: 列宽 {col_num: width}  例: {1:28, 2:14}（应用到所有 sheet）
        freeze_row: 冻结行号 (int)  例: 1 冻结表头行（应用到所有 sheet）

    Returns: str (输出路径)

    示例:
        # 单表
        data = [
            ['科目', '数学', '英语', '总分'],            # 表头 (s=4)
            ['张三', 85, 92, {'formula':'SUM(B2:C2)', 'style':2}],
            ['李四', 78, 88, {'formula':'SUM(B3:C3)', 'style':2}],
        ]
        create_xlsx('成绩表.xlsx', data, '成绩', freeze_row=1)

        # 多表
        create_xlsx('工作簿.xlsx', sheets=[
            ('成绩单', data),
            ('汇总', [['姓名','总分'], ['张三', {'formula':'SUM(成绩单!D2)', 'style':3}]])
        ])
    """
    import tempfile, re

    # 前置检查
    if not _TEMPLATE.exists():
        raise FileNotFoundError(f"XLSX 模板骨架不存在: {_TEMPLATE}\n请确认 skill 安装完整")
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    # 1) 复制模板骨架到临时目录
    tmp = tempfile.mkdtemp()
    try:
        shutil.copytree(_TEMPLATE, tmp, dirs_exist_ok=True)
    except Exception:
        shutil.rmtree(tmp, ignore_errors=True)
        raise

    # 1.1) 还原 OOXML 关系文件名: 发布包为避免平台拦截 .rels 扩展名，
    #      模板以 .rels.txt 存储；运行时还原为正确的 .rels，确保生成的
    #      xlsx 含合法关系声明（Office/WPS 才能正常打开）
    for _root, _dirs, _files in os.walk(tmp):
        for _fn in _files:
            if _fn.endswith('.rels.txt'):
                _src = os.path.join(_root, _fn)
                _dst = os.path.join(_root, _fn[:-4])  # 去掉末尾 .txt
                os.replace(_src, _dst)

    # 1.5) 单表/多表归一化
    if sheets is not None:
        sheet_specs = list(sheets)
    else:
        if data is None:
            raise ValueError("data 和 sheets 至少需提供一个")
        sheet_specs = [(sheet_name, data)]
    if not sheet_specs:
        raise ValueError("至少需要一个工作表")
    for _sn, _sd in sheet_specs:
        if not _sd:
            raise ValueError(f"工作表 '{_sn}' 数据不能为空")

    # 2) 构建 sharedStrings 和 sheet XML
    ss_list = []
    ss_map = {}
    def _add_ss(s):
        if s not in ss_map:
            ss_map[s] = len(ss_list)
            ss_list.append(s)
        return ss_map[s]

    rows_xmls = []   # 每个 sheet 的 <row> 列表
    freeze_xml = ''

    # 为每个 sheet 构建行 XML
    for _sheet_data in sheet_specs:
        _sdata = _sheet_data[1]
        _rows = []
        for r_idx, row in enumerate(_sdata, 1):
            cells = []
            for c_idx, cell in enumerate(row, 1):
                ref = f'{_col_letter(c_idx)}{r_idx}'

                # 解析单元格值
                if isinstance(cell, dict):
                    formula = cell.get('formula')
                    style = cell.get('style', 0)
                    value = cell.get('value') if 'value' in cell else None
                    if formula:
                        f_xml = _xml_escape(formula)
                        cells.append(
                            f'<c r="{ref}" s="{style}"><f>{f_xml}</f><v></v></c>')
                    elif value is not None:
                        if isinstance(value, str):
                            si = _add_ss(value)
                            cells.append(
                                f'<c r="{ref}" t="s" s="{style}"><v>{si}</v></c>')
                        elif isinstance(value, bool):
                            cells.append(
                                f'<c r="{ref}" t="b" s="{style}"><v>{int(value)}</v></c>')
                        else:
                            cells.append(
                                f'<c r="{ref}" s="{style}"><v>{value}</v></c>')
                    else:
                        cells.append(f'<c r="{ref}" s="{style}"/>')
                elif isinstance(cell, str):
                    si = _add_ss(cell)
                    cells.append(f'<c r="{ref}" t="s"><v>{si}</v></c>')
                elif isinstance(cell, bool):
                    cells.append(f'<c r="{ref}" t="b"><v>{int(cell)}</v></c>')
                elif isinstance(cell, (int, float)):
                    cells.append(f'<c r="{ref}"><v>{cell}</v></c>')
                elif cell is None:
                    cells.append(f'<c r="{ref}"/>')
                else:
                    si = _add_ss(str(cell))
                    cells.append(f'<c r="{ref}" t="s"><v>{si}</v></c>')

            _rows.append(f'<row r="{r_idx}">{"".join(cells)}</row>')
        rows_xmls.append(_rows)

    # 3) 冻结窗格
    if freeze_row:
        freeze_xml = (
            f'<pane ySplit="{freeze_row}" '
            f'topLeftCell="A{freeze_row+1}" '
            f'activePane="bottomLeft" state="frozen"/>'
        )

    # 4) 列宽
    cols_xml = ''
    if col_widths:
        cols_xml = '<cols>'
        for c, w in sorted(col_widths.items()):
            cols_xml += f'<col min="{c}" max="{c}" width="{w}" customWidth="1"/>'
        cols_xml += '</cols>'

    # 5) 写 sharedStrings.xml
    sst_count = len(ss_list)
    sst_items = ''.join(
        f'<si><t>{_xml_escape(s)}</t></si>' for s in ss_list
    )
    sst_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        f'count="{sst_count}" uniqueCount="{sst_count}">\n'
        f'{sst_items}\n'
        f'</sst>'
    )
    with open(os.path.join(tmp, 'xl', 'sharedStrings.xml'), 'w', encoding='utf-8') as f:
        f.write(sst_xml)

    # 6) 写每个 sheetN.xml
    for i, _rows in enumerate(rows_xmls):
        sheet_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
            ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
            '  <sheetViews>\n'
            f'    <sheetView workbookViewId="0">\n{freeze_xml}'
            '    </sheetView>\n'
            '  </sheetViews>\n'
            '  <sheetFormatPr defaultRowHeight="15" '
            'xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" '
            'x14ac:dyDescent="0.25"/>\n'
            f'{cols_xml}\n'
            '  <sheetData>\n'
            f'{"".join(_rows)}\n'
            '  </sheetData>\n'
            '  <pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>\n'
            '</worksheet>'
        )
        with open(os.path.join(tmp, 'xl', 'worksheets', f'sheet{i+1}.xml'), 'w', encoding='utf-8') as f:
            f.write(sheet_xml)

    # 7) 写 workbook.xml (列出所有 sheet)
    sheets_xml = ''.join(
        f'    <sheet name="{_xml_escape(n)}" sheetId="{i+1}" r:id="rId{i+1}"/>\n'
        for i, (n, _) in enumerate(sheet_specs)
    )
    wb_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n'
        '  <sheets>\n'
        f'{sheets_xml}'
        '  </sheets>\n'
        '</workbook>'
    )
    with open(os.path.join(tmp, 'xl', 'workbook.xml'), 'w', encoding='utf-8') as f:
        f.write(wb_xml)

    # 7.5) 写 workbook.xml.rels (动态关系，每个 sheet 一个 rId)
    n_sheets = len(sheet_specs)
    rel_items = []
    for i in range(n_sheets):
        rel_items.append(
            f'  <Relationship Id="rId{i+1}" '
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
            f'Target="worksheets/sheet{i+1}.xml"/>')
    # 末尾两个固定关系: styles + sharedStrings
    rel_items.append(
        f'  <Relationship Id="rId{n_sheets+1}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
        f'Target="styles.xml"/>')
    rel_items.append(
        f'  <Relationship Id="rId{n_sheets+2}" '
        f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" '
        f'Target="sharedStrings.xml"/>')
    rels_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
        + '\n'.join(rel_items) + '\n'
        '</Relationships>'
    )
    with open(os.path.join(tmp, 'xl', '_rels', 'workbook.xml.rels'), 'w', encoding='utf-8') as f:
        f.write(rels_xml)

    # 7.6) 写 [Content_Types].xml (动态，每个 sheet 一个 Override)
    ct_overrides = [
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>',
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
    ]
    for i in range(n_sheets):
        ct_overrides.append(
            f'<Override PartName="/xl/worksheets/sheet{i+1}.xml" '
            f'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
    ct_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
        '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
        '  <Default Extension="xml" ContentType="application/xml"/>\n'
        + '\n'.join('  ' + o for o in ct_overrides) + '\n'
        '</Types>'
    )
    with open(os.path.join(tmp, '[Content_Types].xml'), 'w', encoding='utf-8') as f:
        f.write(ct_xml)

    # 8) 写 core.xml (时间戳)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    core_xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"\n'
        '  xmlns:dc="http://purl.org/dc/elements/1.1/"\n'
        '  xmlns:dcterms="http://purl.org/dc/terms/"\n'
        '  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
        '  <dc:creator>Office Toolkit</dc:creator>\n'
        f'  <dcterms:created xsi:type="dcterms:W3CDTF">{now}</dcterms:created>\n'
        '</cp:coreProperties>'
    )
    with open(os.path.join(tmp, 'docProps', 'core.xml'), 'w', encoding='utf-8') as f:
        f.write(core_xml)

    # 9) 打包 ZIP（动态 file_order，包含所有 sheet）
    file_order = [
        '[Content_Types].xml',
        '_rels/.rels',
        'xl/workbook.xml',
        'xl/_rels/workbook.xml.rels',
    ]
    for i in range(n_sheets):
        file_order.append(f'xl/worksheets/sheet{i+1}.xml')
    file_order += [
        'xl/sharedStrings.xml',
        'xl/styles.xml',
        'docProps/core.xml',
        'docProps/app.xml',
    ]
    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for fname in file_order:
            fpath = os.path.join(tmp, fname)
            if os.path.exists(fpath):
                z.write(fpath, fname)

    # 10) 清理
    shutil.rmtree(tmp, ignore_errors=True)
    return output_path


# ── 使用示例 ──────────────────────────────────────────

# 例1: 简单成绩表 (带公式)
create_xlsx('成绩表.xlsx', [
    ['姓名', '数学', '英语', '总分', '平均分'],
    ['张三', 85, 92,
        {'formula': 'SUM(B2:C2)', 'style': 2},
        {'formula': 'AVERAGE(B2:C2)', 'style': 2}],
    ['李四', 78, 88,
        {'formula': 'SUM(B3:C3)', 'style': 2},
        {'formula': 'AVERAGE(B3:C3)', 'style': 2}],
    ['王五', 95, 73,
        {'formula': 'SUM(B4:C4)', 'style': 2},
        {'formula': 'AVERAGE(B4:C4)', 'style': 2}],
], sheet_name='成绩单', freeze_row=1,
   col_widths={1: 12, 2: 10, 3: 10, 4: 10, 5: 10})

# 例2: 财务模型 (蓝输入/黑公式)
create_xlsx('财务模型.xlsx', [
    ['指标', '2023A', '2024E', '2025E'],
    ['营收增长率', None, {'value': 0.12, 'style': 7}, {'value': 0.15, 'style': 7}],
    ['毛利率', None, {'value': 0.45, 'style': 7}, {'value': 0.47, 'style': 7}],
    ['营收', 85000000,
        {'formula': 'B4*(1+C2)', 'style': 6},
        {'formula': 'C4*(1+D2)', 'style': 6}],
    ['毛利', {'formula': 'B4*B3', 'style': 6},
        {'formula': 'C4*C3', 'style': 6},
        {'formula': 'D4*D3', 'style': 6}],
    ['毛利同比增长',
        None,
        {'formula': 'IF(C4=0,0,C5/B5-1)', 'style': 8},
        {'formula': 'IF(D4=0,0,D5/C5-1)', 'style': 8}],
], sheet_name='财务模型', freeze_row=1,
   col_widths={1: 18, 2: 14, 3: 14, 4: 14})

# 例3: 兼容旧格式 (纯数值, 无公式)
create_xlsx('简表.xlsx', [
    ['姓名', '年龄', '职业'],
    ['张三', 25, '工程师'],
], sheet_name='人员表')

# 例4: 多工作表工作簿 (sheets 参数)
成绩_data = [
    ['姓名', '数学', '英语', '总分'],
    ['张三', 85, 92, {'formula': 'SUM(B2:C2)', 'style': 2}],
    ['李四', 78, 88, {'formula': 'SUM(B3:C3)', 'style': 2}],
]
汇总_data = [
    ['项目', '值'],
    ['最高分', {'formula': 'MAX(成绩单!D2:D3)', 'style': 3}],
    ['平均分', {'formula': 'AVERAGE(成绩单!D2:D3)', 'style': 3}],
]
create_xlsx('成绩册.xlsx', sheets=[
    ('成绩单', 成绩_data),
    ('汇总',   汇总_data),
], freeze_row=1)
```

---

## DOCX 创建 (stdlib, 零依赖)

**验证:** ✅ WPS 可正常打开
**限制:** 仅纯文本段落，不支持表格/图片/样式

```python
import zipfile, os
from datetime import datetime, timezone

def create_docx(output_path, paragraphs):
    """
    用纯 Python stdlib 创建最小有效的 DOCX。
    Args:
        output_path: 输出路径 (str)
        paragraphs: 段落文本列表 (list[str])
    Returns: str (输出路径)
    """
    if not paragraphs:
        raise ValueError("paragraphs 不能为空")

    # 确保输出目录存在
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    body_xml = ''
    for p_text in paragraphs:
        safe = (p_text.replace('&', '&amp;')
                      .replace('<', '&lt;')
                      .replace('>', '&gt;')
                      .replace('"', '&quot;'))
        body_xml += f'<w:p><w:r><w:t>{safe}</w:t></w:r></w:p>\n'

    document_xml = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n'
        '  <w:body>\n' +
        body_xml +
        '  <w:sectPr>\n'
        '    <w:pgSz w:w="11906" w:h="16838"/>\n'
        '    <w:pgMar w:top="1440" w:bottom="1440" w:left="1800" w:right="1800"/>\n'
        '  </w:sectPr>\n'
        '  </w:body>\n'
        '</w:document>'
    )

    ct = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>'''

    rels = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>'''

    with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', ct)
        z.writestr('_rels/.rels', rels)
        z.writestr('word/document.xml', document_xml)

    return output_path

# 使用
create_docx('output.docx', [
    '标题行',
    '第二段内容',
    f'生成时间: {datetime.now().strftime("%Y-%m-%d %H:%M")}'
])
```

---

## PPTX 创建 (兼容兜底)

新建或重做视觉化 PPT 时，先使用 `presentation-maker` skill 和
`create_designed_pptx_file`。下面的 `python-pptx` 路径只用于设计工具
不可用、批量兼容或已有复杂文件处理，不能替代高设计主链路。

**验证:** ✅ WPS 可正常打开
**依赖:** UClaw Office Python 环境通常已提供 `python-pptx==1.0.2`；如果缺失，使用 `uv run --with python-pptx==1.0.2 python <script>` 重试。

> **为什么不能用 stdlib?**
> WPS/Office 要求 PPTX 最小结构包含 11 个 slideLayout、thumbnail.jpeg、
> presProps.xml、viewProps.xml、完整 slideMaster 等，总计约 47 个内部文件。
> 手写不现实，必须用 python-pptx。

```python
from pptx import Presentation
from pptx.util import Inches, Pt
import os

def create_pptx(output_path, slides_data):
    """
    使用 python-pptx 创建 PPTX。
    Args:
        output_path: 输出路径 (str)
        slides_data: 幻灯片数据 (list[dict])
            每个 dict:
              - 'title' (str): 标题
              - 'body' (list[str]): 正文行
              - 'title_size' (int): 标题字号, 默认 36
              - 'body_size' (int): 正文字号, 默认 20
              - 'font' (str): 字体, 默认 '微软雅黑'
    Returns: str (输出路径)
    """
    if not slides_data:
        raise ValueError("slides_data 不能为空")

    # 确保输出目录存在
    out_dir = os.path.dirname(os.path.abspath(output_path))
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    try:
        prs = Presentation()
        blank_layout = prs.slide_layouts[6]  # 空白布局

        for slide_info in slides_data:
            slide = prs.slides.add_slide(blank_layout)
            title_size = slide_info.get('title_size', 36)
            body_size = slide_info.get('body_size', 20)
            font_name = slide_info.get('font', '微软雅黑')

            # 标题
            if 'title' in slide_info:
                txBox = slide.shapes.add_textbox(
                    Inches(0.5), Inches(0.3), Inches(9), Inches(1.2))
                tf = txBox.text_frame
                tf.word_wrap = True
                run = tf.paragraphs[0].add_run()
                run.text = slide_info['title']
                run.font.size = Pt(title_size)
                run.font.name = font_name

            # 正文
            if 'body' in slide_info:
                txBox = slide.shapes.add_textbox(
                    Inches(0.5), Inches(1.8), Inches(9), Inches(5))
                tf = txBox.text_frame
                tf.word_wrap = True
                for i, line in enumerate(slide_info['body']):
                    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
                    run = p.add_run()
                    run.text = line
                    run.font.size = Pt(body_size)
                    run.font.name = font_name

        prs.save(output_path)
        return output_path
    except Exception as e:
        raise RuntimeError(
            f"PPTX 创建失败: {e}\n"
            f"建议: 确认 python-pptx 已安装；UClaw 中可用 uv run --with python-pptx==1.0.2 python <script> 重试"
        )

# 使用
create_pptx('output.pptx', [
    {
        'title': '演示文稿标题',
        'body': ['副标题', '作者: Your Name', '日期: 2026-07-01'],
        'title_size': 44
    },
    {
        'title': '第二页',
        'body': ['要点 1', '要点 2', '要点 3'],
        'title_size': 32,
        'body_size': 24
    }
])
```
