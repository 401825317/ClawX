# UClaw Video Project

`uclaw-video-project` is the durable orchestration layer for a generated video.
It is deliberately not a second generator or planner. GPT owns the creative
brief, storyboard, prompts, and semantic acceptance decisions; the existing
OpenClaw `video_generate` tool continues to create media; UClaw Host continues
to validate, compose, and deliver files.

## Tool contract

- `uclaw_video_project` creates, reads, composes, lists, and finalizes a project.
- `uclaw_video_shot` adds or updates shots, records an existing
  `video_generate` attempt, accepts a reviewed attempt, or marks a shot ready
  for another attempt.

Every returned shot includes a `generationInput` object. Its `parentTaskId` is
the durable project ID and its `segmentId` is the durable shot ID. Pass those
unchanged to `video_generate`; when a reference exists, it is exposed as
`image` plus `imageRoles: ['reference_image']`. Do not ask this plugin to
generate the clip. An explicit shot model must exist in the live
`video_generate` capability catalog. The project preserves a valid Agent
choice and rejects a stale or chat-only model instead of substituting another
model.

Projects are session-scoped and persisted atomically under
`$OPENCLAW_HOME/state/uclaw-video-projects` (or `~/.openclaw/...`). A project
can only be read or mutated by the originating OpenClaw session.

## Expected flow

1. Use `uclaw_video_project` with `action=create`, the user brief, constraints,
   the shared reference image when applicable, the proposed shots and captions,
   and the intended narration/audio/output composition contract.
2. For each planned/retry-ready shot, call `video_generate` using the returned
   `generationInput`. For reference-required models, the project carries the
   effective reference path or URL in `referenceImages`.
3. Use `uclaw_video_shot` with `action=record_attempt` after each generator
   result. Store the provider task ID and produced artifact rather than
   reconstructing them from chat text later.
4. Run the Host deterministic QA and GPT semantic review. Record measured
   dimensions and both QA decisions on the attempt, then call `accept` only for
   an acceptable shot. Missing dimensions, output below the requested geometry,
   and aspect-ratio mismatches are blocked; upscaling never satisfies the source
   generation contract. For a failed review, call `retry` and generate a new
   attempt.
5. Once every shot is accepted, call `uclaw_video_project` with
   `action=compose`. It reuses the persisted composition contract. A single
   clip only uses source QA when no resize, duration change, caption, narration,
   music, audio replacement, or transition is required; otherwise it starts an
   idempotent Host timeline-render task. Final video QA starts only after the
   source or renderer returns a managed MP4. The internal render task never
   sends a user-facing artifact by itself.
6. Final QA attaches the verified final MP4 as its sole deliverable artifact.
   When the Task Bridge acknowledges that delivery, the project moves from
   `assembled` to `delivered` automatically. Restarting the Gateway resumes
   the monitor from the persisted project and Host task IDs.

The plugin does not fabricate completion: `assembled` and `delivered` are
written by the Host final-QA workflow only. The public `finalize` action can
only confirm the same already-verified artifact and cannot override a blocked
composition or substitute a manually upscaled file.
