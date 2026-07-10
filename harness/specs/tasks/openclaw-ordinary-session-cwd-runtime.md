---
id: openclaw-ordinary-session-cwd-runtime
title: Add per-session project directories across ClawX and OpenClaw
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Let each ordinary chat session select, persist, restore, and safely execute inside its own project directory, while keeping renderer state, OpenClaw session RPCs, composite artifact output, and restart recovery on one cwd contract without changing subagent spawn lineage semantics.
touchedAreas:
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - electron/utils/composite-run-coordinator.ts
  - electron/utils/local-artifact-runtime.ts
  - shared/composite-run.ts
  - scripts/openclaw-session-cwd-runtime-patch.mjs
  - scripts/patch-browser-hint.mjs
  - scripts/bundle-openclaw.mjs
  - package.json
  - src/components/file-preview/ArtifactPanel.tsx
  - src/components/file-preview/WorkspaceBrowserBody.tsx
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/ja/chat.json
  - src/i18n/locales/ru/chat.json
  - src/i18n/locales/zh/chat.json
  - src/lib/api-client.ts
  - src/pages/Chat/ChatToolbar.tsx
  - src/pages/Chat/index.tsx
  - src/stores/chat.ts
  - src/stores/chat/session-selection.ts
  - src/stores/chat/types.ts
  - harness/specs/tasks/openclaw-ordinary-session-cwd-runtime.md
expectedUserBehavior:
  - Every ordinary chat session can select its own project folder from the chat toolbar without changing another session or the Agent's default workspace.
  - A new local session persists its first project directory through sessions.create; an existing session updates it through sessions.patch; resetting it passes cwd as null and restores the Agent workspace fallback.
  - sessions.list returns the persisted cwd so the selected session, toolbar, project browser, and execution context restore after an application or Gateway restart.
  - Sending waits for an in-flight cwd create or patch for the target session, so a message cannot start in the previous directory; a failed mutation prevents that send.
  - Project-folder selection and reset are disabled while the current session is sending or reports an active run, while project browsing remains available.
  - Agent and tool execution use the session cwd before falling back to immutable spawnedCwd lineage metadata.
  - Explicit command-level cwd remains higher priority than either persisted session field.
  - Composite local file artifacts such as presentations, spreadsheets, mini programs, and copywriting are written under <session cwd>/outputs; sessions without an override keep the existing OpenClaw workspace output location.
  - A composite run keeps the cwd captured when it starts, and Main-process recovery continues unfinished local work in that same outputs directory after restart.
  - Development startup and packaged runtime bundling apply the same patch automatically.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - comms-regression
  - docs-sync
requiredTests:
  - node --check scripts/openclaw-session-cwd-runtime-patch.mjs
  - node scripts/patch-browser-hint.mjs
  - pnpm exec vitest run tests/unit/api-client.test.ts tests/unit/chat-load-sessions-startup.test.ts tests/unit/chat-session-selection.test.ts
  - pnpm exec vitest run tests/unit/workspace-browser-body.test.tsx tests/unit/local-artifact-runtime.test.ts
  - pnpm run typecheck
acceptance:
  - Renderer pages and components use the typed selectDirectory api-client wrapper and chat-store actions; they do not add direct ipcRenderer or Gateway HTTP calls.
  - ChatSession and chat-store state carry cwd per canonical session key, and the toolbar resolves the visible project directory as session cwd first, then the current Agent workspace.
  - Selecting or clearing a project directory updates the store optimistically, persists the change through the Gateway, applies the returned effective cwd, and restores the prior session rows if persistence fails.
  - A pending local session uses sessions.create with its canonical key, agentId, and cwd; a registered session uses sessions.patch; cwd null clears the override without mutating the Agent workspace.
  - sessions.list trims and hydrates cwd into each renderer session row, preserves a newer optimistic local cwd during a concurrent refresh, and restores the persisted current session rather than assigning another session's directory.
  - sendMessage awaits the target session's pending cwd mutation before busy-run queuing, planning, or Gateway/composite dispatch; mutation failure surfaces an error and does not send in a stale directory.
  - The toolbar disables both choose-folder and reset-to-Agent-workspace actions when sending is true or the current session reports hasActiveRun, running, or active; the lock applies only to changing cwd, not to opening the project browser.
  - ArtifactPanel and WorkspaceBrowserBody browse the current session cwd when present, fall back to the Agent workspace otherwise, and reset file selection when the effective root changes.
  - The runtime protocol schema accepts an optional cwd when creating an ordinary session.
  - The runtime protocol schema accepts cwd as a non-empty string or null in sessions.patch.
  - Patch projection trims and stores non-empty cwd values and deletes cwd on null.
  - Session creation reuses the same patch projection, and session listing exposes the stored cwd.
  - spawnedCwd remains immutable and restricted to subagent or ACP lineage.
  - Gateway agent, direct agent command, reply agent, and session compaction resolve cwd before spawnedCwd.
  - Runtime cwd precedence is explicit command cwd, then persisted ordinary-session cwd, then immutable spawnedCwd lineage metadata.
  - CompositeRunStartRequest and its durable record carry the session cwd; Main rejects a supplied directory that is non-absolute, nonexistent, or inaccessible before creating the run.
  - Composite local planning passes path.join(cwd, 'outputs') as outputDir, and the local artifact runtime honors it for PPTX, XLSX, HTML, and Markdown while retaining the existing default output directory when cwd is absent.
  - Composite snapshots and journals preserve cwd and planned outputDir so restart recovery requeues safe local tasks in the original session project, resumes known media monitoring, and does not silently retarget an in-flight run to a later session cwd.
  - The patch is idempotent and fails clearly when a required bundled OpenClaw anchor drifts.
  - pnpm dev reapplies the installed runtime patch before Vite starts.
  - bundle-openclaw applies the same patch to the copied packaged runtime.
docs:
  required: true
---

## Scope

This task owns one end-to-end project-directory contract. The renderer selects
and displays a cwd per ordinary session, the chat store persists it through
`sessions.create` / `sessions.patch` and reloads it through `sessions.list`, and
the generated OpenClaw runtime applies it to agent and tool execution. The
runtime patch is produced only through ClawX-owned build scripts; `node_modules`
is never the source of truth.

For composite work, the cwd is captured when the run is created and stored in
the durable Main-process record. Local file tasks write to `<cwd>/outputs`.
Without a session override, both ordinary execution and local artifact output
retain their existing Agent/OpenClaw workspace fallbacks.

## Ordering And Recovery

A cwd mutation and a send for the same session are ordered: the send waits for
the mutation to settle before any planner or execution path starts. Once a run
is active, the UI cannot change or clear that session's cwd. This makes the cwd
stored in a composite snapshot stable for retries and restart recovery.

Application restart recovery has two layers: `sessions.list` restores the cwd
for future sends and the project browser, while the composite run journal keeps
the captured cwd for already-started work. A later session-directory change
must not retarget a recovered run.

## Compatibility

The mutable `cwd` field is independent from `spawnedCwd`. Existing subagent and
ACP sessions continue to use `spawnedCwd` when no explicit session cwd exists.
Explicit command-level cwd remains the highest-priority override.
