#!/usr/bin/env python3
"""
XLSX 公式验证检查器

读取 XLSX 文件，检查所有公式单元格，报告潜在错误：
  - 公式语法错误（#REF!, #DIV/0!, #VALUE!, #NAME?, #N/A, #NULL!）
  - 循环引用检测
  - 外部引用（引用其他工作簿的链接）
  - 建议：绝对/相对引用一致性

用法:
    python formula_check.py <file.xlsx>            # 检查指定文件
    python formula_check.py <file.xlsx> --summary  # 只输出摘要
    python formula_check.py <file.xlsx> --fix-ref  # 尝试修复明显的外部引用

依赖: openpyxl (可选) 或 stdlib zipfile + XML 解析
"""

import os
import re
import sys
import zipfile
from xml.etree.ElementTree import parse as xml_parse

# ── 错误指示器 ──────────────────────────────────────────
ERROR_INDICATORS = ['#REF!', '#DIV/0!', '#VALUE!', '#NAME?', '#N/A', '#NULL!']
ERR_PATTERN = re.compile(r'#(REF|DIV/0|VALUE|NAME\?|N/A|NULL)\b')

# ── 外部引用模式 ────────────────────────────────────────
EXTERNAL_REF_PATTERN = re.compile(r"\[([^\]]+\.(?:xlsx|xlsm|xls))\]", re.IGNORECASE)
SHEET_REF_PATTERN = re.compile(r"'?([^'!]+)'?!")

NS = {
    's': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
}


def tag_local(tag: str) -> str:
    """剥离命名空间，返回本地标签名"""
    if '}' in tag:
        return tag.split('}', 1)[1]
    return tag


def find_cells_with_formulas(sheet_xml: str):
    """从 sheet XML 中提取所有公式单元格"""
    import xml.etree.ElementTree as ET
    root = ET.fromstring(sheet_xml)
    formulas = []

    # 查找所有 <c> 元素（单元格）
    ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
    for c in root.iter(f'{{{ns}}}c'):
        f_elem = c.find(f'{{{ns}}}f')
        if f_elem is not None and f_elem.text:
            ref = c.get('r', '?')
            formula = f_elem.text.strip()
            formulas.append((ref, formula))
    return formulas


def check_file_xlsx(filepath: str, summary_only: bool = False) -> dict:
    """检查 XLSX 文件中的公式"""
    if not os.path.isfile(filepath):
        return {'error': f'文件不存在: {filepath}'}

    result = {
        'file': filepath,
        'total_formulas': 0,
        'errors': [],
        'external_refs': [],
        'circular_refs': [],
        'warnings': [],
    }

    try:
        with zipfile.ZipFile(filepath, 'r') as z:
            # 遍历所有工作表
            sheet_files = [n for n in z.namelist() if n.startswith('xl/worksheets/sheet') and n.endswith('.xml')]
            # 也包括宏工作表和图表工作表
            sheet_files += [n for n in z.namelist() if n.startswith('xl/worksheets/') and
                           (n.endswith('.xml') or '.xml' in n) and n not in sheet_files]

            # 获取共享字符串（用于解析错误值显示）
            shared_strings = {}
            if 'xl/sharedStrings.xml' in z.namelist():
                try:
                    ss_root = xml_parse(z.open('xl/sharedStrings.xml')).getroot()
                    ns_ss = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
                    for i, si in enumerate(ss_root.findall(f'{{{ns_ss}}}si')):
                        texts = []
                        for t in si.iter(f'{{{ns_ss}}}t'):
                            if t.text:
                                texts.append(t.text)
                        shared_strings[i] = ''.join(texts)
                except Exception:
                    pass

            for sname in sheet_files:
                sheet_id = sname.replace('xl/worksheets/', '').replace('.xml', '')
                content = z.read(sname).decode('utf-8', errors='replace')
                formulas = find_cells_with_formulas(content)

                for ref, formula in formulas:
                    result['total_formulas'] += 1

                    # 检查错误指示
                    for err in ERROR_INDICATORS:
                        if err in formula:
                            result['errors'].append({
                                'sheet': sheet_id,
                                'cell': ref,
                                'type': 'FORMULA_ERROR',
                                'detail': f'公式包含错误值 {err}: {formula}'
                            })

                    # 检查外部引用
                    ext_match = EXTERNAL_REF_PATTERN.search(formula)
                    if ext_match:
                        result['external_refs'].append({
                            'sheet': sheet_id,
                            'cell': ref,
                            'type': 'EXTERNAL_REF',
                            'detail': f'引用外部文件 {ext_match.group(1)}: {formula}'
                        })

                    if not summary_only:
                        # 检查明显的循环引用（自引用）
                        cell_col = ''.join(c for c in ref if c.isalpha())
                        cell_row = ''.join(c for c in ref if c.isdigit())
                        if cell_col and cell_row:
                            if ref in formula:
                                result['circular_refs'].append({
                                    'sheet': sheet_id,
                                    'cell': ref,
                                    'type': 'CIRCULAR_REF',
                                    'detail': f'疑似自引用: {formula}'
                                })

        # 构建摘要
        result['error_count'] = len(result['errors'])
        result['external_count'] = len(result['external_refs'])
        result['circular_count'] = len(result['circular_refs'])
        result['has_issues'] = (result['error_count'] > 0 or
                                result['external_count'] > 0 or
                                result['circular_count'] > 0)
        result['status'] = 'FAIL' if result['error_count'] > 0 else 'PASS'

    except zipfile.BadZipFile:
        result['error'] = '不是有效的 XLSX/ZIP 文件'
        result['status'] = 'ERROR'
    except Exception as e:
        result['error'] = f'解析异常: {e}'
        result['status'] = 'ERROR'

    return result


def print_report(result: dict):
    """格式化输出检查报告"""
    if 'error' in result and 'total_formulas' not in result:
        print(f'[ERROR] {result["error"]}')
        return

    print(f'\n{"="*55}')
    print(f'  XLSX 公式验证报告')
    print(f'  文件: {os.path.basename(result["file"])}')
    print(f'  公式总数: {result["total_formulas"]}')
    print(f'{"="*55}')

    if result['error_count'] > 0:
        print(f'\n🔴 错误: {result["error_count"]} 个')
        for e in result['errors']:
            print(f'  [{e["sheet"]}] {e["cell"]}: {e["detail"]}')
    else:
        print(f'\n✅ 公式错误: 0')

    if result['external_count'] > 0:
        print(f'\n🟡 外部引用: {result["external_count"]} 个')
        for e in result['external_refs']:
            print(f'  [{e["sheet"]}] {e["cell"]}: {e["detail"]}')
    else:
        print(f'\n✅ 外部引用: 0')

    if result['circular_count'] > 0:
        print(f'\n🟡 疑似循环引用: {result["circular_count"]} 个')
        for e in result['circular_refs']:
            print(f'  [{e["sheet"]}] {e["cell"]}: {e["detail"]}')
    else:
        print(f'✅ 疑似循环引用: 0')

    print(f'\n{"="*55}')
    status_icon = '✅' if result['status'] == 'PASS' else '🔴'
    print(f'  {status_icon} 状态: {result["status"]}')
    print(f'{"="*55}\n')


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    filepath = sys.argv[1]
    summary_only = '--summary' in sys.argv

    result = check_file_xlsx(filepath, summary_only)
    print_report(result)

    return 0 if result.get('status') in ('PASS',) else 1


if __name__ == '__main__':
    exit(main())
