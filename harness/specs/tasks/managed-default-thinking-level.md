---
id: managed-default-thinking-level
title: Apply the server-managed default thinking level before Gateway startup
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Extend the existing managed client-config text policy with one validated default thinking level, cache it with the model catalog, and reconcile it into OpenClaw before Gateway startup without replacing explicit per-session choices.
touchedAreas:
  - harness/specs/tasks/managed-default-thinking-level.md
  - shared/managed-client-config.ts
  - electron/services/managed-client-config-service.ts
  - electron/services/providers/managed-runtime-config.ts
  - src/pages/Chat/ChatInput.tsx
  - tests/unit/managed-client-config-service.test.ts
  - tests/unit/managed-runtime-config.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/chat-input.test.tsx
expectedUserBehavior:
  - A managed cold start reads `modelOptions.text.defaultThinkingLevel` from the existing public client-config response before Gateway startup.
  - Valid levels are off, minimal, low, medium, high, and xhigh; a missing or invalid value falls back to medium.
  - The resolved level becomes the inherited OpenClaw default and the inherited Composer label.
  - A session-level thinking choice remains authoritative and is never replaced by a later policy refresh.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - gateway-readiness-policy
  - provider-default-invariant
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm exec vitest run tests/unit/managed-client-config-service.test.ts tests/unit/managed-runtime-config.test.ts tests/unit/provider-runtime-sync.test.ts tests/unit/chat-input.test.tsx
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - The normalized managed text policy always contains `defaultThinkingLevel` and persists it in the origin-scoped cache.
  - Version 2 text-policy caches remain readable and receive the local compatibility default.
  - Cold-start managed runtime reconciliation writes the policy level to `agents.defaults.thinkingDefault` before Gateway startup.
  - The Chat Composer uses a session-provided `thinkingDefault` first and the managed policy default second.
  - Invalid remote values never reach OpenClaw configuration.
docs:
  required: false
---

# Managed default thinking level

Use the existing `/api/clawx/client-config` text policy as the only remote authority. Do not add a renderer fetch or a second policy endpoint. Keep explicit session selections separate from the inherited managed default.
