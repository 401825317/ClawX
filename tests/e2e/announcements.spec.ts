import type { ElectronApplication } from '@playwright/test';
import type { ClientAnnouncementConfig } from '../../shared/announcements';
import { SIDEBAR_COLLAPSED_WIDTH } from '../../shared/sidebar-layout';
import {
  closeElectronApp,
  completeSetup,
  expect,
  getStableWindow,
  installIpcMocks,
  test,
} from './fixtures/electron';

const importantAndNormal: ClientAnnouncementConfig = {
  enabled: true,
  items: [
    {
      id: 'maintenance',
      title: 'Important maintenance',
      content: 'The service will be updated tonight.',
      level: 'important',
      publishedAt: '2026-09-04T12:00:00.000Z',
    },
    {
      id: 'release',
      title: 'New release',
      content: 'UClaw has a new client release.',
      level: 'normal',
      publishedAt: '2026-09-03T12:00:00.000Z',
      link: 'https://aiwxxx.com/releases',
    },
  ],
};

async function recordedAnnouncementInvocations(app: ElectronApplication) {
  return await app.evaluate(() => (
    (globalThis as unknown as {
      __e2eHostInvocations?: Array<{ module?: string; action?: string; payload?: unknown }>;
    }).__e2eHostInvocations ?? []
  )).then((items) => items.filter((item) => item.module === 'announcements'));
}

test('shows public announcements through the typed Host API', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ managedProvider: false });

  try {
    await installIpcMocks(app, {
      announcements: importantAndNormal,
      recordHostInvocations: true,
    });
    const page = await getStableWindow(app);
    await completeSetup(page);

    const bell = page.getByTestId('sidebar-announcements');
    await expect(bell).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('sidebar-announcements-unread')).toBeVisible();
    await expect(page.locator('[data-sonner-toast]').filter({ hasText: 'Important maintenance' })).toBeVisible({
      timeout: 8_000,
    });

    await bell.click();
    const sheet = page.getByTestId('announcements-sheet');
    await expect(sheet.getByRole('heading', { name: 'Announcements' })).toBeVisible();
    await expect(sheet.getByTestId('announcement-maintenance')).toContainText('Important maintenance');
    await expect(sheet.getByTestId('announcement-release')).toContainText('New release');
    await expect(page.getByTestId('announcements-refresh')).toBeVisible();
    await page.getByTestId('announcements-refresh').click();
    await page.getByTestId('announcements-tab-history').click();
    await expect(page.getByTestId('announcements-history-empty')).toBeVisible();
    await page.getByTestId('announcements-tab-latest').click();
    await expect(page.getByTestId('sidebar-announcements-unread')).toHaveCount(0);

    await page.getByTestId('announcements-close').click();
    await expect(sheet).toHaveCount(0);
    const sidebar = page.getByTestId('sidebar');
    await page.getByTestId('sidebar-collapse-toggle').click();
    await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBe(SIDEBAR_COLLAPSED_WIDTH);
    const sidebarBox = await sidebar.boundingBox();
    const collapsedBellBox = await bell.boundingBox();
    const collapsedToggleBox = await page.getByTestId('sidebar-collapse-toggle').boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(collapsedBellBox).not.toBeNull();
    expect(collapsedToggleBox).not.toBeNull();
    for (const box of [collapsedBellBox!, collapsedToggleBox!]) {
      expect(box.x).toBeGreaterThanOrEqual(sidebarBox!.x);
      expect(box.x + box.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
    }

    const invocations = await recordedAnnouncementInvocations(app);
    expect(invocations.length).toBeGreaterThanOrEqual(1);
    expect(invocations.every((invocation) => (
      invocation.action === 'config' && invocation.payload === undefined
    ))).toBe(true);
  } finally {
    await closeElectronApp(app);
  }
});

test('keeps the announcement entry stable when the feed is empty', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ managedProvider: false });

  try {
    await installIpcMocks(app, {
      announcements: { enabled: true, items: [] },
    });
    const page = await getStableWindow(app);
    await completeSetup(page);

    const bell = page.getByTestId('sidebar-announcements');
    await expect(bell).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('sidebar-announcements-unread')).toHaveCount(0);
    await bell.click();
    await expect(page.getByTestId('announcements-empty')).toBeVisible();
  } finally {
    await closeElectronApp(app);
  }
});

test('blocks on an unread urgent announcement until it is confirmed', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ managedProvider: false });

  try {
    await installIpcMocks(app, {
      announcements: {
        enabled: true,
        items: [{
          id: 'urgent-maintenance',
          title: 'Urgent maintenance',
          content: 'Please finish your work before the service restarts.',
          level: 'urgent',
          publishedAt: '2026-09-04T12:00:00.000Z',
        }],
      },
    });
    const page = await getStableWindow(app);
    await completeSetup(page);

    const dialog = page.getByTestId('urgent-announcement-dialog');
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog).toContainText('Urgent maintenance');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(dialog).toHaveCount(0);
  } finally {
    await closeElectronApp(app);
  }
});
