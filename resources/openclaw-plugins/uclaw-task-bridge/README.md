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
`artifacts`, `verifications`, `revision`, `recovery`, and the same correlation
object. It must treat `idempotencyKey` as durable and return the existing job
on a replay. `ack` must be idempotent and record the supplied completion key.

## Completion boundary

The bridge persists a completion event into OpenClaw with
`enqueueNextTurnInjection`, keyed by `taskId + revision`. This is the reliable
model-visible completion record. In a packaged/bundled plugin, it also schedules
a same-session Cron turn to consume that event promptly. OpenClaw's public SDK
does not expose the core media task's privileged immediate wake API to arbitrary
plugins; therefore, when the plugin is loaded as a workspace/external extension,
the event is durable but waits for the next session turn/heartbeat.

The two stores cannot share one transaction. A Host acknowledgement reduces
duplicate wake scheduling after restart; delivery is at-least-once at the
scheduler boundary and exactly-once for the injected completion context.
