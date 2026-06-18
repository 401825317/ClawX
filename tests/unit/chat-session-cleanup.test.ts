import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { testHome, testUserData } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    testHome: `/tmp/uclaw-chat-session-cleanup-${suffix}`,
    testUserData: `/tmp/uclaw-chat-session-cleanup-user-data-${suffix}`,
  };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  const mocked = {
    ...actual,
    homedir: () => testHome,
  };
  return {
    ...mocked,
    default: mocked,
  };
});

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => testUserData,
    getVersion: () => '0.0.0-test',
  },
}));

describe('temporary chat session cleanup', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('sweeps safe temp session files even when sessions.json has no entry', async () => {
    const sessionsDir = join(testHome, '.openclaw', 'agents', 'main', 'sessions');
    const tempId = 'uclaw-profile-temp-123';
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(sessionsDir, 'sessions.json'), JSON.stringify({}, null, 2), 'utf8');
    await writeFile(join(sessionsDir, `${tempId}.jsonl`), '{}\n', 'utf8');
    await writeFile(join(sessionsDir, `${tempId}.trajectory.jsonl`), '{}\n', 'utf8');

    const { deleteLocalChatSession } = await import('@electron/utils/chat-session-cleanup');

    await deleteLocalChatSession(`agent:main:${tempId}`);

    expect(existsSync(join(sessionsDir, `${tempId}.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsDir, `${tempId}.trajectory.jsonl`))).toBe(false);
    expect(JSON.parse(await readFile(join(sessionsDir, 'sessions.json'), 'utf8'))).toEqual({});
  });
});
