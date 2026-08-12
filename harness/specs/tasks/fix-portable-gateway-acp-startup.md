---
id: fix-portable-gateway-acp-startup
title: Stabilize portable Gateway and ACP startup
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Cache the packaged OpenClaw runtime locally and prevent Chat or ACP work from racing a not-yet-ready Gateway while preserving the existing portable snapshot authority.
touchedAreas:
  - harness/specs/tasks/fix-portable-gateway-acp-startup.md
  - harness/specs/rules/gateway-readiness-policy.md
  - electron/main/index.ts
  - electron/main/app-runtime.ts
  - electron/services/acp-chat-service.ts
  - electron/utils/control-ui-device-pairing.ts
  - electron/utils/paths.ts
  - electron/utils/openclaw-sdk.ts
  - electron/utils/portable-mode.ts
  - electron/utils/portable-openclaw-runtime.ts
  - electron/utils/video-reference-image.ts
  - shared/acp-chat/errors.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/AcpTurnFailureCard.tsx
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/acp-chat-components.test.tsx
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/openclaw-cli.test.ts
  - tests/unit/portable-openclaw-runtime.test.ts
  - tests/unit/portable-runtime-state.test.ts
  - tests/unit/video-reference-image.test.ts
expectedUserBehavior:
  - A packaged portable build may take longer on its first launch while OpenClaw is copied from the removable drive into the local portable profile; later launches reuse the verified local runtime cache.
  - Existing portable settings, conversations, SQLite files, and other durable OpenClaw state still restore from and write back through `runtime-snapshots-v2`.
  - Chat shows a Gateway-starting state and cannot load an ACP session or send a prompt until the current Gateway is both running and explicitly ready.
  - Chat becomes available from the initial Gateway status snapshot or the later ready event without requiring a page reload.
  - A Gateway restart during ACP load or send fails that operation safely and does not automatically resend a prompt.
  - Ordinary Chat images larger than 6 MiB are compressed within the supported limit when possible; otherwise Chat reports a specific image-too-large error.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - gateway-readiness-policy
  - renderer-main-boundary
  - backend-communication-boundary
  - host-api-fallback-policy
  - host-events-fallback-policy
  - acp-chat-state-and-history
  - ui-i18n-design-tokens
  - comms-regression
requiredTests:
  - pnpm exec tsc --noEmit -p tsconfig.node.json --composite false
  - pnpm exec tsc --noEmit -p tsconfig.web.json --composite false
  - pnpm exec vitest run tests/unit/portable-runtime-state.test.ts tests/unit/portable-openclaw-runtime.test.ts tests/unit/openclaw-cli.test.ts tests/unit/chat-acp-page.test.tsx tests/unit/acp-chat-service.test.ts tests/unit/acp-chat-components.test.tsx tests/unit/video-reference-image.test.ts tests/unit/acp-chat-errors.test.ts
  - pnpm run build:vite
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/fix-portable-gateway-acp-startup.md
  - pnpm harness validate --spec harness/specs/scenarios/gateway-backend-communication.md
  - pnpm harness run --spec harness/specs/scenarios/gateway-backend-communication.md --dry-run
acceptance:
  - Only packaged portable mode resolves the bundled OpenClaw program tree into a per-portable-ID local runtime cache; development mode, installed builds, and other non-portable launches retain their current path behavior.
  - The runtime cache identity changes when the packaged application or bundled OpenClaw build changes. A cache miss is assembled and verified in a staging directory, then published by atomic rename; an incomplete replacement cannot become the active runtime.
  - Gateway and OpenClaw child processes use the verified local runtime tree after portable preparation completes, while the removable package remains the source used to construct or refresh that cache.
  - The local runtime cache contains executable program files only. Existing `runtime-snapshots-v2` restore, periodic snapshot, shutdown write-back, completeness manifest, retention, and portable-ID behavior remain the sole authority for durable user state.
  - Renderer hydrates the current Gateway status snapshot before deciding whether ACP work may start, then follows subsequent Gateway status events. A missed initial event cannot leave Chat permanently blocked, and a stale snapshot cannot override a newer event.
  - Chat and ACP session load, first prompt, later prompt, and other prompt-producing side-effect paths require `state === 'running' && gatewayReady === true`; `gatewayReady: undefined` is not accepted on these paths.
  - Main repeats the readiness check immediately before ACP load and prompt dispatch, captures the runtime identity from Gateway PID, connection start, and port, and rejects completion against a changed identity.
  - A not-ready or changed Gateway returns a retryable startup/reconnect classification to the UI, but ClawX never automatically replays an ACP prompt because the first dispatch may already have reached the runtime.
  - Main remains the owner of ACP process lifecycle and readiness validation. Renderer adds no direct IPC, Gateway HTTP, Gateway WebSocket, transport fallback, polling loop, or prompt retry implementation.
  - An ordinary Chat image whose decoded payload is at most 6 MiB keeps its supported input representation. A larger image is converted or compressed to a supported payload at most 6 MiB before ACP dispatch, or fails locally as `IMAGE_TOO_LARGE` without starting the prompt.
  - `IMAGE_TOO_LARGE` has localized user-facing copy in English, Simplified Chinese, Japanese, and Russian and is not collapsed into session-load, authentication, or generic invalid-request messaging.
  - Windows x64 verification covers a real removable drive, a cleared `%LOCALAPPDATA%\\UClawRuntime` cold start, a cache-hit warm start, Gateway-starting UI, rapid Chat navigation/send attempts before readiness, restart during load/send, and repeated launches with Microsoft Defender real-time scanning enabled.
  - Windows verification runs on representative NTFS and exFAT removable media when release hardware is available, and confirms a second computer can restore portable user state from `UClawData/runtime-snapshots-v2` while rebuilding its own local program cache.
  - macOS verification covers a packaged portable launch from removable media, local cache miss/hit, Gateway readiness gating, runtime identity change, snapshot write-back, and the same small/compressible/oversize image cases.
  - Automated tests deterministically delay readiness and change runtime identity so the ACP startup race is reproducible without depending on removable-drive timing.
docs:
  required: false
---

## Existing State Authority

Portable user data already restores into a local per-portable-ID runtime profile
and writes complete snapshots back to `UClawData/runtime-snapshots-v2`. This task
does not replace that mechanism or introduce another conversation, settings, or
SQLite authority. It adds a separate local cache for the packaged OpenClaw
program tree because loading that tree directly from removable media makes
Gateway cold start timing unpredictable.

## Readiness Contract

The Gateway store has two input phases: an initial status snapshot and later
status events. Both feed one monotonic readiness decision. Chat and ACP actions
that can load runtime state or produce model-side effects stay disabled until
the exact current Gateway reports `state === 'running'` and
`gatewayReady === true`.

Main validates the same condition and runtime identity at the operation
boundary. If the Gateway changes while an operation is in flight, the operation
is rejected as interrupted. Prompt dispatch is never retried automatically;
the UI may let the user choose to send again after readiness returns.

## Platform Verification

The startup defect is timing-dependent rather than guaranteed on every drive.
Release verification therefore combines deterministic readiness/race tests with
real Windows and macOS removable-media runs. Windows cold-start coverage must
include a cleared local runtime profile and rapid user actions during startup;
warm-start coverage must prove the verified local OpenClaw cache is reused.

## Out Of Scope

- Terminating UClaw when a removable drive is removed.
- Preventing a copied portable package from running away from its original drive.
- Adding server-side licensing, media binding, or anti-copy authorization.
- Replacing or redesigning `runtime-snapshots-v2`.
- Automatically retrying or replaying an ACP prompt after Gateway interruption.
