---
id: openai-text-provider-failover
title: Non-sticky OpenAI text provider failover through the managed relay
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep every managed text call on OpenAI Responses first, then retry only the current invisible provider failure through a configurable OpenAI-compatible fallback provider without pinning later calls to that fallback.
touchedAreas:
  - harness/specs/tasks/openai-text-provider-failover.md
  - harness/specs/tasks/junfeiai-native-responses-migration.md
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/openai-chat-migration.ts
  - scripts/openclaw-text-provider-failover-patch.mjs
  - scripts/openclaw-text-provider-failover-patch.test.mjs
  - scripts/dev-junfeiai.mjs
  - scripts/openclaw-responses-compatible-fallback-patch.mjs
  - scripts/openclaw-responses-compatible-fallback-patch.test.mjs
  - scripts/junfeiai-distribution-defaults.test.ts
  - scripts/junfeiai-provider-seed-stability.test.ts
  - scripts/openai-chat-migration.test.ts
  - scripts/bundle-openclaw.mjs
  - scripts/patch-browser-hint.mjs
  - README.zh-CN.md
  - README.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - Every managed chat model call starts with the configured OpenAI provider and its Responses protocol.
  - A provider failure before visible assistant output or tool side effects retries the current call through the configured fallback provider and model.
  - The fallback provider reuses the managed OpenAI API key and base URL but resolves its own configured API protocol; the initial DeepSeek route uses `openai-completions` and therefore `/chat/completions`.
  - A successful fallback does not change the session model selection, so the next model call starts with OpenAI again.
  - User cancellation, context overflow, tool/runtime coordination errors, and failures after visible output do not transparently retry another provider.
  - The previous same-provider `/responses` 404 to `/chat/completions` compatibility retry is absent.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - active-config-guards
  - backend-communication-boundary
  - api-client-transport-policy
  - comms-regression
  - docs-sync
requiredTests:
  - scripts/openclaw-text-provider-failover-patch.test.mjs
  - scripts/junfeiai-distribution-defaults.test.ts
  - scripts/junfeiai-provider-seed-stability.test.ts
  - scripts/openai-chat-migration.test.ts
acceptance:
  - `shared/junfeiai-endpoints.json` is the single source of truth for enabling text failover and selecting its primary provider, fallback provider, fallback model, and fallback API protocol.
  - Managed provider runtime sync registers the fallback provider with the same normalized relay base URL and API key as managed OpenAI, while keeping the fallback provider's configured API protocol.
  - Managed OpenAI writes exactly the configured fallback model ref into `agents.defaults.model.fallbacks`.
  - Existing managed accounts whose runtime contract predates this failover are resynchronized before Gateway startup.
  - OpenClaw's native model fallback runner remains responsible for error classification, cancellation, output/side-effect safety, attempt ordering, and terminal error aggregation.
  - The runtime patch injects the configured fallback for calls whose actual provider matches the configured primary, including strict session model selections.
  - The runtime patch does not persist this configured fallback as `providerOverride`, `modelOverride`, or `modelOverrideSource: auto`.
  - The runtime patch removes the legacy Responses 404 compatibility wrappers from both registry and transport implementations.
  - A deterministic no-network test simulates an OpenAI failure, verifies the DeepSeek fallback and `/chat/completions` protocol configuration, then verifies that the next call starts with OpenAI and that abort/visible-output cases do not fall back.
  - `pnpm run dev:junfeiai -- --fail-openai-once` arms one explicit development-only failure for real-page verification without changing the normal or packaged runtime defaults.
docs:
  required: true
---

## Scope

- Add a managed text failover contract to `shared/junfeiai-endpoints.json`.
- Reuse the managed OpenAI relay endpoint and credential for the fallback provider while retaining a provider-specific API protocol.
- Reuse OpenClaw's model fallback runner instead of implementing a second transport-level retry loop.
- Keep the configured fallback request-scoped by suppressing only its automatic session model persistence.
- Add a deterministic simulation that performs no paid or external model request.
- Expose an explicit development launch option for one real-page failover check.

## Out of Scope

- Persisting a different secret or endpoint for the fallback provider.
- Retrying user cancellation, context overflow, tool failures, or runs that already produced visible output or external side effects.
- Making DeepSeek the session default or changing the user's explicit model selection.
- Adding a renderer-owned fallback or transport switch.
