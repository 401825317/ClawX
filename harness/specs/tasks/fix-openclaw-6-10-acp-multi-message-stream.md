---
id: fix-openclaw-6-10-acp-multi-message-stream
title: Fix OpenClaw 6.10 ACP multi-message stream truncation
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep assistant text complete when one OpenClaw 6.10 turn emits text, a tool call, then more text with generated media.
touchedAreas:
  - package.json
  - scripts/openclaw-acp-streaming-patch.mjs
  - scripts/bundle-openclaw.mjs
  - tests/unit/openclaw-acp-streaming-patch.test.ts
expectedUserBehavior:
  - Tool-following assistant text remains complete when generated media reaches the conversation.
  - OpenClaw remains pinned to version 2026.6.10.
  - Development installs and packaged USB builds contain the same runtime patch.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/openclaw-acp-streaming-patch.test.ts
acceptance:
  - The patch is idempotent and rejects unknown OpenClaw runtime layouts.
  - package.json still pins OpenClaw to 2026.6.10.
  - Comms replay and compare pass.
docs:
  required: false
---

This task backports only the upstream per-assistant-message streamed-fragment grouping behavior into the bundled OpenClaw 2026.6.10 runtime. It does not upgrade OpenClaw or change ClawX timeline rendering.
