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
  - src/pages/Chat/ChatInput.tsx
  - src/stores/chat.ts
  - electron/api/routes/media.ts
  - electron/services/agent-runtime/**
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/utils/openclaw-video-generation.ts
  - electron/utils/openclaw-video-generation-runtime.ts
  - electron/utils/openclaw-video-relay-constants.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-video-project/**
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - scripts/**
  - tests/e2e/native-agent-media-routing.spec.ts
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
  - pnpm exec tsx scripts/openclaw-video-config-validation.test.ts
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
  - The Agent may explicitly select any advertised compatible video model. UClaw does not replace that valid choice based only on attachment count.
  - When the Agent omits a model, the configured valid video primary remains the tool fallback instead of becoming a renderer or Host override.
  - A non-advertised model returns `invalid_video_model` before a provider HTTP request; UClaw does not silently replace it with a chat model, UI default, or another video model.
  - Host validation rejects `grok-video-1.5` without exactly one readable reference image before calling the backend.
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
