---
id: managed-auth-provider-migration
title: Migrate managed login, registration, and device authorization onto the typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Port the UClaw managed-account login, registration, verification-code, device-authorization, token-refresh, logout, and local/remote status flows into the current ClawX architecture without restoring the legacy localhost Host API server. Keep credentials and relay tokens Main-owned, synchronize a successful managed session to the canonical openai provider and OpenClaw runtime, and apply the new runtime credentials with one bounded Gateway reload.
touchedAreas:
  - harness/specs/tasks/managed-auth-provider-migration.md
  - shared/host-api/contract.ts
  - shared/managed-auth/**
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/main/index.ts
  - electron/main/ipc-handlers.ts
  - electron/services/managed-auth-api.ts
  - electron/services/junfeiai/**
  - electron/services/providers/**
  - electron/services/secrets/secret-store.ts
  - electron/shared/providers/**
  - electron/utils/junfeiai-device.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - src/App.tsx
  - src/components/auth/**
  - src/lib/host-api.ts
  - src/lib/managed-auth.ts
  - src/lib/managed-auth-errors.ts
  - src/pages/Setup/index.tsx
  - src/pages/Settings/index.tsx
  - src/stores/managed-auth.ts
  - shared/i18n/locales/**
  - tests/unit/managed-auth-api.test.ts
  - tests/unit/managed-auth-service.test.ts
  - tests/unit/junfeiai-device.test.ts
  - tests/unit/managed-auth-store.test.ts
  - tests/unit/managed-auth-components.test.tsx
  - tests/unit/secret-store.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/e2e/managed-auth.spec.ts
expectedUserBehavior:
  - A managed build shows registration during first-run setup and supports switching between registration and login without exposing credentials to Renderer logs, stores, or URLs.
  - Registration can require an activation code and verification code; an invalid, expired, consumed, or device-mismatched activation result blocks submission and shows the localized service error.
  - Login and registration bind the current stable device identity, persist the authorized-device state, obtain or refresh the relay credential, and become ready only after the managed runtime is usable.
  - A successful managed authentication makes openai/smart-latest the default model while requests still use the configured UClaw relay base URL and openai-responses protocol.
  - If Gateway is running, a completed account switch applies the new provider credentials with one reload after all files are synchronized; if Gateway is stopped, authentication does not start it implicitly.
  - Failed authentication, activation, relay acquisition, or runtime synchronization never leaves a stale relay credential active for the previous user.
  - Restarting ClawX restores a valid local managed session without a blocking network request, then verifies or refreshes it in the background within the configured offline-grace policy.
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
  - pnpm exec vitest run tests/unit/managed-auth-api.test.ts tests/unit/managed-auth-service.test.ts tests/unit/junfeiai-device.test.ts tests/unit/managed-auth-store.test.ts tests/unit/managed-auth-components.test.tsx tests/unit/secret-store.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/provider-runtime-sync.test.ts tests/unit/openclaw-auth.test.ts
  - pnpm exec playwright test tests/e2e/managed-auth.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - `shared/host-api/contract.ts` exposes a typed `managedAuth` module for local status, verified status, bootstrap, activation check, verification-code send, login, register, verify, refresh, and logout; payloads are explicit shared types rather than `Record<string, unknown>` at the Renderer/Main boundary.
  - Renderer authentication code calls only `hostApi.managedAuth.*`; it adds no direct `ipcRenderer.invoke`, `hostapi:fetch`, localhost Host API fetch, Gateway HTTP call, or Renderer-owned transport fallback.
  - `electron/services/managed-auth-api.ts` validates typed payloads, delegates UClaw HTTP and persistence work to Main-owned services, preserves backend error codes for localized UI messages, and never returns access tokens, refresh tokens, relay tokens, passwords, activation tickets, or raw secret-store records.
  - Endpoint origins, managed provider defaults, auth/relay request timeouts, offline-grace duration, and refresh policy are read from the shared UClaw configuration module; production values are not duplicated across UI or Main services.
  - Device identity remains stable across relaunch and is stored with restrictive permissions; activation state is accepted only for the matching device id and records no password, verification code, activation code, activation ticket, access token, refresh token, or relay token.
  - Expected backend 4xx errors retain a stable backend code and localized user message; transport, timeout, malformed-response, and 5xx errors remain distinguishable and do not masquerade as invalid credentials.
  - Refresh-token requests are single-flight, rotate the stored refresh token when supplied, preserve the prior refresh token when omitted, and cannot race two relay-token writes for different auth generations.
  - A successful login or registration persists the managed auth session, clears stale relay credentials before account switching, obtains a user-bound relay credential, and commits the new auth/provider generation only after the relay response is valid.
  - The runtime account stored for managed chat has provider/account id `openai`, vendor id `openai`, base URL from the shared UClaw configuration, protocol `openai-responses`, model `smart-latest`, and managed metadata sufficient to distinguish it from a personal OpenAI account.
  - The relay credential is synchronized through the existing Provider store and OpenClaw runtime helpers, including `clawx-providers.json`, per-agent auth storage, per-agent `models.json`, and `openclaw.json`; raw secret values never appear in Renderer responses, telemetry, warning/error logs, snapshots, or test failure output.
  - Managed access, refresh, and relay credentials use the protected secret-store representation when Electron safe storage is available; plaintext compatibility data is migrated or removed after a successful protected write, and tests assert persisted JSON and logs do not contain fixture secret values.
  - Provider synchronization writes the complete OpenClaw configuration before requesting a Gateway lifecycle action. A running Gateway receives exactly one debounced reload for the committed auth generation; a stopped Gateway remains stopped; a failed reload reports degraded readiness without rolling back to or reusing a stale prior-user relay.
  - Read-only `localStatus` performs no network call, Provider write, OpenClaw write, Gateway start, reload, or restart. Remote `status`/`verify` may refresh authentication but cannot reorder or repeat lifecycle actions for an already-applied auth generation.
  - Logout clears the managed auth and relay secrets, removes both current and legacy OpenClaw auth profiles for the managed provider, clears verification cache and in-memory auth generation state, and does not expose the revoked token in logs; local logout remains authoritative when Gateway reload is degraded, while a non-running Gateway is stopped fail-closed.
  - Setup, global managed-auth gate, and Settings account status are wired to the same managed-auth store; all visible copy exists in en, zh, ja, and ru locale resources and uses existing design tokens.
  - Unit tests cover typed Host API routing, payload validation, token normalization/redaction, fallback routes only for explicit missing-route responses, device binding, activation failures, refresh single-flight, offline grace, account-switch stale-key removal, openai Provider/default-model writes, stopped/running Gateway behavior, logout cleanup, and rollback/failure states.
  - Electron E2E uses a deterministic mocked managed backend or mocked typed Host service, never real production credentials, and covers registration plus activation in Setup, registration availability in the recovery Gate, login, relaunch restoration, Settings status, logout, error localization, and the absence of duplicate Gateway lifecycle actions.
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

The final managed chat runtime is the canonical `openai` Provider using the UClaw
relay endpoint and `openai-responses`; `openai` is a runtime/provider identifier, not a
claim that requests go directly to the public OpenAI API.

## Scope

- Login, registration, verification-code sending, activation pre-check, device binding,
  auth verification, access-token refresh, relay-token acquisition, local status,
  remote verified status, offline grace, and logout.
- Typed Host API contract, Main service registration, Renderer facade, managed-auth
  store, first-run setup, global auth gate, and Settings account status.
- Managed `openai` Provider persistence and synchronization into the existing OpenClaw
  provider/auth/model files.
- A generation-aware account switch that clears stale credentials and performs at most
  one Gateway reload after a successful commit.
- Security tests that prove secrets are absent from Renderer payloads, persisted
  non-secret state, logs, telemetry, and snapshots.

## Migration constraints

- Use the current ClawX Host API, Provider store, secret store, OpenClaw synchronization,
  and Gateway Manager APIs as the architecture baseline. Do not copy the `master`
  localhost server, IPC proxy, or full `junfeiai-service.ts` dependency graph unchanged.
- Do not overwrite an unmanaged personal `openai` account silently. Managed-distribution
  ownership must be explicit and tested; any unsupported conflict must fail before
  modifying Provider or OpenClaw files.
- Treat authentication plus relay/provider activation as a staged state transition.
  Until the relay credential and runtime configuration are committed, the previous
  credential must not remain selectable by Gateway.
- Keep status reads side-effect free unless the action is explicitly the remote
  verify/refresh operation. UI polling must not repeatedly rewrite configuration or
  trigger Gateway reloads.
- Preserve the current OpenClaw API allowlist, provider model metadata, per-agent model
  selection, auth-profile/SQLite compatibility, and Gateway readiness policy.

## Out of scope

- Top-up/payment/order APIs and UI.
- Image-generation and video-generation provider migration beyond preserving existing
  settings and credentials.
- Changing OpenClaw source code or upgrading the bundled OpenClaw version.
- DeepSeek failure fallback, media task polling, or chat information-flow rendering.
- Restoring the legacy `electron/api` HTTP server or `hostapi:fetch` bridge.

## Rollback

- Keep the migration isolated behind the managed-distribution decision and typed
  `managedAuth` service registration so unmanaged builds retain their existing Provider
  flow.
- Before replacing a managed OpenClaw provider entry, capture the previous managed
  account/config generation and write files atomically. A failed pre-commit step leaves
  the previous files untouched; a post-commit Gateway reload failure leaves the new
  credentials persisted but marks runtime readiness degraded and prevents stale-key
  fallback.
- Code rollback removes the managed-auth UI/service wiring without deleting unrelated
  personal Providers. Data cleanup targets only records carrying the managed ownership
  marker and the dedicated managed auth account id.
