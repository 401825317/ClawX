import { mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { costMocks, providerMocks, testHome, testUserData } = vi.hoisted(() => {
  const suffix = Math.random().toString(36).slice(2);
  return {
    costMocks: {
      enrich: vi.fn(),
      getSnapshot: vi.fn(),
    },
    providerMocks: {
      listAccounts: vi.fn(),
    },
    testHome: `/tmp/clawx-token-usage-${suffix}`,
    testUserData: `/tmp/clawx-token-usage-user-data-${suffix}`,
  };
});

vi.mock('@electron/services/managed-token-usage-cost-service', () => ({
  enrichManagedTokenUsageCosts: costMocks.enrich,
  getManagedTokenCostSnapshot: costMocks.getSnapshot,
}));

vi.mock('@electron/services/providers/provider-store', () => ({
  listProviderAccounts: providerMocks.listAccounts,
}));

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

describe('token usage session scan', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.restoreAllMocks();
    costMocks.enrich.mockReset();
    costMocks.getSnapshot.mockReset();
    providerMocks.listAccounts.mockReset();
    providerMocks.listAccounts.mockResolvedValue([]);
    await rm(testHome, { recursive: true, force: true });
    await rm(testUserData, { recursive: true, force: true });
  });

  it('includes transcripts from agent directories that exist on disk but are not configured', async () => {
    const openclawDir = join(testHome, '.openclaw');
    await mkdir(openclawDir, { recursive: true });
    await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify({
      agents: {
        list: [
          { id: 'main', name: 'Main', default: true },
        ],
      },
    }, null, 2), 'utf8');

    const diskOnlySessionsDir = join(openclawDir, 'agents', 'custom-custom25', 'sessions');
    await mkdir(diskOnlySessionsDir, { recursive: true });
    await writeFile(
      join(diskOnlySessionsDir, 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a.jsonl'),
      [
        JSON.stringify({
          type: 'message',
          timestamp: '2026-03-12T12:19:00.000Z',
          message: {
            role: 'assistant',
            model: 'gpt-5.2-2025-12-11',
            provider: 'openai',
            usage: {
              input: 17649,
              output: 107,
              total: 17756,
            },
          },
        }),
      ].join('\n'),
      'utf8',
    );

    const { getRecentTokenUsageHistory } = await import('@electron/utils/token-usage');
    const entries = await getRecentTokenUsageHistory();

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agentId: 'custom-custom25',
          sessionId: 'f8e66f77-0125-4e2f-b750-9c4de01e8f5a',
          model: 'gpt-5.2-2025-12-11',
          totalTokens: 17756,
        }),
      ]),
    );
    expect(costMocks.getSnapshot).not.toHaveBeenCalled();
  });

  it('enriches managed placeholder costs with the settled snapshot service', async () => {
    const openclawDir = join(testHome, '.openclaw');
    const sessionsDir = join(openclawDir, 'agents', 'main', 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    await writeFile(join(openclawDir, 'openclaw.json'), JSON.stringify({
      agents: { list: [{ id: 'main', default: true }] },
    }), 'utf8');
    providerMocks.listAccounts.mockResolvedValue([{
      id: 'openai',
      vendorId: 'openai',
      metadata: {
        managedBy: 'uclaw',
        managedAllowedModels: ['smart-latest'],
      },
    }]);
    await writeFile(
      join(sessionsDir, 'managed-session.jsonl'),
      JSON.stringify({
        type: 'message',
        timestamp: '2026-09-05T06:41:28.685Z',
        message: {
          role: 'assistant',
          model: 'smart-latest',
          provider: 'openai',
          providerRequestId: 'server-request-1',
          usage: {
            input: 12_206,
            output: 391,
            cacheRead: 19_456,
            total: 32_053,
            cost: { total: 0 },
          },
        },
      }),
      'utf8',
    );

    const settledSnapshot = { quotaPerUnit: 500_000, logs: [] };
    let notifySnapshotRequested: () => void = () => undefined;
    const snapshotRequested = new Promise<void>((resolve) => {
      notifySnapshotRequested = resolve;
    });
    let resolveSnapshot: (value: typeof settledSnapshot) => void = () => undefined;
    const delayedSnapshot = new Promise<typeof settledSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    costMocks.getSnapshot.mockImplementation(() => {
      notifySnapshotRequested();
      return delayedSnapshot;
    });
    costMocks.enrich.mockImplementation((entries: Array<Record<string, unknown>>) => (
      entries.map((entry) => ({ ...entry, costUsd: 0.053618, costUnavailable: undefined }))
    ));

    const { getRecentTokenUsageHistory } = await import('@electron/utils/token-usage');
    vi.useFakeTimers();
    const historyPromise = getRecentTokenUsageHistory();
    try {
      await snapshotRequested;
      let historySettled = false;
      void historyPromise.then(() => {
        historySettled = true;
      });
      await vi.advanceTimersByTimeAsync(2_501);
      expect(historySettled).toBe(false);

      resolveSnapshot(settledSnapshot);
      const entries = await historyPromise;

      expect(costMocks.getSnapshot).toHaveBeenCalledTimes(1);
      expect(costMocks.enrich).toHaveBeenCalledWith(
        [expect.objectContaining({
          sessionId: 'managed-session',
          costUnavailable: true,
          providerRequestId: 'server-request-1',
        })],
        settledSnapshot,
      );
      expect(entries).toEqual([
        expect.objectContaining({ sessionId: 'managed-session', costUsd: 0.053618 }),
      ]);
      expect(entries[0]).not.toHaveProperty('providerRequestId');
    } finally {
      vi.useRealTimers();
    }
  });
});
