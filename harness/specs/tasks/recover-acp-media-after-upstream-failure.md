---
id: recover-acp-media-after-upstream-failure
title: Recover ACP media delivery after provider or summary failure
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep accepted image and video generation Turns recoverable when provider polling, media delivery, or the final summary path fails, without replaying side-effecting media tools or hiding a confirmed failure forever.
touchedAreas:
  - harness/specs/tasks/recover-acp-media-after-upstream-failure.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - harness/specs/rules/acp-compatibility-content-safety.md
  - harness/reference/acp-generated-media-and-diagnostics.md
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/stores/acp-chat-session.ts
  - src/stores/chat.ts
  - electron/services/acp-chat-service.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/acp-image-generation-compat.test.ts
  - tests/e2e/chat-acp-attachments.spec.ts
expectedUserBehavior:
  - Once an image or video tool has started, a summary-model timeout, abort, overloaded response, or requester-run failure does not immediately present the Turn as media generation failure.
  - The owning Turn remains eligible for a bounded transcript/media recovery read after navigation, session switching, or a failed ACP prompt result.
  - A real authorized image or video received during recovery is rendered exactly once and removes or supersedes the matching compatibility failure state.
  - The client never automatically replays a media tool after it has started, so a recovery read cannot duplicate generation or charge the user twice.
  - A confirmed provider failure, invalid request, inaccessible media, or exhausted recovery window still ends in a neutral localized status that does not expose provider internals and does not leave the composer locked.
  - Ordinary text-only ACP failures continue to use the existing failure behavior.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-events-fallback-policy
  - acp-chat-state-and-history
  - acp-compatibility-content-safety
  - attachment-access-safety
  - diagnostics-trace-safety
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/acp-chat-store.test.ts tests/unit/acp-image-generation-compat.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-acp-attachments.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
  - pnpm harness validate --spec harness/specs/tasks/recover-acp-media-after-upstream-failure.md
  - pnpm harness run --spec harness/specs/tasks/recover-acp-media-after-upstream-failure.md
acceptance:
  - OpenClaw remains pinned to 2026.6.10 and its source or bundled runtime is not modified.
  - The renderer distinguishes a media Turn awaiting recovery from a confirmed media failure; the distinction is session- and live-Turn-scoped.
  - Timeout and abort handling releases the composer while retaining a bounded recovery operation for the original Turn.
  - Recovery reads are serialized and identity-scoped; they may resolve an existing provider task or transcript artifact but never submit a second image/video generation request.
  - Media evidence arriving through live ACP updates, Gateway/runtime events, transcript history, or a failed-Turn supplement converges on one timeline item.
  - An authorized media attachment has priority over a summary-only error or compatibility failure for the same user Turn.
  - Video terminal failure projection is delayed until the bounded requester/transcript recovery window has ended, unless the failure is an explicit non-recoverable input or policy rejection.
  - Image and video pending state has a finite deadline and cannot permanently disable the composer.
  - User-visible recovery and terminal messages have complete en/zh/ja/ru translations and do not expose raw provider diagnostics, paths, tokens, or signed URLs.
  - Normal text-only network, timeout, and invalid-request failures retain their existing error projection.
  - Unit and Electron E2E coverage verifies both eventual media success and the exhausted-recovery terminal state, including that the media tool is not replayed.
docs:
  required: true
---

## Scope

Stabilize the existing ClawX ACP media compatibility and transcript-supplement flow for image and video generations that have already started. Preserve the current session-scoped timeline ownership, attachment authorization, local media delivery, and bounded retry architecture while changing failure timing and recovery classification.

The implementation should treat these as recoverable media-delivery conditions when a media task has already started:

- ACP prompt failure after a media tool or non-text output was observed.
- Provider summary or final response timeout, abort, overload, or transient upstream failure.
- Delayed requester completion where the provider task or transcript can still publish the result.
- A temporary transcript/attachment delivery race after the provider reports completion.

Recovery must use the existing transcript/task evidence and authorization boundaries. It must not submit a second generation request.

## Out Of Scope

- Modifying or upgrading OpenClaw 2026.6.10.
- Changing provider request parameters, model policy, billing, or upstream API semantics.
- Adding a second Chat history database or unbounded polling loop.
- Treating every ordinary ACP error as a media recovery case.
- Claiming that media was generated when no authorized media evidence exists.
- Deploying the client or changing production/provider configuration.

## Failure State Contract

1. `mediaPendingRecovery`: a media tool was accepted or started and the prompt/requester path failed or timed out; the composer is usable, and the original Turn retains a bounded recovery operation.
2. `mediaResultObserved`: authorized image/video evidence has been resolved and projected; it wins over summary-only failure text and is deduplicated by session, Turn, task, and evidence identity.
3. `mediaDeliveryExhausted`: the bounded recovery window ended without authorized media, or an explicit non-recoverable provider/input/policy failure was confirmed; show a localized neutral terminal status and release all pending state.

These states may be represented by existing operation fields or a small internal extension, but they must not be inferred from user-visible strings alone.

## Verification Scenarios

- Image tool starts, ACP summary returns an overload/timeout, transcript later contains the generated image: one visible image, no media-failure card, no second prompt/tool call.
- Video task starts, requester run ends before the video attachment is written, transcript later contains the local video: one playable local attachment, no premature video-failed card.
- Provider task is explicitly rejected or violates managed model policy: localized terminal status appears, the composer is released, and no recovery loop continues.
- Recovery attempts expire without media: the user sees a neutral localized terminal message, internal diagnostics remain redacted, and the next prompt can be sent.
- A normal text-only ACP timeout still produces the existing text failure projection.
- Switching conversations and returning during recovery preserves the original Turn's pending/result state without replaying ordinary history or duplicating media.
