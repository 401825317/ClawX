# ClawX Frontend Project Map

## 项目定位

ClawX 是基于 Electron + React + Vite + TypeScript 的 OpenClaw 桌面客户端。本工作区中的这个分支用于适配 new-api/JunFeiAI/灵智无限托管供应商能力，让桌面端可以完成账号登录、设备激活、relay token 获取、模型供应商写入和充值相关流程。

仓库信息：

- 本地目录：`frontend/`
- origin：`https://github.com/401825317/ClawX.git`
- upstream：`https://github.com/ValueCell-ai/ClawX.git`
- 当前分支：`feature/clawx-newapi-client`
- 包管理器：pnpm，版本由 `package.json` 的 `packageManager` 固定

## 先读文件

- `AGENTS.md`：ClawX 原项目开发规则，包含 renderer/Main API 边界、i18n、测试和通信链路要求。
- `package.json`：脚本、依赖、Electron/Vite 构建入口。
- `scripts/dev-junfeiai.mjs`：本分支联调 new-api/JunFeiAI 的推荐启动脚本。
- `electron/services/junfeiai/junfeiai-service.ts`：托管供应商核心逻辑。
- `electron/api/routes/junfeiai.ts`：本地 Host API 的 `/api/junfeiai/*` 路由。

## 关键目录

- `src/`：React renderer UI。
- `src/pages/Setup/`：首次启动、登录/注册、激活码流程。
- `src/pages/Settings/`：设置页，包含退出托管账号等入口。
- `src/pages/Recharge/`：充值与订单状态查询入口。
- `src/pages/Chat/`：聊天页和模型选择，托管模型会从 `/api/junfeiai/models` 获取。
- `src/components/settings/ProvidersSettings.tsx`：供应商设置 UI。
- `src/lib/host-api.ts`、`src/lib/api-client.ts`：renderer 调用 Main/Host API 的统一入口。
- `src/lib/providers.ts`：renderer 侧供应商定义。
- `src/stores/`：Zustand 状态。
- `electron/`：Electron Main、preload、本地 API、Gateway 管理、OpenClaw 配置同步。
- `electron/shared/providers/registry.ts`：Main/shared 侧供应商注册，包含 `lingzhiwuxian`。
- `electron/utils/junfeiai-distribution.ts`：托管分发环境变量和默认域名。
- `electron/utils/junfeiai-device.ts`：设备 ID 和本地激活状态文件。
- `electron/utils/openclaw-auth.ts`：把 provider/token 写入 OpenClaw runtime 配置。
- `electron/main/updater.ts`：更新 feed 默认指向后端 `/api/clawx/updates/feed`。
- `tests/unit/junfeiai-service.test.ts`：托管供应商主要单元测试。
- `harness/specs/`：通信链路和 AI Coding 任务规范。

## ClawX/new-api 对接链路

renderer 不直接请求远端 new-api。UI 通过 `hostApiFetch('/api/junfeiai/...')` 调用本地 Host API，Host API 再由 `electron/services/junfeiai/junfeiai-service.ts` 请求后端：

- `GET /api/clawx/bootstrap`：获取服务名、默认模型、注册/登录/激活要求、离线宽限等。
- `POST /api/clawx/activation/check`：校验激活码并换取 activation ticket。
- `POST /api/clawx/verification/send-code`：发送邮箱验证码。
- `POST /api/clawx/register`：注册并创建设备会话。
- `POST /api/clawx/login`：登录并创建设备会话。
- `POST /api/clawx/auth/refresh`：刷新 ClawX access token。
- `POST /api/clawx/auth/verify`：在线校验授权状态。
- `POST /api/clawx/relay-token`：换取写入 OpenClaw runtime 的 API key。
- `GET /api/clawx/user/self`：读取当前用户。
- `GET /api/clawx/billing/checkout-info`、`POST /api/clawx/billing/orders`、`POST /api/clawx/billing/orders/verify`：充值/订单流程。

兼容策略：如果后端没有 ClawX 兼容路由，部分登录和 key 创建流程会回退到 Sub2API 标准路由，例如 `/api/v1/auth/login`、`/api/v1/keys`。

### 登录、注册、设备授权契约

- 登录状态、设备激活状态、OpenClaw runtime relay key 是三类独立状态。
- 退出登录、登录过期、token 失效后的恢复弹层只允许登录，不显示注册入口，首次提交登录不要求激活码。
- 首次设置页允许“登录已有账号”和“注册新账号”；注册新账号时才使用激活码，并由后端控制首注册送额度。
- 如果后端登录返回 `device_authorization_required`，说明账号密码正确但当前设备未授权；前端再显示激活码输入，用同一登录表单补充设备授权。这个流程不是注册，不发首注册送额度。
- ClawX 相关错误必须优先使用后端 `code` / `errorCode` 映射到用户文案，不把 `api error`、接口路径、内部 provider 名称直接展示给用户。

## 常用命令

首次准备：

```bash
pnpm run init
```

普通开发：

```bash
pnpm dev
```

联调本地 new-api：

```bash
pnpm run dev:junfeiai -- --backend=http://127.0.0.1:3000 --provider=http://127.0.0.1:3000/v1
```

质量检查：

```bash
pnpm run typecheck
pnpm run lint:check
pnpm test
```

通信链路相关改动额外执行：

```bash
pnpm run comms:replay
pnpm run comms:compare
```

## 环境变量

- `CLAWX_MANAGED_PROVIDER=1`：启用托管供应商模式。
- `CLAWX_JUNFEIAI_BACKEND_ORIGIN`：认证、bootstrap、billing 后端，例如 `http://127.0.0.1:3000`。
- `CLAWX_JUNFEIAI_PROVIDER_BASE_URL`：写入 OpenClaw runtime 的模型 API base URL，例如 `http://127.0.0.1:3000/v1`。
- `VITE_DEV_SERVER_PORT`：Vite dev server 端口，默认 `5173`。
- `OPENCLAW_GATEWAY_PORT`：OpenClaw Gateway 端口，默认 `18789`。

## 开发注意

- 新 UI 文案必须走 `react-i18next`，覆盖 `en`、`zh`、`ja`、`ru` 对应 namespace。
- renderer 不新增直接 `window.electron.ipcRenderer.invoke(...)`，不直接 fetch `127.0.0.1:18789` Gateway。
- 供应商、密钥、OpenClaw runtime 写入优先改 Main/electron service 层。
- 触达 Gateway、host-api、api-client、runtime send/receive 的改动，要按 `AGENTS.md` 的 harness/comms 规则验证。
