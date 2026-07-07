# 读取操作参考 — PDF/DOCX/PPTX/XLSX

> 所有代码已通过 PPAP 验证 (2026-07-01, Win10 + Python 3.13 + WPS)

---

## PDF 读取

**方法:** 系统工具 `pdftotext` (Git Bash 内置, 零依赖)

```bash
# 输出到 stdout
pdftotext "C:/path/to/file.pdf" -

# 提取前N行
pdftotext file.pdf - | head -50

# 搜索关键词
pdftotext file.pdf - | grep "关键词"

# 保持排版(适合表格)
pdftotext -layout "file.pdf" "output.txt"

# 指定页范围
pdftotext -f 1 -l 3 "file.pdf" -
```

**错误排查:**
| 错误 | 原因 | 处置 |
|------|------|------|
| command not found | pdftotext 不在 PATH | 用完整路径或安装 XPDF |
| 输出为空 | 加密/扫描件/图片PDF | 尝试 OCR |
| 乱码 | 编码问题 | 加 `-enc UTF-8` |

---

## DOCX 读取

**方法:** zipfile 解压 + XML 解析 (零依赖)

```python
import zipfile, xml.etree.ElementTree as ET, os

def read_docx(docx_path):
    """
    读取 DOCX 文件所有文本内容。
    Returns: str
    """
    if not os.path.isfile(docx_path):
        raise FileNotFoundError(f"文件不存在: {docx_path}")
    try:
        with zipfile.ZipFile(docx_path, 'r') as z:
            if 'word/document.xml' not in z.namelist():
                raise ValueError(f"无效的 DOCX: 缺少 word/document.xml\n文件可能已损坏或不是 Word 文档: {docx_path}")
            xml = z.read('word/document.xml').decode('utf-8')

        root = ET.fromstring(xml)
        texts = []
        for elem in root.iter():
            # 使用 tag.endswith() 稳健匹配 (Python 3.13+ 兼容)
            if elem.tag.endswith('}t') and elem.text and elem.text.strip():
                texts.append(elem.text)
        return ''.join(texts)
    except zipfile.BadZipFile:
        raise ValueError(f"文件不是有效的 DOCX (ZIP 损坏): {docx_path}")

# 使用
text = read_docx('C:/path/to/file.docx')
print(text)
```

**可读取的内部路径:**
| 路径 | 内容 |
|------|------|
| `word/document.xml` | 正文(主) |
| `word/header1.xml` | 页眉 |
| `word/footer1.xml` | 页脚 |

---

## PPTX 读取

**方法:** zipfile 解压 + 遍历所有幻灯片 XML (零依赖)

```python
import zipfile, xml.etree.ElementTree as ET, re, os

def read_pptx(pptx_path):
    """
    读取 PPTX 所有幻灯片文本。
    Returns: list[dict] [{'slide': 1, 'text': '...'}, ...]
    """
    if not os.path.isfile(pptx_path):
        raise FileNotFoundError(f"文件不存在: {pptx_path}")
    try:
        slides_content = []
        with zipfile.ZipFile(pptx_path, 'r') as z:
            slides = sorted(
                [f for f in z.namelist()
                 if re.match(r'ppt/slides/slide\d+\.xml$', f)],
                key=lambda x: int(re.search(r'slide(\d+)', x).group(1))
            )

            if not slides:
                raise ValueError(f"无效的 PPTX: 未找到幻灯片文件\n文件可能已损坏或不是 PowerPoint 文档: {pptx_path}")

            for slide_path in slides:
                slide_num = int(re.search(r'slide(\d+)', slide_path).group(1))
                xml = z.read(slide_path).decode('utf-8')
                root = ET.fromstring(xml)

                texts = []
                for elem in root.iter():
                    if elem.tag.endswith('}t') and elem.text and elem.text.strip():
                        texts.append(elem.text.strip())

                slides_content.append({
                    'slide': slide_num,
                    'text': '\n'.join(texts),
                    'char_count': sum(len(t) for t in texts)
                })

        return slides_content
    except zipfile.BadZipFile:
        raise ValueError(f"文件不是有效的 PPTX (ZIP 损坏): {pptx_path}")

# 使用
for slide in read_pptx('presentation.pptx'):
    print(f"[Slide {slide['slide']}] ({slide['char_count']} chars)")
    print(slide['text'])
    print('-' * 40)
```

---

## XLSX 读取

> **多工作表支持:** `read_xlsx(path, sheet_index='all')` 返回所有 sheet 字典；`list_sheets(path)` 列出 sheet 名。

**方法:** zipfile 解压 + SharedStrings 表 + Sheet 数据 (零依赖)

> **关键:** 使用 `tag.endswith()` 递归匹配，不用 `iter(f'{NS}tag')`。
> 原因: Python 3.13+ 的 ElementTree 对命名空间处理不稳定。

```python
import zipfile, xml.etree.ElementTree as ET, re, os

def _find_all_recursive(elem, local_name):
    """递归搜索所有 tag 以 '}local_name' 结尾的元素"""
    results = []
    if elem.tag.endswith('}' + local_name):
        results.append(elem)
    for child in elem:
        results.extend(_find_all_recursive(child, local_name))
    return results

# OOXML 关系命名空间
_R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

def _parse_shared_strings(z):
    """读取共享字符串表 → list[str]"""
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        ss_root = ET.fromstring(z.read('xl/sharedStrings.xml').decode('utf-8'))
        for si in _find_all_recursive(ss_root, 'si'):
            t_parts = [e.text or '' for e in _find_all_recursive(si, 't')]
            shared.append(''.join(t_parts))
    return shared

def _list_sheets_internal(z):
    """
    返回 [(sheet_name, zip_path)]，按 workbook.xml 中的显示顺序排列。
    zip_path 形如 'xl/worksheets/sheet1.xml'
    """
    wb_root = ET.fromstring(z.read('xl/workbook.xml').decode('utf-8'))
    sheet_defs = []  # (name, rId)
    for s in _find_all_recursive(wb_root, 'sheet'):
        name = s.get('name', 'Sheet')
        rid = s.get(f'{{{_R_NS}}}id')
        sheet_defs.append((name, rid))

    # 解析关系 Id → Target
    rid_to_target = {}
    if 'xl/_rels/workbook.xml.rels' in z.namelist():
        rels_root = ET.fromstring(z.read('xl/_rels/workbook.xml.rels').decode('utf-8'))
        for rel in _find_all_recursive(rels_root, 'Relationship'):
            rid_to_target[rel.get('Id')] = rel.get('Target')

    result = []
    for name, rid in sheet_defs:
        target = rid_to_target.get(rid, '')
        if not target:
            continue
        if not target.startswith('xl/'):
            target = 'xl/' + target.lstrip('/')
        result.append((name, target))
    return result

def _parse_sheet_data(z, sheet_path, shared_strings):
    """解析单个 sheet XML → list[list]"""
    root = ET.fromstring(z.read(sheet_path).decode('utf-8'))
    result = []
    for row_elem in _find_all_recursive(root, 'row'):
        row_data = {}
        for cell in _find_all_recursive(row_elem, 'c'):
            ref = cell.get('r')                 # "A1", "B3"
            cell_type = cell.get('t')           # "s"=string, "n"=number
            v_elems = _find_all_recursive(cell, 'v')
            v_text = v_elems[0].text if v_elems else None

            if v_text and v_text.strip():
                raw = v_text.strip()
                if cell_type == 's':
                    idx = int(raw)
                    row_data[ref] = shared_strings[idx] if idx < len(shared_strings) else raw
                else:
                    try:
                        row_data[ref] = float(raw) if '.' in raw else int(raw)
                    except ValueError:
                        row_data[ref] = raw

        if row_data:
            sorted_cells = sorted(row_data.items(), key=lambda x: (
                int(''.join(filter(str.isdigit, x[0])) or 0),
                ord(''.join(filter(str.isalpha, x[0])) or 'A') - 64
            ))
            result.append([v for _, v in sorted_cells])
        else:
            result.append([])
    return result

def list_sheets(xlsx_path):
    """
    列出 XLSX 所有工作表名称（按显示顺序）。
    Returns: list[str]
    """
    if not os.path.isfile(xlsx_path):
        raise FileNotFoundError(f"文件不存在: {xlsx_path}")
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as z:
            return [name for name, _ in _list_sheets_internal(z)]
    except zipfile.BadZipFile:
        raise ValueError(f"文件不是有效的 XLSX (ZIP 损坏): {xlsx_path}")

def read_xlsx(xlsx_path, sheet_index=0):
    """
    读取 XLSX 工作表数据。

    sheet_index:
      - int  → 读取指定索引的单个 sheet（默认 0）
      - 'all' → 读取所有 sheet，返回 {sheet_name: data} 字典
    Returns: list[list] 或 dict[str, list[list]]
    """
    if not os.path.isfile(xlsx_path):
        raise FileNotFoundError(f"文件不存在: {xlsx_path}")
    if os.path.getsize(xlsx_path) > 15 * 1024 * 1024:
        print(f"提示: 文件较大 ({os.path.getsize(xlsx_path)//1024//1024}MB)，处理可能需要几秒钟...")
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as z:
            shared = _parse_shared_strings(z)
            sheet_list = _list_sheets_internal(z)
            if not sheet_list:
                raise ValueError(f"XLSX 中未找到任何工作表: {xlsx_path}")

            # === 多 Sheet 模式 ===
            if sheet_index == 'all':
                return {
                    name: _parse_sheet_data(z, path, shared)
                    for name, path in sheet_list
                }

            # === 单 Sheet 模式 ===
            if sheet_index >= len(sheet_list):
                raise IndexError(
                    f"sheet_index {sheet_index} 超出范围 (共 {len(sheet_list)} 个: "
                    f"{', '.join(n for n, _ in sheet_list)})"
                )
            _, target = sheet_list[sheet_index]
            return _parse_sheet_data(z, target, shared)

    except zipfile.BadZipFile:
        raise ValueError(f"文件不是有效的 XLSX (ZIP 损坏): {xlsx_path}")
    except KeyError as e:
        raise ValueError(f"XLSX 内部结构异常，缺少: {e}")

# 使用 1: 读取第一个 sheet（默认）
data = read_xlsx('data.xlsx')
for row in data:
    print('\t'.join(str(c) for c in row))

# 使用 2: 列出所有 sheet 名
print(list_sheets('data.xlsx'))   # ['Sheet1', 'Sheet2', '汇总']

# 使用 3: 读取所有 sheet 为字典
all_data = read_xlsx('data.xlsx', sheet_index='all')
for name, rows in all_data.items():
    print(f"== {name} ==")
    for row in rows:
        print('\t'.join(str(c) for c in row))
```
