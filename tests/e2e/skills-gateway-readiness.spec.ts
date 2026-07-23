import {
  completeSetup,
  expect,
  getRecordedHostInvocations,
  installIpcMocks,
  test,
} from './fixtures/electron';

test.describe('Skills page gateway readiness', () => {
  test('shows local skills even when gateway is stopped', async ({ electronApp, page }) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789 },
      gatewayRpc: {
        '["skills.status",null]': { success: false, error: 'Gateway not connected' },
      },
      hostApi: {
        '["skills","status",null]': { skills: [] },
        '["skills","marketplaceCapability",null]': {
          success: true,
          capability: { canSearch: false, canInstall: false },
        },
        '["skills","local",null]': {
          success: true,
          skills: [{
            id: 'pdf',
            slug: 'pdf',
            name: 'PDF',
            description: 'Local PDF tools',
            enabled: true,
            source: 'openclaw-managed',
            baseDir: '/tmp/.openclaw/skills/pdf',
          }, {
            id: 'xlsx',
            slug: 'xlsx',
            name: 'XLSX',
            description: 'Local spreadsheet tools',
            enabled: false,
            source: 'openclaw-managed',
            baseDir: '/tmp/.openclaw/skills/xlsx',
          }],
        },
      },
    });

    const skillStoreNav = page.getByTestId('sidebar-nav-skills');
    await expect(skillStoreNav).toHaveText(/Skill Store|技能商店|スキルストア|Магазин навыков/);
    await skillStoreNav.click();
    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'PDF' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'XLSX' })).toBeVisible();
    await expect(page.getByTestId('skills-gateway-banner')).toHaveAttribute('data-state', 'stopped', { timeout: 3_500 });
    await expect(page.getByRole('button', { name: /Install Skills/i })).toHaveCount(0);

    await page.getByTestId('skills-filter-enabled').click();
    await expect(page.getByRole('heading', { name: 'PDF' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'XLSX' })).toHaveCount(0);

    await page.getByTestId('skills-filter-disabled').click();
    await expect(page.getByRole('heading', { name: 'PDF' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'XLSX' })).toBeVisible();
  });

  test('hides uninstall for plugin-provided skills', async ({ electronApp, page }) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789 },
      gatewayRpc: {
        '["skills.status",null]': { success: false, error: 'Gateway not connected' },
      },
      hostApi: {
        '["skills","status",null]': { skills: [] },
        '["skills","marketplaceCapability",null]': {
          success: true,
          capability: { canSearch: false, canInstall: false },
        },
        '["skills","local",null]': {
          success: true,
          skills: [{
            id: 'browser-automation',
            slug: 'browser-automation',
            name: 'Browser Automation',
            description: 'Plugin skill',
            enabled: true,
            source: 'openclaw-plugin',
            baseDir: '/tmp/.openclaw/plugin-skills/browser-automation',
          }],
        },
      },
    });

    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByRole('heading', { name: 'Browser Automation' })).toBeVisible();
    await page.getByText('Browser Automation').click();
    await expect(page.getByRole('button', { name: /Uninstall|卸载|アンインストール|Удалить/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Disable|禁用|無効化|Выключить/i })).toBeVisible();
  });

  test('clears stale startup banner once local skills load while runtime rpc is still starting', async ({ electronApp, page }) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayRpc: {
        '["skills.status",null]': { success: false, error: 'Gateway not connected' },
      },
      hostApi: {
        '["skills","status",null]': { skills: [] },
        '["skills","marketplaceCapability",null]': {
          success: true,
          capability: { canSearch: false, canInstall: false },
        },
        '["skills","local",null]': {
          success: true,
          skills: [],
        },
      },
    });

    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByTestId('skills-gateway-banner')).toHaveAttribute('data-state', 'stopped', { timeout: 3_500 });

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send('gateway:status-changed', {
        state: 'running',
        port: 18789,
        pid: 12345,
        connectedAt: 1,
        gatewayReady: false,
      });
    });

    await expect(page.getByTestId('sidebar-gateway-restarting')).toHaveAttribute('data-state', 'visible');
    await expect(page.getByTestId('skills-gateway-banner')).toHaveCount(0, { timeout: 3_500 });

    await installIpcMocks(electronApp, {
      gatewayRpc: {
        '["skills.status",null]': { success: true, result: { skills: [] } },
      },
      hostApi: {
        '["skills","status",null]': { skills: [] },
        '["skills","local",null]': { success: true, skills: [] },
        '["skills","marketplaceCapability",null]': {
          success: true,
          capability: { canSearch: false, canInstall: false },
        },
      },
    });

    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win?.webContents.send('gateway:status-changed', {
        state: 'running',
        port: 18789,
        pid: 12345,
        connectedAt: 2,
        gatewayReady: false,
      });
    });

    await expect(page.getByTestId('skills-gateway-banner')).toHaveCount(0, { timeout: 2_000 });
  });

  test('browses and installs marketplace skills without auth or gateway lifecycle calls', async ({ electronApp, page }, testInfo) => {
    await completeSetup(page);

    await installIpcMocks(electronApp, {
      gatewayStatus: { state: 'stopped', port: 18789 },
      gatewayRpc: {
        '["skills.status",null]': { success: false, error: 'Gateway not connected' },
      },
      recordHostInvocations: true,
      hostApi: {
        '["skills","status",null]': { skills: [] },
        '["skills","local",null]': { success: true, skills: [] },
        '["skills","marketplaceCapability",null]': {
          success: true,
          capability: { mode: 'multi-marketplace', canSearch: true, canInstall: true },
        },
        '["skills","marketplaceSearch",{"limit":100,"locale":"en","provider":"skillhub","query":""}]': {
          success: true,
          results: [{
            slug: 'demo-skill',
            name: 'Demo Skill',
            description: 'A marketplace skill',
            version: '1.0.0',
            provider: 'skillhub',
          }],
          total: 2,
          loaded: 1,
          totalKnown: true,
          source: 'skillhub',
          query: '',
          sort: 'score',
          dir: 'desc',
          hasMore: true,
          nextCursor: '2',
        },
        '["skills","marketplaceSearch",{"cursor":"2","dir":"desc","limit":100,"locale":"en","provider":"skillhub","query":"","sort":"score"}]': {
          success: true,
          results: [{
            slug: 'second-skill',
            name: 'Second Skill',
            description: 'Loaded from the next page',
            version: '1.0.0',
            provider: 'skillhub',
          }],
          total: 2,
          loaded: 1,
          totalKnown: true,
          source: 'skillhub',
          query: '',
          sort: 'score',
          dir: 'desc',
          hasMore: false,
          nextCursor: '',
        },
        '["skills","marketplaceSearch",{"limit":24,"locale":"en","provider":"skillhub","query":"browser automation"}]': {
          success: true,
          results: [{
            slug: 'github-helper',
            name: 'GitHub Helper',
            description: 'Developer automation',
            version: '2.0.0',
            provider: 'skillhub',
            category: 'developer_tools',
          }],
          source: 'skillhub',
        },
        '["skills","marketplaceSearch",{"limit":24,"locale":"en","provider":"skillhub","query":"github"}]': {
          success: true,
          results: [],
          source: 'skillhub',
        },
        '["skills","marketplaceSearch",{"limit":24,"locale":"en","provider":"skillhub","query":"coding"}]': {
          success: true,
          results: [],
          source: 'skillhub',
        },
        '["skills","marketplaceSearch",{"limit":24,"locale":"en","provider":"skillhub","query":"developer tools"}]': {
          success: true,
          results: [],
          source: 'skillhub',
        },
        '["skills","marketplaceInstall",{"provider":"skillhub","slug":"github-helper","version":"2.0.0"}]': {
          success: true,
        },
      },
    });

    await page.getByTestId('sidebar-nav-skills').click();
    await expect(page.getByTestId('skills-page')).toBeVisible();
    await expect(page.getByTestId('skills-marketplace-view')).toBeVisible();
    await expect(page.getByTestId('marketplace-category-creative-design')).toBeVisible();
    await expect(page.getByTestId('marketplace-category-ecommerce-growth')).toBeVisible();
    await expect(page.getByTestId('marketplace-skill-card').filter({ hasText: 'Demo Skill' })).toBeVisible();

    await page.getByTestId('marketplace-load-more').click();
    await expect(page.getByTestId('marketplace-skill-card').filter({ hasText: 'Second Skill' })).toBeVisible();

    await page.getByTestId('marketplace-category-dev-automation').click();
    const githubCard = page.getByTestId('marketplace-skill-card').filter({ hasText: 'GitHub Helper' });
    await expect(githubCard).toBeVisible();
    await expect.poll(async () => (
      page.getByTestId('skills-content-scroll').evaluate((element) => element.scrollTop)
    )).toBe(0);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    const desktopScreenshot = testInfo.outputPath('skills-marketplace-desktop.png');
    await page.screenshot({ path: desktopScreenshot });
    await testInfo.attach('skills-marketplace-desktop', {
      path: desktopScreenshot,
      contentType: 'image/png',
    });

    await page.setViewportSize({ width: 720, height: 760 });
    await expect(githubCard).toBeVisible();
    expect(await page.evaluate(() => (
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
    ))).toBe(true);
    const narrowScreenshot = testInfo.outputPath('skills-marketplace-narrow.png');
    await page.screenshot({ path: narrowScreenshot });
    await testInfo.attach('skills-marketplace-narrow', {
      path: narrowScreenshot,
      contentType: 'image/png',
    });
    await githubCard.scrollIntoViewIfNeeded();
    const narrowCardScreenshot = testInfo.outputPath('skills-marketplace-narrow-card.png');
    await githubCard.screenshot({ path: narrowCardScreenshot });
    await testInfo.attach('skills-marketplace-narrow-card', {
      path: narrowCardScreenshot,
      contentType: 'image/png',
    });

    await githubCard.getByRole('button', { name: /Install/i }).click();

    await expect.poll(async () => {
      const invocations = await getRecordedHostInvocations(electronApp);
      return invocations.some((entry) => (
        entry.module === 'skills'
        && entry.action === 'marketplaceInstall'
        && entry.payload?.slug === 'github-helper'
      ));
    }).toBe(true);

    const invocations = await getRecordedHostInvocations(electronApp);
    expect(invocations.some((entry) => entry.module === 'managedAuth')).toBe(false);
    expect(invocations.some((entry) => (
      entry.module === 'gateway'
      && ['start', 'restart', 'stop'].includes(entry.action || '')
    ))).toBe(false);
  });
});
