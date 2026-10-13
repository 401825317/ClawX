---
id: fix-gateway-config-refresh-dedup
title: Deduplicate Gateway configuration refresh without losing changes
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Refresh only changed or unconfirmed runtime configuration, merge startup and concurrent writes, and retain required Windows restart behavior with diagnostic reasons.
touchedAreas:
  - harness/specs/tasks/fix-gateway-config-refresh-dedup.md
  - electron/gateway/manager.ts
  - electron/services/agents-api.ts
  - electron/utils/openclaw-auth-sqlite.ts
  - tests/unit/gateway-manager-config-refresh.test.ts
  - tests/unit/agents-api-config-refresh.test.ts
  - tests/unit/host-services.test.ts
  - README.ja-JP.md
  - README.md
  - README.zh-CN.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/specs/tasks/acp-media-attachments.md
  - harness/specs/tasks/fix-acp-local-cancellation.md
  - harness/specs/tasks/fix-client-call-failures.md
  - package.json
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-acp-binding-isolation-patch.mjs
  - scripts/openclaw-acp-terminal-error-patch.mjs
  - scripts/openclaw-provider-terminal-error-patch.mjs
  - shared/acp-chat/errors.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - shared/i18n/locales/zh/chat.json
  - src/pages/Chat/AcpTurnFailureCard.tsx
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/index.tsx
  - src/stores/acp-chat-session.ts
  - tests/e2e/chat-attachment-preflight.spec.ts
  - tests/e2e/chat-local-cancellation.spec.ts
  - tests/packaged-e2e/fixtures/deterministic-openai-server.ts
  - tests/packaged-e2e/portable-regression.spec.ts
  - tests/unit/acp-binding-isolation.test.ts
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/unit/openclaw-acp-terminal-error-patch.test.ts
  - tests/unit/openclaw-provider-terminal-error-patch.test.ts
expectedUserBehavior:
  - An unchanged Agent operation does not restart a Gateway whose applied configuration is confirmed identical.
  - Agent creation, model and channel changes refresh only after runtime synchronization succeeds.
  - Changes included in a controlled startup do not trigger a redundant Windows restart.
  - Changes made after the launch snapshot remain pending and refresh once startup settles.
  - An unknown applied generation is refreshed conservatively, not treated as a no-op.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/gateway-manager-config-refresh.test.ts
  - tests/unit/agents-api-config-refresh.test.ts
  - tests/unit/host-services.test.ts
  - README.ja-JP.md
  - README.md
  - README.zh-CN.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/specs/tasks/acp-media-attachments.md
  - harness/specs/tasks/fix-acp-local-cancellation.md
  - harness/specs/tasks/fix-client-call-failures.md
  - package.json
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-acp-binding-isolation-patch.mjs
  - scripts/openclaw-acp-terminal-error-patch.mjs
  - scripts/openclaw-provider-terminal-error-patch.mjs
  - shared/acp-chat/errors.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - shared/i18n/locales/zh/chat.json
  - src/pages/Chat/AcpTurnFailureCard.tsx
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/index.tsx
  - src/stores/acp-chat-session.ts
  - tests/e2e/chat-attachment-preflight.spec.ts
  - tests/e2e/chat-local-cancellation.spec.ts
  - tests/packaged-e2e/fixtures/deterministic-openai-server.ts
  - tests/packaged-e2e/portable-regression.spec.ts
  - tests/unit/acp-binding-isolation.test.ts
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/unit/openclaw-acp-terminal-error-patch.test.ts
  - tests/unit/openclaw-provider-terminal-error-patch.test.ts
  - tests/unit/gateway-manager-mutation-barrier.test.ts
  - tests/unit/gateway-manager-restart-recovery.test.ts
acceptance:
  - Compare canonical JSON contents, model catalogs and auth credentials/order; exclude writer metadata, auth cooldowns, usage and SQLite timestamps.
  - Hashes remain process-local and diagnostics never log config contents, keys, auth rows or secrets.
  - Identical pending generations merge reasons without extending debounce; later distinct generations are not swallowed.
  - Only a successful controlled launch promotes its pre-fork config fingerprint. External, failed or unconfirmed runtime generations remain unknown.
  - SIGUSR1 logs signal_sent and health_retained with configAck unconfirmed, never applied_in_place. A signal invalidates the old applied generation too, preserving a real change back to old config.
  - Windows continues to use the existing required restart path, with the originating refresh reason recorded.
  - Custom agentDir credentials are fingerprinted from their read-only SQLite primary rows or JSON fallback.
  - An unowned external Gateway cannot be refreshed by pretending reconnection applies config. Pending changes are retained until a controlled start, and failed reloads do not loop automatically.
  - Real SQLite tests use host path semantics and temporary state directories; repository artifact guards detect leaked Windows-path test files.
  - No restart budget, ACP cancellation, attachment, TLS, infrastructure, commit, push or deployment changes are introduced by this task.
docs:
  required: false
---

## Evidence Boundary

A retained PID or healthy connection after a reload signal is not a config ACK.
The Main process confirms only configuration captured before its controlled
launch after that startup connects successfully. Writes later than this snapshot
are kept separately and cannot be folded into a later disk read.

## Validation Scope

This task owns only the six paths above. The shared worktree also contains TLS,
local-cancellation and attachment work owned by the main workflow. Whole-worktree
harness coverage must be evaluated by that workflow; this spec does not expand
ownership by claiming unrelated paths. Automated Windows-policy tests on macOS
do not substitute for a newly packaged Windows installation test.

No new public API, configuration option, database migration or release action is
introduced. General README workflow updates remain owned by the main workflow.
