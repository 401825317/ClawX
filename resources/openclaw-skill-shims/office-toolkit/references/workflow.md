# 完整使用流程演示

> 本文件提供 **3 个端到端工作流**，从"用户需求"到"最终产出"，每一步精确到加载哪个参考文件、调用哪个函数、传什么参数。
> 适合第一次使用本工具时通读一遍，建立完整认知。

---

## 流程一：PDF 提取表格 → 生成汇总 XLSX

> **场景：** 老板发了一份 PDF 业绩报告，你想把里面的数据表抽出来做成 Excel 方便后续计算。

### 第 1 步：确认需求

```
输入：业绩报告.pdf（含多个表格）
输出：汇总.xlsx（提取的数据 + 新增合计列）
```

### 第 2 步：读取 PDF

加载 `references/read.md`，调用：

```python
from references.read import read_pdf, pdf_to_markdown

# 先看 PDF 里有什么（纯文本预览，不丢信息）
text = read_pdf('业绩报告.pdf')
print(text[:2000])  # 先打印前 2000 字确认内容

# 如果有表格，用 markdown 模式保留表格结构
md = pdf_to_markdown('业绩报告.pdf')
print(md)  # 表格会以 | 列1 | 列2 | 格式保留
```

**预期结果：** 终端输出 PDF 文字内容，表格以 Markdown 形式可见。

### 第 3 步：解析数据

```python
# 手动或用简单逻辑把 markdown 表格转为二维数组
# 假设 pdf_to_markdown 返回的表格长这样：
# | 区域 | Q1销售额 | Q2销售额 |
# | 华东 | 100      | 120      |
# | 华北 | 80       | 95       |

data = [
    ['区域', 'Q1销售额', 'Q2销售额', '上半年合计'],  # 表头
    ['华东', 100, 120, None],   # 合计列先留空
    ['华北', 80, 95, None],
]
```

### 第 4 步：创建带公式的 XLSX

加载 `references/create.md`，调用：

```python
from references.create import create_xlsx

# 给每行加上 SUM 公式
for i, row in enumerate(data[1:], start=2):  # 从第2行开始（跳过表头）
    row[3] = {'formula': f'SUM(B{i}:C{i})', 'style': 2}  # style=2 黄色高亮

create_xlsx(
    '汇总.xlsx',
    data,
    sheet_name='业绩汇总',
    freeze_row=1,          # 冻结表头
    col_widths={1: 10, 2: 12, 3: 12, 4: 14}
)
```

**预期结果：** 当前目录生成 `汇总.xlsx`，打开后：
- D2 = B2+C2 (220), D3 = B3+C3 (175)
- 表头行冻结滚动
- 合计列黄色高亮

### 第 5 步：验证

加载 `scripts/formula_check.py` 运行：

```bash
python scripts/formula_check.py 汇总.xlsx
```

---

## 流程二：批量 Word 转 PDF

> **场景：** 合同文件夹里有 15 个 .docx 合同，全部要转成 PDF 发给客户。

### 第 1 步：确认环境

```python
# 确认 WPS/Office 已安装且 COM 可用
# （convert.md 的 _detect_engine() 会自动检测）
```

**前置条件：**
- Windows 系统
- 已安装 WPS Office 或 Microsoft Office
- 所有 .docx 文件**未被任何程序打开**

### 第 2 步：批量转换

加载 `references/convert.md`，调用：

```python
import os, glob, time
from references.convert import office_to_pdf

src_dir = 'D:\\合同\\'
dst_dir = 'D:\\合同_PDF\\'
os.makedirs(dst_dir, exist_ok=True)

files = sorted(glob.glob(os.path.join(src_dir, '*.docx')))
print(f'找到 {len(files)} 个文件')

# 分批处理：每批 ≤10 个
batch_size = 10
for batch_start in range(0, len(files), batch_size):
    batch = files[batch_start:batch_start + batch_size]
    print(f'\n--- 处理第 {batch_start//batch_size + 1} 批 ({len(batch)} 个) ---')

    for f in batch:
        name = os.path.splitext(os.path.basename(f))[0]
        out = os.path.join(dst_dir, f'{name}.pdf')
        try:
            ok = office_to_pdf(f, out, 'docx')
            print(f'  ✅ {name}.pdf')
        except Exception as e:
            print(f'  ❌ {name} 失败: {e}')

    # 批间等待，让 WPS 进程完全释放
    if batch_start + batch_size < len(files):
        print('  ⏳ 等待 5 秒...')
        time.sleep(5)

print('\n完成！检查 dst_dir 目录。')
```

**预期结果：** `D:\合同_PDF\` 下生成对应数量的 `.pdf` 文件。
失败的单个文件不影响其余文件（每个独立 try-except）。

### 第 3 步：如果遇到问题

1. **某个文件转不出来？** → 检查是否被 WPS 打开着 → 关闭后重试该文件
2. **WPS 卡死了？** → v1.4+ 内置自动清理安全网；如仍卡 → 手动结束 wps.exe 进程
3. **报"找不到引擎"？** → 安装 WPS Office 免费个人版

详见 `references/troubleshooting.md` 和 `references/anti-patterns.md`。

---

## 流程三：读取 Excel → 计算新列 → 写出新 Excel

> **场景：** 你有一个「原始成绩.xlsx」（别人给的），需要加一列"总分"和一列"等级"，存为新文件。

### 第 1 步：读取原始文件

加载 `references/read.md`，调用：

```python
from references.read import read_xlsx, list_sheets

# 先看看有几个 Sheet
sheets = list_sheets('原始成绩.xlsx')
print(f'Sheet 列表: {sheets}')

# 读取第一个 Sheet 的全部数据
data = read_xlsx('原始成绩.xlsx', sheet_index=0)
print(f'共 {len(data)} 行, 每行 {len(data[0]) if data else 0} 列')
print('前3行:', data[:3])
```

**示例输出：**
```
Sheet 列表: ['Sheet1']
共 31 行, 每行 4 列
前3行: [['姓名', '语文', '数学', '英语'], ['张三', 85, 92, 78], ['李四', 76, 88, 90]]
```

### 第 2 步：在内存中计算新列

```python
# 构建新数据（追加"总分"和"等级"两列）
new_data = []

for r_idx, row in enumerate(data):
    if r_idx == 0:  # 表头行
        new_data.append(row + ['总分', '等级'])
        continue

    name = row[0]         # 姓名
    scores = row[1:4]     # 语文、数学、英语

    # 计算总分
    total = sum(s for s in scores if isinstance(s, (int, float)))

    # 判定等级
    if total >= 270:
        grade = 'A'
    elif total >= 240:
        grade = 'B'
    elif total >= 210:
        grade = 'C'
    else:
        grade = 'D'

    new_data.append(row + [total, grade])

# 看一眼结果
for row in new_data[:4]:
    print(row)
```

### 第 3 步：写出新 XLSX

加载 `references/create.md`，调用：

```python
from references.create import create_xlsx

create_xlsx(
    '成绩带等级.xlsx',
    new_data,
    sheet_name='成绩单',
    col_widths={1: 8, 2: 6, 3: 6, 4: 6, 5: 8, 6: 6},
)
```

**关键点：** 输出路径 `成绩带等级.xlsx` ≠ 输入路径 `原始成绩.xlsx`。绝不覆盖原文件。

### 第 4 步：验证新文件

```python
# 读回验证
verify = read_xlsx('成绩带等级.xlsx')
print(f'验证: 共 {len(verify)} 行, 列数: {len(verify[0])}')
print('末3行:', verify[-3:])
```

---

## 三条流程总结

| 流程 | 用到的管道 | 核心函数链 | 典型耗时 |
|------|----------|-----------|---------|
| PDF→XLSX | READ → CREATE | `read_pdf()` → 解析 → `create_xlsx()` | 读取秒级，创建秒级 |
| 批量DOCX→PDF | CONVERT | 循环 `office_to_pdf()` | 每个 2~5 秒 |
| 读Excel→写Excel | READ → 计算 → CREATE | `read_xlsx()` → 内存处理 → `create_xlsx()` | 全部秒级 |

> **通用原则：** 一次只走一个管道。先完成读取，再做计算，最后创建——不要混在一起。
