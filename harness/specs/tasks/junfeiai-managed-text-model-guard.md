---
id: junfeiai-managed-text-model-guard
title: JunFeiAI managed text model guard
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Make `openai/*` the default managed JunFeiAI text-model reference while allowing legacy `lingzhiwuxian/*` refs to remain compatible, and ensure either managed reference only sends models exposed by JunFeiAI client-config.
touchedAreas:
  - src/lib/managed-model-options.ts
  - src/stores/client-config.ts
  - src/stores/agents.ts
  - src/stores/chat.ts
  - electron/api/routes/junfeiai.ts
  - electron/services/junfeiai/junfeiai-service.ts
  - electron/utils/agent-config.ts
  - tests/e2e/chat-model-picker.spec.ts
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - renderer-main-boundary
  - api-client-transport-policy
expectedUserBehavior:
  - New managed defaults and Composer fallbacks use `openai/*`; existing `lingzhiwuxian/*` references remain valid compatibility inputs until migrated.
  - A user whose conversation or agent stores an unsupported managed model is silently moved back to the configured text-model fallback under its active managed provider.
  - Sending a normal chat message through the managed JunFeiAI provider never reaches OpenClaw with a text model absent from `/api/junfeiai/client-config`.
  - Users with non-managed custom providers keep their selected provider/model unchanged.
acceptance:
  - Managed default model creation and Composer fallback references use `openai/*`.
  - Renderer snapshots normalize stale `session.model`, `agent.modelRef`, and `defaultModelRef` values for the managed provider to the client-config text default.
  - A chat send cannot proceed with a managed text model that is absent from `client.modelOptions.text.models`.
  - Personal OpenAI, OpenAI OAuth, and other non-managed provider refs are not rewritten by the JunFeiAI guard.
docs:
  required: false
---

## Contract

- The allowed managed text model set is exactly `client.modelOptions.text.models`
  after disabled entries are filtered out.
- The managed fallback is `client.modelOptions.text.defaultModel` when present
  in the allowed set, otherwise the first allowed model, otherwise
  `smart-latest`.
- Both legacy `lingzhiwuxian/*` refs and JunFeiAI-managed `openai/*` refs are
  normalized against the same allowed-model set. Personal OpenAI and other
  provider refs remain user controlled.
- Final chat sends must repair or block stale managed refs before calling the
  runtime send path.
