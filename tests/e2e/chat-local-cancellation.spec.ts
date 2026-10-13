import {
  closeElectronApp,
  expect,
  getStableWindow,
  installAttachmentHostFixture,
  test,
} from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

test('stops a live turn while Gateway is unavailable without waiting for the remote prompt', async ({ launchElectronApp }) => {
  const app = await launchElectronApp({ skipSetup: true, managedProvider: true });
  try {
    const fixture = await installAttachmentHostFixture(app, {
      sessions: [{ key: SESSION_KEY, title: 'Local cancellation' }],
    });
    await fixture.setTranscriptResponses(SESSION_KEY, [[]]);
    await app.evaluate(async ({ app: _app }) => {
      const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
      type Request = { id: string; module?: string; action?: string };
      type Handler = (event: unknown, request: Request) => Promise<unknown>;
      const original = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers.get('host:invoke');
      const state = { cancelCalls: 0, resolvePrompt: null as (() => void) | null };
      (globalThis as unknown as { __e2eLocalCancel: typeof state }).__e2eLocalCancel = state;
      ipcMain.removeHandler('host:invoke');
      ipcMain.handle('host:invoke', async (event, request: Request) => {
        if (request.module === 'chat' && request.action === 'sendAcpPrompt') {
          await new Promise<void>((resolve) => { state.resolvePrompt = resolve; });
          return { id: request.id, ok: true, data: { success: false, errorCode: 'CANCELLED', retryable: false, error: 'Cancelled by user' } };
        }
        if (request.module === 'chat' && request.action === 'cancelAcpSession') {
          state.cancelCalls += 1;
          state.resolvePrompt?.();
          return { id: request.id, ok: true, data: { success: true, generation: 1 } };
        }
        return original?.(event, request);
      });
    });
    const page = await getStableWindow(app);
    await page.reload();
    const composer = page.getByTestId('chat-composer-input');
    await expect(composer).toBeEnabled({ timeout: 30_000 });
    await composer.fill('Stop this long running task');
    const send = page.getByTestId('chat-composer-send');
    await expect(send).toBeEnabled();
    await send.click();
    await expect(send).toHaveAttribute('title', /stop|停止/i);
    await app.evaluate(({ app: _app }) => {
      const { BrowserWindow } = process.mainModule!.require('electron') as typeof import('electron');
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('gateway:status-changed', { state: 'starting', gatewayReady: false, port: 18789 });
      }
    });
    await expect(composer).toBeDisabled();
    await expect(send).toBeEnabled();
    await send.click();
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __e2eLocalCancel: { cancelCalls: number } }).__e2eLocalCancel.cancelCalls)).toBe(1);
    await expect(send).toHaveAttribute('title', /send|发送/i);
    await expect(send).toBeDisabled();
    await fixture.emitAcpSessionUpdates({
      sessionKey: SESSION_KEY,
      updates: [{ sessionUpdate: 'agent_message_chunk', messageId: 'late-cancelled-reply', content: { type: 'text', text: 'Late reply must not appear' } }],
    });
    await expect(page.getByText('Late reply must not appear')).toHaveCount(0);
    await expect(page.getByTestId('acp-turn-failure')).toHaveCount(0);
  } finally {
    await closeElectronApp(app);
  }
});
