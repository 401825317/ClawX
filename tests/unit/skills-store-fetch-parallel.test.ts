import { beforeEach, describe, expect, it, vi } from 'vitest';

const hostApiFetchMock = vi.fn();
const rpcMock = vi.fn();

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: (...args: unknown[]) => hostApiFetchMock(...args),
}));

vi.mock('@/stores/gateway', () => ({
  useGatewayStore: {
    getState: () => ({
      rpc: (...args: unknown[]) => rpcMock(...args),
    }),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('skills store local-first fetch', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('starts local and gateway requests together, then returns after local skills load', async () => {
    const gatewayDeferred = deferred<{ skills: Array<Record<string, unknown>> }>();
    const localDeferred = deferred<{ success: boolean; skills: Array<Record<string, unknown>> }>();
    rpcMock.mockReturnValueOnce(gatewayDeferred.promise);
    hostApiFetchMock.mockImplementation((path: unknown) => {
      if (path === '/api/skills/local') return localDeferred.promise;
      return Promise.reject(new Error(`Unexpected path: ${String(path)}`));
    });

    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.setState({ skills: [], loading: false, error: null });

    const fetchPromise = useSkillsStore.getState().fetchSkills();
    await Promise.resolve();

    expect(rpcMock).toHaveBeenCalledWith('skills.status');
    expect(hostApiFetchMock).toHaveBeenCalledWith('/api/skills/local');

    localDeferred.resolve({
      success: true,
      skills: [{ id: 'pdf', name: 'PDF', description: 'local', enabled: true }],
    });

    await expect(fetchPromise).resolves.toBe(true);
    expect(useSkillsStore.getState().skills).toHaveLength(1);
    expect(useSkillsStore.getState().skills[0]).toMatchObject({ id: 'pdf', description: 'local', enabled: true });

    gatewayDeferred.resolve({
      skills: [{ skillKey: 'pdf', description: 'runtime', disabled: false, version: '2.0.0' }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSkillsStore.getState().skills[0]).toMatchObject({
      id: 'pdf',
      description: 'runtime',
      version: '2.0.0',
      enabled: true,
    });
  });

  it('does not append bundled gateway skills that are missing from local scan', async () => {
    const gatewayDeferred = deferred<{ skills: Array<Record<string, unknown>> }>();
    rpcMock.mockReturnValueOnce(gatewayDeferred.promise);
    hostApiFetchMock.mockResolvedValueOnce({ success: true, skills: [] });

    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.setState({ skills: [], loading: false, error: null });

    const fetchPromise = useSkillsStore.getState().fetchSkills();
    await expect(fetchPromise).resolves.toBe(true);

    gatewayDeferred.resolve({
      skills: [
        { skillKey: 'browser-use', slug: 'browser-use', name: 'browser-use', bundled: true, disabled: false },
        { skillKey: 'skill-creator', slug: 'skill-creator', name: 'skill-creator', bundled: true, disabled: false },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSkillsStore.getState().skills.map((skill) => skill.id)).toEqual([]);
  });

  it('does not resurrect gateway-managed skills that are missing from local scan', async () => {
    const gatewayDeferred = deferred<{ skills: Array<Record<string, unknown>> }>();
    rpcMock.mockReturnValueOnce(gatewayDeferred.promise);
    hostApiFetchMock.mockResolvedValueOnce({ success: true, skills: [] });

    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.setState({ skills: [], loading: false, error: null });

    const fetchPromise = useSkillsStore.getState().fetchSkills();
    await expect(fetchPromise).resolves.toBe(true);

    gatewayDeferred.resolve({
      skills: [
        { skillKey: 'agent-browser', slug: 'agent-browser', name: 'agent-browser', source: 'openclaw-managed', disabled: false },
        { skillKey: 'plugin-skill', slug: 'plugin-skill', name: 'plugin-skill', source: 'openclaw-plugin', disabled: false },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSkillsStore.getState().skills.map((skill) => skill.id)).toEqual(['plugin-skill']);
  });

  it('preserves local uninstallable metadata when merging gateway status', async () => {
    const gatewayDeferred = deferred<{ skills: Array<Record<string, unknown>> }>();
    rpcMock.mockReturnValueOnce(gatewayDeferred.promise);
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      skills: [{
        id: 'pdf',
        slug: 'pdf',
        name: 'PDF',
        description: 'local preinstalled skill',
        enabled: true,
        source: 'openclaw-managed',
        uninstallable: false,
      }],
    });

    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.setState({ skills: [], loading: false, error: null });

    const fetchPromise = useSkillsStore.getState().fetchSkills();
    await expect(fetchPromise).resolves.toBe(true);

    gatewayDeferred.resolve({
      skills: [{ skillKey: 'pdf', slug: 'pdf', name: 'PDF', source: 'openclaw-managed', disabled: false, version: '2.0.0' }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSkillsStore.getState().skills[0]).toMatchObject({
      id: 'pdf',
      version: '2.0.0',
      uninstallable: false,
    });
  });

  it('preserves localized local description for installed ClawHub skills when gateway status arrives later', async () => {
    const gatewayDeferred = deferred<{ skills: Array<Record<string, unknown>> }>();
    rpcMock.mockReturnValueOnce(gatewayDeferred.promise);
    hostApiFetchMock.mockResolvedValueOnce({
      success: true,
      skills: [{
        id: 'assess-me',
        slug: 'assess-me',
        name: 'Assess Me',
        description: '当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态',
        enabled: true,
        source: 'openclaw-managed',
        marketplace: {
          provider: 'clawhub',
          slug: 'assess-me',
          installedVersion: '1.0.0',
        },
      }],
    });

    const { useSkillsStore } = await import('@/stores/skills');
    useSkillsStore.setState({ skills: [], loading: false, error: null });

    const fetchPromise = useSkillsStore.getState().fetchSkills();
    await expect(fetchPromise).resolves.toBe(true);

    gatewayDeferred.resolve({
      skills: [{
        skillKey: 'assess-me',
        slug: 'assess-me',
        name: 'Assess Me',
        description: 'Run this when debugging goes in circles.',
        source: 'openclaw-managed',
        disabled: false,
        version: '1.0.0',
      }],
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(useSkillsStore.getState().skills[0]).toMatchObject({
      id: 'assess-me',
      description: '当调试绕圈、结果混乱时，帮你梳理目标、进度与阻碍，理清认知状态',
      version: '1.0.0',
      enabled: true,
    });
  });
});
