---
id: fix-chat-reference-image-provenance
title: Keep chat reference images separate from generated output artifacts
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Preserve user-uploaded images as input references during history replay without copying them into assistant replies or classifying them as generated artifacts.
touchedAreas:
  - harness/specs/tasks/fix-chat-reference-image-provenance.md
  - src/pages/Chat/index.tsx
  - src/stores/chat.ts
  - src/stores/chat/helpers.ts
  - src/stores/chat/runtime-evidence.ts
  - src/stores/chat/types.ts
  - tests/e2e/chat-reference-image-provenance.spec.ts
  - scripts/chat-reference-image-provenance-replay.test.ts
expectedUserBehavior:
  - A reference image uploaded for a video or other task remains visible on the user message and is not repeated under the assistant reply.
  - Reopening or reloading the conversation does not turn the reference input into a generated image artifact.
  - The compact execution summary does not say “图片已生成” unless an image-generation operation delivered an image output.
  - Explicit assistant media delivery, including a same-path output, remains renderable and eligible for artifact tracking.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - comms-regression
requiredTests:
  - pnpm exec tsx scripts/chat-reference-image-provenance-replay.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-reference-image-provenance.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - User attachments carry input-reference provenance through optimistic rendering and the local image cache.
  - History enrichment never inherits a raw path from a preceding user message into an assistant message.
  - Input-reference attachments cannot emit artifact.produced events or satisfy final artifact-delivery evidence.
  - Historical replay excludes legacy assistant attachment copies that match the current user turn's input paths unless the assistant explicitly delivers that path.
  - Completed image or video summaries require both a matching generation operation and a matching output artifact.
  - The fix performs only bounded linear scans over messages and attachment paths, with no file hashing, file reads, new RPC, or polling.
docs:
  required: false
---
