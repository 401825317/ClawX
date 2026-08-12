---
id: gateway-readiness-policy
title: Gateway Readiness Policy
type: ai-coding-rule
appliesTo:
  - gateway-backend-communication
requiredTests:
  - tests/unit/gateway-events.test.ts
  - tests/unit/gateway-ready-fallback.test.ts
---

Gateway status handling must preserve `gatewayReady` semantics.

`gatewayReady: false` means runtime-dependent work should wait. `gatewayReady: true` means the current Gateway reported readiness. For general, read-only compatibility paths, `gatewayReady: undefined` remains backward-compatible with older Gateway versions and may be treated as ready when the Gateway state is running.

Chat and ACP paths that load a runtime session, dispatch a prompt, or can otherwise produce user-visible or provider-side effects must use the stricter condition `state === 'running' && gatewayReady === true`. These paths must not treat `gatewayReady: undefined` as ready. Renderer must combine the initial Gateway status snapshot with subsequent status events so it neither races startup nor remains blocked after a ready transition.

Electron Main must enforce the same strict readiness condition immediately before ACP load and send operations. Long-lived or multi-stage operations must remain bound to the Gateway runtime identity they started against and reject a result if that identity changes. A readiness transition or runtime replacement must not automatically replay a prompt.

Gateway manager fallback may mark readiness true after its timeout, but it must not emit duplicate ready transitions.
