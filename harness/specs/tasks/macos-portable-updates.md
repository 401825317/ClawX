---
id: macos-portable-updates
title: Route macOS clients through verified portable ZIP updates
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Make macOS arm64 and x64 update checks use the managed portable ZIP contract while separating package delivery from portable-data eligibility and keeping replacement, migration, rollback, Helper startup, and ACP recovery safe.
touchedAreas:
  - .github/workflows/electron-e2e.yml
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - electron/main/portable-update-installer.ts
  - electron/main/portable-update-ready.ts
  - electron/main/updater.ts
  - electron/services/updates-api.ts
  - electron/utils/openclaw-cli.ts
  - electron/utils/portable-mode.ts
  - package.json
  - resources/cli/posix/openclaw
  - scripts/build-portable-updater.mjs
  - scripts/macos-support/**
  - shared/host-api/contract.ts
  - shared/i18n/locales/en/settings.json
  - shared/i18n/locales/ja/settings.json
  - shared/i18n/locales/ru/settings.json
  - shared/i18n/locales/zh/settings.json
  - src/components/settings/UpdateSettings.tsx
  - src/components/update/UpdateNotifier.tsx
  - src/stores/update.ts
  - tests/e2e/update-notifier.spec.ts
  - tests/unit/openclaw-cli.test.ts
  - tests/unit/openclaw-posix-wrapper.test.ts
  - tests/unit/portable-update-ready.test.ts
  - tests/unit/portable-mode-macos.test.ts
  - tests/unit/updater-macos.test.ts
  - tests/unit/updates-api.test.ts
  - tools/portable-updater/**
  - harness/specs/tasks/macos-portable-updates.md
expectedUserBehavior:
  - Every packaged macOS arm64 and x64 client checks the managed latest-update API with platform=mac, the running architecture, and package_type=portable_zip; it does not fall back to latest-mac.yml or electron-updater installer updates.
  - The update package type remains portable_zip even when the current data mode is installed; package delivery and portable-data mode are reported independently.
  - Automatic replacement is offered only for a complete, writable launch root containing sibling portable.flag, UClawData, and UClaw.app. The client never creates UClawData beside an installed app to make an incomplete layout eligible.
  - A DMG-launched app or an app moved alone into /Applications can download and verify the ZIP, then receives an actionable full-extraction and manual-migration instruction instead of an in-place replacement or forced restart.
  - A 2.0.3 client performs its first macOS migration manually. Automatic macOS portable updates are available from the fixed 2.0.4 release and later.
  - Verified ZIP replacement preserves UClawData, restores the previous app after a failed launch, and accepts an already-executable read-only app bundle without attempting chmod on the bundle.
  - Packaged macOS OpenClaw/ACP startup resolves the canonical UClaw Helper (with legacy-bundle compatibility where required) and remains gated by the real Gateway-ready state.
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
  - active-config-guards
  - packaged-runtime-pruning-guards
  - acp-chat-state-and-history
  - session-workspace-authority
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm run typecheck
  - pnpm exec vitest run tests/unit/updater-macos.test.ts tests/unit/portable-mode-macos.test.ts tests/unit/portable-update-ready.test.ts tests/unit/updates-api.test.ts tests/unit/openclaw-cli.test.ts tests/unit/openclaw-posix-wrapper.test.ts tests/unit/acp-chat-service.test.ts
  - node --test scripts/macos-support/stage-production-release-candidate.test.mjs
  - Set-Location tools/portable-updater; go test -v ./...
  - pnpm run test:e2e
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/macos-portable-updates.md
acceptance:
  - The macOS updater builds the managed latest-update URL for both arm64 and x64 with package_type=portable_zip and never invokes electron-updater or reads latest-mac.yml on macOS.
  - UpdateStatus exposes package type, data mode, auto-replacement eligibility, migration requirement/reason, and disposition without conflating an installed app with a portable data root.
  - The auto-replace gate requires portable.flag, UClawData, UClaw.app, and writable root/app/data paths at the time of installation; a stale eligibility result is rechecked before launching the helper.
  - Manual migration opens or reveals the verified ZIP and explains that the complete archive must be extracted into a new writable directory before data is copied; no UClawData directory is created next to /Applications/UClaw.app.
  - A verified macOS ZIP containing a real UClaw.app bundle replaces only application files, preserves UClawData, and records a rollback backup. Simulated startup failure restores the prior app, including its read-only executable mode, and removes new-only files.
  - Runtime helper lookup uses the bundle's UClaw Helper identity rather than app.getName() or a lowercase clawx Helper path; already-readable app resources are never chmod'ed in place.
  - macOS arm64 and x64 tests cover ZIP metadata, real app-bundle extraction, successful replacement, failure rollback, read-only-root rejection, manual migration, Helper lookup, and ACP/Gateway-ready startup. macOS-only integration tests explicitly skip with a diagnostic on other hosts.
  - User-facing update and migration copy is present in English, Simplified Chinese, Japanese, and Russian, and the three primary README files document the 2.0.3 manual boundary and 2.0.4+ automatic path.
  - The change is client-side only; the managed server `portable_zip` metadata contract is consumed without adding a second server route or feed.
docs:
  required: true
---

## Package and Data-Mode Boundary

The managed update API is the only macOS update source for packaged clients.
`package_type=portable_zip` describes the downloaded artifact; it does not
claim that the current installation is eligible for in-place replacement.
Eligibility is a fresh filesystem probe of the launch root and its
`portable.flag`, `UClawData`, and `UClaw.app` siblings. The probe must verify
write access without manufacturing portable state beside an installed App.

## Migration and Replacement Contract

Complete writable portable roots may hand a verified ZIP to the replacement
helper. App-only, DMG, and `/Applications` layouts stay on the downloaded ZIP
manual-migration path. Replacement excludes `UClawData`, validates filename,
size, and SHA-512 before staging, and keeps a restorable application backup
until the updated app reaches its ready signal. A failed launch rolls back the
application tree and leaves user data untouched.

## Platform and ACP Verification

The integration matrix runs on macOS arm64 and x64 with `ditto`-created app
bundles, a successful update, a simulated startup failure, and a read-only
preflight. Unit and Electron tests cover update status presentation, canonical
Helper resolution, no-`chmod` behavior, manual migration, and ACP startup
gating against the real Gateway-ready state. The first upgrade from 2.0.3 is
documented as a one-time manual install; 2.0.4 and later are the fixed
automatic-update line.
