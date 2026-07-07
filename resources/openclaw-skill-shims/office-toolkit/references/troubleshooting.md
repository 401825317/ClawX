# 故障排查与常见问题

> 遇到错误时先查此表，大部分问题都能快速解决。

---

## 错误码对照表

| 错误信息 | 原因 | 解决方案 |
|---------|------|---------|
| `文件不存在: xxx` | 路径错误或文件被移动 | 检查文件路径是否正确，使用绝对路径 |
| `文件不是有效的 XLSX (ZIP 损坏)` | 文件损坏或不是 Office 格式 | 重新下载或用 WPS/Office 另存为 |
| `无效的 DOCX: 缺少 word/document.xml` | 文件结构不完整 | 用 WPS/Office 打开后另存为 .docx |
| `未检测到可用的 Office COM 引擎` | 未安装 WPS 或 Microsoft Office | 安装 WPS Office（免费）或 Microsoft Office |
| `转换失败（已重试 3 次）` | 文件被占用/Office 异常/文件过大 | 见下方"转换失败"详细排查 |
| `文件过大 (XXMB)，超过 100MB 限制` | 超过 COM 转换上限 | 拆分文档后分别转换 |
| `XLSX 模板骨架不存在` | skill 安装不完整 | 重新安装 office-toolkit skill |
| `PPTX 创建失败` | python-pptx 未安装或数据格式错误 | 在 UClaw 中用 `uv run --with python-pptx==1.0.2 python <script>` 重试 |

---

## 常见问题

### Q1: 转 PDF 时报"未检测到可用的 Office COM 引擎"

**原因：** 系统未安装 WPS Office 或 Microsoft Office。

**解决：**
1. 安装 [WPS Office](https://www.wps.cn/)（免费个人版即可）
2. 安装后重启电脑，确保 COM 组件注册
3. 如果已安装仍报错，尝试修复安装（控制面板 → 程序 → 修复）

---

### Q2: 转 PDF 时报"转换失败（已重试 3 次）"

**排查步骤：**

| 步骤 | 检查项 | 处置 |
|:----:|--------|------|
| 1 | 文件是否被其他程序占用 | 关闭 WPS/Office 中已打开的该文件 |
| 2 | WPS/Office 进程是否残留 | 任务管理器结束 `wps.exe` / `WINWORD.EXE` 进程 |
| 3 | 文件路径是否含特殊字符 | 避免路径中含 `#` `&` `%` 等字符 |
| 4 | 磁盘空间是否充足 | 输出目录至少需要 文件大小 × 2 的空间 |
| 5 | 文件是否过大 | 超过 100MB 建议拆分 |

---

### Q3: 读取 XLSX 时数据不完整

**可能原因：**
- 文件有多个工作表，只读了第一个（`sheet_index=0`）
- 单元格包含公式但无缓存值（公式结果需要 Excel 计算）

**解决：**
```python
# 指定工作表索引
data = read_xlsx('file.xlsx', sheet_index=1)  # 读第二个工作表

# 如果公式结果为空，先用 WPS/Excel 打开保存一次（触发计算）
```

---

### Q4: 创建的 XLSX 在 WPS 中打开乱码

**原因：** 字体未设为中文字体。

**解决：**
- 使用 `openpyxl` 创建时：`Font(name='微软雅黑')`
- stdlib 手写时：必须在 styles.xml 中设置 `宋体` + `charset val="134"`
- 本 skill 的模板骨架已预设中文字体，使用 `create_xlsx()` 不会有此问题

---

### Q5: PDF 读取输出为空

**可能原因：**
- 扫描件 PDF（纯图片，无文字层）→ 需 OCR
- 加密 PDF → 需先解密

**排查：**
```bash
pdftotext file.pdf - | wc -c   # 如果输出 0，说明无文字层
```

---

### Q6: COM 转换后 WPS 进程残留

**原因：** 转换异常退出时未正确关闭。

**自动清理 (v1.3.5+):**
本 skill 已内置三层进程防护：
1. **转换前预清理**: 每次转换前自动检查并清理残留进程
2. **正常释放**: `finally` 块中调用 `doc.Close()` + `app.Quit()`
3. **强制安全网**: `Quit()` 后再用 `taskkill` 兜底杀残留

正常情况下无需手动干预。

**手动清理（如果自动清理仍未解决）:**
```bash
taskkill /f /im wps.exe
taskkill /f /im et.exe
taskkill /f /im wpp.exe
```

> 如频繁出现残留，建议: 控制面板 → WPS Office → 修复安装。

---

### Q7: 大文件处理慢或卡住

**预期性能：**

| 格式 | 舒适范围 | 极限边界 | 建议 |
|:----:|:--------|:--------|:-----|
| PDF | 500MB+ | ~2GB | pdftotext 是 C 程序，几乎无上限 |
| DOCX | ~10MB | ~30MB | 超 10MB 建议拆分 |
| XLSX | ~5MB / ~2万行 | ~15MB / ~6.5万行 | 超大数据建议 openpyxl read_only 模式 |
| PPTX | ~50MB / ~200页 | ~100MB | 每 slide XML 较小，整体可控 |
| COM转换 | ~50MB | ~100MB | COM 调用有超时限制 |

> 超过极限边界时，本 skill 会输出友好提示而非直接崩溃。

---

## 环境检查清单

遇到问题时，依次确认：

1. **Python 版本**: `python --version`（需 3.11+）
2. **pywin32**: `python -c "import win32com"`（COM 转换需要）
3. **python-pptx**: `uv run python -c "import pptx"`（PPTX 创建/编辑需要）
4. **openpyxl**: `uv run python -c "import openpyxl"`（XLSX 创建推荐）
5. **python-docx**: `uv run python -c "import docx"`（DOCX 创建/编辑需要）
5. **WPS/Office**: 打开 WPS 或 Word，确认能正常使用
6. **pdftotext**: `pdftotext -v`（PDF 读取需要，Git Bash 内置）
