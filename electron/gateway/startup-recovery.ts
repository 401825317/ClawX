/**
 * Gateway startup recovery heuristics.
 *
 * This module is intentionally dependency-free so it can be unit-tested
 * without Electron/runtime mocks.
 */

const INVALID_CONFIG_PATTERNS: RegExp[] = [
  /\binvalid config\b/i,
  /\bconfig invalid\b/i,
  /\bunrecognized key\b/i,
  /\brun:\s*openclaw doctor --fix\b/i,
];

const OPENCLAW_FUTURE_CONFIG_GUARD_PATTERNS: RegExp[] = [
  /Your OpenClaw config was written by version .+ but this command is running .+/i,
  /Refusing to run automatic gateway startup migrations because this OpenClaw binary .+ is older than the config last written by OpenClaw/i,
  /OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 only for an intentional downgrade or recovery action/i,
];

const DETERMINISTIC_RUNTIME_FAILURE_PATTERNS: RegExp[] = [
  /ERR_PACKAGE_IMPORT_NOT_DEFINED/i,
  /Package import specifier\s+["']?#[^\s"']+["']?\s+is not defined/i,
];

const TRANSIENT_START_ERROR_PATTERNS: RegExp[] = [
  /WebSocket closed before handshake/i,
  /ECONNREFUSED/i,
  /Gateway process exited before becoming ready/i,
  /Timed out waiting for connect\.challenge/i,
  /Connect handshake timeout/i,
  // OpenClaw can emit connect.challenge before the connect RPC is accepted.
  /gateway starting/i,
  // Port occupied after orphan kill: transient, worth retrying with backoff
  /Port \d+ still occupied after \d+ms/i,
];

/**
 * One initial connection plus four retries. Keep this budget explicit so a
 * slow Gateway cannot turn one startup into an unbounded restart storm.
 */
export const GATEWAY_CONNECT_STARTUP_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000] as const;
export const GATEWAY_CONNECT_STARTUP_MAX_ATTEMPTS = GATEWAY_CONNECT_STARTUP_RETRY_DELAYS_MS.length + 1;

/**
 * Marks a connect retry budget that was exhausted inside a single startup flow.
 * The startup orchestrator must not restart the process and replay this budget.
 */
export class GatewayConnectRetryExhaustedError extends Error {
  readonly code = 'gateway_connect_retry_limit_exhausted';
  readonly cause: unknown;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause ?? 'Gateway connect failed'));
    this.name = 'GatewayConnectRetryExhaustedError';
    this.cause = cause;
  }
}

export function isGatewayConnectRetryExhaustedError(error: unknown): error is GatewayConnectRetryExhaustedError {
  return error instanceof GatewayConnectRetryExhaustedError
    || (typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'gateway_connect_retry_limit_exhausted');
}

function normalizeLogLine(value: string): string {
  return value.trim();
}

/**
 * Returns true when text appears to indicate OpenClaw config validation failure.
 */
export function isInvalidConfigSignal(text: string): boolean {
  const normalized = normalizeLogLine(text);
  if (!normalized) return false;
  return INVALID_CONFIG_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Returns true for OpenClaw's explicit newer-config version guard. */
export function isOpenClawFutureConfigGuardSignal(text: string): boolean {
  const normalized = normalizeLogLine(text);
  if (!normalized) return false;
  return OPENCLAW_FUTURE_CONFIG_GUARD_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Checks startup stderr and the thrown error for the newer-config guard. */
export function hasOpenClawFutureConfigGuardSignal(
  startupError: unknown,
  startupStderrLines: string[],
): boolean {
  if (startupStderrLines.some(isOpenClawFutureConfigGuardSignal)) return true;

  const errorText = startupError instanceof Error
    ? `${startupError.name}: ${startupError.message}`
    : String(startupError ?? '');
  return isOpenClawFutureConfigGuardSignal(errorText);
}

/**
 * Returns true when either startup stderr lines or startup error message
 * indicate an OpenClaw config validation failure.
 */
export function hasInvalidConfigFailureSignal(
  startupError: unknown,
  startupStderrLines: string[],
): boolean {
  for (const line of startupStderrLines) {
    if (isInvalidConfigSignal(line)) {
      return true;
    }
  }

  const errorText = startupError instanceof Error
    ? `${startupError.name}: ${startupError.message}`
    : String(startupError ?? '');

  return isInvalidConfigSignal(errorText);
}

/**
 * Retry guard for one-time config repair during a single startup flow.
 */
export function shouldAttemptConfigAutoRepair(
  startupError: unknown,
  startupStderrLines: string[],
  alreadyAttempted: boolean,
): boolean {
  if (alreadyAttempted) return false;
  return hasInvalidConfigFailureSignal(startupError, startupStderrLines);
}

export function isTransientGatewayStartError(error: unknown): boolean {
  const errorText = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? '');
  return TRANSIENT_START_ERROR_PATTERNS.some((pattern) => pattern.test(errorText));
}

export function isGatewayStillStartingError(error: unknown): boolean {
  const errorText = error instanceof Error
    ? error.message
    : String(error ?? '');
  return /gateway starting/i.test(errorText);
}

export function hasDeterministicGatewayRuntimeFailureSignal(
  startupError: unknown,
  startupStderrLines: string[],
): boolean {
  const errorText = startupError instanceof Error
    ? `${startupError.name}: ${startupError.message}`
    : String(startupError ?? '');
  return [...startupStderrLines, errorText].some((line) => (
    DETERMINISTIC_RUNTIME_FAILURE_PATTERNS.some((pattern) => pattern.test(normalizeLogLine(line)))
  ));
}

export class GatewayRuntimePackageResolutionError extends Error {
  readonly code = 'gateway_runtime_package_resolution_failed';

  constructor(cause?: unknown) {
    super('Gateway runtime package imports could not be resolved', { cause });
    this.name = 'GatewayRuntimePackageResolutionError';
  }
}

export function isTransientGatewayConnectError(error: unknown): boolean {
  const errorText = error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error ?? '');
  return [
    /gateway starting/i,
    /WebSocket closed before handshake/i,
    /ECONNREFUSED/i,
    /Timed out waiting for connect\.challenge/i,
    /Connect handshake timeout/i,
    /Gateway WebSocket closed while loading handshake credentials/i,
  ].some((pattern) => pattern.test(errorText));
}

export async function connectGatewayWithStartupRetry(options: {
  connect: (port: number, externalToken?: string) => Promise<void>;
  port: number;
  externalToken?: string;
  delay: (ms: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
  beforeAttempt?: (attemptNo: number, maxAttempts: number) => void;
  onAttempt?: (attemptNo: number, maxAttempts: number) => void;
  logWarn?: (message: string) => void;
  logInfo?: (message: string) => void;
}): Promise<void> {
  const retryDelaysMs = options.retryDelaysMs ?? GATEWAY_CONNECT_STARTUP_RETRY_DELAYS_MS;
  const logWarn = options.logWarn ?? (() => {});
  const logInfo = options.logInfo ?? (() => {});
  let lastError: unknown;
  const maxAttempts = retryDelaysMs.length + 1;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const attemptNo = attempt + 1;
    options.beforeAttempt?.(attemptNo, maxAttempts);
    options.onAttempt?.(attemptNo, maxAttempts);
    try {
      await options.connect(options.port, options.externalToken);
      if (attempt > 0) {
        logInfo(`Gateway connect succeeded after ${attemptNo} attempt(s)`);
      }
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientGatewayConnectError(error)) {
        throw error;
      }
      if (attemptNo >= maxAttempts) {
        throw new GatewayConnectRetryExhaustedError(error);
      }
      const delayMs = retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1]!;
      logWarn(
        `Gateway connect transiently unavailable (${String(error)}); `
        + `retrying in ${delayMs}ms (retry ${attemptNo}/${maxAttempts})`,
      );
      await options.delay(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Gateway connect failed'));
}

export type GatewayStartupRecoveryAction = 'repair' | 'retry' | 'fail';

export function getGatewayStartupRecoveryAction(options: {
  startupError: unknown;
  startupStderrLines: string[];
  configRepairAttempted: boolean;
  attempt: number;
  maxAttempts: number;
}): GatewayStartupRecoveryAction {
  // Doctor and retries cannot repair a deliberate binary/config version guard.
  if (hasOpenClawFutureConfigGuardSignal(options.startupError, options.startupStderrLines)) {
    return 'fail';
  }

  if (hasDeterministicGatewayRuntimeFailureSignal(options.startupError, options.startupStderrLines)) {
    return 'fail';
  }

  if (shouldAttemptConfigAutoRepair(
    options.startupError,
    options.startupStderrLines,
    options.configRepairAttempted,
  )) {
    return 'repair';
  }

  if (options.attempt < options.maxAttempts && isTransientGatewayStartError(options.startupError)) {
    return 'retry';
  }

  return 'fail';
}
