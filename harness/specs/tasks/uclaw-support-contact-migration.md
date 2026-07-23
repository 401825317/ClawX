---
id: uclaw-support-contact-migration
title: Migrate UClaw help and support contacts onto the typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Port the server-configured Help & Support sidebar entry and contact drawer from master while keeping support reads independent from authentication, Chat, OpenClaw, and Gateway lifecycle state.
touchedAreas:
  - harness/specs/tasks/uclaw-support-contact-migration.md
  - shared/support.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/**/common.json
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/main/ipc-handlers.ts
  - electron/services/support-api.ts
  - electron/services/support-service.ts
  - src/components/client/SupportContactButton.tsx
  - src/components/layout/Sidebar.tsx
  - src/lib/host-api.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - tests/unit/support-api.test.ts
  - tests/unit/support-service.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/junfeiai-endpoints.test.ts
  - tests/e2e/support-contact.spec.ts
expectedUserBehavior:
  - When the UClaw client configuration enables support and contains at least one valid contact, the sidebar shows Help & Support and opens a contact drawer.
  - The drawer supports multiple contacts, localized fallback copy, QR codes, work hours, notes, and copying an optional WeChat ID.
  - A legacy support configuration containing one top-level QR code remains usable.
  - Disabled, malformed, or temporarily unavailable support configuration does not interrupt the user or expose an empty entry.
  - Loading support configuration does not sign a user in, refresh credentials, write Provider or OpenClaw configuration, or start, reload, restart, or stop Gateway.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm exec vitest run tests/unit/support-api.test.ts tests/unit/support-service.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/junfeiai-endpoints.test.ts tests/unit/i18n-locale-parity.test.ts
  - pnpm exec playwright test tests/e2e/support-contact.spec.ts
acceptance:
  - `shared/host-api/contract.ts` exposes a read-only typed `support.config` action; Renderer code calls only `hostApi.support.config()`.
  - Electron Main reads the public UClaw client configuration without an Authorization header and honors the configured application proxy.
  - The client-config path, bootstrap compatibility path, request timeout, and refresh interval are sourced from `shared/junfeiai-endpoints.json`.
  - Only a 404 from the client-config route falls back to the bootstrap client payload; other transport failures remain silent in the UI and preserve the last successful configuration.
  - Remote support data is normalized before crossing into Renderer, unsafe QR URLs and disabled contacts are removed, and legacy branding in visible remote copy is normalized to UClaw.
  - The migration does not restore the legacy localhost Host API server, `/api/junfeiai/*` renderer routes, `hostapi:fetch`, direct Renderer fetches, or direct `ipcRenderer.invoke` calls.
  - All visible copy exists in en, zh, ja, and ru locale resources and uses current design tokens.
  - Electron E2E uses a deterministic mocked typed Host service and does not contact the production support endpoint.
docs:
  required: true
  files:
    - README.md
    - README.zh-CN.md
    - README.ja-JP.md
---

## Migration constraints

- Adapt only the support-contact behavior from `master`; do not port announcements, managed model options, or Gateway reload behavior from the legacy client-config flow.
- Keep support independent from Managed Auth, billing, Chat stores, session history, ACP, and Gateway lifecycle code.
- Preserve the current branch's in-progress Managed Auth changes and exclude them from this task's commit.

## Rollback

- Remove the support component, typed `support` Host API module, service, endpoint settings, locale keys, and sidebar mount point.
- Authentication, Provider data, OpenClaw configuration, Gateway state, billing, skills, and existing sessions remain unchanged because support owns no persisted runtime state.
