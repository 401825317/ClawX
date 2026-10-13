---
id: fix-client-call-failures
title: Repair client call failures, refresh deduplication and draft safety
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Preserve terminal TLS and managed user quota failures, deduplicate actual Gateway config writes, isolate local cancellation, and validate attachments before accepting a draft.
touchedAreas:
  - harness/specs/tasks/fix-client-call-failures.md
  - harness/specs/tasks/fix-gateway-config-refresh-dedup.md
  - harness/specs/tasks/fix-acp-local-cancellation.md
  - harness/specs/tasks/acp-media-attachments.md
  - harness/specs/rules/acp-chat-state-and-history.md
  - electron/gateway/manager.ts
  - electron/services/agents-api.ts
  - electron/utils/openclaw-auth-sqlite.ts
  - electron/services/acp-chat-service.ts
  - electron/services/artifact-task-service.ts
  - src/stores/acp-chat-session.ts
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatInput.tsx
  - shared/acp-chat/errors.ts
  - shared/i18n/locales/en/chat.json
  - shared/i18n/locales/zh/chat.json
  - shared/i18n/locales/ja/chat.json
  - shared/i18n/locales/ru/chat.json
  - src/pages/Chat/AcpTurnFailureCard.tsx
  - scripts/openclaw-acp-terminal-error-patch.mjs
  - scripts/openclaw-provider-terminal-error-patch.mjs
  - scripts/openclaw-acp-binding-isolation-patch.mjs
  - scripts/bundle-openclaw.mjs
  - package.json
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/openclaw-acp-terminal-error-patch.test.ts
  - tests/unit/openclaw-provider-terminal-error-patch.test.ts
  - tests/unit/gateway-manager-config-refresh.test.ts
  - tests/unit/agents-api-config-refresh.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-binding-isolation.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/e2e/chat-local-cancellation.spec.ts
  - tests/e2e/chat-attachment-preflight.spec.ts
  - tests/packaged-e2e/fixtures/deterministic-openai-server.ts
  - tests/packaged-e2e/portable-regression.spec.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - Known managed quota failures do not retry or switch models and are not reported as invalid credentials.
  - Subscription failures instruct users to check subscription status without promising that recharging restores access.
  - Certificate failures remain non-retryable with a stable TLS_CERT_INVALID code through transport, OpenClaw, ACP and replay.
  - Unchanged confirmed configuration does not restart Gateway. Real changes, including custom Agent credentials, remain pending until a supported refresh or controlled start.
  - Stop releases the current prompt without waiting for Gateway, remote acknowledgement or preference cleanup; a fresh ACP binding keeps history and isolates late events.
  - Independently accepted media keeps attachment delivery, not cancelled assistant prose. Other running sessions stay active.
  - Selected, pasted and dropped attachments are capped at eight; rejected pre-dispatch sends retain draft and attachments, while accepted model failures do not replay them.
requiredProfiles:
  - fast
  - comms
  - e2e
requiredTests:
  - tests/unit/acp-chat-errors.test.ts
  - tests/unit/openclaw-acp-terminal-error-patch.test.ts
  - tests/unit/openclaw-provider-terminal-error-patch.test.ts
  - tests/unit/gateway-manager-config-refresh.test.ts
  - tests/unit/agents-api-config-refresh.test.ts
  - tests/unit/openclaw-auth-sqlite.test.ts
  - tests/unit/gateway-manager-mutation-barrier.test.ts
  - tests/unit/gateway-manager-restart-recovery.test.ts
  - tests/unit/host-services.test.ts
  - tests/unit/acp-chat-service.test.ts
  - tests/unit/acp-binding-isolation.test.ts
  - tests/unit/acp-chat-store.test.ts
  - tests/unit/chat-acp-page.test.tsx
  - tests/unit/chat-input.test.tsx
  - tests/e2e/chat-local-cancellation.spec.ts
  - tests/e2e/chat-attachment-preflight.spec.ts
acceptance:
  - Test the complete installed 2026.6.10 classifier, not a substitute classifier.
  - Exercise a real self-signed HTTPS fetch through the patched provider SDK path and count attempts.
  - Preserve ordinary transient network retry behavior and authentication classification.
  - Strict version and exact-layout checks fail closed before patch writes on drift.
  - No disabled TLS verification, additional certificate authorities, media pool changes, Sub2API changes, commit or deployment.
  - Existing uncommitted changes outside the assigned files remain untouched.
  - Slow quota bodies still terminate SDK retries under the caller deadline; allowlisted TLS cause codes survive all provider wrappers.
  - Unowned external Gateway refresh cannot be mistaken for configuration acknowledgement, and cannot trigger a restart loop.
  - Verify actual OpenClaw binding load/prompt/cancel against installed runtime code, including native approvals without run IDs.
docs:
  required: true
---

## Scope

This is the integration spec for the main client-failure workflow. TLS/provider,
Gateway refresh and local cancellation have separate bounded workstreams; this
spec covers their shared worktree and attachment preflight without expanding
into media account pools, server certificates, Sub2API or production changes.
Existing unrelated work is preserved. The 38 full-suite failing assertions were
reproduced against unmodified HEAD 95d7d485; the suite remains non-green and is
not replaced by focused tests. Baseline evidence is retained under artifacts/.

## Release Boundary

Runtime patches are reproducible postinstall and bundle hooks, not manual edits to
node_modules. Tests use temporary runtime copies. Packaged Windows tests are added
but are not equivalent to running a newly built customer installer.

## Trust Boundary

Only allowlisted certificate codes and exact managed business failure signatures
are terminal. Preserve safe codes, never serialize transport options, credentials,
request bodies, certificate contents or raw cause graphs into ACP. Repairing trust
at the customer's actual endpoint remains a separate operational prerequisite.
