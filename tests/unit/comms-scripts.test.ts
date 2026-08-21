import { spawnSync } from 'node:child_process';
import { access, copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  aggregateMetrics,
  calculateScenarioMetrics,
  isEntrypoint as isReplayEntrypoint,
} from '../../scripts/comms/replay.mjs';
import {
  evaluateReport,
  isEntrypoint as isCompareEntrypoint,
} from '../../scripts/comms/compare.mjs';

const ROOT = process.cwd();
const REPLAY_SCRIPT = path.join(ROOT, 'scripts', 'comms', 'replay.mjs');
const COMPARE_SCRIPT = path.join(ROOT, 'scripts', 'comms', 'compare.mjs');

async function createIsolatedScripts() {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'uclaw-comms-scripts-'));
  const scriptDir = path.join(tempRoot, 'path with spaces', 'scripts', 'comms');
  await mkdir(scriptDir, { recursive: true });

  const replayScript = path.join(scriptDir, 'replay.mjs');
  const compareScript = path.join(scriptDir, 'compare.mjs');
  await Promise.all([
    copyFile(REPLAY_SCRIPT, replayScript),
    copyFile(COMPARE_SCRIPT, compareScript),
  ]);

  return {
    tempRoot,
    replayScript,
    compareScript,
    outputDir: path.join(tempRoot, 'path with spaces', 'artifacts', 'comms'),
  };
}

function buildPassingScenarioMetrics() {
  return {
    duplicate_event_rate: 0,
    event_fanout_ratio: 1,
    history_inflight_max: 1,
    history_load_qps: 0.3,
    rpc_p50_ms: 100,
    rpc_p95_ms: 150,
    rpc_timeout_rate: 0,
    gateway_reconnect_count: 0,
    message_loss_count: 0,
    message_order_violation_count: 0,
  };
}

describe('comms scripts', () => {
  it.each([
    ['replay', isReplayEntrypoint, 'replay.mjs'],
    ['compare', isCompareEntrypoint, 'compare.mjs'],
  ])('matches %s as a Windows entrypoint using file URL semantics', (_name, predicate, fileName) => {
    const entryPath = `C:\\UClaw Workspace\\scripts\\comms\\${fileName}`;
    const moduleUrl = pathToFileURL(entryPath, { windows: true }).href;

    expect(predicate(moduleUrl, entryPath.toLowerCase(), 'win32')).toBe(true);
    expect(predicate(moduleUrl, `C:\\other\\${fileName}`, 'win32')).toBe(false);
  });

  it.each([
    ['replay', isReplayEntrypoint, 'replay.mjs'],
    ['compare', isCompareEntrypoint, 'compare.mjs'],
  ])('matches %s as a POSIX entrypoint using file URL semantics', (_name, predicate, fileName) => {
    const entryPath = `/opt/UClaw Workspace/scripts/comms/${fileName}`;
    const moduleUrl = pathToFileURL(entryPath, { windows: false }).href;

    expect(predicate(moduleUrl, entryPath, 'linux')).toBe(true);
    expect(predicate(moduleUrl, `/opt/other/${fileName}`, 'linux')).toBe(false);
  });

  it.each([
    ['replay', isReplayEntrypoint],
    ['compare', isCompareEntrypoint],
  ])('does not treat an empty argv entry as the %s entrypoint', (_name, predicate) => {
    const moduleUrl = 'file:///C:/UClaw/scripts/comms/script.mjs';

    expect(predicate(moduleUrl, undefined, 'win32')).toBe(false);
    expect(predicate(moduleUrl, '', 'win32')).toBe(false);
  });

  it('does not execute either main function when the scripts are imported', async () => {
    const fixture = await createIsolatedScripts();

    try {
      for (const scriptPath of [fixture.replayScript, fixture.compareScript]) {
        const result = spawnSync(
          process.execPath,
          ['--input-type=module', '--eval', `await import(${JSON.stringify(pathToFileURL(scriptPath).href)})`],
          { encoding: 'utf8' },
        );

        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('');
      }

      await expect(access(fixture.outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ['replay', 'replayScript', '[comms:replay] failed:'],
    ['compare', 'compareScript', '[comms:compare] failed:'],
  ])('returns a non-zero exit code when the %s CLI fails', async (_name, scriptKey, expectedError) => {
    const fixture = await createIsolatedScripts();

    try {
      const scriptPath = scriptKey === 'replayScript'
        ? fixture.replayScript
        : fixture.compareScript;
      const result = spawnSync(process.execPath, [scriptPath], { encoding: 'utf8' });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(expectedError);
    } finally {
      await rm(fixture.tempRoot, { recursive: true, force: true });
    }
  });

  it('computes scenario metrics with dedupe and inflight tracking', () => {
    const metrics = calculateScenarioMetrics([
      { ts: 0, type: 'gateway_event', runId: 'r1', sessionKey: 's1', seq: 1, state: 'started', fanout: 1 },
      { ts: 0.2, type: 'gateway_event', runId: 'r1', sessionKey: 's1', seq: 1, state: 'started', fanout: 1 },
      { ts: 0.5, type: 'history_load', sessionKey: 's1', action: 'start' },
      { ts: 0.7, type: 'history_load', sessionKey: 's1', action: 'end' },
      { ts: 1.0, type: 'rpc', latencyMs: 120, timeout: false },
      { ts: 1.5, type: 'message', lost: false, orderViolation: false },
    ]);

    expect(metrics.duplicate_event_rate).toBeCloseTo(0.5, 6);
    expect(metrics.history_inflight_max).toBe(1);
    expect(metrics.rpc_p95_ms).toBe(120);
  });

  it('aggregates multiple scenario metrics deterministically', () => {
    const aggregate = aggregateMetrics([
      { ...buildPassingScenarioMetrics(), rpc_p95_ms: 200 },
      { ...buildPassingScenarioMetrics(), rpc_p95_ms: 400 },
    ]);
    expect(aggregate.rpc_p95_ms).toBe(300);
    expect(aggregate.history_inflight_max).toBe(1);
  });

  it('fails report evaluation when required scenarios are missing', () => {
    const passing = buildPassingScenarioMetrics();
    const current = {
      aggregate: passing,
      scenarios: {
        'happy-path-chat': passing,
      },
    };
    const baseline = { aggregate: passing };
    const result = evaluateReport(current, baseline);

    expect(result.failures.some((f) => f.includes('missing scenario'))).toBe(true);
  });
});
