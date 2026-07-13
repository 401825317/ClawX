---
id: junfeiai-managed-text-model-guard
title: JunFeiAI managed text model guard
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Ensure the managed `openai` account only sends text models exposed by JunFeiAI client-config, migrating legacy `lingzhiwuxian` references before chat requests reach OpenClaw.
touchedAreas:
  - src/lib/managed-model-options.ts
  - src/stores/client-config.ts
  - src/stores/agents.ts
  - src/stores/chat.ts
  - electron/api/routes/junfeiai.ts
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/services/providers/openai-chat-migration.ts
  - electron/services/providers/provider-runtime-sync.ts
  - electron/utils/agent-config.ts
  - tests/unit/chat-session-model-switch.test.ts
  - tests/unit/agent-config.test.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - A user whose old conversation or agent stored `lingzhiwuxian/gpt-5.5` is silently migrated to the server-provided `openai/smart-latest` model.
  - Sending a normal chat message through the managed JunFeiAI provider never reaches OpenClaw with a text model absent from `/api/junfeiai/client-config`.
  - Users with non-managed custom providers keep their selected provider/model unchanged.
acceptance:
  - Startup migrates legacy `lingzhiwuxian/*` model references to `openai/*`, keeps the relay base URL, and uses `openai-responses`.
  - Login/register and `/api/junfeiai/client-config` refresh heal stale managed defaults in local OpenClaw agent config.
  - Renderer snapshots normalize stale `session.model`, `agent.modelRef`, and `defaultModelRef` values for the managed provider to the client-config text default.
  - A chat send cannot proceed with a managed text model that is absent from `client.modelOptions.text.models`.
  - Non-managed providers such as custom OpenAI/OAuth refs are not rewritten by the JunFeiAI guard.
docs:
  required: false
---

## Contract

- The allowed managed text model set is exactly `client.modelOptions.text.models`
  after disabled entries are filtered out.
- The managed fallback is `client.modelOptions.text.defaultModel` when present
  in the allowed set, otherwise the first allowed model, otherwise
  `smart-latest`.
- Legacy `lingzhiwuxian/*` refs are rewritten to the managed `openai/*` form.
  Unmanaged OpenAI/OAuth configurations remain user controlled.
- Final chat sends must repair or block stale managed refs before calling the
  runtime send path.
