---
id: junfeiai-native-responses-migration
title: Migrate managed JunFeiAI chat to native OpenAI Responses
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Deterministically bootstrap managed `smart-latest` chat and media capabilities so clean and existing UClaw development or packaged environments converge on the native `openai/*` Responses adapter before Gateway startup, without replacing UClaw's unified Agent loop, durable task runtime, or artifact verification.
touchedAreas:
  - electron/main/index.ts
  - electron/api/routes/providers.ts
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/services/junfeiai/managed-runtime-bootstrap.ts
  - electron/services/providers/openai-chat-migration.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/provider-service.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/json-file-io.ts
  - electron/utils/channel-config.ts
  - electron/utils/openclaw-image-generation.ts
  - electron/utils/openclaw-video-generation.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/skill-config.ts
  - electron/gateway/reload-policy.ts
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - scripts/openclaw-responses-compatible-fallback-patch.mjs
  - scripts/junfeiai-distribution-defaults.test.ts
  - scripts/junfeiai-reasoning-defaults.test.ts
  - scripts/managed-runtime-bootstrap.test.ts
  - scripts/json-file-io.test.ts
  - scripts/bundle-openclaw.mjs
  - scripts/openai-chat-migration.test.ts
  - scripts/patch-browser-hint.mjs
  - src/pages/Chat/ChatInput.tsx
  - src/stores/chat.ts
  - src/components/settings/ProvidersSettings.tsx
  - tests/e2e/chat-model-picker.spec.ts
  - src/i18n/locales/en/settings.json
  - src/i18n/locales/zh/settings.json
  - src/i18n/locales/ja/settings.json
  - src/i18n/locales/ru/settings.json
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
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
  - Existing managed users are migrated automatically during startup before Gateway reads the runtime config; the managed distribution reserves `openai` for the signed-in Relay account and takes over stale personal account or runtime entries.
  - After migration, normal chat uses `openai/smart-latest` with `api: openai-responses`, the embedded `pi` Agent runtime, the configured thinking default, and `reasoningDefault: on`.
  - Clean and existing managed UClaw environments automatically converge on `openai/smart-latest` before Gateway startup, including when an earlier personal endpoint used the reserved `openai` provider id.
  - Normal chat uses `api: openai-responses`, the embedded `pi` Agent runtime, a 372000-token managed context window, the configured thinking default, and `reasoningDefault: on`.
  - Taking over `openai` replaces its account metadata, secret, runtime endpoint, headers, and model registry with the signed-in Relay configuration; malformed JSON, model-reference key collisions, and failed writes still stop the migration.
  - Managed image and video providers, plugins, authentication, and default models are ready before the first native Agent turn instead of depending on a prior settings-page save or media request.
  - Image, video, PPT, desktop, and long-task execution continue through the current unified OpenClaw Agent and Host Task paths; the migration does not restore renderer-owned media planners.
  - If the managed relay returns HTTP 404 before a Responses stream starts, the same Agent turn retries once through Chat Completions. No retry occurs after output starts, after cancellation, or for other errors.
acceptance:
- The migration creates or updates the managed `openai` account with the JunFeiAI relay base URL and `openai-responses`, then rewrites only `lingzhiwuxian/*` model references in OpenClaw config, agent model files, and session indexes.
- In the managed distribution, an existing non-managed `openai` account or runtime entry is replaced rather than treated as an ownership conflict; non-managed distributions retain the conflict guard.
  - The target `openai` provider is ready before legacy provider refs or credentials are removed, and the migration completion flag is written only after all rewrites succeed.
  - Re-running the migration is idempotent and preserves unrelated providers, sessions, models, media providers, tools, plugins, and task state.
  - Managed OpenAI relay entries remain pinned to `agentRuntime.id = pi` and use the configured reasoning default.
  - New managed bootstrap remains compatible with legacy accounts; startup migration changes persisted provider/model references only after managed auth and relay configuration are ready.
  - Managed startup runs the migration and media bootstrap idempotently before Gateway auto-start when authentication and the relay token are ready.
  - OpenClaw config writers atomically replace complete JSON documents, and readers retry a transient parse failure instead of treating a partial file as an empty configuration.
  - Gateway auto-start reuses an already completed managed-provider preflight result instead of immediately running a second equivalent runtime sync.
  - Legacy `lingzhiwuxian` remains a Chat Completions compatibility provider, while managed `openai` remains the only native Responses provider and the only provider eligible for the narrow 404 fallback.
  - The managed runtime contract version changes when the shipped protocol or context defaults change, forcing existing persisted accounts to resync.
  - A clean state receives `clawx-openai-image/gpt-image-2`, the managed OpenAI video models, disabled automatic media-provider fallback, and the required plugin registrations without a manual settings action.
  - Automatic bootstrap repairs missing or UClaw-managed media defaults but does not replace an explicitly selected third-party image or video provider, and relay credential rotation refreshes the managed image provider key.
  - The fallback patch is version-gated to the bundled OpenClaw runtime and fails packaging validation if its anchors no longer match.
  - Renderer uses `hostApiFetch` for migration and introduces no direct Gateway or IPC transport.
docs:
  required: true
---

## Scope boundary

- Import the provider migration and native Responses transport behavior from
  `feature/weige-1.0.0`.
- Keep the current branch's context window, configured reasoning default, native media
  Agent loop, durable Host Tasks, idempotency, recovery, and artifact checks.
- Do not import the weige renderer media-intent planner, video route planner,
  in-memory media job ownership, fixed production-only development endpoints,
  or unrelated updater/build changes.

## Compatibility

- Legacy `lingzhiwuxian/*` accounts are migrated automatically on managed app
  startup once auth and relay configuration are ready. The managed app owns the
  `openai` provider id and replaces earlier non-managed entries with the Relay
  configuration.
- Non-managed distributions keep the personal `openai` conflict guard and do
  not run the managed bootstrap automatically.
- Migrated `openai/*` accounts always start with Responses. The runtime fallback
  is a narrow availability fallback, not a persisted protocol downgrade.
- Older packaged clients are unaffected because the server endpoint and legacy
  provider contract remain available.
