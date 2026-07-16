---
id: windows-usb-end-to-end-regression
title: Gate Windows USB packages with real end-to-end regression
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Exercise every distributable Windows USB package through the real Electron, Host API, Gateway, OpenClaw, Provider, tool, Agent, Cron, and media runtime paths before release.
touchedAreas:
  - .env.e2e
  - package.json
  - electron-builder.yml
  - electron/gateway/**
  - electron/services/providers/**
  - electron/utils/openclaw-auth.ts
  - scripts/build-usb-release.mjs
  - scripts/windows-support/**
  - src/App.tsx
  - src/components/channels/**
  - src/components/file-preview/**
  - src/components/settings/**
  - src/components/ui/**
  - src/lib/generated-files.ts
  - src/pages/Channels/**
  - src/pages/Chat/**
  - src/stores/chat.ts
  - src/stores/chat/**
  - tests/e2e/**
  - tests/packaged-e2e/**
  - playwright.config.ts
  - playwright.packaged.config.ts
  - PACKAGED_REGRESSION.md
  - harness/specs/scenarios/packaged-windows-regression.md
  - harness/specs/tasks/windows-usb-end-to-end-regression.md
expectedUserBehavior:
  - A newly extracted USB package starts with no inherited user state and completes setup, navigation, Gateway, Provider, chat, tool, Agent, Cron, media, relaunch, and single-instance workflows.
  - Transient Provider failures retry, terminal failures return the composer to idle, corrected credentials recover, and invalid media inputs fail without false artifacts.
  - Reports contain reproducible runtime evidence without exposing credentials or reading the developer's personal UClaw profile.
requiredProfiles:
  - fast
  - e2e
  - comms
requiredRules:
  - gateway-readiness-policy
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - capability-owner-resolution
  - active-config-guards
  - presentation-artifact-quality
  - docs-sync
requiredTests:
  - tests/packaged-e2e/portable-regression.spec.ts
acceptance:
  - `package:win:usb` requires a clean source tree, creates ZIP and companion metadata, then runs the `full` packaged regression as a release gate.
  - Core coverage validates package identity, SHA-512, static self-check, empty portable state, first launch, navigation, Gateway stop/start, port conflict, single instance, relaunch persistence, and managed startup without auth.
  - Full coverage uses two deterministic local Providers through the real UI and runtime synchronization for fallback/deletion, session lifecycle, chat, transient retries, malformed streaming, cancellation, 401 credential recovery, file/browser/DOCX/XLSX/PPTX tools, Skills configuration, Doctor/log/Control UI diagnostics, Agent, Cron, and FFmpeg media workflows.
  - DOCX, XLSX, and PPTX passes require a visible chat attachment recovered from either direct `toolResult.details` or nested `toolResult.details.result.details`, plus readable package structure and content evidence.
  - Chat and error scenarios require both Renderer state and a matching recorded Provider request so cooldowns cannot create false passes.
  - Child processes use isolated HOME, APPDATA, LOCALAPPDATA, TEMP, ports, and portable data; inherited UCLAW, CLAWX, OPENCLAW, token, key, password, and secret environment variables are removed.
  - Live login is accepted only from no-echo stdin or an explicitly supplied isolated profile; managed status, recharge overview/order history, Responses, image, video, desktop capture, and external delivery remain explicit opt-in gates with dedicated test data and destinations, and automated payment is forbidden.
  - Every report classifies evidence as SOURCE_E2E, PACKAGED_REAL, LIVE_REQUIRED, STATIC_ONLY, or NOT_COVERED; mocks and unexecuted conditional capabilities are never counted as packaged passes.
docs:
  required: true
---

This task is the implementation contract for the Windows packaged regression.
Source-mode mocks remain useful for development, but they cannot replace evidence
from the exact executable and runtime tree distributed to testers or production.
