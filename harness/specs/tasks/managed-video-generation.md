---
id: managed-video-generation
title: Managed OpenAI-compatible video generation
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add a ClawX-owned OpenClaw video-generation provider, consume the managed server video policy, let chat users select per-turn aspect ratio, resolution, and duration preferences, and route the managed model from actual video_generate reference-image inputs while preserving model-owned tool selection.
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
  - electron/services/acp-session-access-registry.ts
  - electron/services/attachment-access.ts
  - electron/services/attachment-video-stream.ts
  - electron/services/files-api.ts
  - electron/utils/video-reference-image.ts
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
  - src/lib/acp/video-generation-status.ts
  - src/stores/acp-chat-session.ts
  - src/stores/managed-client-config.ts
  - src/pages/Chat/ChatInput.tsx
  - src/pages/Chat/index.tsx
  - src/pages/Chat/AcpAttachmentPart.tsx
  - src/pages/Chat/AcpVideoAttachment.tsx
  - shared/i18n/locales/*/chat.json
  - tests/unit/managed-client-config-service.test.ts
  - tests/unit/managed-client-config-api.test.ts
  - tests/unit/managed-runtime-config.test.ts
  - tests/unit/acp-turn-video-preference-store.test.ts
  - tests/unit/video-reference-image.test.ts
  - tests/unit/video-generation-status.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/uclaw-video-plugin.test.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/plugin-install.test.ts
  - tests/unit/chat-input.test.tsx
  - tests/unit/attachment-access.test.ts
  - tests/unit/attachment-video-stream.test.ts
  - tests/unit/acp-chat-components.test.tsx
  - tests/e2e/chat-video-generation-options.spec.ts
  - tests/e2e/chat-acp-attachments.spec.ts
expectedUserBehavior:
  - The managed account supplies the enabled video models, modes, aspect ratios, resolutions, durations, defaults, bounded request timeouts, and content-download attempts used by the video flow.
  - Video mode is mutually exclusive with image mode and defaults to grok-image-video, 16:9, 480P, and 6 seconds when those values are allowed by the managed policy.
  - The Composer does not expose a video model selector. A video_generate call with no reference image routes to grok-image-video; exactly one reference image routes to grok-video-1.5; more than one reference image is rejected.
  - Sending in video mode records only this ACP turn's selected aspect ratio, resolution, and duration. The model still decides whether to call OpenClaw's native video_generate tool.
  - A video-mode ACP reference image above the managed 1 MiB limit is compressed in memory before prompt delivery; the user source file and attachment identity are never modified, and a still-oversized result fails clearly.
  - A model-selected video_generate call receives the automatically routed model plus the current turn's aspect ratio, resolution, and duration without changing chat ordering, streaming, history replay, or subsequent turns.
  - After OpenClaw returns an asynchronous video task id, the composer shows a localized video-generation status and blocks another send until that task completes, fails, or reaches the bounded timeout; draft editing remains available.
  - A completed video is downloaded into OpenClaw's managed media directory. Interrupted or timed-out content requests resume from validated byte ranges without resubmitting the generation task. Its matching terminal event performs a bounded supplement of only the original live Turn, then renders one local in-chat player with seek, system-open, and reveal-in-folder actions. The provider URL is delivered only after every configured local download attempt fails.
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
  - pnpm exec vitest run tests/unit/junfeiai-endpoints.test.ts tests/unit/managed-client-config-service.test.ts tests/unit/managed-runtime-config.test.ts tests/unit/acp-turn-video-preference-store.test.ts tests/unit/video-reference-image.test.ts tests/unit/video-generation-status.test.ts tests/unit/acp-chat-service.test.ts tests/unit/acp-chat-store.test.ts tests/unit/uclaw-video-plugin.test.ts tests/unit/provider-runtime-sync.test.ts tests/unit/openclaw-auth.test.ts tests/unit/plugin-install.test.ts tests/unit/openclaw-bundle-config.test.ts tests/unit/chat-input.test.tsx tests/unit/attachment-access.test.ts tests/unit/attachment-video-stream.test.ts tests/unit/acp-chat-components.test.tsx
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/chat-video-generation-options.spec.ts
  - pnpm exec playwright test tests/e2e/chat-acp-attachments.spec.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Renderer reads managed video policy through the typed Host API and never calls the Gateway or provider endpoint directly.
  - The local endpoint manifest owns provider ID, supported models, modes, aspect ratios, resolutions, durations, defaults, polling interval, request timeout, per-download timeout, content-download attempt limit, generation timeout, download limit, and maximum reference-image bytes; secrets remain in managed auth storage and OpenClaw auth profiles.
  - The provider uses OpenAI-compatible POST /videos and GET /videos/{taskId} polling, treats an explicit non-terminal status as authoritative even when a result URL is present, and downloads GET /videos/{taskId}/content within the managed size and timeout bounds. Temporary status-query failures continue polling without resubmitting the generation task. Empty, truncated, timed-out, or interrupted MP4 content is retried; when the server returns a valid 206 Content-Range, the next attempt resumes with Range and If-Range. Invalid ranges are never appended, and a server that ignores Range causes a clean full download. After all configured content attempts fail, a completed task with result_url returns that URL-only asset to OpenClaw so the task can finish and the user receives a usable link.
  - Runtime capabilities expose 2:3, 3:2, 1:1, 9:16, and 16:9, 480P and 720P, plus 6, 10, and 15 seconds, defaulting to 16:9, 480P, and 6 seconds. grok-image-video is text-to-video only; grok-video-1.5 is image-to-video only and receives exactly one reference image.
  - Startup repairs plugins.allow and plugins.entries.uclaw-video.enabled without removing unrelated trusted plugins, and writes agents.defaults.videoGenerationModel.primary as uclaw-video/grok-image-video.
  - ACP preference files store session/run correlation, normalized aspect ratio, resolution, duration, and an optional path to the bounded current-turn reference copy. They are consumed once; the managed copy is removed after successful tool acceptance, run completion, prompt failure, or expiry.
  - Image and video composer modes are mutually exclusive, all visible strings have English, Chinese, Japanese, and Russian translations, and the controls do not add timeline subscriptions.
  - Asynchronous video task state is derived from OpenClaw task-start and terminal events, remains scoped across session navigation, disables a second send while pending, and never inserts a synthetic status message. A terminal task may start only a bounded original-Turn media supplement; it must not start general history polling or recover ordinary transcript messages.
  - OpenClaw owns generated-video persistence under its managed media root. Renderer receives only a session-authorized opaque playback URL; Main revalidates every local read, supports bounded Range streaming, and revokes active URLs on release, session generation change, and app shutdown.
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
