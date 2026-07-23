---
id: video-generation-model-routing
title: Video generation model routing
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep video model choice with the OpenClaw Agent while exposing only capability-scoped video models and rejecting chat or unknown models before any provider request.
touchedAreas:
  - harness/specs/tasks/video-generation-model-routing.md
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - harness/specs/tasks/uclaw-video-project-orchestration.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - src/components/settings/VideoGenerationSettings.tsx
  - src/components/client/ClientConfigInitializer.tsx
  - src/i18n/locales/**/chat.json
  - src/i18n/locales/**/dashboard.json
  - src/lib/video-generation.ts
  - src/pages/Chat/ChatInput.tsx
  - src/stores/client-config.ts
  - src/stores/chat.ts
  - electron/api/routes/media.ts
  - electron/services/agent-runtime/**
  - electron/services/junfeiai/managed-video-capability-cache.ts
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/store-instance.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/openclaw-video-generation.ts
  - electron/utils/openclaw-video-generation-runtime.ts
  - electron/utils/openclaw-video-relay-constants.ts
  - shared/managed-video-capabilities.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-video-project/**
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - scripts/**
  - tests/e2e/chat-model-picker.spec.ts
  - tests/e2e/native-agent-media-routing.spec.ts
  - tests/packaged-e2e/capability-matrix.json
  - tests/packaged-e2e/portable-regression.spec.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
requiredTests:
  - pnpm exec tsc --noEmit --pretty false
  - node scripts/openclaw-video-provider-catalog-patch.test.mjs
  - node scripts/openclaw-video-model-validation-patch.test.mjs
  - node scripts/openclaw-video-capability-contract-patch.test.mjs
  - node scripts/openclaw-managed-media-timeout-patch.test.mjs
  - pnpm exec tsx scripts/openclaw-video-config-validation.test.ts
  - pnpm exec playwright test tests/e2e/chat-model-picker.spec.ts
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - node scripts/windows-support/run-packaged-regression.mjs --latest --profile full
  - node resources/openclaw-plugins/uclaw-video-project/harness.spec.mjs
  - node scripts/uclaw-video-agent-contract.test.mjs
expectedUserBehavior:
  - Every fresh video request remains one OpenClaw Agent turn; video mode supplies current-turn preferences but does not select or invoke a capability by itself.
  - Text-only video requests do not implicitly attach stale chat images. The Agent may reuse a prior artifact only when the current request and session context identify it.
  - Explicitly uploaded, pasted, or selected images are attached to the current Agent turn and are available to `video_generate` as resolved `inputImages`.
  - OpenClaw Task Flow can sequence image edit and video generation when the request requires both, and the video task consumes the verified edited artifact.
  - Switching from image reference mode to video mode preserves the selected image reference for the next video send.
acceptance:
  - ChatInput sends selected image references as attachments on the shared `/api/chat/send` path and carries video settings only as current-turn preferences.
  - The OpenClaw Agent owns text-to-video, image-to-video, and edit-then-video tool selection from the full session context; UClaw does not run a second semantic router.
  - The video capability catalog is built from registered video providers and capability-specific model metadata; shared chat models such as `smart-latest` and `qwen-latest` are never advertised as video models.
  - `/api/clawx/client-config` is the sole authority for managed video models, modes, sizes, durations, and per-model defaults; Renderer, Host, Agent `models.json`, and the bundled OpenClaw runtime consume the same normalized contract.
  - Every valid remote contract is cached as the last-known-good contract and embedded in the managed OpenAI provider `params`. A transient backend outage reuses that contract, while a fresh machine with no valid contract disables managed video instead of guessing model IDs or request parameters.
  - Omitted video geometry and duration use the selected model's `defaultSize` and `defaultDurationSeconds`. A larger size or longer duration is selected only when the current user request explicitly asks for the maximum, and shape-only requests retain a compatible model default.
  - The managed catalog preserves every size advertised by the backend, including low-resolution, landscape, portrait, and square options; OpenClaw patches do not contain a managed-model size, duration, or mode allowlist.
  - Generated video response downloads and local artifact saves use the managed 1 GiB video safety budget independently of the 16 MiB inline media delivery cap; both first generation and regeneration preserve the completed artifact, while oversized responses still fail closed.
  - The Agent may explicitly select any advertised compatible video model. UClaw does not replace that valid choice based only on attachment count.
  - When the Agent omits a model, the configured valid video primary remains the tool fallback instead of becoming a renderer or Host override.
  - A non-advertised model returns `invalid_video_model` before a provider HTTP request; UClaw does not silently replace it with a chat model, UI default, or another video model.
  - Host validation enforces each advertised model's mode and reference-image requirements before calling the backend.
  - Managed video durations come only from the selected model contract; omitted or stale unsupported values normalize deterministically to that model's advertised default or nearest supported value before any provider request.
  - Task Flow preserves the edited-image dependency and does not silently downgrade a requested image-to-video task to text-to-video.
  - Retired video intent and direct media endpoints cannot accept fresh turns or provide an alternate execution path.
docs:
  required: true
---

## Contract

- OpenClaw owns semantic tool and advertised video-model selection plus Task
  Flow dependencies. UClaw owns attachment staging, capability catalog
  integrity, fail-closed parameter validation, durable task projection, and
  artifact verification.
- The renderer never passes a provider video model override from the composer.
  It sends the user request, explicit attachments, and current-turn preferences
  through the shared Agent entrypoint.
- Main normalizes and caches the backend contract, writes the same contract to
  OpenClaw provider params, and reloads a running Gateway only when that
  contract changes. No layer independently reconstructs a managed video
  capability table.
