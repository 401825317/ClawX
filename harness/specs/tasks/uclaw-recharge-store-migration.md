---
id: uclaw-recharge-store-migration
title: Migrate the UClaw recharge store onto the typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Port the UClaw balance overview, recharge products, payment order creation, QR checkout, payment-status polling, and order history from master into ClawX 0.5.1 while keeping credentials Main-owned and leaving Chat event rendering unchanged.
touchedAreas:
  - harness/specs/tasks/uclaw-recharge-store-migration.md
  - shared/billing.ts
  - shared/host-api/contract.ts
  - shared/i18n/locales/**
  - shared/i18n/resources.ts
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/main/ipc-handlers.ts
  - electron/services/billing-api.ts
  - electron/services/billing-service.ts
  - electron/services/managed-auth-service.ts
  - src/App.tsx
  - src/components/layout/Sidebar.tsx
  - src/lib/host-api.ts
  - src/pages/Recharge/**
  - src/types/qrcode-terminal-vendor.d.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - tests/unit/billing-api.test.ts
  - tests/unit/billing-service.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/junfeiai-endpoints.test.ts
  - tests/unit/managed-auth-service.test.ts
  - tests/e2e/recharge.spec.ts
expectedUserBehavior:
  - A signed-in UClaw user can open the recharge store and see the current shrimp balance, available recharge product, supported payment methods, and paginated order history.
  - Creating an order shows a scannable payment QR code or a safe external-payment fallback when the backend supplies only a checkout URL.
  - The checkout dialog polls the order status every two seconds, stops on terminal status or unmount, ignores stale order responses, and refreshes the balance after successful payment.
  - Expired, cancelled, failed, unauthenticated, and temporarily unreachable states show localized actionable messages without exposing credentials or raw backend payloads.
  - Recharge navigation does not change Chat streaming, Timeline ordering, ACP behavior, Gateway lifecycle, or OpenClaw runtime configuration.
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
  - pnpm exec vitest run tests/unit/managed-auth-service.test.ts tests/unit/billing-api.test.ts tests/unit/billing-service.test.ts tests/unit/host-api-facade.test.ts tests/unit/host-services.test.ts
  - pnpm exec playwright test tests/e2e/recharge.spec.ts
acceptance:
  - `shared/host-api/contract.ts` exposes a typed `billing` module for overview, history, order creation, and order verification; Renderer code calls only `hostApi.billing.*`.
  - The Main process obtains and refreshes the managed access token through the existing Managed Auth service. Tokens never appear in Renderer payloads, URLs, logs, tests, or persisted non-secret state.
  - Billing endpoint paths, request timeouts, poll interval, and history page size are sourced from the shared UClaw configuration rather than duplicated across Renderer and Main.
  - The migration does not restore the legacy localhost Host API server, `/api/junfeiai/*` routes, `hostapi:fetch`, direct Renderer fetches, or direct `ipcRenderer.invoke` calls.
  - Overview and history are read-only. Creating and verifying an order do not write Provider/OpenClaw configuration or start, reload, restart, or stop Gateway.
  - The UI validates amount and backend configuration, renders payment QR data locally, opens only an HTTP(S) checkout URL through `hostApi.shell.openExternal`, and clears polling on terminal status, checkout reset, and component unmount.
  - All visible copy exists in en, zh, ja, and ru locale resources and uses current ClawX design tokens.
  - Unit tests cover payload validation, authentication failure, token refresh use, endpoint mapping, status normalization, stale polling protection, and the absence of credential fields in Host API responses.
  - Electron E2E uses deterministic mocked typed Host services and never creates or pays a production order.
docs:
  required: true
  files:
    - README.md
    - README.zh-CN.md
    - README.ja-JP.md
---

## Migration constraints

- Use the committed Managed Auth implementation at `801453cb` as the authentication baseline.
- Adapt the product flow from `master`; do not copy the legacy `junfeiai-service.ts` monolith or localhost route layer.
- Keep billing isolated from Chat stores, Chat events, session history, Timeline reconciliation, ACP, and Gateway lifecycle code.
- Automated tests may mock order creation but must not call a real payment endpoint.

## Rollback

- Remove the Recharge route, sidebar entry, typed `billing` Host API module, and billing services.
- Managed Auth, Provider data, OpenClaw configuration, and existing chat sessions remain unchanged because billing owns no local runtime configuration.
