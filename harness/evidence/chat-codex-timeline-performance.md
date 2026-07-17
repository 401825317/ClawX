# ClawX Chat Timeline Performance Evidence

- Status: **PASSED**
- Captured: `2026-07-15T17:10:34.103Z`
- Source: `7bed59734577e16cf520fb51dbe1248933e20f45` on `feature/newUI` (dirty working tree)
- Fixture: `tests/e2e/chat-timeline.spec.ts`
- Machine: Apple M3, 8 logical CPUs, 16 GiB RAM, darwin 25.5.0 arm64

## High-Frequency Streaming

| Metric | Result | Gate |
| --- | ---: | --- |
| Fixture frames / events per frame | 24 / 8 | Recorded |
| Measurement duration | 450 ms | Recorded |
| Store commits | 24 | > 0 |
| Max commits per frame | 1 | <= 1 (PASS) |
| Total item renders | 24 | Recorded |
| Completed Turn renders | 0 | 0 (PASS) |
| Active Turn renders | 24 | > 0 |
| Mounted / max mounted rows | 5 / 5 | Recorded |
| Scroll corrections | 0 (max 0.00 px) | Recorded |
| Average FPS | 59.99 | >= 30 (PASS) |
| Sampled / slow frames | 29 / 0 | Recorded |
| Long tasks | 0, 0.00 ms total, 0.00 ms max | <= 1 (PASS) |
| Long-task share | 0.00% | <= 10.00% (PASS) |

## 500-Message Replay

| Metric | Result | Gate |
| --- | ---: | --- |
| Messages / Turns / Timeline rows | 500 / 250 / 500 | 500-message fixture |
| Canonical replay duration | 12.20 ms | Recorded |
| Initial interactive duration | 2094 ms | Recorded |
| Mounted rows | 22 | < 80 and < 500 (PASS) |
| Max mounted rows | 22 | < 80 (PASS) |

## Provenance

The collector ran the existing Electron fixture tests and required both the `timeline-performance` and `timeline-dom-performance` payloads before writing this report. The JSON and Markdown live outside Playwright's `test-results` directory, so later test cleanup does not overwrite this captured evidence.
