import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_JSON = resolve(ROOT, 'harness/evidence/chat-codex-timeline-performance.json');
const EVIDENCE_MARKDOWN = resolve(ROOT, 'harness/evidence/chat-codex-timeline-performance.md');
const PERFORMANCE_SPEC = 'tests/e2e/chat-timeline.spec.ts';
const PERFORMANCE_GREP = 'measures real-frame streaming|keeps a 500-message replay DOM bounded';
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const ANSI_ESCAPE = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

function fail(message) {
  throw new Error(`[timeline-performance-evidence] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    if (output) process.stderr.write(output);
    fail(`${command} ${args.join(' ')} exited with status ${result.status}`);
  }
  return result;
}

function commandOutput(command, args) {
  return run(command, args).stdout.trim();
}

function parseMarkerOutput(output, marker) {
  const prefix = `[${marker}]`;
  const values = [];
  for (const rawLine of output.replace(ANSI_ESCAPE, '').split(/\r?\n/u)) {
    const markerIndex = rawLine.indexOf(prefix);
    if (markerIndex < 0) continue;
    const payload = rawLine.slice(markerIndex + prefix.length).trim();
    try {
      values.push(JSON.parse(payload));
    } catch (error) {
      fail(`invalid ${marker} JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return values;
}

function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${path} must be a finite number`);
  }
  return value;
}

function nonNegativeNumber(value, path) {
  const number = finiteNumber(value, path);
  if (number < 0) fail(`${path} must be non-negative`);
  return number;
}

function positiveNumber(value, path) {
  const number = finiteNumber(value, path);
  if (number <= 0) fail(`${path} must be positive`);
  return number;
}

function durationMetric(value, path) {
  if (!value || typeof value !== 'object') fail(`${path} is missing`);
  return {
    count: nonNegativeNumber(value.count, `${path}.count`),
    totalMs: nonNegativeNumber(value.totalMs, `${path}.totalMs`),
    maxMs: nonNegativeNumber(value.maxMs, `${path}.maxMs`),
    lastMs: nonNegativeNumber(value.lastMs, `${path}.lastMs`),
  };
}

function validateEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') fail('evidence JSON must be an object');
  if (evidence.schemaVersion !== 1) fail('unsupported evidence schemaVersion');
  if (evidence.kind !== 'clawx-chat-timeline-performance') fail('unexpected evidence kind');
  if (evidence.status !== 'passed') fail('evidence status is not passed');
  if (!Number.isFinite(Date.parse(evidence.generatedAt))) fail('generatedAt must be an ISO timestamp');

  const stream = evidence.streaming;
  const replay = evidence.historyReplay500;
  if (!stream || typeof stream !== 'object') fail('streaming evidence is missing');
  if (!replay || typeof replay !== 'object') fail('500-message replay evidence is missing');

  const frames = positiveNumber(stream.fixture?.frames, 'streaming.fixture.frames');
  positiveNumber(stream.fixture?.eventsPerFrame, 'streaming.fixture.eventsPerFrame');
  positiveNumber(stream.fixture?.elapsedMs, 'streaming.fixture.elapsedMs');
  const minimumFps = nonNegativeNumber(stream.thresholds?.minimumFps, 'streaming.thresholds.minimumFps');
  const maximumLongTaskCount = nonNegativeNumber(
    stream.thresholds?.maximumLongTaskCount,
    'streaming.thresholds.maximumLongTaskCount',
  );
  const maximumLongTaskShare = nonNegativeNumber(
    stream.thresholds?.maximumLongTaskShare,
    'streaming.thresholds.maximumLongTaskShare',
  );
  const storeCommits = positiveNumber(stream.storeCommits, 'streaming.storeCommits');
  const maxStoreCommitsPerFrame = nonNegativeNumber(
    stream.maxStoreCommitsPerFrame,
    'streaming.maxStoreCommitsPerFrame',
  );
  const itemRenders = positiveNumber(stream.itemRenders, 'streaming.itemRenders');
  const completedTurnRenders = nonNegativeNumber(
    stream.completedTurnRenders,
    'streaming.completedTurnRenders',
  );
  const activeTurnRenders = positiveNumber(stream.activeTurnRenders, 'streaming.activeTurnRenders');
  positiveNumber(stream.mountedRows, 'streaming.mountedRows');
  positiveNumber(stream.maxMountedRows, 'streaming.maxMountedRows');
  nonNegativeNumber(stream.scrollCorrections, 'streaming.scrollCorrections');
  nonNegativeNumber(stream.maxScrollCorrectionPx, 'streaming.maxScrollCorrectionPx');
  const sampledFrames = positiveNumber(stream.sampledFrames, 'streaming.sampledFrames');
  nonNegativeNumber(stream.slowFrames, 'streaming.slowFrames');
  const averageFps = positiveNumber(stream.averageFps, 'streaming.averageFps');
  const longTasks = durationMetric(stream.longTasks, 'streaming.longTasks');
  const longTaskShare = nonNegativeNumber(stream.longTaskShare, 'streaming.longTaskShare');

  if (stream.longTaskObserverSupported !== true) fail('Electron long-task observer was not supported');
  if (maxStoreCommitsPerFrame > 1) fail('visible-item commits exceeded one per animation frame');
  if (completedTurnRenders !== 0) fail('the completed Turn rerendered during active streaming');
  if (activeTurnRenders > itemRenders) fail('active Turn renders exceed total item renders');
  if (sampledFrames < frames) fail('the fixture did not sample every requested stream frame');
  if (averageFps < minimumFps) fail(`average FPS ${averageFps} is below ${minimumFps}`);
  if (longTasks.count > maximumLongTaskCount) fail('long-task count exceeded the configured threshold');
  if (longTaskShare > maximumLongTaskShare) fail('long-task duration share exceeded the configured threshold');
  if (storeCommits < 1) fail('the streaming fixture recorded no store commits');

  if (replay.messageCount !== 500) fail('the persisted replay fixture must contain exactly 500 messages');
  positiveNumber(replay.turnCount, 'historyReplay500.turnCount');
  if (replay.totalRows !== 500) fail('the 500-message fixture must project exactly 500 Timeline rows');
  const mountedRows = positiveNumber(replay.mountedRows, 'historyReplay500.mountedRows');
  const maxMountedRows = positiveNumber(replay.maxMountedRows, 'historyReplay500.maxMountedRows');
  nonNegativeNumber(replay.initialInteractiveMs, 'historyReplay500.initialInteractiveMs');
  nonNegativeNumber(replay.replayDurationMs, 'historyReplay500.replayDurationMs');
  if (mountedRows >= replay.totalRows) fail('mounted DOM grew linearly with replay history');
  if (mountedRows >= 80 || maxMountedRows >= 80) fail('mounted Timeline DOM exceeded the agreed bound');

  return evidence;
}

function renderMarkdown(evidence) {
  const stream = evidence.streaming;
  const replay = evidence.historyReplay500;
  const machine = evidence.environment.machine;
  const pass = (condition) => condition ? 'PASS' : 'FAIL';
  return `# ClawX Chat Timeline Performance Evidence

- Status: **${evidence.status.toUpperCase()}**
- Captured: \`${evidence.generatedAt}\`
- Source: \`${evidence.source.gitHead}\` on \`${evidence.source.branch}\` (${evidence.source.workingTreeDirty ? 'dirty working tree' : 'clean working tree'})
- Fixture: \`${evidence.source.performanceSpec}\`
- Machine: ${machine.cpuModel}, ${machine.logicalCpuCount} logical CPUs, ${machine.totalMemoryGiB} GiB RAM, ${machine.platform} ${machine.release} ${machine.arch}

## High-Frequency Streaming

| Metric | Result | Gate |
| --- | ---: | --- |
| Fixture frames / events per frame | ${stream.fixture.frames} / ${stream.fixture.eventsPerFrame} | Recorded |
| Measurement duration | ${stream.fixture.elapsedMs} ms | Recorded |
| Store commits | ${stream.storeCommits} | > 0 |
| Max commits per frame | ${stream.maxStoreCommitsPerFrame} | <= 1 (${pass(stream.maxStoreCommitsPerFrame <= 1)}) |
| Total item renders | ${stream.itemRenders} | Recorded |
| Completed Turn renders | ${stream.completedTurnRenders} | 0 (${pass(stream.completedTurnRenders === 0)}) |
| Active Turn renders | ${stream.activeTurnRenders} | > 0 |
| Mounted / max mounted rows | ${stream.mountedRows} / ${stream.maxMountedRows} | Recorded |
| Scroll corrections | ${stream.scrollCorrections} (max ${stream.maxScrollCorrectionPx.toFixed(2)} px) | Recorded |
| Average FPS | ${stream.averageFps.toFixed(2)} | >= ${stream.thresholds.minimumFps} (${pass(stream.averageFps >= stream.thresholds.minimumFps)}) |
| Sampled / slow frames | ${stream.sampledFrames} / ${stream.slowFrames} | Recorded |
| Long tasks | ${stream.longTasks.count}, ${stream.longTasks.totalMs.toFixed(2)} ms total, ${stream.longTasks.maxMs.toFixed(2)} ms max | <= ${stream.thresholds.maximumLongTaskCount} (${pass(stream.longTasks.count <= stream.thresholds.maximumLongTaskCount)}) |
| Long-task share | ${(stream.longTaskShare * 100).toFixed(2)}% | <= ${(stream.thresholds.maximumLongTaskShare * 100).toFixed(2)}% (${pass(stream.longTaskShare <= stream.thresholds.maximumLongTaskShare)}) |

## 500-Message Replay

| Metric | Result | Gate |
| --- | ---: | --- |
| Messages / Turns / Timeline rows | ${replay.messageCount} / ${replay.turnCount} / ${replay.totalRows} | 500-message fixture |
| Canonical replay duration | ${replay.replayDurationMs.toFixed(2)} ms | Recorded |
| Initial interactive duration | ${replay.initialInteractiveMs} ms | Recorded |
| Mounted rows | ${replay.mountedRows} | < 80 and < ${replay.totalRows} (${pass(replay.mountedRows < 80 && replay.mountedRows < replay.totalRows)}) |
| Max mounted rows | ${replay.maxMountedRows} | < 80 (${pass(replay.maxMountedRows < 80)}) |

## Provenance

The collector ran the existing Electron fixture tests and required both the \`timeline-performance\` and \`timeline-dom-performance\` payloads before writing this report. The JSON and Markdown live outside Playwright's \`test-results\` directory, so later test cleanup does not overwrite this captured evidence.
`;
}

function environmentEvidence() {
  const packageJson = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
  const cpuList = cpus();
  return {
    node: process.version,
    electron: packageJson.devDependencies?.electron ?? packageJson.dependencies?.electron ?? 'unknown',
    playwright: packageJson.devDependencies?.['@playwright/test'] ?? packageJson.dependencies?.['@playwright/test'] ?? 'unknown',
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpuModel: cpuList[0]?.model?.trim() || 'unknown',
      logicalCpuCount: cpuList.length,
      totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
    },
  };
}

function buildEvidence(streamPayload, replayPayload) {
  const snapshot = streamPayload.snapshot;
  if (!snapshot || typeof snapshot !== 'object') fail('timeline-performance payload has no metrics snapshot');
  if (!streamPayload.fixture || !streamPayload.thresholds) fail('timeline-performance fixture metadata is missing');
  if (!replayPayload || replayPayload.messageCount !== 500) fail('500-message DOM performance payload is missing');

  const source = {
    gitHead: commandOutput('git', ['rev-parse', 'HEAD']),
    branch: commandOutput('git', ['branch', '--show-current']) || 'detached',
    workingTreeDirty: commandOutput('git', ['status', '--porcelain']).length > 0,
    performanceSpec: PERFORMANCE_SPEC,
    playwrightGrep: PERFORMANCE_GREP,
  };
  return validateEvidence({
    schemaVersion: 1,
    kind: 'clawx-chat-timeline-performance',
    status: 'passed',
    generatedAt: new Date().toISOString(),
    source,
    environment: environmentEvidence(),
    streaming: {
      fixture: {
        frames: streamPayload.fixture.frames,
        eventsPerFrame: streamPayload.fixture.eventsPerFrame,
        elapsedMs: streamPayload.fixture.elapsedMs,
      },
      thresholds: streamPayload.thresholds,
      ingressEvents: snapshot.ingressEvents,
      adapter: durationMetric(snapshot.adapter, 'timeline-performance.snapshot.adapter'),
      reducer: durationMetric(snapshot.reducer, 'timeline-performance.snapshot.reducer'),
      projection: durationMetric(snapshot.projection, 'timeline-performance.snapshot.projection'),
      storeCommits: snapshot.storeCommits,
      maxStoreCommitsPerFrame: snapshot.maxStoreCommitsPerFrame,
      itemRenders: snapshot.itemRenders,
      completedTurnRenders: streamPayload.completedTurnRenders,
      activeTurnRenders: streamPayload.activeTurnRenders,
      mountedRows: snapshot.mountedRows,
      maxMountedRows: snapshot.maxMountedRows,
      scrollCorrections: snapshot.scrollCorrections,
      maxScrollCorrectionPx: snapshot.maxScrollCorrectionPx,
      longTaskObserverSupported: snapshot.longTaskObserverSupported,
      longTasks: durationMetric(snapshot.longTasks, 'timeline-performance.snapshot.longTasks'),
      longTaskShare: streamPayload.longTaskShare,
      sampledFrames: snapshot.sampledFrames,
      slowFrames: snapshot.slowFrames,
      averageFps: snapshot.averageFps,
    },
    historyReplay500: {
      messageCount: replayPayload.messageCount,
      turnCount: replayPayload.turnCount,
      totalRows: replayPayload.totalRows,
      mountedRows: replayPayload.mountedRows,
      maxMountedRows: replayPayload.maxMountedRows,
      initialInteractiveMs: replayPayload.initialInteractiveMs,
      replayDurationMs: replayPayload.historyReplayMs,
    },
  });
}

function writeEvidence(evidence) {
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  const markdown = renderMarkdown(evidence);
  const jsonTemp = `${EVIDENCE_JSON}.tmp`;
  const markdownTemp = `${EVIDENCE_MARKDOWN}.tmp`;
  mkdirSync(dirname(EVIDENCE_JSON), { recursive: true });
  try {
    writeFileSync(jsonTemp, json);
    writeFileSync(markdownTemp, markdown);
    renameSync(jsonTemp, EVIDENCE_JSON);
    renameSync(markdownTemp, EVIDENCE_MARKDOWN);
  } finally {
    rmSync(jsonTemp, { force: true });
    rmSync(markdownTemp, { force: true });
  }
}

function collect({ skipBuild }) {
  if (!skipBuild) {
    run(PNPM, ['run', 'build:vite'], { stdio: 'inherit' });
  }
  const result = run(PNPM, [
    'exec',
    'playwright',
    'test',
    PERFORMANCE_SPEC,
    '--grep',
    PERFORMANCE_GREP,
    '--workers=1',
    '--reporter=line',
  ]);
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  process.stdout.write(output);

  const streamPayloads = parseMarkerOutput(output, 'timeline-performance');
  const replayPayloads = parseMarkerOutput(output, 'timeline-dom-performance');
  if (streamPayloads.length === 0) {
    fail('Electron run passed without a timeline-performance payload; no evidence was written');
  }
  const replay500 = replayPayloads.findLast((payload) => payload?.messageCount === 500);
  if (!replay500) {
    fail('Electron run passed without a 500-message timeline-dom-performance payload; no evidence was written');
  }

  const evidence = buildEvidence(streamPayloads.at(-1), replay500);
  writeEvidence(evidence);
  process.stdout.write(`\n[timeline-performance-evidence] wrote ${EVIDENCE_JSON}\n`);
  process.stdout.write(`[timeline-performance-evidence] wrote ${EVIDENCE_MARKDOWN}\n`);
}

function verify() {
  const evidence = validateEvidence(JSON.parse(readFileSync(EVIDENCE_JSON, 'utf8')));
  const expectedMarkdown = renderMarkdown(evidence);
  const actualMarkdown = readFileSync(EVIDENCE_MARKDOWN, 'utf8');
  if (actualMarkdown !== expectedMarkdown) {
    fail('Markdown evidence does not match the validated JSON evidence');
  }
  process.stdout.write(`[timeline-performance-evidence] verified ${EVIDENCE_JSON}\n`);
  process.stdout.write(`[timeline-performance-evidence] verified ${EVIDENCE_MARKDOWN}\n`);
}

const collectMode = process.argv.includes('--collect');
const verifyMode = process.argv.includes('--verify');
if (collectMode === verifyMode) {
  fail('choose exactly one mode: --collect [--skip-build] or --verify');
}

if (collectMode) collect({ skipBuild: process.argv.includes('--skip-build') });
else verify();
