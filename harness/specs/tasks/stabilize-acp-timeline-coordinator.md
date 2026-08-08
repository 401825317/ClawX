---
id: stabilize-acp-timeline-coordinator
title: Stabilize ACP timeline ownership and media delivery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Give each ACP session and user Turn one deterministic ClawX timeline owner so live text, tools, transcript MEDIA, generated images, videos, and attachment resolutions cannot overwrite, reorder, or silently drop one another.
touchedAreas:
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - harness/specs/tasks/stabilize-acp-timeline-coordinator.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/specs/rules/acp-compatibility-content-safety.md
  - harness/reference/acp-chat.md
  - harness/reference/acp-generated-media-and-diagnostics.md
  - docs/superpowers/plans/2026-08-08-acp-timeline-coordinator.md
  - src/lib/acp/session-timeline-coordinator.ts
  - src/lib/acp/reducer.ts
  - src/lib/acp/timeline-types.ts
  - src/lib/acp/attachments.ts
  - src/lib/acp/background-media-projections.ts
  - src/lib/acp/transcript-supplement.ts
  - src/stores/acp-chat-session.ts
  - tests/unit/acp-session-timeline-coordinator.test.ts
  - tests/unit/acp-reducer.test.ts
  - tests/unit/acp-media-attachments.test.ts
  - tests/unit/acp-background-media-projections.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/e2e/chat-acp-attachments.spec.ts
  - tests/e2e/chat-acp-inline-timeline.spec.ts
expectedUserBehavior:
  - Live Assistant text keeps streaming before and after tool calls and is never closed or replaced by a generated-media compatibility projection.
  - An accepted image, video, or explicit assistant MEDIA attachment reaches a visible terminal state without requiring the user to switch conversations.
  - Starting another prompt or visiting another conversation does not cancel the previous Turn's accepted media delivery.
  - Returning to a conversation restores its latest media projection without replaying ordinary history into the end of the timeline.
  - Repeated live, transcript, and history evidence updates one stable item and never duplicates or reorders existing conversation content.
  - Long conversations remain bounded in Renderer memory and live chunks remain visibly incremental.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-api-fallback-policy
  - host-events-fallback-policy
  - acp-chat-state-and-history
  - acp-compatibility-content-safety
  - attachment-access-safety
  - diagnostics-trace-safety
  - session-workspace-authority
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/acp-session-timeline-coordinator.test.ts tests/unit/acp-reducer.test.ts tests/unit/acp-media-attachments.test.ts tests/unit/acp-background-media-projections.test.ts tests/unit/acp-chat-store.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-acp-attachments.spec.ts tests/e2e/chat-acp-inline-timeline.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/stabilize-acp-timeline-coordinator.md
  - pnpm harness run --spec harness/specs/tasks/stabilize-acp-timeline-coordinator.md
acceptance:
  - OpenClaw remains pinned to 2026.6.10 and neither its source nor bundled runtime patch is changed by this task.
  - All live and asynchronous timeline mutations pass through one session-scoped coordinator commit path with a monotonically increasing revision.
  - OpenClaw updates keep their receive order; late evidence can update only its stable Turn anchor and cannot trigger timestamp sorting.
  - Missing ACP message ids use a session-local monotonic identity that is independent of item count and remains stable until a real process boundary.
  - Compatibility media is a monotonic overlay keyed by session, Turn, source, and evidence identity; applying it does not close an ACP message segment.
  - A full Assistant message preserves already-resolved media parts and cannot downgrade an available attachment to pending or unavailable.
  - Transcript supplement operations are isolated by session and live user message, execute retries serially, and survive a new prompt or navigation.
  - Attachment resolution commits to the owning active or retained background session; an inactive result never writes into another conversation.
  - History replay is authoritative only for its base snapshot and then reapplies bounded compatibility overlays idempotently.
  - Accepted evidence ends as available media, an explicit unavailable attachment, or an approved remote fallback; it is never silently discarded.
  - Diagnostic records remain bounded, reason-coded, and free of transcript text, credentials, raw paths, or file contents.
  - Renderer retention is bounded and does not create a persistent second Chat history database.
docs:
  required: true
---

## Scope

Refactor only the ClawX ACP Renderer timeline ownership, Turn correlation, compatibility-media delivery, and related recovery behavior. Existing Chat presentation, tool grouping, provider behavior, OpenClaw protocol, and attachment authorization remain unchanged.

## Out Of Scope

- Modifying, patching, or upgrading OpenClaw 2026.6.10.
- Replacing OpenClaw transcripts with a ClawX-owned Chat history database.
- Periodically polling or replaying complete conversation history.
- Changing image/video provider APIs, generation parameters, or download protocols.
- Redesigning user-visible Chat components.
