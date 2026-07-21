---
id: packaged-windows-regression
title: Packaged Windows Regression
type: packaged-runtime
ownedPaths:
  - package.json
  - playwright.packaged.config.ts
  - scripts/build-usb-release.mjs
  - scripts/windows-support/**
  - tests/packaged-e2e/**
  - PACKAGED_REGRESSION.md
requiredProfiles:
  - e2e
requiredRules:
  - gateway-readiness-policy
  - renderer-main-boundary
  - backend-communication-boundary
  - capability-owner-resolution
  - active-config-guards
  - presentation-artifact-quality
  - docs-sync
---

Use this scenario for every Windows USB package. Source-mode Electron tests and IPC mocks are supporting checks; they do not prove that the distributed executable, bundled Gateway, plugins, native binaries, portable paths, or runtime recovery work.

The required path is:

1. Validate the ZIP companion JSON, file size, SHA-512, package type, version, build ID, Git commit, source-tree state, and x64 PE identities.
2. Extract the ZIP to an isolated temporary path containing spaces.
3. Confirm that packaged `UClawData` contains no account, token, config, log, session, update, or cache data.
4. Run `UClaw-SelfCheck.cmd --static-only --no-desktop-copy` with the bundled Node runtime.
5. Launch the extracted `UClaw.exe`, with isolated HOME, APPDATA, LOCALAPPDATA, TEMP, runtime cache, Host API port, Gateway port, and portable data.
6. Exercise the real Renderer -> Main IPC -> Host API -> Gateway -> OpenClaw -> Provider path.
7. Continue independent scenarios after a failure, then fail the overall run with an aggregate report.
8. Redact credentials from copied diagnostics and remove a successful sandbox. Keep failed sandboxes for diagnosis.

## Required deterministic coverage

The `full` profile must not use a mocked Electron Main process. It may use a local deterministic OpenAI-compatible HTTP server so model behavior is repeatable and does not cost money. Provider creation and validation still go through the real UI and provider/runtime synchronization.

Required scenarios:

- fresh portable startup and setup persistence;
- all core navigation surfaces;
- Gateway RPC readiness, stop/start, foreign-port conflict, and recovery;
- invalid Provider credentials and a healthy custom Provider;
- simple, multilingual, Markdown, and multi-turn chat;
- one-shot 429 and 500 responses followed by verified OpenClaw retry success;
- malformed streaming failure with a recorded Provider request;
- cancellation only after the slow request reaches the Provider;
- persistent 401 failure, successful credential revalidation through the Provider UI, persisted auth-failure reset, Gateway restart, and a healthy recovery turn;
- a real file-writing tool side effect;
- real managed-browser open and snapshot actions;
- Agent create/update/delete;
- Cron create/disable/invalid/delete;
- packaged FFmpeg timeline render, segment composition, ffprobe/shot QA, and missing-input failure;
- single-instance rejection and relaunch persistence;
- managed-distribution startup without auth, which must defer Gateway cleanly.

## Live coverage and side effects

Managed Responses, cloud image generation, cloud video generation, desktop capture, and external channel delivery have cost, privacy, or external-side-effect requirements. They must be explicit gates, never inferred from the developer's existing profile.

- `live` requires a caller-supplied, test-only `UClawData` directory.
- The harness copies that directory into the temporary package sandbox and never mutates the source.
- Desktop capture requires `--allow-desktop-capture`.
- External delivery requires `--allow-external-delivery` plus `UCLAW_REGRESSION_DELIVERY_CHANNEL`, `UCLAW_REGRESSION_DELIVERY_ACCOUNT_ID`, and `UCLAW_REGRESSION_DELIVERY_TARGET`. It must use a dedicated test destination, verify the final delivery state, and remove its temporary Cron job.
- Tokens, API keys, passwords, signed URLs, Authorization headers, and Provider secret values must never enter reports.
- Deterministic Provider reports may include scenario names, attempt numbers, model IDs, message roles, and tool names, but never request headers or secret values.

## Release gate

`pnpm run package:win:usb` runs the `full` packaged regression after ZIP creation. A package is not distributable when the command exits non-zero, even when ZIP and metadata files exist. Test packages stay local; production OSS and release feed changes occur only after the packaged regression passes and the branch/version rules are satisfied.
