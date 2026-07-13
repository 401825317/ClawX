---
id: junfeiai-native-responses-migration
title: Migrate managed JunFeiAI chat to native OpenAI Responses
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Move managed `smart-latest` chat from the legacy `lingzhiwuxian/*` Chat Completions compatibility path to the native `openai/*` Responses adapter without replacing UClaw's unified Agent loop, durable task runtime, or artifact verification.
touchedAreas:
  - electron/api/routes/providers.ts
  - electron/services/providers/openai-chat-migration.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/provider-service.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - scripts/openclaw-responses-compatible-fallback-patch.mjs
  - scripts/bundle-openclaw.mjs
  - scripts/patch-browser-hint.mjs
  - src/components/settings/ProvidersSettings.tsx
  - src/i18n/locales/en/settings.json
  - src/i18n/locales/zh/settings.json
  - src/i18n/locales/ja/settings.json
  - src/i18n/locales/ru/settings.json
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
  - active-config-guards
  - comms-regression
expectedUserBehavior:
  - Existing managed users see an explicit migration action instead of having their provider and stored session model references rewritten silently.
  - After migration, normal chat uses `openai/smart-latest` with `api: openai-responses`, the embedded `pi` Agent runtime, `thinkingDefault: xhigh`, and `reasoningDefault: on`.
  - Image, video, PPT, desktop, and long-task execution continue through the current unified OpenClaw Agent and Host Task paths; the migration does not restore renderer-owned media planners.
  - If the managed relay returns HTTP 404 before a Responses stream starts, the same Agent turn retries once through Chat Completions. No retry occurs after output starts, after cancellation, or for other errors.
acceptance:
  - The migration creates or updates the managed `openai` account with the JunFeiAI relay base URL and `openai-responses`, then rewrites only `lingzhiwuxian/*` model references in OpenClaw config, agent model files, and session indexes.
  - The target `openai` provider is ready before legacy provider refs or credentials are removed, and the migration completion flag is written only after all rewrites succeed.
  - Re-running the migration is idempotent and preserves unrelated providers, sessions, models, media providers, tools, plugins, and task state.
  - Managed OpenAI relay entries remain pinned to `agentRuntime.id = pi` and retain UClaw's `xhigh` reasoning defaults.
  - New managed bootstrap remains compatible with legacy accounts; only the explicit migration action changes persisted provider/model references.
  - The fallback patch is version-gated to the bundled OpenClaw runtime and fails packaging validation if its anchors no longer match.
  - Renderer uses `hostApiFetch` for migration and introduces no direct Gateway or IPC transport.
docs:
  required: true
---

## Scope boundary

- Import the provider migration and native Responses transport behavior from
  `feature/weige-1.0.0`.
- Keep the current branch's context window, `xhigh` reasoning, native media
  Agent loop, durable Host Tasks, idempotency, recovery, and artifact checks.
- Do not import the weige renderer media-intent planner, video route planner,
  in-memory media job ownership, fixed production-only development endpoints,
  or unrelated updater/build changes.

## Compatibility

- Legacy `lingzhiwuxian/*` accounts continue using Chat Completions until the
  user explicitly migrates.
- Migrated `openai/*` accounts always start with Responses. The runtime fallback
  is a narrow availability fallback, not a persisted protocol downgrade.
- Older packaged clients are unaffected because the server endpoint and legacy
  provider contract remain available.
