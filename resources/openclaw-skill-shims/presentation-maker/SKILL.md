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
- 优先使用内置本地生成器：`node {baseDir}/scripts/make-pptx.mjs --input <deck.json> --out <deck.pptx>`。
- 默认按“可直接给客户看的演示稿”生成：封面、章节感、卡片式要点、短标题、少字高密度表达；不要把长段落原样塞进幻灯片。
- 如果 `create_pptx_file` 工具可用，优先直接调用该工具；用户说“做完打开/生成后打开”时设置 `openAfterCreate: true`，不要再额外调用 `exec open`。
- 输出文件名必须避免覆盖，使用时间戳或短随机后缀。
- 只有确认 `.pptx` 文件已经存在并拿到路径后，才能结束任务。
- 最终回复用 `MEDIA:<absolute-path-to-pptx>` 或绝对 `.pptx` 路径输出文件，让 UClaw 能显示产物卡片。

## Input JSON

先创建一个临时 JSON 文件，结构如下：

```json
{
  "title": "项目复盘",
  "subtitle": "2026-07-07",
  "slides": [
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

`slides[].bullets` 使用字符串数组。每页建议 3-5 条要点，每条尽量 10-24 个汉字；如果用户材料很密，拆成更多页，不要把一页塞满。

## 流程

1. 根据用户请求整理幻灯片大纲。
2. 把 JSON 大纲保存到临时目录或当前工作区。
3. 运行生成器：

```bash
node {baseDir}/scripts/make-pptx.mjs --input /path/to/deck.json --out /path/to/deck-20260707-1530.pptx
```

4. 验证输出文件存在。
5. 用中文简短回复，并附上 `MEDIA:/path/to/deck.pptx`。

如果用户要高度设计化的 PPT，也先用这条快路径生成一个有效 `.pptx`；当前默认模板已经包含专业封面、卡片布局和统一配色，后续再按用户反馈做可选美化迭代。
