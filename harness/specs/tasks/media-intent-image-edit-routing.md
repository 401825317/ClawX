---
id: media-intent-image-edit-routing
title: Media intent image edit routing
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep current-image edits in the native Agent turn while binding an unselected edit request to the latest usable image from the same session.
touchedAreas:
  - harness/specs/tasks/media-intent-image-edit-routing.md
  - src/stores/chat.ts
  - electron/api/routes/chat.ts
  - tests/e2e/native-agent-media-routing.spec.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - A regular chat request that clearly edits an image and has no explicit image attachment uses the chronologically latest usable image from the same session.
  - The bound image travels through the existing `gatewayReferenceImages`, media attachment, and client preference contract of one native Agent turn.
  - A current-image edit request with no usable image context asks the user to upload or select an image and does not start an Agent run.
acceptance:
  - For `把这张图片加一条狗` with a recent session image, the native chat send includes that image as a media reference.
  - For the same prompt without any image context, the UI appends a clarification message and does not call the native chat send route.
  - Image/video mode keeps its existing reference resolution and no legacy `/api/media/image-generation/chat-send` route is restored.
requiredTests:
  - tests/e2e/native-agent-media-routing.spec.ts
docs:
  required: false
---

## Contract

- Explicit attachments always take precedence. Only a clear image-edit request
  may implicitly select the latest session image.
- Missing source images become clarification, never an implicit text-to-image
  request. Renderer-to-Main communication remains behind `hostApiFetch`.
