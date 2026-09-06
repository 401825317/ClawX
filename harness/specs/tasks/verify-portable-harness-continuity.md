---
id: verify-portable-harness-continuity
title: Verify portable Responses harness continuity
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Validate the actual bundled runtime preserves reasoning, assistant phases, and tool results while delivering the measured latency patches.
touchedAreas:
  - .codex/goals.md
  - .codex/diagnostics/**
  - electron/utils/openclaw-auth.ts
  - package.json
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-model-catalog-cache-patch.mjs
  - scripts/openclaw-preparation-patch.mjs
  - scripts/diagnostics/profile-client-preparation.mjs
  - scripts/diagnostics/verify-bundle-preparation.mjs
  - scripts/diagnostics/capture-preparation-round.mjs
  - tests/unit/openclaw-preparation-patch.test.ts
  - harness/specs/tasks/reduce-client-preparation-overhead.md
  - scripts/diagnostics/capture-otlp-traces.mjs
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/openclaw-model-catalog-cache-patch.test.ts
  - tests/unit/capture-otlp-traces.test.ts
  - harness/specs/tasks/cache-openclaw-bundled-model-catalog.md
  - harness/specs/tasks/skip-explicit-provider-alias-discovery.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - scripts/diagnostics/verify-responses-continuity.mjs
  - scripts/diagnostics/probe-portable-chat.mjs
  - scripts/diagnostics/summarize-portable-probes.mjs
  - scripts/diagnostics/probe-responses-ttfb.mjs
  - tests/unit/probe-responses-ttfb.test.ts
  - harness/specs/tasks/verify-portable-harness-continuity.md
expectedUserBehavior:
  - The selected model and reasoning effort are not changed by this audit.
  - Tool results and opaque reasoning survive subsequent model requests.
requiredProfiles:
  - fast
  - comms
acceptance:
  - A deterministic stream-to-history-to-request check runs against both development and packaged OpenClaw.
  - Reasoning encrypted content, assistant phase, and tool call identifiers round-trip without exposing real user data.
  - Portable provenance and real text and multi-step tool checks are recorded separately from synthetic protocol checks.
  - Unverified provider capability and latency limits are reported explicitly.
docs:
  required: true
---

This audit does not change routing, reasoning defaults, authentication, or compaction policy. Synthetic protocol checks are not claims about upstream model quality.

The current delivery includes the earlier uncommitted latency patches and their diagnostic evidence. Validate with `--since HEAD` to audit this complete delivery against the fetched 0.5.1 branch tip, not the unrelated historical divergence from origin/main.
