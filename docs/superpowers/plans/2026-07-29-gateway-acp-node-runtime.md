# Gateway And ACP Node Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent packaged Gateway child processes from re-entering ClawX and make development ACP launches use Electron's controlled Node runtime.

**Architecture:** Launch OpenClaw Gateway through a generated CommonJS wrapper that patches Electron-backed child processes before importing the real entry. Resolve ACP's development fork executable directly to Electron with `ELECTRON_RUN_AS_NODE=1`; preserve packaged platform behavior.

**Tech Stack:** Electron, TypeScript, Node.js child processes, Vitest

---

### Task 1: Gateway wrapper regression

**Files:**
- Modify: `tests/unit/gateway-process-launcher.test.ts`
- Modify: `electron/gateway/process-launcher.ts`

- [ ] Add tests asserting that the generated wrapper contains the child-process Node-mode patch and that `launchGatewayProcess` forks the wrapper with `CLAWX_OPENCLAW_ENTRY` pointing at the real entry.
- [ ] Run `pnpm exec vitest run tests/unit/gateway-process-launcher.test.ts` and confirm the new assertions fail because wrapper exports and wrapper launch are absent.
- [ ] Extract one shared child-process patch source, generate the Gateway entry wrapper, add the real entry to the environment, and fork the wrapper.
- [ ] Re-run `pnpm exec vitest run tests/unit/gateway-process-launcher.test.ts` and confirm it passes.

### Task 2: ACP controlled development runtime

**Files:**
- Modify: `tests/unit/openclaw-cli.test.ts`
- Modify: `electron/utils/openclaw-cli.ts`

- [ ] Change the development embedded-fork test to require `process.execPath` and `ELECTRON_RUN_AS_NODE=1` even when an older `node.exe` exists on PATH.
- [ ] Run `pnpm exec vitest run tests/unit/openclaw-cli.test.ts` and confirm the test fails because current code selects PATH Node.
- [ ] Remove PATH Node selection from embedded ACP launches and select Electron Node mode in development.
- [ ] Re-run `pnpm exec vitest run tests/unit/openclaw-cli.test.ts` and confirm it passes while packaged Windows and macOS cases remain green.

### Task 3: Verification

**Files:**
- Verify only the four implementation/test files and the two requested design/plan documents.

- [ ] Run both targeted Vitest files together.
- [ ] Run `pnpm run typecheck`.
- [ ] Inspect `git diff --check`, `git status --short`, and the scoped diff to ensure unrelated existing changes were not modified.
