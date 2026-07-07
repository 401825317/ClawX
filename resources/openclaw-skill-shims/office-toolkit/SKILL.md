---
name: office-toolkit
slug: office-toolkit-ela
displayName: Office Toolkit
version: 1.4.5
description: "Office 文件读写创建转换工具箱。支持 PDF/DOCX/PPTX/XLSX 的读取、创建和格式转换（→PDF/→CSV/→JSON）。XLSX 创建支持公式(SUM/AVERAGE/IF等)+13种财务色系风格位(蓝输入/黑公式/绿跨表)。读取零依赖，转换支持 WPS Office 和 Microsoft Office 双引擎。当用户需要读取/打开/查看/创建/写入/编辑/转换/导出 .pdf/.docx/.pptx/.xlsx 文件时触发。"
license: MIT
visibility: public
metadata:
  requires:
    bins:
      - python3
    optionalBins:
      - pdftotext
    pipDeps:
      - python-pptx==1.0.2
      - openpyxl==3.1.5
      - python-docx==1.2.0
      - pywin32==312
    platforms:
      - windows
    notes: "读取功能跨平台(Python stdlib)；Office→PDF 转换仅限 Windows + WPS/MS Office"
---

# Office Toolkit — Office 文件工具箱

> v1.4.5 | 读取·创建·转换 | 三管道路由 | 验证: 2026-07-07

---

## 定位声明

> Office Toolkit 是**离线批处理工具箱**，专注「文件进、文件出」的批量读写 / 创建 / 转换。
> - ✅ 覆盖 PDF（读取 / 抽取）
> - ✅ 跨平台：读取功能仅需 Python，macOS / Linux 可运行
> - ✅ 零外部服务依赖：纯 Python，无需常驻任何编辑器进程
> - ✅ 批处理 / 自动化：适合「把 N 个文件批量转换 / 抽取」的脚本活
> - ❌ 不做实时协作编辑：不打开你正看的文档做所见即所得修改
> - ❌ 不接入在线文档：不直接读写云端协作文档
>
> 与「实时编辑类 Office skill」互补不重叠：本工具解决**离线、批量、无依赖**；实时编辑类解决**你正在看的某文档要改某句话**的交互场景。

## 平台兼容性

| 功能 | Windows + WPS/MSO | macOS / Linux |
|:----:|:-----------------:|:------------:|
| 读取 PDF/DOCX/PPTX/XLSX | ✅ | ✅（仅需 Python） |
| 创建 DOCX/XLSX（纯文本）| ✅ | ✅（stdlib） |
| 创建 PPTX | ✅ python-pptx | ✅ python-pptx |
| 转换 →PDF（COM 自动化）| ✅ | ❌ |
| 转换 XLSX→CSV/JSON | ✅ | ✅（stdlib） |

> Office→PDF 转换依赖 Windows COM 自动化，需要 WPS Office 或 Microsoft Office。

---

## 路由表 — 三管道模式

| 管道 | 用户意图 | 触发词 | 加载 |
|------|---------|--------|------|
| **READ** 读取 | 打开/查看/阅读 PDF/DOCX/PPTX/XLSX | "打开""看看""读取""查看" | `references/read.md` |
| **CREATE** 创建 | 新建/生成/写出 DOCX/XLSX/PPTX | "新建""创建""生成""做一个" | `references/create.md` |
| **CONVERT** 转换 | 格式转换 →PDF/→CSV/→JSON/→TXT | "转换""导出""另存为""转PDF" | `references/convert.md` |

**加载规则：** 只读取用户当前任务对应的参考文件，不要全部加载。一次只走一个管道。

> **遇到错误？** 加载 `references/troubleshooting.md` 查看错误码对照表和常见问题解答。
> **想避开常见坑？** 加载 `references/anti-patterns.md` 查看「不该怎么做」的反模式清单。
> **第一次用？** 加载 `references/workflow.md` 查看 3 个完整端到端流程演示。

## 什么时候用本工具？

> 用大白话告诉你：**遇到下面这些情况，就交给 Office Toolkit**。

| 你想说… | 本工具能做什么 | 一句话说明 |
|---------|:------------|----------|
| "老板发了 10 个 Excel，全转成 PDF 交差" | 批量 XLSX→PDF | 循环调用 `office_to_pdf()`，自动重试+清理 |
| "这个 PDF 里的表格，把数据抽出来" | PDF→结构化数据 | `read_pdf()` 提取文字，`pdf_to_markdown()` 保表格 |
| "帮我做张成绩表/报价单，要公式那种" | 从零创建 XLSX | `create_xlsx()` + 公式单元格，13 种财务样式 |
| "这个 Word 文档转 PDF 发给客户" | DOCX→PDF | COM 自动化，WPS 或 MSO 都行 |
| "Excel 有 3 个 Sheet，都要读" | 多 Sheet 读取 | `read_xlsx(path, sheet_index='all')` |
| "把 Excel 导出成 CSV 给别的系统用" | XLSX→CSV/JSON | 纯 stdlib，不依赖 Office |
| "从零生成一份 PPT 汇报文稿" | 创建 PPTX | `create_pptx()` + python-pptx |
| "把这个 PPT 变漂亮一点" | 编辑/美化已有 PPTX | 读取原文件 → python-pptx 生成不覆盖的新版本 |
| "文件打不开 / 转换报错 / 进程卡死" | 排查问题 | 先看 `troubleshooting.md`，再查 `anti-patterns.md` |

> **什么时候不用本工具？**
> - 要改正在看的文档里某句话 → 用「实时编辑类 skill」（本机实时协作编辑类工具）
> - 要读写腾讯文档/金山文档 → 用对应云文档 skill
> - 要做在线协作 → 本工具是离线批处理，不做实时协作

## 能力矩阵

| 格式 | 读取 | 创建(stdlib) | 创建(库) | 公式 | 样式 | 转换出 |
|:----:|:----:|:----------:|:-------:|:---:|:---:|:-----:|
| PDF | ✅ pdftotext | ❌ | reportlab/fpdf2 | — | — | →TXT/→DOCX |
| DOCX | ✅ unzip+XML | ✅ WPS验证 | python-docx | — | — | →PDF ✅COM(WPS+MSO) |
| PPTX | ✅ unzip+XML | ❌ 结构复杂 | python-pptx | — | ✅ | →PDF ✅COM(WPS+MSO) |
| XLSX | ✅ unzip+XML | ✅ WPS验证 | openpyxl | ✅ SUM/AVG/IF等 | ✅ 13位财务色系 | →CSV/→JSON/→PDF ✅COM(WPS+MSO) |

## 环境依赖

### 基础（零额外安装）
- Python 3.11+（`zipfile`、`xml.etree.ElementTree`、`subprocess`、`json`、`csv`）
- `pdftotext`（Git Bash / MSYS2 内置）
- **支持：** PDF读取、DOCX/XLSX/PPTX读取、DOCX/XLSX基础创建、XLSX→CSV/JSON

### 可选 pip 安装
| 库 | 用途 | 安装命令 |
|:---|:-----|:---------|
| `python-pptx` | PPTX 创建/编辑 | `uv run --with python-pptx==1.0.2 python <script>` |
| `openpyxl` | XLSX 创建（推荐） | `uv run --with openpyxl==3.1.5 python <script>` |
| `python-docx` | DOCX 创建/编辑 | `uv run --with python-docx==1.2.0 python <script>` |
| `pywin32` | COM 自动化转 PDF（仅 Windows） | `uv run --with pywin32==312 python <script>` |

> UClaw normally prepares these Office Python dependencies in its managed Office environment. If `uv run python` reports `ModuleNotFoundError` for `pptx`, `openpyxl`, or `docx`, retry the same script once with explicit `uv run --with ...` dependencies instead of ending the task.

### 系统软件（仅 PDF 转换需要）
- WPS Office（免费个人版）或 Microsoft Office 2016+
- WPS ProgID: `kwps.Application` / `KWPP.Application` / `KET.Application`
- MSO ProgID: `Word.Application` / `PowerPoint.Application` / `Excel.Application`
- 代码自动检测，优先 WPS → 回退 MSO

**关键发现:**
- Python 3.13 `ET.iter('{ns}tag')` 不稳定 → 用 `_find_all_recursive(tag.endswith)` 替代
- XLSX stdlib 手写必须设中文字体(宋体/微软雅黑) + charset=134，否则 WPS 转 PDF 乱码

**其他可选库:** reportlab(PDF创建), docx2pdf(DOCX→PDF), pdf2docx(PDF→DOCX)

## 关键技术警告

> **Python 3.13+ ElementTree 命名空间 Bug (已验证)**
>
> `ElementTree.iter('{namespace}tag')` 在 Python 3.13+ 对 OOXML 命名空间处理不稳定，
> 可能返回空结果。**所有 XML 解析必须使用 `tag.endswith('}localname')` 方式匹配。**
>
> 正确写法:
> ```python
> for elem in root.iter():
>     if elem.tag.endswith('}row'):
>         ...
> ```
> 错误写法:
> ```python
> for elem in root.iter(f'{NS}row'):  # 可能返回空!
>     ...
> ```

## 测试记录

| ID | 测试项 | 结果 | 日期 |
|:---:|--------|:----:|:----:|
| T01-T04 | 4格式读取 (PDF/DOCX/PPTX/XLSX) | ✅ PASS | 2026-07-01 |
| T05-T06 | DOCX/XLSX 创建 (stdlib) | ✅ WPS打开正常 | 2026-07-01 |
| T07 | PPTX 创建 (python-pptx) | ✅ WPS打开正常 | 2026-07-01 |
| C01-C03 | XLSX→CSV, XLSX→JSON, PDF→TXT | ✅ PASS | 2026-07-01 |
| C04-C06 | DOCX→PDF, PPTX→PDF, XLSX→PDF (WPS COM) | ✅ PASS (硬编码 WPS) | 2026-07-01 |
| C07 | COM 双引擎自动检测 (`_detect_engine()`) | ⏭ SKIP (本机无 MS Office，待有 MSO 环境验证) | — |

> ⚠️ C04-C06 使用 `win32.Dispatch('kwps.Application')` 硬编码路径通过验证。
> `_detect_engine()` WPS 路径逻辑与硬编码等价（已验证），MSO 回退路径**未经实测**。

## 已知限制

- DOCX/XLSX stdlib 创建仅支持纯文本/数值，无样式表格图片
- PPTX 创建必须用 python-pptx（WPS 要求 47 个内部文件，stdlib 不可行）
- PDF→DOCX 转换质量低，建议两步法: pdftotext + create_docx
- PDF 扫描件无法提取文字，需 OCR
- Office→PDF 转换仅限 Windows + WPS/MS Office
- XLSX 中文字体：stdlib 手写必须设 `宋体`/`微软雅黑` + `charset=134`（推荐 openpyxl 避坑）

## 性能预期（文档大小承载）

基于 stdlib（zipfile + ElementTree 全量解析）的预测：

| 格式 | 舒适范围 | 极限边界 | 瓶颈 |
|:----:|:--------|:--------|:-----|
| PDF | 500MB+ | ~2GB | pdftotext 是 C 程序，几乎无上限 |
| DOCX | ~10MB | ~30MB | ElementTree 内存 ≈ XML ×5-10 |
| XLSX | ~5MB / ~2万行 | ~15MB / ~6.5万行 | 超 2 万行建议 openpyxl read_only |
| PPTX | ~50MB / ~200页 | ~100MB | 每 slide XML 较小，整体可控 |
| COM转换 | 取决于 Office | ~100MB+ | 瓶颈在 COM 调用超时 |

> ElementTree 是全量解析（非流式），内存开销约为原始 XML 的 5-10 倍。
> 日常文档（报告/表格/PPT）完全够用；超大 XLSX 建议切换 openpyxl 流式模式。

## 变更记录

| 版本 | 日期 | 变更 |
|:----:|:----:|------|
| 1.4.5 | 2026-07-07 | **合并 1.3.5 本地修复 + 功能与稳定性升级**：① 修复 XLSX 模板骨架两处缺陷（OOXML 关系文件缺失导致生成文件打不开；styles.xml 注释导致 openpyxl 反序列化失败）；② 运行稳定性：新增 Office/WPS 进程残留三层防护（转换前预清理 + 正常释放 + 强制兜底），解决转换后进程卡死需手动结束的问题；③ 异常处理：COM 转换错误包装为中文新手友好提示，按错误类型给出针对性解决建议；④ 新增反模式提醒文档 `references/anti-patterns.md`（常见错误用法与避坑清单）；⑤ XLSX 多工作表支持：`read_xlsx()` 支持 `sheet_index='all'` + `list_sheets()`，`create_xlsx()` 支持多工作表（`sheets=[(name,data),...]` 且兼容单表），动态同步 [Content_Types]/workbook.xml.rels/workbook.xml，支持跨表公式引用；⑥ XLSX→CSV/JSON 大文件（>5MB）转换增加逐 5000 行进度反馈；⑦ 新增完整端到端工作流演示 `references/workflow.md` 与通俗触发场景说明，降低上手门槛。端到端验证（openpyxl 打开多 Sheet XLSX + 跨表公式引用）通过 |
| 1.3.5 | 2026-07-07 | （已合并入 1.4.5，未单独发布）修复 XLSX 模板骨架两处缺陷：(1) `_rels/.rels` 与 `xl/_rels/workbook.xml.rels` 误命名 `.rels.txt` → 标准 `.rels`；(2) `styles.xml` 的 `<fills>` XML 注释致 openpyxl 反序列化失败 → 移除 |
| 1.3.4 | 2026-07-07 | 供应链安全整改：锁定三可选依赖版本号（python-pptx==1.0.2 / openpyxl==3.1.5 / pywin32==312），修复 SkillHub 安全审计「供应链风险⚠️」；pywin32==312 已在 managed Python 3.13 实测可用 |
| 1.3.3 | 2026-07-07 | 合规与定位优化：移除公开发布文件中对外部参考来源的点名（保留通用写法），新增「定位声明」段明确离线批处理/含PDF/跨平台/零外部依赖/不做实时协作编辑的边界 |
| 1.3.2 | 2026-07-04 | 提升稳定性：大文件处理增加异常保护和重试机制，错误提示更友好，新增常见问题解答 |
| 1.3.1 | 2026-07-04 | 优化发布包，移除无关开发文件，安装更轻量 |
| 1.3.0 | 2026-07-02 | P0 功能升级：XLSX 模板骨架(`templates/minimal_xlsx/`)、公式支持(SUM/AVERAGE/IF等)、13位财务色系(蓝输入/黑公式/绿跨表)、三管道路由升级(READ/CREATE/CONVERT)、版本一致性校验(`scripts/version_check.py`) |
| 1.2.1 | 2026-07-01 | edit_utils.py 独立模块；修复 ws.cell(value=None) bug；edit.md 精简 53% |

## P1 升级待办 (v1.3.0+)

| # | 项目 | 优先级 | 状态 |
|:--|:--|:--:|:--:|
| 1 | XLSX 编辑已有文件: 解包XML→编辑→重新打包(不损坏原格式) | 🟡 | 待做 |
| 2 | XLSX 行/列插入删除脚本 | 🟡 | 待做 |
| 3 | DOCX 排版规范: 字号dxa换算、outlineLevel、GB/T 9704公文 | 🟡 | 待做 |
| 4 | DOCX 模板骨架(同XLSX思路: 复制骨架+填充内容) | 🟡 | 待做 |
| 5 | formula_check.py: 验证输出XLSX公式无错误 | 🟢 | ✅ v1.4.5 |
| 6 | 多Sheet XLSX 支持(模板+[Content_Types]同步) | 🟢 | ✅ v1.4.5 |
