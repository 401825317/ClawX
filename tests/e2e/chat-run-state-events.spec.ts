import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import type { ElectronApplication } from '@playwright/test';

const MAIN_SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

async function installHistoryMocks(app: ElectronApplication, history: unknown[]): Promise<void> {
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
      },
      [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
        success: true,
        result: { messages: history },
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
          json: {
            success: true,
            result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
          },
        },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: { messages: history } },
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
    },
  });
}

test.describe('ClawX chat run state events', () => {
  test('keeps stop control active across non-terminal runtime events and clears it on run.ended', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: [] },
          },
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId: 'run-e2e' },
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
              json: {
                success: true,
                result: {
                  sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
                },
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
                result: { messages: [] },
              },
            },
          },
          [stableStringify(['/api/chat/send', 'POST'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: { runId: 'run-e2e' },
              },
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
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      const sendButton = page.getByTestId('chat-composer-send');
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('run long task');
      await sendButton.click();
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'tool.started',
            runId: 'run-e2e',
            sessionKey: 'agent:main:main',
            toolCallId: 'call-1',
            name: 'read',
            args: { filePath: '/tmp/demo.md' },
          });
        }
      });

      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'tool.completed',
            runId: 'run-e2e',
            sessionKey: 'agent:main:main',
            toolCallId: 'call-1',
            name: 'read',
            result: { summary: 'done' },
            isError: false,
          });
        }
      });

      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'tool.started',
            runId: 'run-e2e',
            sessionKey: 'agent:main:main',
            toolCallId: 'call-failed-exec',
            name: 'exec',
            args: { command: 'cat /tmp/missing-result.txt' },
          });
          win.webContents.send('chat:runtime-event', {
            type: 'tool.completed',
            runId: 'run-e2e',
            sessionKey: 'agent:main:main',
            toolCallId: 'call-failed-exec',
            name: 'exec',
            result: 'cat: /tmp/missing-result.txt: No such file or directory',
            isError: true,
          });
        }
      });

      await expect(page.getByTestId('chat-run-progress')).toBeVisible();
      await expect(page.getByTestId('chat-run-progress')).toContainText(/completed|完成/i);
      await expect(page.getByTestId('chat-run-progress')).not.toContainText(/failed|失败/i);
      await expect(page.getByText(/No such file or directory/i)).toHaveCount(0);
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'run.ended',
            runId: 'run-e2e',
            sessionKey: 'agent:main:main',
            status: 'completed',
            endedAt: Date.now(),
          });
        }
      });

      await installIpcMocks(app, {
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main', hasActiveRun: false }],
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/chat/sessions', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: {
                  sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main', hasActiveRun: false }],
                },
              },
            },
          },
        },
      });

      await expect(sendButton).toHaveAttribute('title', /Send|发送/);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps the session running after a final reply until OpenClaw reports it idle', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
      });
      await app.evaluate(async ({ app: _app }) => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        let hasActiveRun = false;
        const sessionResult = () => ({
          sessions: [{ key: 'agent:main:main', displayName: 'main', hasActiveRun }],
        });
        const response = (json: unknown) => ({
          ok: true,
          data: { status: 200, ok: true, json },
        });

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') return { success: true, result: sessionResult() };
          if (method === 'chat.history') return { success: true, result: { messages: [] } };
          if (method === 'chat.send') {
            hasActiveRun = true;
            return { success: true, result: { runId: 'run-authoritative-state' } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string }) => {
          switch (request.path) {
            case '/api/gateway/status':
              return response({ state: 'running', port: 18789, pid: 12345, gatewayReady: true });
            case '/api/chat/sessions':
              return response({ success: true, result: sessionResult() });
            case '/api/chat/history':
              return response({ success: true, result: { messages: [] } });
            case '/api/chat/send':
              hasActiveRun = true;
              return response({ success: true, result: { runId: 'run-authoritative-state' } });
            case '/api/agents':
              return response({ success: true, agents: [{ id: 'main', name: 'Main' }] });
            default:
              return response({});
          }
        });

        (globalThis as Record<string, unknown>).__setOpenClawSessionActive = (active: boolean) => {
          hasActiveRun = active;
        };
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      const sendButton = page.getByTestId('chat-composer-send');
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('wait for authoritative session state');
      await sendButton.click();
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await app.evaluate(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'final',
              runId: 'run-authoritative-state',
              sessionKey: 'agent:main:main',
              message: {
                id: 'final-before-idle',
                role: 'assistant',
                content: 'The final reply arrived before the session became idle.',
                timestamp: Date.now() / 1000,
              },
            },
          });
        }
      });

      await expect(page.getByText('The final reply arrived before the session became idle.')).toBeVisible();
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await app.evaluate(() => {
        const setActive = (globalThis as Record<string, unknown>).__setOpenClawSessionActive as
          | ((active: boolean) => void)
          | undefined;
        setActive?.(false);
      });

      await expect(sendButton).toHaveAttribute('title', /Send|发送/, { timeout: 10_000 });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps the session running after cancellation until OpenClaw reports it idle', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
      });
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        let hasActiveRun = false;
        const sessionResult = () => ({
          sessions: [{ key: 'agent:main:main', displayName: 'main', hasActiveRun }],
        });
        const response = (json: unknown) => ({
          ok: true,
          data: { status: 200, ok: true, json },
        });

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') return { success: true, result: sessionResult() };
          if (method === 'chat.history') return { success: true, result: { messages: [] } };
          if (method === 'chat.send') {
            hasActiveRun = true;
            return { success: true, result: { runId: 'run-cancellation-state' } };
          }
          if (method === 'chat.abort') return { success: true, result: {} };
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string }) => {
          switch (request.path) {
            case '/api/gateway/status':
              return response({ state: 'running', port: 18789, pid: 12345, gatewayReady: true });
            case '/api/chat/sessions':
              return response({ success: true, result: sessionResult() });
            case '/api/chat/history':
              return response({ success: true, result: { messages: [] } });
            case '/api/chat/send':
              hasActiveRun = true;
              return response({ success: true, result: { runId: 'run-cancellation-state' } });
            case '/api/chat/abort':
              return response({ success: true, result: {} });
            case '/api/agents':
              return response({ success: true, agents: [{ id: 'main', name: 'Main' }] });
            default:
              return response({});
          }
        });

        (globalThis as Record<string, unknown>).__setOpenClawCancellationSessionActive = (active: boolean) => {
          hasActiveRun = active;
        };
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      const sendButton = page.getByTestId('chat-composer-send');
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('cancel only when OpenClaw is idle');
      await sendButton.click();
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await sendButton.click();
      await page.waitForTimeout(500);
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await app.evaluate(() => {
        const setActive = (globalThis as Record<string, unknown>).__setOpenClawCancellationSessionActive as
          | ((active: boolean) => void)
          | undefined;
        setActive?.(false);
      });

      await expect(sendButton).toHaveAttribute('title', /Send|发送/, { timeout: 10_000 });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('replays compact tool-work transcript from history on reopen', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const historyTimestamp = Math.floor(Date.now() / 1000);
    const history = [
      {
        id: 'user-file-capabilities',
        role: 'user',
        content: [{ type: 'text', text: '你现在能做哪些文件类产物？' }],
        timestamp: historyTimestamp,
      },
      {
        id: 'assistant-history-read',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-read-capabilities',
          name: 'read',
          arguments: { path: '/tmp/capabilities.md' },
        }],
        timestamp: historyTimestamp + 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'call-read-capabilities',
        toolName: 'read',
        content: [{
          type: 'text',
          text: '- 文档\n- 表格\n- 演示文稿',
        }],
        details: {
          status: 'completed',
          aggregated: '- 文档\n- 表格\n- 演示文稿',
          path: '/tmp/capabilities.md',
        },
        isError: false,
        timestamp: historyTimestamp + 2,
      },
      {
        id: 'assistant-history-final',
        role: 'assistant',
        content: [{ type: 'text', text: '我现在可以生成文档、表格和演示文稿。' }],
        timestamp: historyTimestamp + 3,
      },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: history },
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
              json: {
                success: true,
                result: {
                  sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
                },
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
                result: { messages: history },
              },
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
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('chat-run-progress')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByText('我先查看相关内容。')).toBeVisible();
      await expect(page.getByText('/tmp/capabilities.md')).toBeVisible();
      await expect(page.getByText('我现在可以生成文档、表格和演示文稿。')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows a verified artifact after an earlier tool attempt failed', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const historyTimestamp = Math.floor(Date.now() / 1000);
    const history = [
      {
        id: 'user-ppt-retry',
        role: 'user',
        content: [{ type: 'text', text: '帮我做一个主题 PPT' }],
        timestamp: historyTimestamp,
      },
      {
        id: 'assistant-ppt-attempt-1',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'ppt-attempt-1',
          name: 'create_designed_pptx_file',
          arguments: { title: '深海探索' },
        }],
        timestamp: historyTimestamp + 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'ppt-attempt-1',
        toolName: 'create_designed_pptx_file',
        content: [{ type: 'text', text: 'slide 2 text elements overlap' }],
        details: { status: 'error', error: 'slide 2 text elements overlap' },
        isError: true,
        timestamp: historyTimestamp + 2,
      },
      {
        id: 'assistant-ppt-attempt-2',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'ppt-attempt-2',
          name: 'repair_designed_pptx_file',
          arguments: { repairToken: 'repair-token', baseRevision: 0, patches: [] },
        }],
        timestamp: historyTimestamp + 3,
      },
      {
        role: 'toolResult',
        toolCallId: 'ppt-attempt-2',
        toolName: 'repair_designed_pptx_file',
        content: [{ type: 'text', text: 'PPT created successfully' }],
        details: { status: 'completed', filePath: '/tmp/深海探索.pptx' },
        isError: false,
        timestamp: historyTimestamp + 4,
      },
      {
        id: 'assistant-ppt-final',
        role: 'assistant',
        content: [{ type: 'text', text: '已经做好，共 8 页并通过版式与内容质检。' }],
        _attachedFiles: [{
          fileName: '深海探索.pptx',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          fileSize: 11_595_364,
          preview: null,
          filePath: '/tmp/深海探索.pptx',
          source: 'tool-result',
        }],
        timestamp: historyTimestamp + 5,
      },
    ];

    try {
      await installHistoryMocks(app, history);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByText('已经做好，共 8 页并通过版式与内容质检。')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('深海探索.pptx')).toBeVisible();
      await expect(page.getByText(/任务需要补充处理/)).toHaveCount(0);
      await expect(page.getByText(/任务执行失败/)).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps an open historical tool run active on reopen', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const historyTimestamp = Math.floor(Date.now() / 1000);
    const history = [
      {
        id: 'user-open-history-run',
        role: 'user',
        content: [{ type: 'text', text: '你现在能做哪些文件类产物？' }],
        timestamp: historyTimestamp,
      },
      {
        id: 'assistant-open-history-tool',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call-open-history-read',
          name: 'read',
          arguments: { path: '/tmp/capabilities.md' },
        }],
        timestamp: historyTimestamp + 1,
      },
      {
        role: 'toolResult',
        toolCallId: 'call-open-history-read',
        toolName: 'read',
        content: [{
          type: 'text',
          text: '- 文档\n- 表格\n- 演示文稿',
        }],
        details: {
          status: 'completed',
          aggregated: '- 文档\n- 表格\n- 演示文稿',
          path: '/tmp/capabilities.md',
        },
        isError: false,
        timestamp: historyTimestamp + 2,
      },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: history },
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
              json: {
                success: true,
                result: {
                  sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
                },
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
                result: { messages: history },
              },
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
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('chat-run-progress')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('我先查看相关内容。')).toBeVisible();
      await expect(page.getByText('/tmp/capabilities.md')).toBeVisible();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows clear image preview states for generated media while hydration retries', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const gatewayUrl = '/api/chat/media/outgoing/agent%3Amain%3Aimage-preview/image-1/full';
    const history = [
      {
        role: 'assistant',
        id: 'generated-image',
        timestamp: Date.now() / 1000,
        content: [{
          type: 'image',
          url: gatewayUrl,
          mimeType: 'image/png',
          alt: 'generated.png',
        }],
      },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: history },
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
            data: {
              status: 200,
              ok: true,
              json: { [gatewayUrl]: { preview: null, fileSize: 0 } },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('image-preview-unavailable')).toBeVisible({ timeout: 10_000 });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('hydrates Windows MEDIA SVG artifacts without leaking the marker text', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const filePath = String.raw`C:\Users\Administrator\.openclaw\workspace\japan-kansai-4d3n-plan.svg`;
    const svgPreview = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>').toString('base64')}`;
    const history = [
      {
        role: 'assistant',
        id: 'windows-svg-artifact',
        timestamp: Date.now() / 1000,
        content: String.raw`SVG file is ready:

MEDIA:C:\Users\Administrator\.openclaw\workspace\japan-kansai-4d3n-plan.svg`,
      },
    ];

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: history },
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
            data: {
              status: 200,
              ok: true,
              json: { [filePath]: { preview: svgPreview, fileSize: 73 } },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByText('SVG file is ready:')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('MEDIA:C:')).toHaveCount(0);
      await expect(page.locator('img[alt="japan-kansai-4d3n-plan.svg"]')).toBeVisible();
    } finally {
      await closeElectronApp(app);
    }
  });
});
