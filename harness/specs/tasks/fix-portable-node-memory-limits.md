---
id: fix-portable-node-memory-limits
title: Bound Windows memory use and renderer OOM recovery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent one large ACP session or repeated Chromium failure notification from exhausting a packaged Windows client and turning recovery into a reload storm.
touchedAreas:
  - electron/gateway/config-sync.ts
  - electron/main/app-runtime.ts
  - electron/main/renderer-recovery.ts
  - electron/services/acp-chat-service.ts
  - electron/services/chat-api.ts
  - electron/utils/acp-memory-policy.ts
  - electron/utils/acp-process-failure.ts
  - electron/utils/openclaw-cli.ts
  - electron/utils/runtime-memory.ts
  - scripts/openclaw-acp-session-replay-guard-patch.mjs
  - scripts/bundle-openclaw.mjs
  - shared/acp-chat/bounded-event-queue.ts
  - shared/chat/media-limits.ts
  - src/lib/acp/content-blocks.ts
  - src/lib/acp/reducer.ts
  - src/stores/acp-chat-session.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-memory-policy.test.ts
  - tests/unit/acp-process-failure.test.ts
  - tests/unit/bounded-event-queue.test.ts
  - tests/unit/chat-media-limits.test.ts
  - tests/unit/openclaw-acp-session-replay-guard-patch.test.ts
  - tests/unit/openclaw-cli.test.ts
  - tests/unit/renderer-recovery.test.ts
  - tests/unit/acp-reducer.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/config-sync.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/video-reference-image.test.ts
  - harness/specs/tasks/fix-portable-node-memory-limits.md
expectedUserBehavior:
  - Packaged Windows ACP startup ignores host NODE_OPTIONS and receives a bounded old-space tier selected from current host memory and pressure.
  - Packaged Windows completion-cache generation ignores host NODE_OPTIONS and receives a controlled 512 MB old-space limit.
  - Completion generation starts after the initial Gateway and UI startup peak instead of competing with them.
  - Loading a pathological history, tool result, or media batch keeps bounded in-memory state and preserves the newest usable suffix.
  - Duplicate renderer OOM/crash notifications are coalesced, backed off, and stopped by a rolling recovery circuit instead of triggering an unbounded reload loop.
  - ACP resource exhaustion is identified explicitly and receives at most one delayed connection restart.
  - Development ACP startup keeps its existing runtime behavior.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - acp-chat-state-and-history
  - acp-compatibility-content-safety
  - diagnostics-trace-safety
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/unit/renderer-recovery.test.ts tests/unit/acp-memory-policy.test.ts tests/unit/acp-process-failure.test.ts tests/unit/bounded-event-queue.test.ts tests/unit/chat-media-limits.test.ts tests/unit/openclaw-acp-session-replay-guard-patch.test.ts tests/unit/openclaw-cli.test.ts tests/unit/acp-chat-service.test.ts tests/unit/acp-reducer.test.ts tests/unit/acp-chat-store.test.ts tests/unit/config-sync.test.ts tests/unit/host-services.test.ts tests/unit/video-reference-image.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/fix-portable-node-memory-limits.md
acceptance:
  - Every case-insensitive spelling of host NODE_OPTIONS is absent from packaged Gateway and OpenClaw child environments.
  - Packaged Windows ACP uses bundled node.exe with a hard 1024 MiB minimum and 4096 MiB maximum; a normal 32 GiB host selects 3072 MiB and active memory pressure can only lower that tier.
  - An optional ACP memory override remains inside the same hard bounds and cannot request unlimited memory.
  - Completion-cache Node flags precede the OpenClaw entry module.
  - Completion generation is deferred for 30 seconds and cancelled during application shutdown.
  - OpenClaw 2026.6.10 ACP history replay requests at most the newest 1000 messages and retains only the newest usable messages that fit an 8 MiB byte ceiling before emitting replay events; an individual oversized message is skipped; the runtime patch is version-locked, idempotent, and fails closed on an unknown layout.
  - Main and Renderer session-load queues retain at most 4,096 notifications and approximately 8 MiB each, enough for the bounded 1,000-message replay while dropping intermediate chunks before terminal records.
  - Renderer timeline state retains at most 1000 items and approximately 4 MiB, with per-part and per-tool-result limits, without persisting a second history ledger.
  - One prompt accepts at most 8 media inputs and 24 MiB decoded media in total; rejected input does not start ACP work.
  - A renderer OOM/crash waits at least 500 ms before reload, keeps one recovery in flight until navigation or watchdog, allows at most three actual reloads in 60 seconds, and opens one circuit for launch/integrity failures or an exhausted budget.
  - Recovery diagnostics contain only aggregate numeric memory data and reason codes, never prompt, transcript, credential, token, attachment, or filesystem content.
  - ACP initialization performs at most two total attempts, delays the single retry after a process/resource failure, and does not automatically retry an already-dispatched prompt.
  - Existing Gateway communication boundaries remain unchanged.
  - Comms replay and compare pass.
docs:
  required: false
---

This is an internal resource-management and failure-recovery change. Product entry points, commands, transport ownership, persisted history authority, and user-facing workflows do not change, so the translated READMEs do not require an update.

The V8 old-space value is only one budget. Native buffers, Electron/Chromium processes, media serialization, Gateway work, and the operating system still need separate headroom; the policy therefore remains deliberately finite even on a 32 GiB computer.
