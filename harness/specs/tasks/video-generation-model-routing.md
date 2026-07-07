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
  - Video sends are planned by a Main-owned intent router before selecting text-to-video, image-to-video, or edit-image-then-video behavior.
  - Text-only video sends do not pass old chat images as direct `inputImages`; recent chat images may be sent only as `candidateImages` for the router.
  - Video prompts that refer to previous/current/reference images let the router choose whether to use the latest candidate image.
  - Prompts that ask to alter a referenced image before making a video run image edit first, then feed the edited local image into image-to-video.
  - Explicitly uploaded, pasted, or selected image references in video mode are available to the router as direct `inputImages`.
  - Switching from image reference mode to video mode preserves the selected image reference for the next video send.
acceptance:
  - ChatInput sends selected image references as video attachments when the user switches to video mode.
  - Chat store forwards explicit video attachments as `inputImages`; previous assistant images in history are forwarded as `candidateImages`, not direct `inputImages`.
  - Main video chat-send calls the video route planner and stores its route decision on the queued video job.
  - Low-confidence, failed, or unavailable route planning falls back to explicit-image image-to-video or no-image text-to-video without failing the user request.
  - The edit-image-then-video route first generates an edited local image and then calls image-to-video with that edited image.
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
