---
name: document-maker
description: 快速生成本地 DOCX 文档，优先用于中文或英文的 Word、DOCX、文档、报告类请求。
metadata: { "openclaw": { "emoji": "📄" } }
---

# 文档快速生成

当用户要求创建、制作、导出，或把内容整理成 Word、DOCX、文档、报告时，使用这个 skill。

## 规则

- 面向用户的进度、解释和最终回复必须使用简体中文，除非用户明确要求其他语言。
- 优先调用 `create_docx_file` 生成真实 `.docx` 文件。
- 不要只输出正文、Markdown 或制作计划来代替文件。
- 输出文件名必须避免覆盖，使用时间戳或短随机后缀。
- 只有确认 `.docx` 文件已经存在并拿到路径后，才能结束任务。
- 最终回复用 `MEDIA:<absolute-path-to-docx>` 或绝对 `.docx` 路径输出文件，让 UClaw 能显示产物卡片。

## 流程

1. 根据用户请求整理文档标题、章节、正文段落和要点。
2. 调用 `create_docx_file`。
3. 检查工具返回的 `ok`、`filePath` 和 `fileSize`。
4. 用中文简短回复，并附上 `MEDIA:/path/to/document.docx`。
