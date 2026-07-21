---
id: fix-uclaw-gateway-startup-race
title: Serialize UClaw Gateway startup and provider refresh
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent managed-provider startup verification and deferred Gateway reloads from starting a second Gateway while a restart is already in flight, without changing the managed chat, image, video, or artifact contracts.
touchedAreas:
  - harness/specs/tasks/fix-uclaw-gateway-startup-race.md
  - electron/gateway/manager.ts
  - electron/services/providers/provider-runtime-sync.ts
  - docs/uclaw-runtime-release-deep-dive.md
  - scripts/gateway-startup-serialization.test.ts
  - tests/e2e/gateway-lifecycle.spec.ts
expectedUserBehavior:
  - UClaw starts one Gateway process when managed provider migration, account verification, and automatic startup overlap.
  - Provider synchronization performed while Gateway is stopped or starting is consumed by the current startup and does not schedule a redundant reload.
  - A public Gateway start request arriving during restart waits for and reuses that restart instead of competing for port 18789.
  - Existing chat, image, video, tool authorization, execution queue, artifact verification, history refresh, and progress behavior remain unchanged.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - backend-communication-boundary
  - gateway-readiness-policy
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/fix-uclaw-gateway-startup-race.md --since HEAD
  - pnpm harness run --spec harness/specs/tasks/fix-uclaw-gateway-startup-race.md --dry-run --since HEAD
  - pnpm exec tsx --test scripts/gateway-startup-serialization.test.ts
  - pnpm exec eslint electron/gateway/manager.ts electron/services/providers/provider-runtime-sync.ts scripts/gateway-startup-serialization.test.ts tests/e2e/gateway-lifecycle.spec.ts
  - pnpm run typecheck
  - pnpm exec playwright test tests/e2e/gateway-lifecycle.spec.ts --workers=1
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Runtime provider refresh with `onlyIfRunning` schedules work only when Gateway state is exactly `running`.
  - `starting`, `stopped`, `reconnecting`, and `error` states do not enqueue provider-driven Gateway reloads.
  - Public `GatewayManager.start()` joins an existing restart promise and does not acquire the start lock or spawn a process while that restart is active.
  - The restart-owned internal start path bypasses only the public join guard and cannot be used by provider verification or renderer/API callers.
  - Rejected restart promises propagate to joining start callers without launching a fallback process.
  - Lifecycle diagnostics identify a start request that joined an in-flight restart.
  - Renderer transport remains host-api/Main owned; no direct Gateway HTTP or IPC path is added.
docs:
  required: true
---

## Evidence

The Windows UClaw 1.0.2 field log showed the same startup race twice. A managed
provider save scheduled a deferred reload while Gateway was starting. When the
first start completed, JunFeiAI background verification observed the temporary
`stopped` state and entered `start()` while the deferred restart still owned the
lifecycle. The restart-owned start was then ignored, and a remaining Gateway
listener was misclassified as an external owner of port 18789.

## Scope

This task serializes lifecycle ownership and corrects provider refresh gating.
It does not change provider endpoints, credentials, model mappings, media modes,
tool side-effect authorization, task recovery, or artifact delivery.
