// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  captureChannelStartupSnapshot: vi.fn(),
  readOpenClawConfig: vi.fn(),
  ensurePluginInstalled: vi.fn(),
  removeManagedPluginInstall: vi.fn(),
  repairTrustedOfficialPluginInstallRecords: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getVersion: () => '0.0.0-test',
    isPackaged: true,
  },
}));

vi.mock('@electron/utils/store', () => ({ getAllSettings: vi.fn() }));
vi.mock('@electron/utils/secure-storage', () => ({
  getApiKey: vi.fn(),
  getDefaultProvider: vi.fn(),
  getProvider: vi.fn(),
}));
vi.mock('@electron/utils/provider-registry', () => ({
  getProviderEnvVar: vi.fn(),
  getKeyableProviderTypes: vi.fn(() => []),
}));
vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => '/tmp/openclaw-config',
  getOpenClawDir: () => '/tmp/openclaw-runtime',
  getOpenClawEntryPath: () => '/tmp/openclaw-runtime/openclaw.mjs',
  getOpenClawResolvedDir: () => '/tmp/openclaw-runtime',
  getOpenClawSkillsDir: () => '/tmp/openclaw-config/skills',
  isOpenClawPresent: () => true,
}));
vi.mock('@electron/utils/uv-env', () => ({ getUvMirrorEnv: vi.fn(async () => ({})) }));
vi.mock('@electron/utils/channel-config', () => ({
  captureChannelStartupSnapshot: mocks.captureChannelStartupSnapshot,
  readOpenClawConfig: mocks.readOpenClawConfig,
}));
vi.mock('@electron/utils/openclaw-auth', () => ({
  REQUIRED_UCLAW_RUNTIME_PLUGIN_IDS: [],
  sanitizeOpenClawConfig: vi.fn(async () => undefined),
  batchSyncConfigFields: vi.fn(async () => undefined),
}));
vi.mock('@electron/utils/proxy', () => ({
  buildProxyEnv: vi.fn(() => ({})),
  resolveProxySettings: vi.fn(() => ({ httpProxy: '', httpsProxy: '', allProxy: '' })),
}));
vi.mock('@electron/utils/openclaw-proxy', () => ({
  syncProxyConfigToOpenClaw: vi.fn(async () => undefined),
}));
vi.mock('@electron/utils/logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@electron/utils/env-path', () => ({
  prependPathEntry: vi.fn((env: Record<string, string | undefined>) => ({ env })),
}));
vi.mock('@electron/utils/plugin-install', () => ({
  buildCandidateSources: vi.fn((pluginId: string) => [`/bundled/${pluginId}`]),
  cleanupStalePluginInstallArtifacts: vi.fn(async () => undefined),
  ensureParallelPluginInstalled: vi.fn(async () => ({ installed: true })),
  ensurePluginInstalled: mocks.ensurePluginInstalled,
  findBestBundledPluginSource: vi.fn(async (sources: string[]) => sources[0] ?? null),
  findMissingPluginRuntimeDependencies: vi.fn(async () => []),
  removeManagedPluginInstall: mocks.removeManagedPluginInstall,
  repairTrustedOfficialPluginInstallRecords: mocks.repairTrustedOfficialPluginInstallRecords,
}));
vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: vi.fn(() => 'https://example.test'),
  isUclawManagedDistribution: vi.fn(() => false),
  UCLAW_AUTH_ACCOUNT_ID: 'uclaw-auth',
  UCLAW_COMPATIBILITY_PROVIDER_ID: 'lingzhiwuxian',
  UCLAW_PROVIDER_ID: 'openai',
}));
vi.mock('@electron/utils/uclaw-request-diagnostics', () => ({
  getUclawDiagnosticHeaders: vi.fn(() => ({})),
}));
vi.mock('@electron/services/providers/provider-store', () => ({ getProviderAccount: vi.fn() }));
vi.mock('@electron/services/providers/provider-mutation-lock', () => ({
  isUclawManagedAccount: vi.fn(() => false),
  resolveValidUclawManagedRelayPairToken: vi.fn(),
  withProviderMutationLock: vi.fn((task: () => Promise<unknown>) => task()),
}));
vi.mock('@electron/services/secrets/secret-store', () => ({ getProviderSecret: vi.fn() }));
vi.mock('@electron/services/blender/bridge-server', () => ({
  getBlenderBridgeEnvironment: vi.fn(() => ({})),
}));
vi.mock('@electron/gateway/skills-symlink-cleanup', () => ({
  cleanupAgentsSymlinkedSkills: vi.fn(async () => ({ failed: 0 })),
  cleanupStalePluginRuntimeDeps: vi.fn(async () => ({ failed: 0 })),
}));
vi.mock('@electron/gateway/prelaunch-maintenance-cache', () => ({
  buildPrelaunchMaintenanceCacheKey: vi.fn((value: unknown) => JSON.stringify(value)),
}));
vi.mock('@electron/gateway/async-prelaunch-maintenance-cache', () => ({
  directoryChildrenSignatureAsync: vi.fn(async () => 'children'),
  directoryTreeSignatureAsync: vi.fn(async () => 'tree'),
  pathSignatureAsync: vi.fn(async () => 'path'),
  runCachedPrelaunchMaintenanceTaskAsync: vi.fn(async (
    _taskName: string,
    getCacheKey: () => Promise<string>,
    task: () => Promise<boolean>,
  ) => {
    await getCacheKey();
    return { status: 'executed', succeeded: await task() };
  }),
  scheduleCachedPrelaunchMaintenanceTaskAsync: vi.fn(() => ({
    scheduled: true,
    completion: Promise.resolve({ executed: false, reason: 'cache-hit' }),
  })),
}));

import { syncGatewayConfigBeforeLaunch } from '@electron/gateway/config-sync';

const appSettings = {
  gatewayToken: 'gateway-token',
  proxyEnabled: false,
} as Parameters<typeof syncGatewayConfigBeforeLaunch>[0];

describe('Gateway channel startup config sync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readOpenClawConfig.mockResolvedValue({});
    mocks.ensurePluginInstalled.mockResolvedValue({ installed: true });
    mocks.removeManagedPluginInstall.mockResolvedValue({ removed: true, preserved: false });
    mocks.repairTrustedOfficialPluginInstallRecords.mockResolvedValue(undefined);
  });

  it('upgrades configured plugins before removing unconfigured plugins from one snapshot', async () => {
    mocks.captureChannelStartupSnapshot.mockResolvedValue({
      config: { channels: { wecom: { enabled: true } } },
      configuredChannels: ['wecom'],
      cleanedDanglingWeChatState: false,
    });

    const result = await syncGatewayConfigBeforeLaunch(appSettings, '/tmp/openclaw-runtime');

    expect(mocks.captureChannelStartupSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePluginInstalled).toHaveBeenCalledWith(
      'wecom',
      ['/bundled/wecom'],
      'wecom',
      { deferTrustedRecordSync: true },
    );
    expect(mocks.removeManagedPluginInstall).not.toHaveBeenCalledWith(
      'wecom',
      expect.objectContaining({ operation: 'remove-unconfigured-channel' }),
    );
    expect(mocks.ensurePluginInstalled.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.removeManagedPluginInstall.mock.invocationCallOrder[0],
    );
    expect(result.skipChannels).toBe(false);
    expect(result.channelStartupSummary).toBe('enabled(wecom)');
  });

  it('upgrades the configured image plugin without legacy ownership options', async () => {
    mocks.captureChannelStartupSnapshot.mockResolvedValue({
      config: {
        agents: {
          defaults: {
            imageGenerationModel: { primary: 'clawx-openai-image/gpt-image-2' },
          },
        },
      },
      configuredChannels: [],
      cleanedDanglingWeChatState: false,
    });

    await syncGatewayConfigBeforeLaunch(appSettings, '/tmp/openclaw-runtime');

    expect(mocks.ensurePluginInstalled).toHaveBeenCalledWith(
      'clawx-openai-image',
      ['/bundled/clawx-openai-image'],
      'UClaw OpenAI Image',
      { deferTrustedRecordSync: true },
    );
  });

  it('preserves plugins and keeps channel loading enabled when snapshot parsing fails', async () => {
    mocks.captureChannelStartupSnapshot.mockRejectedValue(new SyntaxError('malformed openclaw.json'));

    const result = await syncGatewayConfigBeforeLaunch(appSettings, '/tmp/openclaw-runtime');

    expect(mocks.ensurePluginInstalled).not.toHaveBeenCalled();
    expect(mocks.removeManagedPluginInstall).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ operation: 'remove-unconfigured-channel' }),
    );
    expect(result.configuredChannels).toEqual([]);
    expect(result.skipChannels).toBe(false);
    expect(result.channelStartupSummary).toBe('enabled(unknown)');
  });
});
