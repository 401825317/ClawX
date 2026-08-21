---
id: uclaw-seven-area-hardening
title: Harden artifact workflows, durable rules, and production diagnostics
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Make artifact work deterministic and fast, open successful HTML artifacts in the built-in browser, persist explicit long-term rules, and prevent logging or fatal-handler failures from taking down UClaw while keeping all rollout policy remotely controlled.
touchedAreas:
  - harness/specs/tasks/uclaw-seven-area-hardening.md
  - harness/src/runner.mjs
  - electron-builder.yml
  - package.json
  - pnpm-lock.yaml
  - vite.config.ts
  - vitest.config.ts
  - shared/managed-client-config.ts
  - shared/acp-chat/errors.ts
  - shared/host-api/contract.ts
  - shared/acp-chat/types.ts
  - shared/artifact-tasks.ts
  - shared/long-term-rules.ts
  - shared/observability-scrub.ts
  - electron/api/routes/**
  - electron/gateway/**
  - electron/main/**
  - electron/services/**
  - electron/utils/logger.ts
  - electron/utils/telemetry.ts
  - electron/utils/channel-config.ts
  - electron/utils/agent-profile.ts
  - resources/openclaw-plugins/uclaw-artifact-orchestrator/**
  - resources/openclaw-plugins/uclaw-local-artifacts/**
  - resources/openclaw-skill-shims/ecommerce-main-image/**
  - scripts/after-pack.cjs
  - scripts/comms/**
  - scripts/openclaw-bundle-config.mjs
  - scripts/prepare-sentry-sourcemaps.mjs
  - src/App.tsx
  - src/components/settings/LongTermRulesSettings.tsx
  - src/lib/host-api.ts
  - src/lib/acp/html-auto-open.ts
  - src/lib/model-options.ts
  - src/lib/observability.ts
  - src/pages/Chat/**
  - src/pages/Settings/**
  - src/stores/artifact-panel.ts
  - src/stores/managed-client-config.ts
  - shared/i18n/locales/**
  - tests/unit/**
  - tests/e2e/**
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - Normal PPT, DOCX, XLSX, and HTML creation uses a deterministic fast artifact route with minimal thinking, no unnecessary network or image generation, one render, and at most one targeted repair.
  - Explicit requests for refined design or asset search use the refined route and allow at most two targeted repairs.
  - A new artifact request in an empty conversation stays in place, while one made after unrelated history creates and selects a visible isolated artifact session; revisions remain in that artifact session.
  - Successful live HTML tool output inside the current workspace opens or refreshes the built-in Web Browser within two seconds and history replay never opens it.
  - Explicit remember-forever wording stores a global or per-Agent long-term rule, projects it into an owned AGENTS.md block without touching user content, and offers undo plus Settings CRUD.
  - Ecommerce main-image requests use a versioned built-in skill that preserves product structure, packaging, logos, and text while model, quality, and dimensions remain server managed.
  - A disconnected stdout sink cannot crash UClaw, repeat fatal handling, or stop the Gateway more than once; file logs keep working with bounded rotation.
  - The existing telemetry preference controls PostHog, Sentry, Crashpad upload, and tracing together, with secrets, prompts, file contents, and private path prefixes removed before upload.
  - Managed backend requests include build diagnostics only for the exact configured UClaw origin, and remote configuration can independently stop or gradually enable every new capability.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - gateway-readiness-policy
  - provider-model-metadata-preservation
  - session-workspace-authority
  - tool-derived-file-safety
  - web-browser-security-and-lifecycle
  - diagnostics-trace-safety
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/uclaw-seven-area-hardening.md
  - pnpm run typecheck
  - pnpm test
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm run harness:ci
  - pnpm run build:vite
  - pnpm run test:e2e
acceptance:
  - Artifact classification is deterministic, Main-owned, unit tested, and emits only classification, model, thinking, tool-count, duration, and repair-count metadata without prompt text.
  - The hidden uclaw-artifact-v1 model is available to runtime resolution with visible false and never appears in the normal model picker.
  - Fast and refined execution budgets are enforced by runtime hooks rather than prompt compliance alone.
  - HTML auto-open accepts only a newly completed webpage artifact whose canonical path is within the active workspace; the last successful HTML wins and same-path writes refresh.
  - Long-term rules use an atomic local store and an independently owned AGENTS.md block with global and per-Agent scopes, versioning, timestamps, startup repair, and bounded undo.
  - Ecommerce main-image classification and the versioned skill are covered without hard-coded model, quality, or size policy in the client.
  - Console EPIPE permanently opens only that sink's circuit breaker, bounded file logs continue, fatal handling is single-entry, emergency logging bypasses Logger, and Gateway cleanup is idempotent.
  - Sentry has no replay, honors remote sampling and kill switches, applies a per-install hourly error cap, and scrubs authentication data, prompt content, file content, and private path prefixes.
  - Client config exposes independent observability, artifacts, and ecommerceMainImage sections; invalid values fall back to safe disabled defaults.
  - Exact-origin managed requests carry version, commit, build ID, platform, architecture, channel, runtime mode, and request ID, while all other destinations receive none of those headers.
  - Unit, Electron E2E, communication replay/compare, Harness, typecheck, and build checks pass; packaged live and full regressions remain separate QA workflows.
docs:
  required: true
---

# UClaw seven-area hardening

This specification is the executable contract for the coordinated client and zz-cn changes. Rollout percentages, model routing, image policy, sampling, and emergency shutdown remain remote policy. Client behavior must remain safe when the backend omits every new field.
