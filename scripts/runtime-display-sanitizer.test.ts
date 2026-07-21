import assert from 'node:assert/strict';
import test from 'node:test';

import {
  sanitizeRuntimeDisplayText,
  sanitizeRuntimeDisplayValue,
} from '../src/lib/runtime-display-sanitizer.ts';
import { deriveRuntimeTaskSteps } from '../src/pages/Chat/runtime-task-visualization.ts';
import { deriveConversationExecutionSteps } from '../src/pages/Chat/timeline/execution-details-projection.ts';
import type { ConversationEvent } from '../shared/conversation-events.ts';
import type { ConversationTurn } from '../src/stores/conversation/types.ts';

const EXECUTION_DETAILS_LABELS = {
  approval: 'Approval',
  artifact: 'Artifact',
  plan: 'Plan',
  verification: 'Verification',
  taskFlow: 'Task flow',
  toolInput: 'Input',
  toolOutput: 'Output',
};

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
  if (detail) assert.match(detail, /\[REDACTED\]/u);
});

test('redacts canonical execution details and never links credential-bearing URLs', () => {
  const secret = 'artifact-signed-secret';
  const turn = {
    id: 'turn:secret-details',
    sessionKey: 'agent:main:secret-details',
    taskById: {},
    items: [{
      id: 'tool-group:secret-details',
      turnId: 'turn:secret-details',
      kind: 'tool-group',
      status: 'completed',
      firstSeenAt: 1,
      updatedAt: 2,
      sourceEventIds: ['tool-event'],
      revision: 1,
      category: 'browser',
      summaryKey: 'timeline.tools.completed',
      summaryParams: {},
      toolCallIds: ['fetch-secret'],
      entries: [{
        toolCallId: 'fetch-secret',
        name: 'web_fetch',
        status: 'completed',
        args: { url: `https://example.test/file?token=${secret}` },
        result: { authorization: `Bearer ${secret}` },
        startedAt: 1,
        updatedAt: 2,
      }],
    }, {
      id: 'artifact-group:secret-details',
      turnId: 'turn:secret-details',
      kind: 'artifact-group',
      status: 'completed',
      firstSeenAt: 2,
      updatedAt: 2,
      sourceEventIds: ['artifact-event'],
      revision: 1,
      artifacts: [{
        id: 'artifact-secret',
        kind: 'document',
        title: 'report.txt',
        filePath: '/Users/alice/work/report.txt',
        url: `https://example.test/report?signature=${secret}`,
      }],
      changes: [],
    }, {
      id: 'verification:secret-details',
      turnId: 'turn:secret-details',
      kind: 'verification-summary',
      status: 'completed',
      firstSeenAt: 3,
      updatedAt: 3,
      sourceEventIds: ['verification-event'],
      revision: 1,
      verifications: [{
        id: 'verification-secret',
        kind: 'artifact.integrity',
        status: 'passed',
        evidence: `https://example.test/evidence?access_token=${secret}`,
      }],
    }],
  } as unknown as ConversationTurn;

  const steps = deriveConversationExecutionSteps(turn, {
    approval: 'Approval',
    artifact: 'Artifact',
    plan: 'Plan',
    verification: 'Verification',
    taskFlow: 'Task flow',
    toolInput: 'Input',
    toolOutput: 'Output',
  });
  const serialized = JSON.stringify(steps);
  const tool = steps.find((step) => step.id === 'fetch-secret');
  const artifact = steps.find((step) => step.id === 'artifact:artifact-secret');

  assert.doesNotMatch(serialized, new RegExp(secret, 'u'));
  assert.doesNotMatch(serialized, /\/Users\/alice/u);
  assert.match(artifact?.detail ?? '', /~\/work\/report\.txt/u);
  assert.match(serialized, /\[REDACTED\]/u);
  assert.equal(tool?.url, undefined);
});

test('projects authoritative aborted diagnostic plan steps as aborted', () => {
  const taskId = 'task-aborted-diagnostic';
  const toolCallId = 'tool-aborted-diagnostic';
  const turn = {
    id: 'turn:aborted-diagnostic',
    sessionKey: 'agent:main:aborted-diagnostic',
    taskById: {
      [taskId]: {
        taskId,
        title: 'Cancelled host task',
        status: 'aborted',
      },
    },
    items: [],
  } as unknown as ConversationTurn;
  const event = {
    version: 1,
    eventId: 'task-ledger:aborted-step',
    type: 'step.updated',
    source: 'task-ledger',
    authority: 'authoritative',
    sessionKey: turn.sessionKey,
    turnId: turn.id,
    taskId,
    toolCallId,
    timelineVisibility: 'diagnostics',
    occurredAt: 1,
    receivedAt: 1,
    replayed: false,
    data: {
      step: {
        id: 'host-task:cancelled',
        title: 'Cancelled host task',
        status: 'aborted',
        taskId,
        toolCallId,
      },
    },
  } satisfies ConversationEvent;

  const steps = deriveConversationExecutionSteps(turn, EXECUTION_DETAILS_LABELS, [event]);

  assert.equal(steps.find((step) => step.id === toolCallId)?.status, 'aborted');
});

test('keeps canonical live commentary while deduplicating owned history commentary', () => {
  const historyEventId = 'history:message-history:commentary';
  const liveEventId = 'openclaw-runtime:run-live:commentary';
  const mergedHistoryEventId = 'history:message-merged:commentary';
  const mergedLiveEventId = 'openclaw-runtime:run-live:merged-commentary';
  const turn = {
    id: 'turn:mixed-commentary',
    sessionKey: 'agent:main:mixed-commentary',
    taskById: {},
    items: [{
      id: 'commentary:message-history',
      turnId: 'turn:mixed-commentary',
      kind: 'commentary',
      status: 'completed',
      firstSeenAt: 1,
      updatedAt: 1,
      sourceEventIds: [historyEventId],
      revision: 1,
      text: 'Persisted history commentary',
      sealed: true,
      origin: 'progress',
    }, {
      id: 'commentary:live-process',
      turnId: 'turn:mixed-commentary',
      kind: 'commentary',
      status: 'running',
      firstSeenAt: 2,
      updatedAt: 2,
      sourceEventIds: [liveEventId],
      revision: 1,
      text: 'Fresh canonical live commentary',
      sealed: false,
      origin: 'progress',
    }, {
      id: 'commentary:message-merged',
      turnId: 'turn:mixed-commentary',
      kind: 'commentary',
      status: 'running',
      firstSeenAt: 3,
      updatedAt: 4,
      sourceEventIds: [mergedHistoryEventId, mergedLiveEventId],
      revision: 2,
      text: 'Reconciled canonical live commentary',
      sealed: false,
      origin: 'progress',
    }],
  } as unknown as ConversationTurn;
  const events = [{
    version: 1,
    eventId: historyEventId,
    type: 'commentary.append',
    source: 'history',
    authority: 'corroborating',
    sessionKey: turn.sessionKey,
    turnId: turn.id,
    messageId: 'message-history',
    occurredAt: 1,
    receivedAt: 1,
    replayed: true,
    data: { text: 'Persisted history commentary', replace: true },
  }, {
    version: 1,
    eventId: liveEventId,
    type: 'commentary.append',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    sessionKey: turn.sessionKey,
    turnId: turn.id,
    occurredAt: 2,
    receivedAt: 2,
    replayed: false,
    data: { text: 'Fresh canonical live commentary' },
  }, {
    version: 1,
    eventId: mergedHistoryEventId,
    type: 'commentary.append',
    source: 'history',
    authority: 'corroborating',
    sessionKey: turn.sessionKey,
    turnId: turn.id,
    messageId: 'message-merged',
    occurredAt: 3,
    receivedAt: 3,
    replayed: true,
    data: { text: 'Stale persisted commentary segment', replace: true },
  }, {
    version: 1,
    eventId: mergedLiveEventId,
    type: 'commentary.append',
    source: 'openclaw-runtime',
    authority: 'authoritative',
    sessionKey: turn.sessionKey,
    turnId: turn.id,
    occurredAt: 4,
    receivedAt: 4,
    replayed: false,
    data: { text: 'Reconciled canonical live commentary' },
  }] satisfies ConversationEvent[];

  const steps = deriveConversationExecutionSteps(turn, EXECUTION_DETAILS_LABELS, events);

  assert.equal(steps.filter((step) => step.label === 'Persisted history commentary').length, 1);
  assert.equal(steps.filter((step) => step.label === 'Fresh canonical live commentary').length, 1);
  assert.equal(steps.filter((step) => step.label === 'Reconciled canonical live commentary').length, 1);
  assert.equal(steps.filter((step) => step.label === 'Stale persisted commentary segment').length, 0);
});
