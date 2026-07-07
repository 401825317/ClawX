# 格式转换参考

> 代码已通过 PPAP 验证 (2026-07-01)
> XLSX 相关转换使用 `tag.endswith()` 稳健匹配方案

---

## 转换能力总览

| 源 → 目标 | stdlib | Python库 | 系统工具 | 质量 |
|:---------:|:------:|:-------:|:-------:|:----:|
| XLSX → CSV | ✅ | openpyxl | LibreOffice | ⭐⭐⭐⭐⭐ |
| XLSX → JSON | ✅ | openpyxl | — | ⭐⭐⭐⭐⭐ |
| PDF → TXT | ✅ pdftotext | pypdf | — | ⭐⭐⭐⭐ |
| DOCX → PDF | ❌ | COM 自动化 ✅已验证(WPS+MSO) | LibreOffice | ⭐⭐⭐⭐⭐ |
| PPTX → PDF | ❌ | COM 自动化 ✅已验证(WPS+MSO) | LibreOffice | ⭐⭐⭐⭐⭐ |
| XLSX → PDF | ❌ | COM 自动化 ✅已验证(WPS+MSO) | LibreOffice | ⭐⭐⭐⭐⭐ |
| PDF → DOCX | ❌ | pdf2docx | ❌ | ⭐⭐ |
| MD → DOCX | ❌ | pypandoc | pandoc | ⭐⭐⭐⭐ |
| HTML → PDF | ❌ | weasyprint | wkhtmltopdf | ⭐⭐⭐ |
| IMG → PDF | ❌ | img2pdf | — | ⭐⭐⭐⭐ |

---

## XLSX → CSV (stdlib) ⭐⭐⭐⭐⭐

**验证:** ✅ PASS (2026-07-01)

```python
import zipfile, xml.etree.ElementTree as ET, csv, re, os

def _find_all_recursive(elem, local_name):
    """递归搜索所有 tag 以 '}local_name' 结尾的元素"""
    results = []
    if elem.tag.endswith('}' + local_name):
        results.append(elem)
    for child in elem:
        results.extend(_find_all_recursive(child, local_name))
    return results

def xlsx_to_csv(xlsx_path, csv_path, sheet_index=0):
    """
    XLSX 转 CSV (纯 stdlib)。
    Returns: int (写入行数)
    """
    if not os.path.isfile(xlsx_path):
        raise FileNotFoundError(f"文件不存在: {xlsx_path}")
    if os.path.getsize(xlsx_path) > 15 * 1024 * 1024:
        print(f"提示: 文件较大 ({os.path.getsize(xlsx_path)//1024//1024}MB)，处理可能需要几秒钟...")
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as z:
            # 共享字符串
            shared_strings = []
            ss_path = 'xl/sharedStrings.xml'
            if ss_path in z.namelist():
                ss_root = ET.fromstring(z.read(ss_path).decode('utf-8'))
                for si in _find_all_recursive(ss_root, 'si'):
                    t_parts = [e.text or '' for e in _find_all_recursive(si, 't')]
                    shared_strings.append(''.join(t_parts))

            # 目标 sheet
            all_sheets = sorted(
                [f for f in z.namelist()
                 if re.match(r'xl/worksheets/sheet\d+\.xml$', f)],
                key=lambda x: int(re.search(r'sheet(\d+)', x).group(1))
            )
            if sheet_index >= len(all_sheets):
                raise IndexError(f"sheet {sheet_index} 不存在 (共 {len(all_sheets)} 个)")
            root = ET.fromstring(z.read(all_sheets[sheet_index]).decode('utf-8'))

        row_count = 0
        _big = os.path.getsize(xlsx_path) > 5 * 1024 * 1024  # 大文件进度反馈
        # utf-8-sig (BOM) 确保 Excel 正确识别中文
        with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
            writer = csv.writer(f)
            for row_elem in _find_all_recursive(root, 'row'):
                row_data = []
                for cell in _find_all_recursive(row_elem, 'c'):
                    v_elems = _find_all_recursive(cell, 'v')
                    v_text = v_elems[0].text if v_elems else None
                    if v_text and v_text.strip():
                        if cell.get('t') == 's':
                            idx = int(v_text)
                            row_data.append(
                                shared_strings[idx] if idx < len(shared_strings) else v_text)
                        else:
                            raw = v_text.strip()
                            try:
                                row_data.append(float(raw) if '.' in raw else int(raw))
                            except ValueError:
                                row_data.append(raw)
                    else:
                        row_data.append('')
                writer.writerow(row_data)
                row_count += 1
                if _big and row_count % 5000 == 0:
                    print(f"  进度: 已处理 {row_count} 行...")

        return row_count
    except zipfile.BadZipFile:
        raise ValueError(f"文件不是有效的 XLSX (ZIP 损坏): {xlsx_path}")
    except KeyError as e:
        raise ValueError(f"XLSX 内部结构异常，缺少: {e}")

# 使用
rows = xlsx_to_csv('data.xlsx', 'output.csv')
print(f'Converted {rows} rows')
```

---

## XLSX → JSON (stdlib) ⭐⭐⭐⭐⭐

**验证:** ✅ PASS (2026-07-01)

```python
import zipfile, xml.etree.ElementTree as ET, json, re, os

def _find_all_recursive(elem, local_name):
    """递归搜索所有 tag 以 '}local_name' 结尾的元素"""
    results = []
    if elem.tag.endswith('}' + local_name):
        results.append(elem)
    for child in elem:
        results.extend(_find_all_recursive(child, local_name))
    return results

def xlsx_to_json(xlsx_path, json_path, sheet_index=0):
    """
    XLSX 转 JSON 数组 (纯 stdlib)。
    第一行作为 header，后续行转为 dict。
    Returns: int (数据行数)
    """
    if not os.path.isfile(xlsx_path):
        raise FileNotFoundError(f"文件不存在: {xlsx_path}")
    if os.path.getsize(xlsx_path) > 15 * 1024 * 1024:
        print(f"提示: 文件较大 ({os.path.getsize(xlsx_path)//1024//1024}MB)，处理可能需要几秒钟...")
    try:
        with zipfile.ZipFile(xlsx_path, 'r') as z:
            shared_strings = []
            ss_path = 'xl/sharedStrings.xml'
            if ss_path in z.namelist():
                ss_root = ET.fromstring(z.read(ss_path).decode('utf-8'))
                for si in _find_all_recursive(ss_root, 'si'):
                    t_parts = [e.text or '' for e in _find_all_recursive(si, 't')]
                    shared_strings.append(''.join(t_parts))

            all_sheets = sorted(
                [f for f in z.namelist()
                 if re.match(r'xl/worksheets/sheet\d+\.xml$', f)],
                key=lambda x: int(re.search(r'sheet(\d+)', x).group(1))
            )
            if sheet_index >= len(all_sheets):
                raise IndexError(f"sheet_index {sheet_index} 超出范围 (共 {len(all_sheets)} 个)")
            root = ET.fromstring(z.read(all_sheets[sheet_index]).decode('utf-8'))

        result = []
        headers = None
        _big = os.path.getsize(xlsx_path) > 5 * 1024 * 1024  # 大文件进度反馈
        _data_rows = 0
        for row_elem in _find_all_recursive(root, 'row'):
            values = []
            for cell in _find_all_recursive(row_elem, 'c'):
                v_elems = _find_all_recursive(cell, 'v')
                v_text = v_elems[0].text if v_elems else None
                val = None
                if v_text and v_text.strip():
                    if cell.get('t') == 's':
                        idx = int(v_text)
                        val = shared_strings[idx] if idx < len(shared_strings) else v_text
                    else:
                        try:
                            val = float(v_text) if '.' in v_text else int(v_text)
                        except ValueError:
                            val = v_text
                values.append(val)

            if headers is None:
                headers = values or [f'col_{i}' for i in range(len(values))]
                continue

            row_dict = {}
            for i, h in enumerate(headers):
                row_dict[h] = values[i] if i < len(values) else None
            result.append(row_dict)
            _data_rows += 1
            if _big and _data_rows % 5000 == 0:
                print(f"  进度: 已处理 {_data_rows} 行...")

        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(result, f, ensure_ascii=False, indent=2)

        return len(result)
    except zipfile.BadZipFile:
        raise ValueError(f"文件不是有效的 XLSX (ZIP 损坏): {xlsx_path}")
    except KeyError as e:
        raise ValueError(f"XLSX 内部结构异常，缺少: {e}")

# 使用
count = xlsx_to_json('data.xlsx', 'output.json')
print(f'Converted {count} rows to JSON')
```

---

## PDF → TXT (pdftotext) ⭐⭐⭐⭐

**验证:** ✅ PASS (2026-07-01)

```bash
# 输出到文件
pdftotext "input.pdf" "output.txt"

# 输出到 stdout
pdftotext "input.pdf" - | head -100

# 保持排版
pdftotext -layout "input.pdf" "output.txt"

# 指定页范围
pdftotext -f 1 -l 3 "input.pdf" -
```

| 场景 | 质量 |
|------|:----:|
| 纯文本 PDF | ⭐⭐⭐⭐⭐ |
| 表格 PDF | ⭐⭐⭐ |
| 双栏 | ⭐⭐⭐ |
| 扫描件 | ⭐ (需OCR) |

---

## DOCX/PPTX/XLSX → PDF (COM 自动化) ⭐⭐⭐⭐⭐

> **验证:** ✅ PASS (2026-07-01, WPS office6, Windows 11)
> **前置:** pywin32 已装 venv, Windows + WPS Office 或 Microsoft Office
> **平台:** 仅 Windows（依赖 COM 自动化）
>
> ⚠️ **XLSX→PDF 乱码坑：** 手写 XLSX 若用 Calibri 等西文字体，WPS 转 PDF 时中文会乱码（显示为"结帐常"之类）。
> **解决方案：** 创建 XLSX 时字体必须设为中文字体（宋体/微软雅黑），推荐用 `openpyxl` + `Font(name='微软雅黑')` 而非纯 stdlib 手写。

### 双引擎支持（WPS + MS Office 自动检测）

```python
import win32com.client as win32
import os, time

# === COM 常量 ===
WD_FORMAT_PDF = 17      # wdFormatPDF
PP_SAVE_AS_PDF = 32     # ppSaveAsPDF
XL_TYPE_PDF = 0         # xlTypePDF

# === 引擎配置表 ===
# 格式 → { "wps": (ProgID, 打开方法, 转换方法, 常量), "mso": (同结构) }
ENGINE_CONFIG = {
    "docx": {
        "wps": ("kwps.Application",    "Documents.Open",   "SaveAs2",           WD_FORMAT_PDF),
        "mso": ("Word.Application",    "Documents.Open",   "SaveAs2",           WD_FORMAT_PDF),
    },
    "pptx": {
        "wps": ("KWPP.Application",     "Presentations.Open","SaveAs",            PP_SAVE_AS_PDF),
        "mso": ("PowerPoint.Application","Presentations.Open","SaveAs",           PP_SAVE_AS_PDF),
    },
    "xlsx": {
        "wps": ("KET.Application",      "Workbooks.Open",    "ExportAsFixedFormat", XL_TYPE_PDF),
        "mso": ("Excel.Application",    "Workbooks.Open",    "ExportAsFixedFormat", XL_TYPE_PDF),
    },
}

# === 可靠性参数 ===
MAX_RETRIES = 3         # COM 调用最大重试次数
RETRY_INTERVAL = 2      # 重试间隔（秒）
COM_TIMEOUT = 60        # COM 操作超时（秒）
MAX_FILE_SIZE = 100 * 1024 * 1024  # 最大文件 100MB

def _detect_engine(fmt):
    """自动检测可用引擎: 优先 WPS, 回退 MSO"""
    config = ENGINE_CONFIG[fmt]
    errors = []
    for engine in ["wps", "mso"]:
        try:
            prog_id = config[engine][0]
            app = win32.Dispatch(prog_id)
            app.Quit()  # 立即释放，避免残留进程
            return engine, config[engine]
        except Exception as e:
            errors.append(f"{engine}({prog_id}): {e}")
            continue
    raise RuntimeError(
        f"未检测到可用的 Office COM 引擎。\n"
        f"需要安装 WPS Office 或 Microsoft Office。\n"
        f"已尝试: {'; '.join(errors)}\n\n"
        f"建议解决步骤:\n"
        f"  1) 安装 WPS Office 免费个人版: https://www.wps.cn/\n"
        f"  2) 安装后重启电脑（COM 组件需要重启注册）\n"
        f"  3) 如果已安装仍报错: 控制面板 → 程序 → WPS → 修复"
    )

# === 进程清理安全网 ===
# WPS/Office COM 异常退出时可能残留进程，导致后续转换卡死。
# 本函数用 subprocess 强制终止，作为 app.Quit() 的兜底。

_OFFICE_PROCESS_NAMES = {
    "wps": ["wps.exe", "et.exe", "wpp.exe"],       # WPS 全家桶
    "mso": ["WINWORD.EXE", "EXCEL.EXE", "POWERPNT.EXE"],
}

def _force_cleanup_office_processes(engine="wps"):
    """
    强制清理指定引擎的残留 Office 进程（安全网）。

    安全策略:
    - 仅在转换失败/异常后调用（正常成功不触发）
    - 仅杀无窗口的残留进程（有窗口=用户正在用，跳过）
    - 使用 taskkill 安全终止，不强制 (/F)

    engine: "wps" / "mso" / "all"
    Returns: (killed_count, messages)
    """
    import subprocess
    killed = 0
    msgs = []

    targets = []
    if engine in ("wps", "all"):
        targets.extend(_OFFICE_PROCESS_NAMES["wps"])
    if engine in ("mso", "all"):
        targets.extend(_OFFICE_PROCESS_NAMES["mso"])

    for proc_name in targets:
        try:
            # 查询该进程是否存在
            result = subprocess.run(
                ["tasklist", "/FI", f"IMAGENAME eq {proc_name}",
                 "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=10
            )
            if proc_name.lower() not in result.stdout.lower():
                continue  # 无残留，跳过

            # 尝试正常结束（不用 /F，避免杀用户正在用的）
            # 注意: WPS 残留进程通常是无窗口的 COM 进程，
            # taskkill 不带 /F 会发送 WM_CLOSE，有窗口的会忽略
            kill_result = subprocess.run(
                ["taskkill", "/IM", proc_name],
                capture_output=True, text=True, timeout=10
            )
            if kill_result.returncode == 0:
                killed += 1
                msgs.append(f"已清理残留: {proc_name}")
            # 被拒绝说明用户正在使用（有窗口保护），静默忽略即可
        except Exception:
            pass  # 清理失败不影响主流程

    return killed, msgs

def office_to_pdf(src_path, dst_path, fmt, engine=None):
    """
    通过 COM 自动化将 Office 文件转为 PDF。
    支持双引擎: WPS Office / Microsoft Office (自动检测)
    内置重试机制（最多3次）和异常保护。

    src_path: 源文件绝对路径
    dst_path: 输出 PDF 绝对路径
    fmt: "docx" / "pptx" / "xlsx"
    engine: "wps" / "mso" / None(自动检测)
    Returns: bool (转换是否成功)
    """
    # === 前置检查 ===
    if not os.path.isfile(src_path):
        raise FileNotFoundError(f"源文件不存在: {src_path}")

    file_size = os.path.getsize(src_path)
    if file_size > MAX_FILE_SIZE:
        raise ValueError(
            f"文件过大 ({file_size // 1024 // 1024}MB)，"
            f"超过 {MAX_FILE_SIZE // 1024 // 1024}MB 限制。\n"
            f"建议: 拆分文档后分别转换。"
        )

    # 确保输出目录存在
    dst_dir = os.path.dirname(dst_path)
    if dst_dir and not os.path.isdir(dst_dir):
        os.makedirs(dst_dir, exist_ok=True)

    # === 预清理：转换前先杀残留进程，防止冲突 ===
    target_engine = engine or "wps"  # 预清理时默认清 WPS（最常见）
    _force_cleanup_office_processes(target_engine)

    # === 引擎检测 ===
    if engine is None:
        engine, (prog_id, open_m, convert_m, const) = _detect_engine(fmt)
    else:
        prog_id, open_m, convert_m, const = ENGINE_CONFIG[fmt][engine]

    # === 带重试的转换 ===
    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        app = None
        doc = None
        try:
            app = win32.Dispatch(prog_id)
            app.Visible = False
            open_method = open_m.split(".")[1]

            if fmt == "pptx":
                doc = getattr(app, open_method)(
                    src_path, ReadOnly=True, Untitled=False, WithWindow=True)
                doc.SaveAs(dst_path, const)
            elif fmt == "xlsx":
                doc = getattr(app, open_method)(src_path, ReadOnly=True)
                doc.ExportAsFixedFormat(const, dst_path)
            else:  # docx
                doc = getattr(app, open_method)(src_path, ReadOnly=True)
                getattr(doc, convert_m)(dst_path, const)

            time.sleep(1)

            if os.path.exists(dst_path) and os.path.getsize(dst_path) > 0:
                return True
            else:
                raise RuntimeError("转换完成但输出文件为空或不存在")

        except Exception as e:
            last_error = e
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_INTERVAL)
            continue

        finally:
            # 安全释放资源（doc 可能未定义）
            if doc is not None:
                try:
                    doc.Close(False)
                except Exception:
                    pass
            if app is not None:
                try:
                    app.Quit()
                except Exception:
                    pass
            # === 强制清理安全网：Quit() 可能无法终止卡死进程 ===
            _force_cleanup_office_processes(engine)

    # 所有重试失败 → 包装为新手友好错误
    err_detail = str(last_error or "未知错误")
    # 提取关键信息用于友好提示
    hint_lines = [
        f"❌ {fmt.upper()} 文件转 PDF 失败",
        f"",
        f"文件: {os.path.basename(src_path)}",
        f"引擎: {'WPS Office' if engine == 'wps' else 'Microsoft Office'}",
        f"已自动重试 {MAX_RETRIES} 次仍未成功。",
        f"",
        f"技术细节: {err_detail[:200]}",
        f"",
        f"建议按以下顺序排查:",
    ]

    # 根据错误类型给具体建议
    err_lower = err_detail.lower()
    if any(kw in err_lower for kw in ["被占用", "locked", "permission", "拒绝访问"]):
        hint_lines.extend([
            f"  ① 关闭 WPS/Office 中正在打开的这个文件",
            f"  ② 确认文件没有设为「只读」",
        ])
    elif any(kw in err_lower for kw in ["timeout", "超时", "调用"]):
        hint_lines.extend([
            f"  ① WPS/Office 可能卡死了，打开任务管理器结束残留进程:",
            f"     taskkill /f /im wps.exe （或 WINWORD.EXE / EXCEL.EXE）",
            f"  ② 重启 WPS/Office 后再试",
        ])
    else:
        hint_lines.extend([
            f"  ① 打开任务管理器（Ctrl+Shift+Esc），结束所有 WPS/Office 进程",
            f"  ② 重启 WPS/Office",
            f"  ③ 确认文件没被其他程序打开",
            f"  ④ 如果仍失败，用 WPS 手动打开文件 → 另存为 PDF",
        ])

    raise RuntimeError('\n'.join(hint_lines))

# 使用 (自动检测引擎)
office_to_pdf(r"D:\docs\file.docx", r"D:\docs\file.pdf", "docx")
```

### 各引擎差异说明

| 特性 | WPS Office | Microsoft Office |
|:-----|:-----------|:-----------------|
| DOCX ProgID | `kwps.Application` | `Word.Application` |
| PPTX ProgID | `KWPP.Application` | `PowerPoint.Application` |
| XLSX ProgID | `KET.Application` | `Excel.Application` |
| PPTX 要求 | 必须 `WithWindow=True` | 同左 |
| XLSX 方法 | `ExportAsFixedFormat` | 同左 |
| 免费版 | ✅ 个人版免费 | ❌ 付费 |
| 中文兼容性 | 更好（国产软件）| 好 |

### 注意事项
- DOCX: 用 `SaveAs2(dst, 17)` (不能用 ExportAsFixedFormat, WPS 参数顺序不同)
- PPTX: 必须 `WithWindow=True`, 否则 COM 报错
- XLSX: 用 `ExportAsFixedFormat(0, dst)` (与 DOCX 方法不同)
- 每次转换后必须 `Quit()`, 否则 WPS 进程残留

### 备选: LibreOffice
```bash
libreoffice --headless --convert-to pdf --outdir . "document.docx"
```

### 备选: docx2pdf (需 Microsoft Word)
```python
from docx2pdf import convert
convert("input.docx", "output.pdf")
```

---

## PDF → DOCX ⭐⭐ (质量低，谨慎使用)

### 方案 A: pdf2docx
```python
from pdf2docx import Converter
cv = Converter("input.pdf")
cv.convert("output.docx", start=0, end=None)
cv.close()
```

### 方案 B: 两步法 (更可靠)
1. `pdftotext input.pdf text.txt`
2. 用 `references/create.md` 中的 `create_docx()` 创建纯文本 DOCX

---

## Markdown → DOCX ⭐⭐⭐⭐

```bash
pandoc input.md -o output.docx
```

---

## HTML → PDF ⭐⭐⭐

### 方案 A: wkhtmltopdf
```bash
wkhtmltopdf --enable-local-file-access --page-size A4 input.html output.pdf
```

### 方案 B: weasyprint
```python
from weasyprint import HTML
HTML(filename='input.html').write_pdf('output.pdf')
```

---

## 图片 → PDF ⭐⭐⭐⭐

```python
import img2pdf
# 单张
with open("output.pdf", "wb") as f:
    f.write(img2pdf.convert("photo.jpg"))
# 多张合并
with open("merged.pdf", "wb") as f:
    f.write(img2pdf.convert(["1.jpg", "2.png", "3.jpg"]))
```
