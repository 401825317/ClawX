---
id: openclaw-2026-7-1-upgrade
title: Upgrade the bundled OpenClaw runtime to 2026.7.1-2
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Upgrade ClawX from OpenClaw 2026.6.11 to the latest stable 2026.7.1-2 runtime while preserving ClawX chat, streaming, compaction, provider failover, media, task delivery, plugin, packaging, state recovery, and rollback contracts.
touchedAreas:
  - package.json
  - pnpm-lock.yaml
  - electron-builder.yml
  - electron/gateway/**
  - electron/main/index.ts
  - electron/main/updater.ts
  - electron/main/portable-update-installer.ts
  - electron/main/portable-update-security.ts
  - electron/utils/openclaw-cli.ts
  - .github/workflows/package-win-manual.yml
  - resources/cli/win32/**
  - resources/openclaw-plugins/**
  - scripts/after-pack.cjs
  - scripts/build-portable-updater.mjs
  - scripts/build-usb-release.mjs
  - scripts/bundle-openclaw.mjs
  - scripts/bundle-openclaw-plugins.mjs
  - scripts/download-bundled-node.mjs
  - scripts/installer.nsh
  - scripts/openclaw-bundle-config.mjs
  - scripts/openclaw-*-patch.mjs
  - scripts/openclaw-*-patch.test.mjs
  - scripts/patch-nsis-extract.mjs
  - tools/portable-updater/**
  - harness/specs/tasks/openclaw-2026-7-1-upgrade.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - ClawX starts OpenClaw 2026.7.1-2 successfully in development and packaged Electron runtimes.
  - Existing sessions, settings, credentials, transcripts, trajectories, task state, extensions, and generated artifacts remain available after the upgrade.
  - Installed and USB-portable customer copies from every supported compatibility epoch can discover, download, verify, apply, restart into, and if necessary recover from the target update without losing user data.
  - Ordinary chat keeps stable token streaming, tool calls, approvals, compaction, request-scoped provider failover, session cwd, and restart recovery behavior.
  - Image and video tasks keep native OpenClaw ownership, exact task correlation, cancellation, timeout, deduplication, completion delivery, result URLs, and verified artifact metadata.
  - Live events and history replay retain stable turn ownership, ordering, idempotence, and media ownership without duplicate or late-appended messages.
  - A failed or cancelled run is not rewritten as success, and a successful async media task is not announced before its artifact is available.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - gateway-readiness-policy
  - channel-plugin-migration-guards
  - capability-owner-resolution
  - active-config-guards
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/openclaw-2026-7-1-upgrade.md --since HEAD
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run package
  - pnpm run prep:win-binaries:x64
  - node scripts/patch-nsis-win.mjs
  - node scripts/run-electron-builder.mjs --win dir --x64 --publish never
  - go test ./... in tools/portable-updater
  - node scripts/openclaw-text-provider-failover-patch.test.mjs
  - node scripts/openclaw-native-image-delivery-patch.test.mjs
  - node scripts/openclaw-native-media-acceptance-cleanup.test.mjs
  - node scripts/openclaw-video-segment-dedupe-patch.test.mjs
  - pnpm exec tsx --test scripts/host-task-lifecycle.test.ts
  - pnpm exec tsx --test scripts/runtime-native-evidence.test.ts
  - pnpm exec tsx --test scripts/runtime-task-graph.test.ts
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - Isolated Gateway RPC smoke for health, sessions.list, tasks.list, chat.history, and config.get
  - Isolated state migration and downgrade-open verification
  - Packaged runtime smoke on macOS arm64 and release artifact verification for every supported target
  - Windows-native NSIS installer, blockmap, latest.yml, portable ZIP, portable helper, install-over-old, and rollback smoke
acceptance:
  - package.json and pnpm-lock.yaml resolve OpenClaw exactly to 2026.7.1-2.
  - Electron resolves to a release whose embedded Node satisfies OpenClaw's engine range; the selected baseline is Electron 41.10.2 with Node 24.18.0.
  - The Windows bundled Node is at least 22.22.3 and every Windows CLI runtime check enforces the same supported floor.
  - OpenClaw starts through Electron utilityProcess without an engine-range failure.
  - Every retained runtime patch declares or verifies its supported OpenClaw target and fails closed when expected targets or postconditions are absent or ambiguous.
  - No required patch may report success with zero patched files unless the step is explicitly documented as an idempotent cleanup and its clean postcondition is verified.
  - Each former patch is classified as retained and rebased, replaced by an upstream contract, migrated to a ClawX/plugin boundary, or retired with proof that no patched behavior remains.
  - The request-scoped OpenAI-to-DeepSeek fallback still starts every new model call on OpenAI and does not persist the fallback provider or model into the session.
  - The bundled local plugins load under OpenClaw 2026.7.1-2 and their package metadata, manifest versions, extension declarations, and bundled runtime dependencies are consistent.
  - Official OpenClaw-owned channel plugins are compatible with the core runtime; third-party channel plugins remain pinned unless their own regression suite proves an upgrade is required.
  - The packaged OpenClaw bundle contains @openclaw/ai, @agentclientprotocol/sdk, photon-node and its WASM payload, plus every existing Electron Main runtime package.
  - Windows installer output contains a matching installer, blockmap, update manifest, bundled Node 22.22.3, OpenClaw 2026.7.1-2, local plugins, channel plugins, uv, agent-browser, and portable updater helper.
  - Installed auto-update verifies metadata and package integrity, shuts down the owning app instance, preserves the user data directory, starts the target version, and reports a recoverable error instead of looping when installation fails.
  - Portable auto-update verifies sha512 and size, preserves UClawData, replaces only application package entries, keeps a recoverable previous package until launch acknowledgement is established, restores the previous package when replacement or launch acknowledgement fails, and never deletes customer data on a failed extraction or swap.
  - The update feed version, installer/ZIP filename, artifact version, latest.yml metadata, blockmap, sha512, size, platform, architecture, and package_type agree for the same release.
  - Representative upgrade tests cover each compatibility epoch identified from git history, including legacy NSIS v0.3.2, overwrite-installer v0.4.6/v0.4.8, first portable v0.7.1, and the current v0.7.4 data layout unless evidence proves an additional epoch is required.
  - Gateway protocol version 4 remains accepted and ClawX-owned RPC consumers tolerate additive response fields.
  - Upgrade verification runs on an isolated copy of user state; no Doctor fix or migration command mutates the live user state during implementation tests.
  - A pre-upgrade backup and rollback procedure covers config files, SQLite plus WAL/SHM, sessions, transcripts, trajectories, extensions, auth profiles, and the exact previous app/runtime versions.
  - The implementation leaves no uncommitted generated release artifacts, temporary state, copied credentials, or diagnostic output in the repository.
docs:
  required: true
---

## 1. 目标与范围

本次升级将 ClawX 内置 OpenClaw 从 `2026.6.11` 升级到稳定版
`2026.7.1-2`。目标不是让新版“能够启动”就结束，而是让现有产品契约在新版运行时下
保持成立，并通过静态、构建、隔离 Gateway、状态迁移、通信回放、E2E 和人工产品验证。

本次不升级 Beta，不重写 ClawX 信息流架构，不主动迁移第三方渠道插件，也不提交、推送、
发布或修改线上数据。客户升级验证同时覆盖安装版和 USB portable，不把“全新安装成功”当作
自动升级成功。

## 2. 已确认基线

- 当前分支：`feature/newUI`，基线提交 `f2d29a0e`。
- 当前分支应用版本仍为 `0.7.4`；生产更新 API 已发布 `1.0.1`，
  `origin/feature/uclaw-general-agent-orchestration` 已推进到 `1.0.2`，且该分支不是当前
  `feature/newUI` 的祖先。正式发布版本必须高于 `1.0.1`，并先处理这条基线分叉。
- 当前 OpenClaw：`2026.6.11`。
- 目标 OpenClaw：`2026.7.1-2`。
- 当前 Electron：lockfile 实际解析为 `40.8.4`，内置 Node `24.14.0`。
- 目标 Electron：`41.10.2`，内置 Node `24.18.0`。
- OpenClaw 新 Node 范围：`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`。
- 当前 Windows 随包 Node：`22.19.0`，目标最低 `22.22.3`。
- Gateway 协议仍为版本 `4`，ClawX 主要 RPC 和 Agent 事件结构保持兼容。

## 3. 成功标准

1. 开发态和打包态都能通过 Electron 启动新版 Gateway。
2. 现有配置和状态可以在隔离副本上升级，旧版仍能重新打开升级后的合成状态。
3. 所有 OpenClaw runtime 补丁都有明确处置结论，不允许静默失效。
4. 文本、工具、审批、压缩、Provider 降级、图片、视频、取消、任务交付、历史恢复和重连
   行为不退化。
5. 成品包包含新版新增运行时依赖和 WASM 文件。
6. 用户可以用升级前备份恢复到 `2026.6.11 + Electron 40.8.4`。
7. Windows 安装版和 portable 的升级包包含一致版本的 OpenClaw、插件、Node、uv、浏览器运行时
   和 updater helper，跨版本升级不会遗失客户数据。

## 4. 实施阶段

### Phase 0：安全基线和备份

- 记录分支、提交、依赖版本和当前工作区状态。
- 停止本仓库的 Vite、Electron 和 Gateway 开发进程后再替换依赖。
- 所有自动迁移和 Doctor 测试使用临时状态目录，不直接运行在真实 `~/.openclaw`。
- 在需要真实状态验证时，只制作只读来源的快照副本，并确保日志不输出凭证内容。

验证：工作区基线可重现，临时状态目录可独立启动，真实 Gateway 未被测试进程占用。

### Phase 1：运行时和依赖基线

- 将 `openclaw` 固定到 `2026.7.1-2`。
- 将 Electron 固定到 `41.10.2`，避免 caret 自动漂移到未经验证的小版本。
- 将 Windows 随包 Node 提升到 `22.22.3` 或同一 Node 22 维护线更高的受支持版本。
- 同步 Windows CLI 对 Node 最低版本的检测逻辑。
- 更新 lockfile，不执行发布命令。

验证：系统 Node 和 Electron Node 分别执行 OpenClaw `--version` 成功；Windows 下载 URL、
归档名、目录名和 CLI 检测保持一致。

### Phase 2：runtime 补丁重定基

对 `bundle-openclaw.mjs` 中的默认补丁逐项处理，先判断上游是否已经吸收产品语义，再决定
重写、迁移或删除。不能仅因为字符串重新命中就判定兼容。

| 补丁能力 | 目标处置 | 必须证明的行为 |
| --- | --- | --- |
| local action finalize cleanup | 退休 | 新版不存在旧强制工具和语义完成覆盖 |
| reply session init conflict | 保留并语义回归 | 前一轮提交状态时，新一轮 ack 后不会丢失回复 |
| compaction session state | 上游吸收审计后保留或重写 | 压缩后 token/session 状态与新 transcript 一致 |
| ordinary session cwd | 保留并重写 | sessions.create/patch/list 与工具执行使用同一 cwd |
| prompt cache key | 保留并回归 | 新会话可复用受管 provider/model/agent 前缀缓存 |
| text provider failover | 更新版本保护并回归 | 每个新调用都先 OpenAI，当前调用才可降级 DeepSeek |
| reasoning status label | 保留并回归 | thinking effort 与 reasoning visibility 不混淆 |
| CJK tool directory scoring | 保留并回归 | 中文工程、只读和媒体意图仍能发现结构化工具 |
| required contract cleanup | 退休 | 新 bundle 不含历史 contract-tool 覆盖 |
| stream smoothing and delta cadence | 重写 | provider delta 连续投影，不以大块文本突发显示 |
| model request contract diagnostics | 优先迁移到新版 provider.request 事件 | 日志仍能证明最终请求形状且不泄露敏感数据 |
| raw tool signal diagnostics | 重写或由正式事件替代 | 能区分 provider 未返回、OpenClaw 丢弃和执行失败 |
| plugin tool run context | 保留并回归 | trusted plugin context 保留权威 runId 关联 |
| native media cancellation | 重写 | tasks.cancel 终止准确 provider 请求且不再完成投递 |
| managed media timeout/completion | 重写 | timeout、视频完成状态和结果 URL 正确进入 task ledger |
| native image delivery | 保留并回归 | 图片只在真实附件可用后结束 pending UI |
| native media acceptance cleanup | 退休 | 新 bundle 不含历史 acceptance 覆盖 |
| video segment dedupe | 重写 | 同 segment 幂等，不同 segment 可并行生成 |
| video provider catalog | 保留并回归 | 列表只暴露实际配置和支持的模型 |
| video capability contract | 重写 | Agent schema 与选中 provider/model 的参数能力一致 |
| video actual specification | 保留并回归 | delivered MP4 的实际时长、尺寸和轨道被探测记录 |
| task summary delivery | 重写 | 任务完成、artifact 和 verification 正确公开给 ClawX |

可选 browser runtime 补丁继续默认关闭。新版已经包含 Node 24 浏览器取消修复，只有专项回归
证明仍需要时才重新启用。

补丁基础设施同时增加以下门禁：

- 明确支持的 OpenClaw 版本。
- 预期目标文件数或唯一语义锚点。
- 应用后的结构化 postcondition。
- `patchedFiles === 0`、多目标歧义或 postcondition 缺失时构建失败。
- 构建结束输出补丁处置和命中报告。

### Phase 3：插件和渠道兼容

- 为 `uclaw-blender`、`uclaw-local-artifacts` 补充 `package.json#openclaw.extensions`。
- 统一 `uclaw-task-bridge` package 与 manifest 版本。
- 修改任何本地插件时按仓库规则提升插件自身版本。
- 将 `@openclaw/qqbot` 和 `@openclaw/parallel-plugin` 对齐到 `2026.7.1`。
- DingTalk、Lark、Weixin 保持当前固定版本，除非新版 Gateway 回归证明必须升级。
- WeCom 禁止使用异常的 npm latest `20206.7.201`，继续固定受控版本。

验证：最新版 `plugins list --json` 中所有内置 UClaw 插件为 loaded；安装、刷新、升级和回滚
路径不因 manifest 校验而退出失败。

### Phase 4：打包完整性

- 确认 OpenClaw 依赖递归复制包含 `@openclaw/ai`、`@agentclientprotocol/sdk`、
  `@silvia-odwyer/photon-node` 和 `photon_rs_bg.wasm`。
- 只在递归复制无法稳定覆盖时，才把包加入显式 bundle 配置。
- 扩展 bundle 和 afterPack 校验，验证文件存在且可以从成品目录解析。
- 检查 Electron 41 下 ASAR、extraResources、自动更新、CLI 和 helper 启动路径。

验证：`pnpm run package` 成功；从 `build/openclaw` 和打包目录实际加载上述包及 WASM；
成品 Gateway 可以启动并执行基础 RPC。

### Phase 5：状态迁移和回滚演练

备份范围：

- OpenClaw 配置及 provider/model 设置。
- SQLite、`-wal`、`-shm`。
- agents、sessions、transcript、reset/deleted transcript。
- trajectory 和 trajectory pointer。
- extensions、插件状态和 auth profiles。
- 当前 ClawX/OpenClaw/Electron 精确版本。

在临时副本中按以下顺序演练：

1. 旧版启动并记录 health、表数和关键 RPC。
2. 新版启动，执行只读 Doctor，记录迁移和新增表。
3. 新版验证 session/history/task/config。
4. 停止新版，用旧版重新打开同一副本。
5. 若 Doctor fix 修改配置，则从原始快照恢复，不把反向兼容当作唯一回滚手段。

### Phase 5B：客户自动升级与 Windows 升级链

先根据 git 历史识别以下兼容边界：用户数据目录位置、安装器 per-user/per-machine 行为、插件
安装与刷新协议、portable 根目录和 `UClawData` 布局、状态 schema、Provider 迁移以及 updater
helper 协议。测试按兼容时代选边界版本，不按 UI 小版本机械枚举。

最低升级矩阵：

| 来源 | 安装形态 | 目标验证 |
| --- | --- | --- |
| clean | NSIS | 安装、首启、Gateway、卸载保留数据策略 |
| v0.3.2 | NSIS | 数据目录保留、锁文件处理和旧卸载器兼容 |
| v0.4.6 | NSIS | pre-skip-uninstaller 覆盖安装和旧安装目录迁移 |
| v0.4.8 | NSIS | 配置、插件、session 和 Provider 迁移 |
| v0.5.0 | NSIS | 旧 OSS feed 桥接、ClawX 安装目录和新 UClaw 安装器迁移 |
| v0.7.1 | NSIS | electron-updater 下载、blockmap、quitAndInstall、重启 |
| v0.7.1 | USB portable | 首代 portable 布局、sha512/size、helper swap、失败恢复和重启 |
| v1.0.1 production | installed + portable | 当前客户版本、Gateway 插件修复和生产更新 API 路径 |
| v1.0.2 orchestration | source baseline | 合并最新 Gateway、Windows portable、视频项目和打包门禁后再升级 OpenClaw |

Windows 产物门禁：

- NSIS installer、`.blockmap` 和 `latest.yml` 必须同时生成，版本和 sha512 一致。
- USB ZIP metadata 必须使用 `package_type=portable_zip` 并与下载文件一致。
- `resources/bin/node.exe --version` 必须为受支持版本。
- 成品 `resources/openclaw/openclaw.mjs --version` 必须为 `2026.7.1-2`。
- `resources/openclaw-plugins` 中本地和渠道插件版本必须与本次 lockfile 一致。
- 安装覆盖时先正常关闭旧 Gateway，不能让新旧版本争用 `18789` 或互相清理进程。
- NSIS 升级不得删除用户目录；portable helper 只能替换应用文件并明确排除 `UClawData`。
- Portable helper 必须等待新版启动确认；启动失败或超时要恢复 backup 并重新启动旧版本。
- 故意破坏 zip、sha512、磁盘空间或 helper 启动时，旧版本和客户数据仍可使用。

macOS 可以完成 Windows `win-unpacked` 交叉构建和目录审计；NSIS 执行、安装覆盖、
electron-updater 和 portable helper 的最终门禁必须在 Windows x64 原生环境完成。

### Phase 6：回归测试矩阵

| 领域 | 自动或隔离验证 | 用户手工复测重点 |
| --- | --- | --- |
| Gateway | 启动、health、重连、异常退出、safe mode | 页面重启后不中断正在进行的会话 |
| 文本流式 | delta cadence、comms replay/compare、E2E | 文字连续出现，不整段突然蹦出 |
| 历史与排序 | live/history reducer、重复事件、重放 | 中间消息不在末尾重复，不突然插入旧消息 |
| 工具与审批 | tool lifecycle、approval RPC、取消 | ask 模式弹审批，full/off 不误弹 |
| 上下文压缩 | overflow、自动压缩、压缩失败恢复 | 长会话不中断，不显示错误完成状态 |
| Provider 降级 | 无网络模拟 OpenAI fail once | 本次降级后下一次仍先请求 OpenAI |
| 图片 | 同步 provider、附件交付、取消、重复 | 不先说已生成再延迟出现图片 |
| 视频 | task_id、轮询、timeout、结果 URL、取消 | 服务端完成后 UI 及时结束生成中 |
| Task/Artifact | task summary、verification、restart restore | 只用当前 run 产物判定成功 |
| 插件 | list/install/refresh/channel startup | 渠道不会重复注册或启动失败 |
| 打包 | macOS arm64 smoke，其他目标产物校验 | 安装包、CLI、自动更新和本地二进制正常 |
| 自动升级 | feed/manifest/sha512/blockmap、portable updater tests | 从各兼容时代升级、重启和失败回滚 |
| Windows | win-unpacked 审计、NSIS patch、Go helper tests | installer/portable 实机覆盖升级和杀毒拦截提示 |

### Phase 7：发布前门禁

- `git diff` 只包含本方案范围内文件。
- 所有 requiredTests 通过，失败项有明确原因和剩余风险。
- README 中的 OpenClaw、Electron/Node 运行时和排障说明与实现一致。
- 不提交代码，由用户完成最终产品验证后自行提交。

## 5. 回滚方案

代码回滚目标是恢复 `package.json`、lockfile、Electron、Windows Node、OpenClaw 补丁和插件到
升级前版本。运行时回滚优先恢复升级前完整状态快照，再启动旧版。不能在未备份的真实状态上
运行 `doctor --fix`，也不能仅因为旧版能打开新增 SQLite 表就省略数据恢复。

隔离状态演练确认，`2026.6.11` 在重新打开由 `2026.7.1-2` 写入的状态前，会要求显式设置
`OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1`。该开关只用于受控降级演练，不写入产品
默认配置，也不能替代状态快照恢复；正式回滚仍应先恢复升级前备份，再启动旧版。

## 6. 风险与决策

- 最高风险是补丁语义漂移，不是 TypeScript 编译错误。
- 媒体、流式、压缩和任务交付与用户近期问题直接重叠，必须以真实产品行为验收。
- Electron 41 公开 API 破坏面当前较低，但 Node/Chrome 升级仍可能改变网络流、子进程、PDF、
  Cookie、文件选择和渲染时序。
- 新版上游已经修复部分重复消息、流式生命周期、Gateway crash loop、compaction 和 task
  recovery；只有证明上游完整覆盖 ClawX 契约后才能删除对应补丁。

## 7. 当前实施状态（2026-07-19）

已完成：

- OpenClaw 固定为 `2026.7.1-2`，Electron 固定为 `41.10.2`，Windows Node 固定为
  `22.22.3`；npm `latest` 已复核仍为 `2026.7.1-2`，未采用 `2026.7.2` beta。
- 保留的 runtime 补丁已经按新版 bundle 重定基，并在目标缺失、命中歧义或 postcondition
  不成立时失败关闭。
- 六个 UClaw 本地插件均进入成品并可由新版 CLI 加载；QQBot 和 Parallel plugin 已对齐
  `2026.7.1`。
- bundle 和 afterPack 已增加 `@openclaw/ai`、ACP SDK、Photon JavaScript/WASM 运行时完整性
  门禁。
- portable 更新已增加 90 秒启动确认；失败时恢复旧应用文件并重启旧版，`UClawData` 不参与替换。
- 已通过 typecheck、lint（仅保留既有 warning）、package、通信回放/对比、现有 OpenClaw 补丁
  脚本测试、Host task/runtime evidence/task graph、Native media Playwright、Go 测试、Windows
  helper 构建、NSIS patch、Windows x64 `win-unpacked` 交叉构建、harness dry-run、隔离 Gateway
  RPC 和隔离状态升级/降级演练。
- macOS arm64 directory 成品构建已通过；成品内 Electron `41.10.2`、Node `24.18.0`、
  OpenClaw `2026.7.1-2`、六个本地插件及新增 JavaScript/WASM 依赖均已核对，成品 Gateway 的
  `health`、`sessions.list`、`tasks.list`、`chat.history`、`config.get` RPC 均在隔离状态下成功。
- OpenClaw 内置 `canvas` 插件缺少的 `@a2ui/lit`、`@lit/context`、`lit` 已按上游精确版本
  补齐并纳入 bundle/afterPack 门禁；重建后的插件诊断为 `requiredInstalled=true` 且无缺失依赖。
- portable helper 已保留新版进程 PID，Windows 回滚只使用 `/PID` 终止本次启动的进程树，
  不再按 `UClaw.exe` 映像名误杀其他 portable；Go 测试覆盖 PID 传递和缺失 PID 失败关闭。
- Windows x64 NSIS、blockmap、`latest.yml` 和 portable ZIP 已在 macOS 交叉生成并完成内容审计；
  installer 与 manifest 的 size/sha512 一致，portable JSON 的版本、架构、package_type、size 和
  sha512 一致，成品内 Node 为 `22.22.3`、OpenClaw 为 `2026.7.1-2`。这些产物只证明当前
  `0.7.4` 树可打包，完成 `1.0.2` 基线整合后必须全部重新生成，不能直接发布。
- 使用 v0.7.1 的真实旧 helper 源码对当前 321 MB portable ZIP 完成兼容演练：旧可执行文件进入
  backup，客户账号、会话和其他 `UClawData` 内容保持不变，当前 OpenClaw 文件正确落盘。
- 安装版更新检查已增加请求级旧 OSS fallback：JunFei 主 feed 失败时仅当前检查回退
  `https://oss.intelli-spectrum.com/<channel>`，下一次检查仍先尝试 JunFei；显式测试 feed 不回退。

发布前仍需完成：

- 当前升级补丁基于旧的 `feature/newUI` `0.7.4` 树；与最新编排 `1.0.2` 的三方审计出现约
  50 个双边修改/删除冲突，且新编排分支新增 `uclaw-video-project`、Windows self-check、packaged
  regression 和更严格的插件/构建身份门禁。必须先确认采用合并、rebase 或重新移植策略，不能把
  当前 `0.7.4` 成品直接提供给已经使用 `1.0.1` 的客户。
- Windows x64 原生环境仍需按 v0.3.2、v0.4.6、v0.4.8、v0.5.0、v0.7.1、v1.0.1 执行真实
  electron-updater/NSIS 覆盖升级、portable 首跳、启动失败恢复和杀毒拦截测试。
- v0.7.1 的旧 portable helper 可以应用当前 ZIP 并保留数据，但不具备新版的 90 秒启动确认；
  从该版本第一次跃迁时若新版文件已经替换但启动失败，仍需使用保留的 backup 人工恢复，或采用
  先升级 helper 的桥接发布策略。
- 旧 v0.3-v0.5 客户硬编码旧 OSS feed；发布工作流必须继续把同一 installer、blockmap 和
  `latest.yml` 同步到旧 OSS。JunFei feed 当前重定向目标在未发布文件时返回前端 HTML，发布前
  必须校验两个 feed 的 MIME、版本、文件名、size、sha512 和下载可达性。
