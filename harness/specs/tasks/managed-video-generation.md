---
id: managed-video-generation
title: Managed OpenAI-compatible video generation
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add a ClawX-owned OpenClaw video-generation provider, consume the managed server video policy, and let chat users select per-turn model, aspect ratio, resolution, and duration preferences while preserving model-owned video_generate tool selection.
touchedAreas:
  - harness/specs/tasks/managed-video-generation.md
  - harness/reference/acp-generated-media-and-diagnostics.md
  - shared/junfeiai-endpoints.json
  - shared/junfeiai-endpoints.ts
  - shared/managed-client-config.ts
  - shared/host-api/contract.ts
  - shared/acp-chat/types.ts
  - electron/services/managed-client-config-service.ts
  - electron/services/managed-client-config-api.ts
  - electron/services/acp-chat-service.ts
  - electron/services/acp-turn-video-preference-store.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/services/providers/managed-runtime-config.ts
  - electron/services/managed-auth-service.ts
  - electron/utils/openclaw-video-relay-constants.ts
  - electron/utils/openclaw-auth.ts
  - electron/utils/plugin-install.ts
  - electron/gateway/config-sync.ts
  - resources/openclaw-plugins/uclaw-video/index.mjs
  - resources/openclaw-plugins/uclaw-video/openclaw.plugin.json
  - resources/openclaw-plugins/uclaw-video/package.json
  - scripts/openclaw-bundle-config.mjs
  - scripts/bundle-openclaw-plugins.mjs
  - src/lib/host-api.ts
  - src/stores/managed-client-config.ts
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/index.tsx
  - shared/i18n/locales/*/chat.json
  - tests/unit/managed-client-config-service.test.ts
  - tests/unit/managed-client-config-api.test.ts
  - tests/unit/managed-runtime-config.test.ts
  - tests/unit/acp-turn-video-preference-store.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/uclaw-video-plugin.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/plugin-install.test.ts
  - tests/unit/chat-input.test.tsx
  - tests/e2e/chat-video-generation-options.spec.ts
expectedUserBehavior:
  - The managed account supplies the enabled video models, modes, aspect ratios, resolutions, durations, and defaults used by the chat composer.
  - Video mode is mutually exclusive with image mode and defaults to grok-image-video, 16:9, 480P, and 6 seconds when those values are allowed by the managed policy.
  - grok-video-1.5 is selectable only for image-to-video turns with exactly one compatible reference image.
  - Sending in video mode records only this ACP turn's selected video preferences. The model still decides whether to call OpenClaw's native video_generate tool.
  - A model-selected video_generate call receives the selected model, aspect ratio, resolution, and duration from the current turn without changing chat ordering, streaming, history replay, or subsequent turns.
  - Startup and managed-login synchronization install and trust the uclaw-video plugin, configure the managed provider and default video model, and synchronize its API key without modifying OpenClaw core files.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
  - host-api-fallback-policy
  - active-config-guards
  - provider-default-invariant
  - provider-model-metadata-preservation
  - acp-chat-state-and-history
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm exec vitest run tests/unit/managed-client-config-service.test.ts tests/unit/acp-turn-video-preference-store.test.ts tests/unit/acp-chat-service.test.ts tests/unit/uclaw-video-plugin.test.ts tests/unit/provider-runtime-sync.test.ts tests/unit/openclaw-auth.test.ts tests/unit/plugin-install.test.ts tests/unit/chat-input.test.tsx
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-video-generation-options.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Renderer reads managed video policy through the typed Host API and never calls the Gateway or provider endpoint directly.
  - The local endpoint manifest owns provider ID, supported models, modes, aspect ratios, resolutions, durations, defaults, polling interval, timeout, and download limit; secrets remain in managed auth storage and OpenClaw auth profiles.
  - The provider uses OpenAI-compatible POST /videos and GET /videos/{taskId} polling, accepts documented task/status/result response variants, and falls back to GET /videos/{taskId}/content when no result URL is returned.
  - Runtime capabilities expose 2:3, 3:2, 1:1, 9:16, and 16:9, 480P and 720P, plus 6, 10, and 15 seconds, defaulting to 16:9, 480P, and 6 seconds. grok-video-1.5 rejects requests without exactly one reference image.
  - Startup repairs plugins.allow and plugins.entries.uclaw-video.enabled without removing unrelated trusted plugins, and writes agents.defaults.videoGenerationModel.primary as uclaw-video/grok-image-video.
  - ACP preference files store only session/run correlation and normalized video options, are consumed once, expire, and are cleaned up when prompt delivery fails.
  - Image and video composer modes are mutually exclusive, all visible strings have English, Chinese, Japanese, and Russian translations, and the controls do not add timeline subscriptions.
  - Focused unit tests, typecheck, Vite build, Electron E2E, and communication regression checks pass.
docs:
  required: false
---

## Scope

This task extends the existing managed client-config and per-turn image
preference patterns for OpenClaw's native video generation capability. The
`uclaw-video` plugin owns provider protocol adaptation while OpenClaw continues
to own the `video_generate` tool and the model continues to decide whether the
tool is called.

## Out Of Scope

- Modifying OpenClaw core files or vendored `node_modules`.
- Migrating `uclaw-video-project` or adding storyboard/project orchestration.
- Calling the video provider directly from the Renderer or bypassing the model.
- Changing ACP timeline reduction, live event ordering, stream rendering,
  history replay, or generated-media ownership.
- Persisting video preferences as session-wide OpenClaw configuration.

## Compatibility

The managed response uses `aspectRatios` / `defaultAspectRatio` and
`resolutions` / `defaultResolution`. Supported aspect ratios are `2:3`, `3:2`,
`1:1`, `9:16`, and `16:9`; canonical resolutions are `480P` and `720P`. The
client may normalize legacy
`sizes/defaultSize` fields for rollout compatibility, but an invalid legacy
default must never override the local 480P default.
