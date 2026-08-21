import type {
  HostApiAction,
  HostApiModule,
  HostApiPayloadArgs,
  HostApiResult,
} from '@shared/host-api/contract';
import type { TypedHostRequest } from '@shared/host-api/types';

const SAFE_RECOVERABLE_ERROR_CODES = new Set([
  'web_browser_url_not_allowed',
  'web_browser_file_requires_preview',
  'web_browser_private_network_blocked',
  'web_browser_dns_resolution_failed',
  'web_browser_preview_not_authorized',
  'web_browser_target_stale',
  'web_browser_navigation_aborted',
  'web_browser_navigation_timeout',
]);

export type HostApiRecoverableErrorDetails = {
  code: string;
  recoverable: true;
  restartGateway: false;
  recovery: string;
};

export class HostApiError extends Error {
  readonly code: string;
  readonly hostCode: string;
  readonly recoverable: boolean;
  readonly restartGateway: boolean;
  readonly recovery?: string;
  readonly recoverableCode?: string;

  constructor(message: string, hostCode: string, details?: HostApiRecoverableErrorDetails) {
    super(message);
    this.name = 'HostApiError';
    this.code = details?.code ?? hostCode;
    this.hostCode = hostCode;
    this.recoverable = details?.recoverable === true;
    this.restartGateway = details?.restartGateway ?? false;
    this.recovery = details?.recovery;
    this.recoverableCode = details?.code;
  }
}

function readRecoverableDetails(value: unknown): HostApiRecoverableErrorDetails | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const details = value as Record<string, unknown>;
  if (
    details.contract !== 'recoverable-v1'
    || typeof details.code !== 'string'
    || !SAFE_RECOVERABLE_ERROR_CODES.has(details.code)
    || details.recoverable !== true
    || details.restartGateway !== false
    || typeof details.recovery !== 'string'
    || details.recovery.length > 320
  ) return undefined;
  return {
    code: details.code,
    recoverable: true,
    restartGateway: false,
    recovery: details.recovery,
  };
}

function createRequestId(): string {
  return crypto.randomUUID();
}

export async function invokeHost<
  M extends HostApiModule,
  A extends HostApiAction<M>,
>(
  module: M,
  action: A,
  ...payloadArgs: HostApiPayloadArgs<M, A>
): Promise<HostApiResult<M, A>> {
  const bridge = window.clawx?.hostInvoke;
  if (!bridge) {
    throw new Error('Host invoke bridge is unavailable');
  }

  const request: TypedHostRequest<M, A> = {
    id: createRequestId(),
    module,
    action,
  };
  if (payloadArgs.length > 0) {
    request.payload = payloadArgs[0];
  }

  const response = await bridge<HostApiResult<M, A>>(request);

  if (!response.ok) {
    const hostError = response.error;
    const details = readRecoverableDetails(hostError?.details);
    throw new HostApiError(
      hostError?.message || `Host request failed: ${module}.${action}`,
      hostError?.code || 'INTERNAL',
      details,
    );
  }

  return response.data;
}
