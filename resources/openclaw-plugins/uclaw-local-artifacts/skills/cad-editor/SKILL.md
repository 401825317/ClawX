---
name: cad-editor
description: 创建可编辑的二维 CAD/DXF 建筑平面图、布局图和施工草图。用户明确要求 CAD、DXF、DWG、可编辑图纸、建筑平面或布局图时使用。
---

# UClaw 可编辑 CAD v1

## 交付契约

- 用户要求 CAD、DXF、DWG、可编辑建筑图、平面图或布局图时，必须调用 `create_dxf_file`，交付真实可编辑的 `.dxf` 文件。
- `image_generate` 只能用于用户明确要求的效果图、渲染图或附加预览图。PNG/JPEG 即使具有 CAD 风格，也不得冒充 CAD 图纸或替代 DXF。
- 同一轮同时要求 CAD 和效果图时，DXF 是必交付物，效果图只能作为附加产物。
- 用户要求 DWG 时，不得创建伪造的 `.dwg` 文件。先交付可编辑 DXF，并明确说明需要在 AutoCAD、ODA File Converter 等工具中转换为 DWG。
- 不得只回复计划、代码片段或“稍后生成”。必须在当前轮调用工具并检查结果。

## 参数与假设

- 优先使用用户给出的单位、占地宽度、进深、层数、墙厚、门窗和楼梯要求。
- 缺少参数时采用保守默认，并在最终回复中列出工具返回的 `assumptions`，不能把假设描述成用户确认的事实。
- 建筑尺寸必须明确 `unit`。例如 12 米乘 15 米使用 `unit=m, width=12, depth=15`，不要混用米和毫米。

## 强制验收

工具返回后必须检查：

1. `ok=true` 且 `verification.ok=true` 或 `verification.status=passed`。
2. `editableFormat=DXF`，文件扩展名为 `.dxf`，文件真实存在且非空。
3. 验证证据包含实体数量、实体类型和图层。
4. 必须存在 `BOUNDARY`、`WALLS`、`DOORS`、`WINDOWS`、`STAIRS`、`DIMENSIONS`、`ANNOTATIONS` 图层。
5. 边界宽度、进深、楼层数量与请求或已声明假设一致。
6. 墙体、门、窗、楼梯和尺寸标注均有实际实体，不得只写在说明文字中。

任一阻断验收失败时，明确返回可恢复错误并修正参数；不得改用 `image_generate` 掩盖失败。

## Python 环境

- 内置 `create_dxf_file` 使用 UClaw 自带的确定性 DXF 引擎，不依赖系统 Python，也不需要安装 `ezdxf`。
- 只有用户明确要求运行自定义 Python CAD 脚本时，才使用 Gateway 继承的 `uv`：`uv run --with ezdxf python <script>`。
- 禁止使用裸 `python` 或 `pip`，禁止把依赖安装到与 Gateway 无关的系统 Python。

## 最终回复

用简体中文简要说明图纸单位、边界尺寸、楼层和采用的假设，并返回：

`MEDIA:<absolute-path-to-file.dxf>`

PNG 预览如存在，应明确标为“附加预览”，不能称为 CAD 源文件。
