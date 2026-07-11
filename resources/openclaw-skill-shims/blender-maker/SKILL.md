---
name: blender-maker
description: 创建可编辑的 Blender 三维场景、GLB 模型和渲染图。适用于 Blender、三维设计、3D、产品建模、场景、动画、GLB、三维海报等请求。
metadata: { "openclaw": { "emoji": "🧊", "requires": { "bins": ["blender"] } } }
---

# UClaw Blender 三维制作

使用 `blender_get_capabilities` 确认本机 Blender runtime 可用，再用 `create_blender_scene` 生成可验证产物。

## 强制约束

- 只提交 `uclaw.blender.scene/v1` 的结构化 SceneSpec。
- 禁止传递 Python、`bpy` 代码、shell 命令、插件安装命令或任意脚本。UClaw 只运行自己的固定 Blender runner。
- 默认交付 `.blend`、`.glb`、`hero.png` 与 `manifest.json`；用户要求动画时才设置 `deliverables.turntable=true`。
- 先定义对象、材质、灯光、相机和渲染方向，再创建。每次场景最多使用必要数量的对象和资产。
- 没有本地且可授权的素材时，使用程序化 primitive 和材质，不要伪造外部素材路径。
- 任务只有 job 状态为 `succeeded` 且 required verifications 通过时才算完成。运行中必须用 `get_blender_job` 轮询，不能用普通文字宣称已完成。
- 修复只可在 terminal job 上使用 `repair_blender_scene`，携带原 job 的 `baseRevision`，并仅提交针对失败项的 bounded patch。

## SceneSpec 最小示例

```json
{
  "schema": "uclaw.blender.scene/v1",
  "title": "Chrome product pedestal",
  "objects": [
    { "id": "form", "primitive": "torus", "materialId": "chrome" },
    { "id": "floor", "primitive": "plane", "transform": { "location": [0, 0, -1] }, "materialId": "floor" }
  ],
  "materials": [
    { "id": "chrome", "baseColor": [0.2, 0.6, 1, 1], "metallic": 0.9, "roughness": 0.16 },
    { "id": "floor", "baseColor": [0.02, 0.02, 0.03, 1], "roughness": 0.3 }
  ],
  "cameras": [{ "id": "camera", "transform": { "location": [5, -5, 3] } }],
  "activeCameraId": "camera"
}
```
