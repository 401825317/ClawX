---
id: managed-auth-provider-migration
title: Migrate managed login, registration, and device authorization onto the typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Port the UClaw managed-account login, registration, verification-code, device-authorization, token-refresh, logout, and local/remote status flows into the current ClawX architecture without restoring the legacy localhost Host API server. Keep credentials and relay tokens Main-owned, converge every authenticated runtime onto the master-compatible managed text contract (`openai` canonical plus `lingzhiwuxian` compatibility) with one Relay Key and one server-directed model policy, and apply credential changes through a crash-safe, fail-closed Gateway quiescence transaction.
touchedAreas:
  - harness/specs/tasks/managed-auth-provider-migration.md
  - shared/host-api/contract.ts
  - shared/managed-client-config.ts
  - shared/managed-auth/**
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/main/index.ts
  - electron/main/ipc-handlers.ts
  - electron/gateway/managed-runtime-mutation-barrier.ts
  - electron/gateway/config-sync-env.ts
  - electron/gateway/config-sync.ts
  - electron/gateway/manager.ts
  - electron/services/managed-auth-api.ts
  - electron/services/managed-auth-service.ts
  - electron/services/managed-client-config-api.ts
  - electron/services/managed-client-config-service.ts
  - electron/services/billing-api.ts
  - electron/services/providers-api.ts
  - electron/services/providers/**
  - electron/services/secrets/secret-store.ts
  - electron/shared/providers/**
  - electron/utils/browser-oauth.ts
  - electron/utils/device-oauth.ts
  - electron/utils/junfeiai-device.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth-sqlite.ts
  - electron/utils/openclaw-auth.ts
  - src/App.tsx
  - src/components/auth/**
  - src/components/settings/ProvidersSettings.tsx
  - src/lib/host-api.ts
  - src/lib/managed-auth.ts
  - src/lib/managed-auth-errors.ts
  - src/lib/model-options.ts
  - src/lib/providers.ts
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Setup/index.tsx
  - src/pages/Settings/index.tsx
  - src/stores/managed-auth.ts
  - src/stores/managed-client-config.ts
  - shared/i18n/locales/**
  - tests/unit/managed-auth-api.test.ts
  - tests/unit/managed-auth-service.test.ts
  - tests/unit/junfeiai-device.test.ts
  - tests/unit/junfeiai-endpoints.test.ts
  - tests/unit/managed-auth-store.test.ts
  - tests/unit/managed-auth-components.test.tsx
  - tests/unit/managed-client-config-api.test.ts
  - tests/unit/managed-client-config-service.test.ts
  - tests/unit/model-options.test.ts
  - tests/unit/chat-input.test.tsx
  - tests/unit/secret-store.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/provider-service-stale-cleanup.test.ts
  - tests/unit/provider-store-managed-transaction.test.ts
  - tests/unit/providers-settings-managed.test.tsx
  - tests/unit/providers.test.ts
  - tests/unit/managed-auth.test.ts
  - tests/unit/openclaw-auth-sqlite.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/managed-runtime-mutation-barrier.test.ts
  - tests/unit/managed-runtime-config.test.ts
  - tests/unit/provider-migration-lock.test.ts
  - tests/unit/provider-mutation-lock.test.ts
  - tests/unit/config-sync.test.ts
  - tests/unit/config-sync-managed-provider.test.ts
  - tests/unit/gateway-manager-restart-recovery.test.ts
  - tests/unit/gateway-manager-mutation-barrier.test.ts
  - tests/unit/gateway-supervisor.test.ts
  - tests/unit/billing-api.test.ts
  - tests/e2e/managed-auth.spec.ts
  - tests/e2e/chat-model-picker.spec.ts
expectedUserBehavior:
  - A managed build opens first-run setup in login mode and supports switching to registration without exposing credentials to Renderer logs, stores, or URLs.
  - Registration can require an activation code and verification code; an invalid, expired, consumed, or device-mismatched activation result blocks submission and shows the localized service error.
  - Login and registration bind the current stable device identity, persist the authorized-device state, obtain or refresh the relay credential, and become ready only after the managed runtime is usable.
  - A successful managed authentication installs or repairs both the canonical `openai` Provider and the `lingzhiwuxian` compatibility Provider with the same Relay Key and enabled text-model set, then makes `openai/<server default>` the default route.
  - The Chat model selector shows only enabled text models delivered by new-api: normally from `GET /api/clawx/client-config`, with `bootstrap.client.modelOptions.text` accepted only when that route returns 404 or the same field accompanies managed login/bootstrap. A temporary fetch failure preserves the most recent valid policy, and a first run with no valid cache falls back to `openai/smart-latest`.
  - Managed Provider settings and Chat selection hide unrelated third-party and internal media Providers without deleting their persisted accounts, credentials, runtime entries, or model metadata.
  - A managed credential mutation first drains and stops any active Gateway, proves its port is free, and persists a recovery marker before any migration or snapshot can write. Only a fully committed or fully rolled-back transaction may clear that marker.
  - If Gateway was active before a completed mutation, the transaction owner starts it with its lease and verifies a healthy new PID; if Gateway was stopped, authentication leaves it stopped.
  - Authentication, activation, or relay acquisition that fails before the local transaction leaves the previous generation untouched. A local write failure may resume the previous generation only after a complete CAS rollback; it never activates a partial next generation.
  - An incomplete snapshot, rollback, cleanup, or marker clear quarantines the managed runtime; ordinary Gateway start, restart, reload, and reconnect remain blocked across application restarts until recovery completes. A late-child termination failure instead aborts quiescence before marker or credential writes and preserves process ownership for another stop attempt.
  - Restarting ClawX restores a valid local managed session without a blocking authentication request, checks the persistent mutation marker, idempotently reconciles both managed Providers and their model/default contract, synchronizes auth, and only then starts Gateway; remote authentication verification or refresh continues in the background within the configured offline-grace policy.
  - Logging out revokes the refresh token on a best-effort basis, removes local auth and relay credentials, removes managed runtime credentials, and prevents subsequent chat from using the prior account.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - gateway-readiness-policy
  - active-config-guards
  - provider-default-invariant
  - provider-model-metadata-preservation
  - provider-model-selection-authority
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm exec vitest run tests/unit/managed-auth-api.test.ts tests/unit/managed-auth-service.test.ts tests/unit/managed-client-config-api.test.ts tests/unit/managed-client-config-service.test.ts tests/unit/junfeiai-device.test.ts tests/unit/junfeiai-endpoints.test.ts tests/unit/managed-auth-store.test.ts tests/unit/managed-auth-components.test.tsx tests/unit/model-options.test.ts tests/unit/chat-input.test.tsx tests/unit/secret-store.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/provider-runtime-sync.test.ts tests/unit/provider-service-stale-cleanup.test.ts tests/unit/provider-store-managed-transaction.test.ts tests/unit/providers-settings-managed.test.tsx tests/unit/providers.test.ts tests/unit/managed-auth.test.ts tests/unit/openclaw-auth-sqlite.test.ts tests/unit/openclaw-auth.test.ts tests/unit/managed-runtime-mutation-barrier.test.ts tests/unit/gateway-manager-mutation-barrier.test.ts tests/unit/config-sync-managed-provider.test.ts tests/unit/billing-api.test.ts
  - pnpm exec playwright test tests/e2e/managed-auth.spec.ts tests/e2e/chat-model-picker.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - `shared/host-api/contract.ts` exposes a typed `managedAuth` module for local status, verified status, bootstrap, activation check, verification-code send, login, register, verify, refresh, and logout; payloads are explicit shared types rather than `Record<string, unknown>` at the Renderer/Main boundary.
  - `shared/host-api/contract.ts` also exposes a read-only typed `managedClientConfig.textModels` action. Renderer model-selection code calls only `hostApi.managedClientConfig.textModels()` and never fetches new-api, Gateway, or localhost compatibility routes directly.
  - Renderer authentication code calls only `hostApi.managedAuth.*`; it adds no direct `ipcRenderer.invoke`, `hostapi:fetch`, localhost Host API fetch, Gateway HTTP call, or Renderer-owned transport fallback.
  - `electron/services/managed-auth-api.ts` validates typed payloads, delegates UClaw HTTP and persistence work to Main-owned services, preserves backend error codes for localized UI messages, and never returns access tokens, refresh tokens, relay tokens, passwords, activation tickets, or raw secret-store records.
  - Endpoint origins, the `/api/clawx/client-config` primary route, `/api/clawx/bootstrap` compatibility route, managed Provider IDs/defaults, auth/relay/client-config request timeouts, offline-grace duration, and refresh policy are read from the shared UClaw configuration module; production values are not duplicated across UI or Main services.
  - Device identity remains stable across relaunch and is stored with restrictive permissions; activation state is accepted only for the matching device id and records no password, verification code, activation code, activation ticket, access token, refresh token, or relay token.
  - Expected backend 4xx errors retain a stable backend code and localized user message; transport, timeout, malformed-response, and 5xx errors remain distinguishable and do not masquerade as invalid credentials.
  - Refresh-token requests are single-flight, rotate the stored refresh token when supplied, preserve the prior refresh token when omitted, and cannot race two relay-token writes for different auth generations.
  - A successful login or registration persists the managed auth session, obtains a user-bound relay credential, and commits the new auth/provider generation only after the relay response and managed text policy are valid or a valid cached/fallback policy has been resolved. A failure before local mutation leaves prior auth, relay, Provider, verification cache, and Gateway state untouched; a failure after mutation resumes that state only after complete CAS rollback and otherwise quarantines it.
  - Managed chat reserves exactly two active identities: canonical provider/account `openai` with vendor `openai`, and compatibility provider/account `lingzhiwuxian` with vendor `lingzhiwuxian`. Both use the shared UClaw Relay base URL, carry the managed ownership marker, contain the same normalized enabled text-model IDs and metadata, and receive the same user-bound Relay Key; the canonical `openai` entry uses `openai-responses` and all newly selected/default model references use `openai/<model-id>`.
  - Successful authentication replaces stale or user-authored data that collides with either reserved managed identity, removes the exact historical `openai-codex` alias and dynamically discovered historical managed aliases, and installs both managed accounts plus matching `openai:default` and `lingzhiwuxian:default` OpenClaw auth profiles. It does not physically delete unrelated custom OpenAI-compatible, DeepSeek, other third-party, or internal image/video Provider accounts, secrets, runtime entries, or model metadata.
  - While managed ownership is active, Provider mutation APIs reject creating, updating, deleting, or selecting a conflicting real OpenAI or `lingzhiwuxian` account. Unrelated Provider data remains supported by storage/runtime APIs but the managed Provider settings projection hides it together with internal media Providers; the Chat selector likewise exposes only canonical `openai` text-model references.
  - New-api is the only remote authority for the Chat text-model policy. The primary source is `GET /api/clawx/client-config` `modelOptions.text`; only an explicit 404 from that route permits a compatibility request to `/api/clawx/bootstrap` and extraction of `client.modelOptions.text`. A managed login/bootstrap response may cache that same `client.modelOptions.text` field. Other client-config failures do not call bootstrap, and `runtime.defaultModel`, `modelFamilies`, Provider Store rows, OpenClaw runtime models, registry defaults, Agent history, and media capability contracts never add Chat picker options. Disabled, blank, malformed, and duplicate model entries are removed; the configured default is accepted only when it is enabled, otherwise the first enabled model becomes the default.
  - A valid client-config policy is cached after normalization. Timeout, transport, 4xx/5xx, malformed payload, or application relaunch preserves the most recent valid cached policy without clearing or widening it; only the absence of any valid cache falls back to the single `smart-latest` model. Refreshes are single-flight and read-only with respect to credentials and Gateway lifecycle.
  - One dedicated managed-auth transaction covers `clawx-providers.json`, all three Secret compatibility maps, both managed Secret slots, per-agent auth-profile JSON/SQLite storage for both managed identities, per-agent `models.json`, `openclaw.json`, verification cache, and current/stable device-activation files. Relay Token plaintext is persisted only in the protected Secret Store and per-agent auth-profile JSON/SQLite compatibility storage; Provider and model files contain ownership and routing metadata, not the Relay Token. Raw secret values may exist only in opaque Main-process memory required for exact rollback and are never serialized as a snapshot, logged, returned to Renderer, emitted to telemetry, or included in test failures.
  - The persistent mutation marker is written after Gateway quiescence but before `snapshot()` and therefore before Provider Store migration or any other possible credential write. The complete snapshot freezes Provider accounts/default keys, Secret slots, verification/device state, runtime config, every Agent `models.json`, and every Agent auth-profile JSON byte sequence and SQLite primary row. Its managed-ID set is the union of canonical IDs, configured legacy IDs, Provider Store discoveries, runtime discoveries, and all frozen Agent model discoveries.
  - The lifecycle order is lease acquisition, Gateway stop plus in-flight/late-start drain, port-free proof, persistent marker, complete snapshot, transactional commit or CAS-protected exact rollback / staged cleanup, marker clear only after completeness, owner-only start when previously active, healthy new-PID verification, then lease release. A late child that cannot be terminated makes quiescence fail before marker or credentials are written.
  - Snapshot failure after the marker, rollback or staged cleanup failure, marker-clear failure, or any CAS conflict keeps or promotes the marker to quarantine. Ordinary Gateway start, restart, reload, debounced lifecycle work, and reconnect fail closed; only the active transaction owner may start with its opaque lease after a complete transaction.
  - Application startup order is strict: persistent marker check -> idempotent managed Provider/model/default reconciliation -> `syncAllProviderAuthToRuntime()` -> Gateway start. A present or malformed marker skips reconciliation, Provider auth sync, and Gateway auto-start; both reconciliation and `syncAllProviderAuthToRuntime()` independently enforce the barrier so another caller cannot bypass it.
  - Startup reconciliation runs for a locally authenticated session with a usable, owner-matched Relay secret. It repairs either missing/stale managed account, Secret slot, per-agent JSON/SQLite auth profile, per-agent model entry, root runtime Provider entry, and `agents.defaults.model.primary`; both Provider model sets come from the resolved client-config policy and the primary is always `openai/<resolved-default>`. An already converged generation performs no credential/config writes, and reconciliation failure blocks Gateway rather than starting against a partial contract.
  - Read-only `localStatus` performs no network call, Provider write, OpenClaw write, or Gateway lifecycle action. Remote `status`/`verify` may refresh authentication but cannot reorder or repeat lifecycle actions for an already-applied auth generation.
  - Managed-auth commit/rollback, every Provider mutation or cleanup side effect, and Browser/Device OAuth completion share one re-entrant Main-process write lock. OAuth re-checks managed ownership after the remote exchange and before persistence; Provider checks and writes execute in the same critical section. Gateway quiescence is established before that lock and owner-only resume occurs after it is released.
  - In managed distributions, inherited OpenAI credentials are removed case-insensitively, including `OPENAI_API_KEY_*`. The validated Relay Token, or the non-secret login-required sentinel when it is unavailable, overrides all four Gateway child environment inputs (`CODEX_API_KEY`, `OPENAI_API_KEY`, `OPENAI_API_KEYS`, and `OPENCLAW_LIVE_OPENAI_KEY`). Existing `.env` files are not deleted or rewritten.
  - Relay injection requires both managed accounts, a valid `uclaw-auth` secret, and one unexpired owner-matched Relay secret mirrored to both managed Secret/auth-profile identities. Missing, expired, mismatched, or divergent state injects no prior token, applies the login-required sentinel, and removes stale managed Agent auth profiles during startup synchronization; a failed removal blocks startup.
  - `openai-codex` is only a historical compatibility alias discovered and removed during takeover/cleanup. New managed state uses canonical provider/account `openai`, compatibility provider/account `lingzhiwuxian`, auth account `uclaw-auth`, the resolved server/cached model set, default `openai/<resolved-default>`, and canonical protocol `openai-responses`; `smart-latest` is the no-cache fallback rather than a permanently hard-coded sole model.
  - Cleanup discovers orphan managed Provider IDs from the frozen Provider Store, runtime, and every Agent model snapshot. It proceeds fail-stop through Secret slots, Agent auth profiles, Agent models, and then runtime state. If a stage fails, later runtime/model discovery anchors are retained, the marker is quarantined, and a later login/logout can deterministically retry the full dynamic-ID union.
  - A Billing HTTP 401 waits for any status flight already in progress; an already-authoritative `authRejected === true` result remains conclusive, otherwise one new forced authoritative verification starts afterward through the same Gateway Manager. The Billing request is never replayed. Only `authRejected === true` maps to `auth_expired`; verification failure and Billing 400, 403, or 5xx remain `request_failed`, retain the local session, and never replay order creation or any other Billing action.
  - Managed access, refresh, and relay credentials use the protected secret-store representation when Electron safe storage is available; plaintext compatibility data is migrated or removed after a successful protected write, and tests assert persisted JSON and logs do not contain fixture secret values.
  - Provider secret reads deny every account that resolves to a reserved managed identity while managed ownership is active, including residual non-canonical real OpenAI accounts, `lingzhiwuxian`, and the exact `openai-codex` alias; preserved custom OpenAI-compatible and unrelated third-party accounts remain readable to Main/runtime code but hidden from managed UI.
  - Logout records the marker before best-effort remote revocation, then clears managed auth and Relay secrets, both current managed identities and historical managed auth profiles, managed model/runtime entries, verification cache, and in-memory state. It preserves unrelated third-party and internal media data. Local logout remains authoritative after complete cleanup; incomplete cleanup quarantines Gateway rather than exposing a partially cleared generation.
  - Setup, global managed-auth gate, and Settings account status are wired to the same managed-auth store; all visible copy exists in en, zh, ja, and ru locale resources and uses existing design tokens.
  - Unit tests cover typed Host API routing, payload validation, token normalization/redaction, auth fallback routes only for explicit missing-route responses, client-config normalization/cache, 404-only bootstrap compatibility, same-field login/bootstrap caching, rejection of runtime/model-family/local Provider injection, device binding, activation failures, refresh single-flight, offline grace, account-switch stale-key removal, shared-key dual Provider/profile writes, identical server-directed model sets, default `openai/<model>`, preservation plus UI filtering of third-party/media data, no-op and repairing cold-start reconciliation, stopped/running Gateway behavior, marker-before-reconcile/snapshot ordering, late-child drain failures, dynamic orphan cleanup retries, Billing 401 verification, CAS rollback, and quarantine states.
  - Electron E2E uses a deterministic mocked managed backend or mocked typed Host service, never real production credentials, and covers registration plus activation in Setup, registration availability in the recovery Gate, login, relaunch reconciliation, Settings status/filtering, server-delivered Chat model selection plus cached fallback, logout, error localization, and the absence of duplicate Gateway lifecycle actions.
docs:
  required: true
  files:
    - README.md
    - README.zh-CN.md
    - README.ja-JP.md
---

## Background

The source implementation on `master` combines the UClaw account HTTP calls, device identity,
token persistence, Provider seeding, OpenClaw file synchronization, and Gateway
lifecycle changes behind legacy `/api/junfeiai/*` localhost routes. The current ClawX
architecture instead owns Renderer/Main communication through the typed Host API:

```
Renderer -> src/lib/host-api.ts -> host:invoke -> Main service -> Provider/OpenClaw/Gateway
```

This migration preserves the product flow while adapting it to that architecture. It
must not restore the local Host API server, `hostapi:fetch` proxy, browser fallback, or
untyped path-based requests.

The final managed chat runtime keeps the `master` compatibility contract: canonical
`openai` and compatibility `lingzhiwuxian` Providers use the same UClaw Relay Key and
the same new-api-directed text-model set. The default route is always
`openai/<resolved-default>` using `openai-responses`; `openai` is a runtime/provider
identifier, not a claim that requests go directly to the public OpenAI API.

## Scope

- Login, registration, verification-code sending, activation pre-check, device binding,
  auth verification, access-token refresh, relay-token acquisition, local status,
  remote verified status, offline grace, and logout.
- Typed Host API contract, Main service registration, Renderer facade, managed-auth
  store, first-run setup, global auth gate, and Settings account status.
- Read-only typed client-config retrieval, normalized/cached new-api text-model policy,
  and Chat model selection driven only by that policy.
- Managed `openai` plus `lingzhiwuxian` Provider persistence and synchronization into
  the existing Provider Store, Secret Store, and OpenClaw provider/auth/model files.
- Login-time and cold-start idempotent reconciliation of both managed identities,
  identical model sets, shared credentials, and the canonical default route.
- Managed UI projection that hides preserved third-party and internal media Provider
  data without deleting or rewriting that unrelated data.
- A generation-aware account switch that quiesces Gateway before the first possible
  credential write, commits or restores one complete generation, and resumes only the
  previously active Gateway with a new process.
- Security tests that prove secrets are absent from Renderer payloads, persisted
  non-secret state, logs, telemetry, and snapshots.

## Migration constraints

- Use the current ClawX Host API, Provider store, secret store, OpenClaw synchronization,
  and Gateway Manager APIs as the architecture baseline. Do not copy the `master`
  localhost server, IPC proxy, or full `junfeiai-service.ts` dependency graph unchanged.
- Managed authentication owns the reserved `openai` and `lingzhiwuxian` Provider
  identities because both point at the configured UClaw relay. A successful login or
  registration replaces stale or user-authored values colliding with those identities,
  removes real-OpenAI conflicts and the exact `openai-codex` alias, then installs the
  canonical and compatibility accounts with one Relay Key and one normalized model set.
  Custom OpenAI-compatible, unrelated Provider vendors, and internal image/video
  Providers remain physically untouched and are filtered only from managed UI surfaces.
- Treat new-api as the managed text-model authority. Read `modelOptions.text` from
  `/api/clawx/client-config`; only that route's explicit 404 may fall back to
  `/api/clawx/bootstrap` `client.modelOptions.text`, and login/bootstrap may cache the
  same nested field when supplied. Never derive picker options from runtime defaults,
  model families, Provider/OpenClaw state, Agent history, or media contracts. Persist the
  most recent valid normalized policy; use only `smart-latest` when no valid cache exists.
- Acquire an opaque mutation lease, stop Gateway while draining any in-flight or late
  start, prove the port is free, and persist the crash-recovery marker before calling the
  snapshot because first-use Provider Store migration may write. A late child that cannot
  be terminated aborts before the marker and before any credential mutation.
- The complete snapshot covers Provider/default/secret records, verification cache,
  device-activation files, the complete managed entries and defaults in `openclaw.json`,
  every frozen Agent `models.json`, and every frozen Agent auth-profile JSON plus SQLite
  primary rows. Its dynamic managed-ID union comes from canonical/configured legacy IDs,
  Provider Store records, runtime records, and every Agent model snapshot. Rollback
  restores raw file content or equivalent SQLite rows only after every managed runtime
  write has finished, so no later step can overwrite the previous generation during recovery.
- Managed Provider, Secret, and SQLite installation compares the current generation with
  its snapshot before writing. Rollback restores a target only while it still equals the
  generation written by this transaction; a concurrent change is never overwritten and
  instead fails closed with the Gateway stopped.
- Serialize managed-auth commit/rollback, Provider mutations and cleanup writes, and
  Browser/Device OAuth completion through one re-entrant Main-process write lock. Any
  ownership check and its corresponding write belong to the same critical section;
  OAuth must re-check ownership after the network exchange. Gateway quiescence precedes
  the lock and transaction-owner resume runs after the lock is released.
- Treat authentication plus relay/provider activation as a staged state transition.
  Until the relay credential and runtime configuration are committed, the previous
  committed generation remains authoritative. A complete CAS rollback may restore and
  resume it; incomplete snapshot, rollback, cleanup, or marker clearing instead persists
  quarantine and must not expose either partial generation.
- Clear the persistent marker only after commit, rollback, or staged cleanup is complete.
  If Gateway was active, only the lease owner may start it and must verify a healthy PID
  different from the prior PID before releasing the lease. Ordinary start, restart,
  reload, debounced work, and reconnect fail closed while a lease or marker exists.
- On application startup, check the marker before any Provider write, reconcile the dual
  managed Provider/model/default contract when the local session and Relay secret are
  usable, run Provider auth synchronization, and only then auto-start Gateway. Skip all
  three stages when recovery is required. Reconciliation and Provider sync must each
  enforce the barrier internally so another caller cannot bypass it; an already matching
  generation is a no-op and any reconciliation failure blocks Gateway startup.
- Do not delete or rewrite `.env`. Strip inherited OpenAI credential names without regard
  to case, including `OPENAI_API_KEY_*`, then set `CODEX_API_KEY`, `OPENAI_API_KEY`,
  `OPENAI_API_KEYS`, and `OPENCLAW_LIVE_OPENAI_KEY` to the same validated Relay Token or
  the login-required sentinel. Reject owner-mismatched, expired, or auth-less Relay state
  and remove stale managed profiles before startup; cleanup failure blocks Gateway.
- Treat `openai-codex` only as a historical compatibility alias. The configured schema
  and all newly committed state use canonical provider/account `openai`, compatibility
  provider/account `lingzhiwuxian`, auth account `uclaw-auth`, identical resolved model
  sets, default `openai/<resolved-default>`, and canonical protocol `openai-responses`.
- For Billing, do not treat an edge 401 as authoritative and do not replay the request.
  Wait for the current status flight; reuse it only when it already authoritatively reports
  `authRejected === true`, otherwise start one new forced verification afterward with the
  same Gateway Manager. Only `authRejected === true` means `auth_expired`. Billing
  400/403/5xx and failed verification remain request failures and preserve the local session.
- Keep status reads side-effect free unless the action is explicitly the remote
  verify/refresh operation. UI polling must not repeatedly rewrite configuration or
  trigger managed credential lifecycle transactions.
- Preserve the current OpenClaw API allowlist, normalized server-supplied model metadata,
  per-agent auth-profile/SQLite compatibility, unrelated Provider/media state, and
  Gateway readiness policy. Normalize stale managed per-agent selections to the resolved
  canonical policy without modifying chat information-flow rendering.

## Out of scope

- New top-up/payment/order features beyond the managed-auth error-classification boundary.
- Image-generation and video-generation provider migration beyond preserving existing
  settings and credentials.
- Changing OpenClaw source code or upgrading the bundled OpenClaw version.
- DeepSeek failure fallback, media task polling, or chat information-flow rendering.
- Restoring the legacy `electron/api` HTTP server or `hostapi:fetch` bridge.

## Rollback

- Keep the migration isolated behind the managed-distribution decision and typed
  `managedAuth` service registration so unmanaged builds retain their existing Provider
  flow.
- Before replacing the reserved OpenClaw `openai` and `lingzhiwuxian` entries, capture
  the previous account/config generation and write files atomically. A failed pre-commit step leaves
  the previous files untouched only when no marker-protected migration write occurred.
  A fully restored rollback may resume the previous active generation; incomplete
  snapshot/rollback/cleanup/marker clearing persists quarantine and prevents all Gateway
  launch paths from using stale or partial credentials.
- Code rollback removes the managed-auth/client-config UI and service wiring without
  deleting unrelated personal or internal media Providers. Data cleanup targets only
  the two reserved managed identities, records carrying the managed ownership marker,
  the dedicated managed auth account id, and dynamically discovered historical managed
  IDs. Recovery must clear the persistent quarantine marker before ordinary Gateway
  startup is re-enabled.
