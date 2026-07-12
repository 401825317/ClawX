---
id: video-generation-prompt-length-guard
title: Video generation prompt length guard
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep the 4096-character provider boundary in the executable video worker while ensuring chat turns reach video generation only through OpenClaw's native Agent tool path.
touchedAreas:
  - harness/specs/tasks/video-generation-prompt-length-guard.md
  - electron/utils/media-generation-worker-entry.ts
  - electron/utils/video-generation-prompt-limits.ts
  - electron/api/routes/media.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - Chat, image-mode, and video-mode requests first enter OpenClaw's Agent loop; UClaw does not shorten or authorize a video prompt in a parallel chat-send route.
  - The executable video worker enforces the shared 4096 Unicode-character limit immediately before calling the provider runtime.
  - The retired `/api/media/video-generation/chat-send` route returns HTTP 410 and never enqueues a video job.
acceptance:
  - Worker-side over-limit video prompts fail before `generateVideoForChatSession` is called.
  - The shared `MAX_VIDEO_GENERATION_PROMPT_CHARS` constant remains 4096.
  - Normal video-mode sends use `/api/chat/send` with video preferences and never call a direct media chat-send route.
  - The retired direct route cannot bypass Agent authorization, prompt validation, idempotency, or the native task ledger.
requiredTests:
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - pnpm harness validate --spec harness/specs/tasks/video-generation-prompt-length-guard.md --since HEAD
  - pnpm exec tsc --noEmit --pretty false
docs:
  required: false
---

## Contract

- Prompt planning belongs to OpenClaw's Agent loop.
- Parameter limits belong at both the native tool schema and the final provider
  execution boundary. This spec retains the worker boundary; the retired
  UClaw chat-send route is not a compatibility path.
