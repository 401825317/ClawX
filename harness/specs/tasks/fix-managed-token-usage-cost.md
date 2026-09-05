---
id: fix-managed-token-usage-cost
title: Resolve managed token usage cost from settled billing logs
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Replace managed placeholder zero costs with uniquely matched settled relay charges.
touchedAreas:
  - harness/specs/tasks/fix-managed-token-usage-cost.md
  - electron/services/managed-token-usage-cost-service.ts
  - electron/utils/token-usage.ts
  - electron/utils/token-usage-core.ts
  - package.json
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-response-request-id-patch.mjs
  - shared/host-api/contract.ts
  - shared/i18n/locales/en/dashboard.json
  - shared/i18n/locales/zh/dashboard.json
  - shared/i18n/locales/ja/dashboard.json
  - shared/i18n/locales/ru/dashboard.json
  - src/pages/Models/index.tsx
  - src/pages/Models/usage-history.ts
  - tests/e2e/token-usage.spec.ts
  - tests/unit/managed-token-usage-cost-service.test.ts
  - tests/unit/models-page.test.tsx
  - tests/unit/openclaw-response-request-id-patch.test.ts
  - tests/unit/token-usage-scan.test.ts
  - tests/unit/token-usage.test.ts
expectedUserBehavior:
  - Managed model usage rows show the settled server charge when one billing log matches uniquely.
  - Placeholder zero costs are never presented as free usage.
  - Offline, unavailable, or ambiguous billing data falls back without inventing a charge.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/managed-token-usage-cost-service.test.ts
  - tests/unit/token-usage.test.ts
  - tests/unit/token-usage-scan.test.ts
  - tests/unit/models-page.test.tsx
  - tests/e2e/token-usage.spec.ts
acceptance:
  - Relay credentials are read only in Electron Main and never cross the Host API boundary.
  - Billing lookups target only the configured UClaw production origin.
  - New usage is joined by the unique settled request ID; historical usage requires a bidirectionally unique model, token, and timestamp match.
  - Existing provider-supplied positive and genuine zero costs remain unchanged.
  - Provider request IDs and Relay credentials remain in Electron Main and never cross the Host API boundary.
  - Renderer does not add direct IPC or backend fetch calls.
docs:
  required: false
---

This task covers the managed UClaw token history path from local OpenClaw transcripts through Main-owned settled billing lookup to the Models page.
