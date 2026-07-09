---
id: uclaw-agent-runtime-contract
title: Add first-class runtime contract events for UClaw agent execution
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Give the desktop client a durable execution-layer contract for objective, plan, step progress, produced artifacts, verification results, and recoverable checkpoints so agent work can be shown and audited as product state instead of inferred from chat text.
touchedAreas:
  - harness/specs/tasks/uclaw-agent-runtime-contract.md
  - electron/utils/openclaw-auth.ts
  - shared/chat-runtime-events.ts
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/event-dispatch.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/openclaw.plugin.json
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-artifact-guard/package.json
  - scripts/openclaw-model-request-contract-patch.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/bundle-openclaw.mjs
  - src/pages/Chat/ChatInput.tsx
  - src/stores/chat/types.ts
  - src/stores/chat/runtime-graph.ts
  - src/stores/chat/runtime-progress.ts
  - src/stores/chat/runtime-contract.ts
  - src/stores/chat.ts
  - src/pages/Chat/RunProgressCard.tsx
  - src/pages/Chat/task-visualization.ts
  - tests/unit/uclaw-artifact-guard.test.ts
  - tests/unit/chat-page-execution-graph.test.tsx
  - tests/unit/gateway-event-dispatch.test.ts
  - tests/unit/gateway-events.test.ts
  - tests/unit/task-visualization.test.ts
  - tests/unit/chat-input.test.tsx
  - tests/unit/chat-target-routing.test.ts
expectedUserBehavior:
  - Agent runs can expose a structured objective and plan in the active execution graph.
  - Step progress updates replace prior state by stable identifiers instead of creating duplicate timeline noise.
  - Produced artifacts, verification results, and checkpoints can be surfaced as execution facts before the final assistant reply.
  - Ordinary chat can render a compact runtime-owned progress transcript without exposing the raw execution graph by default.
  - Heartbeat work runs in an isolated lightweight session and never reuses the interactive chat transcript.
  - Internal heartbeat, restart-continuation, and runtime-plumbing messages are removed before prompt construction and future transcript writes.
  - Safe diagnostics can prove the final provider request contract without recording prompts, credentials, tool schemas, or media payloads.
  - Existing tool lifecycle events, assistant deltas, and legacy Gateway notifications continue to work.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-events-fallback-policy
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/unit/uclaw-artifact-guard.test.ts tests/unit/uclaw-context-routing.test.ts
  - pnpm exec vitest run tests/unit/task-visualization.test.ts tests/unit/gateway-event-dispatch.test.ts tests/unit/gateway-events.test.ts tests/unit/chat-runtime-event-handlers.test.ts
  - pnpm exec vitest run tests/unit/chat-input.test.tsx tests/unit/chat-target-routing.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Shared runtime event types include objective, plan, step, artifact, verification, and checkpoint events.
  - Main process normalizes Gateway plan/artifact/verification/checkpoint streams into the shared runtime event contract.
  - Chat runtime state aggregates the new contract events with stable upsert semantics.
  - Chat execution flow produces default plan events from real run starts or send acknowledgements instead of relying only on model prose.
  - Produced file cards and tool-result file references create artifact and availability verification events.
  - OpenClaw finalize hooks can produce artifact, verification, and checkpoint runtime events through the native agent event bus.
  - OpenClaw tool-result middleware can produce step, artifact, verification, and checkpoint runtime events before final reply generation.
  - Artifact delivery finals are revised when they lack a real artifact reference or a passed availability verification, while explicit blockers are allowed with a recoverable checkpoint.
  - Completed/error/aborted runs pass through a completion gate that records artifact verification, failed steps, unfinished steps, and blocking checkpoints before clearing active run state.
  - Default chat can auto-route image/video intent without requiring mode selection, while still applying the strongest allowed image/video parameters by default.
  - The active execution graph projects the new contract events into visible steps without exposing sensitive prompt or body text in diagnostics.
  - Runtime tool events can also project into a durable user-facing progress transcript for ordinary chat surfaces.
  - Managed OpenClaw config enables heartbeat isolatedSession, lightContext, and skipWhenBusy without changing chat, image, or video model routing.
  - Internal prompt-history sanitization blocks pure runtime messages while preserving real user text from mixed queued/restart envelopes.
  - The final guarded model fetch logs only request-shape metadata, including reasoning effort, tool count, tool choice, prompt-cache-key presence, and top-level keys.
  - Renderer does not add direct Gateway HTTP calls or direct page/component IPC calls.
docs:
  required: false
---

## Scope

This task is the execution-layer foundation for making UClaw behave like a reliable agent product. It intentionally does not bind the product model to a specific tool plugin. Tools, browser control, shell commands, file edits, and future approval flows are downstream producers of the same runtime contract.

## Out of Scope

- A full redesigned run details panel.
- New approval policy UI.
- Persistent run journal/replay storage.
- Agent completion eval harnesses beyond the existing communication regression checks.
