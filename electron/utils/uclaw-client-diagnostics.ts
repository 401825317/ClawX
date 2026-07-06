import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { isPortableMode } from './portable-mode';

const CLIENT_DIAGNOSTIC_SESSION_ID = randomUUID();

function cleanHeaderValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  const cleaned = String(value).replace(/[\r\n\0]/g, ' ').trim();
  return cleaned || undefined;
}

function readAppVersion(): string | undefined {
  try {
    return cleanHeaderValue(app.getVersion());
  } catch {
    return undefined;
  }
}

function readRuntimeMode(): string {
  try {
    return isPortableMode() ? 'portable' : 'installed';
  } catch {
    return 'unknown';
  }
}

function setHeader(headers: Record<string, string>, key: string, value: unknown): void {
  const cleaned = cleanHeaderValue(value);
  if (cleaned) {
    headers[key] = cleaned;
  }
}

export function buildUClawClientDiagnosticHeaders(providerId?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  setHeader(headers, 'X-UClaw-Client', 'UClaw');
  setHeader(headers, 'X-UClaw-Version', readAppVersion());
  setHeader(headers, 'X-UClaw-Platform', process.platform);
  setHeader(headers, 'X-UClaw-Arch', process.arch);
  setHeader(headers, 'X-UClaw-Mode', readRuntimeMode());
  setHeader(headers, 'X-UClaw-Provider', providerId);
  setHeader(headers, 'X-UClaw-Session-Id', CLIENT_DIAGNOSTIC_SESSION_ID);
  return headers;
}

export function withUClawClientDiagnosticHeaders(
  existingHeaders: Record<string, string> | undefined,
  providerId?: string,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(existingHeaders ?? {})) {
    setHeader(merged, key, value);
  }
  return {
    ...merged,
    ...buildUClawClientDiagnosticHeaders(providerId),
  };
}
