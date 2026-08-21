import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedObservabilityConfig } from '@shared/managed-client-config';

const mocks = vi.hoisted(() => {
  const posthogCapture = vi.fn();
  const posthogEnable = vi.fn(async () => undefined);
  const posthogDisable = vi.fn(async () => undefined);
  const posthogShutdown = vi.fn(async () => undefined);
  const posthogOptions: unknown[] = [];
  const posthogConstructor = vi.fn(function PostHogMock(_apiKey: string, options: unknown) {
    posthogOptions.push(options);
    return {
      capture: posthogCapture,
      enable: posthogEnable,
      disable: posthogDisable,
      shutdown: posthogShutdown,
    };
  });
  const sentryClientOptions = {
    enabled: true,
    sampleRate: 1,
    tracesSampleRate: 0.05,
  };
  const sentryScope = {
    clear: vi.fn(),
    clearBreadcrumbs: vi.fn(),
    setTag: vi.fn(),
    setContext: vi.fn(),
    setLevel: vi.fn(),
  };
  const sentryCurrentScope = {
    clear: vi.fn(),
    clearBreadcrumbs: vi.fn(),
  };
  const sentryIsolationScope = {
    clear: vi.fn(),
    clearBreadcrumbs: vi.fn(),
  };
  return {
    appReady: { value: true },
    appWhenReady: vi.fn(async () => undefined),
    crashpadSetUploadToServer: vi.fn(),
    getSetting: vi.fn(),
    setSetting: vi.fn(),
    installationId: vi.fn(async () => 'installation-id-1'),
    loggerDebug: vi.fn(),
    loggerError: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    posthogCapture,
    posthogEnable,
    posthogDisable,
    posthogShutdown,
    posthogConstructor,
    posthogOptions,
    posthogFetch: vi.fn(async () => new Response('', { status: 200 })),
    runtimeConfigSnapshot: vi.fn(),
    runtimeConfigSubscription: { listener: null as null | ((current: unknown, previous: unknown) => void) },
    subscribeRuntimeConfig: vi.fn(),
    unsubscribeRuntimeConfig: vi.fn(),
    sentryCaptureException: vi.fn(),
    sentryCaptureEvent: vi.fn(),
    sentryClientOptions,
    sentryClose: vi.fn(async () => true),
    sentryCurrentScope,
    sentryFlush: vi.fn(async () => true),
    sentryInit: vi.fn(),
    sentryInitReadyStates: [] as boolean[],
    sentryIsolationScope,
    sentryMakeTransport: vi.fn(),
    sentryScope,
    sentryTransportFlush: vi.fn(async () => true),
    sentryTransportSend: vi.fn(async () => ({ statusCode: 200 })),
  };
});

vi.mock('posthog-node', () => ({ PostHog: mocks.posthogConstructor }));

vi.mock('@electron/utils/store', () => ({
  getSetting: mocks.getSetting,
  setSetting: mocks.setSetting,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    debug: mocks.loggerDebug,
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: () => '2.0.3',
    isPackaged: true,
    isReady: () => mocks.appReady.value,
    whenReady: mocks.appWhenReady,
  },
  crashReporter: {
    setUploadToServer: mocks.crashpadSetUploadToServer,
  },
}));

vi.mock('@electron/utils/installation-id', () => ({
  getOrCreateInstallationId: mocks.installationId,
}));

vi.mock('@electron/utils/junfeiai-distribution', () => ({
  getUclawBackendOrigin: () => 'https://uclaw.example.invalid',
}));

vi.mock('@electron/utils/build-identity', () => ({
  getUclawBuildIdentity: () => ({
    appVersion: '2.0.3',
    gitCommit: 'a'.repeat(40),
    buildId: 'build-test-1',
    platform: 'win32',
    arch: 'x64',
    channel: 'stable',
    runtimeMode: 'packaged',
  }),
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  getManagedClientRuntimeConfigSnapshot: mocks.runtimeConfigSnapshot,
  subscribeManagedClientRuntimeConfig: mocks.subscribeRuntimeConfig,
}));

vi.mock('@sentry/electron/main', () => ({
  IPCMode: { Classic: 1, Protocol: 2, Both: 3 },
  init: mocks.sentryInit,
  close: mocks.sentryClose,
  flush: mocks.sentryFlush,
  captureException: mocks.sentryCaptureException,
  captureEvent: mocks.sentryCaptureEvent,
  makeElectronTransport: mocks.sentryMakeTransport,
  getClient: () => ({ getOptions: () => mocks.sentryClientOptions }),
  getCurrentScope: () => mocks.sentryCurrentScope,
  getIsolationScope: () => mocks.sentryIsolationScope,
  withScope: (callback: (scope: typeof mocks.sentryScope) => void) => callback(mocks.sentryScope),
}));

function observabilityConfig(
  enabled: boolean,
  overrides: Partial<ManagedObservabilityConfig> = {},
): ManagedObservabilityConfig {
  return {
    enabled,
    rolloutPercentage: enabled ? 100 : 0,
    ...(enabled ? { sentryDsn: 'https://public@example.invalid/1' } : {}),
    tunnelPath: '/api/clawx/observability/envelope',
    crashSampleRate: 1,
    handledErrorSampleRate: 1,
    tracesSampleRate: 0.05,
    artifactSampleRate: 1,
    maxEventsPerHour: 30,
    ...overrides,
  };
}

function runtimeSnapshot(config: ManagedObservabilityConfig, epoch = 1) {
  return {
    config: { observability: config, features: {} },
    epoch,
    verifiedAt: Date.now(),
  };
}

type GatedTransport = {
  send: (envelope: unknown) => Promise<unknown>;
  flush: (timeout: number) => Promise<boolean>;
};

type SentryInitOptions = {
  dsn: string;
  tunnel: string;
  ipcMode: number;
  transport: (options: unknown) => GatedTransport;
  beforeSend: (event: unknown) => unknown;
  beforeSendTransaction: (event: unknown) => unknown;
  beforeBreadcrumb: (breadcrumb: unknown) => unknown;
  integrations: (defaults: Array<{ name: string }>) => Array<{ name: string }>;
};

describe('main telemetry policy', () => {
  let currentObservability: ManagedObservabilityConfig;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.posthogOptions.length = 0;
    mocks.appReady.value = true;
    mocks.appWhenReady.mockImplementation(async () => undefined);
    mocks.getSetting.mockImplementation(async (key: string) => {
      switch (key) {
        case 'telemetryEnabled':
          return true;
        case 'hasReportedInstall':
          return true;
        default:
          return undefined;
      }
    });
    mocks.setSetting.mockResolvedValue(undefined);
    mocks.installationId.mockResolvedValue('installation-id-1');
    mocks.posthogEnable.mockResolvedValue(undefined);
    mocks.posthogDisable.mockResolvedValue(undefined);
    mocks.posthogShutdown.mockResolvedValue(undefined);
    mocks.sentryClientOptions.enabled = true;
    mocks.sentryClientOptions.sampleRate = 1;
    mocks.sentryClientOptions.tracesSampleRate = 0.05;
    mocks.sentryInitReadyStates.length = 0;
    mocks.sentryInit.mockImplementation(() => {
      mocks.sentryInitReadyStates.push(mocks.appReady.value);
    });
    mocks.sentryMakeTransport.mockReturnValue({
      send: mocks.sentryTransportSend,
      flush: mocks.sentryTransportFlush,
    });
    currentObservability = observabilityConfig(true);
    mocks.runtimeConfigSnapshot.mockImplementation(() => runtimeSnapshot(currentObservability));
    mocks.runtimeConfigSubscription.listener = null;
    mocks.subscribeRuntimeConfig.mockImplementation((listener: (current: unknown, previous: unknown) => void) => {
      mocks.runtimeConfigSubscription.listener = listener;
      return mocks.unsubscribeRuntimeConfig;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('waits for app readiness before initializing Classic Electron IPC', async () => {
    let resolveReady!: () => void;
    mocks.appReady.value = false;
    mocks.appWhenReady.mockReturnValue(new Promise<void>((resolve) => {
      resolveReady = resolve;
    }));

    const { initTelemetry } = await import('@electron/utils/telemetry');
    const pending = initTelemetry();
    await vi.waitFor(() => expect(mocks.appWhenReady).toHaveBeenCalledOnce());
    expect(mocks.sentryInit).not.toHaveBeenCalled();

    mocks.appReady.value = true;
    resolveReady();
    await pending;

    expect(mocks.sentryInitReadyStates).toEqual([true]);
    const options = mocks.sentryInit.mock.calls[0][0] as SentryInitOptions;
    expect(options.ipcMode).toBe(1);
    expect(options.dsn).toBe('https://public@example.invalid/1');
    const tunnel = new URL(options.tunnel);
    expect(tunnel.origin).toBe('https://uclaw.example.invalid');
    expect(tunnel.pathname).toBe('/api/clawx/observability/envelope');
    expect(tunnel.searchParams.get('install_id')).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.crashpadSetUploadToServer).toHaveBeenCalledWith(false);
    expect(options.integrations([
      { name: 'SentryMinidump' },
      { name: 'ElectronMinidump' },
      { name: 'Crashpad' },
      { name: 'Attachment' },
      { name: 'Dedupe' },
    ])).toEqual([{ name: 'Dedupe' }]);
  });

  it('does not initialize or capture when the global telemetry setting is disabled', async () => {
    mocks.getSetting.mockImplementation(async (key: string) => (
      key === 'telemetryEnabled' ? false : undefined
    ));

    const telemetry = await import('@electron/utils/telemetry');
    await telemetry.initTelemetry();
    telemetry.captureHandledException(new Error('must not upload'));
    telemetry.captureTelemetryEvent('must_not_upload');

    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.sentryCaptureException).not.toHaveBeenCalled();
    expect(mocks.posthogCapture).not.toHaveBeenCalled();
    expect(mocks.crashpadSetUploadToServer).toHaveBeenCalledWith(false);
  });

  it('keeps Crashpad direct upload off and gates the live Sentry transport at runtime', async () => {
    const telemetry = await import('@electron/utils/telemetry');
    await telemetry.initTelemetry();
    expect(mocks.sentryInit).toHaveBeenCalledOnce();

    const options = mocks.sentryInit.mock.calls[0][0] as SentryInitOptions;
    const transport = options.transport({});
    await transport.send({ type: 'enabled' });
    expect(mocks.sentryTransportSend).toHaveBeenCalledOnce();
    expect(mocks.sentryClientOptions.enabled).toBe(true);

    const listener = mocks.runtimeConfigSubscription.listener;
    expect(listener).not.toBeNull();
    const disabled = observabilityConfig(false);
    listener?.(runtimeSnapshot(disabled, 2), runtimeSnapshot(currentObservability, 1));

    expect(mocks.sentryClientOptions.enabled).toBe(false);
    telemetry.captureGatewayProcessException(new Error('disabled'), { requestId: 'request-disabled' });
    await transport.send({ type: 'disabled' });
    expect(mocks.sentryCaptureException).not.toHaveBeenCalled();
    expect(mocks.sentryTransportSend).toHaveBeenCalledOnce();
    expect(options.beforeSend({ message: 'disabled' })).toBeNull();
    expect(options.beforeSendTransaction({ type: 'transaction' })).toBeNull();
    expect(options.beforeBreadcrumb({ message: 'disabled' })).toBeNull();
    expect(mocks.crashpadSetUploadToServer).toHaveBeenLastCalledWith(false);
    expect(mocks.sentryClose).not.toHaveBeenCalled();

    listener?.(runtimeSnapshot(currentObservability, 3), runtimeSnapshot(disabled, 2));
    await vi.waitFor(() => expect(mocks.sentryClientOptions.enabled).toBe(true));
    await transport.send({ type: 're-enabled' });
    expect(mocks.sentryTransportSend).toHaveBeenCalledTimes(2);
    expect(mocks.sentryInit).toHaveBeenCalledOnce();
  });

  it('does not revive Sentry when the remote kill switch changes while waiting for app ready', async () => {
    let resolveReady!: () => void;
    mocks.appReady.value = false;
    mocks.appWhenReady.mockReturnValue(new Promise<void>((resolve) => {
      resolveReady = resolve;
    }));

    const { initTelemetry } = await import('@electron/utils/telemetry');
    const pending = initTelemetry();
    await vi.waitFor(() => {
      expect(mocks.runtimeConfigSubscription.listener).not.toBeNull();
      expect(mocks.appWhenReady).toHaveBeenCalledOnce();
    });

    const disabled = observabilityConfig(false);
    mocks.runtimeConfigSubscription.listener?.(
      runtimeSnapshot(disabled, 2),
      runtimeSnapshot(currentObservability, 1),
    );
    mocks.appReady.value = true;
    resolveReady();
    await pending;

    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.crashpadSetUploadToServer).toHaveBeenLastCalledWith(false);
  });

  it('applies the global setting immediately to both PostHog and Sentry', async () => {
    const telemetry = await import('@electron/utils/telemetry');
    await telemetry.initTelemetry();
    const options = mocks.sentryInit.mock.calls[0][0] as SentryInitOptions;
    const transport = options.transport({});

    await telemetry.setTelemetryCollectionEnabled(false);
    telemetry.captureHandledException(new Error('disabled locally'));
    telemetry.captureTelemetryEvent('disabled_locally');
    await transport.send({ type: 'disabled-locally' });

    expect(mocks.posthogDisable).toHaveBeenCalledOnce();
    expect(mocks.sentryClientOptions.enabled).toBe(false);
    expect(mocks.sentryClientOptions.sampleRate).toBe(0);
    expect(mocks.sentryClientOptions.tracesSampleRate).toBe(0);
    expect(mocks.sentryCaptureException).not.toHaveBeenCalled();
    expect(mocks.sentryTransportSend).not.toHaveBeenCalled();
    expect(mocks.crashpadSetUploadToServer).toHaveBeenLastCalledWith(false);

    await telemetry.setTelemetryCollectionEnabled(true);
    await vi.waitFor(() => expect(mocks.sentryClientOptions.enabled).toBe(true));
    expect(mocks.posthogEnable).not.toHaveBeenCalled();
    expect(mocks.posthogConstructor).toHaveBeenCalledTimes(2);
    expect(mocks.sentryClientOptions.sampleRate).toBe(1);
    expect(mocks.sentryClientOptions.tracesSampleRate).toBe(0.05);
    await transport.send({ type: 'enabled-locally' });
    expect(mocks.sentryTransportSend).toHaveBeenCalledOnce();
  });

  it('does not let a stale startup setting overwrite a newer runtime opt-out', async () => {
    let resolveSetting!: (value: boolean) => void;
    mocks.getSetting.mockImplementation((key: string) => {
      if (key === 'telemetryEnabled') {
        return new Promise<boolean>((resolve) => {
          resolveSetting = resolve;
        });
      }
      return Promise.resolve(true);
    });

    const telemetry = await import('@electron/utils/telemetry');
    const startup = telemetry.initTelemetry();
    await vi.waitFor(() => expect(mocks.getSetting).toHaveBeenCalledWith('telemetryEnabled'));
    await telemetry.setTelemetryCollectionEnabled(false);
    resolveSetting(true);
    await startup;

    expect(mocks.posthogConstructor).not.toHaveBeenCalled();
    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.crashpadSetUploadToServer).toHaveBeenLastCalledWith(false);
  });

  it('sends only a safe structured fatal diagnostic', async () => {
    const { captureFatalException, initTelemetry } = await import('@electron/utils/telemetry');
    await initTelemetry();
    captureFatalException({
      eventId: '2f67f433-dcee-48c1-8bd7-85444c85ae55',
      occurredAt: '2026-08-19T00:00:00.000Z',
      reason: 'uncaught_exception',
      errorName: 'TypeError',
      errorCode: 'EPIPE',
      fingerprint: 'a'.repeat(64),
    });

    expect(mocks.sentryCaptureException).not.toHaveBeenCalled();
    expect(mocks.sentryScope.clear).toHaveBeenCalledOnce();
    expect(mocks.sentryScope.clearBreadcrumbs).toHaveBeenCalledOnce();
    expect(mocks.sentryCaptureEvent).toHaveBeenCalledWith({
      level: 'fatal',
      fingerprint: ['a'.repeat(64)],
      tags: {
        fatal_reason: 'uncaught_exception',
        fatal_error_name: 'TypeError',
        fatal_error_code: 'EPIPE',
        fatal_event_id: '2f67f433-dcee-48c1-8bd7-85444c85ae55',
      },
    });
    expect(mocks.sentryCaptureEvent.mock.calls[0][0]).not.toHaveProperty('exception');
    expect(mocks.sentryCaptureEvent.mock.calls[0][0]).not.toHaveProperty('breadcrumbs');
    expect(mocks.sentryCaptureEvent.mock.calls[0][0]).not.toHaveProperty('extra');
  });

  it('aborts old PostHog work and never flushes it when telemetry is disabled', async () => {
    const { initTelemetry, shutdownTelemetry } = await import('@electron/utils/telemetry');
    await initTelemetry();
    const firstOptions = mocks.posthogOptions[0] as {
      fetch: (url: string, options: { method: 'GET'; headers: Record<string, string> }) => Promise<unknown>;
    };
    mocks.posthogFetch.mockImplementation((_url: string, options: { signal?: AbortSignal }) => (
      new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        if (options.signal?.aborted) reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      })
    ));
    vi.stubGlobal('fetch', mocks.posthogFetch);
    const upload = firstOptions.fetch('https://us.i.posthog.com/batch/', {
      method: 'GET',
      headers: {},
    });
    await vi.waitFor(() => expect(mocks.posthogFetch).toHaveBeenCalledOnce());

    await shutdownTelemetry();

    expect(mocks.unsubscribeRuntimeConfig).toHaveBeenCalledOnce();
    expect(mocks.sentryClientOptions.enabled).toBe(false);
    expect(mocks.posthogShutdown).not.toHaveBeenCalled();
    expect(mocks.posthogFetch.mock.calls[0]?.[1]?.signal).toHaveProperty('aborted', true);
    await expect(upload).rejects.toMatchObject({ name: 'AbortError' });
  });
});
