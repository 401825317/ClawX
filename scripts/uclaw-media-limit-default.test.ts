import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureManagedMediaLimitInConfig } from '../electron/utils/openclaw-auth.ts';

test('managed UClaw config defaults inline media delivery to 16 MiB', () => {
  const config: Record<string, unknown> = {};
  assert.equal(ensureManagedMediaLimitInConfig(config), true);
  assert.equal(
    ((config.agents as Record<string, unknown>).defaults as Record<string, unknown>).mediaMaxMb,
    16,
  );
  assert.equal(ensureManagedMediaLimitInConfig(config), false);
});

test('an explicit user media limit is preserved', () => {
  const config = {
    agents: {
      defaults: {
        mediaMaxMb: 32,
      },
    },
  };
  assert.equal(ensureManagedMediaLimitInConfig(config), false);
  assert.equal(config.agents.defaults.mediaMaxMb, 32);
});
