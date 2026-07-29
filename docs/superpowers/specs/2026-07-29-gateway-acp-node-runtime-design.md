# Gateway 与 ACP Node 运行时修复设计

## 目标

修复以下两个启动问题：

1. 打包版 Gateway 内部派生 Node 子进程时误进入 ClawX Electron 主入口，触发 `Second ClawX instance detected` 并导致 Gateway 启动失败。
2. 开发模式 ACP 从 `PATH` 选择过旧的系统 Node，因不满足 OpenClaw 的 Node 版本要求而退出。

## 方案

### Gateway

Gateway 不再直接以 `openclaw.mjs` 作为 `utilityProcess.fork` 入口。应用在受控目录生成 CommonJS wrapper，由 wrapper：

- 在导入 OpenClaw 前修补 `child_process` 的 `spawn`、`exec`、`execFile`、`fork` 及同步变体；
- 对 Node fork 或引用当前 Electron 可执行文件的命令注入 `ELECTRON_RUN_AS_NODE=1`；
- 通过 `CLAWX_OPENCLAW_ENTRY` 获取真实 OpenClaw 入口并动态导入；
- 保留 Windows 子进程隐藏窗口行为。

开发模式的 fetch preload 复用同一段子进程修补逻辑；打包模式不依赖 `NODE_OPTIONS --require`，由 wrapper 保证修补一定生效。

### ACP

开发模式不再扫描 `PATH` 选择系统 Node，而是使用当前 Electron 可执行文件作为 `child_process.fork` 的 `execPath`，并注入 `ELECTRON_RUN_AS_NODE=1`。这样 ACP 与应用绑定的 Electron Node 版本一致，不受用户本机 Node 或 PATH 顺序影响。

打包 Windows 继续优先使用随包 Node；打包 macOS 继续使用 Helper 并设置 `ELECTRON_RUN_AS_NODE=1`，其他既有平台行为保持不变。

## 错误处理

- wrapper 缺少 `CLAWX_OPENCLAW_ENTRY` 或导入失败时向 stderr 输出带固定前缀的错误并以非零码退出。
- ACP 运行时选择不新增静默回退到系统 Node，避免版本不满足时产生环境相关行为。
- 不修改 Gateway token、端口或重连策略。

## 测试

先添加回归测试并确认其在当前代码上失败：

- 打包/开发 Gateway 均通过 wrapper 启动真实 OpenClaw 入口。
- wrapper 对 `child_process.fork` 和引用 Electron `execPath` 的派生调用注入 `ELECTRON_RUN_AS_NODE=1`。
- ACP 开发模式使用 Electron `execPath`，且环境包含 `ELECTRON_RUN_AS_NODE=1`，即使 PATH 中存在旧 Node。
- 打包 Windows 仍选择随包 Node，且不设置 `ELECTRON_RUN_AS_NODE`。

实现后运行定向单元测试、TypeScript 类型检查，并检查最终 diff 不包含现有聊天 UI 改动。

## 非目标

- 不恢复 master 的全局实例锁或端口所有权保护；这些属于独立的共存安全改动。
- 不修改用户 PATH、升级用户系统 Node 或改变 CLI 安装逻辑。
- 不调整 ACP 协议、会话状态或聊天 UI。
