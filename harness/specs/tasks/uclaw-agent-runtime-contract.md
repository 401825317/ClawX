---
id: uclaw-agent-runtime-contract
title: Add first-class runtime contract events for UClaw agent execution
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Give the desktop client a durable execution-layer contract for objective, plan, step progress, produced artifacts, verification results, and recoverable checkpoints so agent work can be shown and audited as product state instead of inferred from chat text.
touchedAreas:
  - .github/workflows/comms-regression.yml
  - .github/workflows/harness.yml
  - AGENTS.md
  - harness/specs/tasks/uclaw-agent-runtime-contract.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark.md
  - harness/specs/scenarios/gateway-backend-communication.md
  - harness/specs/rules/presentation-artifact-quality.md
  - harness/src/profiles.mjs
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - package.json
  - pnpm-lock.yaml
  - electron/api/routes/gateway.ts
  - electron/api/routes/media.ts
  - electron/main/ipc-handlers.ts
  - electron/utils/composite-run-coordinator.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/chat-session-image-message.ts
  - electron/utils/local-artifact-planner.ts
  - electron/utils/local-artifact-runtime.ts
  - electron/utils/media-generation-jobs.ts
  - electron/utils/media-generation-types.ts
  - electron/utils/media-generation-worker-entry.ts
  - electron/services/agent-runtime/**
  - shared/chat-runtime-events.ts
  - shared/composite-run.ts
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/task-ledger-monitor.ts
  - electron/gateway/event-dispatch.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/openclaw.plugin.json
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-artifact-guard/package.json
  - resources/openclaw-plugins/uclaw-local-artifacts/index.mjs
  - resources/openclaw-plugins/uclaw-local-artifacts/openclaw.plugin.json
  - resources/openclaw-plugins/uclaw-local-artifacts/package.json
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - resources/context/AGENTS.clawx.md
  - resources/context/TOOLS.clawx.md
  - resources/openclaw-skill-shims/presentation-maker/SKILL.md
  - resources/openclaw-skill-shims/presentation-maker/references/studio-schema.md
  - resources/openclaw-skill-shims/presentation-maker/scripts/make-pptx.mjs
  - resources/openclaw-skill-shims/office-toolkit/create.md
  - resources/openclaw-skill-shims/office-toolkit/references/create.md
  - scripts/openclaw-model-request-contract-patch.mjs
  - scripts/openclaw-streaming-runtime-patch.mjs
  - scripts/openclaw-tool-directory-i18n-patch.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/bundle-openclaw.mjs
  - scripts/host-capability-registry.test.ts
  - scripts/host-task-lifecycle.test.ts
  - scripts/host-task-runtime-route.test.ts
  - scripts/gateway-task-ledger-monitor.test.ts
  - scripts/uclaw-contract-driven-gate.test.mjs
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/ExecutionGraphCard.tsx
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatMessage.tsx
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/ja/chat.json
  - src/i18n/locales/ru/chat.json
  - src/i18n/locales/zh/chat.json
  - src/stores/chat/types.ts
  - src/stores/chat/helpers.ts
  - src/stores/chat/runtime-graph.ts
  - src/stores/chat/runtime-progress.ts
  - src/stores/chat/runtime-contract.ts
  - src/stores/chat/history-transcript-merge.ts
  - src/stores/chat.ts
  - src/stores/client-config.ts
  - src/stores/gateway.ts
  - src/pages/Chat/RunProgressCard.tsx
  - src/pages/Chat/task-visualization.ts
  - tests/e2e/**
  - harness/specs/tasks/media-intent-image-edit-routing.md
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark-results.md
  - harness/specs/tasks/uclaw-desktop-and-blender-runtime.md
  - harness/specs/tasks/uclaw-feedback-runtime-regressions.md
  - harness/specs/tasks/video-generation-prompt-length-guard.md
expectedUserBehavior:
  - Agent runs can expose a structured objective and plan in the active execution graph.
  - Step progress updates replace prior state by stable identifiers instead of creating duplicate timeline noise.
  - Produced artifacts, verification results, and checkpoints can be surfaced as execution facts before the final assistant reply.
  - Ordinary chat can render a compact runtime-owned progress transcript without exposing the raw execution graph by default.
  - Heartbeat work runs in an isolated lightweight session and never reuses the interactive chat transcript.
  - Internal heartbeat, restart-continuation, and runtime-plumbing messages are removed before prompt construction and future transcript writes.
  - Safe diagnostics can prove the final provider request contract without recording prompts, credentials, tool schemas, or media payloads.
  - Chinese engineering and read-only prompts discover the same relevant tool families as equivalent English prompts.
  - Visible assistant deltas remain genuinely streamed with a responsive UI cadence instead of arriving in large bursts.
  - Fresh multi-deliverable work remains one OpenClaw Agent turn whose Task Flow creates task-specific dependencies only when the user intent requires them.
  - Live Task Flow delivery and reopened history share one canonical artifact manifest and finalized runtime snapshot.
  - Terminal state is monotonic across chat final, runtime end, async completion, and history reconciliation.
  - User stop aborts the active Agent turn, Task Flow, and Host tasks, cancels queued/running media workers, and prevents stale UI or transcript delivery.
  - Capability comparisons and other non-execution questions never acquire file/media side-effect authorization.
  - Concurrent sessions cannot overwrite each other's transcript index or inject a follow-up into an already busy run.
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
  - presentation-artifact-quality
requiredTests:
  - pnpm exec tsc --noEmit --pretty false
  - node --check resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - pnpm harness validate --spec harness/specs/tasks/uclaw-agent-runtime-contract.md --since HEAD
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Every fresh ordinary, media, file, desktop, browser, Blender, MCP, and multi-deliverable request enters the same OpenClaw Agent loop.
  - OpenClaw Task Flow and native subagents own fresh decomposition, dependency ordering, retry decisions, and session continuation.
  - Host capabilities execute local work behind structured contracts and return task, artifact, verification, approval, and delivery evidence without performing semantic intent routing.
  - The legacy composite coordinator is recovery-only: it can resume or finalize pre-migration snapshots but cannot accept a fresh `/api/chat/send` turn.
  - Legacy composite DAG recovery blocks downstream work after dependency failure and never automatically duplicates an unconfirmed media generation after Main restart.
  - Legacy composite final delivery uses one canonical manifest and stable assistant message id so old runs remain recoverable without creating a parallel fresh-turn path.
  - A local artifact run remains non-terminal while its canonical conversation delivery is pending or failed; only a successful transcript append can publish completed delivery state.
  - Media cancellation resolves by native task/job id first and by legacy composite run id only during recovery, so stopping one run cannot cancel unrelated media work.
  - Safe recoverable legacy failures receive at most one automatic retry; exhausted or unsafe failures produce a partial manifest, while restart-uncertain media is never automatically resubmitted.
  - Partial legacy delivery keeps completed artifacts, marks unresolved tasks for user action, and never reports the whole batch as completed.
  - Legacy delivery publishes completed/error termination only after canonical transcript append succeeds; exhausted append failure emits a recoverable delivery checkpoint and never marks the run completed.
  - Canonical transcript delivery retries transient append failures after 0.5, 1.5, and 4 seconds with the same assistant message id; only exhausted delivery becomes terminal failed and drops out of active-run reloads.
  - Host and legacy recovery journal files are private to the current OS user; active journals remain append-only and terminal journals compact before retention expiry.
  - Shared runtime event types include objective, plan, step, artifact, verification, and checkpoint events.
  - Main process normalizes Gateway plan/artifact/verification/checkpoint streams into the shared runtime event contract.
  - Chat runtime state aggregates the new contract events with stable upsert semantics.
  - Chat execution flow produces default plan events from real run starts or send acknowledgements instead of relying only on model prose.
  - Produced file cards and tool-result file references create artifact and availability verification events.
  - OpenClaw finalize hooks can produce artifact, verification, and checkpoint runtime events through the native agent event bus.
  - OpenClaw tool-result middleware can produce step, artifact, verification, and checkpoint runtime events before final reply generation.
  - Artifact delivery finals are revised when they lack a real artifact reference or a passed availability verification, while explicit blockers are allowed with a recoverable checkpoint.
  - Completed/error/aborted runs pass through a completion gate that records artifact verification, failed steps, unfinished steps, and blocking checkpoints before clearing active run state.
  - OpenClaw can select native image/video tools from default chat without requiring mode selection; image/video mode defaults remain current-turn preferences only.
  - The active execution graph projects the new contract events into visible steps without exposing sensitive prompt or body text in diagnostics.
  - Runtime tool events can also project into a durable user-facing progress transcript for ordinary chat surfaces.
  - Managed OpenClaw config enables heartbeat isolatedSession, lightContext, and skipWhenBusy without changing chat, image, or video model routing.
  - Internal prompt-history sanitization blocks pure runtime messages while preserving real user text from mixed queued/restart envelopes.
  - The final guarded model fetch logs only request-shape metadata, including reasoning effort, tool count, tool choice, prompt-cache-key presence, and top-level keys.
  - The managed `lingzhiwuxian/smart-latest` model declares native `xhigh` support in both catalog compatibility and its top-level thinking-level map, so an `xhigh` Agent turn reaches the final OpenRouter payload as `reasoning.effort=xhigh` instead of being clamped to `high`.
  - Dev and packaged OpenClaw runtimes apply the CJK tool-directory and streaming cadence patches idempotently.
  - Task Flow and recovered legacy results persist structured task, artifact, verification, gate, and progress state instead of reconstructing success from localized summary text.
  - Single and multi-artifact fresh requests use the same OpenClaw Agent turn contract, Task Flow semantics, Host capability registry, and verification contract.
  - Single local artifacts use Agent/skill reasoning for semantic content planning; deterministic Host heuristics are only an observable degraded or legacy fallback, never the fresh-turn router.
  - Presentation and local web artifacts preserve the requested subject and interaction domain, and semantic verification rejects unrelated generic templates.
  - Presentation plans carry a deterministic design specification; product, travel, executive, training, and editorial themes render different visible cover and page frameworks across the OpenClaw tool path, Host writer, and legacy fallback.
  - Explicit long-form character or word targets are carried as structured task requirements, receive sufficient planning budget, and fail completion verification when the final readable text is short.
  - Terse follow-ups resolve against the latest structured artifact run and delivery state instead of relying on a phrase-specific local rule or losing the prior objective.
  - A current-turn image-to-video tool call can retain its selected current-session artifact, while ordinary chat remains unable to reuse stale media implicitly.
  - Async completion evidence can resolve accepted tasks by task id, child session key, or child session id without treating generic continuations as completion.
  - Local media availability passes only after Main verifies a readable, non-empty output file.
  - Chat run completion and artifact delivery completion remain separate lifecycle facts so delayed persistence cannot produce a false successful terminal state.
  - Aborting a local run cancels queued/running media jobs and all later tool, worker, verification, and transcript results are ignored for that send generation.
  - Session transcript/index persistence is serialized and atomically replaced for concurrent completions.
  - Deliverable detection covers text, image, video, audio, file blocks, and attached artifact metadata.
  - Renderer does not add direct Gateway HTTP calls or direct page/component IPC calls.
docs:
  required: false
---

## Scope

This task is the execution-layer foundation for making UClaw behave like a reliable agent product. It intentionally does not bind the product model to a specific tool plugin. Tools, browser control, shell commands, file edits, and future approval flows are downstream producers of the same runtime contract.

## Out of Scope

- A full redesigned run details panel.
- New approval policy UI.
- A second orchestration journal that competes with OpenClaw Task Ledger, Host task journals, or recovery-only legacy snapshots.
- Agent completion eval harnesses beyond the existing communication regression checks.
