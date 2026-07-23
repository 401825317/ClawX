import rawConfig from './junfeiai-endpoints.json';

export type UclawApiProtocol = 'openai-responses' | 'openai-completions';
export type UclawThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type UclawExecSecurity = 'deny' | 'allowlist' | 'full';
export type UclawExecAsk = 'off' | 'on-miss' | 'always';
export type UclawCompactionMode = 'default' | 'safeguard';
export type UclawMarketplaceProvider = 'skillhub' | 'clawhub';

export type UclawEndpointsConfig = {
  provider: {
    productionOrigin: string;
    providerName: 'UClaw';
    managedProviderId: string;
    managedAccountId: string;
    authAccountId: string;
    defaultModel: string;
    defaultModelContextWindow: number;
    defaultApiProtocol: UclawApiProtocol;
    defaultThinkingLevel: UclawThinkingLevel;
    requestTimeoutSeconds: number;
  };
  auth: {
    requestTimeoutMs: number;
    bootstrapRequestTimeoutMs: number;
    relayRequestTimeoutMs: number;
    verificationRequestTimeoutMs: number;
    offlineGraceSeconds: number;
    verifyMemoryCacheSeconds: number;
    tokenRefreshSkewSeconds: number;
    defaultAccessTokenLifetimeSeconds: number;
  };
  marketplace: {
    defaultProvider: UclawMarketplaceProvider;
    skillHubApiOrigin: string;
    skillHubWebOrigin: string;
    clawHubConvexOrigin: string;
    clawHubMirrorOrigin: string;
    clawHubInstallOrigin: string;
    requestTimeoutMs: number;
    downloadTimeoutMs: number;
    maxJsonBytes: number;
    maxDownloadBytes: number;
    maxArchiveFiles: number;
    maxArchiveEntryBytes: number;
    maxArchiveUncompressedBytes: number;
  };
  billing: {
    requestTimeoutMs: number;
    orderStatusPollIntervalMs: number;
    historyPageSize: number;
    routes: {
      overview: string;
      orders: string;
      history: string;
      verify: string;
    };
  };
  runtimeDefaults: {
    tools: {
      exec: {
        security: UclawExecSecurity;
        ask: UclawExecAsk;
      };
    };
    compaction: {
      mode: UclawCompactionMode;
      reserveTokensFloor: number;
    };
  };
  media: {
    image: {
      timeoutMs: number;
      defaultSize: string;
    };
    video: {
      timeoutMs: number;
      pollIntervalMs: number;
      maxDownloadBytes: number;
      preferredResolution: string;
      preferredShortEdge: number;
    };
    testTimeoutMs: number;
    clientTimeoutBufferMs: number;
  };
};

type JsonRecord = Record<string, unknown>;

function readRecord(value: unknown, key: string): JsonRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be an object`);
  }
  return value as JsonRecord;
}

function readNonEmptyString(value: unknown, key: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a non-empty string`);
  }
  return value.trim();
}

function readPositiveInteger(value: unknown, key: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a positive integer`);
  }
  return value;
}

function readEnum<T extends string>(value: unknown, key: string, supported: readonly T[]): T {
  const normalized = readNonEmptyString(value, key);
  if (!supported.includes(normalized as T)) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json is not supported`);
  }
  return normalized as T;
}

function readProductionOrigin(value: unknown): string {
  const normalized = readNonEmptyString(value, 'provider.productionOrigin');
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error('provider.productionOrigin in shared/junfeiai-endpoints.json must be a valid URL');
  }
  if (
    !['http:', 'https:'].includes(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new Error('provider.productionOrigin in shared/junfeiai-endpoints.json must be an HTTP(S) origin');
  }
  return parsed.origin;
}

function readMarketplaceOrigin(value: unknown, key: string): string {
  const normalized = readNonEmptyString(value, key);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be a valid URL`);
  }
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]';
  if (
    (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback))
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be an HTTPS origin`);
  }
  return parsed.origin;
}

function readProviderName(value: unknown): 'UClaw' {
  const normalized = readNonEmptyString(value, 'provider.providerName');
  if (normalized !== 'UClaw') {
    throw new Error('provider.providerName in shared/junfeiai-endpoints.json must be UClaw');
  }
  return normalized;
}

function readPixelSize(value: unknown, key: string): string {
  const normalized = readNonEmptyString(value, key);
  if (!/^\d+x\d+$/.test(normalized)) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must use WIDTHxHEIGHT format`);
  }
  return normalized;
}

function readResolution(value: unknown, key: string): string {
  const normalized = readNonEmptyString(value, key).toLowerCase();
  if (!/^\d+p$/.test(normalized)) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must use a value such as 480p`);
  }
  return normalized;
}

function readApiPath(value: unknown, key: string): string {
  const normalized = readNonEmptyString(value, key);
  if (!normalized.startsWith('/') || normalized.startsWith('//') || normalized.includes('?') || normalized.includes('#')) {
    throw new Error(`${key} in shared/junfeiai-endpoints.json must be an absolute API path`);
  }
  return normalized;
}

/** Validate the checked-in managed-distribution configuration before exporting it. */
export function validateUclawEndpointsConfig(value: unknown): UclawEndpointsConfig {
  const root = readRecord(value, 'root');
  const provider = readRecord(root.provider, 'provider');
  const auth = readRecord(root.auth, 'auth');
  const marketplace = readRecord(root.marketplace, 'marketplace');
  const billing = readRecord(root.billing, 'billing');
  const billingRoutes = readRecord(billing.routes, 'billing.routes');
  const runtimeDefaults = readRecord(root.runtimeDefaults, 'runtimeDefaults');
  const tools = readRecord(runtimeDefaults.tools, 'runtimeDefaults.tools');
  const exec = readRecord(tools.exec, 'runtimeDefaults.tools.exec');
  const compaction = readRecord(runtimeDefaults.compaction, 'runtimeDefaults.compaction');
  const media = readRecord(root.media, 'media');
  const image = readRecord(media.image, 'media.image');
  const video = readRecord(media.video, 'media.video');

  return {
    provider: {
      productionOrigin: readProductionOrigin(provider.productionOrigin),
      providerName: readProviderName(provider.providerName),
      managedProviderId: readNonEmptyString(provider.managedProviderId, 'provider.managedProviderId'),
      managedAccountId: readNonEmptyString(provider.managedAccountId, 'provider.managedAccountId'),
      authAccountId: readNonEmptyString(provider.authAccountId, 'provider.authAccountId'),
      defaultModel: readNonEmptyString(provider.defaultModel, 'provider.defaultModel'),
      defaultModelContextWindow: readPositiveInteger(
        provider.defaultModelContextWindow,
        'provider.defaultModelContextWindow',
      ),
      defaultApiProtocol: readEnum(
        provider.defaultApiProtocol,
        'provider.defaultApiProtocol',
        ['openai-responses', 'openai-completions'],
      ),
      defaultThinkingLevel: readEnum(
        provider.defaultThinkingLevel,
        'provider.defaultThinkingLevel',
        ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'],
      ),
      requestTimeoutSeconds: readPositiveInteger(
        provider.requestTimeoutSeconds,
        'provider.requestTimeoutSeconds',
      ),
    },
    auth: {
      requestTimeoutMs: readPositiveInteger(auth.requestTimeoutMs, 'auth.requestTimeoutMs'),
      bootstrapRequestTimeoutMs: readPositiveInteger(
        auth.bootstrapRequestTimeoutMs,
        'auth.bootstrapRequestTimeoutMs',
      ),
      relayRequestTimeoutMs: readPositiveInteger(auth.relayRequestTimeoutMs, 'auth.relayRequestTimeoutMs'),
      verificationRequestTimeoutMs: readPositiveInteger(
        auth.verificationRequestTimeoutMs,
        'auth.verificationRequestTimeoutMs',
      ),
      offlineGraceSeconds: readPositiveInteger(auth.offlineGraceSeconds, 'auth.offlineGraceSeconds'),
      verifyMemoryCacheSeconds: readPositiveInteger(
        auth.verifyMemoryCacheSeconds,
        'auth.verifyMemoryCacheSeconds',
      ),
      tokenRefreshSkewSeconds: readPositiveInteger(
        auth.tokenRefreshSkewSeconds,
        'auth.tokenRefreshSkewSeconds',
      ),
      defaultAccessTokenLifetimeSeconds: readPositiveInteger(
        auth.defaultAccessTokenLifetimeSeconds,
        'auth.defaultAccessTokenLifetimeSeconds',
      ),
    },
    marketplace: {
      defaultProvider: readEnum(
        marketplace.defaultProvider,
        'marketplace.defaultProvider',
        ['skillhub', 'clawhub'],
      ),
      skillHubApiOrigin: readMarketplaceOrigin(
        marketplace.skillHubApiOrigin,
        'marketplace.skillHubApiOrigin',
      ),
      skillHubWebOrigin: readMarketplaceOrigin(
        marketplace.skillHubWebOrigin,
        'marketplace.skillHubWebOrigin',
      ),
      clawHubConvexOrigin: readMarketplaceOrigin(
        marketplace.clawHubConvexOrigin,
        'marketplace.clawHubConvexOrigin',
      ),
      clawHubMirrorOrigin: readMarketplaceOrigin(
        marketplace.clawHubMirrorOrigin,
        'marketplace.clawHubMirrorOrigin',
      ),
      clawHubInstallOrigin: readMarketplaceOrigin(
        marketplace.clawHubInstallOrigin,
        'marketplace.clawHubInstallOrigin',
      ),
      requestTimeoutMs: readPositiveInteger(
        marketplace.requestTimeoutMs,
        'marketplace.requestTimeoutMs',
      ),
      downloadTimeoutMs: readPositiveInteger(
        marketplace.downloadTimeoutMs,
        'marketplace.downloadTimeoutMs',
      ),
      maxJsonBytes: readPositiveInteger(marketplace.maxJsonBytes, 'marketplace.maxJsonBytes'),
      maxDownloadBytes: readPositiveInteger(
        marketplace.maxDownloadBytes,
        'marketplace.maxDownloadBytes',
      ),
      maxArchiveFiles: readPositiveInteger(
        marketplace.maxArchiveFiles,
        'marketplace.maxArchiveFiles',
      ),
      maxArchiveEntryBytes: readPositiveInteger(
        marketplace.maxArchiveEntryBytes,
        'marketplace.maxArchiveEntryBytes',
      ),
      maxArchiveUncompressedBytes: readPositiveInteger(
        marketplace.maxArchiveUncompressedBytes,
        'marketplace.maxArchiveUncompressedBytes',
      ),
    },
    billing: {
      requestTimeoutMs: readPositiveInteger(billing.requestTimeoutMs, 'billing.requestTimeoutMs'),
      orderStatusPollIntervalMs: readPositiveInteger(
        billing.orderStatusPollIntervalMs,
        'billing.orderStatusPollIntervalMs',
      ),
      historyPageSize: readPositiveInteger(billing.historyPageSize, 'billing.historyPageSize'),
      routes: {
        overview: readApiPath(billingRoutes.overview, 'billing.routes.overview'),
        orders: readApiPath(billingRoutes.orders, 'billing.routes.orders'),
        history: readApiPath(billingRoutes.history, 'billing.routes.history'),
        verify: readApiPath(billingRoutes.verify, 'billing.routes.verify'),
      },
    },
    runtimeDefaults: {
      tools: {
        exec: {
          security: readEnum(
            exec.security,
            'runtimeDefaults.tools.exec.security',
            ['deny', 'allowlist', 'full'],
          ),
          ask: readEnum(exec.ask, 'runtimeDefaults.tools.exec.ask', ['off', 'on-miss', 'always']),
        },
      },
      compaction: {
        mode: readEnum(
          compaction.mode,
          'runtimeDefaults.compaction.mode',
          ['default', 'safeguard'],
        ),
        reserveTokensFloor: readPositiveInteger(
          compaction.reserveTokensFloor,
          'runtimeDefaults.compaction.reserveTokensFloor',
        ),
      },
    },
    media: {
      image: {
        timeoutMs: readPositiveInteger(image.timeoutMs, 'media.image.timeoutMs'),
        defaultSize: readPixelSize(image.defaultSize, 'media.image.defaultSize'),
      },
      video: {
        timeoutMs: readPositiveInteger(video.timeoutMs, 'media.video.timeoutMs'),
        pollIntervalMs: readPositiveInteger(video.pollIntervalMs, 'media.video.pollIntervalMs'),
        maxDownloadBytes: readPositiveInteger(video.maxDownloadBytes, 'media.video.maxDownloadBytes'),
        preferredResolution: readResolution(video.preferredResolution, 'media.video.preferredResolution'),
        preferredShortEdge: readPositiveInteger(video.preferredShortEdge, 'media.video.preferredShortEdge'),
      },
      testTimeoutMs: readPositiveInteger(media.testTimeoutMs, 'media.testTimeoutMs'),
      clientTimeoutBufferMs: readPositiveInteger(
        media.clientTimeoutBufferMs,
        'media.clientTimeoutBufferMs',
      ),
    },
  };
}

export const UCLAW_ENDPOINTS_CONFIG = validateUclawEndpointsConfig(rawConfig);

export const UCLAW_PRODUCTION_ORIGIN = UCLAW_ENDPOINTS_CONFIG.provider.productionOrigin;
export const UCLAW_MANAGED_SERVICE_NAME = UCLAW_ENDPOINTS_CONFIG.provider.providerName;
export const UCLAW_MANAGED_PROVIDER_BASE_URL = `${UCLAW_PRODUCTION_ORIGIN}/v1`;
export const UCLAW_MANAGED_PROVIDER_ID = UCLAW_ENDPOINTS_CONFIG.provider.managedProviderId;
export const UCLAW_MANAGED_ACCOUNT_ID = UCLAW_ENDPOINTS_CONFIG.provider.managedAccountId;
export const UCLAW_MANAGED_AUTH_ACCOUNT_ID = UCLAW_ENDPOINTS_CONFIG.provider.authAccountId;
export const UCLAW_DEFAULT_MODEL = UCLAW_ENDPOINTS_CONFIG.provider.defaultModel;
export const UCLAW_DEFAULT_API_PROTOCOL = UCLAW_ENDPOINTS_CONFIG.provider.defaultApiProtocol;
export const UCLAW_DEFAULT_MODEL_CONTEXT_WINDOW = UCLAW_ENDPOINTS_CONFIG.provider.defaultModelContextWindow;
export const UCLAW_DEFAULT_THINKING_LEVEL = UCLAW_ENDPOINTS_CONFIG.provider.defaultThinkingLevel;
export const UCLAW_PROVIDER_REQUEST_TIMEOUT_SECONDS = UCLAW_ENDPOINTS_CONFIG.provider.requestTimeoutSeconds;

export const UCLAW_AUTH_REQUEST_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.auth.requestTimeoutMs;
export const UCLAW_BOOTSTRAP_REQUEST_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.auth.bootstrapRequestTimeoutMs;
export const UCLAW_RELAY_REQUEST_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.auth.relayRequestTimeoutMs;
export const UCLAW_VERIFICATION_REQUEST_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.auth.verificationRequestTimeoutMs;
export const UCLAW_OFFLINE_GRACE_SECONDS = UCLAW_ENDPOINTS_CONFIG.auth.offlineGraceSeconds;
export const UCLAW_VERIFY_MEMORY_CACHE_SECONDS = UCLAW_ENDPOINTS_CONFIG.auth.verifyMemoryCacheSeconds;
export const UCLAW_TOKEN_REFRESH_SKEW_SECONDS = UCLAW_ENDPOINTS_CONFIG.auth.tokenRefreshSkewSeconds;
export const UCLAW_DEFAULT_ACCESS_TOKEN_LIFETIME_SECONDS = UCLAW_ENDPOINTS_CONFIG.auth.defaultAccessTokenLifetimeSeconds;

export const UCLAW_MARKETPLACE_CONFIG = UCLAW_ENDPOINTS_CONFIG.marketplace;
export const UCLAW_MARKETPLACE_DEFAULT_PROVIDER = UCLAW_MARKETPLACE_CONFIG.defaultProvider;
export const UCLAW_SKILLHUB_WEB_ORIGIN = UCLAW_MARKETPLACE_CONFIG.skillHubWebOrigin;
export const UCLAW_CLAWHUB_MIRROR_ORIGIN = UCLAW_MARKETPLACE_CONFIG.clawHubMirrorOrigin;

export const UCLAW_BILLING_REQUEST_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.billing.requestTimeoutMs;
export const UCLAW_BILLING_ORDER_STATUS_POLL_INTERVAL_MS = UCLAW_ENDPOINTS_CONFIG.billing.orderStatusPollIntervalMs;
export const UCLAW_BILLING_HISTORY_PAGE_SIZE = UCLAW_ENDPOINTS_CONFIG.billing.historyPageSize;
export const UCLAW_BILLING_ROUTES = UCLAW_ENDPOINTS_CONFIG.billing.routes;

export const UCLAW_EXEC_SECURITY = UCLAW_ENDPOINTS_CONFIG.runtimeDefaults.tools.exec.security;
export const UCLAW_EXEC_ASK = UCLAW_ENDPOINTS_CONFIG.runtimeDefaults.tools.exec.ask;
export const UCLAW_COMPACTION_MODE = UCLAW_ENDPOINTS_CONFIG.runtimeDefaults.compaction.mode;
export const UCLAW_COMPACTION_RESERVE_TOKENS_FLOOR = UCLAW_ENDPOINTS_CONFIG.runtimeDefaults.compaction.reserveTokensFloor;

export const UCLAW_IMAGE_GENERATION_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.media.image.timeoutMs;
export const UCLAW_IMAGE_GENERATION_DEFAULT_SIZE = UCLAW_ENDPOINTS_CONFIG.media.image.defaultSize;
export const UCLAW_VIDEO_GENERATION_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.media.video.timeoutMs;
export const UCLAW_VIDEO_GENERATION_MAX_DOWNLOAD_BYTES = UCLAW_ENDPOINTS_CONFIG.media.video.maxDownloadBytes;
export const UCLAW_VIDEO_GENERATION_POLL_INTERVAL_MS = UCLAW_ENDPOINTS_CONFIG.media.video.pollIntervalMs;
export const UCLAW_VIDEO_GENERATION_PREFERRED_RESOLUTION = UCLAW_ENDPOINTS_CONFIG.media.video.preferredResolution;
export const UCLAW_VIDEO_GENERATION_PREFERRED_SHORT_EDGE = UCLAW_ENDPOINTS_CONFIG.media.video.preferredShortEdge;
export const UCLAW_MEDIA_GENERATION_TEST_TIMEOUT_MS = UCLAW_ENDPOINTS_CONFIG.media.testTimeoutMs;
export const UCLAW_MEDIA_GENERATION_CLIENT_TIMEOUT_BUFFER_MS = UCLAW_ENDPOINTS_CONFIG.media.clientTimeoutBufferMs;
