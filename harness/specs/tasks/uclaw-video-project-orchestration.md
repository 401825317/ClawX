---
id: uclaw-video-project-orchestration
title: Orchestrate durable reference-driven UClaw video projects
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep GPT/OpenClaw responsible for creative video planning and semantic acceptance while UClaw persists a VideoProject, schedules native video_generate shots through their existing task identity, verifies deterministic media facts locally, and delivers one verified project result without a second media planner or a user-visible provider-routing explanation.
touchedAreas:
  - harness/specs/tasks/uclaw-video-project-orchestration.md
  - harness/specs/tasks/video-generation-model-routing.md
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - harness/specs/tasks/uclaw-agent-runtime-contract.md
  - harness/specs/rules/bundled-plugin-cross-platform-runtime.md
  - electron/services/agent-runtime/host-capability-defaults.ts
  - electron/services/agent-runtime/**
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/api/routes/runtime.ts
  - electron/gateway/config-sync.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/plugin-install.ts
  - electron/services/agent-runtime/local-video-shot-qa.ts
  - resources/openclaw-plugins/uclaw-video-project/**
  - resources/openclaw-plugins/uclaw-artifact-guard/**
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - scripts/**
  - scripts/openclaw-bundle-config.mjs
  - scripts/local-video-shot-qa.test.ts
  - src/pages/Chat/**
  - src/stores/chat/**
  - tests/e2e/**
  - package.json
  - pnpm-lock.yaml
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - A request for a final video first creates a VideoProject. It can remain a single-shot project or expand into multiple shots; GPT determines the creative strategy from the turn context and explicit user constraints, while UClaw does not use keyword or fixed-duration rules. Intended narration, per-shot captions, audio policy, duration, and output geometry are persisted at creation and survive later compose calls.
  - Video-mode size and duration, plus supplied reference artifacts, are preserved as project constraints and made available to every planned shot. The Agent explicitly selects a provider model from the current request, inputs, and advertised capabilities; a UI default model is not silently injected after planning.
  - A reference-image shot passes its managed image path to native video_generate. The project records which reference was used for each attempt so continuity and retries are auditable.
  - Provider models remain selected through the existing video_generate capability contract. UClaw does not show implementation routing or provider issue identifiers in ordinary user-facing delivery text.
  - Each generated shot gets local deterministic QA for readable video, duration, dimensions, audio, black frames, and frozen-frame risk. A contact sheet is returned for GPT semantic review; local QA does not claim to understand Chinese text or visual semantics.
  - A shot is accepted only after deterministic QA passes, GPT records semantic acceptance, and measured source dimensions satisfy the generation contract. Missing dimensions, a smaller output, or a mismatched aspect ratio block acceptance; rendering an upscale never repairs the source contract. Failed/rejected shots can retry under the same project and shot identity with a new attempt.
  - Every final video uses `action=compose`. A single accepted source may use direct source QA only when no resize, duration change, caption, narration, background music, original-audio replacement, or transition is needed. All other single-shot and multi-shot projects start an internal Host render task, then final video QA. The render artifact is never delivered on its own; only final QA exposes the verified MP4 through the normal task delivery path.
  - Project completion records `assembled` after final QA and advances to `delivered` after the Task Bridge acknowledges the final delivery task. Restart recovery resumes from persisted Host task IDs without starting a duplicate render.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - comms-regression
  - bundled-plugin-cross-platform-runtime
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/uclaw-video-project-orchestration.md --since HEAD
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm exec tsc --noEmit --pretty false
  - node scripts/download-bundled-ffmpeg.mjs --verify --target=current
  - pnpm exec tsx --test scripts/local-video-shot-qa.test.ts scripts/local-video-timeline.test.ts
  - node scripts/openclaw-video-capability-contract-patch.test.mjs
  - node scripts/openclaw-video-actual-spec-patch.test.mjs
  - node scripts/openclaw-native-media-completion-queue-patch.test.mjs
  - node scripts/openclaw-native-media-acceptance-cleanup.test.mjs
  - node resources/openclaw-plugins/uclaw-video-project/harness.spec.mjs
  - node resources/openclaw-plugins/uclaw-task-bridge/harness.spec.mjs
  - node scripts/uclaw-artifact-guard-runtime.test.mjs
  - node scripts/uclaw-video-agent-contract.test.mjs
acceptance:
  - A VideoProject has a durable project id, constraints, reference lineage, explicit shots, attempts, per-shot acceptance state, artifact references, and a terminal delivery state.
  - The project API returns tool-callable instructions that use parentTaskId=projectId and a stable segmentId=shotId for native video_generate; it does not generate videos itself.
  - A generic video request may use one shot, and an explicit duration/quality/size request flows into the same project constraints rather than bypassing the project layer.
  - A final video request does not bypass VideoProject to call `video_generate` as an untracked side effect. Every generated attempt, QA decision, retry, and project finalization remains associated with the same durable project.
  - When the Agent does not explicitly select a model, UClaw never silently turns the video-mode's configured default model into a `video_generate.model` override; configured provider defaults remain only the underlying tool fallback.
  - grok-video-1.5 is only planned when an exactly-one reference image is available; a text-only shot remains eligible for grok-image-video according to configured provider capability discovery.
  - QA emits structured metadata and a managed contact-sheet artifact. Black/freeze/audio/dimension/duration findings are factual, and unavailable checks are reported as unavailable instead of passed.
  - Semantic review remains an explicit GPT decision recorded against the QA evidence; UClaw never substitutes a local OCR or keyword heuristic for it.
  - Project finalization rejects incomplete, unaccepted, undersized, or unverifiable required shots and returns structured recovery guidance instead of terminal success. Manual `assembled` or `delivered` cannot override blocked composition state and can only confirm the exact artifact already passed by Host final QA.
  - UClaw-managed video capability guidance does not advertise `480P`; if a provider returns 480-class output after a larger size was submitted, native generation records `terminalOutcome=blocked` and withholds that artifact from successful completion delivery.
  - A final QA task attaches the final video as the verified deliverable and keeps contact-sheet evidence internal, so ordinary delivery contains one final MP4 rather than intermediate clips or QA images.
  - Development and packaged startup install the project plugin alongside existing local UClaw plugins.
docs:
  required: true
---

## Scope

`VideoProject` is a durable envelope around the existing OpenClaw-native media
tool. It is not a replacement renderer, a provider router, or a second agent.
The agent chooses whether the user's request is one-shot or a storyboard; the
project persists that decision, records inputs and results, and makes retries
and final delivery inspectable.

Deterministic QA intentionally checks only media facts available locally. A
contact sheet enables the primary model to evaluate continuity, legibility,
and whether the generated scene meets the requested concept. This preserves
the separation between local evidence and semantic judgement.

## Out Of Scope

- Replacing `video_generate`, its provider discovery, or its configured model
  routing.
- Forcing every simple generated clip through multi-shot composition.
- Claiming local OCR, speech realism, or visual-semantic judgement without an
  implemented and verified model capability.
- Cross-provider scheduling and price arbitration.
