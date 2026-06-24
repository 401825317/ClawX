import { describe, expect, it } from 'vitest';

describe('electron store process options', () => {
  it('injects worker userData cwd only when provided by the utility process env', async () => {
    const {
      getElectronStoreUserDataEnvKey,
      withElectronStoreProcessOptions,
    } = await import('@electron/utils/electron-store-options');
    const envKey = getElectronStoreUserDataEnvKey();
    const original = process.env[envKey];

    try {
      delete process.env[envKey];
      expect(withElectronStoreProcessOptions({ name: 'settings' })).toEqual({ name: 'settings' });

      process.env[envKey] = '/tmp/uclaw-user-data';
      expect(withElectronStoreProcessOptions({ name: 'settings' })).toEqual({
        name: 'settings',
        cwd: '/tmp/uclaw-user-data',
      });

      expect(withElectronStoreProcessOptions({ name: 'settings', cwd: '/tmp/custom' })).toEqual({
        name: 'settings',
        cwd: '/tmp/custom',
      });
    } finally {
      if (original === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = original;
      }
    }
  });
});
