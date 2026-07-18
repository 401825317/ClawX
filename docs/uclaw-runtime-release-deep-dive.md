# UClaw runtime and release deep dive

本文梳理 `feature/clawx-newapi-client` 分支里 UClaw 从启动、登录、Provider 同步、Gateway 请求到打包发版的真实链路。重点不是“有哪些模块”，而是说明每一层为什么存在、它做了哪些副作用、用户出问题时应该从哪一层排查。

当前代码位置：

- Source worktree: `C:\Users\Administrator\Documents\New project\ClawX-video-debug`
- Product name: `UClaw`
- Current version: `package.json` -> `0.7.2`
- Managed provider: `lingzhiwuxian`
- Managed backend origin: `https://zz-cn.lingzhiwuxian.com`
- Managed provider base URL: `https://zz-cn.lingzhiwuxian.com/v1`
- Gateway default port: `18789`
- Host API default port: `13210`

## 1. `/api/junfeiai/*` 到 `/api/clawx/*` 是什么逻辑

它不是“前端直接把接口名字换一下再转发”。实际链路是：

```text
Renderer React
  -> hostApiFetch('/api/junfeiai/...')
  -> IPC channel hostapi:fetch
  -> Electron Main injects per-session Host API Bearer token
  -> local Host API http://127.0.0.1:13210/api/junfeiai/...
  -> electron/api/routes/junfeiai.ts
  -> electron/services/junfeiai/junfeiai-service.ts
  -> remote https://zz-cn.lingzhiwuxian.com/api/clawx/...
  -> local side effects: save auth, save relay token, update provider store, write OpenClaw config, reload/restart Gateway
```

本地 `/api/junfeiai/*` 是桌面端的 facade。远端 `/api/clawx/*` 是 zz-cn/new-api 给 UClaw 这个桌面客户端提供的兼容接口。

### 为什么不让 Renderer 直接请求远端 `/api/clawx/*`

主要有 8 个原因：

1. Renderer 不应该持有或操作长期敏感状态。auth token、refresh token、relay token、OpenClaw runtime API key 都应该由 Main 管理。
2. 登录/注册不是纯 HTTP 请求。成功后要写 `clawx-providers` store、写 OpenClaw `auth-profiles` / `openclaw.json`、设置默认 provider、必要时切换 Gateway auth。
3. 设备授权需要本地设备身份。Main 读取/创建 `clawx-device-identity.json`，并把 device payload 带给远端；Renderer 不应自己处理这个文件。
4. Gateway 生命周期只在 Main 可控。登录成功后如果 Gateway 停止，需要启动；如果 token 切换，可能要 reload/restart。
5. Host API 要避开 CORS 和浏览器限制。Renderer 经 IPC 调本地 Host API，Main 再请求本地/远端，网络代理也统一走 `proxyAwareFetch` / Electron proxy settings。
6. 兼容逻辑集中在 Main。比如远端没有 `/api/clawx/login` 时回退 `/api/v1/auth/login`，没有 `/api/clawx/relay-token` 时回退 `/api/v1/keys`。
7. 错误码统一映射。远端 `device_authorization_required`、`activation_invalid` 等错误会在 Main/Renderer 两层转换成 UI 可读状态。
8. Gateway 和 OpenClaw 插件需要回调本地 Host API。Main 注入 `CLAWX_HOST_API_ORIGIN` 和 `CLAWX_HOST_API_TOKEN` 给 Gateway 进程。

### 这层有没有必要

有必要，但它现在承担的副作用偏多。

保留这层是合理的，因为 UClaw 是 Electron 桌面壳加 OpenClaw runtime，不是纯网页应用。很多动作只能在 Main 做：文件系统、secret store、Gateway 进程、OpenClaw 配置、Windows 安装路径、代理、更新器。

但问题也明显：`GET /api/junfeiai/status` 不是只读状态检查，它会调用 `ensureJunFeiAIProviderSeeded()`，可能触发远端 bootstrap、auth 验证、provider 修复、relay token 检查、runtime 同步。用户看到的一个“刷新状态”可能背后做了多步修复和写入，所以故障表现会混在一起。

更好的拆法应该是：

- `/status/local`: 只读本地状态，不能联网，不能写 runtime。
- `/status/remote`: 只做远端验证，最多更新缓存。
- `/bootstrap/sync`: 明确执行 provider/runtime 修复。
- `/auth/login` 和 `/auth/register`: 登录后明确返回每一步是否成功，例如 `authSaved`、`relayIssued`、`providerSynced`、`gatewaySwitched`。
- `/runtime/repair`: 用户主动点击修复 runtime 时才做 OpenClaw 写入和 Gateway reload。

当前代码把这些合在一起，优势是自愈，劣势是用户问题难定位。

## 2. Host API 和 IPC 层

### Renderer 请求入口

文件：`src/lib/host-api.ts`

主路径：

```text
hostApiFetch(path, init)
  -> invokeIpc('hostapi:fetch', { path, method, headers, body })
```

Renderer 默认不直接 `fetch(127.0.0.1:13210)`，而是走 IPC，因为：

- 避免 CORS。
- Main 可以注入 Host API token。
- Main 可以统一代理网络请求。
- 防止普通网页上下文误调用本地敏感接口。

只有在 `hostapi:fetch` handler 不存在，并且 localStorage 里 `clawx:allow-localhost-fallback=1` 时，才会走浏览器 fallback。

### Main 代理入口

文件：`electron/main/ipc/host-api-proxy.ts`

逻辑：

```text
ipcMain.handle('hostapi:fetch')
  -> validate path starts with /
  -> inject Authorization: Bearer <per-session host api token>
  -> proxyAwareFetch('http://127.0.0.1:<CLAWX_HOST_API><path>')
  -> return normalized json/text response to Renderer
```

### Host API server

文件：`electron/api/server.ts`

启动在 `127.0.0.1:13210`。它有两个关键 gate：

- Bearer token gate: 每个非 OPTIONS 请求必须带本次进程生成的 token。
- Content-Type gate: 变更类请求必须是 `application/json`，避免 simple request CSRF。

路由顺序里 `handleJunFeIAIRoutes` 在 provider/agents/channel 等路由之前。

常见故障：

- Host API port 被占用：Main 日志会提示 `EADDRINUSE`，可用 `CLAWX_PORT_CLAWX_HOST_API` 覆盖。
- Renderer token 过期/不一致：通常发生在 Main 重启、Renderer 没刷新、Gateway 持有旧 env token 的边界上。
- IPC handler 未注册：Renderer 会 fallback，但默认被策略挡住，表现为本地 API 不可用。

## 3. `/api/junfeiai/*` 路由表

文件：`electron/api/routes/junfeiai.ts`

| Local Host API | Main action | Remote route or fallback | 是否有本地副作用 |
| --- | --- | --- | --- |
| `GET /api/junfeiai/status/local` | `getJunFeiAILocalStatus()` | none | 读本地 secret/device/cache |
| `GET /api/junfeiai/status` | `ensureJunFeiAIProviderSeeded(syncRuntime=false, syncRuntimeOnAuthChange=true)` | `/api/clawx/bootstrap`, `/api/clawx/user/self` or `/api/v1/auth/me`, maybe `/api/clawx/relay-token` | 可能保存 provider、default provider、relay token、清理 stale token、同步 runtime |
| `POST /api/junfeiai/bootstrap` | `ensureJunFeiAIProviderSeeded()` | same as above | 可能写 provider/runtime |
| `POST /api/junfeiai/activation/check` | `checkJunFeiAIActivation()` | `/api/clawx/activation/check` | 无持久写入，返回 activation ticket |
| `POST /api/junfeiai/login` | `loginJunFeiAI()` | `/api/clawx/login`, fallback `/api/v1/auth/login`; relay `/api/clawx/relay-token`, fallback `/api/v1/keys` | 保存 auth、relay、activation、provider，切 Gateway auth |
| `POST /api/junfeiai/register` | `registerJunFeiAI()` | `/api/clawx/register`, fallback `/api/v1/auth/register`; relay same as login | 保存 auth、relay、activation、provider，切 Gateway auth |
| `POST /api/junfeiai/verification/send-code` | `sendJunFeiAIVerificationCode()` | `/api/clawx/verification/send-code`, fallback `/api/v1/auth/send-verify-code` | 无 |
| `POST /api/junfeiai/auth/verify` | `verifyJunFeiAIAuth()` | `/api/clawx/auth/verify`, fallback `/api/v1/auth/me` | 保存 verification cache |
| `GET /api/junfeiai/topup/overview` | `getJunFeiAITopupOverview()` | `/api/clawx/billing/checkout-info` | 需要 auth token |
| `GET /api/junfeiai/topup/orders` | `getJunFeiAITopupOrders()` | `/api/clawx/billing/orders/history` | 需要 auth token |
| `POST /api/junfeiai/topup/order` | `createJunFeiAITopupOrder()` | `/api/clawx/billing/orders` | 创建远端订单 |
| `GET /api/junfeiai/topup/order/status` | `getJunFeiAITopupOrderStatus()` | `/api/clawx/billing/orders/verify` | 远端查验订单 |
| `GET /api/junfeiai/models` | `listJunFeiAIModels()` | `/api/clawx/bootstrap` | 失败时用本地 fallback models |
| `GET /api/junfeiai/client-config` | `getJunFeiAIClientConfig()` | `/api/clawx/client-config`, fallback bootstrap.client | 更新 UI 轻量配置 |
| `POST /api/junfeiai/relay-token` | `storeJunFeiAIRelayToken()` | none, token 由调用方提供 | 保存 relay 并同步 provider |
| `POST /api/junfeiai/logout` | `logoutJunFeiAI()` | `/api/clawx/auth/logout` best effort | 删除 auth/relay/OpenClaw key，停止 Gateway |

## 4. Managed auth 状态机

Renderer 侧状态在 `src/lib/managed-auth.ts`。

关键状态字段：

- `managed`: 是否托管模式。
- `hasAuthToken`: 是否有登录 access token。
- `hasRefreshToken`: 是否有 refresh token。
- `authValid`: 远端认证是否有效。
- `authRejected`: 远端明确拒绝 auth。
- `hasRelayToken`: 是否已有可写入 OpenClaw runtime 的 API key/relay key。
- `deviceActivated`: 本地设备是否已授权。
- `activationRequired`: 后端或本地状态是否要求激活。
- `localOnly`: 使用本地缓存/离线 grace。
- `offlineGraceExpiresAt`: 离线宽限截止时间。

UI 判断：

```text
ready =
  managed=false
  or (hasRelayToken && authValid && not activationRequired)
  or localOnly recoverable session
```

### 首启流程

文件：`src/pages/Setup/index.tsx`

步骤：

1. Welcome
2. Auth
3. Runtime
4. Installing
5. Complete

Auth 步骤使用 `ManagedAccountAuthPanel`。通过后才允许进入 runtime 检查。

Runtime 步骤检查：

- Node.js：Electron 内置，所以直接成功。
- OpenClaw package：`openclaw:status`。
- Gateway：看 `useGatewayStore.status`，非 running 时等待，最长 600 秒后报 `Gateway startup timed out`。

### 非 setup 页面强制登录 Gate

文件：`src/components/auth/ManagedAuthGate.tsx`

行为：

- 进入非 setup 页面后，先调用 `/api/junfeiai/status/local`。
- 1.5 秒 idle 后调用 `/api/junfeiai/status` 做远端验证。
- 每 5 分钟重复远端验证。
- 若状态不是 ready，则显示登录/授权面板。

这能及时发现登录过期，但也会让网络差、后端慢、relay token 不一致的用户反复看到弹窗。

## 5. Token、设备和本地持久化

### Provider store

文件：

- `electron/services/providers/store-instance.ts`
- `electron/services/providers/provider-store.ts`
- `electron/utils/secure-storage.ts`

Store 名称：`clawx-providers`。

主要 keys：

- `providerAccounts`
- `providerSecrets`
- `providerSecretsV2`
- `apiKeys`
- `junfeiaiVerificationCache`
- `defaultProvider`
- `defaultProviderAccountId`
- legacy `providers`

目前有 legacy provider config 和新 provider account 两套兼容层。历史迁移和 UI 同步都依赖它，所以排查 provider 问题时不能只看其中一个 key。

### Secret storage

文件：`electron/services/secrets/secret-store.ts`

普通 provider 会优先用 Electron `safeStorage` 写 `providerSecretsV2`。但这两个 account 例外：

- `lingzhiwuxian`
- `lingzhiwuxian-auth`

它们使用本地 file store 的 `providerSecrets`。这能降低 Windows safeStorage 不可用导致登录丢失的概率，但也意味着：

- 本地 store 更敏感。
- 卸载不删数据时旧 token 会保留。
- token owner mismatch 或 token 过期时需要代码主动清理。

### 设备身份

文件：`electron/utils/junfeiai-device.ts`

文件：

- `clawx-device-identity.json`
- `clawx-device-activation.json`

路径：

- 普通安装：`app.getPath('userData')`，当前代码会优先复用 `%APPDATA%\ClawX` 或 `%APPDATA%\clawx`。
- 稳定备份：Windows 下 `%APPDATA%\UClaw\clawx-device-identity.json`。
- 便携模式：`UClawData\clawx`。

迁移逻辑：

1. 如果当前 userData 有 identity + activation，使用当前。
2. 否则找稳定备份和旧 `clawx/ClawX` 路径里已激活的 identity。
3. 若找到，复制到当前路径并镜像回稳定备份。
4. 若无激活身份但有旧 identity，也迁移旧 identity。
5. 都没有才创建新 device identity。

用户问题含义：

- 卸载重装但不删 AppData，可能继续复用旧设备身份。
- 改安装形态或 portable 模式，可能切换到另一套 userData。
- 后端按 device id 授权时，本地 identity 错乱会导致 `device_authorization_required`。

## 6. `ensureJunFeiAIProviderSeeded()` 的真实副作用

文件：`electron/services/junfeiai/junfeiai-service.ts`

它是托管模式的核心函数，做这些事：

1. 如果不是托管分发，返回 `managed=false`。
2. 拉远端 bootstrap：`GET /api/clawx/bootstrap`，失败则用 fallback bootstrap。
3. 读取并刷新本地 auth token。如果 access token 过期，会用 refresh token 请求 `/api/clawx/auth/refresh`。
4. 校验 auth：优先 `/api/clawx/user/self`，缺兼容路由时 fallback `/api/v1/auth/me`。
5. 应用本地 device activation 状态，判断是否还需要激活。
6. 构建 provider account：`lingzhiwuxian`。
7. 如 provider 不一致，保存 `providerAccounts.lingzhiwuxian`。
8. 如 default provider 不是 `lingzhiwuxian`，设置默认 provider。
9. 检查 relay secret 是否可用于当前用户：
   - 没 relay 且 auth 有效时，请求 `/api/clawx/relay-token`。
   - 如果远端没有该路由，fallback 创建 `/api/v1/keys`。
   - relay 有 owner 且 owner 与当前用户不匹配时清理。
   - relay 过期时清理。
   - auth 被拒绝时清理 auth 和 verification cache。
10. 如果 provider/default/relay 改变，则同步到 OpenClaw runtime：
    - `syncSavedProviderToRuntime()`
    - `syncDefaultProviderToRuntime()`
11. 如果 Gateway 正在运行且 auth 需要立即切换，调用 `applyJunFeiAIAuthSwitchToGateway()`。

所以这个函数不是简单“初始化 provider”。它是登录状态修复、provider 修复、runtime 修复、token 清理、Gateway 切换的组合。

## 7. 登录和注册细节

### 登录

文件：`electron/services/junfeiai/junfeiai-service.ts`

`loginJunFeiAI()`：

1. 读取/创建 device payload。
2. POST `/api/clawx/login`，body 包含账号、密码、device。
3. 如果 `/api/clawx/login` 不存在，fallback `/api/v1/auth/login`。
4. 规范化 auth payload。
5. 保存 auth session 到 `lingzhiwuxian-auth`。
6. 清理旧 relay key。
7. 用 access token 请求 runtime token：
   - `/api/clawx/relay-token`
   - fallback `/api/v1/keys`
8. 如果 relay token 成功或 auth payload 表示设备已激活，写本地 activation。
9. 调 `ensureJunFeiAIProviderSeeded()` 保存 relay/provider。
10. 保存 verification cache。
11. 调 `applyJunFeiAIAuthSwitchToGateway()`。

失败模式：

- 登录远端成功，但 relay token 获取失败：会停止 Gateway，用户表现为登录失败或登录后不能发。
- relay token 和当前用户 owner 不一致：后续 status 会清掉 relay，表现为“又要登录/relay missing”。
- 后端要求设备授权：UI 要显示激活码流程，不应该当作普通密码错误。

### 注册

`registerJunFeiAI()` 和登录类似，但：

- 注册 body 可能带 `activationCode` / `activationTicket` / `verifyCode`。
- 注册成功后直接 `markJunFeiAIDeviceActivated('register')`。
- 后端控制首注册赠额，不应该由客户端决定。

## 8. Provider 同步到 OpenClaw

文件：

- `electron/services/providers/provider-runtime-sync.ts`
- `electron/utils/openclaw-auth.ts`

UClaw 自己保存 provider account 还不够，OpenClaw Gateway 实际读的是 OpenClaw runtime 配置。

同步会写：

- OpenClaw auth store / legacy `auth-profiles.json`
- `openclaw.json` 的 `models.providers.lingzhiwuxian`
- `agents.defaults.model`
- 各 agent 的 model registry
- image/video relay provider profile

JunFeiAI 特殊点：

- provider id/type: `lingzhiwuxian`
- API protocol: `openai-completions`
- baseUrl: `https://zz-cn.lingzhiwuxian.com/v1`
- default model: `smart-latest`
- `timeoutSeconds`: `300`
- `apiKey` 对 JunFeiAI 会写进 runtime provider entry，而不是仅靠 env。

常见问题：

- UI provider 显示正常，但 OpenClaw `openclaw.json` 没写对，Gateway 发请求仍失败。
- 默认 provider 已更新，但 agent 自己的 models.json 还指向旧 provider。
- runtime reload 没成功，Gateway 仍持有旧配置。
- 旧 `providers` legacy 数据和新 `providerAccounts` 不一致，导致 UI、defaultProvider、runtime 互相打架。

## 9. Gateway 启动

文件：

- `electron/gateway/manager.ts`
- `electron/gateway/config-sync.ts`
- `electron/gateway/process-launcher.ts`

启动顺序：

1. `GatewayManager.start()` 拿 start lock，防止并发启动。
2. 设置状态 `starting`。
3. 预热 Python readiness。
4. `runGatewayStartupSequence()`：
   - 检查端口上已有 Gateway。
   - Windows 下等待端口释放。
   - 如无可复用进程，调用 `startProcess()`。
   - 等待 Gateway ready。
   - 建立 WebSocket 连接。
5. `startProcess()` 调 `prepareGatewayLaunchContext()`。
6. `prepareGatewayLaunchContext()`：
   - 校验 OpenClaw package 存在。
   - 读取 App settings。
   - `syncGatewayConfigBeforeLaunch()` 做 prelaunch 修复。
   - 加载 provider env。
   - 计算代理 env。
   - 设置 `CLAWX_HOST_API_ORIGIN` / `CLAWX_HOST_API_TOKEN`。
   - 设置 `OPENCLAW_SKIP_CHANNELS`。
7. `launchGatewayProcess()` 用 Electron `utilityProcess.fork()` 启动 OpenClaw wrapper。

### prelaunch sync 做什么

`syncGatewayConfigBeforeLaunch()` 会做大量自愈：

- 安装/升级配置过的 channel plugins。
- 清理未配置的 channel plugins。
- 安装 UClaw core plugin：`uclaw-computer-use`。
- 如果配置了 parallel search，安装 parallel plugin。
- 批量同步 gateway token、browser config、session idle。
- 确保 extension deps 对 ESM 可解析。

这些逻辑有必要，但会让“Gateway 启动慢”包含很多可能原因：文件系统慢、插件复制慢、OpenClaw 配置损坏、杀毒软件拦截、Windows 文件锁、node_modules/资源缺失。

### Gateway 运行期监控

GatewayManager 通过 WebSocket 接收：

- JSON-RPC response
- Gateway notification
- chat runtime event
- channel status

心跳逻辑：

- 定时 ping。
- 连续 missed pong 达到阈值后认为 Gateway 卡死。
- 如果处于可恢复 running 状态，会 restart。
- 初始 `gateway.ready` 有额外 grace，避免刚启动就误杀。

## 10. Chat 请求链路

### 普通文本

`src/stores/chat/runtime-send-actions.ts`

```text
sendMessage()
  -> optimistic user message
  -> start history polling
  -> start UI safety timeout
  -> invokeIpc('gateway:rpc', 'chat.send', ...)
  -> Gateway RPC timeout: 30 minutes
  -> events update UI
```

注意：

- RPC 超时 30 分钟。
- UI safety timeout 是 90 秒没有可见进展就停止等待。
- 所以 UI 停止等待不等于后端任务一定停止。

### 附件/图片

有附件时走：

```text
sendMessage()
  -> invokeIpc('chat:sendWithMedia')
  -> Main read staged files from disk
  -> image attachments base64
  -> also append [media attached: path] to message text
  -> gatewayRpcBackpressure.run('chat.send')
```

图片有两条并行路径：

- `attachments` base64 inline vision。
- message 里的 `[media attached: ...]`，让 Gateway native image detection 再读文件。

这样是为了最大兼容，但失败模式更多：

- staged file 被清理或路径不可读。
- 文件太大，base64 过大。
- 模型不支持 vision。
- Gateway history 里只有 path 引用，另一端读取失败。

### chat send 串行和 abort

Main 层对同一个 session 有串行保护：

- 相同 `sessionKey + idempotencyKey` 会复用 in-flight 请求。
- 如果刚 abort，又马上 send，会等待 settle。
- 遇到 session initialization conflict 会重试，最多 30 秒。

这能减少并发冲突，但用户快速停止/重发时可能看到：

- 旧事件回流。
- 新消息等待旧 abort settle。
- UI 已停止但 runtime 事件还在。

## 11. App 启动主流程

文件：`electron/main/index.ts`

启动顺序：

1. `applyPortableEnvironment()`，决定 portable 数据目录和 OpenClaw home。
2. 设置应用名 `UClaw`。
3. 普通模式下 userData 优先复用 `%APPDATA%\ClawX`，否则 `%APPDATA%\clawx`。
4. 单实例锁，防止两个 App 抢同一个 Gateway port。
5. 初始化 logger、telemetry、proxy、launch-at-startup。
6. 创建菜单、窗口、tray。
7. 为 Gateway Control UI 放宽 frame headers。
8. 注册 IPC handlers。
9. 启动 Host API server。
10. 初始化 extension system。
11. 注册 updater handlers。
12. seed/repair OpenClaw workspace context。
13. 清理旧 ClawX preinstalled skills。
14. 托管模式下预装 WeChat plugin。
15. 读本地 JunFeiAI 状态，决定 Gateway 能否 auto-start。
16. 建立 Gateway event -> HostEventBus 桥。
17. 如果 `gatewayAutoStart=true` 且本地托管状态 ready：
    - `syncAllProviderAuthToRuntime()`
    - `gatewayManager.start()`
18. 后台再跑 `ensureJunFeiAIProviderSeeded()`：
    - 如果补齐 auth/relay，且 Gateway 仍 stopped，则再启动 Gateway。

这解释了为什么用户可能看到：

- 首次打开 Gateway 没启动：本地 auth/relay/activation 不 ready。
- 登录后才启动 Gateway。
- 后台验证后突然启动 Gateway。
- 启动时短暂显示未登录或 relay missing。

## 12. 图片/视频生成链路

UClaw 不是只走普通 chat provider。图片/视频还有专门的 relay provider 和 settings。

相关文件：

- `electron/utils/openclaw-image-generation.ts`
- `electron/utils/openclaw-video-generation.ts`
- `electron/utils/openclaw-image-relay-constants.ts`
- `electron/utils/openclaw-video-relay-constants.ts`
- `resources/openclaw-plugins/clawx-openai-image`
- `src/components/settings/ImageGenerationSettings.tsx`
- `src/components/settings/VideoGenerationSettings.tsx`

重点：

- 图片默认模型设置里有单独 timeout，UI 默认 900000 ms。
- 视频默认模型设置里有单独 timeout，UI 默认 600000 ms。
- JunFeiAI provider 的文本模型 timeout 是 300 秒。
- 图片/视频 relay 可能走不同模型、不同 OpenClaw provider entry。

用户说“文本能用但图片/视频不行”时，不要只查 `lingzhiwuxian/smart-latest`，还要查 image/video relay provider entry 和插件是否安装。

## 13. 充值链路

Renderer：`src/pages/Recharge/index.tsx`

Local Host API：

- `/api/junfeiai/topup/overview`
- `/api/junfeiai/topup/orders`
- `/api/junfeiai/topup/order`
- `/api/junfeiai/topup/order/status`

远端：

- `/api/clawx/billing/checkout-info`
- `/api/clawx/billing/orders/history`
- `/api/clawx/billing/orders`
- `/api/clawx/billing/orders/verify`

本地创建订单前会先读 checkout-info，使用：

- `quotaPerUnit`
- `topupInfo.payg_credit_usd_per_cny`

再把远端订单结果规范成 UI 需要的展示口径。

常见问题：

- auth token 过期 -> 充值页报登录失效。
- checkout-info 和 orders 接口口径不一致 -> 金额/额度展示错。
- 订单 verify 成功但 UI 没更新 -> 需要查轮询和 `sync` 参数。

## 14. 本地打包链路

文件：

- `package.json`
- `electron-builder.yml`
- `scripts/bundle-openclaw.mjs`
- `scripts/bundle-openclaw-plugins.mjs`
- `scripts/after-pack.cjs`
- `scripts/patch-nsis-win.mjs`
- `scripts/run-electron-builder.mjs`
- `scripts/installer.nsh`

Windows 本地打包：

```powershell
pnpm run package:win
```

展开后：

```text
prep:win-binaries
  -> uv:download:win:x64
  -> agent-browser:download:win:x64
  -> node:download:win:x64

package
  -> generate-ext-bridge
  -> build:vite
  -> bundle-openclaw
  -> bundle-openclaw-plugins

patch-nsis-win
  -> patch NSIS extract/install/uninstall templates

run-electron-builder --win --publish never
  -> electron-builder
  -> afterPack
  -> NSIS installer
```

`bundle-openclaw.mjs` 不能简单复制 `node_modules/openclaw`。因为 pnpm 用 symlink/virtual store，必须 BFS 收集 transitive deps，复制成可运行的 flat `build/openclaw/node_modules`。

`after-pack.cjs` 继续做：

- 复制 native/openclaw deps。
- 清理不必要文件。
- patch lru-cache CJS/ESM 兼容。
- Windows 下准备 NSIS overwrite upgrade patch。

`electron-builder.yml`：

- `productName: UClaw`
- output: `release`
- artifact: `UClaw-${version}-${os}-${arch}.exe`
- Windows NSIS x64。
- 创建桌面/开始菜单快捷方式。
- `extraResources` 包含 `resources/`、`build/openclaw/`、Windows `bin` 和 `cli`。

本地当前如果基于 version `0.7.2` 打包，预期产物是：

```text
release/UClaw-0.7.2-win-x64.exe
release/UClaw-0.7.2-win-x64.exe.blockmap
release/latest.yml
```

## 15. 安装器逻辑

文件：`scripts/installer.nsh`

安装时：

- 尝试启用 Windows long path。
- 覆盖升级前杀掉 `$INSTDIR` 下旧进程。
- 特别处理 `openclaw-gateway.exe`、`python.exe`、`uv.exe` 等可能占用文件锁的子进程。
- 清理旧 `resources\openclaw\skills`。
- 把 `$INSTDIR\resources\cli` 加到用户 PATH。

卸载时：

- 从用户 PATH 移除 `resources\cli`。
- 询问是否删除 UClaw app data。
- 删除 `AppData\Local\clawx`、`AppData\Roaming\clawx` 等应用数据时，不删除 `.openclaw`。

用户问题：

- 升级卡在无法关闭：多半是旧 Gateway/python/uv 或杀软持有文件锁。
- 卸载后重装还记得账号：因为默认保留数据。
- 桌面快捷方式缺失：配置上要求创建，但旧安装器/权限/Windows 缓存可能让快捷方式不出现，需单独验证。

## 16. 正式发版链路

文件：`.github/workflows/release.yml`

版本 bump：

```powershell
pnpm version patch
# or pnpm version minor / major / prerelease
```

生命周期：

- `preversion`: fetch origin tags。
- `version`: 检查 `vX.Y.Z` tag 本地和远端都不存在。
- `postversion`: push 当前分支和新 tag。

tag 触发 GitHub Actions：

1. `validate-release`: tag 必须和 `package.json` version 匹配。
2. matrix build:
   - macOS
   - Windows
   - Linux
3. Windows stable 版本：
   - 先构建 unsigned exe。
   - 上传 SignPath。
   - 等待签名。
   - 用 signed exe 替换 unsigned exe。
   - 重算并修正 `latest.yml` 的 sha512。
4. 上传构建 artifacts。
5. 创建 GitHub Release，初始为 prerelease。
6. 上传到 OSS：
   - `latest/`
   - `alpha/`
   - `beta/`
   - `releases/vX.Y.Z/`
7. OSS 验证通过后，stable release 才 promote 为 latest。

Updater：

- installed 模式用 electron-updater generic provider。
- feed base 默认：`https://zz-cn.lingzhiwuxian.com/api/clawx/updates/feed`
- 根据 app version detect channel：
  - stable -> `latest`
  - alpha -> `alpha`
  - beta -> `beta`
- portable 模式不走 electron-updater，走 `/api/clawx/updates/latest?package_type=portable_zip`。

## 17. 用户问题分层排查表

| 用户现象 | 优先看哪层 | 关键证据 | 常见原因 |
| --- | --- | --- | --- |
| 打开 App 后要求登录 | ManagedAuthGate + local status | `/api/junfeiai/status/local` 返回 | 无 auth token、无 relay token、activationRequired、local store 换目录 |
| 明明登录过又弹登录 | `refreshStatus()` + verification cache | Main 日志 `[junfeiai]` authRejected / cached auth | access/refresh 失效、远端 verify 慢、offline grace 过期、relay owner mismatch |
| 登录成功但不能发消息 | relay + OpenClaw runtime + Gateway | provider secret、`openclaw.json`、Gateway start log | relay token 没拿到、runtime 没同步、Gateway 没 reload、默认 provider 不对 |
| 登录后 Gateway 没启动 | startup gating | `JunFeiAI local startup status`、`Gateway auto-start skipped` | `gatewayAutoStart=false`、activation required、relay missing |
| 模型下拉有模型但发送失败 | runtime provider config | `models.providers.lingzhiwuxian`、Gateway RPC error | `/api/junfeiai/models` 有 fallback，但 runtime key/baseUrl 不可用 |
| 图片/视频失败但文本正常 | image/video relay | image/video settings、OpenClaw plugin、provider entry | relay provider 没写入、插件没安装、模型/timeout/上游能力不匹配 |
| 发送后 UI 90 秒无响应停止等待 | Renderer chat safety timeout | UI error `not produced new visible progress` | Gateway 仍运行但无事件、history poll 没看到进展、上游长时间无 token |
| `chat.send` 卡很久 | Gateway RPC | `CHAT_SEND_RPC_TIMEOUT_MS=30min`、Gateway logs | OpenClaw agent任务未完成、工具阻塞、上游慢 |
| 快速停止/重发错乱 | chat abort serialization | sessionKey、idempotencyKey、abort settle logs | 旧 run 事件回流、abort settle、session initialization conflict |
| 附件发送失败 | `chat:sendWithMedia` | staged file exists、Main logs | staged 文件不存在、权限、base64 太大、模型不支持 vision |
| 升级安装失败 | NSIS installer | 安装日志、进程列表 | 旧 Gateway/python/uv 占用 `$INSTDIR`、杀软文件锁 |
| 卸载重装仍保留状态 | installer data policy | AppData、`.openclaw`、stable identity | 默认不删数据，设备身份/secret 仍在 |
| 自动更新失败 | updater/feed/signature/hash | `latest.yml`、sha512、Updater logs | 签名后 yml hash 未更新、OSS feed 旧缓存、channel 不匹配 |

## 18. 建议的后续修复方向

如果用户问题很多，优先不要继续加自愈逻辑，应该先把现有自愈拆成可观测步骤：

1. 给 `/api/junfeiai/status` 增加 debug response 或 internal diagnostics，返回每一步耗时和结果。
2. 把 `ensureJunFeiAIProviderSeeded()` 拆成只读检查和写入修复两种模式。
3. 登录/注册返回完整 step result：`authSaved`、`relayIssued`、`providerSaved`、`runtimeSynced`、`gatewaySwitched`。
4. UI 上区分 `loginExpired`、`relayMissing`、`activationRequired`、`gatewayStopped`，不要都显示成泛化登录问题。
5. 增加一个“诊断导出”按钮，打包：
   - app version
   - userData path
   - portable mode
   - managed auth status
   - provider account summary
   - default provider
   - gateway status
   - redacted OpenClaw provider entry
   - recent `[junfeiai]`、`gateway`、`chat.send` logs
6. 给 Gateway 启动阶段显示细分进度：prelaunch sync、process spawned、ready probe、WebSocket connected、gateway.ready。
7. 对图片/视频建立单独诊断，不要和文本 provider 混在一起。
8. 对 installer/upgrade 单独输出安装日志和残留进程列表。

## 19. 最短排查命令思路

在用户机器上排查时，按这个顺序：

1. 当前版本、安装路径、userData 路径。
2. `clawx-providers` 里 `lingzhiwuxian-auth` 和 `lingzhiwuxian` 是否存在，注意脱敏。
3. `clawx-device-identity.json` 和 `clawx-device-activation.json` 是否匹配。
4. `/api/junfeiai/status/local` 和 `/api/junfeiai/status` 的差异。
5. `openclaw.json` 里 `models.providers.lingzhiwuxian` 和 default model。
6. Gateway status、pid、port、最近 restart/heartbeat 日志。
7. 如果是 chat 问题，看 `chat.send.rpc` metric 和 runtime events。
8. 如果是 image/video，看对应 relay provider、plugin 和 generation settings。
9. 如果是升级问题，看 `$INSTDIR` 残留进程和 NSIS/installer 日志。

