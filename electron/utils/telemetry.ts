import { PostHog } from 'posthog-node';
import { app, crashReporter } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import type { Breadcrumb, ErrorEvent, Event } from '@sentry/core';
import { getSetting, setSetting } from './store';
import { logger } from './logger';
import {
  getManagedClientRuntimeConfigSnapshot,
  subscribeManagedClientRuntimeConfig,
} from '../services/managed-client-config-service';
import type { ManagedObservabilityConfig } from '@shared/managed-client-config';
import {
  projectObservabilityBreadcrumb,
  projectObservabilityContext,
  projectObservabilityEvent,
} from '@shared/observability-scrub';
import { getUclawBackendOrigin } from './junfeiai-distribution';
import { getUclawBuildIdentity } from './build-identity';
import { getOrCreateInstallationId } from './installation-id';
import type { SafeFatalDiagnostic } from '../main/fatal-handler';

const POSTHOG_API_KEY = 'phc_aGNegeJQP5FzNiF2rEoKqQbkuCpiiETMttplibXpB0n';
const POSTHOG_HOST = 'https://us.i.posthog.com';

type MainSentryModule = typeof import('@sentry/electron/main');
type PostHogOptions = NonNullable<ConstructorParameters<typeof PostHog>[1]>;
type PostHogFetch = NonNullable<PostHogOptions['fetch']>;
type PostHogGeneration = {
  controller: AbortController;
  open: boolean;
};

let posthogClient: PostHog | null = null;
const posthogGenerations = new WeakMap<PostHog, PostHogGeneration>();
let distinctId = '';
let sentryModule: MainSentryModule | null = null;
let sentrySdkInitialized = false;
let sentryInitPromise: Promise<boolean> | null = null;
let sentryTransportEnabled = false;
let sentryInitializedConfigKey = '';
let telemetryInitialized = false;
let telemetryInitializationPromise: Promise<void> | null = null;
let telemetryCollectionEnabled = false;
let observabilityConfig: ManagedObservabilityConfig | null = null;
let observabilityEpoch = 0;
let localTelemetryEpoch = 0;
let unsubscribeRuntimeConfig: (() => void) | null = null;
const sentryEventTimestamps: number[] = [];

function getCommonProperties(): Record<string, string> {
  return {
    $app_version: app.getVersion(),
    $os: process.platform,
    os_tag: process.platform,
    arch: process.arch,
  };
}

function allowSentryErrorEvent(): boolean {
  const now = Date.now();
  const cutoff = now - 60 * 60 * 1000;
  while (sentryEventTimestamps.length > 0 && sentryEventTimestamps[0] < cutoff) {
    sentryEventTimestamps.shift();
  }
  const limit = observabilityConfig?.maxEventsPerHour ?? 30;
  if (sentryEventTimestamps.length >= limit) return false;
  sentryEventTimestamps.push(now);
  return true;
}

function safeDiagnosticsContext(context: Record<string, unknown>): Record<string, unknown> {
  return projectObservabilityContext({ eventId: randomUUID(), ...context });
}

function projectSentryEvent(event: Event, rateLimited: boolean): Event | null {
  if (!telemetryCollectionEnabled || !sentryTransportEnabled) return null;
  if (rateLimited && !allowSentryErrorEvent()) return null;
  return projectObservabilityEvent(event) as Event | null;
}

function hashInstallationId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sentryConfigKey(config: ManagedObservabilityConfig): string {
  return `${config.sentryDsn ?? ''}\u0000${config.tunnelPath}`;
}

function keepCrashpadOnSentryTransport(): void {
  try {
    // Raw dumps are not forwarded by Sentry integrations, and Crashpad must
    // remain unable to upload directly regardless of the active policy.
    crashReporter.setUploadToServer(false);
  } catch {
    // Crashpad is not available on every supported platform/test runtime.
  }
}

function setSentryClientEnabled(enabled: boolean): void {
  const client = sentryModule?.getClient();
  if (client) {
    client.getOptions().enabled = enabled;
    if (observabilityConfig) {
      client.getOptions().sampleRate = enabled ? observabilityConfig.crashSampleRate : 0;
      client.getOptions().tracesSampleRate = enabled ? observabilityConfig.tracesSampleRate : 0;
    }
  }
  if (!enabled && sentryModule) {
    sentryModule.getCurrentScope().clear();
    sentryModule.getCurrentScope().clearBreadcrumbs();
    sentryModule.getIsolationScope().clear();
    sentryModule.getIsolationScope().clearBreadcrumbs();
  }
  keepCrashpadOnSentryTransport();
}

function setSentryTransportGate(enabled: boolean): void {
  // Close the transport gate before disabling the client so a concurrently
  // captured event cannot enter the transport queue.
  sentryTransportEnabled = enabled;
  setSentryClientEnabled(enabled);
}

async function ensureSentryInitialized(
  config: ManagedObservabilityConfig,
  installationId: string,
): Promise<boolean> {
  const requestedConfigKey = sentryConfigKey(config);
  if (sentrySdkInitialized) return requestedConfigKey === sentryInitializedConfigKey;
  if (sentryInitPromise) return sentryInitPromise;

  sentryInitPromise = (async () => {
    try {
      const Sentry = await import('@sentry/electron/main');
      const identity = getUclawBuildIdentity();
      const tunnel = new URL(config.tunnelPath, getUclawBackendOrigin());
      tunnel.searchParams.set('install_id', hashInstallationId(installationId));
      sentryModule = Sentry;
      // Initialization may discover a previous minidump. Keep transport shut
      // until the caller revalidates the latest local and remote policy epoch.
      sentryTransportEnabled = false;

      Sentry.init({
        dsn: config.sentryDsn,
        tunnel: tunnel.toString(),
        release: `uclaw@${identity.appVersion}+${identity.buildId}`,
        environment: app.isPackaged ? 'production' : 'development',
        ipcMode: Sentry.IPCMode.Classic,
        sendDefaultPii: false,
        attachScreenshot: false,
        sampleRate: config.crashSampleRate,
        tracesSampleRate: config.tracesSampleRate,
        transport: options => {
          // Deliberately avoid the SDK's offline transport: a disabled gate
          // must drop queued events instead of persisting them for later upload.
          const transport = Sentry.makeElectronTransport(options);
          return {
            send: envelope => sentryTransportEnabled
              ? transport.send(envelope)
              : Promise.resolve({}),
            flush: timeout => sentryTransportEnabled
              ? transport.flush(timeout)
              : Promise.resolve(true),
          };
        },
        beforeSend: event => projectSentryEvent(event, true) as ErrorEvent | null,
        beforeSendTransaction: event => projectSentryEvent(event, false) as typeof event | null,
        beforeBreadcrumb: breadcrumb => (
          telemetryCollectionEnabled && sentryTransportEnabled
            ? projectObservabilityBreadcrumb(breadcrumb) as Breadcrumb | null
            : null
        ),
        integrations: defaults => defaults.filter((integration) => (
          !/additionalcontext|attachment|breadcrumbs|console|contextlines|crashpad|localvariables|minidump|replay|screenshots|uncaughtexception|unhandledrejection/iu
            .test(integration.name)
        )),
      });

      sentrySdkInitialized = true;
      sentryInitializedConfigKey = requestedConfigKey;
      return true;
    } catch {
      sentryTransportEnabled = false;
      sentryModule = null;
      return false;
    } finally {
      keepCrashpadOnSentryTransport();
      sentryInitPromise = null;
    }
  })();
  return sentryInitPromise;
}

async function applyManagedObservabilityConfig(config: ManagedObservabilityConfig): Promise<void> {
  const epoch = ++observabilityEpoch;
  observabilityConfig = config;
  const shouldEnable = Boolean(
    telemetryCollectionEnabled
    && config.enabled
    && config.sentryDsn,
  );
  if (!shouldEnable) {
    setSentryTransportGate(false);
    return;
  }

  const installationId = distinctId || await getOrCreateInstallationId();
  if (epoch !== observabilityEpoch || !telemetryCollectionEnabled) return;
  distinctId = installationId;
  // Classic mode touches ipcMain synchronously in Sentry.init(). Revalidate
  // policy after Electron's ready barrier so a kill switch received while
  // waiting cannot initialize or revive the SDK.
  await app.whenReady();
  if (
    epoch !== observabilityEpoch
    || !telemetryCollectionEnabled
    || observabilityConfig?.enabled !== true
  ) return;
  const initialized = await ensureSentryInitialized(config, installationId);
  if (epoch !== observabilityEpoch) return;
  if (!telemetryCollectionEnabled || observabilityConfig?.enabled !== true) {
    setSentryTransportGate(false);
    return;
  }
  if (!initialized || sentryConfigKey(config) !== sentryInitializedConfigKey) {
    setSentryTransportGate(false);
    logger.warn('[observability] Sentry endpoint changed or initialization failed; capture remains disabled until restart.');
    return;
  }
  setSentryTransportGate(true);
}

function telemetryAbortError(): Error {
  const error = new Error('Telemetry upload disabled');
  error.name = 'AbortError';
  return error;
}

function createPostHogFetch(generation: PostHogGeneration): PostHogFetch {
  return async (url, options) => {
    if (!generation.open || generation.controller.signal.aborted) {
      throw telemetryAbortError();
    }
    const signals = [generation.controller.signal, options.signal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    return globalThis.fetch(url, {
      ...options,
      signal: AbortSignal.any(signals),
    });
  };
}

async function retirePostHogClient(expectedClient?: PostHog): Promise<void> {
  const client = expectedClient ?? posthogClient;
  if (!client) return;
  const generation = posthogGenerations.get(client);
  if (posthogClient === client) {
    posthogClient = null;
  }
  if (generation) {
    generation.open = false;
    generation.controller.abort();
  }
  posthogGenerations.delete(client);
  await client.disable().catch(() => undefined);
}

function ensureRuntimeConfigSubscription(): void {
  if (unsubscribeRuntimeConfig) return;
  unsubscribeRuntimeConfig = subscribeManagedClientRuntimeConfig((current) => {
    void applyManagedObservabilityConfig(current.config.observability).catch(() => {
      if (observabilityConfig === current.config.observability) {
        setSentryTransportGate(false);
        logger.warn('[observability] Failed to apply managed observability policy; capture disabled.');
      }
    });
  });
}

async function enablePostHog(epoch: number): Promise<boolean> {
  await retirePostHogClient();
  if (epoch !== localTelemetryEpoch || !telemetryCollectionEnabled) return false;
  const generation: PostHogGeneration = { controller: new AbortController(), open: true };
  const client = new PostHog(POSTHOG_API_KEY, {
    host: POSTHOG_HOST,
    fetch: createPostHogFetch(generation),
  });
  posthogGenerations.set(client, generation);
  posthogClient = client;
  if (epoch !== localTelemetryEpoch || !telemetryCollectionEnabled) {
    await retirePostHogClient(client);
    return false;
  }

  const properties = getCommonProperties();
  const hasReportedInstall = await getSetting('hasReportedInstall');
  if (epoch !== localTelemetryEpoch || !telemetryCollectionEnabled) {
    await retirePostHogClient(client);
    return false;
  }
  if (!hasReportedInstall) {
    client.capture({ distinctId, event: 'app_installed', properties });
    await setSetting('hasReportedInstall', true);
    logger.info('Reported app_installed event');
  }
  if (epoch !== localTelemetryEpoch || !telemetryCollectionEnabled) {
    await retirePostHogClient(client);
    return false;
  }
  if (!telemetryInitialized) {
    client.capture({ distinctId, event: 'app_opened', properties });
    logger.debug('Reported app_opened event');
  }
  return true;
}

async function applyLocalTelemetrySetting(enabled: boolean): Promise<void> {
  const localEpoch = ++localTelemetryEpoch;
  observabilityEpoch += 1;
  ensureRuntimeConfigSubscription();
  keepCrashpadOnSentryTransport();
  telemetryCollectionEnabled = enabled;
  if (!enabled) {
    setSentryTransportGate(false);
    await retirePostHogClient();
    return;
  }

  const installationId = distinctId || await getOrCreateInstallationId();
  if (localEpoch !== localTelemetryEpoch || !telemetryCollectionEnabled) return;
  distinctId = installationId;
  if (!await enablePostHog(localEpoch)) return;
  if (localEpoch !== localTelemetryEpoch || !telemetryCollectionEnabled) return;
  await applyManagedObservabilityConfig(getManagedClientRuntimeConfigSnapshot().config.observability);
}

/** Initialize telemetry once and then drive its transport gates from settings and Main runtime snapshots. */
export function initTelemetry(): Promise<void> {
  if (telemetryInitialized) return Promise.resolve();
  if (telemetryInitializationPromise) return telemetryInitializationPromise;

  const initializationEpoch = localTelemetryEpoch;
  telemetryInitializationPromise = (async () => {
    try {
      keepCrashpadOnSentryTransport();
      const telemetryEnabled = await getSetting('telemetryEnabled');
      // A settings update or shutdown that happened while the store read was
      // pending owns the newer state and must not be overwritten here.
      if (initializationEpoch !== localTelemetryEpoch) return;
      await applyLocalTelemetrySetting(telemetryEnabled === true);
      if (!telemetryEnabled) logger.info('Telemetry is disabled in settings');
    } catch {
      telemetryCollectionEnabled = false;
      setSentryTransportGate(false);
      logger.error('Failed to initialize telemetry');
    } finally {
      telemetryInitialized = true;
      telemetryInitializationPromise = null;
    }
  })();
  return telemetryInitializationPromise;
}

export function captureHandledException(
  error: unknown,
  context: Record<string, unknown> = {},
  options: { artifactTask?: boolean } = {},
): void {
  if (!telemetryCollectionEnabled || !sentryModule || !sentryTransportEnabled || !observabilityConfig) return;
  const sampleRate = options.artifactTask
    ? observabilityConfig.artifactSampleRate
    : observabilityConfig.handledErrorSampleRate;
  if (Math.random() > sampleRate) return;
  sentryModule.withScope((scope) => {
    scope.setTag('handled', 'true');
    scope.setContext('uclaw', safeDiagnosticsContext(context));
    sentryModule?.captureException(error);
  });
}

export function captureFatalException(diagnostic: SafeFatalDiagnostic): void {
  if (!telemetryCollectionEnabled || !sentryModule || !sentryTransportEnabled) return;
  sentryModule.withScope((scope) => {
    scope.clear();
    scope.clearBreadcrumbs();
    scope.setLevel('fatal');
    sentryModule?.captureEvent({
      level: 'fatal',
      fingerprint: [diagnostic.fingerprint],
      tags: {
        fatal_reason: diagnostic.reason,
        fatal_error_name: diagnostic.errorName,
        fatal_error_code: diagnostic.errorCode ?? 'none',
        fatal_event_id: diagnostic.eventId,
      },
    });
  });
  void sentryModule.flush(2500).catch(() => undefined);
}

export function captureGatewayProcessException(
  error: unknown,
  context: Record<string, unknown>,
): void {
  if (!telemetryCollectionEnabled || !sentryModule || !sentryTransportEnabled) return;
  sentryModule.withScope((scope) => {
    scope.setLevel('error');
    scope.setTag('handled', 'false');
    scope.setTag('subsystem', 'gateway');
    scope.setContext('gateway', safeDiagnosticsContext(context));
    sentryModule?.captureException(error);
  });
}

export function trackMetric(event: string, properties: Record<string, unknown> = {}): void {
  logger.info(`[metric] ${event}`, properties);
}

export function captureTelemetryEvent(event: string, properties: Record<string, unknown> = {}): void {
  if (!telemetryCollectionEnabled || !posthogClient || !distinctId) return;
  try {
    posthogClient.capture({
      distinctId,
      event,
      properties: {
        ...getCommonProperties(),
        ...projectObservabilityContext(properties),
      },
    });
  } catch {
    logger.debug(`Failed to capture telemetry event "${event}"`);
  }
}

/** Stop collection immediately and abandon all queued or in-flight PostHog work. */
export async function shutdownTelemetry(): Promise<void> {
  localTelemetryEpoch += 1;
  observabilityEpoch += 1;
  telemetryCollectionEnabled = false;
  setSentryTransportGate(false);
  unsubscribeRuntimeConfig?.();
  unsubscribeRuntimeConfig = null;

  await retirePostHogClient();
  distinctId = '';
}

export async function setTelemetryCollectionEnabled(enabled: boolean): Promise<void> {
  await applyLocalTelemetrySetting(enabled);
  telemetryInitialized = true;
}
