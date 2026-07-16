---
id: openclaw-native-media-host-bridge
title: Make UClaw a native OpenClaw Agent Host for media, local tasks, and artifacts
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep OpenClaw as the sole owner of user-intent reasoning, tool selection, subagent coordination, session continuation, and async task lifecycle. UClaw remains the desktop Host: it supplies current-turn preferences, local capability adapters, task journals, UI projection, validation, and user approvals without creating a parallel planner-to-job-to-synthetic-transcript route.
touchedAreas:
  - README*.md
  - harness/specs/tasks/**
  - scripts/**
  - shared/**
  - src/**
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - harness/specs/tasks/media-intent-image-edit-routing.md
  - harness/specs/tasks/video-generation-prompt-length-guard.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark.md
  - harness/specs/tasks/uclaw-codex-experience-benchmark-results.md
  - harness/specs/tasks/uclaw-agent-runtime-contract.md
  - harness/specs/tasks/uclaw-feedback-runtime-regressions.md
  - harness/specs/tasks/uclaw-desktop-and-blender-runtime.md
  - harness/specs/rules/backend-communication-boundary.md
  - harness/specs/rules/bundled-plugin-cross-platform-runtime.md
  - harness/src/profiles.mjs
  - electron/api/routes/gateway.ts
  - electron/api/routes/media.ts
  - electron/api/routes/runtime.ts
  - electron/media-generation-worker.cjs
  - electron/utils/chat-session-image-message.ts
  - electron/utils/composite-run-coordinator.ts
  - electron/utils/media-generation-job-journal.ts
  - electron/utils/media-generation-jobs.ts
  - electron/utils/media-generation-types.ts
  - electron/utils/media-generation-worker-entry.ts
  - electron/services/agent-runtime/**
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/task-ledger-monitor.ts
  - shared/chat-runtime-events.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-artifact-guard/openclaw.plugin.json
  - resources/openclaw-plugins/uclaw-artifact-guard/package.json
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - resources/openclaw-plugins/clawx-openai-image/**
  - resources/context/TOOLS.clawx.md
  - electron/gateway/config-sync.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/plugin-install.ts
  - scripts/bundle-openclaw-plugins.mjs
  - scripts/host-capability-registry.test.ts
  - scripts/local-video-timeline.test.ts
  - scripts/host-task-lifecycle.test.ts
  - scripts/host-task-runtime-route.test.ts
  - scripts/gateway-task-ledger-monitor.test.ts
  - scripts/uclaw-artifact-guard-runtime.test.mjs
  - scripts/openclaw-native-image-delivery-patch.mjs
  - scripts/openclaw-native-image-delivery-patch.test.mjs
  - scripts/openclaw-native-image-delivery-runtime.mjs
  - scripts/clawx-openai-image-request-options.test.mjs
  - scripts/bundle-openclaw.mjs
  - scripts/junfeiai-reasoning-defaults.test.ts
  - scripts/openclaw-native-media-acceptance-cleanup.mjs
  - scripts/openclaw-native-media-acceptance-cleanup.test.mjs
  - scripts/openclaw-video-segment-dedupe-patch.mjs
  - scripts/openclaw-video-segment-dedupe-patch.test.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/reasoning-projection.test.ts
  - scripts/runtime-progress-semantics.test.ts
  - scripts/runtime-native-evidence.test.ts
  - scripts/runtime-task-graph.test.ts
  - scripts/uclaw-media-limit-default.test.ts
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/ja/chat.json
  - src/i18n/locales/ru/chat.json
  - src/i18n/locales/zh/chat.json
  - src/pages/Chat/image-generation-status.ts
  - src/pages/Chat/ReasoningPanel.tsx
  - src/pages/Chat/RunProgressCard.tsx
  - src/pages/Chat/index.tsx
  - src/pages/Chat/reasoning-projection.ts
  - src/pages/Chat/runtime-run-merge.ts
  - src/stores/chat.ts
  - src/stores/chat/helpers.ts
  - src/stores/chat/runtime-evidence.ts
  - src/stores/chat/runtime-task-recovery.ts
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/ExecutionGraphCard.tsx
  - src/pages/Chat/task-visualization.ts
  - tests/e2e/**
  - vite.config.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - A normal chat can invoke native image_generate or video_generate based on the full OpenClaw session context; UClaw does not require a keyword matcher or second semantic planning pass.
  - Image and video modes remain visible product affordances. They supply current-turn media constraints and selected input artifacts, but do not bypass the OpenClaw agent loop. For video, the Agent explicitly selects a compatible model from the request, reference inputs, and advertised provider capabilities; UI defaults never become a silent model override.
  - Native OpenClaw media task start, progress, completion, failure, and produced attachments project into the existing UClaw runtime graph and artifact UI.
  - A native async media completion resumes the same session through OpenClaw's completion path. UClaw does not synthesize an assistant reply to pretend that an Agent tool returned.
  - OpenClaw remains the only semantic decision maker for when to invoke a capability. UClaw guard code may validate ownership, cost, parameter bounds, media staging, and result evidence, but may not authorize a tool from natural-language regexes.
  - Recoverable Host work has stable sessionKey/runId/toolCallId/idempotencyKey correlation, a durable journal, cancellation/recovery APIs, and a same-session completion injection. Task Flow and native subagents remain OpenClaw control-plane features, while UClaw projects their task state.
  - A requested image output format and compression setting reach the selected provider unchanged when that provider advertises support.
  - Generated images that exceed the OpenClaw attachment cap are transcoded and progressively compressed before persistence; a provider-successful image is not discarded solely because its original encoding is too large.
  - Native image task terminal state from the task ledger closes the pending image UI and freezes elapsed time even when internal completion messages are intentionally absent from the visible transcript.
  - When remote video providers cannot produce clips, the Agent can select the advertised `local.video.timeline.render` Host capability to render managed image/video scenes with deterministic duration, basic motion, transitions, captions, narration, and optional background music.
  - Generated video scene audio is preserved by default. TTS is an optional overlay only for explicit narration intent or when source speech is missing or unusable; it does not replace model audio in every video workflow.
  - Local video composition and timeline rendering use a packaged FFmpeg/ffprobe runtime on macOS, Windows, and Linux; the Agent never offers a platform-only implementation to a supported UClaw client.
  - `video_generate action=list` exposes the models configured in `agents.defaults.videoGenerationModel` and `models.providers.<id>.models`; the local timeline renderer is a fallback after those real configured candidates are unavailable, not a replacement for provider discovery.
  - Long-form video plans may submit multiple native `video_generate` tasks with one shared `parentTaskId` and a unique `segmentId` per shot. The duplicate guard suppresses only the same logical segment, while calls without segment identity retain session-level single-flight behavior.
  - A still-image-only timeline is disclosed as a fallback after provider generation is unavailable or fails; it is never described as equivalent to provider-generated motion.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-events-fallback-policy
  - comms-regression
  - bundled-plugin-cross-platform-runtime
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/openclaw-native-media-host-bridge.md --since HEAD
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm exec tsc --noEmit --pretty false
  - node scripts/download-bundled-ffmpeg.mjs --verify --target=current
  - node --check resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - node scripts/uclaw-artifact-guard-runtime.test.mjs
  - node resources/openclaw-plugins/uclaw-task-bridge/harness.spec.mjs
  - pnpm exec tsx --test scripts/local-video-timeline.test.ts
  - node scripts/openclaw-native-image-delivery-patch.test.mjs
  - node scripts/openclaw-native-media-acceptance-cleanup.test.mjs
  - node scripts/openclaw-video-segment-dedupe-patch.test.mjs
  - pnpm exec tsx --test scripts/runtime-native-evidence.test.ts
  - pnpm exec tsx --test scripts/runtime-task-graph.test.ts
  - node scripts/clawx-openai-image-request-options.test.mjs
  - pnpm exec tsx scripts/uclaw-media-limit-default.test.ts
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - Electron UI validation for chat-mode image continuation and native async task delivery
acceptance:
  - The renderer has no direct media job/polling branch for a normal agent turn.
  - Image/video mode preferences reach the matching OpenClaw turn without being persisted as user-authored system instructions.
  - Native image_generate and video_generate retain their OpenClaw task ledger, duplicate guard, completion wake, and normal session delivery semantics.
  - Replaying one `parentTaskId + segmentId` pair reuses the active or recent successful video task, while a different `segmentId` under the same parent may start another planned shot.
  - Calls that omit `parentTaskId` and `segmentId` preserve the session-level native video single-flight guard.
  - Fresh turns never call the retired UClaw media intent or video-route planners; OpenClaw performs semantic tool selection once.
  - The retired intent-plan and direct image/video endpoints fail closed with HTTP 410 and cannot enqueue duplicate media work.
  - Media provider settings and existing job inspection/cancel/retry endpoints remain available for current operations; they are not fresh-turn entrypoints.
  - The artifact guard validates real tool and artifact evidence and does not depend on model-declared metadata or a second UClaw planner.
  - Tool/task completion events create stable runtime artifacts and required availability verification before UClaw presents terminal success.
  - Fresh Agent/Task Flow execution cannot create duplicate side effects for one idempotency key.
  - Ordinary, image-mode, and video-mode composer sends all use `/api/chat/send`; only image/video preference fields differ.
  - Existing standalone PPT, file, desktop, Blender, browser, and MCP tool paths continue to use OpenClaw tools/plugins rather than gaining another front-end intent router.
  - New chat turns never persist an internal execution contract as user-authored text; the UI only renders the original user request and verified runtime artifacts.
  - The packaged and development startup paths install and enable every required bundled bridge plugin.
  - `clawx-openai-image` advertises only output controls it actually forwards, including JPEG/WebP compression and supported backgrounds.
  - An oversized PNG response for a requested JPEG is saved as a valid JPEG below the configured image byte cap, with authoritative MIME type and filename metadata.
  - Managed UClaw installs default `agents.defaults.mediaMaxMb` to 16 when unset, while preserving an explicit user value.
  - Failed, partial, cancelled, and completed native image tasks are terminal for the renderer pending-state detector even when the artifact guard filters their internal completion envelopes from transcript history.
  - `local.video.compose` and `local.video.timeline.render` resolve packaged FFmpeg/ffprobe binaries for the current macOS, Windows, or Linux target and do not contain a permanent OS-family rejection.
  - Packaging fails when the target FFmpeg/ffprobe binaries are absent, have the wrong architecture, or cannot execute their version probes.
  - Timeline rendering accepts only managed image/video and background-music paths, verifies the final MP4 duration, dimensions, video track, and requested audio track, and returns blocked rather than success when any required fact is missing.
  - Local composition and timeline rendering retain source video audio unless `keepOriginalAudio=false`; explicit narration mixes over source audio at background level instead of silently deleting it.
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
  same-session structured completion context. A new Agent turn is scheduled only
  when the capability explicitly requests replanning; native media retains
  OpenClaw's internal fast completion wake.
