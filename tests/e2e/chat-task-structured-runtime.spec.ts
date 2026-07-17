import type { ElectronApplication } from '@playwright/test';
import { normalizeGatewayChatRuntimeEvents } from '../../electron/gateway/chat-runtime-events';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import { deriveRuntimeTaskSteps } from '../../src/pages/Chat/runtime-task-visualization';
import type { RawMessage } from '../../src/stores/chat/types';
import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const SESSION_KEY = 'agent:main:main';
const RUN_ID = 'run-structured-task-flow';

function normalizeTaskSnapshot(task: Record<string, unknown>, extras: Record<string, unknown> = {}): ChatRuntimeEvent[] {
  return normalizeGatewayChatRuntimeEvents({
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    ts: typeof task.updatedAt === 'number' ? task.updatedAt : Date.now(),
    data: { task, ...extras },
  });
}

function deriveTaskSteps(
  events: ChatRuntimeEvent[],
  status: 'running' | 'completed' | 'error' | 'aborted' = 'running',
) {
  return deriveRuntimeTaskSteps({
    runId: RUN_ID,
    sessionKey: SESSION_KEY,
    status,
    assistantText: '',
    thinkingText: '',
    events,
  });
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

async function installChatMocks(app: ElectronApplication, historyMessages: RawMessage[] = []): Promise<void> {
  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] },
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
        success: true,
        result: { messages: historyMessages },
      },
      [stableStringify(['chat.send', null])]: {
        success: true,
        result: { runId: RUN_ID },
      },
    },
    hostApi: {
      [stableStringify(['/api/gateway/status', 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { state: 'running', port: 18789, pid: 12345, gatewayReady: true } },
      },
      [stableStringify(['/api/chat/sessions', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, result: { sessions: [{ key: SESSION_KEY, displayName: 'main' }] } },
        },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: { messages: historyMessages } } },
      },
      [stableStringify(['/api/chat/send', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: { runId: RUN_ID } } },
      },
      [stableStringify(['/api/files/thumbnails', 'POST'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: {
            '/tmp/release-evidence.md': {
              filePath: '/tmp/release-evidence.md',
              fileSize: 2048,
            },
          },
        },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, agents: [{ id: 'main', name: 'Main' }] } },
      },
    },
  });
}

async function emitRuntimeEvents(app: ElectronApplication, events: ChatRuntimeEvent[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, runtimeEvents) => {
    for (const event of runtimeEvents) {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('chat:runtime-event', event);
      }
    }
  }, events);
}

test.describe('structured OpenClaw task projection', () => {
  test('projects parent/child tasks, approval, artifact, and terminal state without parsing prose', () => {
    const parentTask = {
      id: 'task-parent',
      taskId: 'task-parent',
      runtime: 'subagent',
      kind: 'orchestration',
      flowId: 'flow-release-check',
      status: 'running',
      title: 'Coordinate release evidence',
      sessionKey: SESSION_KEY,
      childSessionKey: 'agent:main:subagent:parent',
      createdAt: 1000,
      startedAt: 1100,
      updatedAt: 1200,
    };
    const childTask = {
      id: 'task-child',
      taskId: 'task-child',
      parentTaskId: 'task-parent',
      runtime: 'subagent',
      kind: 'research',
      flowId: 'flow-release-check',
      status: 'running',
      title: 'Inspect deployment evidence',
      sessionKey: SESSION_KEY,
      childSessionKey: 'agent:researcher:subagent:child',
      createdAt: 1200,
      startedAt: 1300,
      updatedAt: 1400,
    };

    const runtimeEvents: ChatRuntimeEvent[] = [
      ...normalizeTaskSnapshot(parentTask),
      ...normalizeTaskSnapshot(childTask),
      ...normalizeTaskSnapshot(
        { ...childTask, status: 'waiting_approval', updatedAt: 1500 },
        {
          approval: {
            title: 'Publish release notes',
            kind: 'external_action',
            status: 'pending',
            message: 'Review the external publish action.',
          },
        },
      ),
      ...normalizeGatewayChatRuntimeEvents({
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        taskId: 'task-child',
        parentTaskId: 'task-parent',
        stream: 'approval',
        ts: 1600,
        data: {
          itemId: 'task-child',
          title: 'Publish release notes',
          kind: 'external_action',
          phase: 'resolved',
          status: 'approved',
          message: 'Approved in UClaw.',
        },
      }),
      ...normalizeTaskSnapshot(
        {
          ...childTask,
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          terminalSummary: 'Evidence bundle ready',
          updatedAt: 1700,
          endedAt: 1700,
        },
        {
          artifacts: [{
            id: 'release-evidence',
            kind: 'document',
            title: 'Release evidence',
            filePath: '/tmp/release-evidence.md',
          }],
          verifications: [{
            id: 'release-evidence-check',
            status: 'passed',
            kind: 'artifact.availability',
            title: 'Release evidence',
            artifactId: 'release-evidence',
          }],
        },
      ),
      ...normalizeTaskSnapshot({
        ...parentTask,
        status: 'completed',
        deliveryStatus: 'delivered',
        terminalOutcome: 'succeeded',
        terminalSummary: 'All delegated work completed',
        updatedAt: 1800,
        endedAt: 1800,
      }),
    ];

    const taskEvents = runtimeEvents.filter(
      (event): event is Extract<ChatRuntimeEvent, { type: 'task.updated' }> => event.type === 'task.updated',
    );
    const finalTaskById = new Map(taskEvents.map((event) => [event.task.taskId, event.task]));
    expect([...finalTaskById.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-parent',
        status: 'completed',
      }),
      expect.objectContaining({
        taskId: 'task-child',
        status: 'completed',
        parentTaskId: 'task-parent',
      }),
    ]));
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'approval.updated',
        taskId: 'task-child',
        parentTaskId: 'task-parent',
        status: 'approved',
      }),
      expect.objectContaining({
        type: 'artifact.produced',
        taskId: 'task-child',
        parentTaskId: 'task-parent',
        artifact: expect.objectContaining({ id: 'release-evidence', taskId: 'task-child' }),
      }),
    ]));
    expect(taskEvents.every((event) => event.task.flowId === 'flow-release-check')).toBe(true);
    expect(runtimeEvents.some((event) => event.type === 'run.ended')).toBe(false);
  });

  test('projects pending, delivered, and failed delivery phases distinctly', () => {
    const awaitingDeliveryEvents = normalizeTaskSnapshot({
      id: 'task-delivery',
      taskId: 'task-delivery',
      runtime: 'subagent',
      flowId: 'flow-delivery',
      status: 'completed',
      deliveryStatus: 'pending',
      title: 'Deliver delegated result',
      updatedAt: 2000,
    });
    const deliveredEvents = normalizeTaskSnapshot({
      id: 'task-delivery',
      taskId: 'task-delivery',
      runtime: 'subagent',
      flowId: 'flow-delivery',
      status: 'completed',
      deliveryStatus: 'delivered',
      title: 'Deliver delegated result',
      updatedAt: 2100,
    });
    const failedDeliveryEvents = normalizeTaskSnapshot({
      id: 'task-delivery-failed',
      taskId: 'task-delivery-failed',
      runtime: 'subagent',
      flowId: 'flow-delivery-failed',
      status: 'completed',
      deliveryStatus: 'failed',
      title: 'Recover failed delivery',
      updatedAt: 2200,
    });

    const awaitingDelivery = awaitingDeliveryEvents.find(
      (event): event is Extract<ChatRuntimeEvent, { type: 'task.updated' }> => event.type === 'task.updated',
    );
    const delivered = deliveredEvents.find(
      (event): event is Extract<ChatRuntimeEvent, { type: 'task.updated' }> => event.type === 'task.updated',
    );
    const failedDelivery = failedDeliveryEvents.find(
      (event): event is Extract<ChatRuntimeEvent, { type: 'task.updated' }> => event.type === 'task.updated',
    );
    const awaitingStep = deriveTaskSteps(awaitingDeliveryEvents)
      .find((step) => step.id === 'plan-step:task:task-delivery');
    const deliveredStep = deriveTaskSteps(deliveredEvents, 'completed')
      .find((step) => step.id === 'plan-step:task:task-delivery');
    const failedDeliveryStep = deriveTaskSteps(failedDeliveryEvents)
      .find((step) => step.id === 'plan-step:task:task-delivery-failed');

    expect(awaitingDelivery?.task.status).toBe('running');
    expect(delivered?.task.status).toBe('completed');
    expect(failedDelivery?.task.status).toBe('partial');
    expect(awaitingStep?.status).toBe('running');
    expect(deliveredStep?.status).toBe('completed');
    expect(failedDeliveryStep?.status).toBe('blocked');
    expect(awaitingDeliveryEvents.some((event) => event.type === 'run.ended')).toBe(false);
  });

  test('does not regress a terminal task when stale or newer running snapshots arrive', () => {
    const runtimeEvents = [
      ...normalizeTaskSnapshot({
        id: 'task-terminal',
        taskId: 'task-terminal',
        runtime: 'subagent',
        flowId: 'flow-terminal',
        status: 'running',
        title: 'Terminal task',
        updatedAt: 2300,
      }),
      ...normalizeTaskSnapshot({
        id: 'task-terminal',
        taskId: 'task-terminal',
        runtime: 'subagent',
        flowId: 'flow-terminal',
        status: 'completed',
        deliveryStatus: 'delivered',
        terminalOutcome: 'succeeded',
        title: 'Terminal task',
        updatedAt: 2500,
        endedAt: 2500,
      }),
      ...normalizeTaskSnapshot({
        id: 'task-terminal',
        taskId: 'task-terminal',
        runtime: 'subagent',
        flowId: 'flow-terminal',
        status: 'running',
        title: 'Stale running task',
        updatedAt: 2400,
      }),
      ...normalizeTaskSnapshot({
        id: 'task-terminal',
        taskId: 'task-terminal',
        runtime: 'subagent',
        flowId: 'flow-terminal',
        status: 'running',
        title: 'Newer terminal regression',
        updatedAt: 2600,
      }),
    ];
    const taskSteps = deriveTaskSteps(runtimeEvents, 'completed');
    const terminalTask = taskSteps.find((step) => step.id === 'plan-step:task:task-terminal');

    expect(terminalTask?.label).toBe('Terminal task');
    expect(terminalTask?.status).toBe('completed');
  });

  test('keeps execution failure terminal even when delivery also failed', () => {
    const failed = normalizeTaskSnapshot({
      id: 'task-failed',
      taskId: 'task-failed',
      runtime: 'subagent',
      status: 'failed',
      deliveryStatus: 'failed',
      terminalOutcome: 'partial',
      title: 'Failed delegated task',
      updatedAt: 2_150,
    }).find((event): event is Extract<ChatRuntimeEvent, { type: 'task.updated' }> => event.type === 'task.updated');

    expect(failed?.task.status).toBe('error');
  });

  test('preserves partial artifacts and settles recovery state when the task later completes', () => {
    const partialEvents = normalizeTaskSnapshot({
      id: 'task-recovered',
      taskId: 'task-recovered',
      runtime: 'subagent',
      flowId: 'flow-recovery',
      status: 'partial',
      title: 'Recoverable delegated task',
      updatedAt: 2_160,
    }, {
      artifacts: [{
        id: 'partial-evidence',
        kind: 'document',
        title: 'Partial evidence',
        filePath: '/tmp/partial-evidence.md',
      }],
    });
    const completedEvents = normalizeTaskSnapshot({
      id: 'task-recovered',
      taskId: 'task-recovered',
      runtime: 'subagent',
      flowId: 'flow-recovery',
      status: 'completed',
      deliveryStatus: 'delivered',
      terminalOutcome: 'succeeded',
      title: 'Recoverable delegated task',
      updatedAt: 2_170,
      endedAt: 2_170,
    });
    const events = [...partialEvents, ...completedEvents];
    const steps = deriveTaskSteps(events, 'completed');
    const recoveredTask = steps.find((step) => step.id === 'plan-step:task:task-recovered');
    const partialArtifact = steps.find((step) => step.id === 'artifact:partial-evidence');

    expect(recoveredTask?.taskId).toBe('task-recovered');
    expect(recoveredTask?.status).toBe('completed');
    expect(partialArtifact?.status).toBe('completed');
    expect(partialArtifact?.parentId).toBe('plan-step:task:task-recovered');
    expect(steps.filter((step) => step.id.startsWith('gate-issue:'))).toHaveLength(0);
    expect(steps.filter((step) => step.taskId === 'task-recovered' && step.status === 'blocked')).toHaveLength(0);
  });

  test('only projects explicit output artifacts and never fabricates availability verification', () => {
    const runtimeEvents = normalizeTaskSnapshot({
      id: 'task-artifact-boundary',
      taskId: 'task-artifact-boundary',
      runtime: 'subagent',
      status: 'completed',
      title: 'Render presentation',
      filePath: '/definitely/input/reference.png',
      path: '/definitely/input/source.json',
      media: { url: 'https://example.invalid/input-reference.png' },
      updatedAt: 2200,
    }, {
      filePath: '/definitely/input/another-reference.png',
      result: {
        artifacts: [{
          id: 'presentation-output',
          kind: 'presentation',
          title: 'Presentation output',
          filePath: '/definitely/missing/file.pptx',
        }],
      },
    });

    const artifacts = runtimeEvents.filter(
      (event): event is Extract<ChatRuntimeEvent, { type: 'artifact.produced' }> => event.type === 'artifact.produced',
    );
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0].artifact).toEqual(expect.objectContaining({
      id: 'presentation-output',
      filePath: '/definitely/missing/file.pptx',
    }));
    expect(runtimeEvents.some((event) => event.type === 'verification.completed')).toBe(false);
  });

  test('shows semantic tool progress and keeps an async video run open until the background task settles', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installChatMocks(app);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('做一条小米 SU7 Ultra 的 1 分钟横版宣传片，突出性能和科技感，要中文旁白。');
      await page.getByTestId('chat-composer-send').click();

      const now = Date.now();
      const describeEvents = [
        ['describe-contract', 'uclaw_declare_turn_contract'],
        ['describe-video', 'video_generate'],
        ['describe-search', 'web_search'],
      ].flatMap(([toolCallId, target], index): ChatRuntimeEvent[] => ([{
        type: 'tool.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId,
        name: 'tool_describe',
        args: { id: target },
        ts: now + index * 2 + 1,
      }, {
        type: 'tool.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId,
        name: 'tool_describe',
        result: { id: `openclaw:core:${target}`, name: target, label: target },
        ts: now + index * 2 + 2,
      }]));

      await emitRuntimeEvents(app, [{
        type: 'run.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        startedAt: now,
        ts: now,
      }, ...describeEvents, {
        type: 'tool.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'declare-contract',
        name: 'tool_call',
        args: {
          id: 'uclaw_declare_turn_contract',
          args: {
            intent: 'media',
            toolRequirement: 'required',
            sideEffect: 'remote_generation',
            sideEffectAuthorized: true,
          },
        },
        ts: now + 10,
      }, {
        type: 'tool.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'declare-contract',
        name: 'tool_call',
        result: {
          tool: { name: 'uclaw_declare_turn_contract', label: 'Declare UClaw turn contract' },
          result: { details: { ok: true } },
        },
        ts: now + 11,
      }, {
        type: 'tool.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'search-official-data',
        name: 'tool_call',
        args: {
          id: 'web_search',
          args: { query: '小米 SU7 Ultra 官方性能参数', count: 5 },
        },
        ts: now + 12,
      }, {
        type: 'tool.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'search-official-data',
        name: 'tool_call',
        result: {
          tool: { name: 'web_search', label: 'Web Search' },
          result: { details: { count: 5 } },
        },
        ts: now + 13,
      }, {
        type: 'tool.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'generate-video',
        name: 'tool_call',
        args: {
          id: 'video_generate',
          args: {
            action: 'generate',
            prompt: '电影级汽车宣传片'.repeat(200),
            durationSeconds: 60,
            size: '1920x1080',
            resolution: '1080P',
            aspectRatio: '16:9',
            audio: true,
          },
        },
        ts: now + 14,
      }, {
        type: 'tool.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        toolCallId: 'generate-video',
        name: 'tool_call',
        result: {
          tool: { name: 'video_generate', label: 'Video Generation' },
          result: {
            details: {
              async: true,
              status: 'started',
              taskId: 'video-task-1',
              runId: 'tool:video_generate:1',
              durationSeconds: 60,
              size: '1920x1080',
              resolution: '1080P',
              aspectRatio: '16:9',
              audio: true,
            },
          },
        },
        ts: now + 15,
      }]);

      const toolGroup = page.getByTestId('timeline-tool-group');
      await expect(toolGroup).toHaveCount(1);
      await expect(toolGroup).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('timeline-tool-details')).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('tool_describe');
      await expect(page.locator('body')).not.toContainText('tool_call');
      await expect(page.locator('body')).not.toContainText('uclaw_declare_turn_contract');
      await expect(page.locator('body')).not.toContainText('电影级汽车宣传片电影级汽车宣传片');

      await page.getByTestId('timeline-tool-group-toggle').click();
      const toolDetails = page.getByTestId('timeline-tool-details');
      await expect(toolDetails.locator(':scope > div')).toHaveCount(5);
      await expect(toolDetails).toContainText('小米 SU7 Ultra 官方性能参数');
      await expect(toolDetails).not.toContainText('durationSeconds');
      await page.getByTestId('timeline-tool-group-toggle').click();
      await expect(toolDetails).toHaveCount(0);

      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        runId: 'tool:video_generate:1',
        sessionKey: SESSION_KEY,
        task: {
          taskId: 'video-task-1',
          runtime: 'video_generate',
          title: '生成 1 分钟宣传片',
          status: 'running',
          updatedAt: now + 20,
        },
        ts: now + 20,
      }, {
        type: 'run.ended',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        status: 'completed',
        endedAt: now + 21,
        ts: now + 21,
      }]);

      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).toHaveAttribute('data-status', 'running');
      await expect(page.getByTestId('timeline-subtasks-toggle')).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByTestId('timeline-subtask-details')).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);

      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        runId: 'tool:video_generate:1',
        sessionKey: SESSION_KEY,
        task: {
          taskId: 'video-task-1',
          runtime: 'video_generate',
          title: '生成 1 分钟宣传片',
          detail: '视频生成服务暂时不可用（HTTP 503）',
          status: 'error',
          sourceStatus: 'failed',
          terminalOutcome: 'failed',
          updatedAt: now + 30,
          endedAt: now + 30,
        },
        ts: now + 30,
      }]);

      await expect(subtasks).toHaveAttribute('data-status', 'error');
      await page.getByTestId('timeline-subtasks-toggle').click();
      const subtaskDetails = page.getByTestId('timeline-subtask-details');
      await expect(subtaskDetails.locator(':scope > div')).toHaveCount(1);
      await expect(subtaskDetails).toContainText('生成 1 分钟宣传片');
      await expect(subtaskDetails).toContainText('HTTP 503');
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const graph = dialog.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible();
      const taskRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="video-task-1"]')
        .filter({ hasText: '生成 1 分钟宣传片' });
      await expect(taskRow).toHaveCount(1);
      await expect(taskRow).toHaveAttribute('data-step-status', 'error');
      await expect(taskRow).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(page.getByTestId('timeline-error')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('chat-generated-file')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('redacts runtime credentials from progress and expanded execution details', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const commandSecret = 'sk-proj-ui-secret12345';
    const errorSecret = 'private-cookie-value';

    try {
      await installChatMocks(app);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('检查运行时展示脱敏');
      await page.getByTestId('chat-composer-send').click();

      const now = Date.now();
      await emitRuntimeEvents(app, [{
        type: 'run.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        ts: now,
        startedAt: now,
      }, {
        type: 'tool.started',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        ts: now + 1,
        toolCallId: 'secret-exec',
        name: 'exec',
        args: {
          command: `curl -H "Authorization: Bearer ${commandSecret}" "https://host/file?X-Amz-Signature=signed-ui-secret"`,
        },
      }, {
        type: 'tool.completed',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        ts: now + 2,
        toolCallId: 'secret-exec',
        name: 'exec',
        isError: true,
        result: {
          details: {
            status: 'error',
            error: `{"cookie":"${errorSecret}","api_key":"sk-proj-error-ui-secret"}`,
          },
        },
      }, {
        type: 'run.ended',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        ts: now + 3,
        endedAt: now + 3,
        status: 'error',
        error: 'Runtime command failed',
      }]);

      const toolGroup = page.getByTestId('timeline-tool-group');
      await expect(toolGroup).toHaveCount(1);
      await expect(toolGroup).toHaveAttribute('data-status', 'error');
      const timelineError = page.getByTestId('timeline-error');
      await expect(timelineError).toHaveCount(1);
      await expect(page.locator('body')).not.toContainText(commandSecret);
      await expect(page.locator('body')).not.toContainText(errorSecret);
      await expect(page.locator('body')).not.toContainText('signed-ui-secret');
      await expect(page.locator('body')).not.toContainText('sk-proj-error-ui-secret');

      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const graph = dialog.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible();
      const secretExecRow = dialog.getByTestId('chat-execution-step').filter({ hasText: 'exec' });
      await expect(secretExecRow).toHaveCount(1);
      await expect(secretExecRow).toHaveAttribute('data-step-status', 'error');
      await expect(secretExecRow).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(graph).not.toContainText(commandSecret);
      await expect(graph).not.toContainText(errorSecret);
      await expect(graph).not.toContainText('signed-ui-secret');
      await expect(graph).not.toContainText('sk-proj-error-ui-secret');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('reattaches a cold-start terminal task to the historical user turn', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const now = Date.now();
    const historyMessages: RawMessage[] = [{
      id: 'history-video-user',
      role: 'user',
      content: '生成一段横版产品视频',
      timestamp: (now - 10_000) / 1000,
    }, {
      id: 'history-video-tool-call',
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'history-generate-video',
        name: 'tool_call',
        input: {
          id: 'video_generate',
          args: { durationSeconds: 5, size: '1280x720' },
        },
      }],
      timestamp: (now - 9_000) / 1000,
    }, {
      id: 'history-video-tool-result',
      role: 'toolresult',
      toolCallId: 'history-generate-video',
      toolName: 'tool_call',
      content: 'Background task started.',
      details: {
        async: true,
        status: 'started',
        taskId: 'cold-video-task',
        runId: 'tool:video_generate:cold',
      },
      timestamp: (now - 8_000) / 1000,
    }, {
      id: 'history-video-assistant',
      role: 'assistant',
      content: '视频任务已提交。',
      timestamp: (now - 7_000) / 1000,
    }];

    try {
      await installChatMocks(app, historyMessages);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await expect(page.getByText('生成一段横版产品视频')).toBeVisible();

      await emitRuntimeEvents(app, [{
        type: 'task.updated',
        runId: 'tool:video_generate:cold',
        sessionKey: SESSION_KEY,
        task: {
          taskId: 'cold-video-task',
          runtime: 'video_generate',
          title: '生成产品视频',
          detail: '后台任务恢复后确认生成失败',
          status: 'error',
          sourceStatus: 'failed',
          terminalOutcome: 'failed',
          createdAt: now - 120_000,
          updatedAt: now - 1_000,
          endedAt: now - 1_000,
        },
        ts: now - 1_000,
      }]);

      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).toHaveAttribute('data-status', 'error');
      await page.getByTestId('timeline-subtasks-toggle').click();
      const subtaskDetails = page.getByTestId('timeline-subtask-details');
      await expect(subtaskDetails.locator(':scope > div')).toHaveCount(1);
      await expect(subtaskDetails).toContainText('生成产品视频');
      await expect(subtaskDetails).toContainText('后台任务恢复后确认生成失败');

      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const graph = dialog.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible();
      const taskRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="cold-video-task"]')
        .filter({ hasText: '生成产品视频' });
      await expect(taskRow).toHaveCount(1);
      await expect(taskRow).toHaveAttribute('data-step-status', 'error');
      await expect(taskRow).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(taskRow).toContainText('生成产品视频');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders 0/2 -> 1/2 -> approval -> 2/2 as one native task flow', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installChatMocks(app);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Coordinate a release check with delegated work');
      await page.getByTestId('chat-composer-send').click();

      const now = Date.now();
      const parent = {
        id: 'task-parent',
        taskId: 'task-parent',
        runtime: 'subagent',
        kind: 'orchestration',
        flowId: 'flow-release-check',
        status: 'running',
        title: 'Coordinate release evidence',
        sessionKey: SESSION_KEY,
        updatedAt: now + 10,
      };
      const child = {
        id: 'task-child',
        taskId: 'task-child',
        parentTaskId: 'task-parent',
        runtime: 'subagent',
        kind: 'research',
        flowId: 'flow-release-check',
        status: 'running',
        title: 'Inspect deployment evidence',
        sessionKey: SESSION_KEY,
        updatedAt: now + 20,
      };
      await emitRuntimeEvents(app, [
        {
          type: 'run.started',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          startedAt: now,
          ts: now,
        },
        ...normalizeTaskSnapshot({ ...parent, updatedAt: now + 10 }),
        ...normalizeTaskSnapshot(child),
      ]);

      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(subtasks).toHaveCount(2);
      const parentSubtask = subtasks.nth(0);
      const childSubtask = subtasks.nth(1);
      await expect(parentSubtask).toHaveAttribute('data-status', 'running');
      await expect(childSubtask).toHaveAttribute('data-status', 'running');
      await expect(page.getByTestId('timeline-approval')).toHaveCount(0);
      // The default Timeline stays linear; the full graph mounts only through
      // the Turn-level execution details entry.
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const graph = dialog.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible({ timeout: 30_000 });
      await expect(graph).toHaveAttribute('data-compact-status', 'running');
      const parentRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="task-parent"]')
        .filter({ hasText: 'Coordinate release evidence' });
      const childRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="task-child"]')
        .filter({ hasText: 'Inspect deployment evidence' });
      await expect(parentRow).toHaveAttribute('data-step-status', 'running');
      await expect(childRow).toHaveAttribute('data-step-status', 'running');
      await expect(childRow).toHaveAttribute('data-parent-id', 'plan-step:task:task-parent');

      await emitRuntimeEvents(app, normalizeTaskSnapshot(
        {
          ...child,
          status: 'completed',
          deliveryStatus: 'delivered',
          terminalOutcome: 'succeeded',
          terminalSummary: 'Evidence bundle ready',
          updatedAt: now + 30,
          endedAt: now + 30,
        },
        {
          artifacts: [{
            id: 'release-evidence',
            kind: 'document',
            title: 'Release evidence',
            filePath: '/tmp/release-evidence.md',
          }],
          verifications: [{
            id: 'release-evidence-check',
            status: 'passed',
            kind: 'artifact.availability',
            title: 'Release evidence',
            artifactId: 'release-evidence',
          }],
        },
      ));
      await expect(graph).toHaveAttribute('data-compact-status', 'running');
      await expect(parentRow).toHaveAttribute('data-step-status', 'running');
      await expect(childRow).toHaveAttribute('data-step-status', 'completed');
      await expect(parentSubtask).toHaveAttribute('data-status', 'running');
      await expect(childSubtask).toHaveAttribute('data-status', 'completed');

      await emitRuntimeEvents(app, normalizeTaskSnapshot(
        {
          ...parent,
          status: 'waiting_approval',
          updatedAt: now + 40,
        },
        {
          approval: {
            title: 'Publish release notes',
            kind: 'external_action',
            status: 'pending',
            message: 'Review the external publish action.',
          },
        },
      ));
      const approvalRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="task-parent"]')
        .filter({ hasText: 'Publish release notes' });
      await expect(parentSubtask).toHaveAttribute('data-status', 'blocked');
      await expect(childSubtask).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('timeline-approval')).toHaveCount(1);
      await expect(page.getByTestId('timeline-approval')).toHaveAttribute('data-status', 'blocked');
      await expect(parentRow).toHaveAttribute('data-step-status', 'blocked');
      await expect(approvalRow).toHaveCount(1);
      await expect(approvalRow).toHaveAttribute('data-step-status', 'blocked');
      await expect(approvalRow).toHaveAttribute('data-parent-id', 'plan-step:task:task-parent');

      await emitRuntimeEvents(app, [
        ...normalizeGatewayChatRuntimeEvents({
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          taskId: 'task-parent',
          stream: 'approval',
          ts: now + 50,
          data: {
            itemId: 'task-parent',
            title: 'Publish release notes',
            kind: 'external_action',
            phase: 'resolved',
            status: 'approved',
            message: 'Approved in UClaw.',
          },
        }),
        ...normalizeTaskSnapshot({
        ...parent,
        status: 'completed',
        deliveryStatus: 'delivered',
        terminalOutcome: 'succeeded',
          terminalSummary: 'All delegated work completed',
          updatedAt: now + 60,
          endedAt: now + 60,
        }),
      ]);
      await expect(parentSubtask).toHaveAttribute('data-status', 'completed');
      await expect(childSubtask).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('timeline-approval')).toHaveCount(1);
      await expect(page.getByTestId('timeline-approval')).toHaveAttribute('data-status', 'completed');
      await expect(page.getByTestId('timeline-artifacts')).toHaveCount(1);
      await expect(page.getByTestId('timeline-verification')).toHaveCount(1);
      await expect(parentRow).toHaveAttribute('data-step-status', 'completed');
      await expect(childRow).toHaveAttribute('data-step-status', 'completed');
      await expect(approvalRow).toHaveCount(1);
      await expect(approvalRow).toHaveAttribute('data-step-status', 'completed');
      await expect(approvalRow).toHaveAttribute('data-parent-id', 'plan-step:task:task-parent');
      await expect(graph).toHaveAttribute('data-compact-status', 'running');

      await emitRuntimeEvents(app, [{
        type: 'run.ended',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        status: 'completed',
        endedAt: now + 70,
        ts: now + 70,
      }]);
      await expect(graph).toHaveAttribute('data-compact-status', 'completed');
      if ((await graph.getAttribute('data-collapsed')) === 'true') await graph.click();

      const flowRow = dialog.locator('[data-testid="chat-execution-step"]')
        .filter({ hasText: /Task Flow|任务流/u });
      const artifactRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="task-child"][data-parent-id="plan-step:task:task-child"]')
        .filter({ hasText: 'Release evidence' });
      const artifactVerificationRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="task-child"][data-parent-id="artifact:release-evidence"]')
        .filter({ hasText: 'Release evidence' });

      await expect(flowRow).toHaveCount(1);
      await expect(flowRow).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(parentRow).toHaveAttribute('data-step-status', 'completed');
      await expect(parentRow).toHaveAttribute('data-parent-id', 'plan-step:task-flow:flow-release-check');
      await expect(childRow).toHaveAttribute('data-step-status', 'completed');
      await expect(childRow).toHaveAttribute('data-parent-id', 'plan-step:task:task-parent');
      await expect(artifactRow).toHaveCount(1);
      await expect(artifactRow).toHaveAttribute('data-parent-id', 'plan-step:task:task-child');
      await expect(artifactVerificationRow).toHaveCount(1);
      await expect(artifactVerificationRow).toHaveAttribute('data-step-status', 'completed');

      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);

    } finally {
      await closeElectronApp(app);
    }
  });

  test('renders cancelled native task flow as stopped instead of failed', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installChatMocks(app);
      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-composer-input')).toBeEnabled({ timeout: 30_000 });
      await page.getByTestId('chat-composer-input').fill('Run and then cancel delegated work');
      await page.getByTestId('chat-composer-send').click();

      const now = Date.now();
      await emitRuntimeEvents(app, [
        {
          type: 'run.started',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          startedAt: now,
          ts: now,
        },
        ...normalizeTaskSnapshot({
          id: 'task-cancelled',
          taskId: 'task-cancelled',
          runtime: 'subagent',
          flowId: 'flow-cancelled',
          status: 'cancelled',
          title: 'Cancelled delegated work',
          updatedAt: now + 10,
          endedAt: now + 10,
        }),
        {
          type: 'run.ended',
          runId: RUN_ID,
          sessionKey: SESSION_KEY,
          status: 'aborted',
          endedAt: now + 20,
          ts: now + 20,
        },
      ]);

      const turn = page.getByTestId('conversation-turn');
      await expect(turn).toHaveCount(1);
      await expect(turn).toHaveAttribute('data-turn-status', 'aborted');
      const subtasks = page.getByTestId('timeline-subtasks');
      await expect(subtasks).toHaveCount(1);
      await expect(subtasks).not.toHaveAttribute('data-status', 'error');
      await page.getByTestId('timeline-subtasks-toggle').click();
      const subtaskDetails = page.getByTestId('timeline-subtask-details');
      await expect(subtaskDetails.locator(':scope > div')).toHaveCount(1);
      await expect(subtaskDetails).toContainText('Cancelled delegated work');
      await expect(subtaskDetails).toContainText(/aborted|cancelled|canceled|stopped|已中止|已取消|已停止/u);

      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('timeline-execution-details')).toHaveCount(1);
      await page.getByTestId('timeline-execution-details').click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      const graph = dialog.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible({ timeout: 30_000 });
      if ((await graph.getAttribute('data-collapsed')) === 'true') await graph.click();

      const flowRow = dialog.locator('[data-testid="chat-execution-step"]')
        .filter({ hasText: /Task Flow|任务流/u });
      const taskRow = dialog.locator('[data-testid="chat-execution-step"][data-task-id="task-cancelled"]')
        .filter({ hasText: 'Cancelled delegated work' });
      await expect(flowRow).toHaveCount(1);
      await expect(flowRow).toHaveAttribute('data-step-status', 'aborted');
      await expect(flowRow).toHaveAttribute('data-parent-id', 'agent-run');
      await expect(taskRow).toHaveCount(1);
      await expect(taskRow).toHaveAttribute('data-step-status', 'aborted');
      await expect(taskRow).toHaveAttribute('data-parent-id', 'plan-step:task-flow:flow-cancelled');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
