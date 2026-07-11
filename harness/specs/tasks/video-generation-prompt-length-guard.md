---
id: video-generation-prompt-length-guard
title: Video generation prompt length guard
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent over-limit Grok/xAI video prompts from reaching the upstream video generation provider by enforcing a local final-prompt length guard in UClaw Main process routing and worker execution.
touchedAreas:
  - harness/specs/tasks/video-generation-prompt-length-guard.md
  - electron/api/routes/media.ts
  - electron/utils/media-generation-worker-entry.ts
  - electron/utils/video-generation-prompt-limits.ts
  - electron/utils/video-generation-route-planner.ts
  - electron/utils/media-intent-planner.ts
  - tests/unit/media-generation-worker-entry.test.ts
  - tests/unit/video-generation-chat-send-route.test.ts
  - tests/unit/video-generation-route-planner.test.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - Authorized image and video actions use a `high` reasoning text-planning pass before the media generation API is called; the media generation API itself does not receive reasoning-only parameters.
  - The prompt planner, route guard, and worker guard share one 4096 Unicode-character limit for both text-to-video and image-to-video.
  - Video route planning asks the planner to keep `video_prompt` concise and within the local Grok/xAI safety limit.
  - Final video prompts longer than the local safety limit are rejected locally before a video job is enqueued.
  - Worker execution repeats the same final prompt length guard before calling the video runtime.
acceptance:
  - Explicit image and video mode generation plans include prompt-planning evidence with `reasoningEffort=high`, original character count, and final character count.
  - Prompt-planning failure preserves the authorized media route and falls back to the original prompt instead of silently cancelling generation.
  - Planned video prompts, route validation, and worker validation all use the same exported 4096 Unicode-character limit.
  - POST /api/media/video-generation/chat-send validates the final `route.videoPrompt || prompt` value, not only the raw user prompt.
  - Over-limit final video prompts return a local 400 response with prompt length metadata and do not call `prepareMediaGenerationJob` or `enqueueMediaGenerationJob`.
  - Worker-side over-limit video prompts fail before `generateVideoForChatSession` is called.
requiredTests:
  - tests/unit/video-generation-chat-send-route.test.ts
  - tests/unit/media-generation-worker-entry.test.ts
  - tests/unit/video-generation-route-planner.test.ts
docs:
  required: false
---

## Contract

- The video provider limit is enforced on the final prompt sent to the video
  runtime, after route planning and fallback normalization.
- Planner instructions are a helpful soft limit only; code-level validation is
  the boundary that protects upstream SLA.
- Reasoning belongs to the pre-generation text planner. Image and video model
  requests keep their provider-specific schemas and do not receive
  `reasoning_effort`.
