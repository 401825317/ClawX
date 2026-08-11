---
id: prompt-for-missing-chat-workspace
title: Prompt when a chat workspace is missing
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Prevent ACP session creation from repeatedly failing when a persisted workspace directory has been deleted, and guide the user to select an existing directory.
touchedAreas:
  - harness/specs/tasks/prompt-for-missing-chat-workspace.md
  - harness/specs/scenarios/chat-workspace-and-navigation.md
  - harness/specs/rules/session-workspace-authority.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/pages/Chat/**
  - electron/utils/paths.ts
  - tests/unit/paths.test.ts
  - tests/unit/sessions-api-workspace.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/e2e/chat-workspace-context.spec.ts
expectedUserBehavior:
  - Chat validates the effective workspace through the Main-owned files host API before loading or creating an ACP session.
  - A deleted or otherwise unavailable workspace shows a localized, actionable message instead of a raw filesystem error.
  - New or unbound chats let the user select another existing workspace from the unavailable-state message.
  - Bound historical sessions keep their authoritative workspace and show a read-only unavailable state.
  - Portable historical sessions recover the active portable identity's default workspace across legacy layouts, drive-letter changes, macOS volume changes, and local runtime profiles.
  - ACP loading and prompting remain blocked while the effective workspace is unavailable.
  - Renderer continues to use host-api and never calls direct IPC or Gateway HTTP.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - renderer-main-boundary
  - backend-communication-boundary
  - api-client-transport-policy
  - session-workspace-authority
  - ui-i18n-design-tokens
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/prompt-for-missing-chat-workspace.md
  - pnpm exec vitest run tests/unit/chat-acp-page.test.tsx
  - pnpm exec vitest run tests/unit/paths.test.ts tests/unit/sessions-api-workspace.test.ts
  - pnpm exec playwright test tests/e2e/chat-workspace-context.spec.ts
  - pnpm run typecheck
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Missing workspace paths surface an unavailable state without silently changing workspace authority.
  - ACP load is not attempted until Main confirms that workspace root and execution cwd are valid directories.
  - The recovery action updates only the global workspace used by new or unbound chats.
  - Existing bound sessions remain read-only and do not fall back to another directory.
  - Portable recovery rewrites only the canonical default workspace for the active portable identity and never guesses arbitrary custom paths.
  - User-facing copy is complete in English, Chinese, Japanese, and Russian.
docs:
  required: true
---
