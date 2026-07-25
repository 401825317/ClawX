---
id: acp-image-preview-and-thinking-selection
title: Add generated image preview actions and session thinking selection
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Let users inspect generated ACP images through the existing attachment authorization boundary and persist a per-session OpenClaw thinking level without changing ACP event ordering, replay, or prompt transport.
touchedAreas:
  - harness/specs/tasks/acp-image-preview-and-thinking-selection.md
  - shared/chat/types.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/lib/acp/timeline-types.ts
  - src/pages/Chat/AcpImagePart.tsx
  - src/pages/Chat/ChatInput.tsx
  - src/stores/acp-chat-session.ts
  - src/stores/chat.ts
  - src/stores/chat/session-catalog.ts
  - tests/e2e/chat-acp-inline-timeline.spec.ts
  - tests/e2e/chat-model-picker.spec.ts
  - tests/unit/acp-chat-components.test.tsx
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-input.test.tsx
  - tests/unit/chat-session-model.test.ts
  - tests/unit/session-catalog.test.ts
expectedUserBehavior:
  - A generated ACP image can be double-clicked to open a full-size preview; its original bytes are read only after that action.
  - The full-size preview can reveal an eligible local generated image in the operating-system file manager without exposing its path to the Renderer.
  - A chat user can choose the OpenClaw thinking level for the current session. The setting survives session reload and is committed before the next prompt is sent.
  - A failed thinking-level update restores only the previous thinking selection and does not overwrite concurrent model or session state.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - host-api-fallback-policy
  - attachment-access-safety
  - acp-chat-state-and-history
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/acp-chat-components.test.tsx tests/unit/acp-chat-store.test.ts tests/unit/chat-input.test.tsx tests/unit/chat-session-model.test.ts tests/unit/session-catalog.test.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-acp-inline-timeline.spec.ts tests/e2e/chat-model-picker.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Generated image timeline entries retain only a scoped attachment reference, thumbnail, and opaque media identity; they do not retain original image bytes or a canonical host path.
  - The Renderer uses files.readAttachmentBinary and files.revealAttachment only with the scoped reference. It does not use naked-path reads, direct IPC, Gateway HTTP, or shell commands.
  - Blob URLs created for the preview are revoked when the preview closes or its source changes.
  - Images without a scoped local attachment reference remain viewable from their safe preview source but do not expose a reveal-in-folder action.
  - Thinking selection uses sessions.patch for an existing session. A locally created session is first registered with sessions.create, then subsequent thinking selection uses sessions.patch.
  - Rapid thinking-level changes are serialized per session, Gateway list/event updates preserve the optimistic selection while pending, and a failed request rolls back only the matching thinking field.
  - Sending waits for outstanding model and thinking-level updates for the active session without adding thinking data to ACP prompt payloads.
  - All new visible strings have English, Chinese, Japanese, and Russian translations.
  - Focused unit and Electron E2E coverage, typecheck, Vite build, and communication regression checks pass.
docs:
  required: false
---

## Scope

This task extends the existing ACP generated-image projection and the existing
chat-session model-selection persistence pattern. It does not alter OpenClaw,
ACP prompt data, timeline reduction, historical replay, streaming, or session
ordering.

## Out Of Scope

- Exposing paths, file handles, binary image data, or arbitrary local URLs to
  the Renderer.
- Adding a general image viewer for untrusted or remote images.
- Changing provider defaults, model selection, or the OpenClaw thinking
  protocol.
- Persisting a second client-side conversation or session configuration ledger.

## Validation Notes

The existing attachment access and ACP state rules are authoritative. The
thinking-level mutation must follow the established per-session model mutation
queue so a local optimistic update cannot be replaced by a stale Gateway list
or `sessions.changed` event.
