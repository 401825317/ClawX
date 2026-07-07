---
name: spreadsheet-maker
description: 快速生成本地 XLSX 表格，优先用于中文或英文的 Excel、XLSX、表格、电子表格类请求。
metadata: { "openclaw": { "emoji": "📊" } }
---

# 表格快速生成

当用户要求创建、制作、导出，或把内容整理成 Excel、XLSX、表格、电子表格时，使用这个 skill。

## 规则

- 面向用户的进度、解释和最终回复必须使用简体中文，除非用户明确要求其他语言。
- 优先调用 `create_xlsx_file` 生成真实 `.xlsx` 文件。
- 不要只输出 Markdown 表格或制作计划来代替文件。
- 第一行通常作为表头，除非用户明确给了不同结构。
- 多主题数据优先拆成多个 sheet。
- 输出文件名必须避免覆盖，使用时间戳或短随机后缀。
- 只有确认 `.xlsx` 文件已经存在并拿到路径后，才能结束任务。
- 最终回复用 `MEDIA:<absolute-path-to-xlsx>` 或绝对 `.xlsx` 路径输出文件，让 UClaw 能显示产物卡片。

## 流程

1. 根据用户请求整理表头、行数据和 sheet 名。
2. 调用 `create_xlsx_file`。
3. 检查工具返回的 `ok`、`filePath` 和 `fileSize`。
4. 用中文简短回复，并附上 `MEDIA:/path/to/workbook.xlsx`。
