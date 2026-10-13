// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  create: vi.fn(), update: vi.fn(), model: vi.fn(), assign: vi.fn(), list: vi.fn(),
  clear: vi.fn(), deleteAccount: vi.fn(), sync: vi.fn(), syncModel: vi.fn(), repair: vi.fn(),
}));

vi.mock('@electron/utils/agent-config', () => ({
  createAgent: mocks.create, updateAgentName: mocks.update, updateAgentModel: mocks.model,
  assignChannelToAgent: mocks.assign, listAgentsSnapshot: mocks.list, clearChannelBinding: mocks.clear,
  resolveAccountIdForAgent: () => 'default', deleteAgentConfig: vi.fn(), removeAgentWorkspaceDirectory: vi.fn(),
}));
vi.mock('@electron/utils/channel-config', () => ({ deleteChannelAccountConfig: mocks.deleteAccount }));
vi.mock('@electron/utils/openclaw-workspace', () => ({ ensureClawXContext: async () => undefined }));
vi.mock('@electron/services/agent-profile-generation-service', () => ({ generateAgentProfileViaGateway: vi.fn() }));
vi.mock('@electron/services/providers/provider-runtime-sync', () => ({
  syncAllProviderAuthToRuntime: mocks.sync, syncAgentModelOverrideToRuntime: mocks.syncModel,
}));
vi.mock('@electron/services/long-term-rule-service', () => ({
  longTermRuleService: { repair: mocks.repair, unregisterAgent: vi.fn() },
}));

describe('Agent API runtime change detection', () => {
  const snapshot = {
    agents: [{ id: 'main', name: 'Main', workspace: '/tmp/workspace', modelRef: 'openai/new' }],
    defaultAgentId: 'main', defaultModelRef: 'openai/new', configuredChannelTypes: [],
    channelOwners: {}, channelAccountOwners: {}, createdAgentId: 'main',
  };
  let gateway: {
    captureRuntimeConfigFingerprint: ReturnType<typeof vi.fn>;
    getAppliedRuntimeConfigFingerprint: ReturnType<typeof vi.fn>;
    debouncedReload: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetAllMocks();
    gateway = {
      captureRuntimeConfigFingerprint: vi.fn().mockResolvedValue('same'),
      getAppliedRuntimeConfigFingerprint: vi.fn().mockReturnValue('same'),
      debouncedReload: vi.fn(),
    };
    mocks.create.mockResolvedValue(snapshot);
    mocks.update.mockResolvedValue(snapshot);
    mocks.model.mockResolvedValue(snapshot);
    mocks.assign.mockResolvedValue(snapshot);
    mocks.list.mockResolvedValue(snapshot);
    mocks.sync.mockResolvedValue(undefined);
    mocks.syncModel.mockResolvedValue(undefined);
    mocks.repair.mockResolvedValue(undefined);
  });

  async function api() {
    const { createAgentsApi } = await import('@electron/services/agents-api');
    return createAgentsApi({ gatewayManager: gateway as never });
  }

  it('does not reload merely because agent creation and credential sync succeeded', async () => {
    await (await api()).create({ name: 'Main' });
    expect(mocks.sync).toHaveBeenCalledWith({ reconcileManagedRuntime: true });
    expect(gateway.captureRuntimeConfigFingerprint).toHaveBeenCalledTimes(2);
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('requests one refresh after creation actually changes config and credential sync completes', async () => {
    gateway.captureRuntimeConfigFingerprint.mockResolvedValueOnce('before').mockResolvedValueOnce('after');
    await (await api()).create({ name: 'Main' });
    expect(gateway.debouncedReload).toHaveBeenCalledExactlyOnceWith(undefined, 'create-agent', 'after');
    expect(mocks.sync.mock.invocationCallOrder[0]).toBeLessThan(gateway.debouncedReload.mock.invocationCallOrder[0]);
  });

  it('does not reload a partially synchronized new agent', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.sync.mockRejectedValueOnce(new Error('managed synchronization blocked'));
    await (await api()).create({ name: 'Main' });
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    expect(gateway.captureRuntimeConfigFingerprint).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it('does not reload for a same-name update or a no-op model synchronization', async () => {
    const services = await api();
    await services.update({ id: 'main', name: 'Main' });
    await services.updateModel({ id: 'main', modelRef: 'openai/new' });
    expect(mocks.syncModel).toHaveBeenCalledWith('main');
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('refreshes changed model config/catalogs exactly once after both sync steps', async () => {
    gateway.captureRuntimeConfigFingerprint.mockResolvedValueOnce('before').mockResolvedValueOnce('new-model');
    await (await api()).updateModel({ id: 'main', modelRef: 'openai/new' });
    expect(gateway.debouncedReload).toHaveBeenCalledExactlyOnceWith(undefined, 'update-agent-model', 'new-model');
    expect(mocks.syncModel.mock.invocationCallOrder[0]).toBeLessThan(gateway.debouncedReload.mock.invocationCallOrder[0]);
  });

  it('retries applying an unchanged disk generation when the running Gateway still has older config', async () => {
    gateway.getAppliedRuntimeConfigFingerprint.mockReturnValue('older-applied');
    await (await api()).updateModel({ id: 'main', modelRef: 'openai/new' });
    expect(gateway.debouncedReload).toHaveBeenCalledExactlyOnceWith(undefined, 'update-agent-model', 'same');
  });

  it('refreshes an unchanged disk generation when the applied generation is unknown', async () => {
    gateway.getAppliedRuntimeConfigFingerprint.mockReturnValue(null);
    await (await api()).updateModel({ id: 'main', modelRef: 'openai/new' });
    expect(gateway.debouncedReload).toHaveBeenCalledExactlyOnceWith(undefined, 'update-agent-model', 'same');
  });

  it('does not refresh changed model config if targeted runtime synchronization fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mocks.syncModel.mockRejectedValueOnce(new Error('sync failed'));
    await (await api()).updateModel({ id: 'main', modelRef: 'openai/new' });
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
    warning.mockRestore();
  });

  it('does not reload an unchanged channel binding or removal with no owned accounts', async () => {
    const services = await api();
    await services.assignChannel({ id: 'main', channelType: 'feishu' });
    await services.removeChannel({ id: 'main', channelType: 'feishu' });
    expect(mocks.deleteAccount).not.toHaveBeenCalled();
    expect(gateway.debouncedReload).not.toHaveBeenCalled();
  });

  it('refreshes a changed binding with its call-site reason', async () => {
    gateway.captureRuntimeConfigFingerprint.mockResolvedValueOnce('before').mockResolvedValueOnce('new-binding');
    await (await api()).assignChannel({ id: 'main', channelType: 'feishu' });
    expect(gateway.debouncedReload).toHaveBeenCalledExactlyOnceWith(undefined, 'assign-channel', 'new-binding');
  });

  it('does not mistake an unreadable snapshot for an unchanged generation', async () => {
    gateway.captureRuntimeConfigFingerprint.mockResolvedValue(null);
    await (await api()).update({ id: 'main', name: 'Main' });
    expect(gateway.debouncedReload).toHaveBeenCalledExactlyOnceWith(undefined, 'update-agent', undefined);
  });
});
