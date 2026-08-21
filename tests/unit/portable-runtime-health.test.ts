// @vitest-environment node

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PortableRuntimeHealthMonitor,
  PORTABLE_RUNTIME_FAILURE_WARNING_THRESHOLD,
} from '@electron/utils/portable-runtime-health';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createMarker(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'uclaw-portable-runtime-health-'));
  tempDirs.push(directory);
  const markerPath = join(directory, '.uclaw-runtime-state.json');
  await writeFile(markerPath, JSON.stringify({
    schema: 'uclaw.portable-runtime-state/v1',
    preparedAt: '2026-08-19T00:00:00.000Z',
  }));
  return markerPath;
}

describe('portable runtime health', () => {
  it('shows a repeated-defer warning and deduplicates duplicate attempt events', async () => {
    const markerPath = await createMarker();
    const changes: unknown[] = [];
    const monitor = new PortableRuntimeHealthMonitor({
      markerPath,
      failureWarningThreshold: PORTABLE_RUNTIME_FAILURE_WARNING_THRESHOLD,
      onChange: snapshot => changes.push(snapshot),
    });

    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 1 });
    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 1 });
    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 2 });
    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 3 });

    expect(monitor.getSnapshot()).toMatchObject({
      status: 'warning',
      issue: 'snapshot-not-completed',
      consecutiveFailures: 3,
    });
    expect(changes).toHaveLength(3);
  });

  it('clears a visible warning after a completed snapshot', async () => {
    const markerPath = await createMarker();
    const monitor = new PortableRuntimeHealthMonitor({ markerPath });

    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 1 });
    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 2 });
    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 3 });
    monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-completed' });

    expect(monitor.getSnapshot()).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
    });
    expect(monitor.getSnapshot().issue).toBeUndefined();
  });

  it('contains health delivery failures without changing snapshot accounting', async () => {
    const markerPath = await createMarker();
    const monitor = new PortableRuntimeHealthMonitor({
      markerPath,
      onChange: () => { throw new Error('renderer unavailable'); },
    });

    expect(() => monitor.start()).not.toThrow();
    expect(() => {
      monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 1 });
      monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 2 });
      monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-deferred', attempt: 3 });
    }).not.toThrow();
    expect(monitor.getSnapshot()).toMatchObject({
      status: 'warning',
      issue: 'snapshot-not-completed',
      consecutiveFailures: 3,
    });

    expect(() => monitor.observeSnapshotEvent({ event: 'portable-runtime-snapshot-completed' })).not.toThrow();
    expect(monitor.getSnapshot()).toMatchObject({ status: 'healthy', consecutiveFailures: 0 });
    monitor.stop();
  });
});
