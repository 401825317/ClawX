---
id: uclaw-feedback-runtime-regressions
title: Fix UClaw portable runtime and artifact regressions from field logs
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent portable UClaw versions from fighting over one Gateway, route explicit media execution without accidental side effects, stage user media safely, and require the requested final artifact before a run can report completion.
touchedAreas:
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - electron/gateway/manager.ts
  - electron/gateway/supervisor.ts
  - electron/main/index.ts
  - electron/main/process-instance-lock.ts
  - electron/utils/local-artifact-openability.ts
  - electron/utils/local-artifact-planner.ts
  - electron/utils/local-artifact-runtime.ts
  - electron/services/agent-runtime/**
  - package.json
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-artifact-guard/package.json
  - resources/openclaw-skill-shims/office-toolkit
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-session-cwd-runtime-patch.mjs
  - scripts/patch-browser-hint.mjs
  - src/components/file-preview/ArtifactPanel.tsx
  - src/components/file-preview/WorkspaceBrowserBody.tsx
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/ja/chat.json
  - src/i18n/locales/ru/chat.json
  - src/i18n/locales/zh/chat.json
  - src/lib/api-client.ts
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/ChatToolbar.tsx
  - src/pages/Chat/index.tsx
  - src/stores/chat.ts
  - src/stores/chat/session-selection.ts
  - src/stores/chat/types.ts
  - scripts/host-task-lifecycle.test.ts
  - scripts/uclaw-artifact-guard-runtime.test.mjs
  - tests/e2e/native-agent-media-routing.spec.ts
  - harness/specs/tasks/openclaw-ordinary-session-cwd-runtime.md
  - harness/specs/tasks/uclaw-feedback-runtime-regressions.md
expectedUserBehavior:
  - Launching another portable UClaw copy must not start a second process that kills or replaces the active Gateway on port 18789.
  - An explicit request such as "use this prompt to generate a 15-second video" remains one OpenClaw Agent turn, which may select the native video tool even though the text contains the word prompt.
  - Descriptive text such as "based on the video frames" does not create an additional image task unless the user explicitly requests an image deliverable.
  - A user-selected image or video outside the OpenClaw workspace is staged into an approved per-run directory before a media tool reads it.
  - A failed media tool cannot be treated as successful because older files, extracted frames, or prior-turn artifacts exist.
  - A presentation request finishes only after a new, openable PPTX from the current run is produced; a generated illustration alone is not completion.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - pnpm exec tsx --test scripts/host-task-lifecycle.test.ts
  - node scripts/uclaw-artifact-guard-runtime.test.mjs
  - node --check resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - pnpm run typecheck
  - Manual duplicate-portable-launch and Electron artifact-delivery regression
acceptance:
  - Instance ownership is global to the current OS user and app identity rather than scoped only to one portable extraction directory.
  - A duplicate or legacy portable launch cannot enter an unbounded token-mismatch reconnect and orphan-kill loop.
  - OpenClaw decides current-turn execution from conversation context without a second UClaw semantic router.
  - OpenClaw Task Flow creates media subtasks only when the current turn authorizes those deliverables; UClaw does not infer an image task from contextual nouns alone.
  - External media staging preserves the original file, uses a narrowly approved runtime directory, and does not broaden arbitrary filesystem access.
  - Final verification binds evidence to the current run, required artifact type, and successful tool result.
  - The Office skill accepts its documented references paths and presentation execution has a deterministic fallback when the model requests the legacy root create.md path.
  - Existing chat, image-only, video-only, multi-deliverable Task Flow, history reload, and current session-cwd behavior remain covered.
docs:
  required: false
---

## Evidence

The 2026-07-10 Windows field log showed four independent failures: two portable
versions used different Gateway tokens on the same port and repeatedly killed
one another; a PPT request generated only an image; a desktop video path was
rejected by local-media policy and the run still appeared complete; and a
video request containing the word "prompt" was downgraded to chat and later
split into an unrequested image plus video parallel execution path.

## Scope

This task fixes the general runtime contracts exposed by those examples. It
must not special-case the reported Chinese sentences, relax local-media access
globally, or make UI mode hints authoritative over current-turn intent.
Fresh turns always remain OpenClaw Agent turns. Task Flow owns decomposition,
and Host capabilities own local execution and deterministic verification.
