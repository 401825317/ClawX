---
id: uclaw-desktop-and-blender-runtime
title: Add cross-platform desktop control and Blender artifact runtime
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add explicit, verified desktop-operation and Blender 3D artifact execution paths without changing ordinary chat, image, video, or presentation ownership.
touchedAreas:
  - harness/specs/tasks/uclaw-desktop-and-blender-runtime.md
  - shared/chat-runtime-events.ts
  - electron/api/server.ts
  - electron/api/routes/computer.ts
  - electron/api/routes/blender.ts
  - electron/main/ipc-handlers.ts
  - electron/preload/index.ts
  - electron/services/computer/**
  - electron/services/blender/**
  - electron/shared/skills/bundled-allowlist.ts
  - electron/utils/openclaw-auth.ts
  - resources/openclaw-plugins/uclaw-desktop-control/**
  - resources/openclaw-plugins/uclaw-blender/**
  - resources/openclaw-plugins/uclaw-artifact-guard/**
  - resources/openclaw-skill-shims/blender-maker/**
  - resources/blender/runtime/**
  - harness/fixtures/blender/**
  - scripts/bundle-openclaw-plugins.mjs
  - scripts/openclaw-bundled-skill-allowlist.mjs
  - src/components/file-preview/**
  - src/components/desktop/**
  - src/App.tsx
  - src/lib/desktop-control.ts
  - src/lib/generated-files.ts
  - src/lib/api-client.ts
  - src/i18n/locales/**/chat.json
  - tests/e2e/desktop-approval-overlay.spec.ts
  - package.json
  - pnpm-lock.yaml
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - Explicit desktop actions retain an observable run until a fresh desktop state verifies completion or reports a recoverable blocker.
  - High-impact desktop actions require a Main-issued, short-lived approval and cannot be self-approved by model parameters.
  - Existing browser/API/CLI capabilities remain preferred over desktop interaction and ordinary chat does not gain desktop side effects.
  - Explicit 3D requests produce verified Blender source, portable GLB, and preview artifacts when Blender is available.
  - Blender receives declarative SceneSpec data only; model-produced arbitrary Python is never executed.
  - Existing chat, image, video, and presentation Agent tool ownership remains unchanged unless a current-turn request explicitly targets desktop control or Blender 3D creation.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - capability-owner-resolution
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec tsc --noEmit --pretty false
  - pnpm harness validate --spec harness/specs/tasks/uclaw-desktop-and-blender-runtime.md --since HEAD
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Main owns Computer Use backend selection, approval issuance, foreground/state freshness checks, and managed screenshot storage.
  - Desktop state is scoped to session and app, stale element references fail closed, and each action produces a new observable state.
  - The desktop plugin is a thin Host API client with no direct OS action implementation or embedded model-controlled approval bypass.
  - Main owns Blender executable discovery, a single-concurrency job queue, cancellation, job journal, output validation, and recovery state.
  - Blender jobs only execute the bundled trusted runner with fixed command arguments and a validated SceneSpec.
  - Blender source, GLB, render preview, and verification events flow through the native runtime artifact stream, and capability-derived acceptance rejects missing or invalid outputs.
  - Renderer uses existing API client boundaries and provides a safe artifact preview/fallback for 3D outputs.
  - Bundled plugin lifecycle, package versions, skill allowlist, and packaged-runtime installation include the new plugins.
docs:
  required: true
---

## Global Routing Contract

Desktop control is a fallback for explicit local-app tasks after a purpose-built connector, managed browser tool, or deterministic artifact runtime has been considered.  Blender is a deterministic artifact runtime for explicit 3D creation and must not be implemented by clicking the Blender UI.

## Platform Contract

macOS and Windows are first-class targets. Linux uses a capability-reported adapter and may return a recoverable unsupported/permission blocker where the active display server cannot provide equivalent control.

## Current Release Boundary

The current UClaw Host implements managed desktop screenshots and window discovery on macOS only. Accessibility snapshots and native actions such as click, type, drag, scroll, and key input remain `not-implemented`; the runtime capability catalog must expose that blocker instead of advertising executable Computer Use. The desktop-action acceptance clauses below apply only after a signed platform driver, privileged approval surface, durable `desktop.action` Host Task, and same-session completion wake are connected. Electron UI regression testing uses Playwright and does not depend on the Codex Computer Use helper.

## Safety Contract

Rendered UI text, webpage content, and model parameters are untrusted for authorization. Main process approval tokens bind the session, run, application, action payload digest, and expiry. Blender cannot load arbitrary model-supplied scripts or automatically install executables/add-ons.
