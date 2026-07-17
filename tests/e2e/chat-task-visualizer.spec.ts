import { closeElectronApp, emitIpcEvent, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const PROJECT_MANAGER_SESSION_KEY = 'agent:main:main';
const CODER_SESSION_KEY = 'agent:coder:subagent:child-123';
const CODER_SESSION_ID = 'child-session-id';
const DELEGATION_TASK_ID = 'velaria-delegation-task';
const CODER_TASK_ID = 'velaria-coder-task';
const CODER_EXEC_TOOL_CALL_ID = 'coder-exec-call';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const seededHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: '[Mon 2026-04-06 15:18 GMT+8] Analyze Velaria uncommitted changes' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'spawn-call',
      name: 'sessions_spawn',
      arguments: { agentId: 'coder', task: 'analyze core blocks' },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'spawn-call',
    toolName: 'sessions_spawn',
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'accepted',
        childSessionKey: CODER_SESSION_KEY,
        runId: 'child-run-id',
        mode: 'run',
      }, null, 2),
    }],
    details: {
      status: 'accepted',
      async: true,
      taskId: DELEGATION_TASK_ID,
      taskTitle: 'Delegate Velaria analysis',
      runtime: 'subagent',
      childSessionKey: CODER_SESSION_KEY,
      runId: 'child-run-id',
      mode: 'run',
    },
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'yield-call',
      name: 'sessions_yield',
      arguments: { message: 'I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.' },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'yield-call',
    toolName: 'sessions_yield',
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'yielded',
        message: 'I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.',
      }, null, 2),
    }],
    details: {
      status: 'yielded',
      message: 'I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.',
    },
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[Internal task completion event]
source: subagent
session_key: ${CODER_SESSION_KEY}
session_id: ${CODER_SESSION_ID}
type: subagent task
status: completed successfully`,
      },
      {
        type: 'task_completion',
        taskId: DELEGATION_TASK_ID,
        runId: 'child-run-id',
        runtime: 'subagent',
        title: 'Delegate Velaria analysis',
        taskStatus: 'completed',
        status: 'completed',
        childSessionKey: CODER_SESSION_KEY,
        childSessionId: CODER_SESSION_ID,
      },
      {
        type: 'task_completion',
        taskId: CODER_TASK_ID,
        parentTaskId: DELEGATION_TASK_ID,
        runId: 'child-run-id',
        runtime: 'subagent',
        title: 'coder subagent',
        taskStatus: 'completed',
        status: 'completed',
        childSessionKey: CODER_SESSION_KEY,
        childSessionId: CODER_SESSION_ID,
      },
    ],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Coder has finished the analysis, here are the conclusions.' }],
    _attachedFiles: [
      {
        fileName: 'CHECKLIST.md',
        mimeType: 'text/markdown',
        fileSize: 433,
        preview: null,
        filePath: '/Users/bytedance/.openclaw/workspace/CHECKLIST.md',
        source: 'tool-result',
        disposition: 'intermediate',
      },
    ],
    timestamp: Date.now(),
  },
];

const childTranscriptMessages = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Analyze the core content of ~/Velaria uncommitted changes' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'coder-exec-call',
      name: 'exec',
      arguments: {
        command: "cd ~/Velaria && git status --short && sed -n '1,200p' src/dataflow/core/logical/planner/plan.h",
        workdir: '/Users/bytedance/.openclaw/workspace-coder',
      },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'coder-exec-call',
    toolName: 'exec',
    content: [{ type: 'text', text: 'M src/dataflow/core/logical/planner/plan.h' }],
    details: {
      status: 'completed',
      aggregated: "M src/dataflow/core/logical/planner/plan.h\nM src/dataflow/core/execution/runtime/execution_optimizer.cc",
      cwd: '/Users/bytedance/.openclaw/workspace-coder',
    },
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Analysis complete, there are 4 key blocks.' }],
    timestamp: Date.now(),
  },
];

const longRunPrompt = 'Inspect the workspace and summarize the result';
const longRunProcessSegments = Array.from({ length: 9 }, (_, index) => `Checked source ${index + 1}.`);
const longRunSummary = 'Here is the summary.';
const longRunReplyText = `${longRunProcessSegments.join(' ')} ${longRunSummary}`;
const longRunHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: longRunPrompt }],
    timestamp: Date.now(),
  },
  ...longRunProcessSegments.map((segment, index) => ({
    role: 'assistant',
    id: `long-run-step-${index + 1}`,
    content: [{ type: 'text', text: segment }],
    timestamp: Date.now(),
  })),
  {
    role: 'assistant',
    id: 'long-run-final',
    content: [{ type: 'text', text: longRunReplyText }],
    timestamp: Date.now(),
  },
];

const errorRunPrompt = '你是什么模型？';
const errorRunHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: errorRunPrompt }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'error-final',
    content: [],
    stopReason: 'error',
    errorMessage: '404 Resource not found',
    timestamp: Date.now(),
  },
];

test.describe('ClawX chat execution graph', () => {
  test('renders internal yield status and linked subagent branch from mocked IPC', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: {
              messages: seededHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: {
              messages: seededHistory,
            },
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
          [stableStringify(['/api/chat/sessions', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: {
                  sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
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
                result: {
                  messages: seededHistory,
                },
              },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [
                  { id: 'main', name: 'main' },
                  { id: 'coder', name: 'coder' },
                ],
              },
            },
          },
          [stableStringify([`/api/sessions/transcript?agentId=coder&sessionId=${CODER_SESSION_ID}`, 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                messages: childTranscriptMessages,
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

      // Late child-tool evidence must reattach to the already replayed owning Turn.
      const now = Date.now();
      await emitIpcEvent(app, 'chat:runtime-event', {
        type: 'tool.started',
        producer: 'openclaw',
        runId: 'child-run-id',
        sessionKey: PROJECT_MANAGER_SESSION_KEY,
        taskId: CODER_TASK_ID,
        parentTaskId: DELEGATION_TASK_ID,
        toolCallId: CODER_EXEC_TOOL_CALL_ID,
        name: 'exec',
        args: childTranscriptMessages[1].content[0].arguments,
        ts: now,
      });
      await emitIpcEvent(app, 'chat:runtime-event', {
        type: 'tool.completed',
        producer: 'openclaw',
        runId: 'child-run-id',
        sessionKey: PROJECT_MANAGER_SESSION_KEY,
        taskId: CODER_TASK_ID,
        parentTaskId: DELEGATION_TASK_ID,
        toolCallId: CODER_EXEC_TOOL_CALL_ID,
        name: 'exec',
        result: childTranscriptMessages[2].details,
        isError: false,
        ts: now + 1,
      });
      await emitIpcEvent(app, 'chat:runtime-event', {
        type: 'run.ended',
        producer: 'openclaw',
        runId: 'child-run-id',
        sessionKey: PROJECT_MANAGER_SESSION_KEY,
        status: 'completed',
        endedAt: now + 2,
        ts: now + 2,
      });

      const turn = page.getByTestId('conversation-turn').filter({ hasText: 'Analyze Velaria uncommitted changes' });
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-subtasks')).toHaveCount(2);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);

      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const graph = dialog.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible({ timeout: 30_000 });
      const parentTask = dialog.locator(`[data-testid="chat-execution-step"][data-task-id="${DELEGATION_TASK_ID}"]`)
        .filter({ hasText: 'Delegate Velaria analysis' });
      const childTask = dialog.locator(`[data-testid="chat-execution-step"][data-task-id="${CODER_TASK_ID}"]`)
        .filter({ hasText: 'coder subagent' });
      await expect(parentTask).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(parentTask).toHaveAttribute('data-step-status', 'completed');
      await expect(childTask).toHaveAttribute('data-parent-id', `plan-step:task:${DELEGATION_TASK_ID}`);
      await expect(childTask).toHaveAttribute('data-step-status', 'completed');

      const yieldRow = dialog.getByTestId('chat-execution-step').filter({ hasText: 'sessions_yield' });
      await expect(yieldRow).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(yieldRow).toHaveAttribute('data-step-status', 'completed');
      await yieldRow.click();
      await expect(yieldRow.locator('pre')).toBeVisible();
      await expect(yieldRow).toContainText('I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.');

      const execRow = dialog.locator(`[data-testid="chat-execution-step"][data-task-id="${CODER_TASK_ID}"]`)
        .filter({ hasText: 'exec' });
      await expect(execRow).toHaveAttribute('data-parent-id', `plan-step:task:${CODER_TASK_ID}`);
      await expect(execRow).toHaveAttribute('data-step-status', 'completed');
      await execRow.click();
      await expect(execRow.locator('pre')).toBeVisible();
      await expect(execRow).toContainText('execution_optimizer.cc');
      await expect(page.getByText('CHECKLIST.md')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('preserves long execution history counts and strips the full folded reply prefix', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: {
              messages: longRunHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: {
              messages: longRunHistory,
            },
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
          [stableStringify(['/api/chat/sessions', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: {
                  sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
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
                result: {
                  messages: longRunHistory,
                },
              },
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
      const turn = page.getByTestId('conversation-turn').filter({ hasText: longRunPrompt });
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-status', 'completed');
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-tool-group')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);

      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const processRows = dialog.getByTestId('chat-execution-step');
      await expect(processRows).toHaveCount(longRunProcessSegments.length);
      for (const segment of longRunProcessSegments) {
        await expect(processRows.filter({ hasText: segment })).toHaveCount(1);
      }
      await expect(page.getByText(longRunSummary, { exact: true })).toBeVisible();
      await expect(page.getByText(longRunReplyText, { exact: true })).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('surfaces terminal model errors and stops the stale thinking state', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
            success: true,
            result: {
              messages: errorRunHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000, maxChars: 500000 }])]: {
            success: true,
            result: {
              messages: errorRunHistory,
            },
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
          [stableStringify(['/api/chat/sessions', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                result: {
                  sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
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
                result: {
                  messages: errorRunHistory,
                },
              },
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
      const turn = page.getByTestId('conversation-turn').filter({ hasText: errorRunPrompt });
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-status', 'error');
      const timelineError = page.getByTestId('timeline-error');
      await expect(timelineError).toBeVisible({ timeout: 30_000 });
      await expect(timelineError).toHaveAttribute('data-recoverable', 'false');
      await expect(timelineError).toContainText(/This request could not be completed|暂时无法完成这项请求/u);
      await expect(page.getByTestId('timeline-error-retry')).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-step-thinking-trailing')).toHaveCount(0);
      await expect(page.getByTestId('timeline-turn-status')).toHaveCount(0);
      await expect(page.getByText('404 Resource not found')).toHaveCount(0);

      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const errorRow = dialog.getByTestId('chat-execution-step').filter({ hasText: '404 Resource not found' });
      await expect(errorRow).toHaveCount(1);
      await expect(errorRow).toHaveAttribute('data-step-status', 'error');
      await expect(errorRow).toHaveAttribute('data-parent-id', 'agent-run');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByText('404 Resource not found')).toHaveCount(0);
      await page.getByTestId('chat-composer-input').fill('retry');
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
    } finally {
      await closeElectronApp(app);
    }
  });

});
