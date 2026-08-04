---
id: migrate-packaged-regression-host-invoke
title: Migrate packaged regression to the production Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Exercise packaged UClaw through window.clawx.hostInvoke after removal of the local Host API server and deprecated compatibility IPC channels.
touchedAreas:
  - harness/specs/tasks/migrate-packaged-regression-host-invoke.md
  - shared/host-api/contract.ts
  - electron/services/app-api.ts
  - src/lib/host-api.ts
  - tests/packaged-e2e/fixtures/packaged-app.ts
  - tests/packaged-e2e/portable-regression.spec.ts
  - tests/unit/app-api.test.ts
  - tests/unit/host-api-app-quit.test.ts
expectedUserBehavior:
  - No product behavior changes.
  - Packaged Full and Live regression use the same typed Host API boundary as the production renderer.
  - Gateway, Provider, managed account, billing, session, Cron, Agent, Skill, log, and Doctor checks remain covered.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - comms-regression
requiredTests:
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
  - node scripts/windows-support/run-packaged-regression.mjs --profile full
acceptance:
  - Packaged regression does not invoke hostapi:fetch, gateway:rpc, app:quit, or other deprecated compatibility IPC channels.
  - Graceful packaged shutdown uses the typed app.quit Host action and executes Electron's normal quit lifecycle.
  - Host actions and payloads are checked against the shared HostApiContract at compile time.
  - Host transport failures remain distinguishable from unsuccessful action results.
  - The exact production candidate completes packaged Full regression without manual recovery.
docs:
  required: false
---

This is a regression-harness migration. It does not restore the removed local
Host API server or expand the preload IPC allowlist.
