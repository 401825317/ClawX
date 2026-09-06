/**
 * Small, dependency-free helpers for classifying failures while starting the
 * embedded ACP process.  Connection/protocol failures are safe to retry; a
 * process which ran out of memory (or crashed while starting) needs a cooling
 * period so a second process is not created on top of the same pressure.
 */

export type AcpProcessFailureKind = 'resource' | 'process-exit' | 'other';

const RESOURCE_ERROR_PATTERN = /(?:acp[_ -]?resource[_ -]?exhausted|out of memory|heap out of memory|fatal process out of memory|allocation failed|resource[_ -]?exhausted|not enough memory|memory pressure|status[_ -]?no[_ -]?memory|err[_ -]?out[_ -]?of[_ -]?memory|err[_ -]?worker[_ -]?out[_ -]?of[_ -]?memory|\benomem\b)/iu;
const PROCESS_EXIT_PATTERN = /\bacp process (?:exited with code|did not initialize or exit within)\b/iu;

function collectFailureText(value: unknown, seen: Set<object>, depth = 0): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);

  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['name', 'message', 'code', 'type', 'error', 'cause', 'details', 'reason']) {
    if (record[key] !== undefined) parts.push(collectFailureText(record[key], seen, depth + 1));
  }
  return parts.filter(Boolean).join(' ');
}

export function classifyAcpProcessFailure(error: unknown): AcpProcessFailureKind {
  const text = collectFailureText(error, new Set());
  if (RESOURCE_ERROR_PATTERN.test(text)) return 'resource';
  if (PROCESS_EXIT_PATTERN.test(text)) return 'process-exit';
  return 'other';
}

export function isAcpResourceFailure(error: unknown): boolean {
  return classifyAcpProcessFailure(error) === 'resource';
}

/** Exponential cooling delay for a bounded process restart attempt. */
export function acpProcessRetryDelayMs(attempt: number): number {
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  return Math.min(8_000, 1_000 * (2 ** (safeAttempt - 1)));
}

export const __test = {
  collectFailureText,
  resourcePattern: RESOURCE_ERROR_PATTERN,
  processExitPattern: PROCESS_EXIT_PATTERN,
};
