
<p align="center">
  <img src="src/assets/logo.svg" width="128" height="128" alt="ClawX Logo" />
</p>

<h1 align="center">ClawX</h1>

<p align="center">
  <strong>The Desktop Interface for OpenClaw AI Agents</strong>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#why-clawx">Why ClawX</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#development">Development</a> •
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-MacOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platform" />
  <img src="https://img.shields.io/badge/electron-40+-47848F?logo=electron" alt="Electron" />
  <img src="https://img.shields.io/badge/react-19-61DAFB?logo=react" alt="React" />
  <a href="https://discord.com/invite/84Kex3GGAh" target="_blank">
  <img src="https://img.shields.io/discord/1399603591471435907?logo=discord&labelColor=%20%235462eb&logoColor=%20%23f5f5f5&color=%20%235462eb" alt="chat on Discord" />
  </a>
  <img src="https://img.shields.io/github/downloads/ValueCell-ai/ClawX/total?color=%23027DEB" alt="Downloads" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="License" />
</p>

<p align="center">
  English | <a href="README.zh-CN.md">简体中文</a> | <a href="README.ja-JP.md">日本語</a> | <a href="README.ru-RU.md">Русский</a>
</p>

---

## Overview

**ClawX** bridges the gap between powerful AI agents and everyday users. Built on top of [OpenClaw](https://github.com/OpenClaw), it transforms command-line AI orchestration into an accessible, beautiful desktop experience—no terminal required.

Whether you're automating workflows, managing AI-powered channels, or scheduling intelligent tasks, ClawX provides the interface you need to harness AI agents effectively.

ClawX comes pre-configured with best-practice model providers and natively supports Windows as well as multi-language settings. Of course, you can also fine-tune advanced configurations via **Settings → Advanced → Developer Mode**.

<p align="center"><strong style="font-size:1.1em; text-decoration: underline;">For a full enterprise edition, dedicated service support, or tailored deployment guidance for your business scenario, contact us at <a href="mailto:public@valuecell.ai">public@valuecell.ai</a>.</strong></p>

---
## Screenshot

<p align="center">
  <img src="resources/screenshot/en/chat.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/en/cron.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/en/skills.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/en/channels.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/en/models.png" style="width: 100%; height: auto;">
</p>

<p align="center">
  <img src="resources/screenshot/en/settings.png" style="width: 100%; height: auto;">
</p>

---

## Why ClawX

Building AI agents shouldn't require mastering the command line. ClawX was designed with a simple philosophy: **powerful technology deserves an interface that respects your time.**

| Challenge | ClawX Solution |
|-----------|----------------|
| Complex CLI setup | One-click installation with guided setup wizard |
| Configuration files | Visual settings with real-time validation |
| Process management | Automatic gateway lifecycle management |
| App updates | Startup update checks with a prompt before downloading or installing |
| Multiple AI providers | Unified provider configuration panel |
| Skill/plugin installation | Local-first skill management with optional extension-provided marketplace |

### OpenClaw Inside

ClawX is built directly upon the official **OpenClaw** core. Instead of requiring a separate installation, we embed the runtime within the application to provide a seamless "battery-included" experience.

We are committed to maintaining strict alignment with the upstream OpenClaw project, ensuring that you always have access to the latest capabilities, stability improvements, and ecosystem compatibility provided by the official releases.

When Developer Mode is enabled, the sidebar also provides a native Dreams page for OpenClaw memory review, dream diary inspection, and basic maintenance actions. The full upstream OpenClaw Dreams UI remains available from that page when deeper diagnostics are needed.

---

## Features

### 🎯 Zero Configuration Barrier
Complete the entire setup—from installation to your first AI interaction—through an intuitive graphical interface. No terminal commands, no YAML files, no environment variable hunting.

### 💬 Intelligent Chat Interface
Communicate with AI agents through a modern chat experience. Support for multiple conversation contexts, message history, rich content rendering with Markdown (including GitHub-flavored tables and KaTeX-powered LaTeX math: `$inline$`, `$$block$$`, `\(inline\)`, and `\[block\]`), and direct `@agent` routing in the main composer for multi-agent setups.
Skills you insert from the composer appear as `/skill-name` chips; click a chip to open the preview sidebar and read that skill's `SKILL.md`.
When you target another agent with `@agent`, ClawX switches into that agent's own conversation context directly instead of relaying through the default agent. Agent workspaces stay separate by default, and stronger isolation depends on OpenClaw sandbox settings.
Each conversation can select its own project directory from the chat toolbar. ClawX restores that directory with the session, uses it for agent and tool work, and keeps tool-returned local artifacts in its `outputs/` folder; without an override, the Agent workspace remains the default, and the directory cannot be changed while that session is running.

Local artifact work follows a review-repair-validate loop: the current text model produces the semantic plan, while explicit subject, length, media, and interaction requirements travel with the selected capability or durable task. Completion is derived from real tool/task terminal state, capability-specific verification, and canonical conversation delivery; the model does not make a separate metadata tool call to authorize or prove its own work.
Standalone presentation requests now use the `presentation-maker` visual studio: the agent plans the narrative, sources assets, and authors each slide before `create_designed_pptx_file` writes images, charts, tables, shapes, and text on a PptxGenJS free canvas. The five built-in semantic themes remain only as a basic fallback for `create_pptx_file` and recovery of pre-migration jobs; they are no longer presented as the high-design path.
Desktop observation currently supports screenshots only. The native desktop action driver is not implemented, and this release does not claim that Computer Use can operate the UClaw window. The bundled Blender runtime accepts a declarative SceneSpec, runs local Blender without loading startup add-ons, verifies its `.blend`, `.glb`, preview, and manifest artifacts, and exposes the verified result in chat. Blender remains an optional local dependency; capability discovery reports unavailable platforms or executables instead of pretending a task completed. Chat previews load the 3D viewer only when a compatible model artifact is opened, keeping the normal chat path light.
Fresh chat, image, and video turns share the same OpenClaw Agent loop. Modes contribute per-turn structured media constraints and selected artifacts; the Agent decides whether to invoke native media and explicitly selects a video model from the current request, reference inputs, and advertised provider capabilities. Video-mode geometry and duration are applied only after that tool selection, while a configured UI default model is never silently injected as a provider override. Shared chat models never become video candidates merely because both capabilities use the `openai` provider namespace; `video_generate` rejects a non-advertised model before the provider request instead of replacing it. These values are never concatenated into the model prompt, and modes do not run a renderer-side intent planner or media queue. Native tasks and the bundled Host Task Bridge persist session/run/tool-call/idempotency identity together with capability-derived acceptance requirements. Terminal task, artifact, verification, approval, and partial-failure events return directly to the same conversation; the Renderer projects those facts without making another semantic completion decision. A yielded session gets at most one tagged same-session announcement after its durable completion injection and runtime events are ready. Retired direct planner POST endpoints return `410`, and new requests enter through the Agent loop.

VideoProject is the durable envelope for every requested final video, whether it is a single clip or a multi-shot video: it records the creative constraints, reference-image lineage, stable shot identity, provider attempts, QA decisions, composition, and delivery. The existing `video_generate` tool remains the generator. UClaw Host verifies deterministic media facts for each shot and emits a contact sheet for Agent semantic review; it does not claim local OCR or subjective visual/audio judgement.
Generated video audio is preserved through local composition by default. Neural or system TTS is used only as an explicit narration layer or fallback for missing source speech, and is mixed over source sound instead of replacing every model-generated track.
Each agent can also override its own `provider/model` runtime setting; agents without overrides continue inheriting the global default model.
Managed JunFeiAI installs reserve `openai` for the signed-in Relay account. During startup, legacy `lingzhiwuxian/*` references and any earlier personal `openai` account or endpoint are migrated to the managed native Responses configuration. The legacy provider remains a Chat Completions compatibility path, while malformed JSON, model-reference collisions, and write failures still stop the migration.
Before Gateway starts, the same idempotent bootstrap converges chat on `openai/smart-latest` with the managed 372K context and configured reasoning default, and prepares managed image and video providers for the first Agent turn. Native Responses only falls back to Chat Completions when `/responses` returns 404 before output begins.
From the Agents page, you can create a persona-style agent by entering a rough role and responsibility, choosing a built-in avatar, letting the model generate a polished profile and opening message, and then jumping straight into that agent's dedicated chat.

### 📡 Multi-Channel Management
Configure and monitor multiple AI channels simultaneously. Each channel operates independently, allowing you to run specialized agents for different tasks.
Each channel now supports multiple accounts, per-account agent binding, and switching the channel default account directly from the Channels page.
For custom channel account IDs, ClawX enforces OpenClaw-compatible canonical IDs (`[a-z0-9_-]`, lowercase, max 64 chars, must start with a letter/number) to prevent routing mismatches.
ClawX now also bundles Tencent's official personal WeChat channel plugin, so you can link WeChat directly from the Channels page with an in-app QR flow.

### ⏰ Cron-Based Automation
Schedule AI tasks to run automatically. Define triggers, set intervals, and let your AI agents work around the clock without manual intervention.
The Cron page now lets you configure external delivery directly in the task form with separate sender-account and recipient-target selectors. For supported channels, recipient targets are discovered automatically from channel directories or known session history, so you no longer need to edit `jobs.json` by hand.


### 🧩 Extensible Skill System
Extend your AI agents with pre-built skills. The integrated Skills page is local-first: it scans managed/workspace skill directories, lets you enable or disable skills without depending on the Gateway, and exposes the public ClawHub marketplace for searching and installing community skills when the OpenClaw runtime is present.
The Skills page can display skills discovered from multiple OpenClaw sources (managed dir, workspace, and extra skill dirs), and now shows each skill's actual location so you can open the real folder directly. For package-bundled OpenClaw skills, community builds still ship and expose only `skill-creator`; the broader catalog is available through public ClawHub search/install. Non-allowlisted bundled skills are physically trimmed in both dev and packaged startup, and any stale `openclaw.json` entries left behind for those removed bundled skills are pruned.

### 🔐 Secure Provider Integration
Connect to multiple AI providers (OpenAI, Anthropic, and more) with credentials stored securely in your system's native keychain. OpenAI supports both API key and browser OAuth (Codex subscription) sign-in.
In developer mode, the dedicated Image Generation page supports an independent OpenAI-compatible image-generation endpoint (Base URL, API key, and model name such as `gpt-image-2`) so image generation can use a dedicated `/v1/images/generations` service while chat continues using the normal OpenAI provider.
Requested image format, background, and compatible compression options are forwarded to the image provider. Managed installs default generated-media delivery to 16 MiB when the user has not set a custom limit. If an image is still too large, UClaw automatically transcodes and progressively compresses it before saving instead of discarding a provider-successful result; terminal task-ledger state also closes the pending UI even when internal completion envelopes stay hidden.
For **Custom** providers used with OpenAI-compatible gateways, you can set a custom `User-Agent` in **Settings → AI Providers → Edit Provider** for compatibility-sensitive endpoints.
When a compatible gateway rejects `/models` for non-auth reasons, ClawX automatically falls back to a lightweight `/chat/completions` or `/responses` probe during API key validation.

### 🌙 Adaptive Theming
Light mode, dark mode, or system-synchronized themes. ClawX adapts to your preferences automatically.

### 🚀 Startup Launch Control
In **Settings → General**, you can enable **Launch at system startup** so ClawX starts automatically after login.

### 🔔 Update Prompts
ClawX can automatically check for new versions on startup. When an update is available, it shows an in-app prompt; downloading and installing only happen after you choose the action.

### 💾 High-Performance Portable Mode
Use `pnpm package:mac:usb` for macOS and `pnpm package:win:usb` for Windows to create an install-free portable build. The app keeps settings, sign-in and Chromium session state, OpenClaw config, agents, sessions, skills, and channel credentials in the bundled `UClawData/` folder, so records follow the USB drive to another machine. Rebuildable or machine-local data such as update downloads, Python, uv, temporary files, logs, crash dumps, browser disk cache, and compile cache is stored on the host machine under `UClawRuntime/` to avoid slow USB reads/writes and unnecessary drive growth. A newly packaged artifact always starts with an empty `UClawData/`; it never inherits the packager's account or runtime state.

The Windows packaging flow requires a committed, clean source tree and removes stale unpacked builds and old USB artifacts before building. Finalization verifies the source version and Git commit against `app.asar`, checks all four shipped Windows executables as x64 PE files, validates all 12 bundled UClaw and channel/search plugins with their runtime dependencies, and writes `uclaw-usb-build.json` plus a companion release JSON. The build fails instead of publishing when these identities or package contents disagree.

The Windows USB ZIP includes `UClaw-SelfCheck.cmd` at its root. Users can double-click it without installing Node.js, Python, or Git to verify the build identity, bundled and installed plugin copies, runtime files, writable directories, local ports, zz-cn connectivity, and OpenClaw Doctor status. Dynamic checks only scan logs from the last 24 hours and not older than the packaged build. A redacted support report is saved under `UClawData/diagnostics/`, with a local temporary-directory fallback when the USB drive is not writable.

---

## Getting Started

### System Requirements

- **Operating System**: macOS 11+, Windows 10+, or Linux (Ubuntu 20.04+)
- **Memory**: 4GB RAM minimum (8GB recommended)
- **Storage**: 1GB available disk space

### Installation

#### Pre-built Releases (Recommended)

Download the latest release for your platform from the [Releases](https://github.com/ValueCell-ai/ClawX/releases) page.

#### Build from Source

```bash
# Clone the repository
git clone https://github.com/ValueCell-ai/ClawX.git
cd ClawX

# Initialize the project
pnpm run init

# Start in development mode
pnpm dev
```
### First Launch

When you launch ClawX for the first time, the **Setup Wizard** will guide you through:

1. **Language & Region** – Configure your preferred locale
2. **AI Provider** – Add providers with API keys or OAuth (for providers that support browser/device login)
3. **Skill Bundles** – Select pre-configured skills for common use cases
4. **Verification** – Test your configuration before entering the main interface

The wizard preselects your system language when it is supported, and falls back to English otherwise.

> Note for Moonshot (Kimi): ClawX keeps Kimi web search enabled by default.  
> When Moonshot is configured, ClawX also syncs Kimi web search to the China endpoint (`https://api.moonshot.cn/v1`) in OpenClaw config.

### Proxy Settings

ClawX includes built-in proxy settings for environments where Electron, the OpenClaw Gateway, or channels such as Telegram need to reach the internet through a local proxy client.

Open **Settings → Gateway → Proxy** and configure:

- **Proxy Server**: the default proxy for all requests
- **Bypass Rules**: hosts that should connect directly, separated by semicolons, commas, or new lines
- In **Developer Mode**, you can optionally override:
  - **HTTP Proxy**
  - **HTTPS Proxy**
  - **ALL_PROXY / SOCKS**

Recommended local examples:

```text
Proxy Server: http://127.0.0.1:7890
```
Notes:

- A bare `host:port` value is treated as HTTP.
- If advanced proxy fields are left empty, ClawX falls back to `Proxy Server`.
- Saving proxy settings reapplies Electron networking immediately and restarts the Gateway automatically.
- ClawX also syncs the proxy to OpenClaw's Telegram channel config when Telegram is enabled.
- Gateway restarts preserve an existing Telegram channel proxy if ClawX proxy is currently disabled.
- To explicitly clear Telegram channel proxy from OpenClaw config, save proxy settings with proxy disabled.
- In **Settings → Advanced → Developer**, you can run **OpenClaw Doctor** to execute `openclaw doctor --json` and inspect the diagnostic output without leaving the app.
- On packaged Windows builds, the bundled `openclaw` CLI/TUI runs via the shipped `node.exe` entrypoint to keep terminal input behavior stable.

---

## Architecture

ClawX employs a **dual-process architecture** with a unified host API layer. The renderer talks to a single client abstraction, while Electron Main owns protocol selection and process lifecycle:

```
┌──────────────────────────────────────────────────────────────────┐
│                        ClawX Desktop App                         │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              Electron Main Process                         │  │
│  │  • Window & application lifecycle management               │  │
│  │  • Gateway process supervision                             │  │
│  │  • System integration (tray, notifications, keychain)      │  │
│  │  • Auto-update orchestration                               │  │
│  └────────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              │ IPC (authoritative control plane) │
│                              ▼                                   │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │              React Renderer Process                        │  │
│  │  • Modern component-based UI (React 19)                    │  │
│  │  • State management with Zustand                           │  │
│  │  • Unified host-api/api-client calls                       │  │
│  │  • Rich Markdown rendering                                 │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ Main-owned transport strategy
                               │ (WS first, HTTP then IPC fallback)
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                Host API & Main Process Proxies                   │
│                                                                  │
│  • hostapi:fetch (Main proxy, avoids CORS in dev/prod)           │
│  • gateway:httpProxy (Renderer never calls Gateway HTTP direct)  │
│  • Unified error mapping & retry/backoff                         │
└──────────────────────────────┬───────────────────────────────────┘
                               │
                               │ WS / HTTP / IPC fallback
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                     OpenClaw Gateway                             │
│                                                                  │
│  • AI agent runtime and orchestration                            │
│  • Message channel management                                    │
│  • Skill/plugin execution environment                            │
│  • Provider abstraction layer                                    │
└──────────────────────────────────────────────────────────────────┘
```
### Design Principles

- **Process Isolation**: The AI runtime operates in a separate process, ensuring UI responsiveness even during heavy computation
- **Single Entry for Frontend Calls**: Renderer requests go through host-api/api-client; protocol details are hidden behind a stable interface
- **Main-Process Transport Ownership**: Electron Main controls WS/HTTP usage and fallback to IPC for reliability
- **Graceful Recovery**: Built-in reconnect, timeout, and backoff logic handles transient failures automatically
- **Secure Storage**: API keys and sensitive data leverage the operating system's native secure storage mechanisms
- **CORS-Safe by Design**: Local HTTP access is proxied by Main, preventing renderer-side CORS issues

### Process Model & Gateway Troubleshooting

- ClawX is an Electron app, so **one app instance normally appears as multiple OS processes** (main/renderer/zygote/utility). This is expected.
- Single-instance protection uses Electron's lock plus a local process-file lock fallback, preventing duplicate app launch in environments where desktop IPC/session bus is unstable.
- Core runtime listeners are **single-owner**: Host API `127.0.0.1:13210` and OpenClaw Gateway `127.0.0.1:18789` must belong to the same UClaw desktop instance.
- During installed/portable upgrades, UClaw checks the shared instance lock and both listener process trees before opening the desktop window. It can offer to close a verified older UClaw/ClawX process; an unknown process is never terminated automatically.
- Temporary OAuth callbacks, dynamically allocated loopback listeners, development servers, and external provider ports are not taken over by this startup guard.
- Gateway readiness is based on OpenClaw core signals such as `system-presence`, `health`, and `status`; memory, Dreams, or channel failures are shown as capability degradation instead of global Gateway failure.
- To verify the active listeners:
  - macOS/Linux: `lsof -nP -iTCP:13210 -sTCP:LISTEN` and `lsof -nP -iTCP:18789 -sTCP:LISTEN`
  - Windows (PowerShell): `Get-NetTCPConnection -LocalPort 13210,18789 -State Listen`
- Clicking the window close button (`X`) hides ClawX to tray; it does **not** fully quit the app. Use tray menu **Quit ClawX** for complete shutdown.

---

## Use Cases

### 🤖 Personal AI Assistant
Configure a general-purpose AI agent that can answer questions, draft emails, summarize documents, and help with everyday tasks—all from a clean desktop interface.

### 📊 Automated Monitoring
Set up scheduled agents to monitor news feeds, track prices, or watch for specific events. Results are delivered to your preferred notification channel.

### 💻 Developer Productivity
Integrate AI into your development workflow. Use agents to review code, generate documentation, or automate repetitive coding tasks.

### 🔄 Workflow Automation
Chain multiple skills together to create sophisticated automation pipelines. Process data, transform content, and trigger actions—all orchestrated visually.

---

## Development

### Prerequisites

- **Node.js**: 22+ (LTS recommended)
- **Package Manager**: pnpm 9+ (recommended) or npm
- **Linux (Ubuntu/Debian)**: Install required system libraries before running Electron:
  ```bash
  sudo apt-get install -y libnss3 libgtk-3-0 libxss1 libxtst6 libatspi2.0-0 libnotify4 xdg-utils
  ```
  On Ubuntu 24.04+, some packages use a `t64` suffix; run the above command and `apt` will automatically select the correct variant.

### Project Structure

```ClawX/
├── electron/                 # Electron Main Process
│   ├── api/                 # Main-side API router and handlers
│   │   └── routes/          # RPC/HTTP proxy route modules
│   ├── services/            # Provider, secrets and runtime services
│   │   ├── providers/       # Provider/account model sync logic
│   │   └── secrets/         # OS keychain and secret storage
│   ├── shared/              # Shared provider schemas/constants
│   │   └── providers/
│   ├── main/                # App entry, windows, IPC registration
│   ├── gateway/             # OpenClaw Gateway process manager
│   ├── preload/             # Secure IPC bridge
│   └── utils/               # Utilities (storage, auth, paths)
├── src/                      # React Renderer Process
│   ├── lib/                 # Unified frontend API + error model
│   ├── stores/              # Zustand stores (settings/chat/gateway)
│   ├── components/          # Reusable UI components
│   ├── pages/               # Setup/Dashboard/Chat/Channels/Skills/Cron/Settings
│   ├── i18n/                # Localization resources
│   └── types/               # TypeScript type definitions
├── tests/
│   └── e2e/                 # Playwright Electron end-to-end smoke tests
├── resources/                # Static assets (icons/images)
└── scripts/                  # Build and utility scripts
```
### Available Commands

```bash
# Development
pnpm run init             # Install dependencies + download bundled binaries (uv, agent-browser)
pnpm dev                  # Start with hot reload (auto-prepares bundled skills if missing)

# Quality
pnpm lint                 # Run ESLint
pnpm typecheck            # TypeScript validation

# Testing
pnpm run test:e2e         # Run Electron E2E smoke tests with Playwright
pnpm run test:e2e:headed  # Run Electron E2E tests with a visible window
pnpm run comms:replay     # Compute communication replay metrics
pnpm run comms:baseline   # Refresh communication baseline snapshot
pnpm run comms:compare    # Compare replay metrics against baseline thresholds

# Unit tests
# Unit tests are intentionally not maintained; product behavior is verified manually by the project owner.

# Build & Package
pnpm run build:vite       # Build frontend only
pnpm build                # Full production build (with packaging assets)
pnpm package              # Package for current platform (includes bundled preinstalled skills)
pnpm package:mac          # Package for macOS
pnpm package:mac:usb      # Package an install-free high-performance portable macOS folder
pnpm package:win          # Package for Windows
pnpm package:win:usb      # Package an install-free high-performance portable Windows folder
pnpm package:linux        # Package for Linux
```

On headless Linux, run Electron tests under a display server such as `xvfb-run -a pnpm run test:e2e`.

### Communication Regression Checks

When a PR changes communication paths (gateway events, chat runtime send/receive flow, channel delivery, or transport fallback), run:

```bash
pnpm run comms:replay
pnpm run comms:compare
```

`comms-regression` in CI enforces required scenarios and threshold checks.

### Electron E2E Tests

The Playwright Electron suite launches the packaged renderer and main process
from `dist/` and `dist-electron/`, so it does not require manually running
`pnpm dev` first.

`pnpm run test:e2e` automatically:

- builds the renderer and Electron bundles with `pnpm run build:vite`
- starts Electron in an isolated E2E mode with a temporary `HOME`
- uses a temporary ClawX `userData` directory
- skips heavy startup side effects such as gateway auto-start, bundled skill
  installation, tray creation, and CLI auto-install

The first two baseline specs cover:

- first-launch setup wizard visibility on a fresh profile
- skipping setup and navigating to the Models page inside the Electron app

Add future Electron flows under `tests/e2e/` and reuse the shared fixture in
`tests/e2e/fixtures/electron.ts`.
### Tech Stack

| Layer | Technology |
|-------|------------|
| Runtime | Electron 40+ |
| UI Framework | React 19 + TypeScript |
| Styling | Tailwind CSS + shadcn/ui |
| State | Zustand |
| Build | Vite + electron-builder |
| Testing | Vitest + Playwright |
| Animation | Framer Motion |
| Icons | Lucide React |

---

## Contributing

We welcome contributions from the community! Whether it's bug fixes, new features, documentation improvements, or translations—every contribution helps make ClawX better.

### How to Contribute

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes with clear messages
4. **Push** to your branch
5. **Open** a Pull Request

### Guidelines

- Follow the existing code style (ESLint + Prettier)
- Write tests for new functionality
- Update documentation as needed
- Keep commits atomic and descriptive

---

## Acknowledgments

ClawX is built on the shoulders of excellent open-source projects:

- [OpenClaw](https://github.com/OpenClaw) – The AI agent runtime
- [Electron](https://www.electronjs.org/) – Cross-platform desktop framework
- [React](https://react.dev/) – UI component library
- [shadcn/ui](https://ui.shadcn.com/) – Beautifully designed components
- [Zustand](https://github.com/pmndrs/zustand) – Lightweight state management

---

## Community

Join our community to connect with other users, get support, and share your experiences.

| Enterprise WeChat | Feishu Group | Discord |
| :---: | :---: | :---: |
| <img src="src/assets/community/wecom-qr.png" width="150" alt="WeChat QR Code" /> | <img src="src/assets/community/feishu-qr.png" width="150" alt="Feishu QR Code" /> | <img src="src/assets/community/20260212-185822.png" width="150" alt="Discord QR Code" /> |

### ClawX Partner Program 🚀

We're launching the ClawX Partner Program and looking for partners who can help introduce ClawX to more clients, especially those with custom AI agent or automation needs.

Partners help connect us with potential users and projects, while the ClawX team provides full technical support, customization, and integration.

If you work with clients interested in AI tools or automation, we'd love to collaborate.

DM us or email [public@valuecell.ai](mailto:public@valuecell.ai) to learn more.

---

## Star History

<p align="center">
  <img src="https://api.star-history.com/svg?repos=ValueCell-ai/ClawX&type=Date" alt="Star History Chart" />
</p>

---

## License

ClawX is released under the [MIT License](LICENSE). You're free to use, modify, and distribute this software.

---

<p align="center">
  <sub>Built with ❤️ by the ValueCell Team</sub>
</p>
