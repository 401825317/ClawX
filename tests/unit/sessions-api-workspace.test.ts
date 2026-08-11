// @vitest-environment node

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKSPACE_CWD } from '@shared/workspace';

const testOpenClawDir = join(tmpdir(), `clawx-session-workspace-${process.pid}`);
const testOpenClawConfigDir = join(tmpdir(), `clawx-session-config-${process.pid}`);

vi.mock('@electron/utils/paths', async () => {
  const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
  return {
    ...actual,
    getOpenClawConfigDir: () => testOpenClawDir,
    resolveOpenClawStateDir: () => testOpenClawDir,
    resolveOpenClawConfigDir: () => testOpenClawConfigDir,
  };
});

function seedAcpCwd(sessionKey: string, cwd: string) {
  const stateDir = join(testOpenClawDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, 'openclaw.sqlite'));
  try {
    db.exec('CREATE TABLE acp_sessions (session_key TEXT PRIMARY KEY, cwd TEXT)');
    db.prepare('INSERT INTO acp_sessions (session_key, cwd) VALUES (?, ?)').run(sessionKey, cwd);
  } finally {
    db.close();
  }
}

function seedAcpReplayCwd(sessionKey: string, cwd: string, updatedAt = 2000) {
  const stateDir = join(testOpenClawDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, 'openclaw.sqlite'));
  try {
    db.exec('CREATE TABLE acp_replay_sessions (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL, cwd TEXT NOT NULL, complete INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_seq INTEGER NOT NULL)');
    db.prepare('INSERT INTO acp_replay_sessions (session_id, session_key, cwd, complete, created_at, updated_at, next_seq) VALUES (?, ?, ?, 1, 1000, ?, 1)')
      .run(`${sessionKey}:ledger`, sessionKey, cwd, updatedAt);
  } finally {
    db.close();
  }
}

function seedAcpRuntimeOptionsCwd(sessionKey: string, cwd: string) {
  const stateDir = join(testOpenClawDir, 'state');
  mkdirSync(stateDir, { recursive: true });
  const db = new DatabaseSync(join(stateDir, 'openclaw.sqlite'));
  try {
    db.exec('CREATE TABLE acp_sessions (session_key TEXT PRIMARY KEY, runtime_options_json TEXT, cwd TEXT)');
    db.prepare('INSERT INTO acp_sessions (session_key, runtime_options_json, cwd) VALUES (?, ?, ?)')
      .run(sessionKey, JSON.stringify({ cwd }), '/Users/alex/fallback-cwd');
  } finally {
    db.close();
  }
}

function seedTranscript(sessionKey: string, messages: unknown[]) {
  const sessionsDir = join(testOpenClawDir, 'agents', 'main', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({ [sessionKey]: 'heartbeat.jsonl' }), 'utf8');
  writeFileSync(
    join(sessionsDir, 'heartbeat.jsonl'),
    messages.map((message) => JSON.stringify({ type: 'message', message })).join('\n'),
    'utf8',
  );
}

function seedTranscriptRecords(sessionKey: string, records: unknown[]) {
  const sessionsDir = join(testOpenClawDir, 'agents', 'main', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({ [sessionKey]: 'timings.jsonl' }), 'utf8');
  writeFileSync(
    join(sessionsDir, 'timings.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n'),
    'utf8',
  );
}

describe('sessions API workspace summaries', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    rmSync(testOpenClawDir, { recursive: true, force: true });
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('loads transcript history from the state dir when the config path is elsewhere', async () => {
    seedTranscript('agent:main:session-state', [{
      role: 'assistant',
      content: 'state transcript',
      timestamp: 10_000,
    }]);
    mkdirSync(testOpenClawConfigDir, { recursive: true });
    writeFileSync(join(testOpenClawConfigDir, 'openclaw.json'), '{}');
    const { createSessionsApi } = await import('@electron/services/sessions-api');

    await expect(createSessionsApi().history({
      sessionKey: 'agent:main:session-state',
      limit: 5,
    })).resolves.toMatchObject({
      success: true,
      messages: [{ content: 'state transcript' }],
    });
  });

  it('preserves outer transcript ids for attachment authorization', async () => {
    seedTranscriptRecords('agent:main:session-message-ids', [{
      type: 'message',
      id: 'gateway-image-message',
      timestamp: '2026-08-08T01:00:00.000Z',
      message: {
        role: 'assistant',
        content: [{
          type: 'image',
          url: '/api/chat/media/outgoing/agent%3Amain%3Asession-message-ids/image-1/full',
          mimeType: 'image/png',
        }],
      },
    }]);
    const { createSessionsApi } = await import('@electron/services/sessions-api');

    await expect(createSessionsApi().history({
      sessionKey: 'agent:main:session-message-ids',
      limit: 5,
    })).resolves.toMatchObject({
      success: true,
      messages: [{
        id: 'gateway-image-message',
      }],
    });
  });

  it('extracts bounded whole-turn timings without treating inter-session messages as new turns', async () => {
    seedTranscriptRecords('agent:main:session-timings', [
      {
        type: 'message',
        timestamp: '2026-07-22T10:00:00.000Z',
        message: { role: 'user', content: '[Working directory: /tmp/project]\nRepeat this' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:00:01.000Z',
        message: { role: 'assistant', content: [{ type: 'toolCall', id: 'tool-1' }] },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:00:03.000Z',
        message: { role: 'toolResult', content: 'tool result', toolCallId: 'tool-1' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:00:05.000Z',
        message: { role: 'assistant', content: 'First answer' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:01:00.000Z',
        message: { role: 'user', content: 'Repeat this' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:01:01.000Z',
        message: {
          role: 'user',
          content: '[Inter-session message] async continuation',
          provenance: { kind: 'inter_session' },
        },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:01:02.000Z',
        message: { role: 'tool_result', content: 'continued tool result', toolCallId: 'tool-2' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:01:04.000Z',
        message: { role: 'assistant', content: 'Second answer' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:02:00.000Z',
        message: { role: 'user', content: 'Incomplete turn' },
      },
    ]);
    const { createSessionsApi } = await import('@electron/services/sessions-api');

    const result = await createSessionsApi().turnTimings({
      sessionKey: 'agent:main:session-timings',
      limit: 1000,
    });

    expect(result).toEqual({
      success: true,
      timings: [
        {
          normalizedUserText: 'Repeat this',
          userOccurrenceFromTail: 2,
          durationMs: 5_000,
        },
        {
          normalizedUserText: 'Repeat this',
          userOccurrenceFromTail: 1,
          durationMs: 4_000,
        },
      ],
    });
  });

  it('falls back to message timestamps and omits negative or orphan turn timings', async () => {
    seedTranscriptRecords('agent:main:session-timing-fallback', [
      {
        type: 'message',
        message: { role: 'assistant', content: 'orphan', timestamp: 2_000_000_000_000 },
      },
      {
        type: 'message',
        message: { role: 'user', content: 'Fallback', timestamp: 2_000_000_001_000 },
      },
      {
        type: 'message',
        message: { role: 'assistant', content: 'answer', timestamp: 2_000_000_003_500 },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:03:10.000Z',
        message: { role: 'user', content: 'Clock skew' },
      },
      {
        type: 'message',
        timestamp: '2026-07-22T10:03:09.000Z',
        message: { role: 'assistant', content: 'older answer' },
      },
    ]);
    const { createSessionsApi } = await import('@electron/services/sessions-api');

    const result = await createSessionsApi().turnTimings({
      sessionKey: 'agent:main:session-timing-fallback',
      limit: 1000,
    });

    expect(result).toEqual({
      success: true,
      timings: [{
        normalizedUserText: 'Fallback',
        userOccurrenceFromTail: 1,
        durationMs: 2_500,
      }],
    });
  });

  it('returns OpenClaw ACP cwd as workspacePath when available', async () => {
    seedAcpCwd('agent:main:session-a', '/Users/alex/workspace/ClawX');
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-a'] });

    expect(result.success).toBe(true);
    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-a',
      workspacePath: '/Users/alex/workspace/ClawX',
    });
  });

  it('returns ACP bridge replay cwd as workspacePath when available', async () => {
    seedAcpReplayCwd('agent:main:session-a', '/Users/alex/workspace/ReplayProject');
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-a'] });

    expect(result.success).toBe(true);
    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-a',
      workspacePath: '/Users/alex/workspace/ReplayProject',
    });
  });

  it('returns the logical default workspace for its isolated physical cwd', async () => {
    seedAcpReplayCwd('agent:main:session-default', join(testOpenClawDir, 'workspace'));
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-default'] });

    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-default',
      workspacePath: DEFAULT_WORKSPACE_CWD,
    });
  });

  it('preserves the relative path below the isolated default workspace', async () => {
    seedAcpReplayCwd(
      'agent:main:session-default-child',
      join(testOpenClawDir, 'workspace', 'projects', 'demo'),
    );
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-default-child'] });

    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-default-child',
      workspacePath: `${DEFAULT_WORKSPACE_CWD}/projects/demo`,
    });
  });

  it('recovers a portable default workspace persisted by another Windows computer', async () => {
    vi.stubEnv('CLAWX_PORTABLE', '1');
    vi.stubEnv('CLAWX_PORTABLE_ID', 'portable-1234');
    seedAcpReplayCwd(
      'agent:main:session-portable-default',
      'C:\\Users\\old-user\\AppData\\Local\\UClawRuntime\\profiles\\portable-1234\\openclaw-state\\workspace',
    );
    const { createSessionsApi } = await import('@electron/services/sessions-api');

    const result = await createSessionsApi().summaries({
      sessionKeys: ['agent:main:session-portable-default'],
    });

    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-portable-default',
      workspacePath: DEFAULT_WORKSPACE_CWD,
    });
  });

  it('prefers ACP runtime_options_json cwd over legacy acp_sessions cwd', async () => {
    seedAcpRuntimeOptionsCwd('agent:main:session-a', '/Users/alex/workspace/RuntimeProject');
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-a'] });

    expect(result.success).toBe(true);
    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-a',
      workspacePath: '/Users/alex/workspace/RuntimeProject',
    });
  });

  it('returns null workspacePath when OpenClaw cwd is unavailable', async () => {
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-missing'] });

    expect(result.success).toBe(true);
    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-missing',
      workspacePath: null,
    });
  });

  it('marks heartbeat-only transcripts without using them as titles', async () => {
    seedTranscript('agent:main:session-heartbeat', [
      {
        role: 'user',
        content: '[OpenClaw heartbeat poll]',
        timestamp: 9_000,
      },
    ]);
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-heartbeat'] });

    expect(result.success).toBe(true);
    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-heartbeat',
      firstUserText: null,
      lastTimestamp: 9_000_000,
      heartbeatOnly: true,
    });
  });

  it('does not mark other internal-only transcript prompts as heartbeat sessions', async () => {
    seedTranscript('agent:main:session-time-poll', [
      {
        role: 'user',
        content: 'Current time: local / 2026-05-06 12:00 UTC',
        timestamp: 9_001,
      },
    ]);
    const { createSessionsApi } = await import('@electron/services/sessions-api');
    const api = createSessionsApi();

    const result = await api.summaries({ sessionKeys: ['agent:main:session-time-poll'] });

    expect(result.success).toBe(true);
    expect(result.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-time-poll',
      firstUserText: null,
      lastTimestamp: 9_001_000,
    });
    expect(result.summaries?.[0]?.heartbeatOnly).toBeUndefined();
  });
});
