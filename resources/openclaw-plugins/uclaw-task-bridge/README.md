# UClaw Task Bridge

`uclaw-task-bridge` adapts durable local UClaw Host jobs into normal OpenClaw
tools. It does not classify user intent, run a model, or own a second
conversation loop. OpenClaw remains responsible for tool selection, the
session transcript, policy, and follow-up reasoning.

## Host API contract

The Electron Host owns durable job execution and exposes the authenticated local
API below. Every job must persist its correlation fields so a Host or Gateway
restart can recover it without guessing a session.

```text
GET  /api/task-bridge/capabilities
POST /api/task-bridge/tasks
GET  /api/task-bridge/tasks?activeOnly=true
GET  /api/task-bridge/tasks/:taskId
POST /api/task-bridge/tasks/:taskId/cancel
POST /api/task-bridge/tasks/:taskId/recover
POST /api/task-bridge/tasks/:taskId/ack
```

`POST /tasks` receives a trusted correlation object from the plugin:

```json
{
  "schema": "uclaw.host-task.request/v1",
  "kind": "local.video.compose",
  "title": "Compose final video",
  "input": {},
  "correlation": {
    "sessionKey": "agent:main:session-...",
    "runId": "...",
    "toolCallId": "...",
    "idempotencyKey": "uclaw-task-bridge:..."
  }
}
```

The Host returns `uclaw.host-task/v1` records containing `progress`,
`artifacts`, `verifications`, `revision`, `recovery`, lifecycle operations, and
the same correlation object. Acceptance is derived from the registered Host
capability and persisted with the bounded JSON input, completion policy, and
executor-owned checkpoint. A task cannot become `succeeded` until its required
artifact and passed verification evidence exist. It must treat `idempotencyKey` as
durable, reject a conflicting replay, and return the existing job for an exact
replay. `ack` must be idempotent and record the supplied completion key.

Capabilities advertise lifecycle support from their actual registered methods:
`start` is required, while `cancel` and `resume` are optional. The Host persists
an operation claim before invoking any method. Repeated requests in the same
process reuse that claim; after a restart, only an explicit `resume_if_safe`
request can delegate the stored input and checkpoint to a capability's
`resume` method. The generic bridge never replays a side effect itself.

## Completion boundary

The Host projects terminal `step`, `progress`, `artifact`, `verification`, and
`tool` events directly into the Renderer. The bridge persists the corresponding
structured completion with `enqueueNextTurnInjection`, keyed by
`taskId + revision`, then schedules one tagged same-session `announce` turn.
This wake is required for both `completion.mode=direct` and `replan`, because a
session waiting after `sessions_yield` has no later user turn to consume the
injection. `replan` includes its concrete reason in the wake message. Installed
plugins do not repeat the Host events because OpenClaw reserves those streams
for the Host itself.

The Host and OpenClaw stores cannot share one transaction. A Host acknowledgement
prevents duplicate terminal replay after restart; Host events are idempotent by
stable task/artifact/verification ids, while the tagged session wake is
revision-scoped. The bridge acknowledges only after the Host confirms that wake.
Failed wake or acknowledgement attempts use bounded exponential backoff instead
of polling the same terminal task every monitor tick. The retry policy has both
attempt and elapsed-time budgets. After exhaustion it persists either the
already-delivered acknowledgement or an `abandoned` delivery result with
concrete failure evidence, so the Host no longer returns that terminal revision
forever. The task and its artifacts remain durable; an explicit redelivery
request creates a new revision and clears the prior delivery settlement.

`completion.mode=internal` is reserved for durable Host substeps such as a
VideoProject composition render. The bridge acknowledges that terminal task
without injecting a session turn or emitting artifacts, so a later verified
task can become the single user-facing delivery boundary.

When the Renderer loads a conversation, it also reads the session's persisted
Host tasks and projects their stable task, artifact, verification, and progress
events back into the run view. This restores direct-completion UI after an app
restart without parsing assistant prose or scheduling another model turn.
