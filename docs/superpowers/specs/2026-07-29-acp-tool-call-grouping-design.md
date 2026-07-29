# ACP 连续工具调用分组设计

## 结论

在 `AcpAssistantTurn` 的渲染边界增加只读展示投影，将同一 assistant turn 内连续出现的两条及以上 `tool-call` 合并为一个紧凑工具组。任何正文、思考、计划或审批事件都会结束当前工具组。ACP 原始事件、`itemOrder`、工具 ID、附件投影、历史回放和 Store 均保持不变。

## 用户体验

- 工具组始终默认折叠，运行完成、历史加载或内部工具失败都不会自动展开。
- 用户点击工具组摘要后，按 ACP 原始顺序看到每条工具调用。
- 展开后的单条工具仍可继续展开原始输出；工具组摘要和组级状态不显示失败数量、红色失败状态或失败提示。
- 当前工具阶段仍在运行时显示中性的运行状态与持续流光；工具阶段结束后显示中性的完成状态。内部失败仍保留在原始工具数据和单项详情中。
- 单个工具调用不组成工具组，继续使用现有 `AcpToolCallCard` 行为，避免为一次调用增加额外层级。
- 切换会话或重新加载历史后，工具组重新回到默认折叠状态。

## 分组规则

输入是 `AcpAssistantTurnDisplayGroup.items`，输出是 renderer 专用的 display entry 列表：

1. 按输入数组顺序扫描，不排序、不去重。
2. 连续 `tool-call` 先进入临时缓冲。
3. 遇到任何非 `tool-call` 时刷新缓冲，再原样输出该非工具事件。
4. 缓冲只有一条时原样输出该工具；两条及以上时输出一个工具组。
5. 工具组 ID 使用第一条工具的 `id`，流式追加后续工具时保持稳定。

因此以下序列：

```text
assistant text -> tool A -> tool B -> thought -> tool C -> tool D -> assistant text
```

展示为：

```text
assistant text -> group(A, B) -> thought -> group(C, D) -> assistant text
```

## 组件边界

### `src/lib/acp/tool-call-groups.ts`

纯函数展示投影。只依赖 `TimelineItem` 与 `ToolCallItem`，负责连续分组和稳定 ID，不包含 React、翻译或状态。

### `src/pages/Chat/AcpToolCallGroup.tsx`

负责组摘要、折叠状态、无障碍属性和展开后的工具列表。折叠状态初始化为 `false`，没有完成后自动折叠或失败后自动展开的 effect。

摘要优先按 ACP `toolKind` 识别 `read`、`edit/delete/move`、`search`、`execute`、`fetch`，按编辑、命令、搜索、获取、读取的顺序选择最多两个主要行为。未知类型不再让整个工具组退化为数量文案；只有完全无法识别行为时才使用“正在处理相关操作”或“完成了相关操作”。摘要不展示调用数量，只反映执行活动，不反映成功率。

### `src/pages/Chat/AcpToolCallCard.tsx`

增加 grouped 展示变体，复用现有单项输出逻辑。grouped 变体默认折叠单项详情，标题行更紧凑，并把终态统一呈现为中性完成状态；只有用户再次点击单项时才显示原始输出或内部错误。

### `src/pages/Chat/AcpAssistantTurn.tsx`

使用 `useMemo` 对 `group.items` 建立展示投影。非工具事件继续走现有分支；工具组交给 `AcpToolCallGroup`。不修改 `AcpTimeline`、reducer 或会话状态。

## 运行态动效

采用已确认的 B 方案：旋转状态环保留现有运行提示，仅对“正在执行……”摘要文案增加低对比度流光。流光从左向右循环扫过文字，不覆盖 Chevron、工具组背景或展开后的单项内容，避免整行闪烁和布局跳动。工具组不在右侧重复展示项目数量。

动效状态完全从现有 renderer 输入派生，不向 Store 写入新的运行状态：

1. 工具组必须是当前 assistant turn 的最后一个 display entry，才可能处于活动态。
2. 组内存在 `pending/running` 工具时进入活动态。
3. 即使当前组内工具暂时都进入终态，只要该组仍位于末尾且本轮 `timing.status` 为 `running`，仍保持活动态，覆盖串行工具调用之间没有事件的间隔。
4. 正文、思考、计划、审批或新的分组边界追加到工具组之后时，旧组立即退出活动态。
5. 整轮 timing 进入 complete 时退出活动态；取消和运行错误沿用现有整轮收口信号，不单独显示失败动效。
6. timing 缺失时退化为组内是否存在 `pending/running` 工具，不能因为缺少 timing 无限播放。
7. 历史回放的工具组始终使用静态完成态，不播放流光。

退出活动态时，用约 160ms 的透明度过渡移除流光，状态环切换为静态行为图标，摘要从“正在执行”变为“已执行”。读取、编辑、命令、搜索和网络获取分别使用文件、铅笔、终端、放大镜和地球图标；混合组按编辑、命令、搜索、获取、读取的顺序选择主要图标，未知工具使用扳手。不播放成功闪光，不自动展开工具组，也不根据失败数量改变颜色或文案。网关短暂重连本身不作为完成信号；只要 renderer 仍认为当前轮次在运行，动效继续，避免误报完成。

流光周期约 5 秒，使用现有 muted/foreground token 形成轻微亮度差。页面启用 `prefers-reduced-motion: reduce` 时禁用旋转和流光，只保留静态运行文案与图标。任一时刻每个 assistant turn 最多只有末尾一个工具组播放动效。

## 性能

- 分组为每次 assistant turn 渲染的 O(n) 线性扫描，没有深拷贝工具内容。
- 折叠时不渲染工具输出正文，减少长命令输出产生的 DOM 与内存占用。
- `useMemo` 只在 `group.items` 引用变化时重算。
- 动效只作用于一个短摘要文本，使用 CSS 动画，不增加 Store 状态、定时器、Gateway 订阅或历史刷新。

## 无障碍与视觉

- 摘要使用真实 `button`，提供 `aria-expanded` 与稳定的 `aria-controls`。
- Chevron 表示展开方向；运行中使用 spinner 与摘要文案流光，终态使用中性的工具行为图标。
- 摘要单行截断，窄窗口不会挤出容器。
- 支持键盘 Enter/Space、focus ring 与 `prefers-reduced-motion`。
- 使用现有设计 token、Lucide 图标和 8px 以内圆角，不引入新配色系统。

## 测试

- 纯函数单测覆盖连续分组、正文/思考/计划/审批边界、单工具保留和稳定组 ID。
- React 单测覆盖默认折叠、手动展开、原始顺序、流式追加不重置、摘要不出现失败文案和单项二次展开。
- React 单测覆盖末尾运行组持续播放、非工具边界结束、整轮完成结束、timing 缺失降级和历史回放静态状态。
- Electron Playwright 覆盖 live ACP 事件中 `正文 -> 连续工具 -> 正文 -> 连续工具` 的真实渲染顺序、默认折叠和点击展开。
- Electron Playwright 覆盖运行态流光 class、串行工具间不中断、正文边界停止和完成态不再播放动画。
- 运行 Node/Web typecheck、目标 Vitest、目标 Playwright 和 Vite build。

## 非目标

- 不合并跨 assistant turn 的工具调用。
- 不改变工具事件接收、排序、去重、持久化或历史加载。
- 不改变图片/视频生成、附件提取、审批、计划和思考事件。
- 不删除内部错误数据，也不把工具失败升级为新的用户级错误提示。

## 回滚

删除展示投影与 `AcpToolCallGroup`，将 `AcpAssistantTurn` 恢复为直接遍历 `group.items`，即可回到逐条工具展示；底层数据和协议没有迁移成本。
