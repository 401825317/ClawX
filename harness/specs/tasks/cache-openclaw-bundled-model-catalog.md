---
id: cache-openclaw-bundled-model-catalog
title: Cache OpenClaw bundled model catalog discovery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Avoid rescanning immutable bundled plugin manifests during every embedded-agent model resolution.
touchedAreas:
  - package.json
  - scripts/openclaw-model-catalog-cache-patch.mjs
  - scripts/bundle-openclaw.mjs
  - tests/unit/openclaw-model-catalog-cache-patch.test.ts
  - harness/specs/tasks/cache-openclaw-bundled-model-catalog.md
expectedUserBehavior:
  - Repeated prompts keep the same provider, model, authentication, and fallback behavior.
  - Warm prompts reuse the process-local bundled static model catalog instead of rescanning bundled plugin manifests.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/openclaw-model-catalog-cache-patch.test.ts
acceptance:
  - The default bundled catalog resolver is initialized lazily and reused within one OpenClaw process.
  - Calls with an explicit environment preserve per-call resolver behavior; default-environment catalog lookups reuse separate resolvers for static-only and runtime-marked manifest rows.
  - The patch is idempotent, version-locked to OpenClaw 2026.6.10, and fails closed on an unknown runtime layout.
  - Dependency installation and packaged OpenClaw bundling both apply the patch.
  - Provider, model, authentication, request transport, and fallback semantics remain unchanged.
  - Comms replay and compare pass.
docs:
  required: false
---

Reduce warm text-response latency by removing repeated filesystem discovery from OpenClaw's bundled static model catalog lookup without caching mutable account or authentication state.
