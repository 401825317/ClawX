---
id: fix-portable-node-memory-limits
title: Isolate portable OpenClaw child memory limits
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent packaged ACP and completion-cache processes from inheriting unsafe host Node memory flags.
touchedAreas:
  - electron/utils/openclaw-cli.ts
  - tests/unit/openclaw-cli.test.ts
  - harness/specs/tasks/fix-portable-node-memory-limits.md
expectedUserBehavior:
  - Packaged Windows ACP startup ignores host NODE_OPTIONS and receives a controlled 1024 MB old-space limit.
  - Packaged Windows completion-cache generation ignores host NODE_OPTIONS and receives a controlled 512 MB old-space limit.
  - Development ACP startup keeps its existing runtime behavior.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/openclaw-cli.test.ts
acceptance:
  - Host NODE_OPTIONS is absent from packaged OpenClaw child environments.
  - Packaged Windows ACP uses bundled node.exe with a 1024 MB old-space limit.
  - Completion-cache Node flags precede the OpenClaw entry module.
  - Existing Gateway communication boundaries remain unchanged.
  - Comms replay and compare pass.
docs:
  required: false
---

Harden packaged OpenClaw child startup after a Windows USB first-launch incident exhausted V8 memory during concurrent Gateway, ACP, completion-cache, plugin, and Python initialization.
