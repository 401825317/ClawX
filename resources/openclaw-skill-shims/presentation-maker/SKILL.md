---
name: presentation-maker
description: 快速生成本地 PPTX 文件，优先用于中文或英文的 PPT/演示文稿请求，不需要 Python 初始化。
metadata: { "openclaw": { "emoji": "📊", "requires": { "bins": ["node"] } } }
---

# PPT 快速生成

当用户要求创建、制作、导出，或把内容整理成 PPT、PPTX、presentation、slide deck、演示文稿、幻灯片时，使用这个 skill。

## 规则

- 面向用户的进度、解释和最终回复必须使用简体中文，除非用户明确要求其他语言。
- 普通 PPT 生成不要安装 Python 包，也不要调用 `uv`。
- 如果 `create_pptx_file` 工具可用，优先直接调用该工具；用户说“做完打开/生成后打开”时设置 `openAfterCreate: true`，不要再额外调用 `exec open`。
- 工具不可用时才使用本地生成器：`node {baseDir}/scripts/make-pptx.mjs --input <deck.json> --out <deck.pptx>`。
- 先根据主题、受众和用途选择结构化主题族，不随机换色：产品发布用 `product-launch`，旅行目的地用 `travel-editorial`，老板/经营汇报用 `executive-report`，培训课件用 `training-workshop`，其他叙事用 `creative-editorial`。
- 默认按“可直接给客户看的演示稿”生成：封面、章节感、语义版式、短标题、少字高密度表达；不要把长段落原样塞进幻灯片，也不要把所有正文页做成同一组卡片。
- 输出文件名必须避免覆盖，使用时间戳或短随机后缀。
- 只有确认 `.pptx` 文件已经存在并拿到路径后，才能结束任务。
- 最终回复用 `MEDIA:<absolute-path-to-pptx>` 或绝对 `.pptx` 路径输出文件，让 UClaw 能显示产物卡片。

## Input JSON

先创建一个临时 JSON 文件，结构如下：

```json
{
  "title": "项目复盘",
  "subtitle": "2026-07-07",
  "presentationDesign": {
    "themeFamily": "executive-report",
    "audience": "管理层",
    "purpose": "经营复盘与决策",
    "visualTone": "克制、数据驱动",
    "density": "balanced"
  },
  "slides": [
    {
      "title": "项目复盘",
      "subtitle": "2026-07-07"
    },
    {
      "title": "核心结论",
      "bullets": ["结论一", "结论二", "下一步"]
    },
    {
      "title": "风险与建议",
      "bullets": ["风险一：...", "建议：..."]
    }
  ],
  "footer": "UClaw"
}
```

`slides[0]` 是封面，也计入用户要求的总页数；`slides[].bullets` 使用字符串数组。每页建议 3-5 条要点，每条尽量 10-24 个汉字；如果用户材料很密，拆成更多页，不要把一页塞满。

## 流程

1. 根据用户请求整理幻灯片大纲。
2. 把 JSON 大纲保存到临时目录或当前工作区。
3. 运行生成器：

```bash
node {baseDir}/scripts/make-pptx.mjs --input /path/to/deck.json --out /path/to/deck-20260707-1530.pptx
```

4. 验证输出文件存在。
5. 用中文简短回复，并附上 `MEDIA:/path/to/deck.pptx`。

如果用户要高度设计化的 PPT，仍需先输出完整设计规格和逐页内容计划，再生成有效 `.pptx`。不要用“先套统一模板、后续再美化”代替当前任务要求。
