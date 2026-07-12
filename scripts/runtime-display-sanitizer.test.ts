import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeRuntimeDisplayText,
  sanitizeRuntimeDisplayValue,
} from '../src/lib/runtime-display-sanitizer.ts';
import { deriveRuntimeTaskSteps } from '../src/pages/Chat/runtime-task-visualization.ts';

test('redacts structured credentials without hiding diagnostic identifiers', () => {
  const output = sanitizeRuntimeDisplayText(JSON.stringify({
    apiKey: 'sk-proj-abcdef123456',
    password: 'p@ssword',
    AWS_SECRET_ACCESS_KEY: 'aws-secret-value',
    sessionKey: 'agent:main:session-1',
    prompt_tokens: 42,
  }));

  assert.doesNotMatch(output, /sk-proj-abcdef123456|p@ssword|aws-secret-value/u);
  assert.match(output, /agent:main:session-1/u);
  assert.match(output, /prompt_tokens/u);
  assert.match(output, /42/u);
});

test('redacts headers, env assignments, DSN credentials, signed URL params, JWT, and PEM', () => {
  const raw = [
    'Authorization: Bearer sk-proj-abcdef123456',
    'Cookie: session=abcdef123456',
    'OPENAI_API_KEY=sk-openai-abcdef',
    'postgres://user:db-password@db.example.com/app',
    'https://host/file?token=abc&X-Amz-Signature=def#access_token=ghi',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signaturepart',
    '-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----',
  ].join('\n');
  const output = sanitizeRuntimeDisplayText(raw);

  for (const secret of [
    'sk-proj-abcdef123456',
    'abcdef123456',
    'sk-openai-abcdef',
    'db-password',
    'token=abc',
    'X-Amz-Signature=def',
    'access_token=ghi',
    'eyJhbGciOiJIUzI1NiJ9',
    'secret-material',
  ]) {
    assert.doesNotMatch(output, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
  assert.match(output, /Authorization/u);
  assert.match(output, /\[REDACTED\]/u);
});

test('recursively sanitizes nested values and handles circular diagnostics', () => {
  const value: Record<string, unknown> = {
    nested: {
      accessToken: 'nested-secret',
      label: 'safe label',
    },
  };
  value.self = value;
  const sanitized = sanitizeRuntimeDisplayValue(value) as Record<string, unknown>;
  assert.equal((sanitized.nested as Record<string, unknown>).accessToken, '[REDACTED]');
  assert.equal((sanitized.nested as Record<string, unknown>).label, 'safe label');
  assert.equal(sanitized.self, '[CIRCULAR]');
});

test('sanitizes tool arguments before they become execution graph details', () => {
  const secret = 'sk-proj-execution-graph-secret';
  const steps = deriveRuntimeTaskSteps({
    runId: 'run-secret-graph',
    sessionKey: 'agent:main:secret-graph',
    status: 'running',
    assistantText: '',
    thinkingText: '',
    events: [{
      type: 'tool.started',
      runId: 'run-secret-graph',
      sessionKey: 'agent:main:secret-graph',
      ts: 1,
      toolCallId: 'secret-tool',
      name: 'exec',
      args: {
        command: `node task.js --payload {"api_key":"${secret}","cookie":"sid=private"}`,
      },
    }],
  });
  const detail = steps.find((step) => step.id === 'secret-tool')?.detail ?? '';
  assert.doesNotMatch(detail, new RegExp(secret, 'u'));
  assert.doesNotMatch(detail, /sid=private/u);
  assert.match(detail, /\[REDACTED\]/u);
});
