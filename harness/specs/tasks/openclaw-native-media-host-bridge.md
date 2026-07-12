---
id: openclaw-native-media-host-bridge
title: Make UClaw a native OpenClaw Agent Host for media, local tasks, and artifacts
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep OpenClaw as the sole owner of user-intent reasoning, tool selection, subagent coordination, session continuation, and async task lifecycle. UClaw remains the desktop Host: it supplies current-turn preferences, local capability adapters, task journals, UI projection, validation, and user approvals without creating a parallel planner-to-job-to-synthetic-transcript route.
touchedAreas:
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - harness/specs/tasks/media-intent-image-edit-routing.md
  - harness/specs/tasks/video-generation-prompt-length-guard.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark-results.md
  - harness/specs/tasks/uclaw-agent-runtime-contract.md
  - harness/specs/tasks/uclaw-feedback-runtime-regressions.md
  - harness/specs/tasks/uclaw-desktop-and-blender-runtime.md
  - harness/specs/rules/backend-communication-boundary.md
  - electron/api/routes/gateway.ts
  - electron/api/routes/media.ts
  - electron/api/routes/runtime.ts
  - electron/services/agent-runtime/**
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/task-ledger-monitor.ts
  - shared/chat-runtime-events.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-artifact-guard/openclaw.plugin.json
  - resources/openclaw-plugins/uclaw-artifact-guard/package.json
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - resources/context/TOOLS.clawx.md
  - electron/gateway/config-sync.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/plugin-install.ts
  - scripts/bundle-openclaw-plugins.mjs
  - scripts/host-capability-registry.test.ts
  - scripts/host-task-lifecycle.test.ts
  - scripts/host-task-runtime-route.test.ts
  - scripts/gateway-task-ledger-monitor.test.ts
  - scripts/uclaw-contract-driven-gate.test.mjs
  - src/stores/chat.ts
  - src/stores/chat/helpers.ts
  - src/stores/chat/runtime-contract.ts
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/ExecutionGraphCard.tsx
  - src/pages/Chat/task-visualization.ts
  - tests/e2e/**
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - A normal chat can invoke native image_generate or video_generate based on the full OpenClaw session context; UClaw does not require a keyword matcher or second semantic planning pass.
  - Image and video modes remain visible product affordances. They supply current-turn defaults such as model, size, quality, duration, and selected input artifact, but do not bypass the OpenClaw agent loop.
  - Native OpenClaw media task start, progress, completion, failure, and produced attachments project into the existing UClaw runtime graph and artifact UI.
  - A native async media completion resumes the same session through OpenClaw's completion path. UClaw does not synthesize an assistant reply to pretend that an Agent tool returned.
  - OpenClaw remains the only semantic decision maker for when to invoke a capability. UClaw guard code may validate ownership, cost, parameter bounds, media staging, and result evidence, but may not authorize a tool from natural-language regexes.
  - Recoverable Host work has stable sessionKey/runId/toolCallId/idempotencyKey correlation, a durable journal, cancellation/recovery APIs, and a same-session completion injection. Task Flow and native subagents remain OpenClaw control-plane features, while UClaw projects their task state.
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
  - pnpm harness validate --spec harness/specs/tasks/openclaw-native-media-host-bridge.md --since HEAD
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm exec tsc --noEmit --pretty false
  - node --check resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - node resources/openclaw-plugins/uclaw-task-bridge/harness.spec.mjs
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - Electron UI validation for chat-mode image continuation and native async task delivery
acceptance:
  - The renderer has no direct media job/polling branch for a normal agent turn.
  - Image/video mode preferences reach the matching OpenClaw turn without being persisted as user-authored system instructions.
  - Native image_generate and video_generate retain their OpenClaw task ledger, duplicate guard, completion wake, and normal session delivery semantics.
  - Fresh turns never call the retired UClaw media intent or video-route planners; OpenClaw performs semantic tool selection once.
  - The retired intent-plan and direct image/video endpoints fail closed with HTTP 410 and cannot enqueue duplicate media work.
  - Media provider settings and existing job inspection/cancel/retry endpoints remain available for operations and legacy recovery; they are not fresh-turn entrypoints.
  - The legacy composite coordinator can resume pre-migration records but cannot accept a fresh `/api/chat/send` turn or synthesize a new assistant result.
  - The artifact guard validates the declared Agent turn contract and does not depend on a second UClaw planner.
  - Tool/task completion events create stable runtime artifacts and required availability verification before UClaw presents terminal success.
  - Fresh Agent/Task Flow execution and legacy recovery cannot create duplicate side effects for one idempotency key.
  - Ordinary, image-mode, and video-mode composer sends all use `/api/chat/send`; only image/video preference fields differ.
  - Existing standalone PPT, file, desktop, Blender, browser, and MCP tool paths continue to use OpenClaw tools/plugins rather than gaining another front-end intent router.
  - New chat turns never persist an internal execution contract as user-authored text; the UI only renders the original user request and verified runtime artifacts.
  - The packaged and development startup paths install and enable every required bundled bridge plugin.
docs:
  required: true
---

## Scope

This task completes the UClaw Agent Host migration. Native media proves the
main path because OpenClaw already owns its session-backed task lifecycle; the
same contract applies to local artifacts, desktop control, Blender, browser,
MCP, and future Host executors. New chat turns integrate as an OpenClaw
tool/provider plus a Host adapter and structured result, never as
`renderer -> planner -> host job -> synthetic assistant transcript`.

The Host Task Bridge is the durable adapter for non-media local work. It
records task state and delivery acknowledgements, returns structured progress,
artifacts, and verification, and queues a same-session completion injection.
It does not select a capability or retry side effects itself. OpenClaw's native
Task Flow and subagents remain the orchestration control plane.

## Out Of Scope

- Replacing OpenClaw's agent loop, Task Flow, session store, task ledger, or
  subagent scheduler.
- Removing the current image/video mode controls.
- A privileged OpenClaw-core immediate-wake API for arbitrary third-party
  workers. The bridge uses the public durable injection plus scheduled
  same-session turn contract; native media retains OpenClaw's internal fast
  completion wake.
