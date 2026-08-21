import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getRuntimeConfig: vi.fn(),
  init: vi.fn(),
  getClient: vi.fn(),
  makeRendererTransport: vi.fn(),
  transportSend: vi.fn(),
  transportFlush: vi.fn(),
  currentScope: { clear: vi.fn(), clearBreadcrumbs: vi.fn() },
  isolationScope: { clear: vi.fn(), clearBreadcrumbs: vi.fn() },
  clientOptions: {} as Record<string, unknown>,
  activeTransport: null as null | {
    send: (envelope: unknown) => PromiseLike<unknown>;
    flush: (timeout?: number) => PromiseLike<boolean>;
  },
}));

vi.mock('@/lib/host-api', () => ({
  hostApi: {
    settings: { getAll: mocks.getSettings },
    managedClientConfig: { runtimeConfig: mocks.getRuntimeConfig },
  },
}));

vi.mock('@sentry/electron/renderer', () => ({
  init: mocks.init,
  getClient: mocks.getClient,
  makeRendererTransport: mocks.makeRendererTransport,
  getCurrentScope: () => mocks.currentScope,
  getIsolationScope: () => mocks.isolationScope,
  withScope: vi.fn((callback: (scope: { setContext: ReturnType<typeof vi.fn> }) => void) => {
    callback({ setContext: vi.fn() });
  }),
  captureException: vi.fn(),
}));

function enabledRuntimeConfig() {
  return {
    observability: {
      enabled: true,
      rolloutPercentage: 100,
      sentryDsn: 'https://public@sentry.example.test/42',
      tunnelPath: '/api/clawx/observability/envelope',
      crashSampleRate: 1,
      handledErrorSampleRate: 0.2,
      tracesSampleRate: 0.05,
      artifactSampleRate: 0.2,
      maxEventsPerHour: 30,
    },
    features: {
      artifacts: {
        enabled: false,
        rolloutPercentage: 0,
        modelAlias: 'uclaw-artifact-v1',
        policyVersion: 'v1',
      },
      ecommerceMainImage: {
        enabled: false,
        rolloutPercentage: 0,
        skillVersion: 'v1',
      },
    },
  };
}

async function loadObservability() {
  vi.resetModules();
  return import('@/lib/observability');
}

describe('renderer observability synchronization', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    for (const key of Object.keys(mocks.clientOptions)) delete mocks.clientOptions[key];
    mocks.activeTransport = null;
    mocks.getSettings.mockResolvedValue({ telemetryEnabled: true });
    mocks.getRuntimeConfig.mockResolvedValue(enabledRuntimeConfig());
    mocks.getClient.mockReturnValue({ getOptions: () => mocks.clientOptions });
    mocks.transportSend.mockResolvedValue({ statusCode: 200 });
    mocks.transportFlush.mockResolvedValue(true);
    mocks.makeRendererTransport.mockReturnValue({
      send: mocks.transportSend,
      flush: mocks.transportFlush,
    });
    mocks.init.mockImplementation((options: Record<string, unknown>) => {
      Object.assign(mocks.clientOptions, options);
      const createTransport = options.transport as ((input: unknown) => typeof mocks.activeTransport) | undefined;
      mocks.activeTransport = createTransport?.({}) ?? null;
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each([
    undefined,
    {},
    { telemetryEnabled: false },
  ])('defaults local telemetry setting %j to disabled', async (settings) => {
    mocks.getSettings.mockResolvedValue(settings);
    const { syncRendererObservability } = await loadObservability();

    await syncRendererObservability();

    expect(mocks.getRuntimeConfig).not.toHaveBeenCalled();
    expect(mocks.init).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { observability: { enabled: true } },
    {
      ...enabledRuntimeConfig(),
      observability: { ...enabledRuntimeConfig().observability, enabled: false },
    },
    {
      ...enabledRuntimeConfig(),
      observability: {
        ...enabledRuntimeConfig().observability,
        sentryDsn: 'https://public:private@sentry.example.test/42',
      },
    },
    {
      ...enabledRuntimeConfig(),
      observability: { ...enabledRuntimeConfig().observability, tracesSampleRate: 2 },
    },
    {
      ...enabledRuntimeConfig(),
      observability: { ...enabledRuntimeConfig().observability, unexpected: true },
    },
  ])('defaults invalid managed config %# to disabled', async (config) => {
    mocks.getRuntimeConfig.mockResolvedValue(config);
    const { syncRendererObservability } = await loadObservability();

    await syncRendererObservability();

    expect(mocks.init).not.toHaveBeenCalled();
  });

  it('initializes with a default-deny projection and no remote endpoint material', async () => {
    const { syncRendererObservability } = await loadObservability();

    await syncRendererObservability();

    expect(mocks.init).toHaveBeenCalledOnce();
    const options = mocks.init.mock.calls[0]?.[0] as {
      sendDefaultPii?: boolean;
      beforeSend?: (event: unknown) => unknown;
      integrations?: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
      dsn?: string;
      tunnel?: string;
    };
    expect(options.sendDefaultPii).toBe(false);
    expect(options).not.toHaveProperty('dsn');
    expect(options).not.toHaveProperty('tunnel');
    expect(options.integrations?.([
      { name: 'ScopeToMain' },
      { name: 'Replay' },
      { name: 'SentryMinidump' },
      { name: 'CrashpadAttachment' },
      { name: 'Dedupe' },
    ])).toEqual([{ name: 'Dedupe' }]);

    const projected = options.beforeSend?.({
      level: 'error',
      request: { headers: { authorization: 'Bearer secret-token' } },
      contexts: { renderer: { promptText: 'private prompt' } },
      message: 'failed at C:\\Users\\Alice\\Documents\\draft.docx',
      exception: {
        values: [{
          type: 'Error',
          value: 'password=private-value',
          stacktrace: {
            frames: [{
              filename: 'C:\\Users\\Alice\\app\\src\\App.tsx',
              function: 'Bearer secret-token',
            }],
          },
        }],
      },
    });
    expect(projected).toEqual({
      level: 'error',
      exception: {
        values: [{
          type: 'Error',
          stacktrace: { frames: [{ filename: 'src/App.tsx' }] },
        }],
      },
    });
    expect(JSON.stringify(projected)).not.toMatch(/secret-token|private prompt|private-value|Users|draft\.docx/iu);
  });

  it('stops transport at runtime and can safely re-enable the same client', async () => {
    const { syncRendererObservability } = await loadObservability();
    await syncRendererObservability();
    const transport = mocks.activeTransport;
    expect(transport).not.toBeNull();
    await transport?.send([]);
    expect(mocks.transportSend).toHaveBeenCalledOnce();

    mocks.getSettings.mockResolvedValue({ telemetryEnabled: false });
    await syncRendererObservability();
    await transport?.send([]);
    expect(await transport?.flush(1000)).toBe(true);

    expect(mocks.transportSend).toHaveBeenCalledOnce();
    expect(mocks.transportFlush).not.toHaveBeenCalled();
    expect(mocks.clientOptions.enabled).toBe(false);
    expect(mocks.clientOptions.tracesSampleRate).toBe(0);
    expect(mocks.currentScope.clear).toHaveBeenCalledOnce();
    expect(mocks.isolationScope.clear).toHaveBeenCalledOnce();

    mocks.getSettings.mockResolvedValue({ telemetryEnabled: true });
    await syncRendererObservability();
    await transport?.send([]);

    expect(mocks.init).toHaveBeenCalledOnce();
    expect(mocks.transportSend).toHaveBeenCalledTimes(2);
    expect(mocks.clientOptions.enabled).toBe(true);
    expect(mocks.clientOptions.tracesSampleRate).toBe(0.05);
  });

  it('applies the remote kill switch from the runtime polling loop', async () => {
    const { syncRendererObservability } = await loadObservability();
    await syncRendererObservability();
    const transport = mocks.activeTransport;

    mocks.getRuntimeConfig.mockResolvedValue({
      ...enabledRuntimeConfig(),
      observability: { ...enabledRuntimeConfig().observability, enabled: false },
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await transport?.send([]);

    expect(mocks.getRuntimeConfig).toHaveBeenCalledTimes(2);
    expect(mocks.transportSend).not.toHaveBeenCalled();
    expect(mocks.clientOptions.enabled).toBe(false);
  });

  it('fails closed when a settings or runtime-config read fails', async () => {
    const { syncRendererObservability } = await loadObservability();
    await syncRendererObservability();
    const transport = mocks.activeTransport;

    mocks.getSettings.mockRejectedValueOnce(new Error('settings contained a secret'));
    await expect(syncRendererObservability()).resolves.toBeUndefined();
    await transport?.send([]);
    expect(mocks.transportSend).not.toHaveBeenCalled();

    mocks.getSettings.mockResolvedValue({ telemetryEnabled: true });
    mocks.getRuntimeConfig.mockRejectedValueOnce(new Error('config contained a credential'));
    await expect(syncRendererObservability()).resolves.toBeUndefined();
    await transport?.send([]);
    expect(mocks.transportSend).not.toHaveBeenCalled();
  });

  it('does not let an older enable request resurrect Sentry after a newer disable', async () => {
    let releaseRuntimeConfig!: (value: ReturnType<typeof enabledRuntimeConfig>) => void;
    mocks.getRuntimeConfig.mockReturnValueOnce(new Promise((resolve) => {
      releaseRuntimeConfig = resolve;
    }));
    const { syncRendererObservability } = await loadObservability();

    const staleEnable = syncRendererObservability();
    await vi.waitFor(() => expect(mocks.getRuntimeConfig).toHaveBeenCalledOnce());

    mocks.getSettings.mockResolvedValueOnce({ telemetryEnabled: false });
    await syncRendererObservability();
    releaseRuntimeConfig(enabledRuntimeConfig());
    await staleEnable;

    expect(mocks.init).not.toHaveBeenCalled();
  });
});
