import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';

export type SafeFatalReason = 'uncaught_exception' | 'unhandled_rejection' | 'fatal_error';
export type SafeFatalErrorName = 'Error' | 'TypeError' | 'RangeError' | 'ReferenceError' | 'SyntaxError' | 'URIError' | 'EvalError' | 'AggregateError';

export interface SafeFatalDiagnostic {
  eventId: string;
  occurredAt: string;
  reason: SafeFatalReason;
  errorName: SafeFatalErrorName;
  errorCode?: string;
  fingerprint: string;
}

const SAFE_ERROR_NAMES = new Set<SafeFatalErrorName>([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'URIError', 'EvalError', 'AggregateError',
]);
const SAFE_ERROR_CODES = new Set([
  'EACCES', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'EIO', 'EMFILE', 'ENOMEM', 'ENOSPC', 'EPERM', 'EPIPE', 'ETIMEDOUT',
  'ERR_ASSERTION', 'ERR_INTERNAL_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'ERR_OUT_OF_MEMORY', 'ERR_UNHANDLED_ERROR', 'ERR_WORKER_OUT_OF_MEMORY',
]);

export interface FatalHandlerDependencies {
  getEmergencyLogPath: () => string | null;
  stopGateway: () => Promise<unknown> | unknown;
  forceTerminateGateway?: () => Promise<unknown> | unknown;
  stopBlender: () => Promise<unknown> | unknown;
  exit: (code: number) => void;
  scheduleExit?: (callback: () => void, delayMs: number) => void | PromiseLike<void>;
  captureFatal?: (diagnostic: SafeFatalDiagnostic) => void | PromiseLike<void>;
}

function utf8PrefixAtMost(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function readStringProperty(value: unknown, key: 'name' | 'code'): string | undefined {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return undefined;
  try {
    const candidate = Reflect.get(value, key);
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function createSafeFatalDiagnostic(reason: string, error: unknown): SafeFatalDiagnostic {
  const normalizedReason = typeof reason === 'string' ? reason.trim().toLowerCase() : '';
  const safeReason: SafeFatalReason = normalizedReason.includes('unhandled') && normalizedReason.includes('rejection')
    ? 'unhandled_rejection'
    : normalizedReason.includes('uncaught') && normalizedReason.includes('exception')
      ? 'uncaught_exception'
      : 'fatal_error';
  const name = readStringProperty(error, 'name');
  const errorName = name && SAFE_ERROR_NAMES.has(name as SafeFatalErrorName) ? name as SafeFatalErrorName : 'Error';
  const code = readStringProperty(error, 'code');
  const errorCode = code && SAFE_ERROR_CODES.has(code) ? code : undefined;
  const fingerprint = createHash('sha256')
    .update(`${safeReason}\0${errorName}\0${errorCode ?? ''}`, 'utf8')
    .digest('hex');
  return Object.freeze({
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    reason: safeReason,
    errorName,
    ...(errorCode ? { errorCode } : {}),
    fingerprint,
  });
}

function writeEmergencyLog(path: string | null, diagnostic: SafeFatalDiagnostic): void {
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ level: 'fatal', ...diagnostic })}\n`, { encoding: 'utf8' });
  } catch {
    // Fatal handling must remain independent from every normal logging sink.
  }
}

function scheduleExitSafely(
  scheduleExit: (callback: () => void, delayMs: number) => void | PromiseLike<void>,
  callback: () => void,
): void {
  const fallback = () => {
    try {
      const timer = setTimeout(callback, 3000);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    } catch {
      try { callback(); } catch { /* Best effort. */ }
    }
  };

  try {
    const scheduled = scheduleExit(callback, 3000);
    if (scheduled) void Promise.resolve(scheduled).catch(fallback);
    return;
  } catch {
    // A broken test/runtime scheduler must not leave the process alive.
  }
  fallback();
}

export const __test = { createSafeFatalDiagnostic, utf8PrefixAtMost };

export function createFatalHandler(dependencies: FatalHandlerDependencies): (reason: string, error: unknown) => boolean {
  let handlingFatal = false;
  let terminationStarted = false;
  return (reason, error) => {
    if (handlingFatal) return false;
    handlingFatal = true;
    const diagnostic = createSafeFatalDiagnostic(reason, error);
    let emergencyLogPath: string | null = null;
    try { emergencyLogPath = dependencies.getEmergencyLogPath(); } catch { /* Best effort. */ }
    writeEmergencyLog(emergencyLogPath, diagnostic);
    try {
      const captureResult = dependencies.captureFatal?.(diagnostic);
      if (captureResult) void Promise.resolve(captureResult).catch(() => undefined);
    } catch { /* Best effort. */ }
    try { void Promise.resolve(dependencies.stopBlender()).catch(() => undefined); } catch { /* Best effort. */ }
    try { void Promise.resolve(dependencies.stopGateway()).catch(() => undefined); } catch { /* Best effort. */ }
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      try { void Promise.resolve(dependencies.forceTerminateGateway?.()).catch(() => undefined); } catch { /* Best effort. */ }
      try { dependencies.exit(1); } catch { /* Best effort. */ }
    };
    scheduleExitSafely(dependencies.scheduleExit ?? ((callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
        (timer as NodeJS.Timeout).unref();
      }
    }), terminate);
    return true;
  };
}
