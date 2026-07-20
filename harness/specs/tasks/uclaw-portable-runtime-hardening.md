---
id: uclaw-portable-runtime-hardening
title: Harden UClaw portable runtime, media delivery, and quota recovery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep high-frequency OpenClaw state on a stable per-device runtime profile, make portable snapshots recoverable across disks, separate media execution from reply delivery, preserve user-owned Skills, and expose quota failures as actionable billing states.
touchedAreas:
  - .github/workflows/package-win-manual.yml
  - .github/workflows/release.yml
  - .github/workflows/win-build-test.yml
  - electron/main/index.ts
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/task-ledger-monitor.ts
  - electron/services/agent-runtime/**
  - electron/services/blender/job-store.ts
  - electron/utils/generated-media-store.ts
  - electron/utils/openclaw-video-generation-runtime.ts
  - electron/utils/portable-mode.ts
  - electron/utils/portable-runtime-state.ts
  - package.json
  - harness/specs/tasks/uclaw-portable-runtime-hardening.md
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - resources/openclaw-plugins/uclaw-artifact-guard/**
  - scripts/bundle-openclaw.mjs
  - scripts/gateway-task-ledger-monitor.test.ts
  - scripts/openclaw-plugin-skills-symlink-patch.mjs
  - scripts/openclaw-billing-error-classification-patch.mjs
  - scripts/openclaw-task-summary-delivery-patch.mjs
  - scripts/openclaw-native-media-completion-queue-patch.mjs
  - scripts/openclaw-reply-session-init-conflict-patch.mjs
  - scripts/openclaw-video-actual-spec-patch.mjs
  - scripts/openclaw-video-segment-dedupe-patch.mjs
  - scripts/openclaw-*-patch.test.mjs
  - scripts/uclaw-artifact-guard-runtime.test.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/release.mjs
  - scripts/windows-support/refresh-nsis-release-metadata.mjs
  - scripts/windows-support/run-packaged-regression.mjs
  - scripts/windows-support/validate-nsis-release.mjs
  - shared/chat-runtime-events.ts
  - src/stores/chat/**
  - src/pages/Chat/index.tsx
  - src/pages/Chat/runtime-task-visualization.ts
  - src/pages/Setup/index.tsx
  - src/i18n/locales/**
  - tests/e2e/**
  - tests/packaged-e2e/**
  - PACKAGED_REGRESSION.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
requiredProfiles:
  - fast
  - comms
  - e2e
expectedUserBehavior:
  - Moving the same portable package between supported Windows disks preserves user state through its durable portable identity and the latest verified snapshot.
  - Chat, image, video, Task Flow, history refresh, and Gateway startup continue to use the same UClaw Agent experience after runtime state moves off the portable working volume.
  - A generated image or video stays visible when automatic conversation delivery fails, and the UI explains that delivery is pending instead of reporting provider failure.
  - An insufficient balance error offers recharge and does not retry a chargeable operation automatically.
  - Existing user-owned Skill directories survive startup and managed Skill refresh, while active managed Skill directories remain continuously readable during refresh.
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - comms-regression
  - packaged-runtime-pruning-guards
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - node --test scripts/openclaw-plugin-skills-symlink-patch.test.mjs
  - node --test scripts/openclaw-billing-error-classification-patch.test.mjs
  - node scripts/openclaw-task-summary-delivery-patch.test.mjs
  - node --test scripts/openclaw-native-media-completion-queue-patch.test.mjs
  - node --test scripts/openclaw-reply-session-init-conflict-patch.test.mjs
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run test:e2e
  - pnpm run test:packaged:win:full
acceptance:
  - Portable startup creates one durable identity on the USB data volume and uses an isolated per-identity OpenClaw state directory under the local UClawRuntime profile.
  - Runtime snapshots are accepted only after stable file copies and an atomic completion manifest; incomplete snapshots are never restored.
  - Snapshot cleanup validates path boundaries and retains at most the configured number of verified snapshots.
  - Generated image, video, Host Task, Blender, and timeline state use stable UClawData or local Runtime paths instead of transient USB working paths.
  - Skill publishing copies files with a UClaw ownership manifest, fingerprints unchanged trees, updates active managed directories without a remove/rename visibility gap, and preserves ordinary user-owned entries.
  - A Skill scan without an authoritative workspace may publish discovered entries but must not reconcile or delete existing managed entries.
  - Native media execution reaches a terminal execution state and persists a local artifact contract before any reply wake; a wake or delivery failure cannot downgrade a successful provider result.
  - Reply-session initialization retries against a fresh state snapshot and serializes only the same operation lane, so media delivery cannot self-deadlock while entering reply initialization.
  - Renderer history and task projections recover a produced local artifact when session delivery is failed or pending.
  - Quota failures show a recharge action and do not offer a misleading retry action, do not mark the auth profile failed or place it in cooldown, and allow the next user-initiated request to reach the Provider immediately; transient 429 failures retain retry behavior.
  - Packaged Full verifies the exact USB artifact, fresh startup, Gateway readiness/recovery, deterministic chat/tools/media, artifact recovery, and secret redaction.
  - Live managed tests remain separate from deterministic Full and record only sanitized booleans for account, Relay, Responses, image, and video readiness.
docs:
  required: true
---

## Evidence

The Windows field log showed path-change write failures on a portable volume,
reply-session takeover conflicts, plugin Skill junction failures, successful
media providers followed by an unwoken requester session, and explicit
insufficient-quota responses rendered as generic run failures.

## Scope

This task changes runtime ownership and terminal-state contracts. It does not
grant arbitrary filesystem access, persist signed media URLs, send external
channel messages, or turn an existing-account login into registration evidence.
External delivery, payment, desktop capture, and fresh-account registration
remain explicit release gates.
