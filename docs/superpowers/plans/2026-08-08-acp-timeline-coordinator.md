# ACP Timeline Coordinator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ClawX the single deterministic owner of ACP timeline reduction and media delivery without changing OpenClaw 2026.6.10.

**Architecture:** Introduce a bounded, session-scoped coordinator that serializes timeline commits and retains monotonic media overlays per user Turn. ACP history builds a base snapshot; live events extend it in receive order; transcript and generated-media evidence update stable overlays without closing live text segments or replacing unrelated content.

**Tech Stack:** Electron, React 19, Zustand, TypeScript, ACP SDK, Vitest, Electron Playwright.

**Repository constraint:** Work in the current `feature/claw-0.5.1` workspace. Do not create a branch, modify OpenClaw, commit, push, or publish unless the user explicitly requests it.

---

### Task 1: Lock the reducer invariants

**Files:**
- Modify: `tests/unit/acp-reducer.test.ts`
- Modify: `tests/unit/acp-media-attachments.test.ts`
- Modify: `src/lib/acp/reducer.ts`
- Modify: `src/lib/acp/timeline-types.ts`

- [ ] Add a failing test proving `appendSyntheticAssistantMessage` and `upsertSyntheticTurnAttachments` do not close an open Assistant message segment.
- [ ] Add a failing test proving a full `agent_message` preserves an existing resolved image or attachment overlay while replacing only authoritative ACP content.
- [ ] Add a failing test proving fallback Assistant identities do not depend on `itemOrder.length` and remain stable around compatibility overlays.
- [ ] Run `pnpm exec vitest run tests/unit/acp-reducer.test.ts tests/unit/acp-media-attachments.test.ts` and verify each test fails for the intended old behavior.
- [ ] Add snapshot-local monotonic fallback counters and overlay-aware message replacement.
- [ ] Keep tool, thought, plan, and permission boundaries as the only operations that close a live text segment.
- [ ] Re-run the focused tests and keep all existing ordering behavior green.

### Task 2: Add the session timeline coordinator

**Files:**
- Create: `src/lib/acp/session-timeline-coordinator.ts`
- Create: `tests/unit/acp-session-timeline-coordinator.test.ts`

- [ ] Write failing tests for an active-session commit, inactive retained-session commit, generation mismatch rejection, monotonic revision, stable evidence upsert, and bounded LRU eviction.
- [ ] Verify RED because the coordinator module does not exist.
- [ ] Implement a pure coordinator with this narrow API:

```ts
type SessionTimelineIdentity = { sessionKey: string; generation: number };

type SessionTimelineRecord = SessionTimelineIdentity & {
  revision: number;
  timeline: AcpTimelineSnapshot;
  workspaceRoot: string | null;
  cwd: string | null;
  retained: boolean;
};

class AcpSessionTimelineCoordinator {
  read(identity: SessionTimelineIdentity): SessionTimelineRecord | undefined;
  replace(record: Omit<SessionTimelineRecord, 'revision'>): SessionTimelineRecord;
  update(identity: SessionTimelineIdentity, reduce: (timeline: AcpTimelineSnapshot) => AcpTimelineSnapshot): SessionTimelineRecord | undefined;
  retain(identity: SessionTimelineIdentity): void;
  release(identity: SessionTimelineIdentity): void;
  removeSession(sessionKey: string): void;
}
```

- [ ] Store no transcript bodies outside the existing timeline and cap unretained records to a small fixed LRU.
- [ ] Verify all coordinator tests pass.

### Task 3: Make transcript supplements per Turn and serial

**Files:**
- Modify: `tests/unit/acp-chat-store.test.ts`
- Modify: `src/stores/acp-chat-session.ts`
- Modify: `src/lib/acp/transcript-supplement.ts`

- [ ] Replace the old invalidation matrix test with failing tests proving a first Turn supplement survives a second prompt and session navigation.
- [ ] Add a failing test where the first attachment resolution exceeds 1.5 seconds and a retry cannot invalidate the successful older attempt.
- [ ] Add a failing test proving two sessions can retain independent supplement operations.
- [ ] Replace the global `activeTranscriptSupplement` with a registry keyed by `sessionKey + generation + liveUserMessageId` and a separate historical-load key.
- [ ] Store the operation's own `cwd` and timeline snapshot provider instead of reading the currently active session.
- [ ] Run only one supplement attempt at a time; schedule the next retry after the current attempt settles.
- [ ] A new prompt may replace only the same Turn operation. User cancellation stops only the cancelled Turn; navigation does not cancel accepted media delivery.
- [ ] Verify focused Store tests pass.

### Task 4: Route every asynchronous media commit through the coordinator

**Files:**
- Modify: `tests/unit/acp-chat-store.test.ts`
- Modify: `tests/unit/acp-background-media-projections.test.ts`
- Modify: `src/stores/acp-chat-session.ts`
- Modify: `src/lib/acp/background-media-projections.ts`
- Modify: `src/lib/acp/attachments.ts`

- [ ] Add failing tests for attachment resolution, transcript MEDIA, image thumbnail hydration, and video completion while their owning session is inactive.
- [ ] Add a failing test proving the result updates the original session and never the currently visible session.
- [ ] Register the active timeline before starting asynchronous resolution and retain its coordinator record until every accepted delivery is terminal.
- [ ] Replace active-session-only `setState` callbacks with coordinator updates followed by publication only when that identity is active.
- [ ] Reapply retained compatibility overlays after history base replay using evidence ids and opaque media identities.
- [ ] Release retained records only after results have been consumed by an active load or safely represented by transcript evidence.
- [ ] Verify no session switch is needed for the active conversation to show completed media.

### Task 5: Enforce monotonic attachment terminal states

**Files:**
- Modify: `tests/unit/acp-media-attachments.test.ts`
- Modify: `tests/unit/acp-chat-store.test.ts`
- Modify: `src/lib/acp/attachments.ts`
- Modify: `src/stores/acp-chat-session.ts`

- [ ] Add failing tests for `pending -> available`, `pending -> unavailable -> available`, and rejection of `available -> pending/unavailable` regressions.
- [ ] Add a failing test proving exhausted remote-media resolution retains an approved URL fallback or explicit unavailable card.
- [ ] Implement monotonic attachment merge rules and bounded serial retry state.
- [ ] Stop retries only when all accepted candidates reach visible terminal states or the existing generation deadline expires.
- [ ] Keep internal provider errors out of compatibility cards; the model's native reply remains authoritative for explanatory text.

### Task 6: Make history reconciliation base-plus-overlay only

**Files:**
- Modify: `tests/unit/acp-chat-store.test.ts`
- Modify: `src/stores/acp-chat-session.ts`
- Modify: `src/lib/acp/background-media-projections.ts`
- Modify: `harness/specs/rules/acp-chat-state-and-history.md`
- Modify: `harness/specs/rules/acp-compatibility-content-safety.md`
- Modify: `harness/reference/acp-chat.md`
- Modify: `harness/reference/acp-generated-media-and-diagnostics.md`

- [ ] Add failing tests showing a history load cannot append an ordinary old message after a live Turn or reorder existing live items.
- [ ] Build history into a fresh base snapshot, then idempotently reapply only bounded media overlays.
- [ ] Restrict transcript reads after prompt settlement to the exact user Turn and accepted evidence types.
- [ ] Remove superseded whole-timeline compatibility fallbacks and document the resulting authority model.

### Task 7: Bound rendering work and preserve visible streaming

**Files:**
- Modify: `tests/unit/acp-chat-store.test.ts`
- Modify: `src/lib/acp/session-timeline-coordinator.ts`
- Modify: `src/stores/acp-chat-session.ts`

- [ ] Add fake-timer tests proving adjacent text chunks flush within 32ms, while a following tool boundary flushes pending text immediately and preserves receive order.
- [ ] Batch only adjacent live text chunks for the same session/message segment; never batch tool, completion, permission, media, or terminal events behind text.
- [ ] Bound retained inactive coordinator records and release large settled timelines promptly.
- [ ] Keep history pagination and existing Chat virtualization behavior unchanged unless measurement proves an additional change is required.

### Task 8: End-to-end and regression verification

**Files:**
- Modify: `tests/e2e/chat-acp-attachments.spec.ts`
- Modify: `tests/e2e/chat-acp-inline-timeline.spec.ts`
- Review: `README.md`
- Review: `README.zh-CN.md`
- Review: `README.ja-JP.md`

- [ ] Add Electron scenarios for `text -> tool -> text -> delayed image`, delayed video, ordinary file MEDIA, switching away during resolution, and returning without duplication.
- [ ] Run the focused unit suite from the task spec.
- [ ] Run `pnpm run typecheck`, `pnpm run build:vite`, `pnpm run comms:replay`, and `pnpm run comms:compare`.
- [ ] Run `pnpm harness validate --spec harness/specs/tasks/stabilize-acp-timeline-coordinator.md` and `pnpm harness run --spec harness/specs/tasks/stabilize-acp-timeline-coordinator.md`.
- [ ] Run the two Electron Playwright specs on the current development build.
- [ ] Inspect the running app at desktop and narrow widths; verify continuous text, stable order, immediate media appearance, and bounded memory during repeated session switching.
- [ ] Confirm `package.json` still pins `openclaw` to `2026.6.10` and no OpenClaw source or bundle patch changed.
- [ ] Run `git diff --check` and audit the final diff for unrelated changes.

## Rollback

The coordinator is Renderer-only and stores no migration data. Reverting its Store integration and reducer additions restores the previous in-memory behavior; OpenClaw transcripts, generated files, provider configuration, and portable runtime data remain unchanged.
