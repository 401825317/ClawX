import type { Breadcrumb, ErrorEvent, Event } from '@sentry/core';
import { hostApi } from './host-api';
import {
  projectObservabilityBreadcrumb,
  projectObservabilityContext,
  projectObservabilityEvent,
} from '@shared/observability-scrub';

type RendererSentryModule = typeof import('@sentry/electron/renderer');

const RUNTIME_GATE_POLL_MS = 15_000;
const OBSERVABILITY_TUNNEL_PATH = '/api/clawx/observability/envelope';
const OBSERVABILITY_FIELDS = new Set([
  'enabled',
  'rolloutPercentage',
  'sentryDsn',
  'tunnelPath',
  'crashSampleRate',
  'handledErrorSampleRate',
  'tracesSampleRate',
  'artifactSampleRate',
  'maxEventsPerHour',
]);

type RendererObservabilityPolicy = {
  tracesSampleRate: number;
};

let rendererSentry: RendererSentryModule | null = null;
let sdkInitialized = false;
let initPromise: Promise<boolean> | null = null;
let transportEnabled = false;
let syncEpoch = 0;
let runtimeGateTimer: ReturnType<typeof setInterval> | null = null;
let configuredTracesSampleRate = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasOnlyObservabilityFields(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => OBSERVABILITY_FIELDS.has(key));
}

function isSafeSentryDsn(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:')
      && url.username.length > 0
      && url.password.length === 0
      && url.hostname.length > 0
      && url.pathname !== '/'
      && url.search.length === 0
      && url.hash.length === 0;
  } catch {
    return false;
  }
}

function rendererObservabilityPolicy(value: unknown): RendererObservabilityPolicy | null {
  if (!isRecord(value) || !isRecord(value.observability)) return null;
  const config = value.observability;
  if (
    !hasOnlyObservabilityFields(config)
    || config.enabled !== true
    || !isSafeSentryDsn(config.sentryDsn)
    || config.tunnelPath !== OBSERVABILITY_TUNNEL_PATH
    || !isRate(config.crashSampleRate)
    || !isRate(config.handledErrorSampleRate)
    || !isRate(config.tracesSampleRate)
    || !isRate(config.artifactSampleRate)
    || typeof config.rolloutPercentage !== 'number'
    || !Number.isFinite(config.rolloutPercentage)
    || config.rolloutPercentage < 0
    || config.rolloutPercentage > 100
    || typeof config.maxEventsPerHour !== 'number'
    || !Number.isInteger(config.maxEventsPerHour)
    || config.maxEventsPerHour < 1
    || config.maxEventsPerHour > 30
  ) {
    return null;
  }
  return { tracesSampleRate: config.tracesSampleRate };
}

function setRendererClientEnabled(enabled: boolean): boolean {
  try {
    const client = rendererSentry?.getClient();
    if (!client) return !enabled;
    client.getOptions().enabled = enabled;
    client.getOptions().tracesSampleRate = enabled ? configuredTracesSampleRate : 0;
    if (!enabled && rendererSentry) {
      rendererSentry.getCurrentScope().clear();
      rendererSentry.getCurrentScope().clearBreadcrumbs();
      rendererSentry.getIsolationScope().clear();
      rendererSentry.getIsolationScope().clearBreadcrumbs();
    }
    return true;
  } catch {
    return false;
  }
}

function setRendererTransportGate(enabled: boolean): void {
  // Closing a BrowserClient is irreversible. Keep one initialized client and
  // gate both capture and transport so runtime policy can safely re-enable it.
  transportEnabled = false;
  const clientStateApplied = setRendererClientEnabled(enabled);
  transportEnabled = enabled && clientStateApplied;
}

function ensureRuntimeGatePolling(): void {
  if (runtimeGateTimer) return;
  runtimeGateTimer = setInterval(() => {
    void syncRendererObservability();
  }, RUNTIME_GATE_POLL_MS);
}

async function ensureRendererSentryInitialized(tracesSampleRate: number): Promise<boolean> {
  if (sdkInitialized) return true;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      const Sentry = await import('@sentry/electron/renderer');
      configuredTracesSampleRate = tracesSampleRate;
      rendererSentry = Sentry;
      // The requesting sync may become stale while the SDK is loading. Only
      // the latest verified sync is allowed to open this gate after init.
      transportEnabled = false;
      Sentry.init({
        sendDefaultPii: false,
        tracesSampleRate,
        replaysSessionSampleRate: 0,
        replaysOnErrorSampleRate: 0,
        transport: options => {
          const transport = Sentry.makeRendererTransport(options);
          return {
            send: envelope => transportEnabled
              ? transport.send(envelope)
              : Promise.resolve({}),
            flush: timeout => transportEnabled
              ? transport.flush(timeout)
              : Promise.resolve(true),
          };
        },
        beforeSend: event => (
          transportEnabled ? projectObservabilityEvent(event) as ErrorEvent | null : null
        ),
        beforeSendTransaction: event => (
          transportEnabled ? projectObservabilityEvent(event) as typeof event | null : null
        ),
        beforeBreadcrumb: breadcrumb => (
          transportEnabled
            ? projectObservabilityBreadcrumb(breadcrumb) as Breadcrumb | null
            : null
        ),
        // ScopeToMain has its own IPC path and would bypass beforeSend's
        // default-deny projection. Renderer events use the gated transport.
        integrations: defaults => defaults.filter(
          integration => !/attachment|crashpad|minidump|replay|scopetomain/iu.test(integration.name),
        ),
      });
      sdkInitialized = true;
      return true;
    } catch {
      rendererSentry = null;
      transportEnabled = false;
      return false;
    } finally {
      initPromise = null;
    }
  })();
  return initPromise;
}

export async function syncRendererObservability(): Promise<void> {
  ensureRuntimeGatePolling();
  const epoch = ++syncEpoch;
  let settings: unknown;
  try {
    settings = await hostApi.settings.getAll();
  } catch {
    if (epoch === syncEpoch) setRendererTransportGate(false);
    return;
  }
  if (epoch !== syncEpoch) return;
  if (!isRecord(settings) || settings.telemetryEnabled !== true) {
    setRendererTransportGate(false);
    return;
  }

  let config: unknown;
  try {
    config = await hostApi.managedClientConfig.runtimeConfig({ refresh: false });
  } catch {
    if (epoch === syncEpoch) setRendererTransportGate(false);
    return;
  }
  if (epoch !== syncEpoch) return;
  const policy = rendererObservabilityPolicy(config);
  if (!policy) {
    setRendererTransportGate(false);
    return;
  }

  configuredTracesSampleRate = policy.tracesSampleRate;
  const initialized = await ensureRendererSentryInitialized(configuredTracesSampleRate);
  if (epoch !== syncEpoch || !initialized) {
    if (epoch === syncEpoch) setRendererTransportGate(false);
    return;
  }
  setRendererTransportGate(true);
}

export function captureRendererException(error: unknown, context?: Record<string, unknown>): void {
  if (!rendererSentry || !sdkInitialized || !transportEnabled) return;
  rendererSentry.withScope((scope) => {
    if (context) scope.setContext('renderer', projectObservabilityContext(context));
    rendererSentry?.captureException(error);
  });
}

export const __test = {
  projectEvent: (event: Event): Event | null => projectObservabilityEvent(event) as Event | null,
};
