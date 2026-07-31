import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathState = vi.hoisted(() => ({ root: '' }));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawStateDir: () => pathState.root,
}));

vi.mock('@electron/utils/logger', () => ({
  logger: { warn: vi.fn() },
}));

describe('temporary chat session cleanup', () => {
  beforeEach(async () => {
    pathState.root = await mkdtemp(join(tmpdir(), 'uclaw-session-cleanup-'));
  });

  afterEach(async () => {
    await rm(pathState.root, { recursive: true, force: true });
  });

  it('removes the session entry and all local transcript sidecars', async () => {
    const sessionsDir = join(pathState.root, 'agents', 'main', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const sessionKey = 'agent:main:uclaw-profile-123';
    const transcript = join(sessionsDir, 'profile-session.jsonl');
    const keepTranscript = join(sessionsDir, 'keep.jsonl');
    await writeFile(transcript, '{}\n', 'utf8');
    await writeFile(join(sessionsDir, 'profile-session.jsonl.reset.1'), '{}\n', 'utf8');
    await writeFile(join(sessionsDir, 'profile-session.trajectory.jsonl'), '{}\n', 'utf8');
    await writeFile(keepTranscript, '{}\n', 'utf8');
    await writeFile(join(sessionsDir, 'sessions.json'), JSON.stringify({
      [sessionKey]: { sessionId: 'profile-session', sessionFile: transcript },
      'agent:main:keep': { sessionId: 'keep', sessionFile: keepTranscript },
    }), 'utf8');
    const { deleteLocalChatSession } = await import('@electron/utils/chat-session-cleanup');

    await deleteLocalChatSession(sessionKey);

    const sessions = JSON.parse(await readFile(join(sessionsDir, 'sessions.json'), 'utf8'));
    expect(sessions[sessionKey]).toBeUndefined();
    expect(sessions['agent:main:keep']).toBeDefined();
    await expect(access(transcript)).rejects.toThrow();
    await expect(access(join(sessionsDir, 'profile-session.jsonl.reset.1'))).rejects.toThrow();
    await expect(access(join(sessionsDir, 'profile-session.trajectory.jsonl'))).rejects.toThrow();
    await expect(access(keepTranscript)).resolves.toBeUndefined();
  });

  it('ignores malformed or non-Agent session keys', async () => {
    const { deleteLocalChatSession } = await import('@electron/utils/chat-session-cleanup');

    await expect(deleteLocalChatSession('not-an-agent-session')).resolves.toBeUndefined();
    await expect(deleteLocalChatSession('agent:main:bad/suffix')).resolves.toBeUndefined();
  });
});
