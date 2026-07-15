import type { ElectronApplication, Page } from '@playwright/test';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

async function installRolloutMocks(app: ElectronApplication): Promise<void> {
  const sessions = [{
    key: SESSION_KEY,
    displayName: 'main',
    status: 'done',
    hasActiveRun: false,
  }];
  const historyResult = {
    messages: [{
      id: 'rollout-user',
      role: 'user',
      content: 'Check renderer rollout.',
      timestamp: 1_000,
    }, {
      id: 'rollout-final',
      role: 'assistant',
      content: 'Renderer rollout is ready.',
      timestamp: 1_001,
    }],
    sessionInfo: { hasActiveRun: false },
  };

  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions },
      },
      [stableStringify(['sessions.list', {}])]: { success: true, result: { sessions } },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
        success: true,
        result: historyResult,
      },
    },
    hostApi: {
      [stableStringify(['/api/gateway/status', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        },
      },
      [stableStringify(['/api/chat/sessions', 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: { sessions } } },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: historyResult } },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, agents: [{ id: 'main', name: 'Main' }] },
        },
      },
      [stableStringify(['/api/files/thumbnails', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: {} },
      },
    },
  });
}

async function reloadStableWindow(app: ElectronApplication): Promise<Page> {
  let page = await getStableWindow(app);
  try {
    await page.reload();
  } catch (error) {
    if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
  }
  page = await getStableWindow(app);
  await expect(page.getByTestId('main-layout')).toBeVisible();
  return page;
}

test.describe('conversation timeline rollout', () => {
  test('legacy flag restores the legacy renderer', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true, chatTimelineMode: 'legacy' });
    try {
      await installRolloutMocks(app);
      const page = await reloadStableWindow(app);

      await expect(page.getByTestId('chat-page')).toHaveAttribute('data-timeline-mode', 'legacy');
      await expect(page.getByTestId('conversation-timeline')).toHaveCount(0);
      await expect(page.getByText('Renderer rollout is ready.', { exact: true })).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shadow flag renders legacy while canonical projection compares in the background', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true, chatTimelineMode: 'shadow' });
    try {
      await installRolloutMocks(app);
      let page = await getStableWindow(app);
      const shadowMetrics: string[] = [];
      page.on('console', (message) => {
        if (message.text().includes('[ui-metric] conversation.shadow_compare')) {
          shadowMetrics.push(message.text());
        }
      });
      page = await reloadStableWindow(app);

      await expect(page.getByTestId('chat-page')).toHaveAttribute('data-timeline-mode', 'shadow');
      await expect(page.getByTestId('conversation-timeline')).toHaveCount(0);
      await expect(page.getByText('Renderer rollout is ready.', { exact: true })).toBeVisible();
      await expect.poll(() => shadowMetrics.length).toBeGreaterThan(0);
      expect(shadowMetrics.join('\n')).not.toContain('Check renderer rollout.');
      expect(shadowMetrics.join('\n')).not.toContain('Renderer rollout is ready.');
    } finally {
      await closeElectronApp(app);
    }
  });
});
