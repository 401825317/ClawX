---
id: bundled-plugin-cross-platform-runtime
title: Bundled Plugin Cross-Platform Runtime
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
  - plugin-lifecycle-management
requiredProfiles:
  - fast
---

Every bundled UClaw plugin must load, register, and report capability state on
macOS, Windows, and Linux. A plugin manifest or JavaScript entrypoint being
present is not sufficient evidence that its Host-owned capability works.

Core capabilities shipped as part of UClaw must not return a permanent
`platform not implemented` result on a supported release target. They may use
different platform adapters behind one capability contract, but packaging must
include every runtime binary needed by the selected adapter.

Capabilities that inherently depend on optional external software, hardware,
OS permissions, or user approval may report `unavailable` or
`approval_required`. The reason must name the missing prerequisite and must be
available before the Agent promises or starts the side effect.

Packaging and support diagnostics must verify the target platform's required
runtime files, executable architecture, plugin registration, and core
capability smoke status. A release artifact with a missing or wrong-architecture
runtime must fail the packaging gate instead of degrading after delivery.

Platform-specific shell syntax, paths, and executable names must be isolated in
an explicit adapter. Shared plugin code must not emit POSIX-only commands on
Windows or Windows-only commands on macOS/Linux.
