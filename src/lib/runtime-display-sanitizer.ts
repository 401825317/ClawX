const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_RE = /(?:^|_)(?:authorization|proxy_authorization|cookie|set_cookie|api_key|access_token|refresh_token|id_token|auth_token|password|passwd|secret|credential|client_secret|private_key|signature|sig)(?:$|_)/iu;
const SENSITIVE_KEY_SUFFIX_RE = /(?:^|_)(?:token|secret|password|passwd|credential|private_key|api_key)$/iu;
const URL_SENSITIVE_PARAM_RE = /([?&#](?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|secret|credential|signature|sig|x-amz-credential|x-amz-signature)=)[^&#\s"']*/giu;

function normalizeSensitiveKey(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[^A-Za-z0-9]+/gu, '_')
    .replace(/^_+|_+$/gu, '')
    .toLowerCase();
}

export function isSensitiveRuntimeDisplayKey(value: string): boolean {
  const normalized = normalizeSensitiveKey(value);
  if (!normalized || normalized === 'session_key' || normalized === 'tool_call_id') return false;
  return SENSITIVE_KEY_RE.test(normalized) || SENSITIVE_KEY_SUFFIX_RE.test(normalized);
}

function sanitizeInlineSecrets(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, REDACTED)
    .replace(/\b(?:eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|sk-(?:proj-)?[A-Za-z0-9_-]{8,}|sess-[A-Za-z0-9_-]{8,})\b/gu, REDACTED)
    .replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s\/:@]+:)[^\s\/@]+(@)/gu, `$1${REDACTED}$2`)
    .replace(
      /((?:authorization|proxy[_-]?authorization)\s*[:=]\s*(?:bearer|basic)\s+)[^\s"',;]+/giu,
      `$1${REDACTED}`,
    )
    .replace(
      /((?:^|[\r\n])\s*(?:cookie|set-cookie)\s*:\s*)[^\r\n]*/gimu,
      `$1${REDACTED}`,
    )
    .replace(
      /(["']?(?:authorization|proxy[_-]?authorization|cookie|set[_-]?cookie|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|signature|sig|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY))["']?\s*[:=]\s*["'])[^"'\r\n]*(["'])/giu,
      `$1${REDACTED}$2`,
    )
    .replace(
      /((?:^|[\s{[(,;])(?:export\s+)?(?:[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY)|aws[_-]?secret[_-]?access[_-]?key|aws[_-]?session[_-]?token|api[_-]?key|apiKey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|cookie)\s*=\s*)[^\s,;)}\]]+/gimu,
      `$1${REDACTED}`,
    )
    .replace(
      /(--(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|password|passwd|secret|credential|client[_-]?secret|private[_-]?key|cookie)(?:=|\s+))["']?[^\s"']+["']?/giu,
      `$1${REDACTED}`,
    )
    .replace(URL_SENSITIVE_PARAM_RE, `$1${REDACTED}`);
}

export function sanitizeRuntimeDisplayText(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(sanitizeRuntimeDisplayValue(JSON.parse(value)));
    } catch {
      // Commands often contain JSON fragments without being JSON themselves.
    }
  }
  return sanitizeInlineSecrets(value);
}

export function sanitizeRuntimeDisplayValue(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === 'string') return sanitizeRuntimeDisplayText(value);
  if (value == null || typeof value !== 'object') return value;
  if (depth >= 10) return '[TRUNCATED]';
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeRuntimeDisplayValue(item, depth + 1, seen));
    }
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = isSensitiveRuntimeDisplayKey(key)
        ? REDACTED
        : sanitizeRuntimeDisplayValue(child, depth + 1, seen);
    }
    return sanitized;
  } finally {
    seen.delete(value);
  }
}

export function stringifyRuntimeDisplayValue(value: unknown): string | undefined {
  if (typeof value === 'string') return sanitizeRuntimeDisplayText(value);
  if (value == null) return undefined;
  try {
    return JSON.stringify(sanitizeRuntimeDisplayValue(value), null, 2);
  } catch {
    return sanitizeRuntimeDisplayText(String(value));
  }
}
