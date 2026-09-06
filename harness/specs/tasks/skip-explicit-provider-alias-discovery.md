---
id: skip-explicit-provider-alias-discovery
title: Skip plugin alias discovery for explicit model providers
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Avoid rescanning plugin manifests when the requested provider already has an explicit models.providers entry.
touchedAreas:
  - scripts/openclaw-model-catalog-cache-patch.mjs
  - tests/unit/openclaw-model-catalog-cache-patch.test.ts
  - harness/specs/tasks/skip-explicit-provider-alias-discovery.md
expectedUserBehavior:
  - Explicitly configured providers keep their original provider ID, model, authentication, and transport behavior.
  - Unconfigured provider aliases continue to resolve through plugin model-catalog metadata.
  - Warm prompts no longer scan plugin manifests merely to canonicalize an explicitly configured provider.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/openclaw-model-catalog-cache-patch.test.ts
acceptance:
  - Provider matching is normalized consistently with OpenClaw provider ID handling.
  - Exact and differently cased explicit provider keys bypass plugin manifest discovery.
  - Unconfigured aliases and non-alias provider IDs preserve existing discovery behavior.
  - The patch remains idempotent, version-locked to OpenClaw 2026.6.10, and fails closed on unknown or partial layouts.
  - Provider, model, authentication, request transport, and fallback semantics remain unchanged.
  - Comms replay and compare pass.
docs:
  required: false
---

Reduce warm text-response latency by honoring explicit provider configuration before consulting plugin model-catalog aliases.
