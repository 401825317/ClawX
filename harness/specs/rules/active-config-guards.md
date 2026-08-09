---
id: active-config-guards
title: Active Config Guards
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - plugin-lifecycle-management
---

Final OpenClaw runtime config must represent the resolved and validated plugin state, not raw discovery state.

Rules:

- unresolved or conflicted capabilities must not be written as active runtime owners
- allowlists and entries must agree about which package owns a single-owner capability
- disabling a bundled plugin is required when removing it from an allowlist is not sufficient to stop runtime loading
- stale plugin registrations for unconfigured capabilities must be removed during sanitize or recovery paths
- selecting a managed tool provider must keep its tool selector, `plugins.entries` enablement, and `plugins.allow` trust in sync
- removing a retired tool denial must match only that exact tool id and preserve all unrelated deny entries
- tests for config rewrites should assert the final active config, not only intermediate helper output
