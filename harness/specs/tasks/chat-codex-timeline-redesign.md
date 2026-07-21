---
id: chat-codex-timeline-redesign
title: Rebuild Chat as a Codex-style event-driven timeline
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Implement the approved ClawX Codex-style information-flow design by normalizing OpenClaw evidence into canonical events, reducing live and historical events through one authoritative turn state machine, and projecting stable timeline items into a virtualized renderer without changing OpenClaw orchestration ownership or existing chat, media, task, artifact, verification, and approval capabilities.
touchedAreas:
  - package.json
  - pnpm-lock.yaml
  - harness/specs/tasks/chat-codex-timeline-redesign.md
  - shared/chat-runtime-events.ts
  - shared/chat-send-outbox.ts
  - shared/conversation-events.ts
  - shared/conversation-rollout.ts
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - shared/chat-timeline/**
  - electron/preload/index.ts
  - electron/main/index.ts
  - electron/main/ipc-handlers.ts
  - electron/api/routes/gateway.ts
  - electron/services/chat-send-outbox.ts
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/services/agent-runtime/host-task-service.ts
  - electron/services/computer/approval-broker.ts
  - electron/services/computer/desktop-run-coordinator.ts
  - electron/services/computer/types.ts
  - electron/utils/junfeiai-distribution.ts
  - electron/utils/openclaw-auth.ts
  - electron/gateway/chat-runtime-events.ts
  - electron/gateway/event-dispatch.ts
  - electron/gateway/manager.ts
  - electron/gateway/task-ledger-monitor.ts
  - src/lib/host-events.ts
  - src/lib/approval-actions.ts
  - src/lib/runtime-display-sanitizer.ts
  - src/App.tsx
  - src/components/client/ClientConfigInitializer.tsx
  - src/components/desktop/DesktopApprovalOverlay.tsx
  - src/stores/client-config.ts
  - src/stores/chat.ts
  - src/stores/chat/**
  - src/stores/conversation/**
  - src/stores/gateway.ts
  - src/types/electron.d.ts
  - src/pages/Chat/index.tsx
  - src/pages/Chat/TimelineChatPage.tsx
  - src/pages/Chat/ChatMessage.tsx
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/ChatToolbar.tsx
  - src/pages/Chat/ExecutionGraphCard.tsx
  - src/pages/Chat/RunProgressCard.tsx
  - src/pages/Chat/ReasoningPanel.tsx
  - src/pages/Chat/image-generation-status.ts
  - src/pages/Chat/runtime-run-merge.ts
  - src/pages/Chat/runtime-task-visualization.ts
  - src/pages/Chat/task-visualization.ts
  - src/pages/Chat/timeline/**
  - src/pages/Agents/index.tsx
  - src/pages/Channels/index.tsx
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/zh/chat.json
  - src/i18n/locales/ja/chat.json
  - src/i18n/locales/ru/chat.json
  - scripts/chat-timeline-*.test.ts
  - scripts/collect-chat-timeline-performance-evidence.mjs
  - scripts/fixtures/conversation-timeline-canonical-events.json
  - scripts/fixtures/conversation-timeline-canonical-events.golden.json
  - scripts/chat-send-intent.test.ts
  - scripts/chat-send-outbox.test.ts
  - scripts/chat-runtime-control.test.ts
  - scripts/chat-abort-detached-tasks.test.ts
  - scripts/chat-final-runtime-replay.test.ts
  - scripts/junfeiai-provider-seed-stability.test.ts
  - scripts/junfeiai-distribution-defaults.test.ts
  - scripts/openclaw-compaction-session-state-patch.mjs
  - scripts/openclaw-compaction-session-state-patch.test.mjs
  - scripts/uclaw-artifact-guard-runtime.test.mjs
  - scripts/uclaw-presentation-history-compact.test.mjs
  - scripts/gateway-task-ledger-monitor.test.ts
  - scripts/runtime-display-sanitizer.test.ts
  - scripts/runtime-task-graph.test.ts
  - scripts/timeline-media-ownership.test.ts
  - scripts/conversation-timeline-*.test.ts
  - scripts/conversation-control-selectors.test.ts
  - scripts/conversation-shadow-compare.test.ts
  - scripts/desktop-approval-replay.test.ts
  - scripts/host-task-lifecycle.test.ts
  - scripts/host-task-rehydration.test.ts
  - scripts/comms/**
  - harness/evidence/chat-codex-timeline-performance.json
  - harness/evidence/chat-codex-timeline-performance.md
  - resources/openclaw-plugins/uclaw-desktop-control/index.mjs
  - resources/openclaw-plugins/uclaw-artifact-guard/**
  - resources/openclaw-plugins/uclaw-task-bridge/**
  - tests/e2e/chat-host-task-rehydration.spec.ts
  - tests/e2e/chat-approval-actions.spec.ts
  - tests/e2e/desktop-approval-overlay.spec.ts
  - tests/e2e/chat-timeline-rollout.spec.ts
  - tests/e2e/chat-timeline.spec.ts
  - tests/e2e/chat-timeline-product-matrix.spec.ts
  - tests/e2e/chat-task-structured-runtime.spec.ts
  - tests/e2e/chat-task-visualizer.spec.ts
  - tests/e2e/fixtures/electron.ts
  - tests/e2e/chat-assistant-markdown-plain.spec.ts
  - tests/e2e/chat-code-block-wrap.spec.ts
  - tests/e2e/chat-question-directory.spec.ts
  - tests/e2e/chat-reasoning-panel.spec.ts
  - tests/e2e/chat-scroll-pin-bottom.spec.ts
  - tests/e2e/chat-scroll-to-latest.spec.ts
  - tests/e2e/chat-table-header-light.spec.ts
  - tests/e2e/chat-run-state-events.spec.ts
  - tests/e2e/native-agent-media-routing.spec.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - README.ru-RU.md
  - harness/specs/tasks/uclaw-desktop-and-blender-runtime.md
expectedUserBehavior:
  - Each user request owns one stable turn whose commentary, tool activity, artifacts, verification, approvals, final answer, and terminal status remain correctly attributed during streaming, session switches, refresh, and restart.
  - The default information flow is a calm linear timeline: user message, concise commentary and grouped tool summaries, independently visible artifacts or approvals, and one final answer.
  - Recovered internal tool/task failures and passed verification stay out of the default information flow; a true terminal failure renders at most one friendly outcome while raw errors and verification evidence remain in execution details.
  - Repeated low-level events for one tool call do not create repeated cards; users can expand a tool group for useful details without seeing raw transport payloads.
  - The full execution graph is no longer rendered by default in the main information flow; an accessible execution-details action remains available, while raw event and correlation diagnostics remain developer-only.
  - Streaming updates do not pull a reader back to the bottom after the reader scrolls upward, and expanding details preserves the current viewport anchor.
  - Long conversations remain responsive because completed turns keep stable render identity and offscreen turns are virtualized.
  - Live delivery owns the visible order. Once a Turn or Timeline item is shown, its position is permanent. History reload updates matching identities in place and may append a genuinely missing restored Turn, but it never inserts a new assistant narrative row into an existing live Turn. Explicit backwards pagination may prepend older Turns while preserving the relative order and pixel anchor of every visible Turn.
  - Ordinary chat, image and video generation, planner/task flow, execution queue, artifacts, verification, subagents, approvals, cancellation, failures, and restored sessions retain their existing product behavior.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - host-events-fallback-policy
  - gateway-readiness-policy
  - capability-owner-resolution
  - active-config-guards
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/chat-codex-timeline-redesign.md --since origin/feature/uclaw-general-agent-orchestration
  - pnpm harness run --spec harness/specs/tasks/chat-codex-timeline-redesign.md --since origin/feature/uclaw-general-agent-orchestration --dry-run
  - pnpm exec tsx --test scripts/conversation-timeline-replay.test.ts
  - pnpm exec tsx --test scripts/desktop-approval-replay.test.ts
  - pnpm exec tsx --test scripts/conversation-timeline-golden.test.ts
  - pnpm exec tsx --test scripts/conversation-control-selectors.test.ts
  - pnpm exec tsx --test scripts/chat-send-intent.test.ts
  - pnpm exec tsx --test scripts/chat-send-outbox.test.ts
  - pnpm exec tsx --test scripts/chat-runtime-control.test.ts
  - pnpm exec tsx --test scripts/chat-abort-detached-tasks.test.ts
  - pnpm exec tsx --test scripts/chat-final-runtime-replay.test.ts
  - pnpm exec tsx --test scripts/junfeiai-provider-seed-stability.test.ts
  - pnpm exec tsx --test scripts/junfeiai-distribution-defaults.test.ts
  - node --test scripts/uclaw-presentation-history-compact.test.mjs
  - node --test scripts/uclaw-artifact-guard-runtime.test.mjs
  - node --test scripts/openclaw-compaction-session-state-patch.test.mjs
  - pnpm exec tsx --test scripts/chat-timeline-performance.test.ts
  - pnpm exec tsx --test scripts/gateway-task-ledger-monitor.test.ts
  - pnpm exec tsx --test scripts/host-task-lifecycle.test.ts
  - pnpm exec tsx --test scripts/host-task-rehydration.test.ts
  - pnpm exec tsx --test scripts/runtime-display-sanitizer.test.ts
  - pnpm exec tsx --test scripts/runtime-task-graph.test.ts
  - pnpm exec tsx --test scripts/timeline-media-ownership.test.ts
  - node scripts/collect-chat-timeline-performance-evidence.mjs --verify
  - pnpm run typecheck
  - pnpm run lint:check
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-host-task-rehydration.spec.ts tests/e2e/chat-approval-actions.spec.ts tests/e2e/chat-timeline.spec.ts tests/e2e/chat-timeline-product-matrix.spec.ts tests/e2e/chat-task-structured-runtime.spec.ts tests/e2e/chat-task-visualizer.spec.ts tests/e2e/chat-scroll-to-latest.spec.ts tests/e2e/chat-scroll-pin-bottom.spec.ts tests/e2e/chat-question-directory.spec.ts tests/e2e/chat-assistant-markdown-plain.spec.ts tests/e2e/chat-code-block-wrap.spec.ts tests/e2e/chat-reasoning-panel.spec.ts tests/e2e/chat-table-header-light.spec.ts tests/e2e/chat-run-state-events.spec.ts tests/e2e/native-agent-media-routing.spec.ts --workers=1
  - pnpm run comms:replay
  - pnpm run comms:compare
  - Electron UI verification for long-history streaming, user-scrolled anchoring, expanded tool details, execution details, media, subagents, approvals, abort, error, and restart recovery
acceptance:
  - Gateway and history adapters emit one versioned canonical event contract with stable event, session, turn, run, task, tool-call, and item identifiers where the source supplies them.
  - Every canonical event records whether it is native, derived, history-replayed, or synthetic; derived and synthetic facts never silently override contradictory native terminal evidence.
  - Live Gateway delivery and transcript/task-ledger replay enter the same turn reducer and timeline projector instead of maintaining separate renderer semantics.
  - The turn reducer is the sole owner of queued, running, waiting-approval, completed, error, and aborted transitions; React components do not infer whether a turn is open by rescanning message arrays.
  - Event ordering, duplicate suppression, terminal-state precedence, and late-event handling are deterministic, session-scoped, idempotent, and memory-bounded.
  - A visible session does not automatically replay `chat.history` on final, error, abort, completion wake, or backend-idle settlement. Initial entry, explicit session switch, manual refresh, and Gateway reconnect remain the recovery boundaries.
  - Bundled OpenClaw plugins do not register `before_agent_finalize` for ordinary UI delivery because OpenClaw buffers all assistant deltas while that hook exists. Terminal artifact observation uses `agent_end`; tool-result artifact evidence and the canonical Turn gates remain authoritative.
  - A terminal final answer and terminal run lifecycle remain distinct facts: the answer may render before completion, but only authoritative lifecycle or backend-idle evidence closes the turn.
  - Timeline projection produces stable user-message, commentary, thinking, tool-group, approval, subtask, artifact, verification, final-answer, and error items without duplicating one fact across progress, graph, reasoning, and chat cards.
  - Adjacent compatible tool calls are grouped by stable ownership and chronology; raw command output, arguments, results, duration, and errors remain lazy execution details rather than default top-level items, including after live/history reconciliation.
  - The main timeline shows no default expanded execution graph; normal users retain an execution-details action and developer diagnostics retain raw events, IDs, provenance, ordering, and the complete graph.
  - Streaming assistant deltas are coalesced to at most one visible-item store commit per animation frame, and a delta does not rebuild or rerender completed turns.
  - A 500-message replay keeps the mounted turn/item DOM bounded by the viewport and overscan rather than total history size, while keyboard navigation, selection, expansion, and search targets remain usable.
  - During the agreed streaming performance fixture, the main thread has no sustained long-task pattern, targets 60 FPS on the reference machine, and remains at least 30 FPS on the agreed low-spec profile.
  - Auto-follow occurs only while the viewport is bottom-anchored; user scroll-up disables follow, a new-content affordance is shown, and returning to bottom re-enables follow without a jump.
  - Feature-flagged dual projection can compare legacy and canonical results without rendering both; rollout can restore the legacy renderer without changing Gateway or transcript data.
  - The legacy projection is removed only after replay parity, E2E coverage, performance thresholds, and product compatibility gates pass; no indefinite second source of truth remains afterward.
  - Image/video modes still provide current-turn defaults only, media artifacts remain playable and durable, and media task terminal evidence closes pending UI after live delivery and history replay.
  - Planner steps, execution-queue work, native tasks, and subagents preserve parent/child ownership without interleaving separate user turns or sessions.
  - Approval requests remain visible and actionable until authoritative approval, rejection, cancellation, expiry, or an error/abort that invalidates the request. Successful model Run completion does not cancel a Main-owned pending approval, and replay never reopens a terminal approval.
  - Artifact and verification items come from structured evidence, retain availability/error state, may appear before the final answer, and do not treat path-like prose as produced output.
  - Abort, error, disconnect, stale history, late tool results, duplicate finals, missing sequence numbers, and backend-idle recovery converge to one deterministic visible state.
  - Long tool loops run OpenClaw's mid-turn context precheck before the next model call, rotate the active transcript after successful compaction, and use the endpoint-owned transcript byte threshold without dropping adjacent user compaction settings.
  - Artifact-guard prompt maintenance treats OpenClaw history as immutable, replaces only changed message branches, preserves current-turn tool arguments, and never fails the whole prompt-build hook because a historical tool call is frozen.
  - A recovered overflow attempt cannot leave a stale deferred lifecycle error after a later successful finishing event; genuine compaction failure remains terminal and diagnostic.
  - Renderer pages and components add no direct Gateway HTTP, direct IPC, transport switching, polling ownership, semantic planner, or completion inference.
  - All new user-facing strings use the four chat locales and all timeline UI follows existing design tokens and accessibility behavior.
  - README language variants document the changed default process display and the retained execution-details/diagnostic path before legacy removal.
docs:
  required: true
---

## Approved Design Baseline

This task implements the approved `ClawX Codex-style conversation information-flow redesign` without changing its architecture during implementation. The implementation sequence may be split into small reviews, but the target state and invariants in this spec remain binding. Any required deviation must be documented with its cause, user impact, compatibility impact, migration impact, and rollback effect, then explicitly approved before code follows the deviation.

The defining pipeline is:

```text
OpenClaw / Gateway / task-ledger / transcript evidence
                         |
                         v
               Canonical event adapters
                         |
                         v
             Session-scoped turn reducer
                         |
                         v
              Timeline item projection
                         |
                         v
       Virtualized Codex-style information flow
```

OpenClaw remains the semantic and orchestration owner. ClawX Main normalizes runtime facts. The renderer reduces and projects those facts; it does not create a second planner, authorize side effects, or reinterpret model prose as completion evidence.

## Scope

- Replace message-array and card-specific live inference with a canonical-event-to-turn pipeline.
- Make live Gateway delivery, task-ledger updates, and historical transcript replay converge through the same reducer.
- Replace the default process-card/graph-heavy information flow with stable linear timeline items.
- Preserve expandable tool details and an explicit execution-details entry point.
- Bound streaming update work, completed-turn renders, mounted DOM, Markdown work, and scroll mutations.
- Migrate behind comparison and renderer feature flags so each stage has a usable rollback.
- Preserve all existing product routes: ordinary chat, image, video, planner/task flow, queueing, artifacts, verification, subagents, approvals, cancellation, errors, session switching, history refresh, and restart restoration.

## Out Of Scope

- Replacing the OpenClaw Agent loop, planner, Task Flow, task ledger, session store, subagent scheduler, or tool execution model.
- Removing image mode, video mode, planner routing, execution details, artifact delivery, or verification gates.
- Exposing hidden chain-of-thought. A `thinking` item may project only content OpenClaw explicitly marks as user-displayable reasoning/thinking evidence.
- Treating synthetic or derived evidence as equivalent to native OpenClaw evidence.
- A permanent new/legacy dual state model. Dual projection is a temporary migration instrument only.
- Rewriting unrelated Chat styling, settings, transport, providers, plugins, or artifact generators.

## Canonical Event Contract

Every adapter emits a versioned, serializable event envelope. Payload types remain discriminated and must not be reconstructed from display strings.

```ts
type CanonicalEventSource =
  | 'openclaw-chat'
  | 'openclaw-runtime'
  | 'task-ledger'
  | 'history'
  | 'plugin'
  | 'host'
  | 'derived'
  | 'synthetic'

type CanonicalAuthority = 'authoritative' | 'corroborating' | 'inferred'

type CanonicalEventEnvelope<TKind, TPayload> = {
  version: 1
  eventId: string
  type: TKind
  source: CanonicalEventSource
  authority: CanonicalAuthority
  sessionKey: string
  turnId?: string
  runId?: string
  rootRunId?: string
  messageId?: string
  taskId?: string
  parentTaskId?: string
  toolCallId?: string
  seq?: number
  occurredAt: number
  receivedAt: number
  replayed: boolean
  data: TPayload
}
```

`turnId` is optional only at pre-correlation ingress. The reducer must resolve it through explicit identity, bounded aliases, or deterministic local ownership before projection; unresolved events are quarantined rather than assigned a fabricated Turn. Event families with an upstream item identity retain it in their structured `data`, while lifecycle and liveness events do not invent a visual item. This is the single canonical object checked by the fixture/golden tests.

Supported discriminants cover the evidence already available to ClawX:

- `lifecycle`: queued/start/completed/error/aborted and stop reason.
- `assistant`: displayable text delta, replace, phase, media, and final-answer boundary.
- `thinking`: explicitly displayable reasoning delta or replacement.
- `tool`: call start/update/result/error, name, arguments, partial result, duration, and stable call identity.
- `plan` and `step`: native plan/step identity, status, hierarchy, and result.
- `progress`: displayable commentary/action/status that is not duplicated from another canonical fact.
- `artifact`: stable artifact identity, kind, path/URL, availability, media metadata, owning task/tool, and error state.
- `verification`: stable check identity, kind, status, evidence reference, and owning artifact/task/tool.
- `command_output` and `patch`: structured command/diff details attached to a tool item rather than independent default cards.
- `approval`: request, decision, expiry/cancellation, reason, owning run/task/tool, and stable approval identity.
- `task`: native task/subagent lifecycle, parent relation, progress, result, and terminal state.

### Identity, Ordering, And Authority

- `sessionKey + turnId` is the primary conversation ownership boundary. A run ID alone never joins events across sessions.
- Adapters preserve native `runId`, `taskId`, `parentTaskId`, and `toolCallId`. A deterministic synthetic ID is allowed only when an upstream identifier is absent and must remain source-labelled.
- `eventId` drives idempotence. When old history lacks one, its deterministic replay ID is derived from immutable transcript location and structured identity, not visible text alone.
- Native sequence numbers order events within their native stream. Missing or incomparable sequences use occurred time, adapter priority, transcript position, and event ID as deterministic tie-breakers.
- Native terminal task/tool/run evidence outranks derived, history, and synthetic guesses. History may fill a missing fact but may not downgrade a terminal native fact already observed.
- Terminal states are monotonic except when a later, more authoritative source corrects a lower-authority synthetic fallback. That correction must be observable in diagnostics.
- Deduplication indexes are bounded per session/turn. Completed-turn raw event retention follows an explicit cap or compaction policy while preserving projected output and diagnostic references.

## Turn Reducer

The reducer owns `ConversationTurn` and is independent of React:

```ts
type ConversationTurn = {
  id: string
  sessionKey: string
  rootRunId?: string
  runIds: string[]
  status: 'queued' | 'running' | 'waiting_approval'
    | 'completed' | 'error' | 'aborted'
  itemOrder: string[]
  itemsById: Record<string, TimelineItem>
  activeItemIds: string[]
  terminalEvidence?: CanonicalEventRef
}
```

Reducer rules:

1. A user message or authoritative run start creates one turn and binds subsequent owned events to it.
2. A tool round, subtask, or assistant final never creates a second user turn.
3. An answer may become visible while the turn remains `running`; only authoritative run lifecycle or backend-idle settlement closes it.
4. A pending actionable approval places the turn in `waiting_approval`. Tool or task progress after approval returns it to `running`; a terminal decision/run state closes it appropriately.
5. Tool, task, approval, artifact, and verification states merge monotonically by their stable IDs.
6. Late events for terminal turns may enrich diagnostics or completed item details, but cannot reopen the turn or move a terminal side effect back to pending.
7. Abort owns the active turn and its known child work. A late worker result cannot change the aborted turn to completed.
8. Session switching changes the selected projection only; it does not reset or merge reducer state across sessions.

React components consume turn/item selectors. They must not rescan all messages, merge all runtime runs, or combine `sending`, `pendingFinal`, tool activity, media state, and history gaps to infer whether a turn is active.

## History Replay And Recovery

- Record representative live canonical fixtures before replacing legacy rendering. Fixtures cover direct answers, multi-round tools, missing sequence numbers, duplicate events, final-before-lifecycle, errors, abort, disconnect/reconnect, approval, artifact/verification, subagents, image, video, session switch, and restart.
- Convert transcript messages, task-ledger snapshots, and backend liveness into the same canonical envelope types used by live delivery.
- Rebuild a session by replaying canonical events through the same turn reducer and timeline projector. Do not maintain a history-only UI reconstruction algorithm.
- Compare normalized semantic snapshots, not timestamps or ephemeral transport IDs, between live and replay results.
- Backend liveness remains authoritative for whether an interrupted/restored run is active. A stale open tool segment may remain visible as history without rearming the composer.
- History refresh merges by stable identity and source authority. It must not duplicate or move an existing live item, downgrade a terminal task, reopen an approval, or replace newer text with an older snapshot. Stable assistant identity is derived from the owning Turn, the Turn-local assistant segment ordinal, and the following tool-call boundary when present; message IDs are aliases only. For an existing live Turn, history assistant text must hit one of those identities and update it in place or be ignored. A genuinely missing restored Turn may append after the already-rendered Turn order; the explicit load-earlier path alone may prepend older Turns without changing the relative order of existing Turns.

## Timeline Projection

The default renderer accepts only ordered `TimelineItem` values. Design names use snake case below; the implementation uses the equivalent kebab-case discriminants shown in parentheses:

- `user_message` (`user-message`): original user text and attachments.
- `commentary`: concise displayable progress narrative; contiguous deltas update one item.
- `thinking`: optional, collapsed displayable reasoning only.
- `tool_group` (`tool-group`): summary of adjacent compatible tool calls with lazy details.
- `plan`: compact native planner objective/steps; it is never synthesized from prose and preserves the existing Planner / Task Flow capability.
- `approval`: actionable request and terminal decision state.
- `subtask`: compact child-agent/task status with stable parent ownership.
- `artifact` (`artifact-group`): one stable grouped owner for file, image, video, URL, or other durable output with availability state.
- `verification` (`verification-summary`): one concise grouped result bound to the evidence it verifies.
- `final_answer` (`final-answer`): one visible final response block for the turn.
- `error`: friendly terminal or actionable failure when no later authoritative success supersedes it.

No additional default item kind may be introduced without updating this design. Aggregated implementation kinds do not create additional visual ownership for the same fact.

Projection rules:

- One canonical fact has one default visual owner. Tool evidence cannot simultaneously render as a progress row, reasoning row, execution-graph row, and chat card.
- Group only chronologically adjacent tool calls with compatible ownership and display category. Never group across turns, sessions, approvals, user-visible errors, or parent task boundaries.
- Group summaries use localized user-facing verbs and counts. Arguments, command output, patch details, partial results, raw errors, and duration load only when expanded.
- Artifacts and approvals are not buried inside a tool group because they can require independent inspection or action.
- The execution graph is absent from the default expanded timeline. Each eligible turn keeps an `Execution details` action; developer mode adds raw canonical events, provenance, IDs, reducer decisions, and full graph diagnostics.
- Final answer Markdown is isolated from high-frequency commentary/tool updates. A completed Markdown block is memoized and does not rerender because another item changes.

## Performance And Scroll Contract

- Buffer high-frequency assistant/thinking/tool partial deltas and flush at most once per animation frame per active item.
- Normalize turns/items by ID and use item-level subscriptions. Mutating one active item preserves references for the session list, completed turns, and unrelated items.
- Virtualize long timelines at the turn/item boundary with measured dynamic heights, bounded overscan, and stable keys. Expansion and media load update measurements without recreating the full list.
- Keep inactive tool details, raw diagnostics, command output, and execution graphs unmounted until requested.
- Preserve selection, keyboard focus, text copy, deep links, artifact actions, and accessibility when rows enter or leave the virtual window.
- Track bottom anchoring as explicit state. New content auto-follows only when anchored; scroll-up locks the viewport and shows a new-content control; returning to bottom re-enables follow.
- Maintain an anchor item and offset while expanding/collapsing details or loading media above the viewport.
- Instrument event ingress, adapter time, reducer time, projection time, store commits, item render counts, mounted rows, dropped/slow frames, long tasks, history replay time, and scroll corrections in developer diagnostics.

Performance fixtures must prove:

1. A high-frequency active stream performs no more than one visible-item commit per animation frame.
2. Updating the active turn does not increment render counters for completed turns.
3. Replaying 500 messages does not mount a linearly growing number of turn/item DOM nodes.
4. The reference stream has no sustained main-thread tasks over 50 ms, targets 60 FPS on the reference machine, and remains usable at 30 FPS or better on the agreed low-spec profile.
5. The user-scrolled viewport does not jump under streaming, expansion, artifact delivery, media metadata load, or history prepend.

## Product Compatibility Matrix

| Capability | Required projection and invariant |
| --- | --- |
| Ordinary chat | Direct answers need no fabricated plan/tool item; one final answer remains after replay. |
| Image mode/generation/edit | Mode supplies turn defaults only; progress is compact; source attachments and final images retain provenance and reload correctly. |
| Video mode/generation | Long-running progress remains compact; playable/durable artifact and terminal evidence survive restart; queue ownership stays visible. |
| Planner / Task Flow | Real plans/steps/tasks project from structured events; no synthetic default plan; multi-deliverable partial artifacts can appear before final. |
| Execution queue | Queued/running/terminal work stays bound to the owning turn and cannot block unrelated ordinary chat projection. |
| Subagents | Parent/child tasks remain inspectable without interleaving another turn; child detail is compact by default. |
| Approvals | Pending action is prominent and keyboard accessible; decision is idempotent; terminal replay never reopens it. |
| Artifacts | Structured, available outputs render independently and retain existing open/preview/download actions. |
| Verification | Checks are bound to real artifacts/tasks and cannot be invented from prose; failure remains visible without duplicating tool errors. |
| Abort/error/disconnect | One deterministic status, no ghost run, no late-result reopen, and a precise user-facing recovery path. |
| History/session switching | Live and replay snapshots match; current session selection never leaks another session's active state or items. |

## Migration And Rollback

### Phase 1: Record And Normalize

- Add canonical types, live adapters, replay fixtures, correlation diagnostics, and deterministic snapshot tests.
- Keep the current UI unchanged.
- Exit gate: representative fixtures normalize deterministically and communication regression remains green.
- Rollback: disable canonical recording; no persisted user data changes.

### Phase 2: Dual Reduce And Compare

- Run the canonical turn reducer beside the legacy derivation without rendering both.
- Log bounded semantic diffs for ownership, status, items, artifacts, approvals, tasks, and terminal evidence.
- Exit gate: approved fixtures and manual sessions show explained parity or approved intentional differences.
- Rollback: disable shadow reduction; legacy renderer remains untouched.

### Phase 3: Render The Active Turn

- Render the current active turn from canonical timeline items behind a feature flag.
- Add grouped tools, execution-details access, animation-frame batching, and bottom-anchor behavior.
- Exit gate: direct chat, tools, media, subagents, approvals, abort, and error E2E scenarios pass.
- Rollback: switch the renderer flag to legacy; canonical recording/reduction may remain for diagnostics.

### Phase 4: Replay And Virtualize History

- Move completed turns and restored sessions to canonical replay.
- Enable timeline virtualization, stable Markdown boundaries, dynamic-height measurement, and history prepend anchoring.
- Exit gate: live/replay snapshots match and long-history performance thresholds pass.
- Rollback: restore legacy history projection while retaining unchanged transcripts and Gateway contracts.

### Phase 5: Remove Legacy Projection

- Remove obsolete page-level run-card/message rescans, duplicate runtime projections, and temporary comparison code.
- Keep only the approved execution-details view and developer event inspector.
- Exit gate: full static, comms, replay, E2E, product compatibility, and performance validation passes with the legacy renderer disabled.
- Rollback before merge/release: revert the Phase 5 deletion as a code/version rollback. No Gateway or transcript migration makes rollback destructive, and no runtime dual-renderer flag remains in the release.

## Completion Evidence

Implementation review must include:

- Canonical fixture snapshots for every event family and abnormal ordering case. The fixed input and semantic golden are `scripts/fixtures/conversation-timeline-canonical-events.json` and `scripts/fixtures/conversation-timeline-canonical-events.golden.json`, verified by `scripts/conversation-timeline-golden.test.ts`.
- Live-versus-history semantic replay comparison for ordinary chat, tool rounds, media, subagents, approvals, artifact verification, abort, error, and restart.
- Reducer transition evidence showing terminal precedence, idempotence, late events, missing sequences, and session isolation.
- E2E screenshots/traces of the default linear timeline, expanded tool details, normal execution details, developer diagnostics, scroll lock/new-content behavior, and restored sessions.
- Performance output for high-frequency streaming and a 500-message session, including commit counts, completed-turn render counts, mounted DOM counts, long tasks, frame rate, replay duration, and scroll corrections. The retained reports are `harness/evidence/chat-codex-timeline-performance.json` and `harness/evidence/chat-codex-timeline-performance.md`, verified by `scripts/collect-chat-timeline-performance-evidence.mjs --verify`.
- Communication replay/compare output proving no renderer-owned transport or Gateway contract regression.
- A file-level migration checklist confirming legacy code and rollout flags are removed, the version-level rollback path remains non-destructive, and no permanent duplicate state source remains.

## File-level Migration Checklist

Current status: Phases 1-5 are implemented. Timeline is the sole conversation renderer; the legacy page projection, shadow comparison state, renderer rollout flags, and legacy-only approval overlay have been removed after explicit product and rollback sign-off. Rollback is now a code/version revert and requires no Gateway, transcript, or persisted-conversation migration.

Latest automated evidence: the required script/static/build/comms/Harness gates pass. Script suites pass `334/334` with their native runners (`288/288` TypeScript through `tsx`, `46/46` ESM through Node), including the encrypted durable-outbox security cases. The conversation reducer replay suite passes `108/108`, including real async image/video transcript shapes and sealed live-commentary reconciliation. The complete required Electron suite passes `73/73`, including the recovered multi-tool-failure regression and ordinary-user error layering. Public UI/IPC coverage proves same-session queue serialization, stable queued Turn identity, media-intent preservation, durable restart restoration, transcript reconciliation without duplicate commentary, authoritative abort ownership, normal reconnect convergence, and recovery when Renderer misses the intermediate stopped/reconnecting status and observes only a new running Gateway generation. Retained performance evidence verifies approximately 60 FPS, zero long tasks, one store commit per frame, zero completed-Turn rerenders, and 22 mounted rows for both 500- and 1000-message fixtures. Communication replay/compare reports zero duplicates, loss, ordering violations, or RPC timeout regression. The Harness spec validates and dry-runs against `feature/uclaw-general-agent-orchestration`.

The final continuation audit after the media-order fix also passes the current required boundaries: the combined TypeScript script run passes `236/236`, `uclaw-task-bridge` harness passes, TypeScript and production Vite/Electron builds pass, ESLint reports zero errors with the same six pre-existing warnings, performance evidence verifies, comms replay/compare remains zero-loss/zero-duplicate/zero-ordering-violation, and the task Harness validates and dry-runs from `origin/feature/uclaw-general-agent-orchestration`. After the last canonical-boundary repair, the focused reducer replay passes `110/110`, the canonical golden passes `4/4`, and the required Electron matrix passes `72/72` in one serial invocation against the final build. The live-frame gate records zero long tasks, at most one store commit per frame, zero completed-Turn rerenders, and bounded mounted rows for the 500-, 1000-, and single-long-Turn fixtures.

`src/stores/chat.ts` no longer remains at the previously questioned 8,000-line scale. This continuation reduced it from `7,602` to `6,658` lines without changing the Zustand Store API or canonical Timeline ownership. Media model/default/prompt resolution now lives in `src/stores/chat/media-send-preferences.ts`; session title cleanup, summary hydration, and rename deduplication live in `src/stores/chat/session-label-controller.ts`; transport-shaped tool call/result compatibility lives in `src/stores/chat/tool-status.ts`; and optimistic user-message/history-echo reconciliation plus streaming snapshots live in `src/stores/chat/optimistic-message-reconciliation.ts`. `chat.ts` remains the orchestration facade for send, session lifecycle, artifact/history hydration, and compatibility state used outside rendering, while visible conversation projection continues to come only from canonical Turns.

Latest real-OpenClaw manual evidence: image history renders one artifact block; video history renders one player and one file block with durable metadata. Real image and video transcripts persist the same semantic order: assistant process commentary, async media task evidence, delivered `MEDIA:` artifact, then one completion answer. The user's follow-up screenshots proved that history replay parity alone was insufficient: the live reducer could still show late, merged, or repeated text until a later refresh. The current invariant is append-only: the first visible position of a Timeline item never changes; matching evidence updates that item in place; history evidence without a stable Turn-local owner is ignored instead of being appended. Native OpenClaw `itemId` is the preferred assistant identity, and `stream=item` with `kind=preamble` or `commentary` becomes live assistant commentary. A mixed assistant message containing pre-tool text and a tool call remains commentary, while only the post-tool answer converges into `final-answer`. Initial entry, explicit session switch, manual refresh, and Gateway reconnect are the only full history replay boundaries.

The remaining no-streaming defect was upstream of the reducer. OpenClaw 2026.6.11 sets `deferBlockReplyDelivery` whenever any plugin registers `before_agent_finalize`, buffering every assistant frame until terminal delivery while tool events remain live. `uclaw-artifact-guard` 0.2.4 therefore moves terminal artifact inspection to observation-only `agent_end`; its prompt-history maintenance, tool-result compaction, media preparation, tool-level artifact and verification evidence, and canonical media completion gates remain unchanged. This intentionally removes pre-delivery automatic revision in favor of stable real-time delivery. Real session `agent:main:session-1784288492423`, run `8a0ef6e7-c926-4f90-b026-fc01268aaa67`, then delivered pre-tool text through growing frames from 3 to 576 characters before `tool.started` sequence 105 and `tool.completed` sequence 107, followed by growing final text and one terminal answer. The page retained `commentary -> tool-group -> final-answer` with distinct item IDs. Plain text `state=delta` diagnostics are no longer written once per token-sized frame; structured tool deltas and terminal chat signals remain logged. The real Gateway stayed healthy through the run, and the plugin observer ran before terminal settlement without restarting it.

The later approved product decision supersedes terminal-time automatic history replay. Final, error, abort, completion-wake, and backend-idle events now settle only the live lifecycle and never call `chat.history` for the visible session. Existing Turn and Timeline item positions remain fixed after first render. Matching history evidence updates those identities in place; assistant history that cannot match the Turn-local segment ordinal, message alias, or following tool-call boundary is ignored instead of becoming a new row at the end. Only a genuinely missing restored Turn may append after the visible Turn order. Full replay remains available on initial entry, explicit session switch, manual refresh, and Gateway reconnect. This removes the source of mid-stream transcript insertion without changing default chat/image/video routing, planner ownership, queues, approvals, artifact verification, packaging, or restored-session behavior.

Gateway restart evidence remains separate from renderer ordering. A background JunFeiAI provider-status refresh no longer interprets provider/default metadata drift as an authentication change, so it does not schedule a Gateway runtime reload. The final full development restart at `2026-07-17 08:44` started Electron PID `27806` and Gateway PID `27896`, upgraded the bundled `uclaw-task-bridge` plugin from `0.1.8` to `0.1.9`, and contains one `start_requested` plus one Gateway process start with no later restart. Relay-token changes and explicit runtime synchronization still retain their required restart behavior.

OpenClaw host-exec policy ownership is now configuration-driven. `shared/junfeiai-endpoints.json` owns `openClawExec.security` and `openClawExec.ask`; the shared endpoint module validates the supported OpenClaw values and the startup sanitizer copies them into `tools.exec` while preserving adjacent exec settings. The checked-in defaults remain `security=full` and `ask=off`, so this migration does not itself enable approval prompts or change current runtime behavior. A future policy change in the endpoint file requires a Main/Gateway restart so startup sanitization can apply it to `~/.openclaw/openclaw.json`.

OpenClaw long-session compaction policy is owned by the same endpoint configuration. `openClawCompaction` enables the tool-loop mid-turn precheck, rotates the active transcript after successful semantic compaction, and sets the active-transcript trigger to `20mb`; startup sanitization copies those values into `agents.defaults.compaction` while retaining unrelated compaction fields. Artifact-guard prompt maintenance now uses clone-on-write for frozen historical tool calls, and the bundled OpenClaw lifecycle patch treats the newest deferred finishing event as authoritative so a recovered overflow cannot leave the Run terminal in error after a later successful `stop`. Genuine compaction exhaustion still emits the native blocked/error outcome and remains available in diagnostics.

The old task-delivery warning loop is now closed rather than merely identified. Four cancelled `agent:main:route-test` Host tasks had no completion acknowledgement and targeted a non-existent session, so completion injection remained not ready forever. The task bridge now enforces both attempt and elapsed-time budgets, persists a `delivered` or `abandoned` completion settlement in the Host task and journal, and reserves explicit redelivery for a new revision. On the real restarted runtime all four old tasks exhausted at five attempts, persisted `task.completion_abandoned` with `reason=injection_not_ready`, retained their task evidence without deleting local data, and produced zero further retry warnings after `2026-07-17 08:48:35`; Gateway PID `27896` remained unchanged.

The actionable desktop-approval matrix now has real product evidence. OpenClaw Tool Search emits an outer `tool_call` plus an inner `desktop_*` call whose encoded ID replaces the outer `|` separator with `_`; live and history projections fold those facts into exactly two visible tool operations while retaining the inner call as a Turn alias. A request sent without model-supplied `sessionKey/runId` produced approval `runId=dad777a5-03d2-490c-9af5-1eea3932e85a` and an inner `toolCallId`, remained visibly actionable after the model Run completed, exposed `Allow once / Deny`, and moved to `denied` when rejected. The composer recovered immediately, and renderer reload preserved one two-tool Turn without reopening the rejected approval. After a later Main restart, historical approval Turns still rendered exactly two tool operations and no actionable approval reopened. One later approval was manually accepted by the user; it is not evidence of automatic approval or auto-consent. The coordinating regression coverage includes Tool Search deduplication, coordinator ownership preservation, completed-Run approval persistence, late-pending rejection, denial closure, manual resolution replay, and replay safety.

The real Gateway crash/reconnect matrix is now authoritative. Session `agent:main:session-1784200865033` started a 120-second command under Gateway PID `37175`; `SIGKILL` produced `runtime_work_reset` with `interruptedRunCount=1`, and Main started Gateway PID `40849`. OpenClaw then reported `hasActiveRun=false` with a terminal failed session row. Renderer recognized the new Gateway generation even though it had missed the intermediate stopped/reconnecting status, settled the same Turn from backend idle, restored the composer, and did not fabricate `MUST_NOT_RENDER_AFTER_CRASH`. A same-session follow-up produced exactly one `RECOVERY_OK` final. The transcript contains only the original user request, the real pre-tool `toolUse` commentary, the follow-up user request, and the one follow-up final. Non-lifecycle approval/tool replay is also covered against fabricating process-local active Gateway work.

The real-OpenClaw product-compatibility matrix is complete for ordinary chat, media, subagents, approvals, authoritative abort, session/history restoration, and Gateway crash recovery. The user explicitly approved the large-version Phase 5 removal and accepted version-level rollback instead of retaining runtime dual-renderer compatibility.

- [x] `src/pages/Chat/index.tsx`: expose only `TimelineChatPage`; `LegacyChat` and page-level `messages/runtimeRuns -> UserRunCard/ExecutionGraphCard/ReasoningPanel` rescans are deleted.
- [x] `src/stores/chat.ts`: retain send, session, artifact, media, and compatibility runtime state still used outside rendering, while removing legacy-only history comparison inputs. Visible conversation state comes only from canonical Turn/Timeline projection.
- [x] `src/stores/gateway.ts`: keep one Gateway subscription and remove legacy terminal projection comparison. Gateway contracts, transcripts, and persisted user data remain unchanged, so version rollback requires no data migration.
- [x] `shared/conversation-events.ts`, `src/stores/conversation/*`, `src/pages/Chat/TimelineChatPage.tsx`, and `src/pages/Chat/timeline/*`: retain these as the target event contract, Turn source of truth, and only default renderer. Execution graphs mount only through execution details, and raw canonical events remain developer-only.
- [x] `scripts/conversation-timeline-replay.test.ts`, `scripts/chat-timeline-performance.test.ts`, Timeline/scroll E2E, and manual Electron evidence: keep replay parity, abnormal ordering, 500-message DOM bounds, scroll locking, dynamic-height anchoring, media, approval, subtask, and restart coverage as deletion gates. Any failed gate blocks legacy removal.
- [x] Phase 5 retention foundation: raw canonical evidence is bounded by active/terminal event tails and monotonic retention checkpoints; sequence watermarks are scoped per concrete run/entity stream; no-sequence IDs, quarantine records, assignment diagnostics, session caches, and item provenance all have explicit bounds with replay/performance coverage.
- [x] Main-owned durable send outbox: queued intents use stable Turn/idempotency ownership, encrypted atomic persistence, schema and capacity limits, corrupt-file isolation, memory-only fallback when `safeStorage` is unavailable, transcript reconciliation before retry, and staged-attachment TTL leases. Prompt previews, base64 payloads, signed URLs, credentials, and generated reference artifacts are not persisted as owned staging files.
- [x] Phase 5 legacy removal: old page-level run-card/message rescans, renderer feature branches, rollout overrides, legacy-only approval overlay, and temporary shadow comparison state are deleted. Visible state has one canonical Turn/Timeline source of truth while execution details and developer diagnostics remain available.
