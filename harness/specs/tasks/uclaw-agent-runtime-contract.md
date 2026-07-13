---
id: uclaw-agent-runtime-contract
title: Project native OpenClaw execution evidence into UClaw
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep semantic planning and tool ownership in the native OpenClaw loop while UClaw projects real task, tool, artifact, verification, approval, delivery, and terminal-state evidence. Host acceptance is declared by the registered capability and evaluated deterministically from actual outputs, never by model-authored metadata or a second renderer decision layer.
touchedAreas:
  - README*.md
  - harness/specs/tasks/**
  - scripts/**
  - shared/**
  - src/**
  - harness/specs/tasks/uclaw-agent-runtime-contract.md
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark-results.md
  - harness/specs/tasks/uclaw-desktop-and-blender-runtime.md
  - harness/specs/tasks/uclaw-feedback-runtime-regressions.md
  - electron/api/routes/runtime.ts
  - electron/api/routes/media.ts
  - electron/media-generation-worker.cjs
  - electron/utils/chat-session-image-message.ts
  - electron/utils/composite-run-coordinator.ts
  - electron/utils/media-generation-job-journal.ts
  - electron/utils/media-generation-jobs.ts
  - electron/utils/media-generation-types.ts
  - electron/utils/media-generation-worker-entry.ts
  - electron/services/agent-runtime/**
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/event-dispatch.ts
  - electron/gateway/task-ledger-monitor.ts
  - shared/chat-runtime-events.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/**
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - resources/context/TOOLS.clawx.md
  - scripts/openclaw-contract-tool-cleanup.mjs
  - scripts/openclaw-contract-tool-cleanup.test.mjs
  - scripts/uclaw-artifact-guard-runtime.test.mjs
  - scripts/uclaw-tool-progress.test.mjs
  - scripts/runtime-native-evidence.test.ts
  - scripts/runtime-task-graph.test.ts
  - scripts/runtime-progress-semantics.test.ts
  - scripts/runtime-run-merge.test.ts
  - scripts/host-capability-registry.test.ts
  - scripts/host-task-lifecycle.test.ts
  - scripts/host-task-runtime-route.test.ts
  - src/pages/Chat/RunProgressCard.tsx
  - src/pages/Chat/index.tsx
  - src/pages/Chat/runtime-run-merge.ts
  - src/pages/Chat/runtime-task-visualization.ts
  - src/stores/chat.ts
  - src/stores/chat/helpers.ts
  - src/stores/chat/runtime-evidence.ts
  - src/stores/chat/runtime-graph.ts
  - src/stores/chat/runtime-progress.ts
  - src/stores/chat/types.ts
  - vite.config.ts
expectedUserBehavior:
  - Every fresh ordinary, media, file, desktop, browser, Blender, MCP, and multi-deliverable request enters the same OpenClaw Agent loop.
  - Ordinary chat can answer directly without fabricating a plan, task, or execution panel.
  - Real tool and task activity appears as concise progress with stable identifiers rather than repeated generic "已运行" rows.
  - Produced artifacts and deterministic verification results can appear before the final assistant reply.
  - Transcript entries marked `provenance.kind=inter_session` remain internal and are not rendered as conversation history.
  - A late tool-terminal error does not replace a user-visible final reply from the same turn; errors remain visible when no final reply exists.
  - Native task failure, cancellation, partial completion, and success remain authoritative across live events and history reload.
  - Host work is accepted only when the registered capability's required artifacts and verifications are satisfied by real structured results.
  - Async Host completion reaches the same run and session directly; another model turn occurs only when the capability explicitly requests replanning and supplies a reason.
  - Internal execution instructions, provider diagnostics, and runtime plumbing are never persisted as user-authored transcript text.
  - Capability questions, explanation requests, and explicit no-tool turns do not receive side-effect authorization from UI mode hints or keyword rules.
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
  - pnpm exec tsc --noEmit --pretty false
  - node --check resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - node scripts/openclaw-contract-tool-cleanup.test.mjs
  - node scripts/uclaw-artifact-guard-runtime.test.mjs
  - node scripts/uclaw-tool-progress.test.mjs
  - node resources/openclaw-plugins/uclaw-task-bridge/harness.spec.mjs
  - pnpm exec tsx --test scripts/runtime-native-evidence.test.ts
  - pnpm exec tsx --test scripts/runtime-task-graph.test.ts
  - pnpm exec tsx scripts/runtime-progress-semantics.test.ts
  - pnpm exec tsx --test scripts/runtime-run-merge.test.ts
  - pnpm exec tsx --test scripts/host-capability-registry.test.ts
  - pnpm exec tsx --test scripts/host-task-lifecycle.test.ts
  - pnpm exec tsx --test scripts/host-task-runtime-route.test.ts
  - pnpm harness validate --spec harness/specs/tasks/uclaw-agent-runtime-contract.md --since HEAD
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - OpenClaw owns semantic intent, tool selection, decomposition, dependency ordering, retries, subagent use, and session continuation for fresh turns.
  - UClaw mode controls provide current-turn media defaults only; they cannot force or suppress a capability independently of the Agent loop.
  - The artifact guard never injects UClaw reply rules, artifact instructions, or UI preferences into the model prompt; it only applies matching UI media defaults after the Agent selects a native media tool.
  - The artifact guard has no model-callable declaration tool, no natural-language authorization cache, and no semantic retry policy.
  - The artifact guard validates only deterministic facts such as parameter bounds, staged media ownership, artifact references, readable non-empty local files, and provider result evidence.
  - Host capability descriptors declare required artifact kinds, minimum counts, and required verification kinds.
  - Host task completion persists the capability-derived acceptance snapshot and rejects a reported success when required evidence is absent.
  - Required local file artifacts reference readable, non-empty regular files before the task can become succeeded.
  - Direct Host completion emits artifact, verification, step, progress, tool, and terminal run events to the owning run without an unconditional model wake.
  - Explicit replan completion schedules at most one same-session Agent continuation and records why replanning is required.
  - Native OpenClaw task and tool terminal states are authoritative; the renderer does not perform a second semantic completion decision.
  - A fresh run begins with `run.started` only. Plan and step rows appear only when real runtime events provide them.
  - Runtime task and artifact updates use stable identifiers and merge monotonically across live delivery and history hydration.
  - The renderer waits only for actual pending async work it already knows about and does not invent a missing-execution blocker from assistant prose.
  - Earlier unrelated tool failures do not override a later authoritative native success for the current run.
  - Failed, cancelled, and blocked native tasks remain visible as such and cannot be turned into success by a summary message.
  - Generated-file cards come from actual attachments or artifact events, not path-like prose alone.
  - The retired model declaration tool is removed from source, patched development runtimes, and packaged OpenClaw bundles.
  - No new run writes internal runtime instructions, acceptance metadata, or completion plumbing into the visible user transcript.
  - User stop aborts the active Agent turn and owned Host tasks; late worker results cannot reopen or complete the stopped run.
  - Concurrent sessions retain separate run, artifact, task, and delivery ownership.
  - Renderer code does not add direct Gateway HTTP calls or direct page/component IPC calls.
docs:
  required: false
---

## Scope

This specification defines UClaw's execution projection boundary. OpenClaw is
the semantic and orchestration control plane. UClaw Main owns Host capability
registration, approvals, durable local work, deterministic output acceptance,
and structured event delivery. The renderer only projects those facts.

## Explicit Deletions

- No model-authored execution declaration or self-authorization step.
- No semantic text classifier that decides whether the Agent "really worked."
- No renderer-owned second decision after a native task reaches a terminal state.
- No synthetic default plan row for an ordinary run start.
- No support path for loading the removed Host task journal schema.

## Out Of Scope

- Replacing OpenClaw's Agent loop, Task Flow, session store, task ledger, or
  subagent scheduler.
- Exposing hidden model reasoning tokens.
- Treating a visible progress transcript as authorization or completion proof.
