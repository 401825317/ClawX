# Studio tool schema

`create_designed_pptx_file` renders a 16:9 free canvas. All `x`, `y`, `w`, and `h` values are percentages from `0` to `100`; every element must stay inside the canvas. Colors are six-digit hex strings without `#`.

Top-level fields:

```json
{
  "title": "演示标题",
  "designIntent": "为决策者制作一份克制、具摄影感的数据叙事",
  "fonts": { "heading": "Microsoft YaHei", "body": "Microsoft YaHei" },
  "filename": "presentation.pptx",
  "openAfterCreate": false,
  "slides": []
}
```

Each slide has `background`, optional `speakerNotes`, and an `elements` array. Supported element types are:

- `text`: `text`, `role` (`title|subtitle|body|caption|metric`), `fontSize`, `color`, `bold`, `italic`, `align`, `valign`, optional fill/line/shadow.
- `image`: local `path`, `fit` (`cover|contain`), optional transparency/rotate/rounding/shadow. Reuse a logo only with `allowReuse: true`; do not reuse ordinary imagery.
- `shape`: `shape` (`rect|roundRect|ellipse|line|chevron|hexagon|arc|triangle|diamond`), fill/line/rotate/shadow.
- `chart`: `chartType` (`column|bar|line|area|pie|doughnut`), categories, series, optional labels and legend.
- `table`: rows, header/body colors, border, font size, margins, optional column widths.

Example slide fragments:

```json
{
  "background": "0B0D10",
  "elements": [
    { "type": "image", "path": "/workspace/assets/product.jpg", "x": 53, "y": 0, "w": 47, "h": 100, "fit": "cover" },
    { "type": "text", "role": "title", "text": "不是更多功能\n而是更少阻力", "x": 7, "y": 18, "w": 39, "h": 28, "fontSize": 44, "bold": true, "color": "FFFFFF" },
    { "type": "text", "role": "body", "text": "把复杂工作压缩成一个自然入口", "x": 7, "y": 55, "w": 36, "h": 12, "fontSize": 20, "color": "B7BEC8" }
  ]
}
```

```json
{
  "type": "chart",
  "chartType": "line",
  "x": 42,
  "y": 18,
  "w": 52,
  "h": 63,
  "categories": ["一月", "二月", "三月"],
  "series": [
    { "name": "活跃用户", "values": [42, 67, 91], "color": "00A7C4" }
  ],
  "showLegend": false,
  "showValue": true
}
```

Do not emulate presentation layout by creating a grid of rounded rectangles. Start from the content's visual hierarchy and use shapes sparingly for structure or emphasis.

## Incremental quality-gate repair

When `create_designed_pptx_file` is blocked, its result includes a `repairToken`, `baseRevision`, and structured zero-based issue indexes. Keep the original deck server-side and call `repair_designed_pptx_file`; do not resend the full `slides` array.

Replace only an affected element:

```json
{
  "repairToken": "returned-token",
  "baseRevision": 0,
  "patches": [
    {
      "op": "replace_element",
      "slideIndex": 1,
      "elementIndex": 4,
      "element": { "type": "text", "text": "Adjusted copy", "role": "body", "x": 8, "y": 38, "w": 36, "h": 12, "fontSize": 20, "color": "FFFFFF" }
    }
  ]
}
```

Use `replace_slide` only when the issue is about the whole composition, visual coverage, or layout variety. Every repair reruns the complete original studio quality gate before the PPTX is rendered.
