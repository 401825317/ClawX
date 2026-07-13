---
id: chat-final-runtime-ended
title: Close chat runtime lifecycle from terminal final events
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Ensure a terminal Gateway chat final produces one structured run.ended event so Main runtime tracking, renderer lifecycle state, and terminal history refresh converge even when OpenClaw omits a native lifecycle completion event.
touchedAreas:
  - harness/specs/tasks/chat-final-runtime-ended.md
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/event-dispatch.ts
  - electron/gateway/manager.ts
  - shared/chat-runtime-events.ts
  - src/stores/chat.ts
  - src/stores/gateway.ts
  - scripts/chat-final-runtime-replay.test.ts
expectedUserBehavior:
  - A completed assistant reply always closes the matching foreground run.
  - Intermediate tool-use finals keep the run open until a terminal assistant reply arrives.
  - Duplicate chat finals or a native lifecycle completion do not fan out duplicate run.ended events.
  - Runs with the same run ID in different sessions remain isolated.
  - Chat error and aborted events release Main runtime tracking with the matching terminal status.
  - Synthesized terminal events do not start duplicate history or backend-idle polling before the legacy final is applied.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - comms-regression
requiredTests:
  - pnpm exec tsx --test scripts/chat-final-runtime-replay.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-run-state-events.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Terminal assistant chat finals synthesize a completed run.ended event with the original sessionKey and runId.
  - Message-less terminal events still close an identified run, while payloads without sessionKey or runId do not.
  - Tool-use, function-call, and result-only intermediate finals do not synthesize run.ended.
  - Chat error and aborted states synthesize matching terminal statuses through both supported chat dispatch paths.
  - Terminal event deduplication is constant-time, session-scoped, and memory-bounded.
  - Native lifecycle terminal events remain authoritative over synthesized terminal events.
  - The legacy chat:message event is still delivered unchanged.
docs:
  required: false
---
