---
id: video-generation-model-routing
title: Video generation model routing
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep UClaw video generation requests routed to the correct Grok video model based on explicit reference images, avoiding text-to-video calls hitting image-to-video-only models and image-to-video calls staying on text-video defaults.
touchedAreas:
  - harness/specs/tasks/video-generation-model-routing.md
  - src/pages/Chat/ChatInput.tsx
  - src/stores/chat.ts
  - electron/api/routes/media.ts
  - electron/services/agent-runtime/**
  - electron/utils/openclaw-video-generation.ts
  - electron/utils/openclaw-video-generation-runtime.ts
  - electron/utils/openclaw-video-relay-constants.ts
  - resources/openclaw-plugins/uclaw-artifact-guard/index.mjs
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - scripts/uclaw-artifact-guard-runtime.test.mjs
  - tests/e2e/native-agent-media-routing.spec.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - Every fresh video request remains one OpenClaw Agent turn; video mode supplies current-turn preferences but does not select or invoke a capability by itself.
  - Text-only video requests do not implicitly attach stale chat images. The Agent may reuse a prior artifact only when the current request and session context identify it.
  - Explicitly uploaded, pasted, or selected images are attached to the current Agent turn and are available to `video_generate` as resolved `inputImages`.
  - OpenClaw Task Flow can sequence image edit and video generation when the request requires both, and the video task consumes the verified edited artifact.
  - Switching from image reference mode to video mode preserves the selected image reference for the next video send.
acceptance:
  - ChatInput sends selected image references as attachments on the shared `/api/chat/send` path and carries video settings only as current-turn preferences.
  - The OpenClaw Agent owns text-to-video, image-to-video, and edit-then-video tool selection from the full session context; UClaw does not run a second semantic router.
  - The Host video capability selects `grok-image-video` when resolved `inputImages` is empty and `grok-video-1.5` when exactly one verified reference image is present.
  - Host validation rejects `grok-video-1.5` without exactly one readable reference image before calling the backend.
  - Task Flow preserves the edited-image dependency and does not silently downgrade a requested image-to-video task to text-to-video.
  - Retired video intent and direct media endpoints cannot accept fresh turns or provide an alternate execution path.
docs:
  required: false
---

## Contract

- OpenClaw owns semantic tool selection and Task Flow dependencies. UClaw owns
  attachment staging, Host-side parameter validation, provider model selection,
  durable task projection, and artifact verification.
- The renderer never passes a provider video model override from the composer.
  It sends the user request, explicit attachments, and current-turn preferences
  through the shared Agent entrypoint.
