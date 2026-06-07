---
id: extend-chat-send-timeout
title: Extend Gateway chat.send RPC timeout
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Increase desktop chat.send Gateway RPC timeout from 120 seconds to 30 minutes for long-running AI tasks.
touchedAreas:
  - harness/specs/tasks/extend-chat-send-timeout.md
  - shared/chat-timeouts.ts
  - src/stores/chat.ts
  - src/stores/chat/runtime-send-actions.ts
  - electron/api/routes/gateway.ts
  - electron/main/ipc-handlers.ts
  - electron/gateway/client.ts
  - tests/unit/chat-target-routing.test.ts
  - tests/unit/gateway-control-ui-route.test.ts
  - tsconfig.node.json
expectedUserBehavior:
  - Plain text chat sends can wait up to 30 minutes for Gateway chat.send acknowledgement.
  - Attachment chat sends can wait up to 30 minutes for Gateway chat.send acknowledgement.
  - Renderer continues to use the existing Host API and gateway:rpc boundaries.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - comms-regression
requiredTests:
  - pnpm exec vitest run tests/unit/chat-target-routing.test.ts tests/unit/gateway-control-ui-route.test.ts
  - pnpm run typecheck
acceptance:
  - All direct desktop chat.send Gateway RPC calls use a shared 30 minute timeout constant.
  - No renderer page or component adds direct Gateway HTTP calls.
  - No renderer page or component adds direct window.electron.ipcRenderer.invoke calls.
  - Existing Host API and gateway:rpc fallback behavior stays intact.
docs:
  required: false
---
