import { describe, expect, it } from 'vitest';
import {
  buildManagedOpenAiProviderEnv,
  shouldInjectProviderEnv,
  stripManagedProviderEnv,
  stripSystemdSupervisorEnv,
  UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
} from '@electron/gateway/config-sync-env';

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

describe('managed Gateway provider environment', () => {
  it('removes an inherited OpenAI key without mutating the parent environment', () => {
    const env = {
      OpenAi_Api_Key: 'parent-openai-key',
      codex_api_key: 'parent-codex-key',
      openai_api_keys: 'parent-openai-key-list',
      OpenClaw_Live_OpenAI_Key: 'parent-live-openai-key',
      OPENAI_API_KEY_1: 'parent-rotation-key-1',
      openai_api_key_backup: 'parent-rotation-key-2',
      OPENAI_API_KEYSTONE: 'keep-similar-key',
      DEEPSEEK_API_KEY: 'keep-deepseek-key',
    };

    const result = stripManagedProviderEnv(env, true);

    expect(result).toEqual({
      OPENAI_API_KEYSTONE: 'keep-similar-key',
      DEEPSEEK_API_KEY: 'keep-deepseek-key',
    });
    expect(env).toEqual({
      OpenAi_Api_Key: 'parent-openai-key',
      codex_api_key: 'parent-codex-key',
      openai_api_keys: 'parent-openai-key-list',
      OpenClaw_Live_OpenAI_Key: 'parent-live-openai-key',
      OPENAI_API_KEY_1: 'parent-rotation-key-1',
      openai_api_key_backup: 'parent-rotation-key-2',
      OPENAI_API_KEYSTONE: 'keep-similar-key',
      DEEPSEEK_API_KEY: 'keep-deepseek-key',
    });
  });

  it('preserves the normal environment outside the UClaw managed distribution', () => {
    const env = {
      CODEX_API_KEY: 'local-codex-key',
      OPENAI_API_KEY: 'local-openai-key',
      OPENAI_API_KEYS: 'local-openai-key-list',
      OPENCLAW_LIVE_OPENAI_KEY: 'local-live-openai-key',
      OPENAI_API_KEY_1: 'local-rotation-key',
    };

    expect(stripManagedProviderEnv(env, false)).toEqual(env);
    expect(shouldInjectProviderEnv('CODEX_API_KEY', false)).toBe(true);
    expect(shouldInjectProviderEnv('OPENAI_API_KEY', false)).toBe(true);
  });

  it('blocks both managed OpenAI env aliases before reading Provider secrets', () => {
    expect(shouldInjectProviderEnv('CODEX_API_KEY', true)).toBe(false);
    expect(shouldInjectProviderEnv('Codex_Api_Key', true)).toBe(false);
    expect(shouldInjectProviderEnv('OPENAI_API_KEY', true)).toBe(false);
    expect(shouldInjectProviderEnv('OpenAi_Api_Key', true)).toBe(false);
    expect(shouldInjectProviderEnv('OPENAI_API_KEYS', true)).toBe(false);
    expect(shouldInjectProviderEnv('OPENCLAW_LIVE_OPENAI_KEY', true)).toBe(false);
    expect(shouldInjectProviderEnv('openai_api_key_backup', true)).toBe(false);
    expect(shouldInjectProviderEnv('OPENAI_API_KEYSTONE', true)).toBe(true);
    expect(shouldInjectProviderEnv('DEEPSEEK_API_KEY', true)).toBe(true);
    expect(shouldInjectProviderEnv(undefined, true)).toBe(false);
  });

  it('publishes one current managed credential through both OpenClaw aliases', () => {
    expect(buildManagedOpenAiProviderEnv(' current-relay-token ')).toEqual({
      providerEnv: {
        CODEX_API_KEY: 'current-relay-token',
        OPENAI_API_KEY: 'current-relay-token',
        OPENAI_API_KEYS: 'current-relay-token',
        OPENCLAW_LIVE_OPENAI_KEY: 'current-relay-token',
      },
      loadedProviderKeyCount: 1,
    });
  });

  it('uses one non-empty login sentinel when no managed credential exists', () => {
    expect(buildManagedOpenAiProviderEnv('  ')).toEqual({
      providerEnv: {
        CODEX_API_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENAI_API_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENAI_API_KEYS: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
        OPENCLAW_LIVE_OPENAI_KEY: UCLAW_LOGIN_REQUIRED_PROVIDER_KEY,
      },
      loadedProviderKeyCount: 0,
    });
    expect(UCLAW_LOGIN_REQUIRED_PROVIDER_KEY).not.toBe('');
  });

  it('replaces inherited aliases and leaves unrelated Provider keys unchanged', () => {
    const inherited = stripManagedProviderEnv({
      Codex_Api_Key: 'stale-codex-key',
      openai_api_key: 'stale-openai-key',
      OPENAI_API_KEYS: 'stale-openai-key-list',
      OPENCLAW_LIVE_OPENAI_KEY: 'stale-live-openai-key',
      OPENAI_API_KEY_OLD: 'stale-rotation-key',
      DEEPSEEK_API_KEY: 'keep-deepseek-key',
    }, true);
    const managed = buildManagedOpenAiProviderEnv('current-relay-token');

    expect({ ...inherited, ...managed.providerEnv }).toEqual({
      CODEX_API_KEY: 'current-relay-token',
      OPENAI_API_KEY: 'current-relay-token',
      OPENAI_API_KEYS: 'current-relay-token',
      OPENCLAW_LIVE_OPENAI_KEY: 'current-relay-token',
      DEEPSEEK_API_KEY: 'keep-deepseek-key',
    });
  });
});
