import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importPaths() {
  vi.resetModules();
  return await import('@electron/utils/paths');
}

describe('OpenClaw path helpers', () => {
  const root = join(tmpdir(), `uclaw-paths-${Math.random().toString(36).slice(2)}`);

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers OPENCLAW_STATE_DIR for portable OpenClaw data', async () => {
    const stateDir = join(root, 'UClawData', 'openclaw-home', '.openclaw');
    vi.stubEnv('OPENCLAW_HOME', join(root, 'UClawData', 'openclaw-home'));
    vi.stubEnv('OPENCLAW_STATE_DIR', stateDir);
    vi.stubEnv('OPENCLAW_CONFIG_PATH', join(root, 'elsewhere', 'openclaw.json'));

    const {
      getOpenClawAgentsDir,
      getOpenClawConfigDir,
      getOpenClawConfigPath,
      getOpenClawExtensionsDir,
      getOpenClawMediaDir,
      getOpenClawSkillsDir,
    } = await importPaths();

    expect(getOpenClawConfigDir()).toBe(stateDir);
    expect(getOpenClawConfigPath()).toBe(join(root, 'elsewhere', 'openclaw.json'));
    expect(getOpenClawSkillsDir()).toBe(join(stateDir, 'skills'));
    expect(getOpenClawExtensionsDir()).toBe(join(stateDir, 'extensions'));
    expect(getOpenClawAgentsDir()).toBe(join(stateDir, 'agents'));
    expect(getOpenClawMediaDir()).toBe(join(stateDir, 'media'));
  });

  it('derives the config directory from OPENCLAW_CONFIG_PATH when state dir is unset', async () => {
    const configPath = join(root, 'config-dir', 'openclaw.json');
    vi.stubEnv('OPENCLAW_CONFIG_PATH', configPath);

    const { getOpenClawConfigDir, getOpenClawConfigPath } = await importPaths();

    expect(getOpenClawConfigDir()).toBe(join(root, 'config-dir'));
    expect(getOpenClawConfigPath()).toBe(configPath);
  });

  it('expands OPENCLAW_CONFIG_PATH against the effective OpenClaw home', async () => {
    const openclawHome = join(root, 'config-home');
    vi.stubEnv('OPENCLAW_HOME', openclawHome);
    vi.stubEnv('OPENCLAW_CONFIG_PATH', '~/.openclaw/openclaw.json');

    const { getOpenClawConfigDir, getOpenClawConfigPath } = await importPaths();

    expect(getOpenClawConfigDir()).toBe(join(openclawHome, '.openclaw'));
    expect(getOpenClawConfigPath()).toBe(join(openclawHome, '.openclaw', 'openclaw.json'));
  });

  it('uses OPENCLAW_HOME as the fallback OpenClaw home root', async () => {
    const openclawHome = join(root, 'openclaw-home');
    vi.stubEnv('OPENCLAW_HOME', openclawHome);

    const {
      expandPath,
      expandOpenClawPath,
      getOpenClawConfigDir,
      getOpenClawConfigPath,
      resolveOpenClawEffectiveHomeDir,
      resolveOpenClawHomeDir,
    } = await importPaths();

    expect(resolveOpenClawHomeDir()).toBe(openclawHome);
    expect(resolveOpenClawEffectiveHomeDir()).toBe(openclawHome);
    expect(getOpenClawConfigDir()).toBe(join(openclawHome, '.openclaw'));
    expect(getOpenClawConfigPath()).toBe(join(openclawHome, '.openclaw', 'openclaw.json'));
    expect(expandOpenClawPath('~/.openclaw/workspace')).toBe(join(openclawHome, '.openclaw', 'workspace'));
    expect(expandPath('~/.openclaw/workspace')).not.toBe(join(openclawHome, '.openclaw', 'workspace'));
  });

  it('resolves OPENCLAW_HOME values that are relative to the OS home', async () => {
    const osHome = join(root, 'os-home');
    vi.stubEnv('HOME', osHome);
    vi.stubEnv('OPENCLAW_HOME', '~/portable-openclaw');

    const { expandOpenClawPath, resolveOpenClawEffectiveHomeDir } = await importPaths();

    expect(resolveOpenClawEffectiveHomeDir()).toBe(join(osHome, 'portable-openclaw'));
    expect(expandOpenClawPath('~/.openclaw/agents/main/agent')).toBe(
      join(osHome, 'portable-openclaw', '.openclaw', 'agents', 'main', 'agent'),
    );
  });

  it('keeps normal tilde expansion on the OS home when OPENCLAW_HOME is unset', async () => {
    const osHome = join(root, 'normal-home');
    vi.stubEnv('HOME', osHome);

    const { expandPath, resolveOpenClawHomeDir } = await importPaths();

    expect(resolveOpenClawHomeDir()).toBe(osHome);
    expect(expandPath('~/Downloads')).toBe(join(osHome, 'Downloads'));
  });
});
