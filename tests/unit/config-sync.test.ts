import { app } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { stripSystemdSupervisorEnv } from '@electron/gateway/config-sync-env';
import {
  buildPluginMaintenanceCacheKey,
  buildRuntimeDepsCleanupCacheKey,
  buildSkillsSymlinkCleanupCacheKey,
} from '@electron/gateway/config-sync';

describe('stripSystemdSupervisorEnv', () => {
  it('removes systemd supervisor marker env vars', () => {
    const env = {
      PATH: '/usr/bin:/bin',
      OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service',
      INVOCATION_ID: 'abc123',
      SYSTEMD_EXEC_PID: '777',
      JOURNAL_STREAM: '8:12345',
      OTHER: 'keep-me',
    };

    const result = stripSystemdSupervisorEnv(env);

    expect(result).toEqual({
      PATH: '/usr/bin:/bin',
      OTHER: 'keep-me',
    });
  });

  it('keeps unrelated variables unchanged', () => {
    const env = {
      NODE_ENV: 'production',
      OPENCLAW_GATEWAY_TOKEN: 'token',
      CLAWDBOT_SKIP_CHANNELS: '0',
    };

    expect(stripSystemdSupervisorEnv(env)).toEqual(env);
  });

  it('does not mutate source env object', () => {
    const env = {
      OPENCLAW_SYSTEMD_UNIT: 'openclaw-gateway.service',
      VALUE: '1',
    };
    const before = { ...env };

    const result = stripSystemdSupervisorEnv(env);

    expect(env).toEqual(before);
    expect(result).toEqual({ VALUE: '1' });
  });
});

describe('gateway prelaunch maintenance cache keys', () => {
  it('keeps plugin maintenance cache stable across app version changes', () => {
    vi.mocked(app.getVersion).mockReturnValueOnce('0.7.0');
    const first = buildPluginMaintenanceCacheKey([]);

    vi.mocked(app.getVersion).mockReturnValueOnce('0.7.1');
    const second = buildPluginMaintenanceCacheKey([]);

    expect(second).toBe(first);
  });

  it('keeps cleanup cache keys independent of app version changes', () => {
    vi.mocked(app.getVersion).mockReturnValueOnce('0.7.0');
    const firstSkills = buildSkillsSymlinkCleanupCacheKey();
    const firstRuntimeDeps = buildRuntimeDepsCleanupCacheKey();

    vi.mocked(app.getVersion).mockReturnValueOnce('0.7.1');
    const secondSkills = buildSkillsSymlinkCleanupCacheKey();
    const secondRuntimeDeps = buildRuntimeDepsCleanupCacheKey();

    expect(secondSkills).toBe(firstSkills);
    expect(secondRuntimeDeps).toBe(firstRuntimeDeps);
  });

  it('changes plugin maintenance cache when configured channels change', () => {
    expect(buildPluginMaintenanceCacheKey([])).not.toBe(
      buildPluginMaintenanceCacheKey(['feishu']),
    );
  });
});
