
<p align="center">
  <img src="src/assets/logo.svg" width="128" height="128" alt="ClawX Logo" />
</p>

<h1 align="center">ClawX</h1>

<p align="center">
  <strong>OpenClaw AI 智能体的桌面客户端</strong>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#为什么选择-clawx">为什么选择 ClawX</a> •
  <a href="#快速上手">快速上手</a> •
  <a href="#系统架构">系统架构</a> •
  <a href="#开发指南">开发指南</a> •
  <a href="#参与贡献">参与贡献</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-MacOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/electron-41+-47848F?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?logo=react" alt="React" />
  <a href="https://discord.com/invite/84Kex3GGAh" target="_blank">
  <img src="https://img.shields.io/discord/1399603591471435907?logo=discord&labelColor=%20%235462eb&logoColor=%20%23f5f5f5&color=%20%235462eb" alt="chat on Discord" />
  </a>
  <img src="https://img.shields.io/github/downloads/ValueCell-ai/ClawX/total?color=%23027DEB" alt="Downloads" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

<p align="center">
  <a href="README.md">English</a> | 简体中文 | <a href="README.ja-JP.md">日本語</a> | <a href="README.ru-RU.md">Русский</a>
</p>

---

## 概述

**ClawX** 是连接强大 AI 智能体与普通用户之间的桥梁。基于 [OpenClaw](https://github.com/OpenClaw) 构建，它将命令行式的 AI 编排转变为易用、美观的桌面体验——无需使用终端。

无论是自动化工作流、连接通讯软件，还是调度智能定时任务，ClawX 都能提供高效易用的图形界面，帮助你充分发挥 AI 智能体的能力。

ClawX 预置了最佳实践的模型供应商配置，原生支持 Windows 平台以及多语言设置。当然，你也可以通过 **设置 → 高级 → 开发者模式** 来进行精细的高级配置。

<p align="center"><strong style="font-size:1.1em; text-decoration: underline;">如需完整的企业版、专属服务支持或面向您业务场景的定制化落地辅导，请联系 <a href="mailto:public@valuecell.ai">public@valuecell.ai</a>。</strong></p>

---

## 截图预览

<p align="center">
  <img src="resources/screenshot/zh/chat.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/zh/cron.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/zh/skills.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/zh/channels.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/zh/models.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/zh/settings.png" style="width: 100%; height: auto;">
</p>

---

## 为什么选择 ClawX

构建 AI 智能体不应该需要精通命令行。ClawX 的设计理念很简单：**强大的技术值得拥有一个尊重用户时间的界面。**

| 痛点 | ClawX 解决方案 |
|------|----------------|
| 复杂的命令行配置 | 一键安装，配合引导式设置向导 |
| 手动编辑配置文件 | 可视化设置界面，实时校验 |
| 进程管理繁琐 | 自动管理网关生命周期 |
| 应用更新 | 启动时检查新版本，并在下载或安装前提示确认 |
| 多 AI 供应商切换 | 统一的供应商配置面板 |
| 技能/插件安装复杂 | 内置技能市场与管理界面 |

### 内置 OpenClaw 核心

ClawX 直接基于官方 **OpenClaw** 核心构建。无需单独安装，我们将运行时嵌入应用内部，提供开箱即用的无缝体验。

我们致力于与上游 OpenClaw 项目保持严格同步，确保你始终可以使用官方发布的最新功能、稳定性改进和生态兼容性。

打开开发者模式后，侧边栏还会提供原生 Dreams 页面，可在 ClawX 内查看 OpenClaw 记忆回顾、梦境日记，并执行基础维护操作；需要更深诊断时仍可从该页面打开完整 OpenClaw Dreams UI。

---

## 功能特性

### 🎯 零配置门槛
从安装到第一次 AI 对话，全程通过直观的图形界面完成。无需终端命令，无需 YAML 文件，无需到处寻找环境变量。

### 💬 智能聊天界面
通过现代化的聊天体验与 AI 智能体交互。支持多会话上下文、消息历史记录、Markdown 富文本渲染（包括 GitHub 风格表格以及由 KaTeX 渲染的 LaTeX 数学公式：`$行内$`、`$$块级$$`、`\(行内\)` 和 `\[块级\]`），以及在多 Agent 场景下通过主输入框中的 `@agent` 直接路由到目标智能体。
从输入框插入的技能会以 `/技能名` 卡片形式显示；点击卡片可在右侧预览栏打开并阅读该技能的 `SKILL.md`。
当你使用 `@agent` 选择其他智能体时，ClawX 会直接切换到该智能体自己的对话上下文，而不是经过默认智能体转发。各 Agent 工作区默认彼此分离，但更强的运行时隔离仍取决于 OpenClaw 的 sandbox 配置。
每个会话都可以在聊天工具栏中选择独立的项目目录。ClawX 会随会话恢复该目录，将其用于 Agent 和工具执行，并把工具返回的本地文件产物写入其中的 `outputs/`；未设置时继续使用 Agent 工作空间，且该会话运行期间不能切换目录。

本地产物执行采用“审查、修复、验证”闭环：由当前文本模型完成语义规划，主题、长度、媒体和交互等明确要求随实际选中的能力或持久任务一起保存。完成状态只由真实工具/任务终态、能力专属验证和规范会话交付共同决定；模型不再先调用元数据工具给自己的执行授权，也不能用声明证明已经完成。
独立 PPT 请求现在走 `presentation-maker` 视觉工作室：agent 先做叙事、素材和逐页构图，再由 `create_designed_pptx_file` 用 PptxGenJS 自由画布写入图片、图表、表格、形状和文本。五套内置语义主题只保留给 `create_pptx_file` 与迁移前任务恢复做基础兜底，不再冒充高设计主链路。
每个 Agent 还可以单独覆盖自己的 `provider/model` 运行时设置；未覆盖的 Agent 会继续继承全局默认模型。
零至无限托管安装将 `openai` 保留给登录账户的 Relay。启动时会把旧 `lingzhiwuxian/*` 引用，以及此前个人 OpenAI 的账户或端点一并迁移为托管的原生 Responses 配置。旧 provider 仍保留为 Chat Completions 兼容路径；JSON 损坏、模型引用键冲突和写入失败仍会中止迁移。
Gateway 启动前，同一套幂等流程会把聊天收敛为使用托管 372K 上下文和配置推理默认等级的 `openai/smart-latest`，并在首个 Agent 回合前准备好图片和视频 Provider。只有 `/responses` 在尚未开始输出时返回 404，才会回退一次 Chat Completions。
在 Agents 页面，你可以输入粗略的角色名称和职责、选择内置头像，让模型生成更专业的 Agent 画像和开场消息，并在创建后直接进入该 Agent 的独立对话。

聊天、图片和视频的新请求共用同一个 OpenClaw Agent loop。模式只提供本轮结构化媒体约束和已选产物；Agent 根据当前请求、参考输入和已公布的 provider 能力决定是否调用原生媒体工具，并显式选择视频模型。视频模式中的尺寸和时长只会在该工具已被选中后补到参数中，配置里的默认视频模型不会再被悄悄注入成 provider 覆盖。聊天和视频即使共用 `openai` provider 命名空间，聊天模型也不会因此进入视频候选；`video_generate` 会在请求 provider 前拒绝未公布的模型，而不是偷偷替换。上述值绝不会拼接进模型提示词。模式不在 Renderer 侧运行意图 planner 或媒体队列。原生任务与内置 Host Task Bridge 持久化 `session/run/tool-call/idempotency` 身份和由实际能力生成的验收要求；任务终态、产物、验证、审批和部分失败直接回到原会话，Renderer 只投影这些事实，不再自行做一次语义完成裁决。会话在 `yield` 后需要消费持久完成注入时，最多只会安排一次带稳定标签的同会话完成播报。旧 direct planner POST 端点统一返回 `410`，新请求全部进入 Agent loop。

`VideoProject` 是每个最终视频请求的持久项目壳，无论它是单段还是多镜头：它记录创作约束、参考图血缘、稳定镜头身份、provider 尝试、QA 决策、合成和交付。实际生成仍复用现有 `video_generate`；UClaw Host 对每段做可确定的媒体事实校验，并输出联系表供 Agent 做语义复核，不会谎称本地 OCR 或主观画面、音频判断已经完成。
本地视频合成默认保留视频模型生成的原始音轨。神经网络或系统 TTS 只在用户明确要求旁白，或源视频确实缺少可用语音时作为可选叠加层，并以背景混音方式保留原声，不再无条件替换每段模型音轨。
图片格式、背景和兼容的压缩参数会真实透传给图片 provider；用户未自定义时，托管安装的生成媒体交付上限默认为 16 MiB。若生成结果仍超过上限，UClaw 会在保存前自动转码并逐级压缩，不再丢弃 provider 已成功生成的图片。即使内部完成消息被隔离，任务账本中的成功、失败、部分完成或取消终态也会立即关闭等待状态和计时。

桌面观察当前只支持截图；原生桌面动作驱动尚未实现，本版本也不宣称 Computer Use 可以操作 UClaw 窗口。内置 Blender runtime 接收声明式 SceneSpec，在不加载启动扩展的本地 Blender 中渲染，并校验 `.blend`、`.glb`、预览图和 manifest 后再投递到会话。Blender 是可选的本地依赖，平台或可执行文件不可用时会明确返回能力状态，不会把未产出当作完成；三维预览只会在打开兼容模型文件时按需加载，不增加普通聊天路径的负担。

### 📡 多频道管理
同时配置和监控多个 AI 频道。每个频道独立运行，允许你为不同任务运行专门的智能体。
现在每个频道支持多个账号，并可在 Channels 页面直接完成账号绑定到 Agent 与默认账号切换。
对于自定义频道账号 ID，ClawX 现在会强制校验 OpenClaw 兼容的规范格式（`[a-z0-9_-]`、小写、最长 64 位、且必须以字母或数字开头），避免路由匹配异常。
ClawX 现在还内置了腾讯官方个人微信渠道插件，可直接在 Channels 页面通过内置二维码流程完成微信连接。

### ⏰ 定时任务自动化
调度 AI 任务自动执行。定义触发器、设置时间间隔，让 AI 智能体 7×24 小时不间断工作。
现在定时任务页面已经可以直接配置外部投递，统一拆成“发送账号”和“接收目标”两个下拉选择。对于已支持的通道，接收目标会从通道目录能力或已知会话历史中自动发现，不需要再手动修改 `jobs.json`。


### 🧩 可扩展技能系统
通过预构建的技能扩展 AI 智能体的能力。集成的 Skills 页面采用“本地优先”方式：会扫描托管目录与 workspace 技能目录，并且无需依赖 Gateway 即可启用或停用技能；当 OpenClaw runtime 可用时，也会接入公共 ClawHub marketplace，用于搜索和安装社区技能。
Skills 页面可展示来自多个 OpenClaw 来源的技能（托管目录、workspace、额外技能目录），并显示每个技能的实际路径，便于直接打开真实安装位置。对于 OpenClaw 自带的 bundled skills，社区版现在在打包产物里只保留并展示 `skill-creator`；更大的技能目录来自公共 ClawHub 搜索/安装。开发模式和打包版启动时都会直接清理其它 bundled skill，同时把这些已删除 bundled skill 在 `openclaw.json` 中残留的旧配置一并移除。

### 🔐 安全的供应商集成
连接多个 AI 供应商（OpenAI、Anthropic 等），凭证安全存储在系统原生密钥链中。OpenAI 同时支持 API Key 与浏览器 OAuth（Codex 订阅）登录。
在开发者模式下，独立的“图像生成”页面支持配置 OpenAI 兼容生图端点（Base URL、API Key 和模型名，例如 `gpt-image-2`），生图请求会走专用的 `/v1/images/generations` 服务，聊天仍继续使用正常的 OpenAI Provider。
如果你通过 **自定义（Custom）Provider** 对接 OpenAI-compatible 网关，可以在 **设置 → AI Providers → 编辑 Provider** 中配置自定义 `User-Agent`，以提高兼容性。
如果兼容网关的 `/models` 因非鉴权原因不可用，ClawX 会在校验 API Key 时自动降级为轻量的 `/chat/completions` 或 `/responses` 探测。
替换 API Key 并成功通过校验后，UClaw 会在刷新 Gateway 前清除该账号持久化的认证失败状态，让已经修正的 Provider 立即恢复可选，同时保留正常的 401 防护。

### 🌙 自适应主题
支持浅色模式、深色模式或跟随系统主题。ClawX 自动适应你的偏好设置。

### 🚀 开机启动控制
在 **设置 → 通用** 中，你可以开启 **开机自动启动**，让 ClawX 在系统登录后自动启动。

### 🔔 更新提示
ClawX 可以在启动时自动检查新版本。发现更新后会显示应用内提示；只有在你选择操作后，才会下载或安装更新。Windows 安装版升级会保留旧安装目录直到新文件解压成功；解压失败时会先恢复旧目录再退出安装器。

### 💾 高性能便携模式
macOS 可通过 `pnpm package:mac:usb`、Windows 可通过 `pnpm package:win:usb` 生成免安装可直接运行包。该模式会把应用设置、登录状态、Chromium 会话状态、OpenClaw 配置、Agent、会话、技能和通道凭据保存在随包的 `UClawData/` 中，因此插到另一台电脑后仍能看到原来的记录；更新下载、Python、uv、临时文件、日志、崩溃转储、浏览器磁盘缓存和编译缓存会放到当前电脑的本机目录 `UClawRuntime/`，避免 U 盘被频繁读写拖慢或快速占满。新生成的包一定从空白 `UClawData/` 开始，不会带入打包电脑上的账号或运行状态。更新时，portable helper 会先确认当前进程已经退出，再保留旧版应用文件，直到新版确认完成关键 Main 进程初始化；如果无法确认旧版退出，不会替换任何文件。如果更新包校验、解压、替换、新版启动或 90 秒启动确认失败，会自动恢复并重启旧版，且不会替换或删除 `UClawData/`。

Windows 打包必须从已经提交且 worktree 干净的源码开始，并会先清理旧的解包目录和历史 USB 产物。封装阶段会核对源码版本、Git commit 与 `app.asar`，把随包的 4 个 Windows 可执行文件全部校验为 x64 PE，并检查 12 个 UClaw 内置及渠道/搜索插件和它们的运行依赖，随后生成 `uclaw-usb-build.json` 和配套发布 JSON；任何身份或内容不一致都会直接让构建失败，不再发布看似成功的旧包。

Windows USB ZIP 根目录内置 `UClaw-SelfCheck.cmd`。用户无需安装 Node.js、Python 或 Git，双击即可检查构建身份、包内和已安装插件副本、随包运行时、目录读写与原子 rename、本地端口、zz-cn 连通性和 OpenClaw Doctor 状态。动态检查只扫描最近 24 小时且不早于当前构建的日志。脱敏后的支持报告默认保存在 `UClawData/diagnostics/`；U 盘不可写时会回退到本机临时目录。

---

## 快速上手

### 系统要求

- **操作系统**：macOS 11+、Windows 10+ 或 Linux（Ubuntu 20.04+）
- **内存**：最低 4GB RAM（推荐 8GB）
- **存储空间**：1GB 可用磁盘空间

### 安装方式

#### 预构建版本（推荐）

从 [Releases](https://github.com/ValueCell-ai/ClawX/releases) 页面下载适用于你平台的最新版本。

#### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/ValueCell-ai/ClawX.git
cd ClawX

# 初始化项目
pnpm run init

# 以开发模式启动
pnpm dev
```
### 首次启动

首次启动 ClawX 时，**设置向导** 将引导你完成以下步骤：

1. **语言与区域** – 配置你的首选语言和地区
2. **AI 供应商** – 通过 API 密钥或 OAuth（支持浏览器/设备登录的供应商）添加账号
3. **技能包** – 选择适用于常见场景的预配置技能
4. **验证** – 在进入主界面前测试你的配置

如果系统语言在支持列表中，向导会默认选中该语言；否则回退到英文。

> Moonshot（Kimi）说明：ClawX 默认保持开启 Kimi 的 web search。  
> 当配置 Moonshot 后，ClawX 也会将 OpenClaw 配置中的 Kimi web search 同步到中国区端点（`https://api.moonshot.cn/v1`）。

### 代理设置

ClawX 内置了代理设置，适用于需要通过本地代理客户端访问外网的场景，包括 Electron 本身、OpenClaw Gateway，以及 Telegram 这类频道的联网请求。

打开 **设置 → 网关 → 代理**，配置以下内容：

- **代理服务器**：所有请求默认使用的代理
- **绕过规则**：需要直连的主机，使用分号、逗号或换行分隔
- 在 **开发者模式** 下，还可以单独覆盖：
  - **HTTP 代理**
  - **HTTPS 代理**
  - **ALL_PROXY / SOCKS**

本地代理的常见填写示例：

```text
代理服务器: http://127.0.0.1:7890
```
说明：

- 只填写 `host:port` 时，会按 HTTP 代理处理。
- 高级代理项留空时，会自动回退到“代理服务器”。
- 保存代理设置后，Electron 网络层会立即重新应用代理，并自动重启 Gateway。
- 如果启用了 Telegram，ClawX 还会把代理同步到 OpenClaw 的 Telegram 频道配置中。
- 当 ClawX 代理处于关闭状态时，Gateway 的常规重启会保留已有的 Telegram 频道代理配置。
- 如果你要明确清空 OpenClaw 中的 Telegram 代理，请在关闭代理后点一次“保存代理设置”。
- 在 **设置 → 高级 → 开发者** 中，可以直接运行 **OpenClaw Doctor**，执行 `openclaw doctor --json` 并在应用内查看诊断输出。
- 在 Windows 打包版本中，内置的 `openclaw` CLI/TUI 会通过随包分发的 `node.exe` 入口运行，以保证终端输入行为稳定。

---

## 系统架构

ClawX 采用 **双进程 + Host API 统一接入架构**。渲染进程只调用统一客户端抽象，协议选择与进程生命周期由 Electron 主进程统一管理：

```
┌───────────────────────────────────────────────────────────────────┐
│                        ClawX 桌面应用                              │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              Electron 主进程                                 │  │
│  │  • 窗口与应用生命周期管理                                       │  │
│  │  • 网关进程监控                                               │  │
│  │  • 系统集成（托盘、通知、密钥链）                                │  │
│  │  • 自动更新编排                                               │  │
│  └─────────────────────────────────────────────────────────────┘  │
│                              │                                    │
│                              │ IPC (权威控制面)                     │
│                              ▼                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │              React 渲染进程                                  │  │
│  │  • 现代组件化 UI（React 19）                                  │  │
│  │  • Zustand 状态管理                                          │  │
│  │  • 统一 host-api/api-client 调用                             │  │
│  │  • Markdown 富文本渲染                                       │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ 主进程统一传输策略
                               │（WS 优先，HTTP 次之，IPC 回退）
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Host API 与主进程代理层                          │
│                                                                 │
│  • hostapi:fetch（主进程代理，规避开发/生产 CORS）                  │
│  • gateway:httpProxy（渲染进程不直连 Gateway HTTP）                │
│  • 统一错误映射与重试/退避策略                                      │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               │ WS / HTTP / IPC 回退
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                     OpenClaw 网关                                │
│                                                                 │
│  • AI 智能体运行时与编排                                           │
│  • 消息频道管理                                                   │
│  • 技能/插件执行环境                                               │
│  • 供应商抽象层                                                   │
└─────────────────────────────────────────────────────────────────┘
```
### 设计原则

- **进程隔离**：AI 运行时在独立进程中运行，确保即使在高负载计算期间 UI 也能保持响应
- **前端调用单一入口**：渲染层统一走 host-api/api-client，不感知底层协议细节
- **主进程掌控传输策略**：WS/HTTP 选择与 IPC 回退在主进程集中处理，提升稳定性
- **优雅恢复**：内置重连、超时、退避逻辑，自动处理瞬时故障
- **安全存储**：API 密钥和敏感数据利用操作系统原生的安全存储机制
- **CORS 安全**：本地 HTTP 请求由主进程代理，避免渲染进程跨域问题

### 进程模型与 Gateway 排障

- ClawX 基于 Electron，**单个应用实例出现多个系统进程是正常现象**（main/renderer/zygote/utility）。
- 单实例保护同时使用 Electron 自带锁与本地进程文件锁回退机制，可在桌面会话总线异常时避免重复启动。
- 核心运行时监听必须保持**单一所有者**：Host API `127.0.0.1:13210` 与 OpenClaw Gateway `127.0.0.1:18789` 必须归属于同一个 UClaw 桌面实例。
- 安装版与便携版升级混跑时，UClaw 会在创建桌面窗口前检查共享实例锁和两个端口的进程树。只有确认属于旧版 UClaw/ClawX 时才会提供退出旧版的选项；无法确认身份的进程绝不会被自动结束。
- 临时 OAuth 回调、系统动态分配的回环端口、开发服务器和外部供应商端口不由该启动守卫接管。
- Gateway readiness 以 OpenClaw 的 `system-presence`、`health`、`status` 等核心信号为准；memory、Dreams 或频道失败会显示为能力降级，而不是全局 Gateway 故障。
- 可用以下命令确认监听进程：
  - macOS/Linux：`lsof -nP -iTCP:13210 -sTCP:LISTEN` 和 `lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - Windows（PowerShell）：`Get-NetTCPConnection -LocalPort 13210,18789 -State Listen`
- 点击窗口关闭按钮（`X`）默认只是最小化到托盘，并不会完全退出应用。请在托盘菜单中选择 **Quit ClawX** 执行完整退出。

---

## 使用场景

### 🤖 个人 AI 助手
配置一个通用 AI 智能体，可以回答问题、撰写邮件、总结文档并协助处理日常任务——全部通过简洁的桌面界面完成。

### 📊 自动化监控
设置定时智能体来监控新闻动态、追踪价格变动或监听特定事件。结果将推送到你偏好的通知渠道。

### 💻 开发者效率工具
将 AI 融入你的开发工作流。使用智能体进行代码审查、生成文档或自动化重复性编码任务。

### 🔄 工作流自动化
将多个技能串联起来，创建复杂的自动化流水线。处理数据、转换内容、触发操作——全部通过可视化方式编排。

---

## 开发指南

### 前置要求

- **Node.js**：22+（推荐 LTS 版本）
- **包管理器**：pnpm 9+（推荐）或 npm
- **Linux（Ubuntu/Debian）**：运行 Electron 前，请先安装所需系统库：
  ```bash
  sudo apt-get install -y libnss3 libgtk-3-0 libxss1 libxtst6 libatspi2.0-0 libnotify4 xdg-utils
  ```
  在 Ubuntu 24.04+ 上，部分软件包使用 `t64` 后缀，运行上述命令后 `apt` 会自动选择正确版本。

### 项目结构

```ClawX/
├── electron/                 # Electron 主进程
│   ├── api/                 # 主进程 API 路由与处理器
│   │   └── routes/          # RPC/HTTP 代理路由模块
│   ├── services/            # Provider、Secrets 与运行时服务
│   │   ├── providers/       # Provider/account 模型同步逻辑
│   │   └── secrets/         # 系统钥匙串与密钥存储
│   ├── shared/              # 共享 Provider schema/常量
│   │   └── providers/
│   ├── main/                # 应用入口、窗口、IPC 注册
│   ├── gateway/             # OpenClaw 网关进程管理
│   ├── preload/             # 安全 IPC 桥接
│   └── utils/               # 工具模块（存储、认证、路径）
├── src/                      # React 渲染进程
│   ├── lib/                 # 前端统一 API 与错误模型
│   ├── stores/              # Zustand 状态仓库（settings/chat/gateway）
│   ├── components/          # 可复用 UI 组件
│   ├── pages/               # Setup/Dashboard/Chat/Channels/Skills/Cron/Settings
│   ├── i18n/                # 国际化资源
│   └── types/               # TypeScript 类型定义
├── tests/
│   └── e2e/                 # Playwright Electron 端到端冒烟测试
├── resources/                # 静态资源（图标、图片）
└── scripts/                  # 构建与工具脚本
```
### 常用命令

```bash
# 开发
pnpm run init             # 安装依赖并下载捆绑二进制（uv、agent-browser）
pnpm dev                  # 以热重载模式启动（若缺失会自动准备预装技能包）

# 代码质量
pnpm lint                 # 运行 ESLint 检查
pnpm typecheck            # TypeScript 类型检查

# 测试
pnpm run test:e2e         # 运行 Electron E2E 冒烟测试
pnpm run test:e2e:headed  # 以可见窗口运行 Electron E2E 测试
pnpm run test:packaged:win       # 对最新 Windows USB ZIP 执行核心真实回归
pnpm run test:packaged:win:full  # 执行打包版聊天、工具、浏览器、Cron、Agent 和媒体完整回归
pnpm run comms:replay     # 计算通信回放指标
pnpm run comms:baseline   # 刷新通信基线快照
pnpm run comms:compare    # 将回放指标与基线阈值对比

# 单元测试
# 本项目不再维护单元测试；产品行为由项目负责人本地手动验收。

# 构建与打包
pnpm run build:vite       # 仅构建前端
pnpm build                # 完整生产构建（含打包资源）
pnpm package              # 为当前平台打包（包含预装技能资源）
pnpm package:mac          # 为 macOS 打包
pnpm package:mac:usb      # 为 macOS 生成免安装高性能便携包
pnpm package:win          # 为 Windows 打包
pnpm package:win:usb      # 生成 Windows USB ZIP，并自动通过打包版完整回归门禁
pnpm package:linux        # 为 Linux 打包
```

在无头 Linux 环境下，Electron 测试需要显示服务；可使用 `xvfb-run -a pnpm run test:e2e`。

### 通信回归检查

当 PR 涉及通信链路（Gateway 事件、Chat 收发流程、Channel 投递、传输回退）时，建议执行：

```bash
pnpm run comms:replay
pnpm run comms:compare
```

CI 中的 `comms-regression` 会校验必选场景与阈值。
### 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Electron 41+ |
| UI 框架 | React 19 + TypeScript |
| 样式 | Tailwind CSS + shadcn/ui |
| 状态管理 | Zustand |
| 构建工具 | Vite + electron-builder |
| 测试 | Vitest + Playwright |
| 动画 | Framer Motion |
| 图标 | Lucide React |

---

## 参与贡献

我们欢迎社区的各种贡献！无论是修复 Bug、开发新功能、改进文档还是翻译——每一份贡献都让 ClawX 变得更好。

### 如何贡献

1. **Fork** 本仓库
2. **创建** 功能分支（`git checkout -b feature/amazing-feature`）
3. **提交** 清晰描述的变更
4. **推送** 到你的分支
5. **创建** Pull Request

### 贡献规范

- 遵循现有代码风格（ESLint + Prettier）
- 为新功能编写测试
- 按需更新文档
- 保持提交原子化且描述清晰

---

## 致谢

ClawX 构建于以下优秀的开源项目之上：

- [OpenClaw](https://github.com/OpenClaw) – AI 智能体运行时
- [Electron](https://www.electronjs.org/) – 跨平台桌面框架
- [React](https://react.dev/) – UI 组件库
- [shadcn/ui](https://ui.shadcn.com/) – 精美设计的组件库
- [Zustand](https://github.com/pmndrs/zustand) – 轻量级状态管理

---

## 社区

加入我们的社区，与其他用户交流、获取帮助、分享你的使用体验。

| 企业微信 | 飞书群组 | Discord |
| :---: | :---: | :---: |
| <img src="src/assets/community/wecom-qr.png" width="150" alt="企业微信二维码" /> | <img src="src/assets/community/feishu-qr.png" width="150" alt="飞书二维码" /> | <img src="src/assets/community/20260212-185822.png" width="150" alt="Discord 二维码" /> |

### ClawX 合作伙伴计划 🚀

我们正在启动 ClawX 合作伙伴计划，寻找能够帮助我们将 ClawX 介绍给更多客户的合作伙伴，尤其是那些有定制化 AI 智能体或自动化需求的客户。

合作伙伴负责帮助我们连接潜在用户和项目，ClawX 团队则提供完整的技术支持、定制开发与集成服务。

如果你服务的客户对 AI 工具或自动化方案感兴趣，欢迎与我们合作。

欢迎私信我们，或发送邮件至 [public@valuecell.ai](mailto:public@valuecell.ai) 了解更多。

---

## Stars 历史

<p align="center">
  <img src="https://api.star-history.com/svg?repos=ValueCell-ai/ClawX&type=Date" alt="Stars 历史图表" />
</p>

---

## 许可证

ClawX 基于 [MIT 许可证](LICENSE) 发布。你可以自由地使用、修改和分发本软件。

---

<p align="center">
  <sub>由 ValueCell 团队用 ❤️ 打造</sub>
</p>
