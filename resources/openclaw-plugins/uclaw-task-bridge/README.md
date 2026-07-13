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

The bridge emits terminal `step`, `progress`, `artifact`, `verification`, and
`tool` events directly into the originating OpenClaw run. It also persists the
same structured completion with `enqueueNextTurnInjection`, keyed by
`taskId + revision`, so a later user turn has exact task evidence without
reconstructing it from assistant prose. The default `completion.mode=direct`
does not schedule a model turn. A task may explicitly request
`completion.mode=replan` with a concrete reason; only that path schedules one
same-session `announce` turn.

The Host and OpenClaw stores cannot share one transaction. A Host acknowledgement
prevents duplicate terminal replay after restart; runtime events are idempotent
by stable task/artifact/verification ids, while the injected completion context
is exactly-once. Failed event emission, injection, explicit replan wake, or
acknowledgement attempts use bounded exponential backoff instead of polling the
same terminal task every monitor tick.

When the Renderer loads a conversation, it also reads the session's persisted
Host tasks and projects their stable task, artifact, verification, and progress
events back into the run view. This restores direct-completion UI after an app
restart without parsing assistant prose or scheduling another model turn.
