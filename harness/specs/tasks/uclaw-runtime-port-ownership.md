---
id: uclaw-runtime-port-ownership
title: Keep UClaw runtime ports under one verified desktop owner
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Make mixed installed and portable UClaw versions fail closed on fixed runtime port conflicts, identify verified legacy UClaw owners before offering replacement, and prevent Host API bind failures from leaving a partially initialized desktop runtime.
touchedAreas:
  - harness/specs/tasks/uclaw-runtime-port-ownership.md
  - electron/api/server.ts
  - electron/api/server-listener.ts
  - electron/gateway/supervisor.ts
  - electron/main/index.ts
  - electron/main/ipc/host-api-proxy.ts
  - electron/main/process-instance-lock.ts
  - electron/main/runtime-port-guard.ts
  - electron/utils/process-inspection.ts
  - scripts/runtime-port-ownership.test.ts
  - scripts/installer.nsh
  - scripts/patch-nsis-extract.mjs
  - src/stores/chat.ts
  - tests/e2e/native-agent-media-routing.spec.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - Host API port 13210 and Gateway port 18789 have one verified UClaw owner across installed and portable copies.
  - When a verified older UClaw or ClawX process owns a core runtime port or shared instance lock, the new app can request a graceful replacement and retries only after the old process exits.
  - Force termination is offered only after graceful shutdown times out and the process identity is revalidated.
  - Unknown processes are never terminated; UClaw shows their PID/path when available and blocks startup until the conflict is resolved.
  - Host API EADDRINUSE or EACCES prevents the main window and Gateway from starting instead of degrading into a broken mixed runtime.
  - Temporary OAuth, dynamic loopback, development, and external provider ports keep their existing non-takeover behavior.
requiredProfiles:
  - fast
  - comms
requiredRules:
  - backend-communication-boundary
  - gateway-readiness-policy
  - comms-regression
  - docs-sync
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/uclaw-runtime-port-ownership.md --since HEAD
  - pnpm harness run --spec harness/specs/tasks/uclaw-runtime-port-ownership.md --dry-run --since HEAD
  - pnpm exec tsx --test scripts/runtime-port-ownership.test.ts
  - pnpm exec eslint electron/api/server-listener.ts electron/api/server.ts electron/gateway/supervisor.ts electron/main/index.ts electron/main/ipc/host-api-proxy.ts electron/main/runtime-port-guard.ts electron/utils/process-inspection.ts scripts/patch-nsis-extract.mjs scripts/runtime-port-ownership.test.ts src/stores/chat.ts tests/e2e/native-agent-media-routing.spec.ts
  - pnpm run typecheck
  - pnpm run build:vite
  - pnpm exec playwright test tests/e2e/native-agent-media-routing.spec.ts --workers=1
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Core runtime ownership preflight covers the configured CLAWX_HOST_API and OPENCLAW_GATEWAY ports before the main window is created.
  - Listener PID ancestry is resolved so a Gateway child process can be attributed to its UClaw desktop root process.
  - A verified UClaw/ClawX owner requires a product identity or platform app-bundle identity; a loose path or substring match cannot authorize termination.
  - A shared lock held by a live verified UClaw process follows the same user-visible replacement flow as a port conflict.
  - The Windows installer closes and verifies both current UClaw.exe and legacy ClawX.exe processes before replacing files.
  - Unknown or changed process identity fails closed without any kill attempt.
  - Graceful termination precedes any force option, and force revalidates the same PID and identity fingerprint.
  - Host API startup resolves only after listening and rejects startup bind errors.
  - Gateway keeps its existing descendant ownership and external-owner rejection semantics.
  - Browser Control/CDP ownership remains lazy and capability-scoped; OAuth callback collisions degrade without process takeover; dynamic ports are not preclaimed.
docs:
  required: true
---
