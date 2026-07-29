# Windows Portable Update And Production Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the portable updater recovery loop from `b46420e3` and the complete Windows USB production release loop from `ab9fdc3d` into `feature/claw-0.5.1` without changing the app version, managed endpoints, OpenClaw version, chat runtime, or existing user worktree changes.

**Architecture:** Keep the current `0.5.1` update discovery and download path as the source of truth. Extend only the detached portable helper contract with an isolated attempt, startup-ready marker, process-tree shutdown, verified relaunch, rollback, and previous-version restart. Add a separate protected Windows production workflow that builds one immutable USB candidate, deep-signs and re-hashes it, runs Full and fresh-account Live tests against that exact ZIP, then publishes immutable OSS objects and transactionally updates the public release feed.

**Tech Stack:** Electron 40, TypeScript, Go 1.22, Node.js scripts, PowerShell, GitHub Actions, SignPath, Alibaba OSS, SSH/PostgreSQL.

---

### Task 1: Lock The Migration Boundary

**Files:**
- Modify: `docs/superpowers/plans/2026-07-29-windows-portable-update-production-release.md`
- Review: `electron/main/updater.ts`
- Review: `shared/junfeiai-endpoints.json`

- [ ] Confirm the branch remains `feature/claw-0.5.1` and record pre-existing dirty files.
- [ ] Preserve `package.json` version `0.5.1`, OpenClaw `2026.6.10`, managed endpoint lookup, request timeouts, and update status clearing.
- [ ] Exclude chat, media generation, provider management, and runtime configuration from this migration.

### Task 2: Add Portable Updater Recovery Tests First

**Files:**
- Modify: `tools/portable-updater/main_test.go`
- Create: `tools/portable-updater/start_process_windows.go`
- Create: `tools/portable-updater/stop_process_windows.go`
- Modify: `tools/portable-updater/wait_windows.go`
- Create: `tools/portable-updater/start_process_unix.go`
- Create: `tools/portable-updater/stop_process_unix.go`
- Modify: `tools/portable-updater/wait_unix.go`

- [ ] Add tests proving backup paths are unique for immediate retries.
- [ ] Add tests proving a matching version/PID ready marker is required and immediate process exit fails verification.
- [ ] Run `go test ./...` under `tools/portable-updater` and verify the new tests fail because the recovery contract is absent.
- [ ] Implement process-tree wait/stop primitives required by the tests and cross-compilation.

### Task 3: Implement The Electron-to-Helper Ready Contract

**Files:**
- Create: `electron/main/portable-update-ready.ts`
- Modify: `electron/main/portable-update-installer.ts`
- Modify: `electron/main/index.ts`
- Modify: `tools/portable-updater/main.go`

- [ ] Give each update attempt an isolated helper directory and ready-marker path.
- [ ] Pass `UCLAW_PORTABLE_UPDATE_READY_PATH` only to the newly launched application.
- [ ] Write the marker atomically after the main window reaches `ready-to-show`, validating that the path is inside the portable runtime ready directory.
- [ ] Abort before replacement when the previous process tree cannot be stopped.
- [ ] Verify marker version and PID, wait for a one-second survival grace period, and treat timeout or early exit as startup failure.
- [ ] Stop the failed new process tree, restore the previous files with symmetric retries, and restart the previous application.
- [ ] Keep the backup when rollback is unsafe or incomplete.
- [ ] Run Go tests, TypeScript typecheck, and updater unit tests.

### Task 4: Migrate The Production Release Dependency Closure

**Files:**
- Create/modify: `scripts/windows-support/portable-release-utils.mjs`
- Create/modify: `scripts/windows-support/refresh-portable-release-metadata.mjs`
- Create/modify: `scripts/windows-support/refresh-portable-release-metadata.test.mjs`
- Create/modify: `scripts/windows-support/stage-production-release-candidate.mjs`
- Create/modify: `scripts/windows-support/run-packaged-regression.mjs`
- Create/modify: `scripts/windows-support/generate-regression-report.mjs`
- Create/modify: packaged regression helper files required by those entry points
- Modify: `scripts/build-usb-release.mjs`
- Modify: `package.json`

- [ ] Add tests for signed-ZIP metadata refresh and immutable candidate identity checks before implementation.
- [ ] Import only the Windows packaged regression dependency closure used by the production workflow.
- [ ] Adapt required-file and plugin assertions to the current branch's packaged contents.
- [ ] Preserve version `0.5.1` and current plugin/OpenClaw inventory.
- [ ] Verify that candidate version, commit, build ID, size, SHA-512, Full summary, and Live summary all refer to the same ZIP.

### Task 5: Add The Protected Production Workflow

**Files:**
- Create: `.github/workflows/uclaw-portable-production.yml`
- Create: `.github/UCLAW_PORTABLE_RELEASE.md`
- Create: `.github/actionlint.yaml`
- Modify: `.github/workflows/check.yml`
- Create: `scripts/windows-support/invoke-live-registration-gate.ps1`
- Create: `scripts/windows-support/publish-portable-release.ps1`
- Modify: `PACKAGED_REGRESSION.md`

- [ ] Require the latest clean `master` commit and an exact stable package version.
- [ ] Build, deep-sign, inspect, re-hash, and Full-test one immutable Windows USB ZIP.
- [ ] Require the protected interactive Windows runner and DPAPI credentials for fresh-account Live.
- [ ] Validate publication inputs before any production write.
- [ ] Upload immutable ZIP/JSON objects, transactionally update `claw_x_releases`, verify the public feed, and restore the prior enabled rows when feed convergence fails.
- [ ] Create or verify the annotated tag and GitHub Release only after production publication succeeds.
- [ ] Never run the workflow, publish objects, alter production data, or create tags during local migration.

### Task 6: Verify The Complete Migration

**Files:**
- Test: `tools/portable-updater/main_test.go`
- Test: `scripts/windows-support/refresh-portable-release-metadata.test.mjs`
- Test: workflow and package scripts

- [ ] Run `go test ./...` for the updater.
- [ ] Cross-compile the updater for `windows/amd64`.
- [ ] Run release pipeline Node tests.
- [ ] Run `pnpm run typecheck:node` and focused update tests.
- [ ] Parse all changed JSON/YAML and run actionlint when available.
- [ ] Run dry-run/validation-only release checks that do not require credentials or production writes.
- [ ] Compare final capabilities against `b46420e3` and `ab9fdc3d` and report any environment-only validation still required on Windows CI.
- [ ] Confirm the pre-existing dirty files are unchanged by this migration.

