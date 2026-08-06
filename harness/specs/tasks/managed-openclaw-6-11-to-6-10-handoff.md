---
id: managed-openclaw-6-11-to-6-10-handoff
title: Safely hand OpenClaw 2026.6.11 user state to the managed 2026.6.10 runtime
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Let Windows portable users upgrade from a ClawX build that wrote OpenClaw 2026.6.11 state to the current UClaw build fixed on OpenClaw 2026.6.10 without losing config or entering a Gateway reconnect loop.
touchedAreas:
  - harness/specs/tasks/managed-openclaw-6-11-to-6-10-handoff.md
  - electron/gateway/openclaw-downgrade.ts
  - electron/gateway/config-sync-env.ts
  - electron/gateway/process-launcher.ts
  - electron/gateway/startup-orchestrator.ts
  - electron/gateway/startup-recovery.ts
  - electron/gateway/manager.ts
  - package.json
  - pnpm-lock.yaml
  - tests/unit/openclaw-downgrade.test.ts
  - tests/unit/gateway-manager-mutation-barrier.test.ts
  - tests/unit/gateway-manager-restart-recovery.test.ts
  - tests/unit/gateway-process-launcher.test.ts
  - tests/unit/gateway-startup-orchestrator.test.ts
  - tests/unit/gateway-startup-recovery.test.ts
expectedUserBehavior:
  - Existing OpenClaw 2026.6.10 users start normally with no migration work.
  - OpenClaw 2026.6.11 user state is validated, backed up, and handed to the bundled 2026.6.10 runtime once.
  - A second launch uses 2026.6.10 normally without the destructive-action override.
  - Unsupported newer state is left untouched and does not trigger Doctor or reconnect loops.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - gateway-readiness-policy
  - active-config-guards
  - comms-regression
  - docs-sync
requiredTests:
  - tests/unit/openclaw-downgrade.test.ts
  - tests/unit/gateway-manager-mutation-barrier.test.ts
  - tests/unit/gateway-manager-restart-recovery.test.ts
  - tests/unit/gateway-process-launcher.test.ts
  - tests/unit/gateway-startup-orchestrator.test.ts
  - tests/unit/gateway-startup-recovery.test.ts
acceptance:
  - Automatic handoff is restricted to OpenClaw 2026.6.11 state and the bundled 2026.6.10 runtime.
  - The active config passes the bundled 2026.6.10 read-only validator before any managed startup write.
  - The original config is backed up before UClaw prelaunch synchronization or OpenClaw startup migration.
  - Managed validation and stamping preserve the configured OpenClaw state directory when the config file lives elsewhere.
  - OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS is absent by default and present only in controlled child processes.
  - The bundled 2026.6.10 config writer stamps ownership only after the controlled Gateway reports ready.
  - Failed handoff restores the backup and suppresses internal retry, Doctor repair, and automatic reconnect.
  - A failed handoff never restores the config while the controlled Gateway may still be running.
  - Normal transient Gateway startup recovery remains unchanged outside the handoff flow.
docs:
  required: false
  reason: This is a narrowly scoped compatibility repair for an existing portable upgrade path; it adds no user-facing workflow or public interface.
references:
  - harness/specs/scenarios/gateway-backend-communication.md
---

## Scope

- Detect and validate the single supported 2026.6.11 to 2026.6.10 compatibility handoff.
- Preserve the original config and make the handoff transactional and retry-safe.
- Prevent the known future-config guard from entering layered Gateway recovery loops.

## Out Of Scope

- Upgrading the bundled OpenClaw version.
- Supporting arbitrary OpenClaw downgrades.
- Changing providers, models, plugins, chat rendering, or renderer transport behavior.
