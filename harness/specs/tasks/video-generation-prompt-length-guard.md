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
  - Video route planning asks the planner to keep `video_prompt` concise and within the local Grok/xAI safety limit.
  - Final video prompts longer than the local safety limit are rejected locally before a video job is enqueued.
  - Worker execution repeats the same final prompt length guard before calling the video runtime.
acceptance:
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
