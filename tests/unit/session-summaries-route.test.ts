import type { IncomingMessage, ServerResponse } from 'http';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostApiContext } from '@electron/api/context';

const {
  parseJsonBodyMock,
  testOpenClawConfigDir,
} = vi.hoisted(() => {
  return {
    parseJsonBodyMock: vi.fn(),
    testOpenClawConfigDir: `${process.env.TEMP || process.env.TMPDIR || '/tmp'}/clawx-session-summaries-${Math.random().toString(36).slice(2)}`,
  };
});

vi.mock('@electron/utils/paths', () => ({
  getOpenClawConfigDir: () => testOpenClawConfigDir,
}));

vi.mock('@electron/api/route-utils', async () => {
  const actual = await vi.importActual<typeof import('@electron/api/route-utils')>('@electron/api/route-utils');
  return {
    ...actual,
    parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  };
});

function createResponse() {
  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      headers.set(name, value);
    },
    end: (value: string) => {
      body = value;
    },
  } as unknown as ServerResponse;

  return {
    res,
    get json() {
      return JSON.parse(body) as {
        success: boolean;
        summaries?: Array<Record<string, unknown>>;
        messages?: Array<Record<string, unknown>>;
      };
    },
    get statusCode() {
      return (res as ServerResponse).statusCode;
    },
  };
}

describe('POST /api/sessions/summaries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rmSync(testOpenClawConfigDir, { recursive: true, force: true });
  });

  it('strips sender metadata and ignores internal untrusted injections when building titles', async () => {
    parseJsonBodyMock.mockResolvedValue({
      sessionKeys: ['agent:main:session-a'],
    });

    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-a', file: 'session-a.jsonl' },
      ],
    }), 'utf8');
    writeFileSync(
      join(sessionsDir, 'session-a.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            timestamp: 1700000000,
            content: 'System (untrusted): internal noise',
          },
        }),
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            timestamp: 1700000002,
            content: 'Sender (untrusted): Alice\n\nHello from Alice',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const response = createResponse();
    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');
    const handled = await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/sessions/summaries'),
      {} as HostApiContext,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      success: true,
      summaries: [
        {
          sessionKey: 'agent:main:session-a',
          firstUserText: 'Hello from Alice',
          lastTimestamp: 1700000002000,
        },
      ],
    });
  });

  it('drops sender json metadata blocks instead of using them as the label', async () => {
    parseJsonBodyMock.mockResolvedValue({
      sessionKeys: ['agent:main:session-json'],
    });

    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: [
        { key: 'agent:main:session-json', file: 'session-json.jsonl' },
      ],
    }), 'utf8');
    writeFileSync(
      join(sessionsDir, 'session-json.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            timestamp: 1700000010,
            content: 'Sender (untrusted): ```json\n{"name":"Alice","id":"u1"}\n```\n\nActual user title',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const response = createResponse();
    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');
    await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/sessions/summaries'),
      {} as HostApiContext,
    );

    expect(response.json).toMatchObject({
      success: true,
      summaries: [
        {
          sessionKey: 'agent:main:session-json',
          firstUserText: 'Actual user title',
          lastTimestamp: 1700000010000,
        },
      ],
    });
  });

  it('bounds summary requests and reads transcripts through head/tail chunks', async () => {
    const requestedSessionKeys = Array.from({ length: 120 }, (_, index) => `agent:main:session-${index}`);
    parseJsonBodyMock.mockResolvedValue({
      sessionKeys: requestedSessionKeys,
    });

    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      sessions: requestedSessionKeys.map((key, index) => ({ key, file: `session-${index}.jsonl` })),
    }), 'utf8');

    for (let index = 0; index < 120; index += 1) {
      const rows = [
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            timestamp: 1700000000 + index,
            content: `first title ${index}`,
          },
        }),
      ];
      for (let line = 0; line < 600; line += 1) {
        rows.push(JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            timestamp: 1700001000 + line,
            content: 'x'.repeat(80),
          },
        }));
      }
      writeFileSync(join(sessionsDir, `session-${index}.jsonl`), rows.join('\n'), 'utf8');
    }

    const response = createResponse();
    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');
    await handleSessionRoutes(
      { method: 'POST' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/sessions/summaries'),
      {} as HostApiContext,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json.summaries).toHaveLength(80);
    expect(response.json.summaries?.[0]).toMatchObject({
      sessionKey: 'agent:main:session-0',
      firstUserText: 'first title 0',
    });
  });

  it('merges usage family reset transcripts when loading a session transcript', async () => {
    const sessionsDir = join(testOpenClawConfigDir, 'agents', 'main', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(join(sessionsDir, 'sessions.json'), JSON.stringify({
      'agent:main:main': {
        sessionFile: join(sessionsDir, 'current-session.jsonl'),
        sessionId: 'current-session',
        usageFamilySessionIds: ['old-session', 'current-session'],
      },
    }), 'utf8');
    writeFileSync(
      join(sessionsDir, 'old-session.jsonl.reset.2026-07-07T12-34-21.046Z'),
      [
        JSON.stringify({
          type: 'message',
          message: {
            role: 'assistant',
            timestamp: 1783427166423,
            content: '图片已生成。\n\nMEDIA:/tmp/generated-beauty.png',
            idempotencyKey: 'old-image-message',
          },
        }),
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(sessionsDir, 'current-session.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          message: {
            role: 'user',
            timestamp: 1783427641000,
            content: '你觉得美嘛？',
            idempotencyKey: 'current-question',
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const response = createResponse();
    const { handleSessionRoutes } = await import('@electron/api/routes/sessions');
    await handleSessionRoutes(
      { method: 'GET' } as IncomingMessage,
      response.res,
      new URL('http://127.0.0.1/api/sessions/transcript?sessionKey=agent%3Amain%3Amain&limit=10&includeFamily=true'),
      {} as HostApiContext,
    );

    expect(response.statusCode).toBe(200);
    expect(response.json.messages?.map((message) => message.content)).toEqual([
      '图片已生成。\n\nMEDIA:/tmp/generated-beauty.png',
      '你觉得美嘛？',
    ]);
  });
});
