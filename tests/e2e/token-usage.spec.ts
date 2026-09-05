import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  closeElectronApp,
  completeSetup,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const TEST_AGENT_ID = 'agent';
const ZERO_TOKEN_SESSION_ID = 'agent-session-zero-token';
const NONZERO_TOKEN_SESSION_ID = 'agent-session-nonzero-token';
const MANAGED_ZERO_COST_SESSION_ID = 'agent-session-managed-zero-cost';
const GATEWAY_INJECTED_SESSION_ID = 'agent-session-gateway-injected';
const DELIVERY_MIRROR_SESSION_ID = 'agent-session-delivery-mirror';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

async function seedTokenUsageTranscripts(homeDir: string): Promise<void> {
  const sessionDir = join(homeDir, '.openclaw', 'agents', TEST_AGENT_ID, 'sessions');
  const now = new Date();
  const zeroTimestamp = new Date(now.getTime() - 20_000).toISOString();
  const nonzeroTimestamp = now.toISOString();
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, `${ZERO_TOKEN_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: zeroTimestamp,
        message: {
          role: 'assistant',
          model: 'kimi-k2.6',
          provider: 'kimi',
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${NONZERO_TOKEN_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: nonzeroTimestamp,
        message: {
          role: 'assistant',
          model: 'kimi-k2.6',
          provider: 'kimi',
          usage: {
            total_tokens: 27,
            input_tokens: 20,
            output_tokens: 7,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${MANAGED_ZERO_COST_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() + 1_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'smart-latest',
          provider: 'openai',
          usage: {
            input: 300,
            output: 219,
            cacheRead: 31_232,
            total: 31_751,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${GATEWAY_INJECTED_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() - 10_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'gateway-injected',
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(sessionDir, `${DELIVERY_MIRROR_SESSION_ID}.jsonl`),
    [
      JSON.stringify({
        type: 'message',
        timestamp: new Date(now.getTime() - 5_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'delivery-mirror',
          usage: {
            total_tokens: 0,
            input_tokens: 0,
            output_tokens: 0,
          },
        },
      }),
      '',
    ].join('\n'),
    'utf8',
  );
}

async function seedManagedProviderStore(userDataDir: string): Promise<void> {
  const now = new Date().toISOString();
  await mkdir(userDataDir, { recursive: true });
  await writeFile(
    join(userDataDir, 'clawx-providers.json'),
    JSON.stringify({
      schemaVersion: 0,
      providers: {},
      providerAccounts: {
        openai: {
          id: 'openai',
          vendorId: 'openai',
          label: 'OpenAI',
          authMode: 'api_key',
          enabled: true,
          isDefault: true,
          metadata: {
            managedBy: 'uclaw',
            managedAllowedModels: ['smart-latest', 'deepseek-v4-flash'],
          },
          createdAt: now,
          updatedAt: now,
        },
      },
      apiKeys: {},
      providerSecrets: {},
      defaultProvider: 'openai',
      defaultProviderAccountId: 'openai',
    }, null, 2),
    'utf8',
  );
}

test.describe('ClawX token usage history', () => {

  async function validateUsageHistory(page: Page): Promise<void> {
    const usageHistory = await page.evaluate(async () => {
      return window.electron.ipcRenderer.invoke('usage:recentTokenHistory', 20);
    });
    if (!Array.isArray(usageHistory) || usageHistory.length === 0) {
      throw new Error('No usage history found in IPC usage:recentTokenHistory');
    }

    const hasSeededEntries = usageHistory.some((entry) =>
      typeof entry?.sessionId === 'string' && (
        entry.sessionId === ZERO_TOKEN_SESSION_ID
        || entry.sessionId === NONZERO_TOKEN_SESSION_ID
        || entry.sessionId === MANAGED_ZERO_COST_SESSION_ID
      ),
    );
    if (!hasSeededEntries) {
      throw new Error('Seeded transcript session IDs were not found in IPC usage history');
    }
  }

  test('displays token usage and labels managed placeholder cost as unavailable', async ({
    homeDir,
    launchElectronApp,
    userDataDir,
  }) => {
    await seedTokenUsageTranscripts(homeDir);
    await seedManagedProviderStore(userDataDir);
    const electronApp = await launchElectronApp({ managedProvider: false, skipSetup: true });

    try {
      const page = await getStableWindow(electronApp);
      await installIpcMocks(electronApp, {
        gatewayStatus: {
          state: 'running',
          gatewayReady: true,
          port: 18789,
          pid: 12345,
          connectedAt: Date.now(),
        },
      });
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await validateUsageHistory(page);

      const usageHistory = await page.evaluate(async () => {
        return window.electron.ipcRenderer.invoke('usage:recentTokenHistory', 20);
      });

      const zeroEntry = usageHistory.find((entry) => entry?.sessionId === ZERO_TOKEN_SESSION_ID);
      const nonzeroEntry = usageHistory.find((entry) => entry?.sessionId === NONZERO_TOKEN_SESSION_ID);
      const managedZeroCostEntry = usageHistory.find((entry) => entry?.sessionId === MANAGED_ZERO_COST_SESSION_ID);
      expect(zeroEntry).toBeTruthy();
      expect(nonzeroEntry).toBeTruthy();
      expect(managedZeroCostEntry).toBeTruthy();
      expect(nonzeroEntry?.totalTokens).toBe(27);
      expect(zeroEntry?.totalTokens).toBe(0);
      expect(zeroEntry?.agentId).toBe(TEST_AGENT_ID);
      expect(nonzeroEntry?.agentId).toBe(TEST_AGENT_ID);
      expect(zeroEntry?.provider).toBe('kimi');
      expect(nonzeroEntry?.provider).toBe('kimi');
      expect(managedZeroCostEntry?.costUsd).toBeUndefined();
      expect(managedZeroCostEntry?.costUnavailable).toBe(true);

      await page.getByTestId('sidebar-nav-models').click();
      await expect(page.getByTestId('models-page')).toBeVisible();

      const managedZeroCostRow = page.locator('[data-testid="token-usage-entry"]', {
        hasText: MANAGED_ZERO_COST_SESSION_ID,
      });
      await expect(managedZeroCostRow).toBeVisible();
      await expect(managedZeroCostRow.getByTestId('token-usage-cost-unavailable')).toHaveText('Cost unavailable');
      await expect(managedZeroCostRow.getByTestId('token-usage-cost')).toHaveCount(0);
    } finally {
      await closeElectronApp(electronApp);
    }
  });

  test('displays a settled managed charge returned through the Host API', async ({
    launchElectronApp,
  }) => {
    const electronApp = await launchElectronApp({ managedProvider: false, skipSetup: true });
    const timestamp = new Date().toISOString();

    try {
      const page = await getStableWindow(electronApp);
      await installIpcMocks(electronApp, {
        gatewayStatus: {
          state: 'running',
          gatewayReady: true,
          port: 18789,
          pid: 12345,
          connectedAt: Date.now(),
        },
        hostApi: {
          [stableStringify(['usage', 'recentTokenHistory', { limit: undefined }])]: [{
            timestamp,
            sessionId: 'settled-managed-session',
            agentId: 'main',
            model: 'smart-latest',
            provider: 'openai',
            usageStatus: 'available',
            inputTokens: 12_206,
            outputTokens: 391,
            cacheReadTokens: 19_456,
            cacheWriteTokens: 0,
            totalTokens: 32_053,
            costUsd: 0.053618,
          }],
        },
      });

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.getByTestId('sidebar-nav-models').click();
      await expect(page.getByTestId('models-page')).toBeVisible();

      const settledRow = page.locator('[data-testid="token-usage-entry"]', {
        hasText: 'settled-managed-session',
      });
      await expect(settledRow).toBeVisible();
      await expect(settledRow.getByTestId('token-usage-cost')).toHaveText('Cost $0.0536');
      await expect(settledRow.getByTestId('token-usage-cost-unavailable')).toHaveCount(0);
    } finally {
      await closeElectronApp(electronApp);
    }
  });

  // TODO: This test needs a reliable way to inject mocked gateway status into
  // the renderer's Zustand store in CI (where no real OpenClaw runtime exists).
  // The IPC mock + page.reload approach fails because the reload
  // re-triggers setup flow. Skipping until we add an E2E-aware store hook.
  test.skip('hides gateway internal usage rows from the usage list overview', async ({ page, homeDir }) => {
    await seedTokenUsageTranscripts(homeDir);
    await completeSetup(page);
    await validateUsageHistory(page);

    await page.getByTestId('sidebar-nav-models').click();
    await expect(page.getByTestId('models-page')).toBeVisible();

    const usageEntryRows = page.getByTestId('token-usage-entry');
    await expect.poll(async () => await usageEntryRows.count()).toBe(2);

    await expect(page.locator('[data-testid="token-usage-entry"]', { hasText: GATEWAY_INJECTED_SESSION_ID })).toHaveCount(0);
    await expect(page.locator('[data-testid="token-usage-entry"]', { hasText: DELIVERY_MIRROR_SESSION_ID })).toHaveCount(0);
  });
});
