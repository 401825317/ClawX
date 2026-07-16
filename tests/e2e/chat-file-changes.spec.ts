import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const history = [
  {
    role: 'user',
    id: 'user-1',
    content: [{ type: 'text', text: 'Patch the workspace file' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'assistant-tool-1',
    content: [{
      type: 'toolCall',
      id: 'edit-1',
      name: 'Edit',
      arguments: {
        file_path: '/workspace/demo.ts',
        old_string: 'const value = 1\n',
        new_string: 'const value = 2\n',
      },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'assistant-final-1',
    content: [{ type: 'text', text: 'Updated the file.' }],
    timestamp: Date.now(),
  },
];

const attachedFileHistory = [
  {
    role: 'user',
    id: 'user-attached-1',
    content: [{ type: 'text', text: '查看这个技能文件' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'assistant-attached-1',
    content: [{ type: 'text', text: '这是文件。' }],
    _attachedFiles: [
      {
        fileName: 'SKILL.md',
        mimeType: 'text/markdown',
        fileSize: 128,
        preview: null,
        filePath: '/workspace/skills/open-xueqiu/SKILL.md',
        source: 'tool-result',
      },
    ],
    timestamp: Date.now(),
  },
];

const htmlFileHistory = [
  {
    role: 'user',
    id: 'user-html-1',
    content: [{ type: 'text', text: '预览 HTML 页面' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'assistant-html-1',
    content: [{ type: 'text', text: '已生成 /workspace/demo.html' }],
    timestamp: Date.now(),
  },
];

const structuredToolResultHistory = [
  {
    role: 'user',
    id: 'user-structured-output-1',
    content: [{ type: 'text', text: '生成两个 Office 文件' }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    id: 'tool-result-direct-1',
    toolCallId: 'create-docx-1',
    toolName: 'create_docx_file',
    content: [{ type: 'text', text: '{"ok":true,"filePath":"C:\\\\workspace\\\\direct-output.docx"}' }],
    details: {
      ok: true,
      filePath: 'C:\\workspace\\direct-output.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 4096,
    },
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    id: 'tool-result-nested-1',
    toolCallId: 'create-xlsx-1',
    toolName: 'tool_call',
    content: [{ type: 'text', text: '{"ok":true,"filePath":"C:\\\\workspace\\\\nested-output.xlsx"}' }],
    details: {
      tool: { name: 'create_xlsx_file' },
      result: {
        details: {
          ok: true,
          filePath: 'C:\\workspace\\nested-output.xlsx',
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileSize: 8192,
        },
      },
    },
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'assistant-structured-output-1',
    content: [{ type: 'text', text: '文件已生成。' }],
    timestamp: Date.now(),
  },
];
test.describe('ClawX chat file changes', () => {
  test('renders direct and nested structured tool result files as attachment cards', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: structuredToolResultHistory },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: { messages: structuredToolResultHistory },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main', workspace: 'C:\\workspace' }],
              },
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

      await expect(page.getByTestId('main-layout')).toBeVisible();
      const fileCards = page.getByTestId('chat-attached-file');
      await expect(fileCards.filter({ hasText: 'direct-output.docx' })).toContainText('4.0 KB');
      await expect(fileCards.filter({ hasText: 'nested-output.xlsx' })).toContainText('8.0 KB');
      await expect(fileCards).toHaveCount(2);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('shows line stats on generated file cards', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
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
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
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

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await page.evaluate(() => {
        const root = document.documentElement;
        root.classList.remove('dark');
        root.classList.add('light');
      });
      await expect(page.getByTestId('artifact-panel')).toHaveCount(0);

      const fileCard = page.getByRole('button', { name: /demo\.ts/ }).first();
      await expect(fileCard).toBeVisible({ timeout: 30_000 });
      await expect(fileCard).toContainText('+1');
      await expect(fileCard).toContainText('-1');

      await fileCard.click();
      const sidePanel = page.getByTestId('artifact-panel');
      await expect(sidePanel).toBeVisible({ timeout: 30_000 });
      await expect(sidePanel.getByTestId('artifact-panel-tab-browser')).toBeVisible();
      await expect(fileCard).toContainText('demo.ts');

      const diffBackground = page.getByTestId('monaco-diff-viewer').locator('.monaco-editor-background').first();
      await expect(diffBackground).toBeVisible({ timeout: 30_000 });

      const colors = await diffBackground.evaluate((element) => {
        return {
          diffBackground: window.getComputedStyle(element).backgroundColor,
          appBackground: window.getComputedStyle(document.body).backgroundColor,
        };
      });

      expect(colors.diffBackground).toBe(colors.appBackground);
      expect(colors.diffBackground).not.toBe('rgb(255, 255, 255)');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('opens html files from chat as rendered previews', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: htmlFileHistory },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: { messages: htmlFileHistory },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main', workspace: '/workspace' }],
              },
            },
          },
        },
      });

      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        ipcMain.removeHandler('file:stat');
        ipcMain.handle('file:stat', async (_event: unknown, inputPath: string) => ({
          ok: inputPath === '/workspace/demo.html',
          size: 154,
          isFile: inputPath === '/workspace/demo.html',
          isDir: false,
          readOnly: true,
        }));
        ipcMain.removeHandler('file:readText');
        ipcMain.handle('file:readText', async (_event: unknown, inputPath: string) => {
          if (inputPath !== '/workspace/demo.html') return { ok: false, error: 'notFound' };
          return {
            ok: true,
            content: '<!doctype html><html><body><h1 id="title">HTML Rendered Preview</h1><script>document.body.dataset.htmlPreview = "ok";</script></body></html>',
            size: 154,
            mimeType: 'text/html',
            readOnly: true,
          };
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
      const htmlFileCard = page.locator('[title="Open file"]').filter({ hasText: 'demo.html' }).first();
      await expect(htmlFileCard).toBeVisible({ timeout: 30_000 });
      await htmlFileCard.click();

      const sidePanel = page.getByTestId('artifact-panel');
      const frame = sidePanel.getByTestId('html-preview-frame');
      await expect(frame).toBeVisible({ timeout: 30_000 });
      await expect(sidePanel.getByText('<!doctype html>')).toHaveCount(0);
      const htmlFrame = frame.contentFrame();
      await expect(htmlFrame.locator('#title')).toHaveText('HTML Rendered Preview');
      await expect(htmlFrame.locator('body')).toHaveAttribute('data-html-preview', 'ok');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps an attached file selected after switching through workspace', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: { messages: attachedFileHistory },
          },
          [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: { messages: attachedFileHistory },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main', workspace: '/workspace' }],
              },
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

      await expect(page.getByTestId('main-layout')).toBeVisible();
      const skillFileCard = page.locator('[title="Open file"]').filter({ hasText: 'SKILL.md' }).first();
      await expect(skillFileCard).toBeVisible({ timeout: 30_000 });
      await skillFileCard.click();

      const sidePanel = page.getByTestId('artifact-panel');
      await expect(sidePanel.getByRole('heading', { name: 'SKILL.md' })).toBeVisible({ timeout: 30_000 });

      await sidePanel.getByTestId('artifact-panel-tab-browser').click();
      await sidePanel.getByTestId('artifact-panel-tab-preview').click();
      await expect(sidePanel.getByRole('heading', { name: 'SKILL.md' })).toBeVisible();
      await expect(sidePanel.getByText('No file selected')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
