---
id: retry-partial-text-turns
title: Retry interrupted partial-text ACP turns
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Preserve an interrupted partial text reply while UClaw retries, then atomically replace it when the next attempt produces visible text.
touchedAreas:
  - shared/acp-chat/types.ts
  - electron/services/acp-chat-service.ts
  - src/lib/acp/reducer.ts
  - src/lib/acp/timeline-types.ts
  - src/stores/acp-chat-session.ts
  - src/pages/Chat/AcpAssistantTurn.tsx
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/acp-reducer.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/acp-chat-components.test.tsx
  - tests/e2e/chat-acp-inline-timeline.spec.ts
  - harness/specs/tasks/retry-partial-text-turns.md
  - harness/specs/scenarios/acp-chat-experience.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/reference/acp-chat.md
expectedUserBehavior:
  - A partial text reply remains visible but muted while a retry is waiting.
  - The retry status reports the bounded attempt count.
  - The first visible text from a replacement attempt removes the interrupted reply and appears in the same Renderer commit.
  - Exhausted retries retain the last interrupted reply as incomplete and show the terminal failure.
  - A turn that has observed a tool call or permission request is never replayed automatically.
  - Stopping during retry backoff prevents another upstream attempt.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-reducer.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/acp-chat-components.test.tsx
  - tests/e2e/chat-acp-inline-timeline.spec.ts
acceptance:
  - HTTP 429, retryable 5xx/timeout failures, and interrupted upstream connections can retry after partial text only when no replay-unsafe event has occurred.
  - Resolved HTTP 200 failure envelopes and replay-safe empty ACP completions enter the same bounded recovery loop instead of returning a false success.
  - Main marks the first visible replacement event with its owning user turn and attempt.
  - Renderer applies replacement cleanup and the first new text event atomically.
  - Retry status and interrupted content survive ordinary in-memory navigation.
  - No tool or permission side effect is repeated.
  - Comms replay and compare pass.
docs:
  required: false
---

This recovery is intentionally limited to text-only turns. It does not replay turns after tools, permissions, generated media, or other side-effect-capable activity.
