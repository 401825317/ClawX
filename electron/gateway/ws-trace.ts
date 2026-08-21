import { createHash } from 'node:crypto';

const SECRET_KEY = /(?:authorization|cookie|token|api[_-]?key|signature|secret|password|credential|prompt|instruction|message|content|raw_?params?|input|arguments|request|response|attachment|file|image|video)/iu;
const STRUCTURAL_KEYS = new Set([
  'type', 'id', 'method', 'event', 'ok', 'code', 'status', 'name', 'attempt',
  'traceid', 'trace_id', 'runid', 'run_id',
]);
const PRIVATE_NETWORK_KEYS = new Set(['allowprivatenetwork', 'dangerouslyallowprivatenetwork']);
const WINDOWS_USER_PATH = /(?:file:\/\/\/)?[A-Z]:\\(?:Users|Documents and Settings)\\[^\r\n"'`{}\x5B\x5D()<>]+/giu;
const POSIX_USER_PATH = /(?:file:\/\/)?\/(?:Users|home)\/[^\r\n"'`{}\x5B\x5D()<>]+/gu;

interface RedactedFrameValue {
  redacted: true;
  bytes: number;
  sha256: string;
}

export function isGatewayWsTraceEnabled(): boolean {
  return process.env.CLAWX_GATEWAY_WS_TRACE === '1';
}

function stableFrameValue(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (typeof value === 'undefined') return '"[undefined]"';
  if (typeof value === 'symbol' || typeof value === 'function') return JSON.stringify(String(value));
  if (Buffer.isBuffer(value)) return JSON.stringify({ type: 'Buffer', base64: value.toString('base64') });
  if (value instanceof Uint8Array) return JSON.stringify({
    type: value.constructor.name,
    base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('base64'),
  });
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map(item => stableFrameValue(item, seen)).join(',')}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableFrameValue(record[key], seen)}`
  )).join(',')}}`;
}

function summarizeFrameValue(value: unknown): RedactedFrameValue {
  const serialized = typeof value === 'string'
    ? Buffer.from(value, 'utf8')
    : Buffer.from(stableFrameValue(value), 'utf8');
  return {
    redacted: true,
    bytes: serialized.byteLength,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

function safeStructuralValue(value: unknown): unknown {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (typeof value !== 'string') return summarizeFrameValue(value);
  return value
    .slice(0, 128)
    .replace(WINDOWS_USER_PATH, '[UserPath]')
    .replace(POSIX_USER_PATH, '[UserPath]');
}

function redactGatewayFrameValue(value: unknown, key = '', depth = 0): unknown {
  const normalizedKey = key.toLowerCase();
  if (PRIVATE_NETWORK_KEYS.has(normalizedKey)) {
    return { requested: value === true, policy: 'not-enabled-by-ws-trace' };
  }
  if (SECRET_KEY.test(key)) return summarizeFrameValue(value);
  if (STRUCTURAL_KEYS.has(normalizedKey)) return safeStructuralValue(value);
  if (depth >= 4 || Array.isArray(value) || !value || typeof value !== 'object') {
    return summarizeFrameValue(value);
  }

  const result: Record<string, unknown> = {};
  for (const [entryKey, item] of Object.entries(value as Record<string, unknown>)) {
    result[entryKey] = redactGatewayFrameValue(item, entryKey, depth + 1);
  }
  return result;
}

/** Gateway tracing is developer-only and never changes the SSRF policy. */
export function redactGatewayFrameForTrace(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return summarizeFrameValue(value);
  }
  return redactGatewayFrameValue(value, '', 0);
}

export function summarizeGatewayFrameForTrace(value: unknown): string {
  if (!value || typeof value !== 'object') return typeof value;
  const frame = value as Record<string, unknown>;
  if (frame.type === 'req') {
    return `req id=${String(safeStructuralValue(frame.id ?? '-'))} method=${String(safeStructuralValue(frame.method ?? '-'))}`;
  }
  if (frame.type === 'res') {
    return `res id=${String(safeStructuralValue(frame.id ?? '-'))} ok=${String(frame.ok ?? !frame.error)}`;
  }
  if (frame.type === 'event') {
    return `event ${String(safeStructuralValue(frame.event ?? '-'))}`;
  }
  if (typeof frame.method === 'string') {
    return `jsonrpc method=${String(safeStructuralValue(frame.method))}`;
  }
  return 'unknown gateway frame';
}
