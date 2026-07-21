---
id: openclaw-2026-7-1-upgrade
title: Upgrade the bundled OpenClaw runtime to 2026.7.1-2
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Integrate the approved newUI timeline onto the latest orchestration baseline while upgrading ClawX from OpenClaw 2026.6.11 to the latest stable 2026.7.1-2 runtime, preserving chat, streaming, compaction, provider failover, media, task delivery, plugin, packaging, state recovery, and rollback contracts.
touchedAreas:
  - .env.example
  - .gitignore
  - .node-version
  - AGENTS.md
  - PACKAGED_REGRESSION.md
  - PROJECT_MAP.md
  - clawx-extensions.json
  - index.html
  - playwright.packaged.config.ts
  - vite.config.ts
  - vitest.config.ts
  - package.json
  - pnpm-lock.yaml
  - electron-builder.yml
  - electron/**
  - electron/gateway/**
  - electron/main/index.ts
  - electron/main/updater.ts
  - electron/main/portable-update-installer.ts
  - electron/main/portable-update-security.ts
  - electron/services/providers/openai-chat-migration.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/utils/openclaw-cli.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - .github/workflows/check.yml
  - .github/workflows/comms-regression.yml
  - .github/workflows/electron-e2e.yml
  - .github/workflows/harness.yml
  - .github/workflows/package-win-manual.yml
  - .github/workflows/release.yml
  - .github/workflows/win-build-test.yml
  - resources/cli/win32/**
  - resources/openclaw-plugins/**
  - harness/evidence/**
  - harness/fixtures/**
  - harness/specs/rules/**
  - harness/specs/scenarios/**
  - harness/specs/tasks/**
  - harness/src/**
  - scripts/**
  - shared/**
  - src/**
  - resources/blender/**
  - resources/cli/posix/**
  - resources/context/**
  - resources/icons/**
  - resources/openclaw-skill-shims/**
  - resources/skills/**
  - tests/packaged-e2e/**
  - tests/unit/**
  - tests/e2e/**
  - tests/setup.ts
  - scripts/after-pack.cjs
  - scripts/build-portable-updater.mjs
  - scripts/build-usb-release.mjs
  - scripts/bundle-openclaw.mjs
  - scripts/bundle-openclaw-plugins.mjs
  - scripts/download-bundled-node.mjs
  - scripts/dev-junfeiai.mjs
  - scripts/installer.nsh
  - scripts/junfeiai-distribution-defaults.test.ts
  - scripts/openai-chat-migration.test.ts
  - scripts/openclaw-bundle-config.mjs
  - scripts/openclaw-*-patch.mjs
  - scripts/openclaw-*-patch.test.mjs
  - scripts/patch-nsis-extract.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/runtime-port-ownership.test.ts
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
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
  - pnpm run test:update-channel:unit
  - pnpm run test:win-signing:unit
  - pnpm run package
  - pnpm run prep:win-binaries:x64
  - pnpm run updater:build:win
  - node scripts/patch-nsis-win.mjs
  - node scripts/run-electron-builder.mjs --win dir --x64 --publish never
  - node scripts/run-electron-builder.mjs --win nsis --x64 --publish never
  - node scripts/run-electron-builder.mjs --skip-nsis-patch --win portable --x64 --publish never immediately after NSIS
  - go test ./... in tools/portable-updater
  - node scripts/openclaw-text-provider-failover-patch.test.mjs
  - node scripts/openclaw-native-image-delivery-patch.test.mjs
  - node scripts/openclaw-native-media-acceptance-cleanup.test.mjs
  - node scripts/openclaw-video-segment-dedupe-patch.test.mjs
  - pnpm exec tsx --test scripts/host-task-lifecycle.test.ts
  - pnpm exec tsx --test scripts/runtime-native-evidence.test.ts
  - pnpm exec tsx --test scripts/runtime-task-graph.test.ts
  - pnpm exec tsx --test scripts/runtime-port-ownership.test.ts
  - pnpm exec tsx --test scripts/openclaw-plugin-path-sanitize.test.ts
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
  - The Windows installer blockmap is regenerated from the final signed installer bytes, and publication fails when any blockmap chunk differs from a fresh app-builder calculation.
  - The update feed version, installer/ZIP filename, artifact version, latest.yml metadata, blockmap, sha512, size, platform, architecture, and package_type agree for the same release.
  - Representative upgrade tests cover each compatibility epoch identified from git history, including legacy NSIS v0.3.2, overwrite-installer v0.4.6/v0.4.8, first portable v0.7.1, and the current production v1.0.1 data layout unless evidence proves an additional epoch is required.
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

本次不升级 Beta，不偏离已批准的 ClawX newUI Timeline 设计，不主动迁移第三方渠道插件，
也不提交、推送、发布或修改线上数据。最终实现以最新 orchestration `1.0.2` 为基线融合
newUI 和升级层；客户升级验证同时覆盖安装版和 USB portable，不把“全新安装成功”当作
自动升级成功。

## 2. 已确认基线

- 升级前 newUI 来源：`feature/newUI`，基线提交 `f2d29a0e`，应用版本 `0.7.4`。
- 当前融合工作树：`feature/newUI-openclaw-2026-7-1-integrated`，以 orchestration `1.0.2`
  提交 `b1507595` 为基线承载 newUI 和升级层；生产更新 API 已发布 `1.0.1`，正式发布版本必须
  高于该版本。
- 升级前 OpenClaw：`2026.6.11`。
- 目标 OpenClaw：`2026.7.1-2`。
- 升级前 Electron：lockfile 实际解析为 `40.8.4`，内置 Node `24.14.0`。
- 目标 Electron：`41.10.2`，内置 Node `24.18.0`。
- OpenClaw 新 Node 范围：`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`。
- 升级前 Windows 随包 Node：`22.19.0`，目标最低 `22.22.3`。
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
| v1.0.1 production | USB portable | 当前客户便携版本、Gateway 插件修复和生产更新 API 路径；若存在私下分发的 NSIS，需另行补测 |
| v1.0.2 orchestration | source baseline | 合并最新 Gateway、Windows portable、视频项目和打包门禁后再升级 OpenClaw |

Windows 产物门禁：

- NSIS installer、`.blockmap` 和 `latest.yml` 必须同时生成，版本和 sha512 一致。
- SignPath 改写 installer 后必须基于签名后的最终字节重新生成 `.blockmap`，再结构化更新
  `latest.yml` 的 size 和 sha512；发布前必须逐块重算并比较 blockmap。
- USB ZIP metadata 必须使用 `package_type=portable_zip` 并与下载文件一致。
- 稳定版 Windows USB ZIP 必须作为 `archive: false` 的原始 ZIP artifact 单独提交给
  SignPath，不能使用 GitHub 默认外包 ZIP 代替产品 ZIP。SignPath `ValueCell` 项目需创建
  ZIP artifact configuration，并将其 slug 写入 GitHub 仓库变量
  `SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG`：

  ```xml
  <artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
    <zip-file>
      <pe-file path="UClaw.exe">
        <authenticode-sign/>
      </pe-file>
      <pe-file path="resources/resources/updater/win32-x64/uclaw-portable-updater.exe">
        <authenticode-sign/>
      </pe-file>
    </zip-file>
  </artifact-configuration>
  ```

  该配置只签名 UClaw 自有 PE；Node、uv、ffmpeg 等第三方二进制保留上游签名，
  不使用 UClaw 证书重签。工作流必须在签名结果中只找到一个同名 ZIP，解压后确认
  `UClaw.exe` 和 portable updater helper 的 Authenticode 状态均为 `Valid`，然后才能替换
  原 ZIP 并重算 companion JSON 的 size 和 hex SHA-512。最后必须对签名后的正式 ZIP 重新
  执行 `test:packaged:win:full`；签名前的 packaged regression 不能代替该门禁。
- GitHub `upload-artifact@v7` 在 `archive: false` 时会忽略 `name` 并使用上传文件名作为
  artifact 名，且当前 `overwrite: true` 对该模式存在公开未修复缺陷。签名输入因此必须
  先复制为带 `github.run_id` 和 `github.run_attempt` 的唯一临时 ZIP 文件名；SignPath 返回后严格
  校验该临时名，再覆盖正式 ZIP。这是失败 job 可重跑的发布门禁，不得改回同名直传。
- SignPath action 必须设置 `skip-decompress: true`，使签名后的 ZIP 按原始临时文件名落盘。
  默认值 `false` 会直接解压签名产物，后续就无法以最终 ZIP 字节重算客户端 metadata。
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

隔离状态演练确认，单纯由 `2026.7.1-2` 打开旧状态不会自动改写
`meta.lastTouchedVersion`：配置仍标记为 `2026.6.11` 时，旧版前台 Gateway 可以直接重新打开，
3 个会话仍可读取，SQLite `startup-migrations.app_version` 保持 `2026.7.1-2` 且完整性为 `ok`。
一旦新版 OpenClaw 或 ClawX 实际写入配置，版本戳会更新为 `2026.7.1-2`；此时旧版默认拒绝
运行自动 Gateway 启动迁移，只有受控设置
`OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1` 后才能启动并读取状态。该开关只用于隔离
降级演练，不写入产品默认配置，也不能替代状态快照恢复；正式回滚仍应先恢复升级前备份，再
启动旧版。

## 6. 风险与决策

- 最高风险是补丁语义漂移，不是 TypeScript 编译错误。
- 媒体、流式、压缩和任务交付与用户近期问题直接重叠，必须以真实产品行为验收。
- Electron 41 公开 API 破坏面当前较低，但 Node/Chrome 升级仍可能改变网络流、子进程、PDF、
  Cookie、文件选择和渲染时序。
- 新版上游已经修复部分重复消息、流式生命周期、Gateway crash loop、compaction 和 task
  recovery；只有证明上游完整覆盖 ClawX 契约后才能删除对应补丁。

## 7. 当前实施状态（2026-07-20）

已完成：

- OpenClaw 固定为 `2026.7.1-2`，Electron 固定为 `41.10.2`，Windows Node 固定为
  `22.22.3`；npm `latest` 已复核仍为 `2026.7.1-2`，未采用 `2026.7.2` beta。
- 保留的 runtime 补丁已经按新版 bundle 重定基，并在目标缺失、命中歧义或 postcondition
  不成立时失败关闭。
- 七个 UClaw 本地插件均进入构建产物并可由新版 CLI 加载，包含最新编排基线新增的
  `uclaw-video-project`；QQBot 和 Parallel plugin 已对齐
  `2026.7.1`。
- bundle 和 afterPack 已增加 `@openclaw/ai`、ACP SDK、Photon JavaScript/WASM 运行时完整性
  门禁；afterPack 同时清理 `app.asar.unpacked` 中与目标平台/架构不匹配的原生包，并在残留错误
  架构包或缺少目标 Sharp runtime 时失败关闭。
- portable 更新已增加 90 秒启动确认；失败时恢复旧应用文件并重启旧版，`UClawData` 不参与替换。
- 已通过 typecheck、package、通信回放/对比、现有 OpenClaw 补丁
  脚本测试、Host task/runtime evidence/task graph、Native media Playwright、Go 测试、Windows
  helper 构建、NSIS patch、Windows x64 `win-unpacked` 交叉构建、harness dry-run、隔离 Gateway
  RPC 和隔离状态升级/降级演练。全量 lint 当前为 0 error、6 条既有 React hook/fast-refresh
  warning。
- Electron E2E 最新一轮完成 159 项回归：157 passed、2 skipped、0 failed。两个 skip 分别为
  Windows 专属标题栏用例和一个按既有条件跳过的内部 usage 过滤用例。Timeline 实际流式性能约
  60 FPS、无 long task；500/1000 条历史消息均保持最多 22 个挂载行。
- 最终全量 E2E 审计曾暴露两个回归：Channels degraded 文案的全局定位同时命中 banner 标题和状态
  标签，现已限定在 `channels-health-banner` 内；视口上方工具详情收起时，Virtuoso 偶发先移动可见行、
  后更新总 `scrollHeight`，旧补偿会让当前阅读锚点偏移约 `170px` 并被虚拟化回收。动态布局恢复现优先
  使用真实可见行像素偏移，仅在锚点暂时被回收时用总高度兜底，并在恢复事务内禁止把漂移后的位置记为
  新锚点。修复前重复 10 次出现 1 次失败，修复后连续 20/20 通过；完整滚动契约 6/6、最终 159 项
  Electron E2E 仍为 157 passed、2 skipped、0 failed。
- Gateway 从未 ready/断开状态恢复后会受控刷新 sessions 和当前会话 history，不恢复周期性历史
  轮询；fresh Gateway 状态拒绝发送时，同时撤销 legacy optimistic message 和 canonical local Turn，
  页面不再留下看似已发送的用户气泡。
- Provider lifecycle E2E 已对齐当前 account API 契约：seed/mock 在主界面首次 snapshot 前完成，
  多账户 provider 使用动态 account id，语言相关断言固定测试语言。该调整不改变产品 Provider
  行为。
- macOS arm64 directory 成品构建已通过；成品内 Electron `41.10.2`、Node `24.18.0`、
  OpenClaw `2026.7.1-2`、七个本地插件及新增 JavaScript/WASM 依赖均已核对，成品 Gateway 的
  `health`、`sessions.list`、`tasks.list`、`chat.history`、`config.get` RPC 均在隔离状态下成功。
- OpenClaw 内置 `canvas` 插件缺少的 `@a2ui/lit`、`@lit/context`、`lit` 已按上游精确版本
  补齐并纳入 bundle/afterPack 门禁；重建后的插件诊断为 `requiredInstalled=true` 且无缺失依赖。
- portable helper 已保留新版进程 PID，Windows 回滚只使用 `/PID` 终止本次启动的进程树，
  不再按 `UClaw.exe` 映像名误杀其他 portable；Go 测试覆盖 PID 传递和缺失 PID 失败关闭。
- Windows x64 NSIS、blockmap、`latest.yml` 和 electron-builder portable EXE 已在 macOS 交叉生成；
  installer 与 manifest 的 size/sha512 一致，成品内 Node 为 `22.22.3`、OpenClaw 为
  `2026.7.1-2`。构建身份为 `1.0.2` 且 `sourceTreeState=dirty`，这些产物只能用于验证，不能发布。
- 当前融合树已在 Sharp 原生包清理修复后，再次按 `package` → Windows `dir` → NSIS → portable
  顺序完整重建。最终 Windows installer 为 `351740726` 字节，base64 SHA-512 为
  `8NNXCQvQAOVn7gSBST2VZQM+ibG+2EY4VKoe3jdLuJLp7XYDVa7dcsH6TJ4axveiGbWtr8k+M0a/L2PTLgaGzw==`；
  `latest.yml` 的 filename、size 和 sha512 与实际文件完全一致。blockmap 为 `352375` 字节、
  `16724` 个 chunks，现场重算与发布文件逐字节一致；portable EXE 为 `272138858` 字节。相较修复前，
  installer 约从 `428 MB` 降至 `352 MB`，portable 约从 `334 MB` 降至
  `272 MB`；`app.asar.unpacked/node_modules/@img` 从约 `222 MB` 降至 `29 MB`，最终只保留
  `sharp-win32-x64` 和 `sharp-wasm32`。成品内同时复核了 `@openclaw/ai 2026.7.1-2`、ACP SDK
  `1.1.0`、Photon `0.3.4` 及 WASM、Canvas/Lit 依赖、portable helper 和全部本地/渠道插件。
  `UClaw.exe` 在 `win-unpacked`、NSIS installer 和 portable EXE 内的 hex SHA-512 均为
  `e2a169b671d63b910d16450aeca0eac174f8830138c1a9448e3aebc1f70177369eba04b3f600fb49bff0fac111e07600a321d952c2c134620f1a4cc9bc45398d`；
  helper 为 `2951168` 字节，源码产物、`win-unpacked`、NSIS installer 和 portable EXE 内嵌文件的
  hex SHA-512 均为
  `8217e75fb7ea925591d318807973188a7e87f01986fa1b120d63b74c5e3dcaa807b6d2ca9607d40e2e02853da49f3f2388b3181616d43fa19b4e53c4309c7bb4`。
- 连续执行 NSIS 后再构建 portable 时，发现 electron-builder 全局解压模板会把安装版
  `$clawxRollbackDir` 泄漏到 portable。解压补丁已升级为 v6：只有安装版编译失败回滚分支，
  portable 不再引用安装器变量；实际 NSIS → portable → NSIS 连续构建和静态回归均已通过。
- 2026-07-20 再次执行连续构建时发现 `package:win:portable` 未显式传入 `--x64`，在 Apple Silicon
  主机上会误选 Windows ARM64，而准备步骤只提供 x64 运行时。脚本现已固定 `--win portable --x64`，
  防止本地交叉构建和 CI runner 架构影响目标产物。
- 同次复核发现 `scripts/run-electron-builder.mjs` 只在 Windows 主机传递 `CLAWX_SKIP_NSIS_PATCH`，
  macOS/Linux 交叉构建的 `--skip-nsis-patch` 实际不会到达 afterPack，且不会清理旧
  `win-unpacked`。包装脚本现按 Windows 构建目标而非宿主平台清理目录，并在所有宿主统一传递该
  环境变量；实际 NSIS 后的 portable 构建已打印 `Skipping NSIS install template patches`。
- `scripts/build-usb-release.mjs` 明确禁止在非 Windows 主机生成 Windows USB ZIP，因此本轮没有把
  macOS 手工组装的 ZIP 或 JSON 当作发布证据。当前 `1.0.2` 融合树的 portable ZIP、metadata、
  v0.7.1 旧 helper 首跳和 90 秒启动确认仍需在 Windows x64 原生环境生成并验证。
- 安装版更新检查已增加请求级旧 OSS fallback：JunFei 主 feed 失败时仅当前检查回退
  `https://oss.intelli-spectrum.com/<channel>`，下一次检查仍先尝试 JunFei；显式测试 feed 不回退。
- fallback 状态投影已补强：主 feed 存在备用源时，其临时错误只写日志，不提前推送给 renderer；
  切换旧 OSS 前清理错误，只有主、备两路都失败才呈现错误。Electron E2E 已覆盖“主源失败、
  备用源成功后最终为 not-available 且无残留 error”。
- 主发布工作流已纳入 Windows 原生 USB ZIP：同一 Windows job 先构建 NSIS，再运行
  `package:win:usb` 生成并回归 portable ZIP/JSON；发布 artifact、GitHub Release、旧 OSS 和
  `release-info.json` 均包含 portable 产物。USB metadata 的版本、package_type、文件名、size 和
  hex sha512 不一致时工作流失败。
- 旧 OSS 发布从“先删除整个 channel 再上传”改为“版本化包先上传、YAML 和 release-info 最后
  切换”。缺少 Windows/macOS/Linux manifest、USB ZIP/JSON 或远端 manifest 版本错误时发布失败，
  避免大包上传期间老客户看到 404。
- 使用 npm registry 固定 tarball（integrity
  `sha512-T+P/g19IheeT1ckXMoPN61dYuE8vBF4MderI+kWkvpuFYxPkJxn8AXLpu9IXCnN9g36Acpm9+mMD/V+lsvOkyA==`）
  重新建立了未污染的 `2026.6.11` 隔离基线。旧版创建 3 个会话后，新版在同一状态上的
  `health`、`sessions.list`、`tasks.list`、`chat.history`、`config.get` 全部成功；SQLite
  integrity 为 `ok`，`startup-migrations.app_version=2026.7.1-2`。新版只打开状态时配置版本戳
  保持 `2026.6.11`，旧版可直接重新打开并读取 3 个会话；新版实际写配置并将版本戳更新为
  `2026.7.1-2` 后，旧版无恢复开关明确拒绝 Gateway 启动，受控恢复开关下 health 和 3 个会话
  仍可读取。ClawX 自有配置写入现同步写入实际内置 OpenClaw 版本，并拒绝覆盖来自更高或无法
  安全比较版本的配置，避免降级客户端冲掉 newer-config guard。
- 兼容版本产物已盘点：上游 GitHub Release 提供 `v0.3.2`、`v0.4.6`、`v0.4.8`、`v0.5.0`
  Windows x64 NSIS 安装包；实际远端 `401825317/ClawX` 的 `v0.7.1` Release 也公开提供
  `UClaw-0.7.1-win-x64.exe`、blockmap 和 `latest.yml`。生产 OSS 另提供
  `UClaw-0.7.1-win-x64-usb.zip` 与 `UClaw-1.0.1-win-x64-usb.zip`，因此 v0.7.1 的安装版和
  portable 都必须测试，v1.0.1 当前按 portable 客户版本测试。portable ZIP 不能冒充 NSIS 证据。
- 2026-07-20 已从公开 Release 完整下载并校验 `UClaw-0.7.1-win-x64.exe`：文件大小
  `252020623` 字节，base64 SHA-512 为
  `rOd4Mu8YScoaWlOKo/6RM3e74t5H/cfc+q/kFDQw5sk188Aj/f5Suk6SEWqLSPlOcYEO3lbPTG2iuNJYKf+qKg==`，
  与 `latest.yml` 的顶层和 files 记录完全一致。
- 2026-07-20 已继续核对实际远端 `401825317/ClawX` 的全部未过期 Actions artifacts：
  `v1.0.1` 对应 run `29387532229` 只上传了 USB ZIP/JSON，未生成或保留 installer；公开
  GitHub Release、OSS latest/版本化目录、本机 Downloads/Documents/WeChat/CloudStorage 及挂载卷
  也均未找到 v1.0.1 安装包。若该版本曾私下向客户分发 NSIS，仍必须通过
  `UCLAW_UPGRADE_INSTALLER_101_URL` 和 `UCLAW_UPGRADE_INSTALLER_101_SHA512` 提供真实介质；否则
  installed v1.0.1 不属于实际客户升级路径。
- 当前 `scripts/windows-support/run-packaged-regression.mjs` 已验证新 portable 包的静态布局、
  首次启动、Gateway、工具、媒体和隔离数据，但它不会安装旧 NSIS、替换同一安装目录、调用旧
  portable helper 或验证升级后用户目录。因此“新包回归通过”与“跨版本自动升级通过”在证据上严格
  分开。
- 已新增 `scripts/windows-support/run-upgrade-matrix.mjs`，并在手动 Windows workflow 中提供
  `upgrade_matrix` 入口。该入口会同时构建 NSIS 和 USB ZIP，校验公开历史 manifest/metadata，
  校验目标 installer 的 `latest.yml`、blockmap、size 和 sha512，执行 clean NSIS 安装、
  v0.3.2/v0.4.6/v0.4.8/v0.5.0 同目录覆盖、v0.7.1 真实 electron-updater
  `check → download → quitAndInstall → restart`、v0.7.1/v1.0.1 历史 helper 首跳，以及当前 helper
  的真实启动确认、size/SHA-512 完整性拒绝和 90 秒启动确认失败回滚。安装版和 portable 场景均使用
  动态 Host API/Gateway 端口启动真实 UClaw 并等待 Gateway health；卸载后再次验证用户数据标记。
  历史大文件下载具备单次 20 分钟超时、最多三次重试和半包清理。
  结果写入
  `release/regression/windows-upgrade-matrix-*/summary.json`；v0.7.1 安装包直接使用公开 Release，
  v1.0.1 私下分发的安装包则通过受控 URL 和 128 字符十六进制 SHA-512 secrets 提供，配置
  `--require-complete-installers` 时缺失或校验不一致会失败关闭。
- 升级矩阵审计修复了可选 v1.0.1 installer 未配置时引用未声明状态的问题，并统一由来源版本决定
  `installed-electron-updater`/`installed-nsis-overwrite` 报告类型。portable 回滚测试不再用
  `cmd.exe` 代替应用：旧 helper 首跳、当前 helper 成功确认、完整性失败恢复和确认超时回滚都直接
  观察 helper 自动启动或恢复出的 UClaw Gateway，避免“测试脚本手动重启成功”冒充自动恢复证据。
- 稳定版 SignPath 会改写 NSIS installer 字节。发布 workflow 现先校验顶层 EXE 的
  Authenticode 状态，再运行 `release:refresh-win-metadata` 从签名后 installer 重建 blockmap 和
  `latest.yml`；发布前校验会现场重算 blockmap，并逐块比较完整 JSON，旧 blockmap 不再可能随签名后
  installer 一起发布。SignPath 官方文档确认 ZIP artifact 支持 deep signing；发布 workflow 现将
  Windows USB ZIP 作为 `archive: false` 的独立 artifact 提交，并要求仓库变量
  `SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG` 指向只签名 `UClaw.exe` 和
  `resources/resources/updater/win32-x64/uclaw-portable-updater.exe` 的 ZIP artifact configuration。
  签名后的 ZIP 会重新计算 companion JSON 的 size/hex sha512，并解压后用 Windows
  `Get-AuthenticodeSignature` 强制校验这两个 UClaw-owned PE；变量或签名结果缺失时失败关闭。
- 发布 workflow 和 `Windows Build Test` 现在会在 SignPath 完成、installer blockmap/manifest 与
  USB metadata 全部按最终字节刷新、且签名后 packaged regression 通过以后，再对签名后的最终
  installer 和 USB ZIP 执行完整 `test:upgrade:win`。该矩阵继续覆盖 clean NSIS、五个历史安装版、
  两个历史 portable 首跳、当前 helper 成功确认、完整性拒绝和启动失败回滚；报告作为独立
  `signed-windows-upgrade-matrix-*` Actions artifact 保留，不进入 GitHub Release 或 OSS 客户下载目录。
  v1.0.1 私下 installer 的 URL/SHA-512 仍为可选受控 secrets，任一项配置不完整会在历史介质校验时
  失败关闭。这样未签名构建的升级矩阵只作为提前反馈，最终发布门禁以客户实际下载的签名字节为准。
- 历史安装器审计发现 v0.3.2/v0.4.6/v0.4.8 使用 `ClawX` 产品名和快捷方式，而当前安装器会在
  electron-builder 调用旧卸载器之前把旧安装目录整体移到 `_stale_*`。旧卸载器因此可能无法启动；
  虽然新 UClaw 可以完成覆盖安装，但旧 `ClawX.lnk` 会残留并指向已经不存在的 `ClawX.exe`。
  `customInstall` 现使用 electron-builder 在覆盖前捕获的 `$oldDesktopLink`/`$oldStartMenuLink`，仅在
  新旧入口不同且新文件已成功写入后注销并删除旧快捷方式。升级矩阵同时通过 Windows Shell/COM 读取
  当前用户和公共桌面、开始菜单的真实 `.lnk` 目标：历史安装后必须存在指向旧 EXE 的来源入口，升级后
  必须存在指向目标安装目录 `UClaw.exe` 的新入口且没有指向该目录的 `ClawX.lnk`，目标卸载后不得留下
  本场景快捷方式；finally 只清理由本场景安装目录拥有的入口。
- 上述快捷方式修复完成后，macOS arm64 再次成功执行完整 Windows x64 `package:win`，生成的 NSIS
  installer 为 `351740953` 字节，base64 SHA-512 为
  `9NNKfX3usbogrmDCWDArsscJJ/f+MTUoIQorJNJUyJvw9OiCFte2TYVkP6tfp9ozImZoWWHifZ+17yLRcgaYeA==`；
  `latest.yml` 顶层与 files 记录均和实际 filename/size/sha512 一致，`352396` 字节 blockmap 现场重算
  完全覆盖 installer。随后按 NSIS → portable 顺序成功构建 x64 portable EXE，大小为
  `272142994` 字节，二进制不含 `$clawxRollbackDir`、`CLAWX_INSTALLER_ROLLBACK`、`oldDesktopLink` 或
  `oldStartMenuLink`，证明快捷方式清理仍只进入安装版。本轮产物继续来自 dirty 工作树，只用于验证。
- Portable 失败矩阵进一步区分“下载完整性错误”和“归档结构错误”。新增 Go 回归使用与实际坏文件
  完全匹配的 size/SHA-512，使校验阶段通过后在 `zip.OpenReader` 失败；结果证明 staging 被删除，旧
  `UClaw.exe` 和 `UClawData` 字节不变，并且只重启旧版。Windows 原生矩阵新增
  `portable-current-helper-archive-rejection`：在 v1.0.1 portable 上运行目标版本真实 helper，使用
  metadata 正确但不是 ZIP 的 `invalid-update.zip`，要求 helper 非零退出、结果明确为归档错误、来源
  build identity 与数据标记不变，且旧 Gateway 自动恢复到 healthy。该场景补足了单纯修改 size/hash
  无法覆盖的解压失败路径；磁盘耗尽和杀毒软件独占锁仍保留为 Windows 实机/CI 专项门禁。
- 2026-07-21 在快捷方式迁移和坏 ZIP 场景合入后重新执行全部本地契约回归：43 个 TS 文件为
  `341/341`，31 个 MJS 文件为 `82/82`，portable updater Go 测试、typecheck 均通过；全量 ESLint
  为 0 error、6 条既有 warning。Windows x64 NSIS 与 portable 已在最新修改后完成连续交叉构建，
  installer manifest/hash/blockmap 仍一致，portable 无安装器模板污染。测试期间独立探测真实 Gateway
  120 次，0 次失败、最大延迟 21ms；`agent:main:route-test` 仍为原来的 9 条 cancelled task，没有新增
  真实状态污染。
- USB 构建身份和 Windows self-check 的架构清单现在同时覆盖 portable updater helper，避免只校验
  Node/ffmpeg 等运行时而漏掉负责升级回滚的核心 PE。
- 2026-07-20 最终本机回归再次通过 workflow YAML/core JSON 解析、`actionlint`、typecheck、
  全量 lint（0 error、6 条既有 warning）、harness validate/dry-run、通信 replay/compare、Go updater、
  `pnpm run package` 和上述 159 项 Electron E2E。Sharp 清理修复后又执行了 `scripts/` 下全部
  31 个 MJS 测试文件（82 项）及全部 43 个 TS 契约测试文件（339 项），均为 0 failed；
  最终 installer 的 manifest size/sha512 与实际文件一致，blockmap 覆盖字节也已现场重算为
  `351740726`，与 installer 完全一致。USB 深度签名链的本地审计额外确认了
  `upload-artifact@v7 archive:false` 与 SignPath `skip-decompress:true` 的真实 action 契约，并覆盖
  失败 job 重跑的唯一 artifact 文件名。
- 2026-07-20 已直接下载并核对公开 portable 历史产物：v0.7.1 ZIP 为 `342506207` 字节，
  sha512 为
  `73fabfffa46315d742096174b4922870f6c089a9bbd418bdd9e5a72bc16274cddae32735418d55ca202a3ca929f5b09e2d44e51a56c820035764ec8d2055d1d7`；
  v1.0.1 ZIP 为 `351181598` 字节，sha512 为
  `f6e9f875db83fbb4476f10158c8344811fbabf9657be34257a942b6115909dbd7fdd55c883a53f4211bdedd76a419b4c64b9b3419d580b5eee31291744b46d79`，
  均与 OSS metadata 完全一致。两版均包含 `portable.flag`、
  `UClawData` 和 `resources/resources/updater/win32-x64/uclaw-portable-updater.exe`。
  二进制字段审计确认两版旧 helper 都不包含 `ackPath`/`pendingPath`，因此首跳只能验证替换、
  数据标记和 backup 保留；启动确认和自动回滚必须由目标版本 helper 在后续更新中提供。
- 已在隔离 worktree `/tmp/clawx-openclaw-upgrade-latest-base` 上，以最新编排 `1.0.2`
  `b1507595` 为基线完成升级层手工融合。保留了 7 个本地插件、build identity、Windows
  self-check/packaged regression 和视频编排能力，同时接回请求级 OpenAI → DeepSeek 降级。
- 强制依赖重装暴露并修复了两个原先可能被旧 `node_modules` 掩盖的漂移：Browser Lifecycle
  新增 Chrome MCP/扩展分支，Cron scheduled task ledger 拆分到独立 `task-runs` chunk。两项均按
  新版控制流重定基并保持失败关闭。官方 npm tarball 独立解包验证表明 Provider 降级补丁首次命中
  2 个目标文件，排除了 pnpm 复用缓存导致的假阳性；重装后 typecheck、55 个 OpenClaw 补丁测试、
  package 和本轮差异定向 lint 再次通过。
- 2026-07-20 再次执行 typecheck、全量 lint、通信 replay/compare、四组关键 OpenClaw 补丁测试、
  Host task/runtime evidence/task graph/port ownership、Go updater、Native media E2E 和
  `pnpm run package`：全部通过；lint 仍为 0 error、6 条既有 warning，Native media 为 8/8。
  随后重新执行 Windows x64 `dir → NSIS → portable` 连续交叉构建，portable 二进制未包含
  `$clawxRollbackDir` 或 `CLAWX_INSTALLER_ROLLBACK`，排除了安装器模板再次污染 portable。
- 真实页面回归发现 `reply session init conflict` 补丁曾把串行队列注入
  `runExclusiveSessionStoreWrite` 持锁区，队列任务再次申请同一把非可重入写锁，导致 Gateway
  接受 `chat.send` 后永久停在模型请求之前。队列入口现已迁移到写锁外，旧的锁内注入会被自动
  清理，并增加缺失外层锚点或残留锁内队列时的失败关闭断言。官方未修改的
  `openclaw@2026.7.1-2` npm 包验证首次命中 1 个目标文件、二次执行命中 0 个文件；真实 UClaw
  页面首轮完成了 OpenAI 200、工具调用和最终回复，同一 session 第二轮在 6.5 秒内返回，未再产生
  `stalled session`。修复后的 `package`、Windows `dir → NSIS → portable` 成品均包含锁外队列。
- 发布前代码审计继续补齐 portable 的失败关闭边界：父进程 45 秒内未退出或退出状态无法确认时不再
  继续替换；复制中途失败会把当前半成品纳入清理；校验、解压、备份、复制、启动路径、启动和 90 秒
  确认任一阶段失败时，只有旧文件恢复成功后才重启旧版。启动确认同时校验目标版本、portable 根目录
  和新版 PID，`UClawData` 按 Windows 大小写不敏感语义保护。
- `package:win` 和 `package:win:portable` 现在都会先构建 x64 updater helper；afterPack 与 USB
  finalizer 均会在 helper 缺失时失败关闭，避免干净 CI 因本机遗留的 ignored 二进制而产生假成功。
- 更新入口路径和旧 OSS fallback 已统一定义在 `shared/junfeiai-endpoints.json#appUpdates`。稳定版发布
  先上传版本化包和永久 archive，managed Windows/macOS/Linux manifest 及 Windows portable 记录与
  本地签名产物逐字段一致后，才切换旧 OSS 三个平台 manifest；三路公网复核通过后才把 GitHub
  Release 从 pre-release 提升为 latest。managed 记录尚未配置时 promotion job 会失败关闭，可在完成
  管理端登记后只重跑失败 job，不会提前切换稳定 channel。
- ClawX 配置版本戳保护加入后，再次通过 typecheck、全量 lint（0 error、6 条既有 warning）、
  `pnpm run package`、全部 43 个 TS 契约文件（339/339）和全部 31 个 MJS 文件（82/82）。隔离测试
  同时证明旧版本戳会升级为实际内置 OpenClaw 版本，未来或无法安全比较的版本会拒写且原文件字节
  不变。
- Host task 契约回归发现测试隔离仍有一个异步竞态：`HostTaskService` 原先每次持久化都会重新读取
  `OPENCLAW_STATE_DIR`。测试恢复环境变量后，尚未结束的 operation 可能把最后一次状态写入真实
  `~/.openclaw`。服务现在在首次使用时固定 durable store 根目录；route 测试也会等到 cancel
  operation 已经完成并持久化后再恢复环境。新增回归用例在修复前稳定失败、修复后通过。定向
  Host task 测试为 11/11，全部 43 个 TS 契约文件以 `test-concurrency=1` 执行增至
  340/340；typecheck、定向 ESLint、
  `pnpm run package` 和 `git diff --check` 均通过。再次运行完整 TS 契约测试后，真实目录中的
  `agent:main:route-test` 任务数量仍为 9，没有新增污染。
- 2026-07-20 18:39 的真实日志确认 Gateway 曾发生事件循环级无响应：18:39:39
  `tasks.list` 超时，18:40:59 `sessions.list` 超时，heartbeat 从 18:41 起连续 4 次未收到 pong，
  watchdog 在 18:44:02 重启 Gateway，18:44:10 的 `tasks.list` 在 50ms 内恢复。OpenClaw
  `tasks.list` 首次调用会同步恢复 task registry，并通过共享 `DatabaseSync` 打开状态库；该连接的
  `busy_timeout` 为 30 秒。因此外部写锁能够阻塞 Gateway 主事件循环。现有证据不能证明这是唯一根因，
  但测试错误写入真实状态与该卡死发生在同一窗口，属于高度可信诱因。修复隔离后，在完整测试期间
  连续 60 秒探测 Gateway 共 120 次，0 次失败，最大延迟 22ms；顺序重跑全部 TS 契约文件时再次
  探测 120 次仍为 0 失败，最大延迟 1ms，均未再次复现卡死。
- 同日完成当前工作树的最终本机发布回归：31 个 MJS 文件为 82/82，43 个 TS 契约文件为
  340/340，portable updater Go 测试、更新通道单测、Windows USB 签名元数据单测、typecheck、
  harness validate、通信 replay/compare、`pnpm run package` 和 `git diff --check` 均通过。通信回放的
  duplicate、loss、order violation 和 RPC timeout 均为 0。Electron E2E 为 157 passed、2 skipped、
  0 failed；两个 skip 仍是既有内部 usage 过滤条件和 Windows 专属标题栏。Timeline 实测 60 FPS、
  0 long task，500/1000 条历史消息均最多挂载 22 行。
- 当前工作树随后再次按 `dir → NSIS → portable` 顺序完成 Windows x64 交叉构建。installer 为
  `351740760` 字节，base64 SHA-512 为
  `iBX5YtMHCgYuy9xe55P//cl1g1V4vCbIP/MR50YYuPrEJooEo4vfhCNBNKa0XxQm7KVugCo/S4JYA7/2SSHcLQ==`；
  重建后的 blockmap 为 `352448` 字节、`16726` 个 chunks，现场重算与 installer 完全一致。
  electron-builder portable EXE 为 `272143045` 字节。`win-unpacked`、installer 和 portable EXE
  内的 `UClaw.exe` SHA-512 均为
  `b463fd0f5263d88966dfa401d044bde0a61f4d8e5e4ff47e97373b4d0cd08eeaeafb55fa4d72e0a288e7602ba95eb2a408463bedb02a5629d2e5cf68c5902b14`；
  updater helper 三处 SHA-512 均为
  `8217e75fb7ea925591d318807973188a7e87f01986fa1b120d63b74c5e3dcaa807b6d2ca9607d40e2e02853da49f3f2388b3181616d43fa19b4e53c4309c7bb4`。
  成品确认 Node `22.22.3`、OpenClaw `2026.7.1-2`、目标 x64 PE、全部插件和 JavaScript/WASM
  依赖完整；portable 不含 `$clawxRollbackDir` 或 `CLAWX_INSTALLER_ROLLBACK`。本次 build identity
  仍为 `sourceTreeState=dirty`，仅可用于验证，不能发布；electron-builder portable EXE 也不能替代
  必须在 Windows 原生环境生成和签名的客户 USB ZIP。
- 同一工作树重新生成的 macOS arm64 `release/mac-arm64/UClaw.app` 已完成成品级隔离冒烟。
  测试使用独立 HOME、portable root 和动态 Host/Gateway 端口，通过 Host API 启动成品内置 Gateway，
  未读取真实用户状态。renderer、Gateway 和 OpenClaw 健康检查均通过，内置版本为 `2026.7.1-2`；
  `sessions.list`、`tasks.list`、`chat.history`、`config.get` 全部成功，隔离状态中的 session、task 和
  history 数量均为 0，插件加载无错误，heartbeat/RPC 失败计数均为 0。测试结束后成品进程、脚本和
  `uclaw-mac-packaged-smoke-*` 临时目录均已清理。该结果证明当前 macOS 打包产物可独立启动并完成
  核心 RPC，但不能替代 Windows 原生升级矩阵、签名后 USB ZIP 或真实用户产品验收。
- 公网入口再次只读复核，状态没有变化：managed Windows/Linux feed 仍返回 New API HTML，managed
  macOS 为 `0.4.8`，legacy Windows/macOS/Linux 为 `0.5.0`，managed portable API 为 `1.0.1`。
  `test:update-channel --version 1.0.2 --remote-only` 因 managed Windows 非 YAML 正确失败。历史
  v0.3.2/v0.4.6/v0.4.8/v0.5.0/v0.7.1 installer 仍可在 GitHub Release API 中找到；v0.7.1 和
  v1.0.1 portable ZIP 均返回 200，metadata 的版本、文件名、size、hex SHA-512、平台、架构和
  `portable_zip` 类型仍一致。

发布前仍需完成：

- 2026-07-21 用户明确决定暂缓 Windows CI checkout、SignPath 外部配置和生产更新入口登记。本次暂缓
  不撤销对应代码与 workflow，也不把这些门禁标记为通过；当前交叉构建和本地回归只能支持产品验收，
  在恢复正式客户发布流程前仍必须执行下面的 Windows 原生、签名和线上入口检查。
- 当前目标工作树 `feature/newUI-openclaw-2026-7-1-integrated` 已从最新编排 `1.0.2`
  `b1507595` 建立，并完成 newUI 与升级层的语义融合。工作树仍包含大量未提交改动，正式发布前
  必须由用户完成产品验收、逐文件审查并形成干净提交；不能使用当前 dirty 构建产物发布。
- 测试竞态已经在真实用户状态中留下 9 条 `agent:main:route-test` Host task、测试会话
  `c411b15d-a23f-437a-a95f-7f9b8bfe63a2`，以及已禁用且 `next_run_at_ms` 为空的 completion wake
  `d4411a40-f4eb-481a-887d-ab5d185e53d1`。该 wake 曾在 19:32 触发模型调用，随后因 Weixin
  delivery 缺少 target 失败；当前不会继续调度。清理属于真实本地用户数据修改，必须在用户明确授权
  后，仅按上述 session key、session id、9 个 task id 和 cron job id 精确删除，并在操作前保留定向
  备份，不能扩大到其他会话、任务或 cron 记录。
- Windows x64 原生环境仍需实际运行 `test:packaged:win:full` 和 `test:upgrade:win`。稳定版必须以
  SignPath 签名并刷新 metadata 后的最终 installer/USB ZIP 执行：按
  v0.3.2、v0.4.6、v0.4.8、v0.5.0、v0.7.1 验证真实 NSIS 覆盖升级，并按 v0.7.1、v1.0.1
  验证 portable 首跳、启动失败恢复和杀毒拦截；若确认存在 v1.0.1 客户安装版，再增加该 NSIS
  覆盖场景。当前 macOS arm64 主机未安装 Wine、Windows VM 或可用 Windows 容器，不能用交叉构建
  结果替代上述 Actions/Windows x64 报告。
- USB ZIP 深度签名的代码链已接入，但 SignPath 外部配置仍需管理员在 `ValueCell`
  项目中按 Phase 5B 的 XML 创建 ZIP artifact configuration，并设置仓库变量
  `SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG`。本地无法代替这两项外部状态验证；在
  `Windows Build Test` 实际返回签名后的同名 ZIP，且其中 `UClaw.exe` 和 updater helper
  均通过 `Get-AuthenticodeSignature=Valid` 之前，不能宣称 portable 签名门禁已通过。
- GitHub 公共 API 当前可见 7 个 workflow 均为 active，但最近的 Windows 手工构建成功记录来自
  `feature/uclaw-general-agent-orchestration`，当前
  `feature/newUI-openclaw-2026-7-1-integrated` 按本轮“不 push”约束尚不存在于远端，因此没有该树的
  Windows 原生或 SignPath 运行证据；公开 latest Release 仍为 `v0.7.1`。仓库 Variables/Secrets API
  在未认证访问下均返回 `401`，本机也没有 `gh` 或 GitHub token，所以
  `SIGNPATH_USB_ARTIFACT_CONFIGURATION_SLUG` 与 `SIGNPATH_API_TOKEN` 的真实存在状态仍需仓库管理员
  登录后确认，不能从 workflow 引用反推已配置。
- v0.7.1 和 v1.0.1 的旧 portable helper 都不具备新版的 90 秒启动确认。当前融合树 ZIP 尚未在
  Windows 原生环境完成旧 helper 首跳，因此从这两个版本第一次跃迁必须验证 backup 保留和人工
  恢复说明；只有用户已经运行目标版本后，后续升级才能使用新版自动启动确认与回滚。
- 跨版本升级矩阵的原生执行仍未完成：当前分支尚未推送，无法由 GitHub Actions checkout 这棵工作树。
  提前验证可在 `Package Windows (Manual)` 手动选择 `package_type=upgrade_matrix`；稳定版发布和
  `Windows Build Test` 已自动在 SignPath 后运行最终签名产物矩阵。v0.7.1 安装包无需 secrets；只有
  确认存在 v1.0.1 客户安装版时，才启用 `require_private_installer` 或提供
  `UCLAW_UPGRADE_INSTALLER_101_URL`、`UCLAW_UPGRADE_INSTALLER_101_SHA512`。只有最终签名矩阵中所有
  适用场景为 `passed`，且不适用场景有发布证据支持，才能声称全矩阵通过；脚本存在、静态检查通过、
  未签名矩阵或新包回归通过都不能替代这项 Windows 原生证据。
- 生产更新数据当前不是可发布状态。2026-07-20 对七个客户发现入口重新执行只读实测：

  | 入口 | 当前结果 |
  | --- | --- |
  | managed Windows `latest.yml` | 307 后返回 `text/html`，不是 YAML |
  | managed macOS `latest-mac.yml` | YAML `0.4.8` |
  | managed Linux `latest-linux.yml` | 307 后返回 `text/html`，不是 YAML |
  | legacy Windows `latest.yml` | YAML `0.5.0` |
  | legacy macOS `latest-mac.yml` | YAML `0.5.0` |
  | legacy Linux `latest-linux.yml` | YAML `0.5.0` |
  | managed Windows portable API | JSON `1.0.1`，`package_type=portable_zip` |

  `pnpm run test:update-channel -- --version 1.0.2 --remote-only` 因 managed Windows 返回 HTML 按预期
  失败。这不是客户端 YAML 解析问题，而是 new-api 没有完整启用目标 installer/portable 发布记录，
  旧 OSS 也尚未同步目标版本。
- 2026-07-20 进一步按历史源码确认客户发现入口：

  | 客户版本/形态 | 实际更新入口 | 发布要求 |
  | --- | --- | --- |
  | v0.3.2/v0.4.6/v0.4.8/v0.5.0 installed | `https://oss.intelli-spectrum.com/latest/latest.yml` | 旧 OSS manifest 必须切到目标 installer |
  | v0.7.1/v1.0.1 installed | JunFei `/api/clawx/updates/feed/latest/latest.yml` | managed installer feed 必须返回目标 YAML，不能返回 HTML |
  | v0.7.1/v1.0.1 portable | JunFei `/api/clawx/updates/latest?...package_type=portable_zip` | API 必须返回目标 ZIP/size/hex sha512 |
  | 目标版本后续 installed | JunFei 优先、旧 OSS 请求级 fallback | 两个入口仍应保持同一目标版本 |

  因此在 managed 三个平台、portable API 和 legacy 三个平台元数据全部同步前，不能声称所有客户
  版本都能发现本次升级；这不是客户端代码可以在发布前单方面补救的问题。
- 已新增只读发布后校验命令 `pnpm run test:update-channel -- --version <target>`：同时校验 managed
  与旧 OSS 的 Windows/macOS/Linux installer feed 和 Windows portable API，并默认与本地签名后
  三个平台 manifest/安装包、Windows blockmap、USB JSON/ZIP 的 filename、size、sha512 逐字段比较。
  `--managed-only` 用于稳定 channel 切换前的管理端预检，`--remote-only` 可在
  没有本地产物时只检查三处线上入口是否已经一致切到目标版本；当前以 `1.0.2` 执行应失败，这是
  正确的发布阻断信号。
- 正式发布必须在文件上传和签名完成后，为同一目标版本登记并启用 new-api release 记录：至少包含
  Windows x64 `installer`、Windows x64 `portable_zip`，以及实际发布的 macOS/Linux 架构；每条记录
  必须使用不可变下载 URL、真实文件名、size、sha512 和 release date。该步骤修改线上数据，本轮未
  自动执行。
- 启用 release 记录后必须从公网验证：JunFei installer feed 返回 YAML 且 version/URL/size/sha512
  与签名后产物一致；portable API 返回 `package_type=portable_zip` 且 ZIP 可下载并通过 hex sha512；
  旧 OSS feed 同步同一 installer 和 blockmap。任一入口不一致时不得把 GitHub Release 提升为 latest。

## 8. 正式发布顺序

1. 用户完成产品验收和逐文件审查，在干净提交上把应用版本设为高于生产 `1.0.1` 的目标版本。
2. Windows x64 原生 CI 同时产出 NSIS、blockmap、`latest.yml`、USB ZIP、USB JSON 和 helper 回归证据；
   macOS/Linux 生成各自的 update manifest。
3. 确认 SignPath ZIP artifact configuration 和仓库变量已就绪，对 Windows installer 与 USB ZIP
   分别完成签名。从最终 installer 重新生成 blockmap，并重新计算 `latest.yml` 的
   size/sha512；USB ZIP 必须校验两个自有 PE 的 Authenticode、重算 JSON，并通过签名后
   `test:packaged:win:full`，再上传所有版本化文件。旧 channel manifest 必须最后切换，不能先删除
   线上目录。
4. 在 new-api 管理端登记并核对 installer/portable release 记录，确认下载 URL 指向已经存在的不可变
   文件；所有字段核验完成后再启用记录。
5. 执行 `pnpm run test:update-channel -- --version <target>`，再验证 GitHub Release 和真实客户端
   下载；完成版本矩阵覆盖升级、90 秒启动确认及失败回滚后，才将该版本标记为正式 latest。

发布回滚：先禁用或恢复 new-api 上一版 release 记录，再把旧 OSS channel manifest 恢复到上一版；
版本化文件和 archive 不删除。客户端运行时回滚仍使用升级前完整状态备份和旧应用包，不让旧版直接
覆盖已经由新版写入的状态。

## 9. 用户产品验收清单

验收前记录当前分支、应用/OpenClaw 版本和开始时间，保留重要会话，不运行 `doctor --fix`。每个场景
使用独立新会话；失败时记录 session key、发生时间、截图和对应日志时间窗，避免用刷新页面掩盖问题。

| ID | 操作 | 通过标准 | 失败判据 |
| --- | --- | --- | --- |
| U1 | 发送一段要求回复 3 至 5 段文字的普通问题 | 首段尽快出现，文字持续增长，最终内容完整 | 长时间空白后整段突然出现、缺字或重复 |
| U2 | 发送“先回复、调用一个只读工具、再回复” | 用户消息、前置回复、工具过程、最终回复顺序固定 | 中间消息跳到末尾、同一回复出现两次或工具前后错位 |
| U3 | 在 U2 完成后切换会话再返回，并刷新一次页面 | 已有消息位置和内容不变，不新增历史副本 | 旧消息突然插入中间或在末尾再次出现 |
| U4 | 在一轮仍流式输出或工具执行时断开再恢复 Gateway | 页面保持进行中语义，恢复后续接同一轮并最终收敛 | 提前显示结束，随后又冒出新消息，或恢复后形成第二个 Turn |
| U5 | 保持默认 `tools.exec.security=full`、`ask=off` 执行命令；再仅在专用测试配置切到 ask 模式复测 | 默认不弹审批；ask 模式只弹一次且允许/拒绝都能正确收敛 | 默认误弹、ask 不弹、重复弹窗或审批后 Turn 卡住 |
| U6 | 在已有长上下文会话继续发送多轮工具和文本请求 | 需要时自动压缩，压缩后仍继续回复且历史可读 | 请求过长直接终止、压缩失败后假装完成或会话永久无响应 |
| U7 | 在专用测试配置触发一次 OpenAI 请求失败，然后连续发送下一轮 | 失败的当前调用才降级 DeepSeek；下一轮重新先走 OpenAI | 一次失败后整轮会话永久停留在 DeepSeek，或向用户暴露内部降级错误 |
| U8 | 生成一张图片，等待真实附件出现后再离开会话 | 只出现一个生成过程和一张结果图，附件可打开后才结束 pending | 先回复“已生成”但图片晚到、图片重复或 Gateway 重启 |
| U9 | 生成一个 6 秒、默认 480P 的视频 | 收到 task_id 后持续查询，服务端完成后 UI 及时结束并只展示一个视频 | 服务端已完成但 UI 一直生成中、重复视频或结果归到其他 Turn |
| U10 | 分别在图片和视频仍进行时取消 | 当前任务进入取消态，provider 请求停止且之后不再投递附件 | 取消后仍显示成功、延迟出现媒体或取消了其他任务 |
| U11 | 完成包含文本、工具、图片或视频的会话后退出并重新启动应用 | Gateway 自动恢复，当前会话历史、媒体和任务终态一致 | 启动卡死、消息丢失、任务回到 pending 或媒体所有权变化 |
| U12 | 打开 500 条以上历史的长会话，持续滚动、展开/收起工具详情并发送新消息 | 滚动锚点稳定，输入和流式渲染无明显卡顿 | 阅读位置跳变、内容重叠、输入阻塞或列表整页重排 |

本地产品验收要求所有适用场景通过。U1/U2/U3/U4/U8/U9 任一出现重复、乱序、提前完成或 Gateway
重启即判定失败，不以刷新后恢复为通过。Windows 原生覆盖升级、SignPath 和生产更新入口按用户决定
在本轮暂缓，不能用本表通过替代对应发布门禁。
