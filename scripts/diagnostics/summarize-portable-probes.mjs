import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve('.codex/diagnostics');
const jsonl = async (name) => (await readFile(path.join(root, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const probes = await jsonl('portable-206-chat.jsonl');
const links = await jsonl('runtime-links-206.jsonl');
const exporterLinks = await jsonl('exporter-links-206.jsonl');
const timeline = await jsonl('timeline-portable-206.jsonl');
const otel = await jsonl('otel-portable-206.jsonl');
const stageLog = await readFile(path.join(process.env.APPDATA, 'ClawX/logs/clawx-2026-09-06.log'), 'utf8');
const stageMarker = '[uclaw-stage-probe] ';
const stageRows = stageLog.split('\n').filter((line) => line.includes(stageMarker)).map((line) => JSON.parse(line.slice(line.indexOf(stageMarker) + stageMarker.length)));
const ms = (span) => Number(BigInt(span.startTimeUnixNano) / 1000000n);
const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
let entries;
let health;
try {
  const page = browser.contexts()[0].pages()[0];
  const trace = await page.evaluate(() => window.clawx.hostInvoke({ id: crypto.randomUUID(), module: 'diagnostics', action: 'acpTrace' }));
  assert.equal(trace.ok, true);
  entries = trace.data.entries;
  health = await page.evaluate(() => window.clawx.hostInvoke({ id: crypto.randomUUID(), module: 'gateway', action: 'health', payload: { probe: true } }));
} finally { await browser.close(); }
const results = [];
for (const probe of probes) {
  const savedDispatch = probe.trace.find((entry) => entry.event === 'session/prompt:dispatched');
  if (!savedDispatch) continue;
  const requestId = savedDispatch.details.requestId;
  const dispatch = entries.find((entry) => entry.event === 'session/prompt:dispatched' && entry.details?.requestId === requestId);
  const complete = entries.find((entry) => entry.event === 'session/prompt:complete' && entry.details?.requestId === requestId);
  const visible = entries.find((entry) => entry.event === 'renderer/assistant-visible' && entry.details?.requestId === requestId);
  if (!dispatch || !complete || !visible) continue;
  const clientStart = Date.parse(complete.timestamp) - complete.details.clientToCompleteMs;
  const first = entries.find((entry) => entry.event === 'session/prompt:first-text' && entry.sessionKey === dispatch.sessionKey && entry.seq > dispatch.seq && entry.seq < complete.seq);
  const inbound = timeline.filter((entry) => entry.type === 'span.start' && entry.name === 'gateway.chat_send.dispatch_inbound' && entry.attributes?.sessionKey === dispatch.sessionKey && Date.parse(entry.timestamp) >= Date.parse(dispatch.timestamp) - 2 && Date.parse(entry.timestamp) <= Date.parse(complete.timestamp));
  const result = { scenario: probe.scenario, requestId, sessionKey: dispatch.sessionKey, clientFirstVisibleMs: Date.parse(visible.timestamp) - clientStart, mainToVisibleMs: Date.parse(visible.timestamp) - Date.parse(first.timestamp), completeMs: complete.details.clientToCompleteMs, checks: probe.checks };
  if (inbound.length === 1) {
    result.runId = inbound[0].attributes.runId;
    result.stages = stageRows.filter((entry) => entry.runId === result.runId);
    const modelLink = links.find((entry) => entry.type === 'model.call.started' && entry.runId === result.runId);
    const exportedLink = exporterLinks.find((entry) => entry.type === 'model.call.started' && entry.runId === result.runId);
    if (modelLink && exportedLink) {
      assert.equal(modelLink.trace.traceId, exportedLink.sourceTraceId);
      result.sourceTraceId = modelLink.trace.traceId;
      result.traceId = exportedLink.traceId;
      result.correlation = 'ACP request ID; unique in-flight Gateway run in the same session; trusted run-to-trace link; OTLP trace ID';
      const spans = otel.filter((entry) => entry.traceId === result.traceId);
      const call = spans.find((entry) => entry.name === 'openclaw.model.call');
      const harness = spans.find((entry) => entry.name === 'openclaw.harness.run');
      assert.ok(call && harness, 'OTLP must contain the trusted linked run');
      const ttfb = call.attributes['openclaw.model_call.time_to_first_byte_ms'];
      result.hopsMs = {
        clientToMain: dispatch.details.clientToMainMs,
        mainToDispatch: dispatch.details.mainToDispatchMs,
        dispatchToGateway: Date.parse(inbound[0].timestamp) - Date.parse(dispatch.timestamp),
        gatewayToHarness: ms(harness) - Date.parse(inbound[0].timestamp),
        harnessToProvider: ms(call) - ms(harness),
        providerFirstEvent: ttfb,
        providerFirstEventToMainText: Date.parse(first.timestamp) - ms(call) - ttfb,
        mainTextToRenderer: result.mainToVisibleMs,
      };
      result.providerCallMs = call.durationMs;
      result.providerRequestBytes = call.attributes['openclaw.model_call.request_bytes'];
      result.localBeforeProviderMs = ms(call) - clientStart;
    }
  }
  results.push(result);
}
const report = { createdAt: new Date().toISOString(), gatewayHealth: { ok: health.ok && health.data?.ok, core: health.data?.capabilities?.core, eventLoop: health.data?.capabilities?.openclawHealth?.payload?.eventLoop }, rendererMetric: 'React nonempty assistant projection effect, not hardware presentation time', results };
await writeFile(path.join(root, 'portable-206-summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
