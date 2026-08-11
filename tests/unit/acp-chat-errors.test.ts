import { describe, expect, it } from 'vitest';
import { normalizeAcpChatError } from '@shared/acp-chat/errors';

describe('ACP chat error classification', () => {
  it.each([
    ['status_code=503, bad response status code 503', 'SERVICE_UNAVAILABLE', true, 503],
    [
      'status_code=404, Model "gpt-5.6-luna" is not supported by any configured account in this group',
      'MODEL_UNAVAILABLE',
      false,
      404,
    ],
    [
      'status_code=403, {"error":{"code":"insufficient_user_quota","message":"预扣费额度失败"}}',
      'INSUFFICIENT_QUOTA',
      false,
      403,
    ],
    [
      'status_code=451, The generated images appear to be unsafe. Try modifying the prompts or the seeds.',
      'CONTENT_POLICY',
      false,
      451,
    ],
    [
      'status_code=502, The origin web server returned an invalid or incomplete response to Cloudflare',
      'SERVICE_UNAVAILABLE',
      true,
      502,
    ],
    [
      'status_code=400, The reasoning_text in the thinking mode must be passed back to the API',
      'CONVERSATION_INVALID',
      false,
      400,
    ],
    ['status_code=500, responses stream error: response.failed', 'SERVICE_UNAVAILABLE', true, 500],
    ['status_code=500, request context done: context canceled', 'NETWORK', true, 500],
  ] as const)('classifies production zz-cn signature: %s', (message, code, retryable, httpStatus) => {
    expect(normalizeAcpChatError(message)).toMatchObject({ code, retryable, httpStatus });
  });

  it.each([
    ['401 Unauthorized: token expired', 'AUTH_INVALID', false],
    ['403 Forbidden: permission denied', 'PERMISSION_DENIED', false],
    ['429 Too Many Requests', 'RATE_LIMIT', true],
    ['session file locked by another process', 'SESSION_LOCKED', true],
    ['request timed out', 'TIMEOUT', true],
    ['ECONNRESET socket hang up', 'NETWORK', true],
    ['client_gone', 'NETWORK', true],
    ['server_is_overloaded service_unavailable_error', 'SERVICE_UNAVAILABLE', true],
    ['The AI service is temporarily overloaded. Please try again in a moment.', 'SERVICE_UNAVAILABLE', true],
    ['session file changed while embedded prompt lock was released', 'SESSION_LOCKED', true],
    ['status_code=400, Unsupported parameter: max_output_tokens', 'INVALID_REQUEST', false],
    ['status_code=400, Video duration must be 6 or 10 seconds.', 'INVALID_REQUEST', false],
    ['status_code=400, model_not_found', 'MODEL_UNAVAILABLE', false],
    ['sensitive_words_detected', 'CONTENT_POLICY', false],
  ] as const)('keeps recovery semantics for %s', (message, code, retryable) => {
    expect(normalizeAcpChatError(message)).toMatchObject({ code, retryable });
  });

  it('reads structured status and upstream code through an Error cause', () => {
    const error = new Error('用户额度不足', {
      cause: { status: 403, code: 'insufficient_user_quota' },
    });

    expect(normalizeAcpChatError(error)).toEqual({
      code: 'INSUFFICIENT_QUOTA',
      message: '用户额度不足',
      retryable: false,
      httpStatus: 403,
      upstreamCode: 'insufficient_user_quota',
    });
  });

  it('recurses through ACP RequestError data/details/response envelopes', () => {
    expect(normalizeAcpChatError({
      message: 'Internal error',
      data: {
        details: {
          response: {
            statusCode: 403,
            code: 'insufficient_user_quota',
            message: '用户额度不足',
          },
        },
      },
    })).toMatchObject({
      code: 'INSUFFICIENT_QUOTA',
      retryable: false,
      httpStatus: 403,
      upstreamCode: 'insufficient_user_quota',
    });
  });
});
