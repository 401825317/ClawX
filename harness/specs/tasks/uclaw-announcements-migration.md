---
id: uclaw-announcements-migration
title: Migrate UClaw public announcements onto the typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Port the public ClawX announcement feed into the managed UClaw client while moving production runtime and release defaults to aiwxxx.com and preserving old-domain compatibility fixtures.
touchedAreas:
  - harness/specs/tasks/uclaw-announcements-migration.md
  - shared/announcements.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/**/common.json
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/main/ipc-handlers.ts
  - electron/services/announcements-api.ts
  - electron/services/announcements-service.ts
  - electron/services/public-client-config-service.ts
  - electron/services/managed-client-config-service.ts
  - tests/unit/public-client-config-service.test.ts
  - tests/unit/provider-mutation-lock.test.ts
  - tests/unit/support-service.test.ts
  - src/App.tsx
  - src/components/client/AnnouncementBell.tsx
  - src/components/client/AnnouncementsInitializer.tsx
  - src/components/client/UrgentAnnouncementDialog.tsx
  - src/components/layout/Sidebar.tsx
  - src/lib/host-api.ts
  - src/stores/announcements.ts
  - scripts/windows-support/UClaw-SelfCheck.mjs
  - scripts/windows-support/publish-portable-release.ps1
  - scripts/windows-support/publish-disabled-release-stage.ps1
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - .github/UCLAW_PORTABLE_RELEASE.md
  - tests/unit/announcements-api.test.ts
  - tests/unit/announcements-service.test.ts
  - tests/unit/announcements-store.test.ts
  - tests/unit/openclaw-bundle-config.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/i18n-locale-parity.test.ts
  - tests/e2e/announcements.spec.ts
expectedUserBehavior:
  - Managed UClaw reads the public announcement feed from the configured production backend (`https://aiwxxx.com`) through Electron Main and sends no account credential with that read.
  - Announcements are filtered by enabled state, publication time, and expiry time, sorted newest first, and expose normal, important, and urgent levels.
  - Each unread important announcement produces one in-app toast, urgent announcements require dismissal in a blocking dialog, and the sidebar bell lists current unread announcements.
  - A temporary feed failure preserves the last valid announcement state; disabled, malformed, or unsafe data fails closed without interrupting Chat or Gateway.
  - Community distributions do not fetch managed announcements, while release scripts use the aiwxxx.com update feed by default and old-domain URLs remain confined to compatibility tests or historical fixtures.
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
  - pnpm exec vitest run tests/unit/announcements-api.test.ts tests/unit/announcements-service.test.ts tests/unit/announcements-store.test.ts tests/unit/public-client-config-service.test.ts tests/unit/support-service.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts tests/unit/junfeiai-endpoints.test.ts tests/unit/provider-mutation-lock.test.ts tests/unit/i18n-locale-parity.test.ts tests/unit/openclaw-bundle-config.test.ts
  - pnpm exec playwright test tests/e2e/announcements.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - `shared/host-api/contract.ts` exposes a read-only typed `announcements.config` action and Renderer code calls only `hostApi.announcements.config()`.
  - Electron Main fetches the configured public client-config route without Authorization, falls back to bootstrap only for an explicit 404, and honors the configured application proxy and timeout.
  - Main normalizes announcement fields before crossing into Renderer, rejects malformed dates and unsafe external URLs, removes disabled or expired items, and sorts/deduplicates the visible feed.
  - Read, toast, and urgent-dismiss keys are persisted with a bounded, UClaw-scoped store; refreshes do not write credentials, Provider/OpenClaw configuration, or Gateway state.
  - The bell, toast, and urgent dialog use the current shared locale resources in en, zh, ja, and ru and open only validated HTTP(S) links.
  - Runtime and Windows release defaults resolve to `https://aiwxxx.com`; `zz-cn.lingzhiwuxian.com` remains only where an explicit compatibility or historical fixture requires it.
  - Documentation describes the production origin, public unauthenticated announcement read, level/read behavior, safe link policy, and disabled/community behavior.
docs:
  required: true
  files:
    - README.md
    - README.zh-CN.md
    - README.ja-JP.md
---

## Migration constraints

- Keep announcement retrieval independent from Managed Auth, billing, Chat stores, Provider reconciliation, and Gateway lifecycle code.
- Use the shared UClaw endpoint configuration for the production origin, client-config route, bootstrap compatibility route, timeout, and update feed; do not duplicate the old domain in runtime or release defaults.
- Preserve `lingzhiwuxian` provider identifiers and old-domain URLs in tests or historical reports when they describe compatibility behavior rather than the current production route.
- Do not restore the removed localhost Host API server, `/api/junfeiai/*` Renderer routes, `hostapi:fetch`, direct Renderer fetches, or direct `ipcRenderer.invoke` calls.
- Release validation must remain read-only until its existing credentialed publishing step is explicitly invoked, and must not contact a production announcement endpoint from Electron E2E.

## Rollback

- Remove the announcement Host API module, service, store, components, locale keys, and sidebar/App mounts.
- Restore the previous release-feed defaults only when reverting the corresponding backend deployment; compatibility fixtures and provider identifiers remain unchanged.
- Authentication, Provider data, OpenClaw configuration, Gateway state, billing, skills, and existing sessions remain unchanged because announcements own no runtime configuration.
