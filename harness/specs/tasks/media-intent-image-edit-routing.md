---
id: media-intent-image-edit-routing
title: Media intent image edit routing
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Route UClaw chat composer media requests through a Main-owned intent planner so current-image edits use image edit inputs instead of silently becoming text-to-image generation.
touchedAreas:
  - harness/specs/tasks/media-intent-image-edit-routing.md
  - src/stores/chat.ts
  - electron/api/routes/media.ts
  - electron/utils/media-intent-planner.ts
  - resources/openclaw-plugins/clawx-openai-image/index.mjs
  - resources/openclaw-plugins/clawx-openai-image/openclaw.plugin.json
  - resources/openclaw-plugins/clawx-openai-image/package.json
  - tests/unit/media-intent-planner.test.ts
  - tests/unit/chat-target-routing.test.ts
  - tests/unit/chat-session-model-switch.test.ts
  - tests/unit/clawx-openai-image-plugin.test.ts
  - tests/unit/image-generation-chat-send-route.test.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - Chat composer sends prompt, explicit image attachments, recent message image candidates, and recent text context to a Main-owned media intent planner before selecting chat, image, video, screenshot, or clarification behavior.
  - Prompts that refer to editing the current, previous, or selected image route to image edit only when the planner binds them to a concrete explicit or candidate image.
  - Current-image edit requests with no usable image context ask the user to upload or select an image instead of falling back to text-to-image generation.
  - OpenAI-compatible image responses that return image URLs still produce local image outputs instead of being parsed as empty results.
acceptance:
  - Renderer media routing no longer depends on local keyword or regular-expression heuristics for image generation, image editing, or desktop screenshot selection.
  - POST /api/media/intent-plan returns a normalized plan from Main process and logs the selected action, selected image source, and selected image count.
  - For `这个图片上能不能加一条狗？` with a recent assistant image, chat send calls image generation chat-send with `inputImages` populated from that image.
  - For the same prompt without any image context, chat send appends a clarification message and does not call chat send or image generation.
  - The bundled OpenAI image plugin parses both `b64_json` and URL-based image outputs.
requiredTests:
  - tests/unit/media-intent-planner.test.ts
  - tests/unit/chat-target-routing.test.ts
  - tests/unit/chat-session-model-switch.test.ts
  - tests/unit/clawx-openai-image-plugin.test.ts
  - tests/unit/image-generation-chat-send-route.test.ts
docs:
  required: false
---

## Contract

- Prompt text is user intent only. Routing must combine prompt, current
  composer attachments, recent message image context, and planner output.
- If the selected action is image edit, a concrete source image is mandatory.
  Missing source images become clarification, never text-to-image generation.
- Renderer stays behind `hostApiFetch`; model-backed intent planning and
  media route logging live in Electron Main.
