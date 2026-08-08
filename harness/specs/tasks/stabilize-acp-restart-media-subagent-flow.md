---
id: stabilize-acp-restart-media-subagent-flow
title: Stabilize ACP restart titles, media delivery, and subagent progress
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep Windows restart titles, generated-image delivery, and OpenClaw subagent progress stable without adding a second Chat history source or polling loop.
touchedAreas:
  - harness/specs/tasks/stabilize-acp-restart-media-subagent-flow.md
  - harness/reference/acp-chat.md
  - harness/reference/sidebar-session-attention.md
  - harness/reference/acp-generated-media-and-diagnostics.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/specs/rules/acp-compatibility-content-safety.md
  - electron/services/sessions-api.ts
  - shared/chat/types.ts
  - shared/i18n/locales/**/chat.json
  - src/components/layout/Sidebar.tsx
  - src/lib/acp/image-generation-compat.ts
  - src/lib/acp/transcript-supplement.ts
  - src/lib/acp/tool-call-groups.ts
  - src/pages/Chat/**
  - src/stores/acp-chat-session.ts
  - src/stores/chat.ts
  - src/stores/chat/session-catalog.ts
  - src/stores/chat/session-key-utils.ts
  - tests/unit/acp-*.test.ts
  - tests/unit/acp-*.test.tsx
  - tests/unit/chat-load-sessions-startup.test.ts
  - tests/unit/chat-store-session-label-fetch.test.ts
  - tests/unit/session-catalog.test.ts
  - tests/unit/session-key-utils.test.ts
  - tests/unit/sidebar-session-buckets.test.ts
  - tests/e2e/chat-acp-inline-timeline.spec.ts
expectedUserBehavior:
  - A Windows portable restart never exposes the injected working-directory envelope as a conversation title while the transcript summary is loading.
  - A generated image delivered by a live Gateway event remains visible in the current timeline and is not duplicated by a stale transcript supplement.
  - A synchronous generated image carried by a Gateway-injected structured block appears in the current Turn and its later text-only model mirror is not duplicated.
  - When a provider stream fails after delivering only a short prefix, the existing Assistant segment is extended from the failed transcript record without replaying history or inserting a message.
  - Native OpenClaw subagent sessions stay out of the ordinary sidebar while their state drives one collapsed task group in the parent timeline.
  - A yielded parent remains visibly active and keeps the composer usable until all child work returns and the parent resumes output.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - acp-chat-state-and-history
  - acp-compatibility-content-safety
  - sidebar-session-attention-authority
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/chat-store-session-label-fetch.test.ts tests/unit/sidebar-session-buckets.test.ts tests/unit/acp-chat-store.test.ts tests/unit/acp-image-generation-compat.test.ts tests/unit/sessions-api-workspace.test.ts tests/unit/session-catalog.test.ts tests/unit/session-key-utils.test.ts tests/unit/acp-tool-call-groups.test.ts tests/unit/acp-chat-components.test.tsx tests/unit/chat-load-sessions-startup.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-acp-inline-timeline.spec.ts --grep "keeps yielded subagent work"
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/stabilize-acp-restart-media-subagent-flow.md
acceptance:
  - Initial cwd-only titles are hydrated before the first session catalog publish; explicit labels and normal display names retain their existing priority.
  - Transcript and deferred image retries can supersede only reservations from the same source and cannot steal a live Gateway projection.
  - Transcript JSONL envelope ids remain available to the attachment boundary, and structured outgoing-image blocks win over later `MEDIA:` mirrors from the same image task.
  - Failed-Turn text repair is limited to one current-Turn read and a strict prefix extension of one existing Assistant segment.
  - `sessions.list` and `sessions.changed` remain the only subagent status sources; no Renderer polling or persisted reduced timeline is added.
  - Subagent rows are retained in a non-navigable status collection, excluded from startup selection and sidebar attention, and matched to the exact parent session.
  - `sessions_yield` participates in task-state reduction but its raw tool result is not shown to users.
  - The task group completes only after every matched child is terminal and later parent content is visible.
  - The bundled OpenClaw dependency remains `2026.6.10`.
docs:
  required: true
---

README translations do not require changes because product entry points, setup, transport ownership, and user commands are unchanged. Durable state and display semantics are recorded in the two architecture references listed above.

## Out Of Scope

- Modifying or upgrading OpenClaw.
- Polling subagent state from Renderer.
- Making child sessions navigable user conversations.
- Persisting a second ACP timeline or Chat history ledger.
