---
id: gpt55-tool-call-diagnostics
title: Add diagnostics for GPT-5.5 tool-call contract drift
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add low-noise, redacted diagnostics that show whether OpenClaw model requests include tools and whether Gateway chat messages/responses contain tool-call signals, so GPT-5.5 "promise-only" behavior can be diagnosed without logging prompt bodies or secrets.
touchedAreas:
  - harness/specs/tasks/gpt55-tool-call-diagnostics.md
  - electron/gateway/gateway-entry-wrapper.cjs
  - electron/gateway/gateway-fetch-preload.cjs
  - electron/gateway/startup-stderr.ts
  - electron/gateway/manager.ts
  - electron/gateway/event-dispatch.ts
  - tests/unit/gateway-event-dispatch.test.ts
  - tests/unit/gateway-process-launcher.test.ts
  - tests/unit/gateway-startup-stderr.test.ts
expectedUserBehavior:
  - Normal chat, tool execution, and Gateway startup behavior remain unchanged.
  - UClaw logs include a redacted Gateway fetch preload readiness diagnostic before OpenClaw is imported, including packaged desktop builds where NODE_OPTIONS preloading is unavailable.
  - UClaw logs include redacted model fetch request summaries for model endpoints, including model id, endpoint shape, stream flag, message/input counts, tools count, tool names, and tool choice.
  - UClaw logs include redacted model fetch response summaries, including status, elapsed time, output/tool-call signal counts, and function-call signal presence.
  - UClaw logs include redacted chat message signal summaries for Gateway chat messages, including role, content shape, tool-call counts, function-call presence, and top-level keys.
  - Logs must not include user prompt text, assistant response text, authorization headers, API keys, or raw tool arguments.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - gateway-readiness-policy
requiredTests:
  - pnpm exec vitest run tests/unit/gateway-event-dispatch.test.ts tests/unit/gateway-process-launcher.test.ts tests/unit/gateway-startup-stderr.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - The Gateway wrapper loads the fetch preload before importing OpenClaw so packaged builds get the same diagnostics path as dev.
  - Model request diagnostics are emitted from the Gateway child process preload only for recognized model endpoints.
  - Model response diagnostics use bounded response sampling and only report derived fields, never raw response text.
  - Gateway stderr classification routes model fetch diagnostics as info instead of warnings.
  - Chat message diagnostics expose tool-call/function-call structure without logging message text or tool arguments.
docs:
  required: false
---
