export type AcpChatErrorCode =
  | 'INSUFFICIENT_QUOTA'
  | 'AUTH_INVALID'
  | 'RATE_LIMIT'
  | 'PERMISSION_DENIED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVICE_UNAVAILABLE'
  | 'SESSION_LOCKED'
  | 'MODEL_UNAVAILABLE'
  | 'CONTENT_POLICY'
  | 'CONVERSATION_INVALID'
  | 'INVALID_REQUEST'
  | 'CANCELLED'
  | 'UNKNOWN';

export type AcpChatErrorDetails = {
  code: AcpChatErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  upstreamCode?: string;
};

type ErrorSignals = {
  messages: string[];
  codes: string[];
  statuses: number[];
};

const MAX_ERROR_SIGNAL_DEPTH = 4;
const MAX_ERROR_SIGNALS = 24;

function collectErrorSignals(value: unknown, signals: ErrorSignals, seen: Set<object>, depth = 0): void {
  if (depth > MAX_ERROR_SIGNAL_DEPTH) return;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text && signals.messages.length < MAX_ERROR_SIGNALS) signals.messages.push(text);
    return;
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 100 && value <= 599) signals.statuses.push(value);
    return;
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'detail', 'body', 'cause', 'data', 'details', 'response']) {
    collectErrorSignals(record[key], signals, seen, depth + 1);
  }
  for (const key of ['code', 'type', 'errorCode', 'upstreamCode']) {
    const code = record[key];
    if ((typeof code === 'string' || typeof code === 'number') && signals.codes.length < MAX_ERROR_SIGNALS) {
      signals.codes.push(String(code).trim());
    }
  }
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const status = Number(record[key]);
    if (Number.isInteger(status) && status >= 100 && status <= 599) signals.statuses.push(status);
  }
}

function inferHttpStatus(text: string, statuses: number[]): number | undefined {
  if (statuses.length > 0) return statuses[0];
  const match = /(?:^|\b)([1-5]\d{2})(?:\b|$)/u.exec(text);
  return match ? Number(match[1]) : undefined;
}

function inferUpstreamCode(text: string, codes: string[]): string | undefined {
  const structured = codes.find((code) => code && !/^\d+$/u.test(code));
  if (structured) return structured;
  const match = /(?:["']?code["']?\s*[:=]\s*["'])([a-z0-9_.-]+)["']/iu.exec(text)
    ?? /\bcode\s*[=:]\s*([a-z0-9_.-]+)/iu.exec(text);
  return match?.[1];
}

function includesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

/**
 * Converts ACP, OpenClaw and provider failures into one stable UI contract.
 * Classification order is intentional: business quota errors often arrive as
 * HTTP 403 and must not be mistaken for invalid authentication or permission.
 */
export function normalizeAcpChatError(error: unknown, fallback = 'ACP prompt failed'): AcpChatErrorDetails {
  const signals: ErrorSignals = { messages: [], codes: [], statuses: [] };
  collectErrorSignals(error, signals, new Set());
  const message = signals.messages[0] || fallback;
  const searchable = [...signals.codes, ...signals.messages].join(' ').toLowerCase();
  const httpStatus = inferHttpStatus(searchable, signals.statuses);
  const upstreamCode = inferUpstreamCode(searchable, signals.codes);

  const result = (code: AcpChatErrorCode, retryable: boolean): AcpChatErrorDetails => ({
    code,
    message,
    retryable,
    ...(httpStatus ? { httpStatus } : {}),
    ...(upstreamCode ? { upstreamCode } : {}),
  });

  if (includesAny(searchable, [
    /insufficient[_ -]?user[_ -]?quota/u,
    /insufficient[_ -]?(?:quota|balance|credits?)/u,
    /(?:user|account).{0,12}(?:quota|balance).{0,8}(?:exhausted|insufficient)/u,
    /用户额度不足/u,
    /(?:账户)?余额不足/u,
    /额度已用完/u,
    /预扣费额度失败/u,
  ])) return result('INSUFFICIENT_QUOTA', false);

  if (httpStatus === 451 || includesAny(searchable, [
    /generated images?.{0,20}unsafe/u,
    /content.{0,12}(?:policy|safety).{0,12}(?:blocked|violation|reject)/u,
    /sensitive[_ -]?words?[_ -]?detected/u,
    /prompt[_ -]?blocked/u,
    /safety system/u,
    /内容.{0,8}(?:安全|审核).{0,8}(?:拦截|拒绝)/u,
  ])) return result('CONTENT_POLICY', false);

  if (includesAny(searchable, [
    /model.{0,40}not supported/u,
    /model.{0,40}not found/u,
    /model[_ -]?not[_ -]?found/u,
    /no configured account/u,
    /模型.{0,12}(?:不支持|不存在|不可用)/u,
  ])) return result('MODEL_UNAVAILABLE', false);

  if (includesAny(searchable, [
    /reasoning_text.{0,40}must be passed back/u,
    /conversation.{0,20}(?:invalid|out of order)/u,
    /messages?.{0,20}(?:role|order)/u,
    /会话.{0,12}(?:上下文|协议).{0,8}(?:异常|无效)/u,
  ])) return result('CONVERSATION_INVALID', false);

  if (includesAny(searchable, [
    /cancelled by (?:the )?user/u,
    /user cancelled/u,
    /用户(?:主动)?取消/u,
  ])) return result('CANCELLED', false);

  if (httpStatus === 400 || httpStatus === 422 || includesAny(searchable, [
    /invalid[_ -]?request/u,
    /unsupported parameter/u,
    /unsupported (?:video )?size/u,
    /video duration must/u,
    /param[_ -]?override[_ -]?invalid/u,
    /参数.{0,12}(?:错误|无效|不支持)/u,
  ])) return result('INVALID_REQUEST', false);

  if (httpStatus === 401 || includesAny(searchable, [
    /\bunauthori[sz]ed\b/u,
    /invalid[_ -]?(?:api[_ -]?)?key/u,
    /invalid authentication/u,
    /authentication failed/u,
    /token.{0,12}(?:expired|invalid)/u,
    /登录.{0,8}(?:失效|过期)/u,
    /凭证.{0,8}(?:失效|过期|无效)/u,
  ])) return result('AUTH_INVALID', false);

  if (httpStatus === 429 || includesAny(searchable, [
    /rate[_ -]?limit/u,
    /too many requests/u,
    /请求过于频繁/u,
    /调用频率/u,
    /频率限制/u,
  ])) return result('RATE_LIMIT', true);

  if (includesAny(searchable, [
    /session file locked/u,
    /session.{0,20}\blocked\b/u,
    /file lock timeout/u,
    /会话.{0,8}(?:锁定|占用)/u,
  ])) return result('SESSION_LOCKED', true);

  if (httpStatus === 408 || includesAny(searchable, [
    /\btimeout\b/u,
    /timed out/u,
    /deadline exceeded/u,
    /超时/u,
  ])) return result('TIMEOUT', true);

  if (includesAny(searchable, [
    /econn(?:reset|refused|aborted)/u,
    /enotfound/u,
    /network error/u,
    /fetch failed/u,
    /socket hang up/u,
    /connection (?:closed|reset|refused)/u,
    /client_gone/u,
    /context canceled/u,
    /request was aborted/u,
    /operation (?:was )?aborted/u,
    /网络.{0,8}(?:异常|断开|不可用)/u,
  ])) return result('NETWORK', true);

  if ((httpStatus != null && httpStatus >= 500) || includesAny(searchable, [
    /bad gateway/u,
    /service unavailable/u,
    /upstream.{0,12}(?:error|unavailable)/u,
    /服务.{0,8}(?:异常|不可用)/u,
    /responses stream error/u,
  ])) return result('SERVICE_UNAVAILABLE', true);

  if (httpStatus === 403 || includesAny(searchable, [
    /\bforbidden\b/u,
    /permission denied/u,
    /没有权限/u,
    /无权限/u,
  ])) return result('PERMISSION_DENIED', false);

  return result('UNKNOWN', false);
}
