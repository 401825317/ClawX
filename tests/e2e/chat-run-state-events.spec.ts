import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import type { ElectronApplication } from '@playwright/test';
import { normalizeGatewayChatRuntimeEvents } from '../../electron/gateway/chat-runtime-events';

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
      [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
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
  test('does not replay terminal history into the live stream and still recovers on manual refresh', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
      });
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        let history: unknown[] = [];
        let historyRequestCount = 0;
        const sessions = { sessions: [{ key: 'agent:main:main', displayName: 'main' }] };
        const response = (json: unknown) => ({ ok: true, data: { status: 200, ok: true, json } });

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string) => {
          if (method === 'sessions.list') return { success: true, result: sessions };
          if (method === 'chat.history') {
            historyRequestCount += 1;
            return { success: true, result: { messages: history } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string }) => {
          switch (request.path) {
            case '/api/gateway/status': return response({ state: 'running', port: 18789, pid: 12345, gatewayReady: true });
            case '/api/chat/sessions': return response({ success: true, result: sessions });
            case '/api/chat/history':
              historyRequestCount += 1;
              return response({ success: true, result: { messages: history } });
            case '/api/agents': return response({ success: true, agents: [{ id: 'main', name: 'Main' }] });
            default: return response({});
          }
        });

        (globalThis as Record<string, unknown>).__setTerminalHistory = (nextHistory: unknown[]) => {
          history = nextHistory;
        };
        (globalThis as Record<string, unknown>).__getTerminalHistoryRequestCount = () => historyRequestCount;
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      const readHistoryRequestCount = async () => await app.evaluate(() => {
        const getCount = (globalThis as Record<string, unknown>).__getTerminalHistoryRequestCount as
          | (() => number)
          | undefined;
        return getCount?.() ?? 0;
      });
      await expect.poll(readHistoryRequestCount).toBeGreaterThan(0);
      await page.waitForTimeout(300);
      const historyRequestsBeforeTerminal = await readHistoryRequestCount();

      await app.evaluate(({ BrowserWindow }) => {
        const setHistory = (globalThis as Record<string, unknown>).__setTerminalHistory as
          | ((nextHistory: unknown[]) => void)
          | undefined;
        setHistory?.([{
          id: 'final-video-timeout',
          role: 'assistant',
          content: '本次视频生成失败：生成服务处理超时，未产生可交付的视频文件。',
          timestamp: Date.now() / 1000,
        }]);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'run.ended',
            runId: 'run-final-persisted-only-in-history',
            sessionKey: 'agent:main:main',
            status: 'error',
            endedAt: Date.now(),
          });
        }
      });

      await page.waitForTimeout(1_000);
      const historyRequestsAfterTerminal = await readHistoryRequestCount();
      expect(historyRequestsAfterTerminal).toBe(historyRequestsBeforeTerminal);
      await expect(page.getByText('本次视频生成失败：生成服务处理超时，未产生可交付的视频文件。')).toHaveCount(0, { timeout: 1_000 });
      await page.getByRole('button', { name: /Refresh|刷新/u }).click();
      await expect(page.getByText('本次视频生成失败：生成服务处理超时，未产生可交付的视频文件。')).toBeVisible({ timeout: 10_000 });
    } finally {
      await closeElectronApp(app);
    }
  });

  test('streams assistant text in place and folds a late tool-message echo without duplication', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const runId = 'run-stable-assistant-stream';
    const toolCallId = 'tool-stable-assistant-stream';

    try {
      await installHistoryMocks(app, [{
        id: 'stable-assistant-stream-user',
        role: 'user',
        content: 'Inspect the file and summarize it.',
        timestamp: Date.now() / 1000,
      }]);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByText('Inspect the file and summarize it.', { exact: true })).toBeVisible({ timeout: 30_000 });

      const startedAt = Date.now();
      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'run.started',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 1,
            ts: input.startedAt,
          });
          win.webContents.send('chat:runtime-event', {
            type: 'assistant.delta',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 2,
            ts: input.startedAt + 1,
            text: 'I will inspect the file first.',
            replace: true,
          });
        }
      }, { runId, startedAt });

      const preamble = page.getByTestId('timeline-commentary').filter({ hasText: 'I will inspect the file first.' });
      await expect(preamble).toHaveCount(1);
      const preambleRow = preamble.locator('xpath=ancestor::*[@data-item-id][1]');
      const preambleItemId = await preambleRow.getAttribute('data-item-id');
      expect(preambleItemId).toBeTruthy();

      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'tool.started',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 3,
            ts: input.startedAt + 2,
            toolCallId: input.toolCallId,
            name: 'read_file',
            args: { path: '/tmp/example.md' },
          });
          win.webContents.send('chat:runtime-event', {
            type: 'tool.completed',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 4,
            ts: input.startedAt + 3,
            toolCallId: input.toolCallId,
            name: 'read_file',
            result: 'ok',
          });
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'final',
              runId: input.runId,
              sessionKey: 'agent:main:main',
              seq: 5,
              message: {
                role: 'assistant',
                timestamp: (input.startedAt + 4) / 1000,
                content: [{
                  type: 'text',
                  text: 'I will inspect the file first.',
                }, {
                  type: 'toolCall',
                  id: input.toolCallId,
                  name: 'read_file',
                  arguments: { path: '/tmp/example.md' },
                }],
              },
            },
          });
        }
      }, { runId, toolCallId, startedAt });

      await expect(preamble).toHaveCount(1);
      await expect(preambleRow).toHaveAttribute('data-item-id', preambleItemId!);
      const toolGroup = page.getByTestId('timeline-tool-group');
      await expect(toolGroup).toHaveCount(1);
      const [preambleBox, toolBox] = await Promise.all([preamble.boundingBox(), toolGroup.boundingBox()]);
      expect(preambleBox).not.toBeNull();
      expect(toolBox).not.toBeNull();
      expect(preambleBox!.y).toBeLessThan(toolBox!.y);

      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'assistant.delta',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 6,
            ts: input.startedAt + 5,
            text: 'The file is valid',
            replace: true,
            phase: 'final_answer',
          });
        }
      }, { runId, startedAt });
      const streamingFinal = page.getByTestId('timeline-commentary').filter({ hasText: 'The file is valid' });
      await expect(streamingFinal).toHaveCount(1);
      const streamingFinalRow = streamingFinal.locator('xpath=ancestor::*[@data-item-id][1]');
      const streamingFinalItemId = await streamingFinalRow.getAttribute('data-item-id');
      expect(streamingFinalItemId).toBeTruthy();

      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('chat:runtime-event', {
            type: 'assistant.delta',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 7,
            ts: input.startedAt + 6,
            text: 'The file is valid and ready.',
            replace: true,
            phase: 'final_answer',
          });
        }
      }, { runId, startedAt });
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'The file is valid and ready.' })).toHaveCount(1);
      await expect(streamingFinalRow).toHaveAttribute('data-item-id', streamingFinalItemId!);

      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'final',
              runId: input.runId,
              sessionKey: 'agent:main:main',
              seq: 8,
              message: {
                role: 'assistant',
                timestamp: (input.startedAt + 7) / 1000,
                content: 'The file is valid and ready.',
              },
            },
          });
          win.webContents.send('chat:runtime-event', {
            type: 'run.ended',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 9,
            ts: input.startedAt + 8,
            status: 'completed',
          });
        }
      }, { runId, startedAt });

      await expect(page.getByText('The file is valid and ready.', { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'The file is valid and ready.' })).toHaveCount(0);
      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(1);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders native OpenClaw preamble and final frames incrementally around the tool boundary', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const runId = 'run-native-openclaw-preamble-stream';
    const itemId = 'item-native-openclaw-preamble-stream';
    const toolCallId = 'tool-native-openclaw-preamble-stream';
    const preambleStart = 'I will inspect';
    const preamble = 'I will inspect the session first.';
    const finalStart = 'The tool finished';
    const finalAnswer = 'The tool finished and the result is valid.';
    const foldedFinal = `${preamble}${finalAnswer}`;
    const startedAt = Date.now();
    const normalize = (seq: number, stream: string, data: Record<string, unknown>) => (
      normalizeGatewayChatRuntimeEvents({
        runId,
        sessionKey: MAIN_SESSION_KEY,
        seq,
        ts: startedAt + seq,
        stream,
        data,
      })
    );
    const sendRuntime = async (events: ReturnType<typeof normalizeGatewayChatRuntimeEvents>) => {
      await app.evaluate(({ BrowserWindow }, runtimeEvents) => {
        for (const win of BrowserWindow.getAllWindows()) {
          runtimeEvents.forEach((event) => win.webContents.send('chat:runtime-event', event));
        }
      }, events);
    };
    try {
      await installHistoryMocks(app, [{
        id: 'native-openclaw-preamble-stream-user',
        role: 'user',
        content: 'Inspect the session and report back.',
        timestamp: startedAt / 1_000,
      }]);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByText('Inspect the session and report back.', { exact: true })).toBeVisible({ timeout: 30_000 });

      await sendRuntime(normalize(1, 'lifecycle', { phase: 'start' }));
      await sendRuntime(normalize(2, 'item', {
        itemId,
        kind: 'preamble',
        title: 'Preamble',
        phase: 'update',
        progressText: preambleStart,
        source: 'codex-app-server',
      }));
      const preambleBlock = page.getByTestId('timeline-commentary').filter({ hasText: preambleStart });
      await expect(preambleBlock).toHaveCount(1);
      const preambleRow = preambleBlock.locator('xpath=ancestor::*[@data-item-id][1]');
      const preambleTimelineItemId = await preambleRow.getAttribute('data-item-id');
      expect(preambleTimelineItemId).toBeTruthy();

      await sendRuntime(normalize(3, 'item', {
        itemId,
        kind: 'preamble',
        title: 'Preamble',
        phase: 'update',
        progressText: preamble,
        source: 'codex-app-server',
      }));
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: preamble })).toHaveCount(1);
      await expect(preambleRow).toHaveAttribute('data-item-id', preambleTimelineItemId!);

      await sendRuntime(normalize(4, 'tool', {
        phase: 'start',
        toolCallId,
        name: 'tool_search',
        args: { query: 'status' },
      }));
      await sendRuntime(normalize(5, 'tool', {
        phase: 'result',
        toolCallId,
        name: 'tool_search',
        result: [],
      }));
      const toolGroup = page.getByTestId('timeline-tool-group');
      await expect(toolGroup).toHaveCount(1);

      await sendRuntime(normalize(6, 'assistant', { text: finalStart, delta: finalStart }));
      const streamingFinal = page.getByTestId('timeline-commentary').filter({ hasText: finalStart });
      await expect(streamingFinal).toHaveCount(1);
      const streamingFinalRow = streamingFinal.locator('xpath=ancestor::*[@data-item-id][1]');
      const streamingFinalItemId = await streamingFinalRow.getAttribute('data-item-id');
      expect(streamingFinalItemId).toBeTruthy();

      await sendRuntime(normalize(7, 'assistant', {
        text: finalAnswer,
        delta: ' and the result is valid.',
      }));
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: finalAnswer })).toHaveCount(1);
      await expect(streamingFinalRow).toHaveAttribute('data-item-id', streamingFinalItemId!);

      await sendRuntime(normalize(8, 'assistant', { text: foldedFinal }));
      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'final',
              runId: input.runId,
              sessionKey: 'agent:main:main',
              seq: 9,
              message: {
                role: 'assistant',
                timestamp: (input.startedAt + 9) / 1_000,
                content: [{ type: 'text', text: input.foldedFinal }],
              },
            },
          });
        }
      }, { runId, startedAt, foldedFinal });

      const finalBlock = page.getByText(finalAnswer, { exact: true });
      await expect(finalBlock).toHaveCount(1);
      await expect(page.getByText(foldedFinal, { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: preamble })).toHaveCount(1);
      await expect(preambleRow).toHaveAttribute('data-item-id', preambleTimelineItemId!);
      const finalRow = finalBlock.locator('xpath=ancestor::*[@data-item-id][1]');
      const [preambleBox, toolBox, finalBox] = await Promise.all([
        preambleBlock.boundingBox(),
        toolGroup.boundingBox(),
        finalRow.boundingBox(),
      ]);
      expect(preambleBox).not.toBeNull();
      expect(toolBox).not.toBeNull();
      expect(finalBox).not.toBeNull();
      expect(preambleBox!.y).toBeLessThan(toolBox!.y);
      expect(toolBox!.y).toBeLessThan(finalBox!.y);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('preserves multiple native commentary items around tools when chat final aggregates the whole run', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const runId = 'run-native-openclaw-multi-commentary-stream';
    const startedAt = Date.now();
    const commentary = [
      {
        itemId: 'item-native-commentary-1',
        partial: 'First commentary starts',
        text: 'First commentary starts and completes before the first tool.',
      },
      {
        itemId: 'item-native-commentary-2',
        partial: 'Second commentary starts',
        text: 'Second commentary starts and completes before the second tool.',
      },
      {
        itemId: 'item-native-commentary-3',
        partial: 'Third commentary starts',
        text: 'Third commentary starts and completes before the third tool.',
      },
    ];
    const finalPartial = 'The final answer starts';
    const finalAnswer = 'The final answer starts and completes after all three tools.';
    const aggregatedFinal = `${commentary.map((item) => item.text).join('')}${finalAnswer}`;
    const userMessage = {
      id: 'native-openclaw-multi-commentary-user',
      role: 'user',
      content: 'Run three searches and report the result.',
      timestamp: startedAt / 1_000,
    };
    const persistedHistory = [
      userMessage,
      ...commentary.flatMap((item, index) => {
        const toolCallId = `tool-native-commentary-${index + 1}`;
        return [{
          id: item.itemId,
          role: 'assistant',
          timestamp: (startedAt + 2 + (index * 4)) / 1_000,
          content: [{ type: 'text', text: item.text }, {
            type: 'toolCall',
            id: toolCallId,
            name: 'tool_search',
            arguments: { query: `search-${index + 1}` },
          }],
        }, {
          id: `tool-result-native-commentary-${index + 1}`,
          role: 'toolresult',
          toolCallId,
          toolName: 'tool_search',
          timestamp: (startedAt + 5 + (index * 4)) / 1_000,
          content: [{ id: `result-${index + 1}` }],
        }];
      }),
      {
        id: 'native-openclaw-multi-commentary-final',
        role: 'assistant',
        timestamp: (startedAt + 18) / 1_000,
        content: [{ type: 'text', text: finalAnswer }],
      },
    ];
    const normalize = (seq: number, stream: string, data: Record<string, unknown>) => (
      normalizeGatewayChatRuntimeEvents({
        runId,
        sessionKey: MAIN_SESSION_KEY,
        seq,
        ts: startedAt + seq,
        stream,
        data,
      })
    );
    const sendRuntime = async (events: ReturnType<typeof normalizeGatewayChatRuntimeEvents>) => {
      await app.evaluate(({ BrowserWindow }, runtimeEvents) => {
        for (const win of BrowserWindow.getAllWindows()) {
          runtimeEvents.forEach((event) => win.webContents.send('chat:runtime-event', event));
        }
      }, events);
    };
    const sendChatDelta = async (seq: number, text: string, deltaText: string) => {
      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'delta',
              runId: input.runId,
              sessionKey: 'agent:main:main',
              seq: input.seq,
              deltaText: input.deltaText,
              message: {
                role: 'assistant',
                timestamp: input.timestamp,
                content: [{ type: 'text', text: input.text }],
              },
            },
          });
        }
      }, {
        runId,
        seq,
        text,
        deltaText,
        timestamp: startedAt + seq,
      });
    };

    try {
      await installHistoryMocks(app, [userMessage]);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }
      await expect(page.getByText('Run three searches and report the result.', { exact: true })).toBeVisible({ timeout: 30_000 });

      await sendRuntime(normalize(1, 'lifecycle', { phase: 'start' }));
      const commentaryRows: Array<{ locator: ReturnType<typeof page.getByTestId>; itemId: string }> = [];
      let accumulatedAssistantText = '';
      for (let index = 0; index < commentary.length; index += 1) {
        const item = commentary[index]!;
        const toolCallId = `tool-native-commentary-${index + 1}`;
        const baseSeq = 2 + (index * 4);
        await sendRuntime(normalize(baseSeq, 'item', {
          itemId: item.itemId,
          kind: 'preamble',
          title: 'Preamble',
          phase: 'update',
          progressText: item.partial,
          source: 'codex-app-server',
        }));
        await sendChatDelta(baseSeq, `${accumulatedAssistantText}${item.partial}`, item.partial);
        const block = page.getByTestId('timeline-commentary').filter({ hasText: item.partial });
        await expect(block).toHaveCount(1);
        await expect(block).toHaveText(item.partial);
        const row = block.locator('xpath=ancestor::*[@data-item-id][1]');
        const timelineItemId = await row.getAttribute('data-item-id');
        expect(timelineItemId).toBeTruthy();

        await sendRuntime(normalize(baseSeq + 1, 'item', {
          itemId: item.itemId,
          kind: 'preamble',
          title: 'Preamble',
          phase: 'update',
          progressText: item.text,
          source: 'codex-app-server',
        }));
        await sendChatDelta(baseSeq + 1, `${accumulatedAssistantText}${item.text}`, item.text.slice(item.partial.length));
        await expect(page.getByTestId('timeline-commentary').filter({ hasText: item.text })).toHaveCount(1);
        await expect(row.getByTestId('timeline-commentary')).toHaveText(item.text);
        await expect(row).toHaveAttribute('data-item-id', timelineItemId!);
        commentaryRows.push({ locator: row, itemId: timelineItemId! });
        accumulatedAssistantText += item.text;

        await sendRuntime(normalize(baseSeq + 2, 'tool', {
          phase: 'start',
          toolCallId,
          name: 'tool_search',
          args: { query: `search-${index + 1}` },
        }));
        await sendRuntime(normalize(baseSeq + 3, 'tool', {
          phase: 'result',
          toolCallId,
          name: 'tool_search',
          result: [{ id: `result-${index + 1}` }],
        }));
        await expect(page.getByTestId('timeline-tool-group')).toHaveCount(index + 1);
      }

      const finalStreamSamples = [
        'The final',
        finalPartial,
        'The final answer starts and completes',
        finalAnswer,
      ];
      let previousFinalText = '';
      let streamingFinalItemId: string | null = null;
      const observedFinalTexts: string[] = [];
      for (let index = 0; index < finalStreamSamples.length; index += 1) {
        const text = finalStreamSamples[index]!;
        const seq = 14 + index;
        const delta = text.slice(previousFinalText.length);
        await sendRuntime(normalize(seq, 'assistant', { text, delta }));
        await sendChatDelta(seq, `${accumulatedAssistantText}${text}`, delta);
        await page.waitForTimeout(40);
        const currentFinal = page.getByTestId('timeline-commentary').filter({ hasText: text });
        await expect(currentFinal).toHaveCount(1);
        await expect(currentFinal).toHaveText(text);
        const currentFinalRow = currentFinal.locator('xpath=ancestor::*[@data-item-id][1]');
        const currentItemId = await currentFinalRow.getAttribute('data-item-id');
        expect(currentItemId).toBeTruthy();
        if (streamingFinalItemId == null) streamingFinalItemId = currentItemId;
        else expect(currentItemId).toBe(streamingFinalItemId);
        observedFinalTexts.push((await currentFinal.textContent()) ?? '');
        previousFinalText = text;
      }
      expect(observedFinalTexts).toEqual(finalStreamSamples);
      const streamingFinal = page.getByTestId('timeline-commentary').filter({ hasText: finalAnswer });
      await expect(streamingFinal).toHaveCount(1);
      await expect(streamingFinal).toHaveText(finalAnswer);
      const streamingFinalRow = streamingFinal.locator('xpath=ancestor::*[@data-item-id][1]');
      await expect(streamingFinalRow).toHaveAttribute('data-item-id', streamingFinalItemId!);

      await app.evaluate(({ BrowserWindow }, input) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'final',
              runId: input.runId,
              sessionKey: 'agent:main:main',
              seq: 18,
              message: {
                role: 'assistant',
                timestamp: input.startedAt + 18,
                content: [{ type: 'text', text: input.aggregatedFinal }],
              },
            },
          });
          win.webContents.send('chat:runtime-event', {
            type: 'run.ended',
            producer: 'openclaw',
            runId: input.runId,
            sessionKey: 'agent:main:main',
            seq: 19,
            ts: input.startedAt + 19,
            status: 'completed',
          });
        }
      }, { runId, startedAt, aggregatedFinal });

      await expect(page.getByText(aggregatedFinal, { exact: true })).toHaveCount(0);
      await expect(page.getByText(finalAnswer, { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('timeline-commentary')).toHaveCount(3);
      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(3);
      for (const item of commentary) {
        await expect(page.getByTestId('timeline-commentary').filter({ hasText: item.text })).toHaveCount(1);
      }

      const timelineItemOrder = async () => page.locator('[data-timeline-row-kind="item"]')
        .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item-id')));
      const liveItemOrder = await timelineItemOrder();
      expect(liveItemOrder).toHaveLength(8);
      await installHistoryMocks(app, persistedHistory);
      await page.getByRole('button', { name: /Refresh|刷新/u }).click();
      await expect.poll(timelineItemOrder).toEqual(liveItemOrder);
      await expect(page.getByText(finalAnswer, { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('timeline-commentary')).toHaveCount(3);
      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(3);

      const toolGroups = page.getByTestId('timeline-tool-group');
      const finalRow = page.getByText(finalAnswer, { exact: true }).locator('xpath=ancestor::*[@data-item-id][1]');
      const rowBoxes = await Promise.all([
        commentaryRows[0]!.locator.boundingBox(),
        toolGroups.nth(0).boundingBox(),
        commentaryRows[1]!.locator.boundingBox(),
        toolGroups.nth(1).boundingBox(),
        commentaryRows[2]!.locator.boundingBox(),
        toolGroups.nth(2).boundingBox(),
        finalRow.boundingBox(),
      ]);
      rowBoxes.forEach((box) => expect(box).not.toBeNull());
      for (let index = 1; index < rowBoxes.length; index += 1) {
        expect(rowBoxes[index - 1]!.y).toBeLessThan(rowBoxes[index]!.y);
      }
    } finally {
      await closeElectronApp(app);
    }
  });

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
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
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

      const turn = page.getByTestId('conversation-turn').filter({ hasText: 'run long task' });
      const turnId = await turn.getAttribute('data-turn-id');
      expect(turnId).toBeTruthy();
      await expect(turn).toHaveAttribute('data-turn-status', 'running');
      await expect(page.getByTestId('timeline-turn-status')).toBeVisible();
      const toolGroups = page.getByTestId('timeline-tool-group');
      await expect(toolGroups).toHaveCount(1);
      await expect(toolGroups.nth(0)).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await expect(page.getByText(/No such file or directory/i)).toHaveCount(0);
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      await page.getByTestId('timeline-execution-details').click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'read' })).toBeVisible();
      const failedExec = page.getByTestId('chat-execution-step').filter({ hasText: 'exec' });
      await expect(failedExec).toBeVisible();
      await failedExec.locator('button').click();
      await expect(failedExec).toContainText('No such file or directory');
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);

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

      await expect(page.locator(`[data-turn-id="${turnId}"][data-timeline-row-kind="status"]`)).toHaveCount(0);

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

  test('dedupes sanitized nested tool progress and hides internal plan updates', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const runId = 'run-sanitized-nested-progress';
    const parentToolCallId = 'call-inspect-workspace|fc_4f13f53d';
    const nestedToolCallId = `tool_search_code:${parentToolCallId.replaceAll('|', '_')}:exec:1`;

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
            success: true,
            result: { messages: [] },
          },
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId },
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
              json: { success: true, result: { messages: [] } },
            },
          },
          [stableStringify(['/api/chat/send', 'POST'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, result: { runId } },
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
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('检查工作区并继续生成应用');
      await page.getByTestId('chat-composer-send').click();

      await app.evaluate(({ BrowserWindow }, payload) => {
        const now = Date.now();
        const events = [{
          type: 'run.started',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          startedAt: now,
          ts: now,
        }, {
          type: 'tool.started',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: 'call-update-plan',
          name: 'update_plan',
          args: {
            plan: [
              { step: 'Inspect the workspace', status: 'in_progress' },
              { step: 'Build the application', status: 'pending' },
            ],
          },
          ts: now + 1,
        }, {
          type: 'tool.completed',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: 'call-update-plan',
          name: 'update_plan',
          result: { message: 'Plan updated' },
          ts: now + 2,
        }, {
          type: 'tool.started',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: payload.parentToolCallId,
          name: 'tool_call',
          args: { id: 'exec', args: { command: 'pwd' } },
          ts: now + 3,
        }, {
          type: 'tool.started',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: payload.nestedToolCallId,
          name: 'exec',
          args: { command: 'pwd' },
          ts: now + 4,
        }, {
          type: 'tool.completed',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: payload.nestedToolCallId,
          name: 'exec',
          result: { stdout: '/tmp/uclaw-workspace', exitCode: 0 },
          isError: false,
          ts: now + 5,
        }, {
          type: 'tool.completed',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: payload.parentToolCallId,
          name: 'tool_call',
          result: {
            tool: { name: 'exec', label: 'Command' },
            result: { details: { status: 'completed', exitCode: 0 } },
          },
          isError: false,
          ts: now + 6,
        }, {
          type: 'tool.started',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: 'call-check-package',
          name: 'exec',
          args: { command: 'node --check package.json' },
          ts: now + 7,
        }, {
          type: 'tool.completed',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: 'call-check-package',
          name: 'exec',
          result: { stdout: '', exitCode: 0 },
          isError: false,
          ts: now + 8,
        }, {
          type: 'tool.started',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: 'call-list-files',
          name: 'exec',
          args: { command: 'find . -maxdepth 1 -type f' },
          ts: now + 9,
        }, {
          type: 'tool.completed',
          runId: payload.runId,
          sessionKey: 'agent:main:main',
          toolCallId: 'call-list-files',
          name: 'exec',
          result: { stdout: './package.json', exitCode: 0 },
          isError: false,
          ts: now + 10,
        }];
        for (const win of BrowserWindow.getAllWindows()) {
          for (const event of events) win.webContents.send('chat:runtime-event', event);
        }
      }, { runId, parentToolCallId, nestedToolCallId });

      const toolGroup = page.getByTestId('timeline-tool-group');
      await expect(toolGroup).toHaveCount(1);
      await expect(toolGroup).toContainText(/command|命令/u);
      await toolGroup.getByTestId('timeline-tool-group-toggle').click();
      const toolDetails = toolGroup.getByTestId('timeline-tool-details');
      await expect(toolDetails).toBeVisible();
      await expect(toolDetails.locator(':scope > div')).toHaveCount(3);
      await expect(page.getByText(/Update Plan|update plan/u)).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByTestId('chat-execution-step')).toHaveCount(3);
      await expect(dialog).not.toContainText(/Update Plan|update plan/u);
      await expect(page.getByTestId('chat-typing-indicator')).toHaveCount(0);
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

  test('does not restore a stale run after backend idle settles while the session is offscreen', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const otherSessionKey = 'agent:main:offscreen-idle-control';

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 32345, gatewayReady: true },
      });
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        let mainActive = false;
        let mainIdleObserved = false;
        let mainHistory: unknown[] = [];
        let mainRequestIdempotencyKey: string | undefined;
        const otherHistory = [
          {
            id: 'user-offscreen-control',
            role: 'user',
            content: '切换到这个会话。',
            timestamp: Math.floor(Date.now() / 1000) - 30,
          },
          {
            id: 'assistant-offscreen-control',
            role: 'assistant',
            content: '这个会话处于空闲状态。',
            timestamp: Math.floor(Date.now() / 1000) - 29,
          },
        ];
        const sessionResult = () => ({
          sessions: [
            { key: 'agent:main:main', displayName: 'Main', hasActiveRun: mainActive, updatedAt: Date.now() },
            {
              key: 'agent:main:offscreen-idle-control',
              displayName: 'Idle control',
              hasActiveRun: false,
              updatedAt: Date.now() - 1_000,
            },
          ],
        });
        const historyFor = (sessionKey: string | undefined) => (
          sessionKey === 'agent:main:main' ? mainHistory : sessionKey === 'agent:main:offscreen-idle-control' ? otherHistory : []
        );
        const response = (json: unknown) => ({
          ok: true,
          data: { status: 200, ok: true, json },
        });

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (
          _event: unknown,
          method: string,
          params: { sessionKey?: string; idempotencyKey?: string } = {},
        ) => {
          if (method === 'sessions.list') {
            if (!mainActive) mainIdleObserved = true;
            return { success: true, result: sessionResult() };
          }
          if (method === 'chat.history') {
            return {
              success: true,
              result: {
                messages: historyFor(params.sessionKey),
                sessionInfo: { hasActiveRun: mainActive, status: mainActive ? 'running' : 'done' },
                ...(mainActive && params.sessionKey === 'agent:main:main'
                  ? { inFlightRun: { runId: 'run-offscreen-idle', text: '' } }
                  : {}),
              },
            };
          }
          if (method === 'chat.send') {
            mainActive = true;
            mainRequestIdempotencyKey = params.idempotencyKey;
            return { success: true, result: { runId: 'run-offscreen-idle' } };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; body?: string }) => {
          if (request.path === '/api/gateway/status') {
            return response({ state: 'running', port: 18789, pid: 32345, gatewayReady: true });
          }
          if (request.path === '/api/chat/sessions') {
            if (!mainActive) mainIdleObserved = true;
            return response({ success: true, result: sessionResult() });
          }
          if (request.path === '/api/chat/history') {
            const body = request.body ? JSON.parse(request.body) as { sessionKey?: string } : {};
            return response({
              success: true,
              result: {
                messages: historyFor(body.sessionKey),
                sessionInfo: { hasActiveRun: mainActive, status: mainActive ? 'running' : 'done' },
                ...(mainActive && body.sessionKey === 'agent:main:main'
                  ? { inFlightRun: { runId: 'run-offscreen-idle', text: '' } }
                  : {}),
              },
            });
          }
          if (request.path === '/api/chat/send') {
            mainActive = true;
            const body = request.body
              ? JSON.parse(request.body) as { idempotencyKey?: string }
              : {};
            mainRequestIdempotencyKey = body.idempotencyKey;
            return response({ success: true, result: { runId: 'run-offscreen-idle' } });
          }
          if (request.path?.startsWith('/api/task-bridge/tasks')) {
            return response({ success: true, tasks: [] });
          }
          if (request.path === '/api/agents') {
            return response({ success: true, agents: [{ id: 'main', name: 'Main' }] });
          }
          return response({});
        });

        (globalThis as Record<string, unknown>).__persistMainOffscreenFinal = (history: unknown[]) => {
          mainHistory = history;
        };
        (globalThis as Record<string, unknown>).__setMainOffscreenIdle = () => {
          mainActive = false;
          mainIdleObserved = false;
        };
        (globalThis as Record<string, unknown>).__mainOffscreenIdleObserved = () => mainIdleObserved;
        (globalThis as Record<string, unknown>).__mainRequestIdempotencyKey = () => mainRequestIdempotencyKey;
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      const sendButton = page.getByTestId('chat-composer-send');
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('后台完成后不要恢复旧运行态');
      await sendButton.click();
      await expect(sendButton).toHaveAttribute('title', /Stop|停止/);

      const finalTimestamp = Date.now() / 1000;
      const idempotencyKey = await app.evaluate(() => {
        const getIdempotencyKey = (globalThis as Record<string, unknown>).__mainRequestIdempotencyKey as
          | (() => string | undefined)
          | undefined;
        return getIdempotencyKey?.();
      });
      expect(idempotencyKey).toBeTruthy();
      const settledHistory = [
        {
          id: 'user-offscreen-idle',
          idempotencyKey,
          role: 'user',
          content: '后台完成后不要恢复旧运行态',
          timestamp: finalTimestamp - 1,
        },
        {
          id: 'assistant-offscreen-idle-final',
          role: 'assistant',
          content: '任务已经完成。',
          timestamp: finalTimestamp,
        },
      ];
      await app.evaluate(({ BrowserWindow }, history) => {
        const persist = (globalThis as Record<string, unknown>).__persistMainOffscreenFinal as
          | ((messages: unknown[]) => void)
          | undefined;
        persist?.(history);
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('gateway:chat-message', {
            message: {
              state: 'final',
              runId: 'run-offscreen-idle',
              sessionKey: 'agent:main:main',
              message: history[1],
            },
          });
        }
      }, settledHistory);

      await expect(page.getByText('任务已经完成。')).toBeVisible();
      await page.getByTestId(`sidebar-session-${otherSessionKey}`).click();
      await expect(page.getByText('这个会话处于空闲状态。')).toBeVisible();
      await app.evaluate(() => {
        const setIdle = (globalThis as Record<string, unknown>).__setMainOffscreenIdle as
          | (() => void)
          | undefined;
        setIdle?.();
      });
      await expect.poll(async () => await app.evaluate(() => {
        const observed = (globalThis as Record<string, unknown>).__mainOffscreenIdleObserved as
          | (() => boolean)
          | undefined;
        return observed?.() ?? false;
      })).toBe(true);

      await page.evaluate(() => {
        const state = globalThis as unknown as Record<string, unknown>;
        state.__staleOffscreenRunObserved = false;
        const check = () => {
          const send = document.querySelector<HTMLElement>('[data-testid="chat-composer-send"]');
          if (send?.getAttribute('title') === 'Stop' || document.body.textContent?.includes('正在整理执行结果…')) {
            state.__staleOffscreenRunObserved = true;
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
        state.__staleOffscreenRunObserver = observer;
      });

      await page.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`).click();
      await expect(page.getByText('任务已经完成。')).toHaveCount(1);
      await expect(sendButton).toHaveAttribute('title', /Send|发送/);
      expect(await page.evaluate(() => (
        (globalThis as unknown as Record<string, unknown>).__staleOffscreenRunObserved
      ))).toBe(false);
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
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
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

      const toolGroup = page.getByTestId('timeline-tool-group');
      await expect(toolGroup).toBeVisible({ timeout: 30_000 });
      await expect(toolGroup).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await page.getByTestId('timeline-tool-group-toggle').click();
      await expect(page.getByTestId('timeline-tool-details')).toContainText('/tmp/capabilities.md');
      await expect(page.getByText('我现在可以生成文档、表格和演示文稿。')).toBeVisible();
      await expect(page.getByTestId('conversation-turn').filter({ hasText: '你现在能做哪些文件类产物？' }))
        .toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      await expect(page.getByTestId('chat-execution-step').filter({ hasText: 'read' })).toBeVisible();
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

  test('does not revive an interrupted historical tool run without backend active evidence', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const otherSessionKey = 'agent:main:completed-session';

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 22345, gatewayReady: true },
      });
      await app.evaluate(async () => {
        const { ipcMain } = process.mainModule!.require('electron') as typeof import('electron');
        const sessionKeys = ['agent:main:main', 'agent:main:completed-session'];
        const sessionResult = () => ({
          sessions: sessionKeys.map((key) => ({
            key,
            displayName: key === 'agent:main:main' ? 'Interrupted run' : 'Completed session',
            updatedAt: key === 'agent:main:main' ? Date.now() : Date.now() - 1_000,
          })),
        });
        const timestamp = Math.floor(Date.now() / 1000) - 60;
        const historiesBySession = {
          'agent:main:main': [
            {
              id: 'user-interrupted-history-run',
              role: 'user',
              content: [{ type: 'text', text: '生成一个视频，然后我会强制退出应用。' }],
              timestamp,
            },
            {
              id: 'assistant-interrupted-history-tool',
              role: 'assistant',
              content: [{
                type: 'toolCall',
                id: 'call-interrupted-video',
                name: 'video_generate',
                arguments: { prompt: 'snow mountain' },
              }],
              timestamp: timestamp + 1,
            },
            {
              role: 'toolResult',
              toolCallId: 'call-interrupted-video',
              toolName: 'video_generate',
              content: [{ type: 'text', text: 'render process disconnected' }],
              details: {
                async: true,
                status: 'started',
                taskId: 'task-interrupted-video',
              },
              isError: false,
              timestamp: timestamp + 2,
            },
          ],
          'agent:main:completed-session': [
            {
              id: 'user-completed-session',
              role: 'user',
              content: '这是另一个会话。',
              timestamp: timestamp - 20,
            },
            {
              id: 'assistant-completed-session',
              role: 'assistant',
              content: '另一个会话已经完成。',
              timestamp: timestamp - 19,
            },
          ],
        } as Record<string, unknown[]>;
        const response = (json: unknown) => ({
          ok: true,
          data: { status: 200, ok: true, json },
        });

        ipcMain.removeHandler('gateway:rpc');
        ipcMain.handle('gateway:rpc', async (_event: unknown, method: string, params: { sessionKey?: string } = {}) => {
          if (method === 'sessions.list') return { success: true, result: sessionResult() };
          if (method === 'chat.history') {
            return {
              success: true,
              result: {
                messages: historiesBySession[params.sessionKey ?? ''] ?? [],
                sessionInfo: { hasActiveRun: false, status: 'done' },
              },
            };
          }
          return { success: true, result: {} };
        });

        ipcMain.removeHandler('hostapi:fetch');
        ipcMain.handle('hostapi:fetch', async (_event: unknown, request: { path?: string; body?: string }) => {
          if (request.path === '/api/gateway/status') {
            return response({ state: 'running', port: 18789, pid: 22345, gatewayReady: true });
          }
          if (request.path === '/api/chat/sessions') {
            return response({ success: true, result: sessionResult() });
          }
          if (request.path === '/api/chat/history') {
            const body = request.body ? JSON.parse(request.body) as { sessionKey?: string } : {};
            return response({
              success: true,
              result: {
                messages: historiesBySession[body.sessionKey ?? ''] ?? [],
                sessionInfo: { hasActiveRun: false, status: 'done' },
              },
            });
          }
          if (request.path?.startsWith('/api/task-bridge/tasks')) {
            return response({ success: true, tasks: [] });
          }
          if (request.path === '/api/agents') {
            return response({ success: true, agents: [{ id: 'main', name: 'Main' }] });
          }
          return response({});
        });
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      const sendButton = page.getByTestId('chat-composer-send');
      await expect(page.getByText('生成一个视频，然后我会强制退出应用。')).toBeVisible({ timeout: 30_000 });
      await expect(sendButton).toHaveAttribute('title', /Send|发送/);
      await expect(page.getByText('正在整理执行结果…')).toHaveCount(0);

      await page.getByTestId(`sidebar-session-${otherSessionKey}`).click();
      await expect(page.getByText('另一个会话已经完成。')).toBeVisible();
      await page.getByTestId(`sidebar-session-${MAIN_SESSION_KEY}`).click();
      await expect(page.getByText('生成一个视频，然后我会强制退出应用。')).toBeVisible();
      await expect(sendButton).toHaveAttribute('title', /Send|发送/);
      await expect(page.getByText('正在整理执行结果…')).toHaveCount(0);
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
    const activeSession = {
      key: MAIN_SESSION_KEY,
      displayName: 'main',
      status: 'done',
      hasActiveRun: true,
    };
    const activeHistory = {
      messages: history,
      sessionInfo: { status: 'done', hasActiveRun: true },
      inFlightRun: { runId: 'run-open-history-live', text: '' },
    };
    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
            success: true,
            result: {
              sessions: [activeSession],
            },
          },
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
            success: true,
            result: activeHistory,
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
                  sessions: [activeSession],
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
                result: activeHistory,
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

      const openTurn = page.getByTestId('conversation-turn').filter({ hasText: '你现在能做哪些文件类产物？' });
      await expect(openTurn).toHaveAttribute('data-turn-status', 'running', { timeout: 30_000 });
      await expect(page.getByTestId('timeline-turn-status')).toBeVisible();
      await expect(page.getByTestId('timeline-tool-group')).toHaveAttribute('data-status', 'completed');
      await page.getByTestId('timeline-tool-group-toggle').click();
      await expect(page.getByTestId('timeline-tool-details')).toContainText('/tmp/capabilities.md');
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
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
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
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
              json: { success: true, result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] } },
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
          [stableStringify(['chat.history', { sessionKey: MAIN_SESSION_KEY, limit: 100, maxChars: 500000 }])]: {
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
              json: { success: true, result: { sessions: [{ key: MAIN_SESSION_KEY, displayName: 'main' }] } },
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
