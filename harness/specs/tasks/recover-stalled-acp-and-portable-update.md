---
id: recover-stalled-acp-and-portable-update
title: Recover stalled ACP initialization and portable shutdown
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep Chat usable when an ACP child is slow to complete its first protocol handshake, make the stall diagnosable without recording user content, and ensure app shutdown explicitly terminates owned ACP children before the portable updater replaces files.
expectedUserBehavior:
  - On a slow Windows machine, opening or returning to Chat waits for one controlled ACP startup attempt instead of rapidly killing and respawning ACP children every 15 seconds.
  - Chat continues to show its normal session-loading state only while the session bridge is genuinely loading; no model prompt is replayed automatically.
  - If ACP cannot become usable within the bounded startup budget, the client recovers the runtime through the existing Gateway lifecycle rather than leaving the page in an unbounded spinner.
  - A portable update either begins after UClaw and its owned children have exited or reports which residual child process prevented replacement.
touchedAreas:
  - harness/specs/tasks/recover-stalled-acp-and-portable-update.md
  - electron/services/acp-chat-service.ts
  - electron/services/chat-api.ts
  - electron/gateway/manager.ts
  - electron/main/app-runtime.ts
  - electron/utils/control-ui-device-pairing.ts
  - src/pages/Chat/index.tsx
  - tools/portable-updater/wait_windows.go
  - tools/portable-updater/wait_windows_test.go
  - tests/unit/acp-chat-service.test.ts
  - tests/e2e/chat-acp-inline-timeline.spec.ts
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - gateway-readiness-policy
  - acp-chat-state-and-history
  - diagnostics-trace-safety
  - renderer-main-boundary
  - backend-communication-boundary
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec tsc --noEmit -p tsconfig.node.json --composite false
  - pnpm exec tsc --noEmit -p tsconfig.web.json --composite false
  - pnpm exec playwright test tests/e2e/chat-acp-inline-timeline.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/recover-stalled-acp-and-portable-update.md
  - pnpm harness run --spec harness/specs/tasks/recover-stalled-acp-and-portable-update.md --dry-run
acceptance:
  - ACP startup uses one bounded handshake budget that accommodates slow packaged Windows startup but cannot leave Chat loading indefinitely.
  - A live ACP process whose handshake has exceeded that budget is terminated once; the same unresponsive Gateway is not immediately retried with a duplicate ACP child.
  - Diagnostics distinguish child spawn, initialize request, first protocol response, timeout, and child termination using only elapsed times, PIDs, and reason codes.
  - App quit explicitly disposes the owned ACP child before waiting for the owned Gateway, so portable updating does not depend on an orphaned ACP process eventually exiting.
  - The detached portable updater never kills an unverified task PID; when shutdown exceeds 45 seconds, its Windows diagnostics identify surviving observed child PIDs and executable names.
  - Renderer keeps its existing Main-owned host API and Gateway transport boundary, and no prompt is automatically replayed.
docs:
  required: false
---

## Scope

This is a process lifecycle and readiness repair. The visual loading state remains
the renderer's existing ACP state; it must not hide an in-progress prompt or
invent a second transcript source. The Main process owns all process creation,
termination, protocol timing, and recovery decisions.

## Out Of Scope

- Changing provider/model selection, reasoning policy, or upstream request retries.
- Logging prompt text, tokens, credentials, filesystem paths, or raw ACP frames.
- Making the portable updater force-kill PIDs supplied through its task file.
