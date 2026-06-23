import { closeElectronApp, emitIpcEvent, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

async function measureNavigation(
  page: Awaited<ReturnType<typeof getStableWindow>>,
  navTestId: string,
  targetTestId: string,
): Promise<number> {
  const startedAt = Date.now();
  await page.getByTestId(navTestId).click();
  await expect(page.getByTestId(targetTestId)).toBeVisible();
  return Date.now() - startedAt;
}

function buildStressSessions(count: number, now: number) {
  return Array.from({ length: count }, (_, index) => ({
    key: `agent:main:session-${now - index}`,
    displayName: `Stress session ${index}`,
    label: `Stress session ${index}`,
    updatedAt: now - index * 1_000,
    status: 'completed',
    hasActiveRun: false,
  }));
}

async function installLargeSessionListMocks(
  app: Parameters<typeof installIpcMocks>[0],
  sessions: ReturnType<typeof buildStressSessions>,
) {
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions },
      },
      [stableStringify(['chat.history', null])]: {
        success: true,
        result: { messages: [] },
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
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: { sessions } },
        },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: { messages: [] } },
        },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, agents: [{ id: 'main', name: 'Main' }] },
        },
      },
      [stableStringify(['/api/sessions/summaries', 'POST'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, summaries: [] },
        },
      },
    },
  });
}

async function loadLargeSessionList(
  app: Parameters<typeof emitIpcEvent>[0],
  page: Awaited<ReturnType<typeof getStableWindow>>,
  sessions: ReturnType<typeof buildStressSessions>,
  now: number,
) {
  await installLargeSessionListMocks(app, sessions);
  await page.waitForTimeout(1_250);
  await emitIpcEvent(app, 'gateway:status-changed', {
    state: 'running',
    port: 18789,
    pid: 12345,
    gatewayReady: true,
    connectedAt: now,
  });
  await expect(page.getByText('Stress session 0')).toBeVisible({ timeout: 10_000 });
}

test.describe('ClawX navigation responsiveness', () => {
  test('keeps core navigation responsive with developer mode enabled', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await expect(page.getByTestId('main-layout')).toBeVisible();

      await page.getByTestId('sidebar-nav-settings').click();
      await expect(page.getByTestId('settings-page')).toBeVisible();
      const devModeSwitch = page.getByTestId('settings-dev-mode-switch');
      await expect(devModeSwitch).toBeVisible();
      if (await devModeSwitch.getAttribute('data-state') !== 'checked') {
        await devModeSwitch.click();
      }
      await expect(page.getByTestId('sidebar-nav-dreams')).toBeVisible();

      const timings = {
        models: await measureNavigation(page, 'sidebar-nav-models', 'models-page'),
        agents: await measureNavigation(page, 'sidebar-nav-agents', 'agents-page'),
        channels: await measureNavigation(page, 'sidebar-nav-channels', 'channels-page'),
        settings: await measureNavigation(page, 'sidebar-nav-settings', 'settings-page'),
      };

      console.info('[navigation:perf]', JSON.stringify({ timings }));

      for (const [route, durationMs] of Object.entries(timings)) {
        expect(durationMs, `${route} navigation should not block on heavy background work`).toBeLessThan(5_000);
      }
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps the sidebar clickable during rapid workbench navigation', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      const page = await getStableWindow(app);

      await expect(page.getByTestId('main-layout')).toBeVisible();

      const navIds = [
        'sidebar-nav-models',
        'sidebar-nav-agents',
        'sidebar-nav-channels',
        'sidebar-nav-skills',
        'sidebar-nav-cron',
        'sidebar-nav-settings',
      ];
      const clickDurations: number[] = [];

      for (let round = 0; round < 4; round += 1) {
        for (const testId of navIds) {
          const startedAt = Date.now();
          await page.getByTestId(testId).click({ timeout: 2_000 });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          clickDurations.push(Date.now() - startedAt);
        }
      }

      await expect(page.getByTestId('settings-page')).toBeVisible();

      const maxClickMs = Math.max(...clickDurations);
      const averageClickMs = clickDurations.reduce((sum, value) => sum + value, 0) / clickDurations.length;
      console.info('[navigation:rapid]', JSON.stringify({ maxClickMs, averageClickMs, clickDurations }));

      expect(maxClickMs, 'rapid sidebar clicks should not freeze the workbench').toBeLessThan(1_500);
      expect(averageClickMs, 'rapid sidebar clicks should stay consistently responsive').toBeLessThan(500);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps rapid workbench navigation responsive with a large session list', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const now = Date.now();
    const sessions = buildStressSessions(400, now);

    try {
      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await loadLargeSessionList(app, page, sessions, now);

      const navIds = [
        'sidebar-nav-models',
        'sidebar-nav-agents',
        'sidebar-nav-channels',
        'sidebar-nav-skills',
        'sidebar-nav-cron',
        'sidebar-nav-settings',
      ];
      const clickDurations: number[] = [];

      for (let round = 0; round < 5; round += 1) {
        for (const testId of navIds) {
          const startedAt = Date.now();
          await page.getByTestId(testId).click({ timeout: 2_000 });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          clickDurations.push(Date.now() - startedAt);
        }
      }

      const maxClickMs = Math.max(...clickDurations);
      const averageClickMs = clickDurations.reduce((sum, value) => sum + value, 0) / clickDurations.length;
      console.info('[navigation:session-stress]', JSON.stringify({ maxClickMs, averageClickMs, clickDurations }));

      expect(maxClickMs, 'large session list should not freeze workbench navigation').toBeLessThan(1_500);
      expect(averageClickMs, 'large session list should keep repeated nav clicks responsive').toBeLessThan(500);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps rapid chat session switching responsive with a large session list', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const now = Date.now();
    const sessions = buildStressSessions(400, now);

    try {
      const page = await getStableWindow(app);
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await loadLargeSessionList(app, page, sessions, now);

      const sessionIndexes = [1, 2, 3, 4, 5, 10, 15, 20, 25, 30, 35, 40];
      const clickDurations: number[] = [];

      for (let round = 0; round < 3; round += 1) {
        for (const index of sessionIndexes) {
          const startedAt = Date.now();
          await page.getByTestId(`sidebar-session-${sessions[index]!.key}`).click({ timeout: 2_000 });
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
          clickDurations.push(Date.now() - startedAt);
        }
      }

      const maxClickMs = Math.max(...clickDurations);
      const averageClickMs = clickDurations.reduce((sum, value) => sum + value, 0) / clickDurations.length;
      console.info('[navigation:session-switch]', JSON.stringify({ maxClickMs, averageClickMs, clickDurations }));

      expect(maxClickMs, 'rapid session clicks should not freeze the workbench').toBeLessThan(1_500);
      expect(averageClickMs, 'rapid session clicks should stay responsive').toBeLessThan(500);
    } finally {
      await closeElectronApp(app);
    }
  });
});
