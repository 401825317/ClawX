---
id: migrate-public-skill-marketplace
title: Migrate the public SkillHub and ClawHub marketplace onto typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Restore the public skill marketplace without coupling it to managed authentication or making local skill management depend on Gateway readiness.
touchedAreas:
  - .gitignore
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - harness/specs/tasks/migrate-public-skill-marketplace.md
  - electron/extensions/builtin/clawhub-marketplace.ts
  - electron/extensions/builtin/skillhub-marketplace.ts
  - electron/extensions/builtin/marketplace-config.ts
  - electron/extensions/builtin/index.ts
  - electron/extensions/registry.ts
  - electron/extensions/types.ts
  - electron/gateway/clawhub.ts
  - electron/main/index.ts
  - electron/services/skills-api.ts
  - electron/services/skills/local-skill-service.ts
  - shared/host-api/contract.ts
  - shared/types/skill.ts
  - src/lib/host-api.ts
  - src/pages/Skills/index.tsx
  - src/stores/skills.ts
  - shared/i18n/locales/*/skills.json
  - tests/e2e/skills-gateway-readiness.spec.ts
  - tests/unit/clawhub-service.test.ts
  - tests/unit/host-api-facade.test.ts
  - tests/unit/local-skill-service.test.ts
  - tests/unit/skillhub-marketplace.test.ts
  - tests/unit/skills-api-marketplace.test.ts
  - tests/unit/skills-errors.test.ts
  - tests/unit/skills-page-gateway-readiness.test.tsx
  - tests/unit/skills-store-fetch-parallel.test.ts
  - tests/unit/skills-store-marketplace.test.ts
expectedUserBehavior:
  - Installed skills remain visible and manageable while Gateway is stopped or starting.
  - The Skills page exposes separate Installed and Marketplace views.
  - Marketplace Explore, keyword search, category search, pagination, install, and uninstall work through typed Host API actions.
  - SkillHub is the default public provider and compatible ClawHub results keep their provider identity through installation.
  - Marketplace browsing and installation do not require a UClaw account or managed-provider token.
  - Opening or using Marketplace never starts, stops, or restarts Gateway.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - gateway-readiness-policy
  - ui-i18n-design-tokens
requiredTests:
  - tests/e2e/skills-gateway-readiness.spec.ts
  - tests/unit/clawhub-service.test.ts
  - tests/unit/skillhub-marketplace.test.ts
  - tests/unit/skills-api-marketplace.test.ts
  - tests/unit/skills-store-marketplace.test.ts
  - tests/unit/local-skill-service.test.ts
  - tests/unit/host-api-facade.test.ts
acceptance:
  - Renderer marketplace calls use hostApi.skills.marketplace* and add no direct IPC or backend HTTP calls.
  - Legacy clawhub* actions remain Main-side compatibility aliases and are not used by the new Renderer flow.
  - Marketplace actions do not read managed-auth state, tokens, or provider-session state.
  - Marketplace actions do not invoke Gateway lifecycle operations.
  - Local skills load before best-effort Gateway runtime status is merged.
  - Provider selection defaults to SkillHub and explicitly routes ClawHub results back to ClawHub for installation.
  - SkillHub downloads enforce request, response, archive-entry, file-count, and uncompressed-size limits.
  - SkillHub archives reject absolute paths, parent traversal, Windows path traversal, and missing root SKILL.md.
  - Skill replacement is atomic and restores the prior installed version when commit fails.
  - Only user-installed SkillHub or ClawHub managed skills with valid origin metadata can be uninstalled.
  - Marketplace strings have matching English, Chinese, Japanese, and Russian locale keys.
docs:
  required: true
---

Use this task spec when changing the public marketplace providers, marketplace Host API, or the Skills marketplace UI.
