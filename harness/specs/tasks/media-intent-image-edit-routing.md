---
id: media-intent-image-edit-routing
title: Retire the legacy UClaw media intent bypass
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep OpenClaw as the only owner of chat-turn intent and image continuation while preventing the retired UClaw planner and direct media chat-send routes from creating parallel side effects.
touchedAreas:
  - harness/specs/tasks/media-intent-image-edit-routing.md
  - harness/specs/tasks/openclaw-native-media-host-bridge.md
  - electron/api/routes/media.ts
  - tests/e2e/native-agent-media-routing.spec.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - Ordinary, image-mode, and video-mode messages enter one OpenClaw Agent turn through `/api/chat/send`.
  - Image/video modes contribute current-turn preferences and selected artifacts, but do not authorize or enqueue media work themselves.
  - OpenClaw resolves references such as the current or previous image from session context and invokes the native image tool when appropriate.
  - Existing provider settings/tests and media job inspection/cancel/retry remain available after the bypass is retired.
acceptance:
  - The renderer never calls `/api/media/intent-plan`, `/api/media/image-generation/chat-send`, or `/api/media/video-generation/chat-send` for a user turn.
  - All three retired POST routes return HTTP 410 with `code=media_agent_bypass_retired` and point callers to `/api/chat/send`.
  - A retired route cannot call a model planner, enqueue a media job, or append a synthetic assistant transcript.
  - Existing session artifacts and persisted media job records remain readable and cancellable.
  - Image and video provider configuration, provider discovery, and provider test routes are unchanged.
requiredTests:
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts
  - pnpm harness validate --spec harness/specs/tasks/media-intent-image-edit-routing.md --since HEAD
  - pnpm exec tsc --noEmit --pretty false
docs:
  required: false
---

## Contract

- Prompt text and conversation context belong to OpenClaw's Agent loop.
- UClaw mode state is a preference contract, not a second semantic router.
- Legacy bypasses fail closed so an older renderer cannot double-submit paid
  image or video work. Compatibility is preserved at the persisted job and
  artifact layer, not by keeping a second execution path alive.
