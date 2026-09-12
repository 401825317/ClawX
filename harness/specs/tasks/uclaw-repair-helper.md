---
id: uclaw-repair-helper
title: Add a safe UClaw Windows repair helper
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Provide an independent Windows x64 helper for diagnosing a portable UClaw launch failure and applying only bounded, reversible repairs when the main Electron app cannot open.
touchedAreas:
  - .github/UCLAW_PORTABLE_RELEASE.md
  - .github/workflows/uclaw-portable-production.yml
  - tools/portable-repair/**
  - scripts/build-portable-repair.mjs
  - scripts/build-usb-release.mjs
  - scripts/release.test.mjs
  - scripts/run-electron-builder.mjs
  - scripts/windows-support/UClaw-SelfCheck.mjs
  - scripts/windows-support/publish-disabled-release-stage.ps1
  - scripts/windows-support/repack-portable-release.test.mjs
  - scripts/windows-support/validate-nsis-release.mjs
  - electron/utils/portable-first-launch-repair.ts
  - package.json
  - tests/packaged-e2e/portable-regression.spec.ts
  - tests/unit/portable-first-launch-repair.test.ts
  - harness/specs/tasks/uclaw-repair-helper.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - The helper discovers a portable installation from its own location, updater task files, or updater/application logs without assuming a drive letter.
  - Diagnostic output records platform, package identity, update residue, relevant process names, fixed gateway ports, and bounded log findings.
  - Repair mode may terminate only explicitly named UClaw/OpenClaw processes, isolate update staging/ready directories, and attempt a restart.
  - Repair mode never deletes UClawData, SQLite databases, session transcripts, credentials, or configuration by default.
  - Reports redact the current Windows user path and never include credentials or raw conversation content.
  - The helper is shipped as an external Windows x64 executable and is covered by package completeness and PE architecture checks.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - packaged-runtime-pruning-guards
  - diagnostics-trace-safety
  - docs-sync
requiredTests:
  - Set-Location tools/portable-repair; gofmt -w main.go main_test.go dialog_windows.go dialog_other.go; go test ./...
  - GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go test -c -o /tmp/uclawrepair-windows.test.exe ./...
  - pnpm run repair:build:win
  - pnpm exec vitest run tests/unit/portable-first-launch-repair.test.ts
  - pnpm harness validate --spec harness/specs/tasks/uclaw-repair-helper.md
acceptance:
  - The helper builds reproducibly with CGO disabled for Windows x64.
  - The package scripts build the helper before Windows portable and USB artifacts.
  - USB, self-check, first-launch repair, NSIS validation, and packaged regression all require resources/bin/UClawRepair.exe.
  - Installation discovery works for arbitrary Windows drive letters and does not scan or mutate unrelated user directories.
  - The default double-click run collects diagnostics and asks before repair; `--diagnose` stays diagnostic-only, while `--repair` opts into bounded update residue isolation, named UClaw/OpenClaw process cleanup, and a restart attempt.
  - No repair path removes or rewrites user state.
docs:
  required: true
---

## Safety Boundary

The helper runs outside Electron because the main app may not start. It must
remain dependency-free and must not require the gateway, Node, or OpenClaw to
collect the first report.

Use runtime cache paths under `%LOCALAPPDATA%\\UClawRuntime` for update tasks and
logs. Resolve the portable root from trusted task metadata and bounded local
context. Never hard-code `C:\\`, `D:\\`, `E:\\`, or another drive letter.

## Out Of Scope

- Deleting or repairing SQLite databases.
- Deleting sessions, credentials, provider configuration, or `UClawData`.
- Killing generic `node.exe` processes.
- Downloading or replacing an update package.
- Sending collected reports to a server without an explicit user action.
