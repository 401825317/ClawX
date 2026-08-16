---
id: measure-and-prewarm-acp-first-response
title: Measure and prewarm ACP first response
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Measure Renderer-to-first-text ACP latency and remove avoidable cold bridge and duplicate session-load work without changing Chat session creation semantics.
touchedAreas:
  - harness/specs/tasks/measure-and-prewarm-acp-first-response.md
  - shared/acp-chat/types.ts
  - electron/services/acp-chat-service.ts
  - electron/services/chat-api.ts
  - src/stores/acp-chat-session.ts
  - src/pages/Chat/index.tsx
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - Opening UClaw starts ACP connection initialization in the background once the Gateway is ready, so the first Chat turn can reuse the initialized bridge.
  - A warmup failure never blocks Chat startup and a later session load still retries through the normal readiness and connection path.
  - A pending ACP session load is reused by the matching send path instead of dispatching an identical second load.
  - Locally created sidebar placeholders still create their backing ACP session only on first send.
  - ACP diagnostics expose bounded phase durations from Renderer send start through Main receipt, ACP dispatch, first visible assistant text, and prompt completion.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - acp-chat-state-and-history
  - diagnostics-trace-safety
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/acp-chat-service.test.ts tests/unit/acp-chat-store.test.ts tests/unit/chat-acp-page.test.tsx
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/measure-and-prewarm-acp-first-response.md
  - pnpm harness run --spec harness/specs/tasks/measure-and-prewarm-acp-first-response.md --dry-run
acceptance:
  - Renderer supplies a client start timestamp through the typed Host API prompt payload, and Main treats invalid or future timestamps as Main receipt time.
  - Main records session/prompt:first-text at most once per live prompt and only for a non-empty agent_message_chunk text block.
  - The first-text trace contains non-negative clientToMainMs, mainToDispatchMs, dispatchToFirstTextMs, and clientToFirstTextMs durations without prompt text, paths, or credentials.
  - Prompt completion trace records whether first text was observed and includes bounded non-negative completion durations.
  - ACP connection warmup is fire-and-forget, shares ensureConnection initialization with normal loads, and preserves Gateway readiness recovery.
  - Matching in-flight page loads share one Promise while a different load intent can replace the reusable reference.
  - Existing local-placeholder tests continue to prove that no backing ACP session is created before first send.
  - No provider selection, model options, tool inventory, transcript authority, or visible Chat presentation changes in this task.
docs:
  required: true
---

## Scope

Add phase diagnostics and remove bridge/session-load work that can be performed or shared before prompt dispatch. Keep the optimization generic across prompts and models.

## Out Of Scope

- Reducing the OpenClaw tool inventory or changing tool selection.
- Special-casing short prompts such as `hi`.
- Precreating backing ACP sessions for abandoned local placeholders.
- Changing provider, model, reasoning, context, transcript, or timeline behavior.
- Claiming browser paint time or provider-native time-to-first-token; the measured endpoint is the first visible assistant text chunk observed by Electron Main.
