---
id: junfeiai-prompt-cache-key-compat
title: JunFeiAI prompt cache key compat metadata
intent: Keep ClawX-owned `lingzhiwuxian` text model entries marked as prompt-cache-key compatible, while only writing compat fields accepted by the bundled OpenClaw config schema.
owners:
  - desktop
related:
  - electron/shared/pi-ai-model-cost.ts
  - electron/shared/providers/registry.ts
  - electron/utils/openclaw-auth.ts
  - electron/main/provider-model-sync.ts
  - electron/services/providers/provider-runtime-sync.ts
  - scripts/openclaw-prompt-cache-key-patch.mjs
---

## Contract

- JunFeiAI text chat models continue to use the existing `openai-completions` compatible route.
- ClawX-managed `lingzhiwuxian` text models may set `compat.supportsPromptCacheKey: true` so OpenClaw can pass `prompt_cache_key` through compatible OpenAI-style transports.
- Do not write `compat.supportsLongCacheRetention` into `openclaw.json` or agent `models.json` provider entries unless the bundled OpenClaw config schema explicitly accepts it for that config surface.
- Gateway prelaunch sanitization must remove unsupported `model.compat` keys from existing user config without deleting supported keys such as `supportsPromptCacheKey`.
- Image and video relay provider entries must not inherit text prompt-cache compat metadata.
- The bundled OpenClaw webchat prompt cache key should be stable for the same provider/model/agent across fresh conversations; it must not include the transient session key.

## Regression Checks

- A managed provider save writes `compat.supportsPromptCacheKey: true` for `lingzhiwuxian` models.
- Existing 0.6.6 configs containing `supportsLongCacheRetention` are self-healed before Gateway launch.
- Agent `models.json` updates preserve supported compat metadata and drop unsupported keys.
- Media relay providers (`clawx-openai-image`, video relay) remain free of text prompt-cache compat metadata.
- The OpenClaw runtime patch removes `params.sessionKey` from `resolveWebchatPromptCacheKey` while preserving provider/model/agent identity in the key.
