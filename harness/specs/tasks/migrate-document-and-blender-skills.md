---
id: migrate-document-and-blender-skills
title: Migrate document and Blender skills without restoring the legacy Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Restore the develop-branch presentation, spreadsheet, document, and Blender capabilities on OpenClaw 2026.6.10 while preserving the current typed renderer boundary and ordinary chat ownership.
touchedAreas:
  - harness/specs/tasks/migrate-document-and-blender-skills.md
  - electron/services/blender/**
  - electron/gateway/config-sync.ts
  - electron/main/index.ts
  - electron/utils/openclaw-auth.ts
  - resources/blender/runtime/**
  - resources/openclaw-plugins/uclaw-local-artifacts/**
  - resources/openclaw-plugins/uclaw-blender/**
  - resources/openclaw-skill-shims/presentation-maker/**
  - resources/openclaw-skill-shims/spreadsheet-maker/**
  - resources/openclaw-skill-shims/document-maker/**
  - resources/openclaw-skill-shims/blender-maker/**
  - scripts/install-openclaw-skill-shims.mjs
  - scripts/bundle-openclaw.mjs
  - scripts/openclaw-bundle-config.mjs
  - scripts/build-usb-release.mjs
  - scripts/windows-support/UClaw-SelfCheck.mjs
  - tests/unit/blender-*.test.ts
  - tests/unit/uclaw-blender-runtime.test.ts
  - tests/unit/uclaw-local-artifacts.test.ts
  - tests/unit/openclaw-skill-shims.test.ts
  - tests/packaged-e2e/capability-matrix.json
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
expectedUserBehavior:
  - OpenClaw can select presentation-maker, spreadsheet-maker, document-maker, or blender-maker in the ordinary Agent loop without renderer-side intent routing.
  - Document tools write PPTX, DOCX, XLSX, text, and HTML artifacts without rewriting prompts, transcripts, tool results, or compression state.
  - Explicit Blender requests produce verified local artifacts when Blender is installed and return a concrete unavailable capability when it is not.
  - Existing chat streaming, history, image generation, video generation, Provider ownership, and OpenClaw 2026.6.10 remain unchanged.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - capability-owner-resolution
  - active-config-guards
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/blender-scene-spec.test.ts tests/unit/blender-bridge-server.test.ts tests/unit/blender-main-lifecycle.test.ts tests/unit/uclaw-blender-runtime.test.ts tests/unit/uclaw-local-artifacts.test.ts tests/unit/openclaw-skill-shims.test.ts tests/unit/config-sync-media-plugins.test.ts tests/unit/openclaw-auth.test.ts tests/unit/openclaw-bundle-config.test.ts
  - pnpm run typecheck:node
  - pnpm run bundle:openclaw-plugins
  - zx scripts/bundle-openclaw.mjs
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/migrate-document-and-blender-skills.md
acceptance:
  - No OpenClaw source or version is modified; package and lockfile keep OpenClaw 2026.6.10.
  - Skill shims install in development and packaged builds, skip user-owned same-name SKILL.md files, and do not restore the retired pdf, xlsx, docx, or pptx copies.
  - uclaw-local-artifacts registers document tools only and does not register prompt or transcript hooks.
  - The Blender plugin is a thin client of a Main-owned bridge and never executes OS or Blender operations itself.
  - The bridge listens on a system-selected 127.0.0.1 port, generates a new 256-bit bearer token for each app process, exposes only capabilities/create/get/repair, limits JSON bodies to 1 MiB, and caps a synchronous wait at 90 seconds.
  - Bridge origin and token exist only in the Gateway child environment; inherited stale values are discarded and secrets are never persisted or logged.
  - SceneSpec rejects Python, shell, scripts, and unknown fields, including nested fields. Blender runs only the bundled fixed runner with factory startup and auto-execution disabled.
  - Main shutdown stops the bridge, prevents queued work from starting, and terminates the active Blender process.
  - Packaged plugin bundling and Windows USB checks require both runtime plugins plus the Blender runner and schema.
docs:
  required: true
---

## Scope

This task migrates only the four requested skills and their deterministic local
artifact runtimes. The existing Renderer to Main typed APIs and the current ACP
chat timeline remain untouched.

## Out Of Scope

- Restoring the develop branch's full legacy Host API.
- Restoring uclaw-artifact-guard or any prompt/transcript/history hook.
- Modifying vendored OpenClaw files or upgrading OpenClaw beyond 2026.6.10.
- Bundling Blender itself or adding an inline GLB viewer.
- Adding desktop mouse, keyboard, or accessibility control.
