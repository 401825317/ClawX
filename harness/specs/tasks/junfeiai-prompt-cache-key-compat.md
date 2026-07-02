---
id: junfeiai-prompt-cache-key-compat
title: Enable prompt cache key support for JunFeiAI text provider entries
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Improve cross-session prompt cache hit stability for JunFeiAI text models by marking ClawX-owned `lingzhiwuxian` OpenClaw model entries as prompt-cache-key compatible, without changing the default API protocol or the separate image/video relay providers.
touchedAreas:
  - harness/specs/tasks/junfeiai-prompt-cache-key-compat.md
  - electron/shared/pi-ai-model-cost.ts
  - electron/shared/providers/registry.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/main/provider-model-sync.ts
  - electron/utils/openclaw-auth.ts
  - tests/unit/provider-runtime-sync.test.ts
  - tests/unit/openclaw-auth.test.ts
expectedUserBehavior:
  - JunFeiAI text chats continue to use the existing OpenAI Chat Completions compatible route and do not switch to the Responses protocol.
  - OpenClaw sends stable `prompt_cache_key` values for JunFeiAI text models when the runtime supports prompt caching.
  - Re-saving or refreshing a managed JunFeiAI provider repairs older per-agent `models.json` entries that lack prompt-cache compat metadata.
  - ClawX image generation and OpenAI/Grok video relay provider entries keep their existing protocol and model metadata.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - active-config-guards
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
acceptance:
  - Shared pi-ai model helpers expose a reusable prompt-cache compat entry builder with `supportsPromptCacheKey: true` and `supportsLongCacheRetention: false`.
  - `lingzhiwuxian` runtime provider entries in `openclaw.json` receive prompt-cache compat metadata for every model row ClawX writes or preserves.
  - Per-agent `models.json` updates preserve existing model metadata while also accepting newly supplied compat fields.
  - Managed image and video relay provider entries are not marked with text prompt-cache compat.
  - Unit tests cover global provider config sync and per-agent model sync for JunFeiAI prompt-cache compat.
docs:
  required: false
---

## Background

JunFeiAI text traffic currently remains on the OpenAI Chat Completions
compatible path. OpenClaw's OpenAI-compatible runtime only forwards
`prompt_cache_key` when the selected model row advertises prompt-cache-key
support through its compatibility metadata.

Without this metadata, cross-session requests can still work, but cache
affinity depends on incidental upstream routing and may fall back to full-price
prompt processing. The change should therefore make the existing text-provider
path more explicit instead of changing protocols.

## Scope

- Add a shared model-entry helper for prompt-cache compat metadata.
- Apply the helper to JunFeiAI text model entries created from managed provider
  metadata and registry-backed provider config.
- Add a provider-key fallback inside OpenClaw config writers so legacy entries
  are repaired during normal provider sync.
- Keep `clawx-openai-image` and OpenAI video relay provider entries unchanged.

## Out of scope

- Switching JunFeiAI text traffic from `/v1/chat/completions` to
  `/v1/responses`.
- Enabling long cache retention (`prompt_cache_retention: "24h"`).
- Changing image generation or video generation relay protocols.
