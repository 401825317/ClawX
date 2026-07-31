---
id: agent-persona-creation-host-api
title: Agent persona creation through the typed Host API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Migrate the managed Agent creation and persona workflow without restoring legacy renderer transports.
touchedAreas:
  - shared/types/agent.ts
  - shared/host-api/contract.ts
  - src/lib/host-api.ts
  - src/stores/agents.ts
  - src/pages/Agents/index.tsx
  - src/pages/Chat/ChatToolbar.tsx
  - src/stores/chat/session-key-utils.ts
  - src/stores/chat.ts
  - electron/services/agents-api.ts
  - electron/services/agent-profile-generation-service.ts
  - electron/utils/agent-config.ts
  - electron/utils/agent-profile-generation.ts
  - electron/utils/agent-profile.ts
  - electron/utils/chat-session-welcome-message.ts
  - electron/utils/chat-session-cleanup.ts
expectedUserBehavior:
  - Users can create an Agent with a role, responsibility, built-in avatar, and generated persona.
  - The created Agent opens its main chat and keeps its persona after restart.
  - Existing Agents without persona data continue to use their current name and default avatar.
  - Internal persona-generation sessions never appear in the conversation list or runtime feed.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/host-api-facade.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/agent-config.test.ts
  - tests/unit/agent-profile-generation.test.ts
  - tests/unit/agent-profile-generation-service.test.ts
  - tests/unit/agent-profile.test.ts
  - tests/unit/chat-session-cleanup.test.ts
  - tests/unit/session-key-utils.test.ts
  - tests/unit/gateway-events.test.ts
  - tests/unit/agents-store.test.ts
  - tests/unit/agents-page.test.tsx
  - tests/unit/chat-toolbar.test.tsx
  - tests/e2e/agents-profile-create.spec.ts
acceptance:
  - Renderer uses hostApi.agents for Agent creation and persona generation.
  - Persona generation uses an exact agent:main:uclaw-profile- session-key prefix and always cleans up the temporary session.
  - Agent creation persists profile files, the welcome transcript, and OpenClaw Agent configuration transactionally.
  - Deleting an Agent removes its managed persona profile.
  - Normal chat ordering, history loading, deduplication, and streaming behavior remain unchanged.
  - Comms replay and compare pass.
docs:
  required: false
---

This task migrates the existing UClaw Agent management workflow onto the current typed Host API and OpenClaw 2026.6.10 runtime boundaries.
