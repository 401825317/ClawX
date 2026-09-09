---
id: fix-session-switch-flash-and-reasoning-off
title: Prevent stale ACP timeline during session selection
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep managed-model Think Off metadata explicit and prevent prior ACP content from flashing while a newly selected session loads.
touchedAreas:
  - harness/specs/tasks/fix-session-switch-flash-and-reasoning-off.md
  - electron/services/providers/managed-runtime-config.ts
  - src/components/layout/Sidebar.tsx
  - src/pages/Chat/index.tsx
  - tests/unit/managed-runtime-config.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/e2e/chat-acp-inline-timeline.spec.ts
expectedUserBehavior:
  - Selecting Think Off for a managed Responses model preserves the explicit `none` effort mapping in the generated runtime configuration.
  - Selecting a different conversation never briefly renders the prior conversation's ACP timeline.
  - The composer remains unavailable until the selected conversation owns the active ACP timeline.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - provider-model-metadata-preservation
  - acp-chat-state-and-history
  - sidebar-session-attention-authority
  - renderer-main-boundary
  - backend-communication-boundary
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/managed-runtime-config.test.ts tests/unit/chat-acp-page.test.tsx
  - pnpm exec playwright test tests/e2e/chat-acp-inline-timeline.spec.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Managed Responses model metadata maps Think Off to the supported `none` effort without changing the reasoning display default.
  - Sidebar selection uses the ACP session coordinator as the sole session-selection path.
  - Renderer shows a loading state rather than stale ACP content while selected and active ACP session keys differ.
  - Live timeline updates for the active session remain visible without treating transient timeline generation IDs as a session switch.
  - Renderer adds no direct IPC or Gateway HTTP call.
docs:
  required: false
---

This task keeps ACP replay as the history authority. It only closes the brief state handoff between sidebar selection and ACP timeline ownership.
