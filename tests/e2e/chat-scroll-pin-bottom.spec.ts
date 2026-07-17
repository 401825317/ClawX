import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const RUN_ID = 'run-pin-e2e';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

// Seed enough history that the scroll container overflows from the start.
const seededHistory = Array.from({ length: 40 }, (_, idx) => ({
  role: idx % 2 === 0 ? 'user' : 'assistant',
  content: `Chat history message ${idx + 1}`,
  timestamp: Date.now() + idx,
}));

// Build a streaming assistant text of `paragraphs` markdown paragraphs so each
// delta grows the rendered height deterministically.
function streamingText(paragraphs: number): string {
  return Array.from({ length: paragraphs }, (_, idx) => `Streaming paragraph ${idx + 1}.`).join('\n\n');
}

test.describe('ClawX chat scroll pin-to-bottom during runs', () => {
  test('keeps the scrollbar pinned to the bottom through oscillating tool-heavy streaming, and yields to manual scroll-up', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
        gatewayRpc: {
          // Null-arg fallbacks match regardless of the exact request payload.
          [stableStringify(['sessions.list', null])]: {
            success: true,
            result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', null])]: {
            success: true,
            result: { messages: seededHistory },
          },
          [stableStringify(['chat.send', null])]: {
            success: true,
            result: { runId: RUN_ID },
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
          [stableStringify(['/api/chat/send', 'POST'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, result: { runId: RUN_ID } },
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

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-page')).toBeVisible();
      await expect(page.getByText('Chat history message 40')).toBeVisible({ timeout: 30_000 });

      const scrollContainer = page.getByTestId('chat-scroll-container');
      const timeline = page.getByTestId('conversation-timeline');

      // Emit the canonical runtime contract consumed by the Timeline store.
      const emitRuntimeEvents = async (events: ChatRuntimeEvent[]) => {
        await app.evaluate(({ BrowserWindow }, runtimeEvents) => {
          for (const event of runtimeEvents) {
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('chat:runtime-event', event);
            }
          }
        }, events);
      };

      // Assert the scrollbar is glued to the very bottom (within a small epsilon
      // that tolerates sub-pixel rounding).
      const expectPinnedToBottom = async () => {
        await expect(timeline).toHaveAttribute('data-follow-mode', 'following');
        await expect
          .poll(
            async () =>
              scrollContainer.evaluate((el) => {
                const element = el as HTMLElement;
                return Math.round(element.scrollHeight - element.clientHeight - element.scrollTop);
              }),
            { timeout: 5_000 },
          )
          .toBeLessThanOrEqual(8);
      };

      // Start a run so pinning becomes active (sending === true).
      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('do a multi-tool task');
      await page.getByTestId('chat-composer-send').click();
      await expect(page.getByText('do a multi-tool task', { exact: true })).toBeVisible();
      await expect(page.getByTestId('chat-composer-send')).toHaveAttribute('title', /Stop|停止/);

      const runStartedAt = Date.now();
      await emitRuntimeEvents([{
        type: 'run.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        startedAt: runStartedAt,
        seq: 0,
        ts: runStartedAt,
      }]);

      // Growing text stream -> height keeps increasing; bar must stay at bottom.
      await emitRuntimeEvents([{
        type: 'assistant.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: streamingText(3),
        replace: true,
        seq: 1,
        ts: Date.now(),
      }]);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'Streaming paragraph 3.' })).toBeVisible();
      await expectPinnedToBottom();

      await emitRuntimeEvents([{
        type: 'assistant.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: streamingText(8),
        replace: true,
        seq: 2,
        ts: Date.now(),
      }]);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'Streaming paragraph 8.' })).toBeVisible();
      await expectPinnedToBottom();

      // Tool round -> layout oscillates (bubble/graph/tool-status churn); the
      // bar must still snap to the bottom rather than jitter upward.
      await emitRuntimeEvents([{
        type: 'tool.started',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'tool-1',
        name: 'exec',
        args: { command: 'ls -la' },
        seq: 3,
        ts: Date.now(),
      }]);
      await expectPinnedToBottom();

      // Back to text growth after the tool round.
      await emitRuntimeEvents([{
        type: 'assistant.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: streamingText(14),
        replace: true,
        seq: 4,
        ts: Date.now(),
      }]);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'Streaming paragraph 14.' })).toBeVisible();
      await expectPinnedToBottom();

      // Manual scroll-up while the run is live: pinning must yield to the user
      // and surface the "scroll to latest" affordance.
      await scrollContainer.evaluate((el) => {
        const element = el as HTMLElement;
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });

      const jumpButton = page.getByTestId('chat-scroll-to-latest');
      await expect(jumpButton).toBeVisible();
      await expect(timeline).toHaveAttribute('data-follow-mode', 'detached');
      await expect.poll(async () => scrollContainer.evaluate((el) => {
        const element = el as HTMLElement;
        return Math.round(element.scrollHeight - element.clientHeight - element.scrollTop);
      })).toBeGreaterThan(8);
      const detachedMetrics = await scrollContainer.evaluate((el) => {
        const element = el as HTMLElement;
        return { scrollTop: element.scrollTop, scrollHeight: element.scrollHeight };
      });

      // Further offscreen streaming must NOT yank the user back down while
      // they've escaped. A virtualized row does not need to be mounted just to
      // update the detached viewport's total-height estimate.
      const revisionBeforeDetachedGrowth = Number(
        await timeline.getAttribute('data-latest-turn-revision') ?? '-1',
      );
      await emitRuntimeEvents([{
        type: 'assistant.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: streamingText(20),
        replace: true,
        seq: 5,
        ts: Date.now(),
      }]);
      await expect.poll(async () => Number(
        await timeline.getAttribute('data-latest-turn-revision') ?? '-1',
      )).toBeGreaterThan(revisionBeforeDetachedGrowth);
      await expect(jumpButton).toBeVisible();
      const afterGrowth = await scrollContainer.evaluate((el) => {
        const element = el as HTMLElement;
        return {
          scrollTop: element.scrollTop,
          distanceFromBottom: Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
        };
      });
      expect(Math.abs(afterGrowth.scrollTop - detachedMetrics.scrollTop)).toBeLessThanOrEqual(4);
      expect(afterGrowth.distanceFromBottom).toBeGreaterThan(8);

      // A scrollbar/touch gesture remains user-owned until pointerup. Keep the
      // pointer active beyond the discrete 1.5s intent window, then finish the
      // slow drag at the bottom and verify following is restored.
      const scrollerBox = await scrollContainer.boundingBox();
      expect(scrollerBox).not.toBeNull();
      await scrollContainer.dispatchEvent('pointerdown', {
        pointerType: 'mouse',
        clientX: Math.floor(scrollerBox!.x + scrollerBox!.width - 1),
        clientY: Math.floor(scrollerBox!.y + scrollerBox!.height / 2),
        button: 0,
        buttons: 1,
      });
      await page.waitForTimeout(1_650);
      await scrollContainer.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      await expect(timeline).toHaveAttribute('data-follow-mode', 'following');
      await page.evaluate(() => {
        window.dispatchEvent(new PointerEvent('pointerup', {
          pointerType: 'mouse',
          bubbles: true,
        }));
      });
      await expect(jumpButton).toBeHidden({ timeout: 10_000 });
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'Streaming paragraph 20.' })).toBeVisible();

      const revisionBeforeRefollowGrowth = Number(
        await timeline.getAttribute('data-latest-turn-revision') ?? '-1',
      );
      await emitRuntimeEvents([{
        type: 'assistant.delta',
        producer: 'openclaw',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        text: streamingText(24),
        replace: true,
        seq: 6,
        ts: Date.now(),
      }]);
      await expect.poll(async () => Number(
        await timeline.getAttribute('data-latest-turn-revision') ?? '-1',
      )).toBeGreaterThan(revisionBeforeRefollowGrowth);
      await expect(page.getByTestId('timeline-commentary').filter({ hasText: 'Streaming paragraph 24.' })).toBeVisible();
      await expectPinnedToBottom();
    } finally {
      await closeElectronApp(app);
    }
  });
});
