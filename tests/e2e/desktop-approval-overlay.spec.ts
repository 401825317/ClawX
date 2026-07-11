import { closeElectronApp, expect, getStableWindow, test } from './fixtures/electron';

test.describe('UClaw desktop approval overlay', () => {
  test('shows a Main-owned pending approval and can deny it without exposing action payload', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    try {
      await app.evaluate(({ ipcMain }) => {
        let pending = true;
        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event, request: { path?: string; method?: string }) => {
          const path = request?.path || '';
          const method = request?.method || 'GET';
          if (path.startsWith('/api/computer/approvals') && method === 'GET') {
            return {
              ok: true,
              data: {
                status: 200,
                ok: true,
                json: {
                  success: true,
                  approvals: pending ? [{
                    id: '12345678-1234-1234-1234-123456789012',
                    sessionKey: 'agent:main:main',
                    runId: 'run:test',
                    action: { kind: 'type_text', appId: 'com.example.editor' },
                    createdAt: new Date().toISOString(),
                    expiresAt: new Date(Date.now() + 60_000).toISOString(),
                    reason: 'test',
                  }] : [],
                },
              },
            };
          }
          if (path.includes('/api/computer/approvals/') && path.endsWith('/deny') && method === 'POST') {
            pending = false;
            return { ok: true, data: { status: 200, ok: true, json: { success: true } } };
          }
          return { ok: true, data: { status: 200, ok: true, json: {} } };
        });
      });
      const page = await getStableWindow(app);
      const overlay = page.getByTestId('desktop-approval-overlay');
      await expect(overlay).toBeVisible();
      await expect(overlay).toContainText('com.example.editor');
      await expect(overlay).not.toContainText('secret payload');
      await page.getByTestId('desktop-approval-deny').click();
      await expect(overlay).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
