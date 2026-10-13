---
id: fix-acp-local-cancellation
title: Keep local cancellation independent of Gateway availability
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Settle local prompt waits and deny permissions immediately on stop while isolating late ACP events without restarting Gateway.
touchedAreas:
  - harness/specs/tasks/fix-acp-local-cancellation.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - electron/services/acp-chat-service.ts
  - electron/services/artifact-task-service.ts
  - scripts/openclaw-acp-binding-isolation-patch.mjs
  - src/stores/acp-chat-session.ts
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatInput.tsx
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/unit/acp-binding-isolation.test.ts
  - tests/e2e/chat-local-cancellation.spec.ts
  - README.md
  - README.zh-CN.md
  - harness/specs/tasks/acp-media-attachments.md
  - harness/specs/tasks/fix-client-call-failures.md
  - harness/specs/tasks/fix-gateway-config-refresh-dedup.md
  - package.json
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-acp-terminal-error-patch.mjs
  - scripts/openclaw-provider-terminal-error-patch.mjs
  - shared/acp-chat/errors.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - shared/i18n/locales/zh/chat.json
  - src/pages/Chat/AcpTurnFailureCard.tsx
  - tests/e2e/chat-attachment-preflight.spec.ts
  - tests/packaged-e2e/fixtures/deterministic-openai-server.ts
  - tests/packaged-e2e/portable-regression.spec.ts
  - tests/unit/acp-binding-isolation.test.ts
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/agents-api-config-refresh.test.ts
  - tests/unit/gateway-manager-config-refresh.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/openclaw-acp-terminal-error-patch.test.ts
  - tests/unit/openclaw-provider-terminal-error-patch.test.ts
  - README.ja-JP.md
expectedUserBehavior:
  - Stop remains available for the active turn while Gateway is not ready.
  - Stop ends local prompt waiting and cancels pending permissions without waiting for Gateway readiness or a remote acknowledgement.
  - Cancelled prompts cannot retry, dispatch after cancellation, or forward late text, tool or permission events.
  - A new prompt uses a fresh ACP protocol session ID bound to the same logical history without replacing the shared connection, restarting Gateway or replaying the cancelled request.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/unit/acp-binding-isolation.test.ts
  - tests/e2e/chat-local-cancellation.spec.ts
acceptance:
  - Gateway readiness wait is abortable for prompts, and cancellation does not initialize or wait for Gateway.
  - Remote cancellation is best effort and diagnostics distinguish notification delivery from actual upstream termination.
  - Retired ACP session IDs cannot forward late events or permissions, including events finishing asynchronous materialization.
  - Cancellation returns before preference cleanup; cleanup IDs cannot affect a newer prompt.
  - Native exec approvals without a run identity are denied after logical-session binding rotation; correctly scoped approvals and untouched sessions retain their behavior.
  - Unrelated live sessions and independently accepted media tasks retain their ownership.
  - No Gateway restart budget, TLS bypass, infrastructure changes, submission or deployment is added.
docs:
  required: true
---

## Boundary

Local stop cannot prove that an unavailable remote runtime stopped a provider
request or already-started external side effects. Only a live original ACP
connection receives the best-effort cancel notification. Logs record that boundary
without claiming remote completion. A cancelled protocol session ID is retired;
the next load uses a new ID plus the original logical sessionKey. The shared ACP
connection stays alive for unrelated sessions. Already accepted media retains
only its attachment delivery owner; cancelled text is not recovered from history.
