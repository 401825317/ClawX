import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ensureJunFeiAIManagedRuntimeBootstrap,
  type ManagedRuntimeBootstrapDependencies,
} from '../electron/services/junfeiai/managed-runtime-bootstrap.ts';

function dependencies(overrides: Partial<ManagedRuntimeBootstrapDependencies> = {}) {
  let migrated = false;
  const calls: string[] = [];
  const value: ManagedRuntimeBootstrapDependencies = {
    isMigrated: async () => {
      calls.push('isMigrated');
      return migrated;
    },
    migrate: async () => {
      calls.push('migrate');
      migrated = true;
    },
    ensureImage: async () => {
      calls.push('ensureImage');
    },
    ensureVideo: async () => {
      calls.push('ensureVideo');
    },
    ...overrides,
  };
  return { value, calls, setMigrated: (next: boolean) => { migrated = next; } };
}

test('fresh managed runtime migrates before media providers are initialized', async () => {
  const fixture = dependencies();
  const result = await ensureJunFeiAIManagedRuntimeBootstrap(fixture.value);

  assert.deepEqual(result, { ready: true, migratedNow: true });
  assert.deepEqual(fixture.calls, [
    'isMigrated',
    'migrate',
    'isMigrated',
    'ensureImage',
    'ensureVideo',
  ]);
});

test('existing migrated runtime only heals media providers', async () => {
  const fixture = dependencies();
  fixture.setMigrated(true);
  const result = await ensureJunFeiAIManagedRuntimeBootstrap(fixture.value);

  assert.deepEqual(result, { ready: true, migratedNow: false });
  assert.deepEqual(fixture.calls, ['isMigrated', 'ensureImage', 'ensureVideo']);
});

test('migration failures are surfaced and skip media writes', async () => {
  const fixture = dependencies({
    migrate: async () => {
      fixture.calls.push('migrate');
      throw new Error('managed_openai_runtime_conflict: personal endpoint');
    },
  });

  await assert.rejects(
    () => ensureJunFeiAIManagedRuntimeBootstrap(fixture.value),
    /managed_openai_runtime_conflict/,
  );
  assert.deepEqual(fixture.calls, ['isMigrated', 'migrate']);
});
