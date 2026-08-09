# Preserve OpenClaw Bundled Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve every skill bundled by OpenClaw while retiring UClaw's separately preinstalled `docx`, `pdf`, `pptx`, and `xlsx` skills without deleting user-owned copies.

**Architecture:** OpenClaw's package remains the source of truth for bundled skills. UClaw scans and displays the complete bundled directory, removes all build/startup allowlist pruning, and performs a one-way startup cleanup only for retired skill directories carrying a valid `.clawx-preinstalled.json` ownership marker.

**Tech Stack:** Electron, TypeScript, React/Zustand, Vitest, pnpm/zx packaging scripts.

---

### Task 1: Lock the desired behavior with failing tests

**Files:**
- Modify: `tests/unit/local-skill-service.test.ts`
- Modify: `tests/unit/skills-store-fetch-parallel.test.ts`
- Modify: `tests/unit/skill-config-bundled-defaults.test.ts`

- [ ] Change the local scan test so both `skill-creator` and an arbitrary bundled skill must be returned as `openclaw-bundled`.
- [ ] Add a store test where a locally scanned bundled skill receives its enabled state from Gateway status.
- [ ] Replace the trimming test with cleanup coverage: a correctly marked retired skill is removed with its config, while an unmarked same-name directory is retained.
- [ ] Run the three test files and confirm failures are caused by the current allowlist and missing cleanup API.

### Task 2: Preserve and expose all OpenClaw bundled skills

**Files:**
- Modify: `scripts/bundle-openclaw.mjs`
- Modify: `electron/main/index.ts`
- Modify: `electron/utils/skill-config.ts`
- Modify: `electron/services/skills/local-skill-service.ts`
- Modify: `src/stores/skills.ts`

- [ ] Remove build-time deletion of non-allowlisted OpenClaw skills.
- [ ] Remove startup deletion and stale-config pruning for OpenClaw bundled skills.
- [ ] Scan the complete OpenClaw bundled skills directory without an allowlist.
- [ ] Allow Gateway status to merge into every locally discovered bundled skill while retaining the existing rule that Gateway-only managed skills are not resurrected.
- [ ] Run the local service and store tests and confirm they pass.

### Task 3: Retire UClaw's four preinstalled document skills

**Files:**
- Delete: `resources/skills/preinstalled-manifest.json`
- Delete: `scripts/bundle-preinstalled-skills.mjs`
- Delete: `scripts/prepare-preinstalled-skills-dev.mjs`
- Modify: `package.json`
- Modify: `electron/utils/skill-config.ts`
- Modify: `electron/main/index.ts`

- [ ] Remove the development and packaging hooks that fetch or bundle the four external skills.
- [ ] Remove the generic preinstalled-skill installer now that its manifest is retired.
- [ ] Add `removeRetiredPreinstalledSkills()` that only deletes `docx`, `pdf`, `pptx`, or `xlsx` when the directory marker has `source: "clawx-preinstalled"` and the matching slug.
- [ ] Remove config entries only for directories actually removed; retain unmarked/user-owned directories and their configuration.
- [ ] Run the cleanup test and the complete skill-related unit test set.

### Task 4: Synchronize documentation and verify packaging behavior

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `README.ja-JP.md`
- Modify: `harness/specs/tasks/decouple-skills-page-from-gateway.md`

- [ ] Replace the old allowlist/preinstall documentation with the complete bundled-skill policy and safe retirement rule.
- [ ] Remove command descriptions claiming that preinstalled document skills are prepared or packaged.
- [ ] Run targeted Vitest tests, typecheck, harness validation, and changed-file lint.
- [ ] Restore the local OpenClaw dependency if startup previously trimmed it, run the OpenClaw bundle script, and verify the output contains more than `skill-creator` with no OpenClaw version change.
- [ ] Review `git diff` and confirm no unrelated user changes were modified. Do not commit or push.
