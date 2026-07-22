import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

test.describe('ClawX startup chat history recovery', () => {
  test('retries an initial chat.history timeout and eventually renders history', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, connectedAt: Date.now() },
        gatewayRpc: {},
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345, connectedAt: Date.now() },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, agents: [{ id: 'main', name: 'main' }] },
            },
          },
        },
      });

      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        let chatHistoryCallCount = 0;

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, payload: unknown) => {
          const stableStringify = (value: unknown): string => {
            if (value == null || typeof value !== 'object') return JSON.stringify(value);
            if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
            const entries = Object.entries(value as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
            return `{${entries.join(',')}}`;
          };

          const key = stableStringify([method, payload ?? null]);
          if (key === stableStringify(['sessions.list', {}])) {
            return {
              success: true,
              result: {
                sessions: [{ key: 'agent:main:main', displayName: 'main' }],
              },
            };
          }
          if (key === stableStringify(['chat.history', { sessionKey: 'agent:main:main', limit: 100, maxChars: 500000 }])) {
            chatHistoryCallCount += 1;
            if (chatHistoryCallCount === 1) {
              return {
                success: false,
                error: 'RPC timeout: chat.history',
              };
            }
            return {
              success: true,
              result: {
                messages: [
                  { role: 'user', content: 'hello', timestamp: 1000 },
                  { role: 'assistant', content: 'history restored after retry', timestamp: 1001 },
                ],
              },
            };
          }
          return { success: true, result: {} };
        });
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('history restored after retry')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('RPC timeout: chat.history')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders local transcript while initial chat.history is still pending', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, connectedAt: Date.now() },
        gatewayRpc: {},
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345, connectedAt: Date.now() },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, agents: [{ id: 'main', name: 'main' }] },
            },
          },
          [stableStringify(['/api/sessions/transcript?sessionKey=agent%3Amain%3Amain&limit=100', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                messages: [
                  { role: 'assistant', content: 'local transcript while gateway is pending', timestamp: 1000 },
                ],
              },
            },
          },
          [stableStringify(['/api/sessions/transcript?sessionKey=agent%3Amain%3Amain&limit=100&includeFamily=true', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                messages: [
                  { role: 'assistant', content: 'local transcript while gateway is pending', timestamp: 1000 },
                ],
              },
            },
          },
        },
      });

      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, payload: unknown) => {
          const stableStringify = (value: unknown): string => {
            if (value == null || typeof value !== 'object') return JSON.stringify(value);
            if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
            const entries = Object.entries(value as Record<string, unknown>)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
            return `{${entries.join(',')}}`;
          };

          const key = stableStringify([method, payload ?? null]);
          if (key === stableStringify(['sessions.list', {}])) {
            return {
              success: true,
              result: {
                sessions: [{ key: 'agent:main:main', displayName: 'main' }],
              },
            };
          }
          if (key === stableStringify(['chat.history', { sessionKey: 'agent:main:main', limit: 100, maxChars: 500000 }])) {
            await new Promise((resolve) => setTimeout(resolve, 5_000));
            return {
              success: true,
              result: {
                messages: [
                  { role: 'assistant', content: 'gateway authoritative history after delay', timestamp: 1001 },
                ],
              },
            };
          }
          return { success: true, result: {} };
        });
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('local transcript while gateway is pending')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('gateway authoritative history after delay')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByText('local transcript while gateway is pending')).toHaveCount(0);
      await expect(page.getByText('RPC timeout: chat.history')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not list the reset default composer session as conversation history', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const sessionKey = 'agent:main:main';

    try {
      await installIpcMocks(app, {
        gatewayStatus: {
          state: 'running',
          port: 18789,
          pid: 12345,
          gatewayReady: true,
          connectedAt: Date.now(),
        },
        gatewayRpc: {},
      });

      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const runtime = globalThis as Record<string, unknown>;
        runtime.__clawxE2EEmptySessionListRequests = 0;

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (
          _event: unknown,
          request: { path?: string },
        ) => {
          const path = request?.path ?? '';
          const jsonResponse = (json: unknown) => ({
            ok: true,
            data: { status: 200, ok: true, json },
          });

          if (path === '/api/chat/sessions') {
            runtime.__clawxE2EEmptySessionListRequests = Number(
              runtime.__clawxE2EEmptySessionListRequests ?? 0,
            ) + 1;
            return jsonResponse({
              success: true,
              result: {
                sessions: [{
                  key: 'agent:main:main',
                  displayName: 'main',
                  systemSent: false,
                  hasActiveRun: false,
                  totalTokens: 0,
                }],
              },
            });
          }
          if (path === '/api/chat/history') {
            return jsonResponse({
              success: true,
              result: { messages: [], sessionInfo: { hasActiveRun: false } },
            });
          }
          if (path.startsWith('/api/sessions/transcript?')) {
            return jsonResponse({ messages: [] });
          }
          if (path.startsWith('/api/task-bridge/tasks?')) {
            return jsonResponse({ success: true, tasks: [] });
          }
          if (path === '/api/gateway/status') {
            return jsonResponse({
              state: 'running',
              port: 18789,
              pid: 12345,
              gatewayReady: true,
            });
          }
          if (path === '/api/agents') {
            return jsonResponse({ success: true, agents: [{ id: 'main', name: 'main' }] });
          }
          if (path === '/api/settings') {
            return jsonResponse({ devModeUnlocked: false });
          }
          if (path === '/api/files/thumbnails') {
            return jsonResponse({});
          }
          return jsonResponse({});
        });
      });

      let page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      page = await getStableWindow(app);

      await expect(page.getByTestId('chat-composer-input')).toBeVisible();
      await page.waitForTimeout(2_500);
      await page.getByRole('button', { name: /Refresh chat|刷新聊天|チャットを更新|Обновить чат/u }).click();
      await expect.poll(async () => await app.evaluate(() => Number(
        (globalThis as Record<string, unknown>).__clawxE2EEmptySessionListRequests ?? 0,
      ))).toBeGreaterThan(0);
      await page.waitForTimeout(500);
      for (const bucketKey of ['today', 'withinWeek', 'withinMonth', 'older']) {
        const toggle = page.getByTestId(`session-bucket-toggle-${bucketKey}`);
        if (await toggle.count() > 0 && await toggle.getAttribute('aria-expanded') === 'false') {
          await toggle.click();
        }
      }
      await expect(page.getByTestId(`sidebar-session-${sessionKey}`)).toHaveCount(0);
      await expect(page.getByTestId('conversation-turn')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('does not resurrect deleted media when an older history request resolves late', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const sessionKey = 'agent:main:main';
    const deletedMediaHistory = [{
      id: 'deleted-session-media',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Deleted session media snapshot.\nMEDIA:/tmp/deleted-session-output.png',
      }, {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        },
      }],
      timestamp: 2_000,
      _attachedFiles: [{
        fileName: 'deleted-session-output.png',
        mimeType: 'image/png',
        fileSize: 128,
        preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
        filePath: '/tmp/deleted-session-output.png',
        source: 'tool-result',
        disposition: 'output-delivery',
      }],
    }];

    try {
      await installIpcMocks(app, {
        gatewayStatus: {
          state: 'running',
          port: 18789,
          pid: 12345,
          gatewayReady: true,
          connectedAt: Date.now(),
        },
        gatewayRpc: {},
      });

      await app.evaluate(async ({ app: _app }, fixture) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const runtime = globalThis as Record<string, unknown>;
        let deleted = false;
        let releaseLateHistory: (() => void) | null = null;
        const lateHistoryGate = new Promise<void>((resolve) => {
          releaseLateHistory = resolve;
        });

        runtime.__clawxE2ELateHistoryStarted = false;
        runtime.__clawxE2EPostDeleteTranscriptRead = false;
        runtime.__clawxE2EReleaseLateHistory = () => releaseLateHistory?.();

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (
          _event: unknown,
          request: { path?: string; method?: string; body?: string },
        ) => {
          const path = request?.path ?? '';
          const jsonResponse = (json: unknown) => ({
            ok: true,
            data: { status: 200, ok: true, json },
          });

          if (path === '/api/chat/sessions') {
            return jsonResponse({
              success: true,
              result: {
                sessions: deleted ? [] : [{
                  key: fixture.sessionKey,
                  displayName: 'main',
                  updatedAt: Date.now(),
                }],
              },
            });
          }
          if (path === '/api/chat/history') {
            runtime.__clawxE2ELateHistoryStarted = true;
            await lateHistoryGate;
            return jsonResponse({
              success: true,
              result: {
                messages: fixture.deletedMediaHistory,
                sessionInfo: { hasActiveRun: false },
              },
            });
          }
          if (path.startsWith('/api/sessions/transcript?')) {
            if (deleted) runtime.__clawxE2EPostDeleteTranscriptRead = true;
            return jsonResponse({ messages: deleted ? [] : fixture.deletedMediaHistory });
          }
          if (path === '/api/sessions/delete') {
            deleted = true;
            return jsonResponse({ success: true });
          }
          if (path === '/api/chat/outbox/session/cancel') {
            return jsonResponse({ success: true, cancelled: 0 });
          }
          if (path.startsWith('/api/task-bridge/tasks?')) {
            return jsonResponse({ tasks: [] });
          }
          if (path === '/api/gateway/status') {
            return jsonResponse({
              state: 'running',
              port: 18789,
              pid: 12345,
              gatewayReady: true,
            });
          }
          if (path === '/api/agents') {
            return jsonResponse({ success: true, agents: [{ id: 'main', name: 'main' }] });
          }
          if (path === '/api/settings') {
            return jsonResponse({ devModeUnlocked: false });
          }
          if (path === '/api/files/thumbnails') {
            return jsonResponse({});
          }
          return jsonResponse({});
        });
      }, { sessionKey, deletedMediaHistory });

      let page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      page = await getStableWindow(app);

      const sessionRow = page.getByTestId(`sidebar-session-${sessionKey}`);
      await expect(sessionRow).toBeVisible();
      await expect(page.getByText('Deleted session media snapshot.', { exact: true })).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('img[alt="deleted-session-output.png"]')).toHaveCount(1);
      await expect.poll(async () => await app.evaluate(() => (
        globalThis as Record<string, unknown>
      ).__clawxE2ELateHistoryStarted)).toBe(true);

      await sessionRow.hover();
      await sessionRow.locator('xpath=..').locator('button').last().click();
      const confirmDialog = page.getByRole('dialog');
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole('button').last().click();

      await expect(sessionRow).toHaveCount(0);
      await expect(page.getByText('Deleted session media snapshot.', { exact: true })).toHaveCount(0);
      await expect(page.locator('img[alt="deleted-session-output.png"]')).toHaveCount(0);

      await app.evaluate(() => {
        const release = (globalThis as Record<string, unknown>).__clawxE2EReleaseLateHistory;
        if (typeof release === 'function') release();
      });
      await expect.poll(async () => await app.evaluate(() => (
        globalThis as Record<string, unknown>
      ).__clawxE2EPostDeleteTranscriptRead)).toBe(true);
      await page.evaluate(async () => await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
      }));
      await page.waitForTimeout(1_000);

      await expect(page.getByText('Deleted session media snapshot.', { exact: true })).toHaveCount(0);
      await expect(page.locator('img[alt="deleted-session-output.png"]')).toHaveCount(0);
      await expect(page.getByTestId('conversation-turn')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps a conversation visible when durable deletion fails', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const sessionKey = 'agent:main:delete-failure';

    try {
      await installIpcMocks(app, {
        gatewayStatus: {
          state: 'running',
          port: 18789,
          pid: 12345,
          gatewayReady: true,
          connectedAt: Date.now(),
        },
        gatewayRpc: {},
        hostApi: {
          [stableStringify(['/api/chat/sessions', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: { sessions: [{ key: sessionKey, displayName: 'delete-failure' }] },
              },
            },
          },
          [stableStringify(['/api/chat/history', 'POST'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: {
                  messages: [{
                    id: 'delete-failure-message',
                    role: 'assistant',
                    content: 'Keep this conversation after failed deletion.',
                    timestamp: 2_000,
                  }],
                  sessionInfo: { hasActiveRun: false },
                },
              },
            },
          },
          [stableStringify(['/api/sessions/delete', 'POST'])]: {
            ok: true,
            data: {
              status: 500,
              ok: false,
              json: { success: false, error: 'Simulated durable deletion failure' },
            },
          },
          [stableStringify(['/api/chat/outbox/session/cancel', 'POST'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, cancelled: 0 } },
          },
          [stableStringify(['/api/task-bridge/tasks?activeOnly=false&sessionKey=agent%3Amain%3Adelete-failure', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: { success: true, tasks: [] } },
          },
        },
      });

      let page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      page = await getStableWindow(app);

      for (const bucketKey of ['withinMonth', 'older']) {
        const toggle = page.getByTestId(`session-bucket-toggle-${bucketKey}`);
        if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
      }
      const sessionRow = page.getByTestId(`sidebar-session-${sessionKey}`);
      await expect(sessionRow).toBeVisible();
      await expect(page.getByText('Keep this conversation after failed deletion.', { exact: true })).toBeVisible();

      await sessionRow.hover();
      await sessionRow.locator('xpath=..').locator('button').last().click();
      const confirmDialog = page.getByRole('dialog');
      await expect(confirmDialog).toBeVisible();
      await confirmDialog.getByRole('button').last().click();

      await expect(sessionRow).toBeVisible();
      await expect(page.getByText('Keep this conversation after failed deletion.', { exact: true })).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('hard-deletes durable host tasks when the OpenClaw session index is already absent', async ({
    launchElectronApp,
    homeDir,
  }) => {
    const sessionKey = 'agent:main:main';
    const taskId = 'deleted-session-host-task';
    const stateDir = join(homeDir, '.openclaw');
    const sessionsDir = join(stateDir, 'agents', 'main', 'sessions');
    const taskDir = join(stateDir, 'uclaw-runtime', 'host-tasks', 'jobs', taskId);
    const sessionsJsonPath = join(sessionsDir, 'sessions.json');

    await mkdir(sessionsDir, { recursive: true });
    await mkdir(taskDir, { recursive: true });
    await writeFile(sessionsJsonPath, '{}\n', 'utf8');
    await writeFile(join(taskDir, 'task.json'), `${JSON.stringify({
      version: 3,
      taskId,
      sessionKey,
      runId: 'deleted-session-run',
      toolCallId: 'deleted-session-tool',
      idempotencyKey: 'deleted-session-idempotency',
      capability: 'local.video.render',
      title: 'Deleted session durable video task',
      input: {},
      acceptance: {
        source: 'host_capability',
        requiresArtifact: false,
        requiresVerification: false,
        requiredVerificationKinds: [],
      },
      completion: { mode: 'direct' },
      status: 'succeeded',
      createdAt: 1_000,
      updatedAt: 2_000,
      revision: 1,
      artifacts: [],
      verifications: [],
      completionAcks: [],
      completionDeliveries: [],
      lifecycle: { operations: [] },
    }, null, 2)}\n`, 'utf8');
    await writeFile(join(taskDir, 'journal.jsonl'), '{"version":3,"type":"task.created"}\n', 'utf8');

    const callHostApi = async (
      app: Awaited<ReturnType<typeof launchElectronApp>>,
      request: { path: string; method?: string; body?: string },
    ) => {
      const page = await getStableWindow(app);
      return await page.evaluate(async (hostApiRequest) => (
        await window.electron.ipcRenderer.invoke('hostapi:fetch', hostApiRequest)
      ), request) as {
        ok?: boolean;
        data?: { status?: number; ok?: boolean; json?: unknown };
      };
    };

    let app = await launchElectronApp({ skipSetup: true });
    try {
      const beforeDelete = await callHostApi(app, {
        path: `/api/task-bridge/tasks?activeOnly=false&sessionKey=${encodeURIComponent(sessionKey)}`,
      });
      expect(beforeDelete.data?.status).toBe(200);
      expect((beforeDelete.data?.json as { tasks?: unknown[] })?.tasks).toHaveLength(1);

      const deleteResponse = await callHostApi(app, {
        path: '/api/sessions/delete',
        method: 'POST',
        body: JSON.stringify({ sessionKey }),
      });
      expect(deleteResponse.data?.status).toBe(200);
      expect(deleteResponse.data?.json).toMatchObject({ success: true });

      const afterDelete = await callHostApi(app, {
        path: `/api/task-bridge/tasks?activeOnly=false&sessionKey=${encodeURIComponent(sessionKey)}`,
      });
      expect((afterDelete.data?.json as { tasks?: unknown[] })?.tasks).toHaveLength(0);
      await expect(access(taskDir)).rejects.toThrow();
      expect(JSON.parse(await readFile(sessionsJsonPath, 'utf8'))).not.toHaveProperty(sessionKey);

      await closeElectronApp(app);
      app = await launchElectronApp({ skipSetup: true });

      const afterRestart = await callHostApi(app, {
        path: `/api/task-bridge/tasks?activeOnly=false&sessionKey=${encodeURIComponent(sessionKey)}`,
      });
      expect((afterRestart.data?.json as { tasks?: unknown[] })?.tasks).toHaveLength(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
