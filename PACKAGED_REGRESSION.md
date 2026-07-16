# UClaw Windows 便携包自动回归

这套回归测试的对象是已经生成的 USB ZIP，不是源码版 Electron，也不使用 IPC Mock 代替 Gateway。测试入口会解压 ZIP、启动其中的 `UClaw.exe`，并使用隔离的 `UClawData`、`APPDATA`、`LOCALAPPDATA` 和端口运行真实的 Electron Main、Host API、OpenClaw Gateway、插件及媒体 Runtime。

## 每次打包

`package:win:usb` 已接入 `full` 回归。打包、ZIP/JSON 生成或任一必测场景失败时，命令返回非零状态，产物不得作为测试包分发。

```powershell
pnpm run package:win:usb
```

也可以对已经存在的包单独运行：

```powershell
pnpm run test:packaged:win
pnpm run test:packaged:win:full
node scripts/windows-support/run-packaged-regression.mjs --zip C:\path\UClaw-x.y.z-win-x64-usb.zip --profile full
```

## 测试档位

| 档位 | 是否默认 | 覆盖范围 |
| --- | --- | --- |
| `core` | 否 | 包身份、SHA-512、静态自检、空白便携目录、首次启动、设置持久化、核心导航、真实 Gateway 启停、端口冲突恢复、单实例和托管未登录状态 |
| `full` | 是 | `core` 加双本地确定性 Provider 的真实 fallback/删除、会话全生命周期、真实 OpenClaw 文本流、Markdown/Unicode/多轮、429/500 自动重试、畸形流、401 凭证恢复、取消、文件/浏览器/Office 工具、Skills 配置、Doctor、日志、Control UI、Agent、Cron、FFmpeg 时间线/合成/Shot QA 及错误输入 |
| `live` | 显式执行 | 使用专用测试账号执行登录、激活/Relay 状态、Responses、真实图片/视频和充值只读查询；不创建支付订单，外部渠道发送仍需额外授权 |

## 完整能力矩阵

| 范围 | 正常场景 | 异常场景 | 默认档位 |
| --- | --- | --- | --- |
| 安装/便携 | ZIP 解压、带空格路径、JSON/SHA、x64 PE、空 `UClawData`、静态自检 | 缺文件、混合版本、错误架构、脏用户数据直接失败 | `core` |
| 启动 | 首次启动、跳过引导、重启持久化、单实例 | Gateway 端口被占用、托管未登录、恢复后再次启动 | `core` |
| UI | Chat、Models、Agents、Channels、Skills、Cron、Settings | Gateway 停止时仍可导航 | `core` |
| Provider | 本地兼容 Provider 校验、保存、设为默认、真实 fallback、删除、重启后保留 | 无效 API Key 必须被拒绝；401 后重新校验并替换凭证会清除该账号的持久化认证失败状态；删除 fallback 不得残留引用 | `full` |
| 文本聊天 | 简单、中文、多语言、Markdown、表格、代码、多轮上下文 | 瞬时 429/500 自动重试、畸形流失败、慢请求在到达 Provider 后取消、401 凭证修复后恢复 | `full` |
| 会话 | 新会话落盘、转录读取、重命名、重启保留、硬删除 | 删除后会话、转录和侧车产物不得残留 | `full` |
| 工具 | OpenClaw 写文件、浏览器打开与 snapshot、DOCX/XLSX/PPTX 真实生成；直接或嵌套结构化 toolResult 均恢复为可见附件卡，并检查 Office ZIP 内容 | 工具缺失、文件缺失、附件卡缺失、内容证据缺失或没有真实副作用均失败 | `full` |
| Skills | 本地发现、启停配置持久化、Quick Access、市场能力探测 | 公网安装默认不执行，必须在报告中标为条件项 | `full` |
| Agent | 创建、展示、重命名、删除 | 删除后残留配置失败 | `core` |
| Cron | 创建、禁用、查询、删除 | 非法 Cron 表达式必须被拒绝 | `core` |
| 本地媒体 | 时间线渲染、视频合成、ffprobe、抽帧、接触表、验收证据 | 缺少源文件不得伪成功或产生可交付 artifact | `full` |
| 诊断 | 日志读取、Doctor、Control UI HTTP 可达 | 日志不得出现凭证；Control UI Token 必须在页面进程内移除后才能返回 Playwright/报告 | `full` |
| 图片/视频云端 | 托管真实图片和真实视频，检查 UI 媒体结果 | 云端错误由运行态和 UI 收敛 | `live` |
| 桌面控制 | `desktop.observe` 真实截图和 artifact 验证 | 默认因隐私跳过 | 显式 `--allow-desktop-capture` |
| 外部渠道 | 状态与健康探测 | 默认禁止真实外发 | 显式 `--allow-external-delivery` |
| 数据安全 | 独立 HOME/APPDATA/LOCALAPPDATA、报告脱敏 | 发现 API Key/Token 明文即失败 | 全部 |

## Live 回归

Live 回归不会读取当前用户的 `%APPDATA%` 或 `%USERPROFILE%\.openclaw`。必须显式提供一个专门用于自动化、允许产生费用的 `UClawData` 副本：

```powershell
pnpm run test:packaged:win:live -- --live-profile C:\UClaw-Test-Profile\UClawData
```

也可以让测试在全新隔离沙箱内登录。命令只从无回显 `stdin` 读取一行 `{"username":"...","password":"..."}` JSON；不要把账号密码放进命令参数、环境变量、仓库或报告：

```powershell
pnpm run test:packaged:win:live -- --live-login-stdin
```

启动后再通过标准输入发送 JSON 行。该模式不会写回任何现有用户目录。Live 充值回归只读取概览和订单历史，禁止创建订单或发起支付。

该目录会复制到临时沙箱后使用，原目录不会被修改。不要使用个人生产账号，不要在仓库、命令输出或报告中保存 Token。外部渠道默认只检查状态，不发送消息。

只有专用测试渠道和接收目标都准备好时才允许真实外发。目标信息通过当前进程环境传入，不写入报告；缺少任一字段时，入口会在启动 UClaw 前拒绝执行：

```powershell
$env:UCLAW_REGRESSION_DELIVERY_CHANNEL = 'feishu'
$env:UCLAW_REGRESSION_DELIVERY_ACCOUNT_ID = '<test-account-id>'
$env:UCLAW_REGRESSION_DELIVERY_TARGET = '<test-recipient>'
pnpm run test:packaged:win:live -- --live-profile C:\UClaw-Test-Profile\UClawData --allow-external-delivery
```

真实外发通过 UClaw 的 Cron/Gateway/Agent/Provider/Channel 完整链路执行，等待 Gateway 回报交付成功后删除临时 Cron 任务。不得把个人联系人或生产群作为测试目标。

## 报告

每次运行在下面目录生成报告：

```text
release/regression/<version>-<timestamp>/
  summary.json
  scenario-results.json
  capability-results.json
  UClaw-complete-regression-report.zh-CN.md
  static-self-check.log
  deterministic-provider-requests.json
  sanitized-runtime.log
  playwright-results.json
  html/
  artifacts/
  scenario-failures/
```

失败时保留临时解压沙箱，便于复现；成功时默认删除。使用 `--keep` 可以保留成功运行的沙箱。

`deterministic-provider-requests.json` 会记录每次本地 Provider 调用的场景、尝试次数、模型、消息角色和工具名，不记录 API Key。聊天、取消和异常场景必须同时具有 UI 状态与真实 Provider 请求证据，不能因为前序熔断而假通过。

能力矩阵源文件是 `tests/packaged-e2e/capability-matrix.json`。报告中的证据等级固定为：

- `SOURCE_E2E`：源码 Electron/Renderer 测试，可能使用受控 Mock，不能证明分发包。
- `PACKAGED_REAL`：精确 ZIP 内的 `UClaw.exe`，真实 Main/Host API/Gateway/OpenClaw/插件/原生二进制；本地确定性模型服务只负责可重复输出。
- `LIVE_REQUIRED`：需要专用在线账号、费用、隐私授权、公网或外部副作用。
- `STATIC_ONLY`：只检查文件、元数据、配置或二进制身份。
- `NOT_COVERED`：当前没有自动化端到端证据，永远不能计入通过。

## 判定规则

- `PASS`：真实执行完成并满足状态、文件、媒体或 UI 证据。
- `FAIL`：必测能力执行失败、超时、伪成功、缺少副作用或错误恢复失败。
- `SKIP`：只允许用于需要真实费用、隐私权限或外部副作用的显式能力，并必须记录原因。
- 静态自检、`core` 和 `full` 的必测项目不能用 `SKIP` 掩盖包缺陷。
