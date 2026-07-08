---
id: gpt55-tool-call-diagnostics
title: Add diagnostics for GPT-5.5 tool-call contract drift
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add low-noise diagnostics that show whether OpenClaw model requests include tools, whether the raw ChatCompletions stream returned tool_calls, whether OpenClaw parsed tool-call signals, and whether UClaw executed them, so GPT-5.5 "promise-only" behavior can be diagnosed by layer.
touchedAreas:
  - harness/specs/tasks/gpt55-tool-call-diagnostics.md
  - electron/gateway/gateway-entry-wrapper.cjs
  - electron/gateway/gateway-fetch-preload.cjs
  - electron/gateway/startup-stderr.ts
  - electron/gateway/manager.ts
  - electron/gateway/event-dispatch.ts
  - scripts/openclaw-raw-tool-signal-patch.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/bundle-openclaw.mjs
  - tests/unit/gateway-event-dispatch.test.ts
  - tests/unit/gateway-process-launcher.test.ts
  - tests/unit/gateway-startup-stderr.test.ts
expectedUserBehavior:
  - Normal chat, tool execution, and Gateway startup behavior remain unchanged.
  - UClaw logs include a redacted Gateway fetch preload readiness diagnostic before OpenClaw is imported, including packaged desktop builds where NODE_OPTIONS preloading is unavailable.
  - UClaw logs include OpenClaw model transport summaries for model endpoints, including provider, API, model id, status, elapsed time, and content type.
  - UClaw logs include ChatCompletions raw tool signal summaries after each streamed completion, including rawToolCallDeltaSeen, rawToolCallDeltaCount, rawToolCallNames, parsedToolCallCount, parsedToolCallNames, stopReason, and finishReasons.
  - UClaw logs include chat message signal summaries for Gateway chat messages, including role, content shape, tool-call counts, function-call presence, and top-level keys.
  - Prompt bodies may remain visible in UClaw local diagnostic logs during this investigation, but logs must not include authorization headers, API keys, bearer tokens, or raw tool argument payloads.
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
  - Gateway stdout classification routes OpenClaw `[model-fetch]` and `[completions] raw_tool_signal` lines as info instead of warnings.
  - Chat message diagnostics expose tool-call/function-call structure without logging message text or tool arguments.
  - The raw tool signal diagnostic distinguishes provider-no-tool (`rawToolCallDeltaSeen=false, parsedToolCallCount=0`), parser/compat loss (`rawToolCallDeltaSeen=true, parsedToolCallCount=0`), and execution-layer loss (`parsedToolCallCount>0` without tool.started).
docs:
  required: false
---
