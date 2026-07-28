---
id: preserve-acp-background-media-projections
title: Preserve ACP media projections during background generation
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep already-rendered historical image and video projections visible when users return to a conversation whose ACP prompt has settled but whose asynchronous media task is still pending.
touchedAreas:
  - harness/specs/tasks/preserve-acp-background-media-projections.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/reference/acp-chat.md
  - src/lib/acp/background-media-projections.ts
  - src/stores/acp-chat-session.ts
  - tests/unit/acp-background-media-projections.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/e2e/chat-acp-attachments.spec.ts
  - tests/e2e/fixtures/electron.ts
expectedUserBehavior:
  - Returning to a conversation during asynchronous image or video generation keeps its previously rendered historical media visible.
  - ACP replay remains authoritative for ordinary text, tools, thoughts, permissions, plans, and ordering.
  - Completing the pending media task does not duplicate previously restored images or attachments.
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
  - session-workspace-authority
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/acp-background-media-projections.test.ts
  - pnpm exec vitest run tests/unit/acp-chat-store.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-acp-attachments.spec.ts --grep "keeps historical media visible while background generation is pending"
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/preserve-acp-background-media-projections.md
acceptance:
  - A background snapshot is eligible only while an image or video task remains pending and its session, workspace root, and cwd match the new load.
  - The new ACP replay remains the timeline authority; only explicitly marked image-generation and OpenClaw MEDIA compatibility projections are restored from memory.
  - Restored projections match a unique semantic user Turn by normalized prompt text and occurrence from the tail; synthetic media is inserted at that Turn's end.
  - Image media identities, compatibility evidence ids, and attachment identities prevent duplicate projections.
  - Restored attachment references are rebound to the active session generation before they can be opened or previewed.
  - Ordinary snapshot messages and process items omitted by ACP replay are not restored.
  - No persistent history cache, transcript polling expansion, OpenClaw source change, or legacy Chat renderer path is introduced.
docs:
  required: true
---

## Scope

Restore only the bounded Renderer compatibility media already present in an in-memory background-generation snapshot after the authoritative ACP replay has completed.

## Out Of Scope

- Reusing an entire older-generation timeline.
- Persisting Renderer timeline snapshots.
- Reconstructing ordinary transcript messages or process events.
- Adding history polling or changing OpenClaw.
