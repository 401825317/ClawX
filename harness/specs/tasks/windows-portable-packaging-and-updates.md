---
id: windows-portable-packaging-and-updates
title: Migrate UClaw Windows USB packaging and update delivery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add a reproducible Windows x64 USB package, isolated portable runtime state, verified portable updates, and release gates without changing chat or OpenClaw event rendering behavior.
touchedAreas:
  - .github/workflows/package-win-manual.yml
  - .github/workflows/release.yml
  - .github/workflows/win-build-test.yml
  - README.ja-JP.md
  - README.md
  - README.ru-RU.md
  - README.zh-CN.md
  - electron-builder.yml
  - electron/gateway/config-sync.ts
  - electron/gateway/reload-policy.ts
  - electron/main/index.ts
  - electron/main/ipc-handlers.ts
  - electron/main/updater.ts
  - electron/main/portable-update-security.ts
  - electron/main/portable-update-installer.ts
  - electron/services/files-api.ts
  - electron/services/acp-chat-service.ts
  - electron/services/acp-session-access-registry.ts
  - electron/services/updates-api.ts
  - electron/utils/agent-config.ts
  - electron/utils/channel-config.ts
  - electron/utils/openclaw-auth-sqlite.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/openclaw-workspace.ts
  - electron/utils/paths.ts
  - electron/utils/plugin-install.ts
  - electron/utils/portable-bootstrap.ts
  - electron/utils/portable-mode.ts
  - electron/utils/portable-runtime-state.ts
  - electron/utils/proxy-fetch.ts
  - electron/utils/skill-config.ts
  - electron/utils/skill-quick-access.ts
  - electron/utils/wechat-login.ts
  - electron/utils/whatsapp-login.ts
  - harness/specs/tasks/windows-portable-packaging-and-updates.md
  - package.json
  - scripts/after-pack.cjs
  - scripts/bundle-openclaw-plugins.mjs
  - scripts/build-portable-updater.mjs
  - scripts/build-usb-release.mjs
  - scripts/build-windows-self-check.mjs
  - scripts/download-bundled-*.mjs
  - scripts/openclaw-bundle-config.mjs
  - scripts/run-electron-builder.mjs
  - scripts/windows-support/**
  - shared/host-api/contract.ts
  - shared/i18n/locales/**/settings.json
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - src/components/settings/UpdateSettings.tsx
  - src/components/update/UpdateNotifier.tsx
  - src/stores/update.ts
  - tests/unit/**
  - tools/portable-updater/**
expectedUserBehavior:
  - A Windows x64 USB ZIP starts with an empty UClawData directory and keeps account, OpenClaw, and Electron state beside the portable package or in its isolated local runtime profile.
  - High-frequency OpenClaw state uses a per-USB local runtime profile and is copied back only through complete, verified snapshots.
  - Portable update checks use the managed UClaw update API while installed builds continue to use electron-updater.
  - A downloaded USB update is installed only after filename, ZIP signature, size, and SHA-512 verification.
  - Portable update installation preserves UClawData, rolls back application files on failure, and restarts the updated executable.
  - Existing chat, media, authentication, Provider, skill, and OpenClaw event behavior is unchanged.
  - The logical default chat workspace resolves inside the active isolated OpenClaw state directory, so ACP sessions can load and send prompts in portable mode.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
  - active-config-guards
  - packaged-runtime-pruning-guards
  - ui-i18n-design-tokens
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm exec vitest run tests/unit/portable-update-security.test.ts tests/unit/portable-runtime-state.test.ts tests/unit/updates-api.test.ts
  - pnpm exec vitest run tests/unit/files-api-workspace.test.ts tests/unit/acp-session-access-registry.test.ts tests/unit/acp-chat-service.test.ts
  - go test ./...
  - pnpm harness validate --spec harness/specs/tasks/windows-portable-packaging-and-updates.md
acceptance:
  - package:win:usb requires a clean source tree, prepares Windows x64 runtime binaries, builds the portable updater, builds win-unpacked, creates portable.flag and an empty UClawData, and emits UClaw-<version>-win-x64-usb.zip plus companion JSON metadata.
  - The companion metadata contains version, platform, architecture, package type, file name, byte size, SHA-512, Git commit, build ID, and release date.
  - afterPack writes a build identity containing package version, Git commit, source-tree state, platform, architecture, build ID, and timestamp.
  - Portable state uses a durable portable ID and a local per-ID OpenClaw state directory; only snapshots with a complete manifest are restored.
  - The default workspace alias and its descendants resolve to `<OPENCLAW_STATE_DIR>/workspace` consistently in Files API validation, ACP access grants, and ACP prompt cwd checks.
  - Snapshot creation uses stable file copies, atomic completion, path-boundary validation, and bounded retention.
  - The renderer calls update operations only through src/lib/host-api.ts; no new direct IPC or Gateway HTTP calls are added.
  - Portable update URLs and timeouts are defined by shared/junfeiai-endpoints.json and validated before use.
  - Windows CI uploads USB ZIP and metadata as build artifacts; production registration or deployment is not performed automatically.
  - Installed Windows release metadata is refreshed after signing and validated before artifacts are published.
  - Plugin packaging starts from a clean mirror, uses one required-plugin manifest for build and release validation, and includes the local image plugin with its runtime dependencies under resources/openclaw-plugins.
docs:
  required: true
---

## Migration Boundary

The reference implementation is `/Users/xianshengnihao/code/SelfCode/ClawX` on
`master`. Port the packaging and updater contracts, but adapt them to this
repository's Typed Host API and current bundled runtime. Do not copy the
reference repository's legacy direct-IPC renderer implementation, old backend
helper names, feature-branch workflow triggers, or unrelated media/chat code.

## Platform Verification

macOS development can validate TypeScript, unit tests, Go tests, metadata logic,
and workflow structure. The final `package:win:usb` command, PE architecture
checks, NSIS lifecycle validation, and real update replacement must run on a
Windows x64 host or Windows GitHub Actions runner.
