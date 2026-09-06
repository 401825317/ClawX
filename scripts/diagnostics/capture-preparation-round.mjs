import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const output = path.resolve(process.argv[2] ?? '.codex/diagnostics/preparation-round.json');
const logPath = process.argv[3] ?? path.join(process.env.APPDATA, 'ClawX/logs/clawx-2026-09-06.log');
const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
let entries;
try {
  const page = browser.contexts()[0].pages().find(p => p.url().includes('index.html'));
  const snapshot = await page.evaluate(() => window.clawx.hostInvoke({ id: crypto.randomUUID(), module: 'diagnostics', action: 'acpTrace' }));
  if (!snapshot.ok) throw new Error('ACP trace unavailable');
  const keys = ['requestId', 'clientToMainMs', 'mainToDispatchMs', 'clientToFirstTextMs', 'clientToCompleteMs', 'dispatchToFirstTextMs', 'preDispatchPhases'];
  entries = snapshot.data.entries.filter(e => /session\/prompt:|renderer\/assistant-visible/u.test(e.event)).map(e => ({
    timestamp: e.timestamp, seq: e.seq, event: e.event, sessionKey: e.sessionKey,
    details: Object.fromEntries(keys.filter(k => e.details?.[k] !== undefined).map(k => [k, e.details[k]])),
  }));
} finally { await browser.close(); }
const log = await readFile(logPath, 'utf8');
const stages = [];
const events = [];
for (const line of log.split('\n')) for (const [marker, rows] of [['[uclaw-prep-probe] ', stages], ['[uclaw-event-probe] ', events]]) {
  const index = line.indexOf(marker);
  if (index !== -1) rows.push({ logTimestamp: line.slice(1, line.indexOf(']')), ...JSON.parse(line.slice(index + marker.length)) });
}
const results = entries.filter(e => e.event === 'session/prompt:complete').map(complete => {
  const requestId = complete.details.requestId;
  const end = Date.parse(complete.timestamp);
  const start = end - complete.details.clientToCompleteMs;
  const visible = entries.find(e => e.event === 'renderer/assistant-visible' && e.details.requestId === requestId);
  const first = entries.find(e => e.event === 'session/prompt:first-text' && e.sessionKey === complete.sessionKey && Date.parse(e.timestamp) >= start && Date.parse(e.timestamp) <= end);
  const matchingStages = stages.filter(s => Date.parse(s.logTimestamp) >= start && Date.parse(s.logTimestamp) <= end);
  const runIds = [...new Set(matchingStages.map(s => s.runId))];
  const modelEvents = events.filter(e => runIds.includes(e.runId));
  const call = modelEvents.find(e => e.type === 'model.call.started');
  return {
    requestId, sessionKey: complete.sessionKey, runIds, start, firstVisibleMs: visible ? Date.parse(visible.timestamp) - start : null,
    mainToVisibleMs: visible && first ? Date.parse(visible.timestamp) - Date.parse(first.timestamp) : null,
    completeMs: complete.details.clientToCompleteMs,
    localToProviderMs: call ? Date.parse(call.logTimestamp) - start : null,
    stages: matchingStages, modelEvents,
  };
});
await writeFile(output, JSON.stringify({ entries, results }, null, 2));
console.log(JSON.stringify(results.map(({ stages, modelEvents, ...result }) => ({ ...result, startupMs: stages.find(s => s.kind === 'startup')?.totalMs, prepMs: stages.find(s => s.kind === 'prep')?.totalMs, providerTtfbMs: modelEvents.find(e => e.type === 'model.call.completed')?.timeToFirstByteMs }))));
