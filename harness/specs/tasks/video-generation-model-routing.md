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
  - electron/utils/openclaw-video-generation.ts
  - electron/utils/openclaw-video-generation-runtime.ts
  - electron/utils/openclaw-video-relay-constants.ts
  - tests/unit/chat-input.test.tsx
  - tests/unit/chat-target-routing.test.ts
  - tests/unit/openclaw-video-generation-routing.test.ts
  - tests/unit/openclaw-video-generation-runtime-direct.test.ts
  - tests/unit/video-generation-chat-send-route.test.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - Text-only video sends do not reuse old chat images implicitly and route as text-to-video.
  - Explicitly uploaded, pasted, or selected image references in video mode route as image-to-video.
  - Switching from image reference mode to video mode preserves the selected image reference for the next video send.
acceptance:
  - ChatInput sends selected image references as video attachments when the user switches to video mode.
  - Chat store only forwards explicit video attachments as `inputImages`; previous assistant images in history are not auto-attached for video sends.
  - Main video generation routing selects `grok-image-video` when `inputImages` is empty and `grok-video-1.5` when at least one explicit image is present.
  - Direct runtime generation rejects `grok-video-1.5` without exactly one reference image before calling the backend.
docs:
  required: false
---

## Contract

- UClaw client code owns the distinction between explicit reference images and
  old images present in chat history.
- Main process video generation owns the final model selection; renderer should
  not pass a video model override from the composer.
