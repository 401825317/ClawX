import { chromium } from 'playwright-core';
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const scenario = process.argv[2] ?? 'text';
if (!['text', 'tools', 'followup'].includes(scenario)) throw new Error('Unknown scenario');
const report = path.resolve('.codex/diagnostics/portable-206-chat.jsonl');
const fixture = path.resolve('.codex/diagnostics/harness-live-fixture.json').replaceAll('\\', '/');
const prompt = scenario === 'text' ? 'hi' : scenario === 'tools'
  ? `This is an authorized local acceptance test. Use real tools, not simulated results. Only write this one file: ${fixture}. Create JSON with numbers [13,21,34] and marker "uclaw-206-check". Read it back with a tool, calculate the sum from the read values, update the same file adding sum and verified:true, and read it again to verify. Complete all steps in this turn without asking me to continue. Final reply must contain UCLAW_ACCEPTANCE_68 only after the final read succeeds. Do not modify other files, settings, models, or services.`
  : `Continue the previous acceptance task. Read the same harness-live-fixture.json file using a real tool. Report the saved marker and sum and the phrase UCLAW_CONTINUITY_OK. Do not modify the file or any settings.`;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9224');
try {
  const page = browser.contexts()[0].pages().find((candidate) => candidate.url().includes('index.html')) ?? browser.contexts()[0].pages()[0];
  const composer = page.getByTestId('chat-composer-input');
  await composer.waitFor({ timeout: 120000 });
  if (scenario === 'text' && process.argv.includes('--new')) {
    await page.getByTestId('sidebar-new-chat').click();
  }
  await composer.fill(prompt);
  await page.getByTestId('chat-composer-send').evaluate((button) => {
    button.addEventListener('click', () => { window.__uclawProbeClickedAt = Date.now(); }, { once: true, capture: true });
  });
  await page.getByTestId('chat-composer-send').click();
  const startedAt = await page.evaluate(() => window.__uclawProbeClickedAt);
  if (!Number.isFinite(startedAt)) throw new Error('Click timestamp was not captured');
  const deadline = Date.now() + 240000;
  let firstVisibleAt = null;
  let completeAt = null;
  let relevant = [];
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.clawx.hostInvoke({ id: crypto.randomUUID(), module: 'diagnostics', action: 'acpTrace' }));
    if (!snapshot.ok) throw new Error('ACP diagnostic snapshot unavailable');
    relevant = snapshot.data.entries.filter((entry) => Date.parse(entry.timestamp) >= startedAt);
    const start = relevant.find((entry) => entry.event === 'session/prompt:dispatched');
    const requestId = start?.details?.requestId;
    const visible = relevant.find((entry) => entry.event === 'renderer/assistant-visible' && (!requestId || entry.details?.requestId === requestId));
    if (visible) firstVisibleAt ??= Date.parse(visible.timestamp);
    const complete = relevant.find((entry) => entry.event === 'session/prompt:complete' && (!requestId || entry.details?.requestId === requestId));
    if (complete) { completeAt = Date.parse(complete.timestamp); break; }
    if (relevant.some((entry) => entry.event === 'session/prompt:failed')) throw new Error('ACP prompt failed; inspect local redacted trace');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (completeAt == null) throw new Error('Acceptance prompt did not complete within 240 seconds');
  const checks = await page.getByTestId('acp-assistant-turn').last().evaluate((element) => ({
    toolMarker: element.textContent.includes('UCLAW_ACCEPTANCE_68'),
    followupMarker: element.textContent.includes('UCLAW_CONTINUITY_OK'),
    savedMarker: element.textContent.includes('uclaw-206-check'),
  }));
  // Store timing and correlation metadata only, never message bodies or tool payloads.
  const detailsKeys = ['requestId', 'assistantMessageId', 'itemId', 'acpSessionId', 'clientToMainMs', 'mainToDispatchMs', 'clientToDispatchMs', 'clientToFirstTextMs', 'dispatchToFirstTextMs', 'clientToCompleteMs', 'dispatchToCompleteMs', 'preDispatchPhases'];
  const trace = relevant.map(({ timestamp, source, event, sessionKey, generation, details }) => ({
    timestamp, source, event, sessionKey, generation,
    details: Object.fromEntries(detailsKeys.filter((key) => details?.[key] != null).map((key) => [key, details[key]])),
  }));
  const result = { scenario, startedAt, firstVisibleMs: firstVisibleAt == null ? null : firstVisibleAt - startedAt, completeMs: completeAt - startedAt, checks, trace };
  await mkdir(path.dirname(report), { recursive: true });
  await appendFile(report, `${JSON.stringify(result)}\n`);
  console.log(JSON.stringify({ ...result, trace: trace.filter((entry) => /prompt:|assistant-visible/.test(entry.event)) }));
  if (scenario === 'tools' && !checks.toolMarker || scenario === 'followup' && (!checks.followupMarker || !checks.savedMarker)) process.exitCode = 1;
} finally {
  await browser.close();
}
