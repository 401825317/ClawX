type UnknownRecord = Record<string, unknown>;

const FILTERED = '[Filtered]';
const USER_PATH = '[UserPath]';
const CIRCULAR = '[Circular]';
const UNSERIALIZABLE = '[Unserializable]';
const TRUNCATED = '[Truncated]';

const MAX_SCRUB_DEPTH = 8;
const MAX_SCRUB_KEYS = 64;
const MAX_SCRUB_ARRAY_ITEMS = 64;
const MAX_SCRUB_STRING_LENGTH = 4_096;

const SAFE_LEVELS = new Set(['fatal', 'error', 'warning', 'info', 'debug']);
const SAFE_PLATFORMS = new Set(['javascript', 'node', 'native']);
const SAFE_ENVIRONMENTS = new Set(['production', 'development', 'test']);
const SAFE_BREADCRUMB_TYPES = new Set(['default', 'debug', 'error', 'http', 'navigation', 'system', 'user']);
const SAFE_CONTEXT_NAMES = new Set(['app', 'device', 'gateway', 'os', 'renderer', 'runtime', 'trace', 'uclaw']);
const SAFE_CONTEXT_KEYS = new Set([
  'app_build', 'app_name', 'app_version', 'arch', 'attempt', 'buildId', 'build_type',
  'channel', 'commit', 'errorCode', 'errorName', 'eventId', 'exitCode', 'family',
  'kind', 'mode', 'model', 'name', 'op', 'parent_span_id', 'phase', 'platform',
  'policyVersion', 'retryable', 'runId', 'run_id', 'skill', 'skillVersion',
  'span_id', 'status', 'statusCode', 'subsystem', 'traceId', 'trace_id', 'version',
]);
const SAFE_TAG_KEYS = new Set([
  'artifact_task', 'fatal_error_code', 'fatal_error_name', 'fatal_event_id',
  'fatal_reason', 'handled', 'kind', 'mode', 'phase', 'platform', 'subsystem',
]);
const SAFE_FRAME_ROOTS = new Set([
  'dist', 'dist-electron', 'electron', 'node_modules', 'resources', 'scripts', 'shared', 'src',
]);

const SAFE_IDENTIFIER = /^[A-Za-z0-9_@.+:/~-]{1,160}$/u;
const SAFE_ERROR_TYPE = /^[A-Za-z_$][A-Za-z0-9_$.-]{0,79}$/u;
const SAFE_EVENT_ID = /^[0-9a-f]{32}$/iu;
const SAFE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_TRACE_ID = /^[0-9a-f]{32}$/iu;
const SAFE_SPAN_ID = /^[0-9a-f]{16}$/iu;
const SAFE_HASH = /^[0-9a-f]{8,128}$/iu;
const SAFE_COMMIT = /^(?:development|unknown|[0-9a-f]{7,64})$/iu;
const SAFE_TAG_SLUG = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_FATAL_REASONS = new Set(['uncaught_exception', 'unhandled_rejection', 'fatal_error']);
const SAFE_FATAL_ERROR_CODES = new Set([
  'none', 'EACCES', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'EIO', 'EMFILE',
  'ENOMEM', 'ENOSPC', 'EPERM', 'EPIPE', 'ETIMEDOUT', 'ERR_ASSERTION',
  'ERR_INTERNAL_ASSERTION', 'ERR_MODULE_NOT_FOUND', 'ERR_OUT_OF_MEMORY',
  'ERR_UNHANDLED_ERROR', 'ERR_WORKER_OUT_OF_MEMORY',
]);
const SAFE_OS_PLATFORMS = new Set(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32']);

const ABSOLUTE_URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s<>"']+/giu;
const FILE_URL_PATTERN = /\bfile:\/\/[^\s<>"']*/giu;
const WINDOWS_PATH_PATTERN = /(^|[\s("'`=])(?:[A-Za-z]:[\\/]|\\\\(?:[?.][\\/])?)[^\r\n"'`<>]*/gimu;
const POSIX_USER_PATH_PATTERN = /(^|[\s("'`=])\/(?:Users|home|root|tmp|var\/folders)(?:\/[^\r\n"'`<>]*)?/gimu;
const WINDOWS_PATH_TEST = /(?:^|[\s("'`=])(?:[A-Za-z]:[\\/]|\\\\(?:[?.][\\/])?)/imu;
const POSIX_USER_PATH_TEST = /(?:^|[\s("'`=])\/(?:Users|home|root|tmp|var\/folders)(?:\/|$)/imu;
const URL_LIKE_TEST = /(?:^[A-Za-z][A-Za-z0-9+.-]*:\/\/|^[^/@:\s]+:[^/@\s]+@[^/@\s]+$)/u;
const INLINE_AUTH_PATTERN = /\b((?:authorization|proxy-authorization|cookie|set-cookie)\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/giu;
const INLINE_SECRET_PATTERN = /((?:"|')?(?:access[_-]?token|refresh[_-]?token|relay[_-]?token|token|api[_-]?key|password|passwd|passphrase|client[_-]?secret|secret|credential|prompt|instruction|file[_-]?content|request[_-]?body|response[_-]?body)(?:"|')?\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)/giu;
const AUTHORIZATION_VALUE_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}/giu;
const COMMON_SECRET_PATTERN = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{12,})\b/gu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const SECRET_VALUE_TEST = /(?:\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{4,}|\bsk-[A-Za-z0-9_-]{8,}|\bgh[pousr]_[A-Za-z0-9]{8,}|\bxox[baprs]-[A-Za-z0-9-]{8,}|\bAIza[A-Za-z0-9_-]{20,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/u;
const EMAIL_ADDRESS_TEST = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu;
const SENSITIVE_IDENTIFIER_TEST = /(?:^|[^A-Za-z0-9])(?:authorization|cookie|credential|password|passwd|passphrase|secret|token|api[_-]?key)(?:$|[^A-Za-z0-9])/iu;

const SENSITIVE_KEYS = new Set([
  'accesstoken', 'apikey', 'args', 'arguments', 'attachment', 'attachmentcontent',
  'authorization', 'body', 'buffer', 'clientsecret', 'content', 'cookie',
  'credential', 'credentials', 'data', 'document', 'documentcontent', 'filecontent',
  'input', 'inputcontent', 'instruction', 'output', 'outputcontent', 'passphrase',
  'passwd', 'password', 'payload', 'prompt', 'prompttext', 'proxyauthorization',
  'raw', 'rawbody', 'rawparams', 'refreshtoken', 'relaytoken', 'requestbody',
  'requestdata', 'responsebody', 'responsedata', 'secret', 'sessioncookie',
  'setcookie', 'source', 'sourcecontent', 'systemprompt', 'text', 'token',
  'userprompt',
]);
const SENSITIVE_QUERY_KEYS = new Set([
  'accesstoken', 'apikey', 'auth', 'authorization', 'clientsecret', 'code', 'cookie',
  'credential', 'key', 'password', 'passwd', 'refreshtoken', 'relaytoken', 'secret',
  'session', 'sessionid', 'sig', 'signature', 'token', 'xamzcredential',
  'xamzsignature', 'xgoogcredential', 'xgoogsignature',
]);
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function isSensitiveKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (normalized.includes('prompt') || normalized.includes('instruction')) return true;
  if (/(?:token|apikey|password|passwd|passphrase|secret|credential|cookie)$/u.test(normalized)) {
    return !/(?:count|length|size|hash|type|name|version)$/u.test(normalized);
  }
  return /(?:file|document|attachment|request|response|source)(?:body|content|data|text|bytes)$/u.test(normalized);
}

function asRecord(value: unknown): UnknownRecord | null {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as UnknownRecord
      : null;
  } catch {
    return null;
  }
}

function asArray(value: unknown): unknown[] | null {
  try {
    return Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function dataProperty(record: UnknownRecord, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function enumerableDataEntries(record: UnknownRecord): Array<[string, unknown, boolean]> | null {
  try {
    const descriptors = Object.getOwnPropertyDescriptors(record);
    return Object.entries(descriptors)
      .filter(([, descriptor]) => descriptor.enumerable)
      .map(([key, descriptor]) => [
        key,
        'value' in descriptor ? descriptor.value : undefined,
        !('value' in descriptor),
      ]);
  } catch {
    return null;
  }
}

function arrayDataValues(value: unknown, maxItems: number, fromEnd = false): unknown[] {
  const array = asArray(value);
  if (!array) return [];
  try {
    const length = Math.min(array.length, Number.MAX_SAFE_INTEGER);
    const start = fromEnd ? Math.max(0, length - maxItems) : 0;
    const end = fromEnd ? length : Math.min(length, maxItems);
    const values: unknown[] = [];
    for (let index = start; index < end; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(array, String(index));
      if (descriptor && 'value' in descriptor) values.push(descriptor.value);
    }
    return values;
  } catch {
    return [];
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15
    ? value
    : undefined;
}

function hasUnsafeDiagnosticText(value: string): boolean {
  return WINDOWS_PATH_TEST.test(value)
    || POSIX_USER_PATH_TEST.test(value)
    || URL_LIKE_TEST.test(value)
    || SECRET_VALUE_TEST.test(value)
    || EMAIL_ADDRESS_TEST.test(value)
    || SENSITIVE_IDENTIFIER_TEST.test(value)
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
}

function safeIdentifier(value: unknown, maxLength = 160): string | undefined {
  if (
    typeof value !== 'string'
    || value.length > maxLength
    || !SAFE_IDENTIFIER.test(value)
    || hasUnsafeDiagnosticText(value)
  ) return undefined;
  return value;
}

function safeErrorType(value: unknown): string | undefined {
  return typeof value === 'string'
    && SAFE_ERROR_TYPE.test(value)
    && !hasUnsafeDiagnosticText(value)
    ? value
    : undefined;
}

function safeFrameFilename(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) return undefined;
  const normalized = value.replace(/\\/gu, '/').split(/[?#]/u, 1)[0];
  const segments = normalized.split('/').filter(Boolean);
  const rootIndex = segments.findIndex(segment => SAFE_FRAME_ROOTS.has(segment));
  if (rootIndex < 0) return undefined;
  const relative = segments.slice(rootIndex).join('/');
  if (
    relative.length > 320
    || relative.split('/').some(segment => segment === '..' || segment === '.')
    || !/^[A-Za-z0-9_@.+/~-]+$/u.test(relative)
    || hasUnsafeDiagnosticText(relative)
  ) return undefined;
  return relative;
}

function projectFrame(value: unknown): UnknownRecord | null {
  const frame = asRecord(value);
  if (!frame) return null;
  const projected: UnknownRecord = {};
  const filename = safeFrameFilename(dataProperty(frame, 'filename') ?? dataProperty(frame, 'abs_path'));
  const lineno = finiteNumber(dataProperty(frame, 'lineno'));
  const colno = finiteNumber(dataProperty(frame, 'colno'));
  if (filename) projected.filename = filename;
  if (lineno !== undefined && lineno >= 0) projected.lineno = Math.floor(lineno);
  if (colno !== undefined && colno >= 0) projected.colno = Math.floor(colno);
  const inApp = dataProperty(frame, 'in_app');
  if (typeof inApp === 'boolean') projected.in_app = inApp;
  return Object.keys(projected).length > 0 ? projected : null;
}

function projectStacktrace(value: unknown): UnknownRecord | undefined {
  const stacktrace = asRecord(value);
  if (!stacktrace) return undefined;
  const frames = arrayDataValues(dataProperty(stacktrace, 'frames'), 40, true)
    .map(projectFrame)
    .filter((frame): frame is UnknownRecord => frame !== null);
  return frames.length > 0 ? { frames } : undefined;
}

function projectException(value: unknown): UnknownRecord | undefined {
  const exception = asRecord(value);
  if (!exception) return undefined;
  const values = arrayDataValues(dataProperty(exception, 'values'), 10, true)
    .flatMap((entry): UnknownRecord[] => {
      const source = asRecord(entry);
      if (!source) return [];
      const projected: UnknownRecord = {};
      const type = safeErrorType(dataProperty(source, 'type'));
      const stacktrace = projectStacktrace(dataProperty(source, 'stacktrace'));
      if (type) projected.type = type;
      if (stacktrace) projected.stacktrace = stacktrace;

      const mechanism = asRecord(dataProperty(source, 'mechanism'));
      if (mechanism) {
        const mechanismType = safeIdentifier(dataProperty(mechanism, 'type'), 64);
        const projectedMechanism: UnknownRecord = {};
        if (mechanismType) projectedMechanism.type = mechanismType;
        const handled = dataProperty(mechanism, 'handled');
        if (typeof handled === 'boolean') projectedMechanism.handled = handled;
        if (Object.keys(projectedMechanism).length > 0) projected.mechanism = projectedMechanism;
      }
      return Object.keys(projected).length > 0 ? [projected] : [];
    });
  return values.length > 0 ? { values } : undefined;
}

function safeContextValue(key: string, value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  const numberValue = finiteNumber(value);
  if (numberValue !== undefined) return numberValue;
  if (typeof value !== 'string') return undefined;
  if (/hash|fingerprint/iu.test(key)) return SAFE_HASH.test(value) ? value.toLowerCase() : undefined;
  if (key === 'eventId') {
    return SAFE_UUID.test(value) || SAFE_EVENT_ID.test(value) ? value.toLowerCase() : undefined;
  }
  if (key === 'traceId' || key === 'trace_id') {
    return SAFE_TRACE_ID.test(value) ? value.toLowerCase() : undefined;
  }
  if (key === 'span_id' || key === 'parent_span_id') {
    return SAFE_SPAN_ID.test(value) ? value.toLowerCase() : undefined;
  }
  if (key === 'commit') return SAFE_COMMIT.test(value) ? value.toLowerCase() : undefined;
  return safeIdentifier(value);
}

export function projectObservabilityContext(value: unknown): UnknownRecord {
  const context = asRecord(value);
  if (!context) return {};
  const output: UnknownRecord = {};
  for (const key of SAFE_CONTEXT_KEYS) {
    const safeValue = safeContextValue(key, dataProperty(context, key));
    if (safeValue !== undefined) output[key] = safeValue;
  }
  return output;
}

function projectContexts(value: unknown): UnknownRecord | undefined {
  const contexts = asRecord(value);
  if (!contexts) return undefined;
  const output: UnknownRecord = {};
  for (const name of SAFE_CONTEXT_NAMES) {
    const projected = projectObservabilityContext(dataProperty(contexts, name));
    if (Object.keys(projected).length > 0) output[name] = projected;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function safeTagValue(key: string, value: unknown): string | undefined {
  if (typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  if (key === 'handled' || key === 'artifact_task') {
    return value === 'true' || value === 'false' ? value : undefined;
  }
  if (key === 'fatal_event_id') {
    return SAFE_UUID.test(value) || SAFE_EVENT_ID.test(value) ? value.toLowerCase() : undefined;
  }
  if (key === 'fatal_error_name') return safeErrorType(value);
  if (key === 'fatal_error_code') return SAFE_FATAL_ERROR_CODES.has(value) ? value : undefined;
  if (key === 'fatal_reason') return SAFE_FATAL_REASONS.has(value) ? value : undefined;
  if (key === 'platform') return SAFE_OS_PLATFORMS.has(value) ? value : undefined;
  return SAFE_TAG_SLUG.test(value) && !hasUnsafeDiagnosticText(value) ? value : undefined;
}

function projectTags(value: unknown): Record<string, string> | undefined {
  const tags = asRecord(value);
  if (!tags) return undefined;
  const output: Record<string, string> = {};
  for (const key of SAFE_TAG_KEYS) {
    const safeValue = safeTagValue(key, dataProperty(tags, key));
    if (safeValue !== undefined) output[key] = safeValue;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function projectObservabilityBreadcrumb(value: unknown): UnknownRecord | null {
  const breadcrumb = asRecord(value);
  if (!breadcrumb) return null;
  const output: UnknownRecord = {};
  const timestamp = finiteNumber(dataProperty(breadcrumb, 'timestamp'));
  const type = safeIdentifier(dataProperty(breadcrumb, 'type'), 32);
  const category = safeIdentifier(dataProperty(breadcrumb, 'category'), 64);
  const rawLevel = dataProperty(breadcrumb, 'level');
  const level = typeof rawLevel === 'string' && SAFE_LEVELS.has(rawLevel) ? rawLevel : undefined;
  if (timestamp !== undefined && timestamp >= 0) output.timestamp = timestamp;
  if (type && SAFE_BREADCRUMB_TYPES.has(type)) output.type = type;
  if (category) output.category = category;
  if (level) output.level = level;
  return Object.keys(output).length > 0 ? output : null;
}

function projectBreadcrumbs(value: unknown): UnknownRecord[] | undefined {
  const breadcrumbs = arrayDataValues(value, 50, true)
    .map(projectObservabilityBreadcrumb)
    .filter((breadcrumb): breadcrumb is UnknownRecord => breadcrumb !== null);
  return breadcrumbs.length > 0 ? breadcrumbs : undefined;
}

function projectFingerprint(value: unknown): string[] | undefined {
  const fingerprint = arrayDataValues(value, 8)
    .filter((entry): entry is string => (
      typeof entry === 'string' && (SAFE_HASH.test(entry) || entry === '{{ default }}')
    ))
    .map(entry => entry === '{{ default }}' ? entry : entry.toLowerCase());
  return fingerprint.length > 0 ? fingerprint : undefined;
}

export function projectObservabilityEvent(value: unknown): UnknownRecord | null {
  const event = asRecord(value);
  if (!event) return null;
  const output: UnknownRecord = {};
  const eventId = dataProperty(event, 'event_id');
  if (typeof eventId === 'string' && SAFE_EVENT_ID.test(eventId)) output.event_id = eventId.toLowerCase();
  const timestamp = finiteNumber(dataProperty(event, 'timestamp'));
  const startTimestamp = finiteNumber(dataProperty(event, 'start_timestamp'));
  if (timestamp !== undefined && timestamp >= 0) output.timestamp = timestamp;
  if (startTimestamp !== undefined && startTimestamp >= 0) output.start_timestamp = startTimestamp;
  const level = dataProperty(event, 'level');
  const platform = dataProperty(event, 'platform');
  const environment = dataProperty(event, 'environment');
  const release = dataProperty(event, 'release');
  if (typeof level === 'string' && SAFE_LEVELS.has(level)) output.level = level;
  if (typeof platform === 'string' && SAFE_PLATFORMS.has(platform)) output.platform = platform;
  if (typeof environment === 'string' && SAFE_ENVIRONMENTS.has(environment)) output.environment = environment;
  if (
    typeof release === 'string'
    && /^uclaw@[A-Za-z0-9.+_-]{1,160}$/u.test(release)
    && !hasUnsafeDiagnosticText(release)
  ) output.release = release;
  if (dataProperty(event, 'type') === 'transaction') output.type = 'transaction';

  const exception = projectException(dataProperty(event, 'exception'));
  const contexts = projectContexts(dataProperty(event, 'contexts'));
  const tags = projectTags(dataProperty(event, 'tags'));
  const breadcrumbs = projectBreadcrumbs(dataProperty(event, 'breadcrumbs'));
  const fingerprint = projectFingerprint(dataProperty(event, 'fingerprint'));
  if (exception) output.exception = exception;
  if (contexts) output.contexts = contexts;
  if (tags) output.tags = tags;
  if (breadcrumbs) output.breadcrumbs = breadcrumbs;
  if (fingerprint) output.fingerprint = fingerprint;
  return Object.keys(output).length > 0 ? output : null;
}

function redactInlineSecrets(value: string): string {
  return value
    .replace(INLINE_AUTH_PATTERN, `$1${FILTERED}`)
    .replace(INLINE_SECRET_PATTERN, `$1${FILTERED}`)
    .replace(AUTHORIZATION_VALUE_PATTERN, match => `${match.split(/\s/u, 1)[0]} ${FILTERED}`)
    .replace(COMMON_SECRET_PATTERN, FILTERED)
    .replace(JWT_PATTERN, FILTERED);
}

function sanitizeUrl(raw: string): string {
  const punctuation = /[),.;!?]+$/u.exec(raw)?.[0] ?? '';
  const candidate = punctuation ? raw.slice(0, -punctuation.length) : raw;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'file:') return USER_PATH + punctuation;
    if (parsed.username || parsed.password) {
      parsed.username = FILTERED;
      parsed.password = '';
    }
    for (const [key, entryValue] of [...parsed.searchParams.entries()]) {
      const decodedValue = (() => {
        try {
          return decodeURIComponent(entryValue);
        } catch {
          return entryValue;
        }
      })();
      if (
        SENSITIVE_QUERY_KEYS.has(normalizedKey(key))
        || SECRET_VALUE_TEST.test(decodedValue)
        || WINDOWS_PATH_TEST.test(decodedValue)
        || POSIX_USER_PATH_TEST.test(decodedValue)
      ) parsed.searchParams.set(key, FILTERED);
    }
    if (parsed.hash) parsed.hash = FILTERED;
    return parsed.toString().replace(/%5BFiltered%5D/giu, FILTERED) + punctuation;
  } catch {
    return redactInlineSecrets(candidate) + punctuation;
  }
}

function scrubString(value: string, depth: number, seen: WeakSet<object>): string {
  if (value.length > MAX_SCRUB_STRING_LENGTH) return TRUNCATED;
  const trimmed = value.trim();
  if (depth < MAX_SCRUB_DEPTH && ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']')))) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const scrubbed = scrubValue(parsed, depth + 1, seen);
        const encoded = JSON.stringify(scrubbed);
        if (encoded.length <= MAX_SCRUB_STRING_LENGTH) return encoded;
        return TRUNCATED;
      }
    } catch {
      // Not a JSON payload; continue with bounded text redaction.
    }
  }

  const urls: string[] = [];
  let urlPlaceholderPrefix = '__UCLAW_OBSERVABILITY_URL_';
  while (value.includes(urlPlaceholderPrefix)) urlPlaceholderPrefix += '_';
  let scrubbed = value
    .replace(FILE_URL_PATTERN, USER_PATH)
    .replace(ABSOLUTE_URL_PATTERN, match => {
      const index = urls.push(sanitizeUrl(match)) - 1;
      return `${urlPlaceholderPrefix}${index}__`;
    });
  scrubbed = redactInlineSecrets(scrubbed)
    .replace(WINDOWS_PATH_PATTERN, `$1${USER_PATH}`)
    .replace(POSIX_USER_PATH_PATTERN, `$1${USER_PATH}`);
  for (const [index, url] of urls.entries()) {
    scrubbed = scrubbed.replaceAll(`${urlPlaceholderPrefix}${index}__`, url);
  }
  return scrubbed;
}

function scrubValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : UNSERIALIZABLE;
  if (typeof value === 'string') return scrubString(value, depth, seen);
  if (typeof value !== 'object') return UNSERIALIZABLE;
  if (depth >= MAX_SCRUB_DEPTH) return TRUNCATED;
  try {
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);

    const array = asArray(value);
    if (array) {
      const values = arrayDataValues(array, MAX_SCRUB_ARRAY_ITEMS)
        .map(entry => scrubValue(entry, depth + 1, seen));
      if (array.length > MAX_SCRUB_ARRAY_ITEMS) values.push(TRUNCATED);
      return values;
    }

    const record = asRecord(value);
    if (!record) return UNSERIALIZABLE;
    const entries = enumerableDataEntries(record);
    if (!entries) return UNSERIALIZABLE;
    const output: UnknownRecord = {};
    let included = 0;
    for (const [key, entryValue, accessor] of entries) {
      if (included >= MAX_SCRUB_KEYS) break;
      if (UNSAFE_OBJECT_KEYS.has(key)) continue;
      included += 1;
      if (isSensitiveKey(key)) {
        output[key] = FILTERED;
      } else if (accessor) {
        output[key] = UNSERIALIZABLE;
      } else {
        output[key] = scrubValue(entryValue, depth + 1, seen);
      }
    }
    if (entries.length > MAX_SCRUB_KEYS) output.__truncated__ = TRUNCATED;
    return output;
  } catch {
    return UNSERIALIZABLE;
  }
}

// Compatibility entrypoint for flat, code-owned diagnostics. It deliberately
// uses the same allowlist as context projection instead of recursively keeping
// arbitrary fields that merely appear safe after redaction.
export function scrubObservabilityValue(value: unknown): UnknownRecord {
  return projectObservabilityContext(value);
}
