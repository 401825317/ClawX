---
id: reduce-client-preparation-overhead
title: Reduce measured client preparation overhead
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Attribute repeated authentication and tool preparation work before removing redundant immutable work without weakening runtime behavior.
touchedAreas:
  - scripts/diagnostics/**
  - scripts/openclaw-preparation-patch.mjs
  - scripts/bundle-openclaw.mjs
  - package.json
  - tests/unit/openclaw-preparation-patch.test.ts
  - harness/specs/tasks/reduce-client-preparation-overhead.md
  - .codex/**
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - smart-latest routing and selected reasoning settings remain unchanged.
  - Authentication refresh, tool permissions, and per-run tool execution state remain current.
requiredProfiles:
  - fast
  - comms
acceptance:
  - Measure preparation substeps in the actual portable runtime before selecting a patch.
  - Keep temporary timing instrumentation out of delivered artifacts.
  - Version-lock runtime patches, fail closed on unknown layouts, and test idempotence.
  - Verify invalidation and isolation for any reused data.
  - Run real text and tool acceptance without attributing provider variance to local changes.
docs:
  required: true
---

This iteration continues the previous portable delivery. Local preparation is not considered optimized merely because the upstream provider is slower than one second. Do not cache credentials, permission decisions, or tool execution closures across runs.
