// @vitest-environment node

import { describe, expect, it, vi } from 'vitest';
import {
  projectObservabilityBreadcrumb,
  projectObservabilityContext,
  projectObservabilityEvent,
  scrubObservabilityValue,
} from '@shared/observability-scrub';

const SECRET_MARKERS = [
  'secret-token',
  'cookie-value',
  'private user request',
  'PRIVATE_FILE_BODY',
  'alice:password',
  'query-secret',
  'R:\\private\\source.ts',
  'D:/customer/private.docx',
  '\\\\server\\private\\source.ts',
  '\\\\?\\C:\\private\\extended.txt',
];

function expectNoSecretMarkers(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const marker of SECRET_MARKERS) expect(serialized).not.toContain(marker);
}

describe('observability scrubbing', () => {
  it('keeps only allowlisted top-level diagnostic keys in the compatibility API', () => {
    const scrubbed = scrubObservabilityValue({
      phase: 'gateway_start',
      attempt: 2,
      retryable: true,
      authorization: 'Bearer secret-token',
      nested: {
        Cookie: 'session=cookie-value',
        promptText: 'private user request',
        request_body: '{"password":"secret-token"}',
        fileContent: 'PRIVATE_FILE_BODY',
        message: 'R:\\private\\source.ts and D:/customer/private.docx and \\\\server\\private\\source.ts',
        extendedPath: '\\\\?\\C:\\private\\extended.txt',
        url: 'https://alice:password@example.test/v1?access%5Ftoken=query-secret&mode=test#private',
      },
    });

    expect(scrubbed).toEqual({ phase: 'gateway_start', attempt: 2, retryable: true });
    expectNoSecretMarkers(scrubbed);
  });

  it('drops nested, circular, and arbitrary fields instead of recursively retaining them', () => {
    const value: Record<string, unknown> = {
      phase: 'startup',
      safe: 'value',
      encoded: JSON.stringify({ token: 'secret-token', message: '/home/alice/private.txt' }),
      oversized: 'x'.repeat(5_000),
    };
    value.self = value;

    expect(scrubObservabilityValue(value)).toEqual({ phase: 'startup' });
  });

  it('projects diagnostic context with a strict key and value allowlist', () => {
    expect(projectObservabilityContext({
      phase: 'gateway_start',
      model: 'openai/smart-latest',
      attempt: 2,
      retryable: true,
      trace_id: 'c'.repeat(32),
      span_id: 'd'.repeat(16),
      eventId: '2f67f433-dcee-48c1-8bd7-85444c85ae55',
      authorization: 'Bearer secret-token',
      promptText: 'private user request',
      fileContent: 'PRIVATE_FILE_BODY',
      name: 'https://alice:password@example.test',
      errorCode: 'sk-secret-token',
      path: 'R:\\private\\source.ts',
      nested: { cookie: 'cookie-value' },
    })).toEqual({
      attempt: 2,
      eventId: '2f67f433-dcee-48c1-8bd7-85444c85ae55',
      model: 'openai/smart-latest',
      phase: 'gateway_start',
      retryable: true,
      span_id: 'd'.repeat(16),
      trace_id: 'c'.repeat(32),
    });
  });

  it('rejects PII and secret-shaped identifiers and unknown fatal codes', () => {
    expect(projectObservabilityContext({
      phase: 'ready',
      name: 'alice@example.test',
      runId: 'customer_secret',
      model: 'openai/tokenizer-v2',
      subsystem: 'gateway',
    })).toEqual({ model: 'openai/tokenizer-v2', phase: 'ready', subsystem: 'gateway' });

    expect(projectObservabilityEvent({
      tags: {
        subsystem: 'gateway',
        fatal_reason: 'fatal_error',
        fatal_error_name: 'TypeError',
        fatal_error_code: 'SECRET_TOKEN_VALUE',
      },
    })).toEqual({
      tags: {
        subsystem: 'gateway',
        fatal_reason: 'fatal_error',
        fatal_error_name: 'TypeError',
      },
    });

    expect(projectObservabilityEvent({
      tags: { fatal_error_code: 'EPIPE' },
    })).toEqual({ tags: { fatal_error_code: 'EPIPE' } });
  });

  it('projects breadcrumbs without message, data, URL, prompt, or file content', () => {
    const projected = projectObservabilityBreadcrumb({
      timestamp: 1_777_777_777.25,
      type: 'http',
      category: 'gateway.start',
      level: 'error',
      message: 'private user request',
      data: { authorization: 'Bearer secret-token' },
      url: 'https://alice:password@example.test/?token=query-secret',
      fileContent: 'PRIVATE_FILE_BODY',
    });

    expect(projected).toEqual({
      timestamp: 1_777_777_777.25,
      type: 'http',
      category: 'gateway.start',
      level: 'error',
    });
    expectNoSecretMarkers(projected);
    expect(projectObservabilityBreadcrumb({ category: 'https://alice:password@example.test' })).toBeNull();
  });

  it('projects Sentry events onto a default-deny schema and strips private frame prefixes', () => {
    const projected = projectObservabilityEvent({
      event_id: 'a'.repeat(32),
      timestamp: 1_777_777_777.25,
      level: 'error',
      platform: 'javascript',
      environment: 'production',
      release: 'uclaw@2.0.3+build-17',
      message: 'private user request at R:\\private\\source.ts',
      request: {
        headers: { authorization: 'Bearer secret-token', cookie: 'cookie-value' },
        data: 'PRIVATE_FILE_BODY',
      },
      user: { email: 'private@example.test', ip_address: '192.0.2.1' },
      extra: { prompt: 'private user request', fileContent: 'PRIVATE_FILE_BODY' },
      exception: {
        values: [{
          type: 'TypeError',
          value: 'private user request',
          mechanism: {
            type: 'generic',
            handled: false,
            data: { token: 'secret-token' },
          },
          stacktrace: {
            frames: [
              {
                abs_path: 'R:\\private\\customer\\src\\main.ts',
                filename: 'R:\\private\\customer\\src\\main.ts',
                lineno: 42,
                colno: 7,
                in_app: true,
                vars: { cookie: 'cookie-value' },
                context_line: 'const prompt = "private user request";',
              },
              {
                filename: '\\\\server\\private\\electron\\main\\index.ts',
                lineno: 8,
              },
            ],
          },
        }],
      },
      contexts: {
        gateway: {
          phase: 'ready',
          statusCode: 503,
          prompt: 'private user request',
          name: 'https://alice:password@example.test',
        },
        custom: { token: 'secret-token' },
      },
      tags: {
        subsystem: 'gateway',
        handled: 'false',
        freeform: 'private user request',
        fatal_reason: 'https://alice:password@example.test',
        fatal_error_code: 'sk-secret-token',
      },
      breadcrumbs: [{
        type: 'error',
        category: 'gateway',
        level: 'warning',
        message: 'private user request',
        data: { token: 'secret-token' },
      }],
      fingerprint: ['b'.repeat(64), 'private user request'],
      sdkProcessingMetadata: { request: 'PRIVATE_FILE_BODY' },
    });

    expect(projected).toEqual({
      event_id: 'a'.repeat(32),
      timestamp: 1_777_777_777.25,
      level: 'error',
      platform: 'javascript',
      environment: 'production',
      release: 'uclaw@2.0.3+build-17',
      exception: {
        values: [{
          type: 'TypeError',
          stacktrace: {
            frames: [
              { filename: 'src/main.ts', lineno: 42, colno: 7, in_app: true },
              { filename: 'electron/main/index.ts', lineno: 8 },
            ],
          },
          mechanism: { type: 'generic', handled: false },
        }],
      },
      contexts: { gateway: { phase: 'ready', statusCode: 503 } },
      tags: { handled: 'false', subsystem: 'gateway' },
      breadcrumbs: [{ type: 'error', category: 'gateway', level: 'warning' }],
      fingerprint: ['b'.repeat(64)],
    });
    expectNoSecretMarkers(projected);
    for (const key of ['message', 'request', 'user', 'extra', 'sdkProcessingMetadata']) {
      expect(projected).not.toHaveProperty(key);
    }
  });

  it('never invokes accessors and fails closed for accessor-backed Sentry fields', () => {
    const getter = vi.fn(() => {
      throw new Error('must not execute');
    });
    const event = Object.defineProperties({}, {
      event_id: { enumerable: true, value: 'e'.repeat(32) },
      message: { enumerable: true, get: getter },
      contexts: { enumerable: true, get: getter },
      request: { enumerable: true, get: getter },
    });

    expect(projectObservabilityEvent(event)).toEqual({ event_id: 'e'.repeat(32) });
    expect(scrubObservabilityValue(event)).toEqual({});
    expect(getter).not.toHaveBeenCalled();
  });
});
