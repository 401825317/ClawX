---
id: openclaw-web-search-context-budget
title: Bound managed web-search results before OpenClaw context recovery
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent dense or parallel web-search results from exhausting the active model context before OpenClaw can complete the current turn.
touchedAreas:
  - harness/specs/tasks/openclaw-web-search-context-budget.md
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - scripts/junfeiai-distribution-defaults.test.ts
expectedUserBehavior:
  - Managed web search uses the configured result count when a tool call does not explicitly provide one.
  - One live tool result cannot consume more than the configured character budget in the main agent context.
  - Automatic compaction keeps the configured reserve before the next model response or tool call.
  - Existing provider, cache, context, and compaction settings outside the managed fields remain intact.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - active-config-guards
  - backend-communication-boundary
  - comms-regression
requiredTests:
  - pnpm exec tsx --test scripts/junfeiai-distribution-defaults.test.ts
  - pnpm run typecheck
acceptance:
  - `shared/junfeiai-endpoints.json` is the single source of truth for web-search result count, live tool-result characters, and compaction reserve floor.
  - Startup config sync writes the managed values to `tools.web.search.maxResults`, `agents.defaults.contextLimits.toolResultMaxChars`, and `agents.defaults.compaction.reserveTokensFloor`.
  - Config sync deep-merges adjacent user settings and is idempotent.
  - The implementation uses OpenClaw 2026.7.1's public configuration surface and does not patch bundled OpenClaw runtime code.
docs:
  required: false
---

## Scope

- Add managed defaults for web-search breadth, live tool-result size, and compaction reserve.
- Validate those defaults before startup and synchronize them into `openclaw.json`.
- Preserve unrelated user configuration while enforcing the three managed fields.

## Out of Scope

- Adding a configurable aggregate tool-result budget to OpenClaw.
- Externalizing raw search payloads or changing provider response schemas.
- Replaying or deduplicating web-search calls during overflow recovery.
