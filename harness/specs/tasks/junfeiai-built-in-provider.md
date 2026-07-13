---
id: junfeiai-built-in-provider
title: Built-in JunFeiAI activation and provider flow for ClawX
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Migrate the ClawBox-style startup, activation, authorization, built-in model provider, skill list, WeChat plugin install, and Windows portable experience into ClawX without requiring users to manually add a provider or paste an API key.
touchedAreas:
  - harness/specs/tasks/junfeiai-built-in-provider.md
  - PROJECT_MAP.md
  - .env.example
  - src/lib/host-api.ts
  - src/lib/providers.ts
  - src/stores/providers.ts
  - src/components/settings/ProvidersSettings.tsx
  - src/pages/Setup/index.tsx
  - src/pages/Skills/index.tsx
  - src/i18n/locales/en/settings.json
  - src/i18n/locales/zh/settings.json
  - src/i18n/locales/ja/settings.json
  - src/i18n/locales/ru/settings.json
  - electron/api/routes/providers.ts
  - electron/api/routes/junfeiai.ts
  - electron/api/routes/skills.ts
  - electron/api/server.ts
  - electron/extensions/builtin/clawhub-marketplace.ts
  - electron/gateway/clawhub.ts
  - electron/main/index.ts
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/services/providers/provider-service.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/store-instance.ts
  - electron/services/secrets/secret-store.ts
  - electron/services/skills/local-skill-service.ts
  - electron/shared/providers/registry.ts
  - electron/shared/providers/types.ts
  - electron/utils/junfeiai-device.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - electron/utils/secure-storage.ts
  - electron/utils/skill-config.ts
  - electron-builder.yml
  - package.json
  - harness/src/specs.mjs
  - scripts/after-pack.cjs
  - scripts/bundle-openclaw.mjs
  - scripts/bundle-preinstalled-skills.mjs
  - scripts/dev-junfeiai.mjs
  - scripts/download-bundled-agent-browser.mjs
  - scripts/download-bundled-node.mjs
  - scripts/download-bundled-uv.mjs
  - scripts/patch-nsis-extract.mjs
  - scripts/pnpm.cmd
  - scripts/run-electron-builder.mjs
  - vite.config.ts
  - tests/unit/harness-specs.test.ts
  - tests/unit/junfeiai-service.test.ts
  - tests/unit/providers.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/provider-service-stale-cleanup.test.ts
  - tests/unit/provider-store-validation.test.ts
  - tests/unit/secret-store.test.ts
  - tests/unit/local-skill-service.test.ts
  - tests/unit/skill-config-bundled-defaults.test.ts
  - tests/unit/clawhub-service.test.ts
  - tests/e2e/provider-lifecycle.spec.ts
  - tests/e2e/skills-gateway-readiness.spec.ts
expectedUserBehavior:
  - A clean Windows install or portable unzip starts with JunFeiAI as the built-in model provider and does not require users to add a provider or paste an API key.
  - Startup calls `https://zz-cn.lingzhiwuxian.com/api/clawx/bootstrap`, then uses `/api/clawx/*` for activation, login/register, verify, device unregister, and relay-token flows.
  - The returned relay credential is saved through ClawX secure secret storage and never shown in plaintext settings, logs, or UI.
  - The runtime writes a Gateway-valid JunFeiAI provider entry pointing at the shared configured origin's `/v1`, with the server-provided default model and the shared `openai-responses` protocol.
  - Development and packaged execution read the same JunFeiAI origin, context window, and protocol from `shared/junfeiai-endpoints.json`; environment-only development overrides are not applied.
  - If the authorization server is unreachable, ClawX allows short offline use only when the last successful verify is inside the server-provided grace window.
  - If the server rejects auth, entitlement, or device state, ClawX does not use offline grace and blocks model access.
  - The Settings provider add/manual-key flow is hidden or disabled for the JunFeiAI distribution while the app still keeps provider internals testable.
  - The Skills page shows bundled OpenClaw skills comparable to ClawBox before any remote marketplace is enabled.
  - The ClawHub remote marketplace remains disabled unless a JunFeiAI marketplace provider is explicitly implemented.
  - The packaged WeChat plugin is installed from bundled resources on a fresh machine without requiring a separate manual download.
  - A Windows portable artifact can run from an extracted folder and keep runtime/user data under the portable layout.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - active-config-guards
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
  - packaged-runtime-pruning-guards
  - docs-sync
requiredTests:
  - tests/unit/junfeiai-service.test.ts
  - tests/unit/secret-store.test.ts
  - tests/unit/providers.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/provider-store-validation.test.ts
  - tests/unit/local-skill-service.test.ts
  - tests/unit/skill-config-bundled-defaults.test.ts
  - tests/unit/clawhub-service.test.ts
  - tests/e2e/provider-lifecycle.spec.ts
  - tests/e2e/skills-gateway-readiness.spec.ts
acceptance:
  - JunFeiAI provider metadata is represented as a first-class built-in/provider-account type or as a locked managed account with the shared configured `/v1` base URL, `apiProtocol=openai-responses`, and a server-provided default model.
  - Manual provider creation and API-key entry are hidden for the JunFeiAI distribution, but renderer code still respects the Main-owned provider/account APIs instead of adding direct IPC or direct Gateway HTTP calls.
  - A ClawX auth client in the Main process calls `/api/clawx/bootstrap`, `/api/clawx/activation/check`, `/api/clawx/register`, `/api/clawx/login`, `/api/clawx/auth/verify`, `/api/clawx/auth/unregister-device`, and `/api/clawx/relay-token` through a single transport module with redacted logging.
  - Relay credentials are stored through `electron/services/secrets/secret-store.ts` and injected into OpenClaw runtime only through existing provider runtime sync helpers.
  - Offline grace state records only non-secret metadata such as last successful verify time, grace seconds, user id, device id, and provider runtime shape; access tokens, refresh tokens, relay credentials, and API keys are not written to plaintext JSON.
  - Verify failures distinguish network/unreachable errors from definite server rejection; only network/unreachable failures can use offline grace.
  - Bundled OpenClaw skill filtering is expanded or made distribution-configurable so ClawBox-like bundled skills appear in the Skills page while still preventing accidental package bloat or unsafe arbitrary installs.
  - The ClawHub marketplace capability remains disabled for community builds unless a JunFeiAI marketplace provider is registered and covered by tests.
  - WeChat plugin bundling and install paths are covered by unit or package-structure tests, including the `@tencent-weixin/openclaw-weixin` payload.
  - Windows packaging supports the existing NSIS installer and a portable artifact, with documented runtime/data paths and no regression to packaged runtime pruning.
  - README files and localized settings/skills text are reviewed when UI flow text changes.
docs:
  required: true
---

## Background

ClawBox already provides a mostly self-contained desktop flow: startup checks a
remote bootstrap endpoint, activation/registration are handled by the ClawBox
service, the model provider is built in, authorization verification supports a
short offline grace window, bundled OpenClaw skills are visible, and the WeChat
plugin is copied from the packaged runtime during first run.

ClawX currently exposes a more general community app flow where the user can add
providers manually. For the JunFeiAI distribution, that is too complex. The app
should behave like ClawBox: users activate or log in, then the JunFeiAI provider,
models, skills, and WeChat plugin are ready without manual provider setup.

The backend compatibility contract is tracked in Sub2API as
`docs/clawx_compat_api.md` on the `feature/clawx-junfeiai-compat` branch.

## Scope

- Add a Main-owned ClawX auth/activation client for `https://zz-cn.lingzhiwuxian.com/api/clawx/*`.
- Bootstrap the managed account before Gateway startup while taking its origin, context window, and `openai-responses` protocol from the shared endpoint configuration.
- Persist relay credentials only through the existing secret-store path.
- Record authorization verify state for offline grace without storing secrets in plaintext.
- Hide or disable manual provider add/API-key entry for the JunFeiAI distribution.
- Expand bundled skill availability enough to reproduce the ClawBox skill list.
- Keep remote skill marketplace disabled in phase 1.
- Ensure packaged WeChat plugin installation works on a clean Windows machine.
- Add or preserve a Windows portable packaging path.

## Out of Scope

- Building a full remote skill marketplace in phase 1.
- Replacing Sub2API user billing or gateway accounting.
- Changing OpenClaw Gateway transport ownership from Main to renderer.
- Rewriting provider storage outside the existing provider-account and secret-store model.

## Implementation Notes

- Use `openai-responses` for JunFeiAI/Sub2API from
  `shared/junfeiai-endpoints.json`. Bootstrap values cannot override the
  configured origin or protocol, so development and packaged runtime behavior
  remains identical.
- Device id is not a secret. Access token, refresh token, relay token, and API key
  are secrets.
- Offline grace is a client-side availability rule, not a license bypass. It must
  never apply after a definite server rejection.
- Skills phase 1 should use bundled OpenClaw skills or preinstalled skills. Remote
  marketplace support should be a later provider extension with signed manifests.
- Portable mode should be evaluated with an actual extracted Windows artifact,
  not only an Electron config diff.
