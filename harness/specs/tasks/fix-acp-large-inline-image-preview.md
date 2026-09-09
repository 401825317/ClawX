---
id: fix-acp-large-inline-image-preview
title: Render large ACP images through bounded previews
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep generated images visible in ACP Chat without retaining full-size data URIs in Renderer state.
touchedAreas:
  - harness/specs/tasks/fix-acp-large-inline-image-preview.md
  - harness/reference/acp-generated-media-and-diagnostics.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - electron/main/app-runtime.ts
  - electron/services/acp-chat-service.ts
  - electron/services/media-api.ts
  - src/lib/acp/content-blocks.ts
  - shared/chat/media-limits.ts
  - tests/unit/app-runtime-managed-gates.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/media-api.test.ts
  - tests/unit/acp-chat-store.test.ts
expectedUserBehavior:
  - A generated 2K image appears as an in-chat preview instead of an unsupported-content error.
  - Opening the preview reads the full original only after user action.
  - Large image bytes never remain in the Renderer timeline.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - attachment-access-safety
  - acp-chat-state-and-history
  - acp-compatibility-content-safety
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/acp-chat-service.test.ts tests/unit/media-api.test.ts tests/unit/acp-chat-store.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Main materializes trusted over-limit ACP image data into a session/generation-scoped managed-media record before forwarding the update.
  - Renderer receives a bounded preview plus a scoped attachment reference, never the full original data URI.
  - Preview encoding remains within the inline preview budget; lack of a preview retains an actionable image attachment instead of an unsupported-content error.
  - Stale session/generation references, invalid image data, and over-budget materialization are rejected without leaking a local path or leaving files behind.
docs:
  required: true
---
