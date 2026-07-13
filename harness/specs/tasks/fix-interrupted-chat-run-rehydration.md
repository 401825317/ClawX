---
id: fix-interrupted-chat-run-rehydration
title: Prevent interrupted chat runs from reviving after restart
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Use current Gateway liveness instead of immutable transcript gaps when restoring chat composer state, and prevent session switches from reviving stale run or async-task state.
touchedAreas:
  - harness/specs/tasks/fix-interrupted-chat-run-rehydration.md
  - src/stores/chat.ts
  - src/stores/chat/helpers.ts
  - tests/e2e/chat-run-state-events.spec.ts
  - scripts/chat-async-task-terminal-replay.test.ts
expectedUserBehavior:
  - Restarting ClawX after interrupting a turn does not leave the composer on Stop or show “正在整理执行结果…” when the current Gateway reports no active run.
  - Switching away and back does not briefly restore a run that became idle while its session was offscreen.
  - A run explicitly reported by chat.history or sessions.list as active remains active even when persisted session status still says done.
  - A terminal async task cannot be downgraded to pending by replaying an older transcript snapshot.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - comms-regression
requiredTests:
  - pnpm exec tsx --test scripts/chat-async-task-terminal-replay.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-run-state-events.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - chat.history sessionInfo.hasActiveRun and inFlightRun are consumed from the same response as messages.
  - hasActiveRun=true or an inFlightRun takes precedence over stale terminal session metadata.
  - An explicit idle observation cannot clear a user turn that began after the corresponding history request started.
  - History-only open tool segments remain available for transcript projection but cannot arm sending, activeRunId, or pendingFinal.
  - Backend idle settlement clears the matching offscreen session cache and rejects a stale expectedRunId.
  - Detached-task terminal state is monotonic across history replay.
  - The fix adds no session-switch RPC, global polling loop, or unbounded cache.
docs:
  required: false
---
