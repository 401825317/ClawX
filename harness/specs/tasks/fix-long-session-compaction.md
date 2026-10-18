---
id: fix-long-session-compaction
title: Cancel and drain long-session compaction before recovery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Repair the customer overflow, timed-out compaction and subsequent session-lock failure chain without replaying completed work or concealing provider quota errors.
touchedAreas:
  - scripts/openclaw-compaction-recovery-patch.mjs
  - scripts/openclaw-provider-terminal-error-patch.mjs
  - scripts/openclaw-acp-terminal-error-patch.mjs
  - scripts/bundle-openclaw.mjs
  - package.json
  - tests/unit/openclaw-compaction-recovery-patch.test.ts
  - tests/unit/openclaw-provider-terminal-error-patch.test.ts
  - tests/unit/acp-chat-errors.test.ts
  - shared/acp-chat/errors.ts
  - harness/specs/tasks/fix-long-session-compaction.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - docs/customer-incident-20261016.md
expectedUserBehavior:
  - Context compaction forwards caller cancellation through the legacy runtime bridge into the native session.
  - Timeout recovery waits a bounded interval for compaction cleanup before attempting another session writer.
  - Explicit managed balance and subscription failures stop summarization retries and progressive fallback.
  - Abort and timeout never become a successful size-only summary that discards the active task.
  - Successful long-session compaction retains task identifiers and completed tool evidence for continuation.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - acp-chat-state-and-history
  - diagnostics-trace-safety
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-compaction-recovery-patch.test.ts tests/unit/openclaw-acp-terminal-error-patch.test.ts tests/unit/openclaw-provider-terminal-error-patch.test.ts tests/unit/acp-chat-errors.test.ts tests/unit/acp-chat-service.test.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Reproduce the dropped abort signal from the installed OpenClaw 2026.6.10 bridge before asserting the fix.
  - Use the actual installed timeout wrapper, legacy delegate and session-lock implementation for timeout and immediate reacquisition checks; replace only the expensive native model entrypoint in the deterministic fixture.
  - Ordinary transient provider retries and plugin compaction timeout bounds remain intact.
  - Version and exact source layout checks reject unsupported chunks before any writes, and patching is idempotent.
  - Patch changes are applied by both postinstall and packaging, never only by editing node_modules.
  - No production billing writes or paid customer model requests are required for deterministic regression.
  - A package is not considered customer-ready until the failure-path regression and packaged verification pass.
docs:
  required: true
---

The customer log contains two separate compaction timeout episodes followed about
one minute later by SessionWriteLockTimeoutError. The legacy context-engine
delegate drops params.abortSignal. The outer safety timeout can therefore return
while native compaction still owns the same session lock. Summarization also
retries terminal quota errors and catches aborts as progressive size fallback.

Preserve the transcript and completed actions. Never manufacture a successful
summary from an aborted or terminally rejected model request. Deterministic tests
establish runtime cancellation, cleanup ordering and quota call counts; they do
not establish the customer's actual final artifact or historical billing.
