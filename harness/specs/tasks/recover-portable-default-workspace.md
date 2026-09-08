---
id: recover-portable-default-workspace
title: Recover the portable default workspace during startup
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent a transient portable-runtime startup race from leaving the UClaw default workspace permanently unavailable in chat.
touchedAreas:
  - electron/main/app-runtime.ts
  - src/pages/Chat/index.tsx
  - tests/unit/app-runtime-managed-gates.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/e2e/chat-workspace-context.spec.ts
  - harness/specs/tasks/recover-portable-default-workspace.md
expectedUserBehavior:
  - The managed default workspace exists before the main chat renderer loads.
  - A transient workspace check failure recovers when the Gateway runtime becomes ready or the window regains focus.
  - Missing user-selected workspaces remain unavailable and are never recreated automatically.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/app-runtime-managed-gates.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/e2e/chat-workspace-context.spec.ts
acceptance:
  - Portable runtime preparation completes before the default workspace is seeded.
  - Default workspace seeding completes before the main renderer is loaded.
  - Workspace availability is rechecked after Gateway runtime identity changes and window focus.
  - Renderer continues to resolve workspaces only through the host API.
  - Comms replay and compare pass.
docs:
  required: false
---

This is a startup recovery fix. It does not change workspace selection, session binding, model routing, billing, or video behavior.
