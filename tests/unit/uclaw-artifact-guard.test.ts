import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadGuard() {
  return await import(
    `${join(process.cwd(), 'resources', 'openclaw-plugins', 'uclaw-artifact-guard', 'index.mjs')}?t=${Date.now()}-${Math.random()}`
  );
}

type HookHandler = (event: unknown, ctx?: unknown) => unknown;
type ToolResultMiddleware = (event: unknown, ctx: unknown) => unknown | Promise<unknown>;

const RAW_SEVEN_ARTIFACT_PROMPT = '生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个';
const REQUIRED_ARTIFACT_LINE = '   - 产物要求：必须为这个子任务生成一个可见、可追踪的产物，并在回复或运行事件中给出产物路径/链接/卡片。';

function createHookRegistry(
  pluginModule: { default: { register(api: unknown): void } },
  apiExtras: Record<string, unknown> = {},
) {
  const hooks = new Map<string, HookHandler>();
  const toolResultMiddlewares: Array<{ handler: ToolResultMiddleware; options?: unknown }> = [];
  pluginModule.default.register({
    ...apiExtras,
    on(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
    registerHook(name: string, handler: HookHandler) {
      hooks.set(name, handler);
    },
    registerAgentToolResultMiddleware(handler: ToolResultMiddleware, options?: unknown) {
      toolResultMiddlewares.push({ handler, options });
    },
  });
  return { hooks, toolResultMiddlewares };
}

function registerHooks(pluginModule: { default: { register(api: unknown): void } }) {
  return createHookRegistry(pluginModule).hooks;
}

function registerHooksWithRuntimeEvents(pluginModule: { default: { register(api: unknown): void } }) {
  const emitAgentEvent = vi.fn((params: { stream: string }) => ({
    emitted: true,
    stream: params.stream,
  }));
  const { hooks, toolResultMiddlewares } = createHookRegistry(pluginModule, {
    agent: {
      events: {
        emitAgentEvent,
      },
    },
  });
  return { hooks, toolResultMiddlewares, emitAgentEvent };
}

function registerFinalizeHook(pluginModule: { default: { register(api: unknown): void } }) {
  const finalizeHook = registerHooks(pluginModule).get('before_agent_finalize');
  expect(finalizeHook).toBeTypeOf('function');
  return finalizeHook!;
}

describe('uclaw-artifact-guard', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('injects only compact base rules for ordinary diagnostic prompts', async () => {
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const promptHook = hooks.get('before_prompt_build');

    expect(promptHook).toBeTypeOf('function');
    const result = await promptHook!({
      runId: 'run-prompt-context',
      userMessage: '只读诊断当前 ClawX 项目，不要改文件。请引用证据路径。',
    }) as { appendSystemContext?: string };

    expect(result.appendSystemContext).toContain('简体中文');
    expect(result.appendSystemContext).toContain('普通工程诊断');
    expect(result.appendSystemContext).not.toContain('真实本地产物');
    expect(result.appendSystemContext).not.toContain('MEDIA:<absolute-path>');
    expect(result.appendSystemContext).not.toContain('~/.openclaw/media/outbound/');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('prompt-context'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"hasArtifactRule":false'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('做个电站维保'));
  });

  it('injects artifact delivery rules only for artifact-producing prompts', async () => {
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const promptHook = hooks.get('before_prompt_build');

    expect(promptHook).toBeTypeOf('function');
    const result = await promptHook!({
      runId: 'run-prompt-artifact-context',
      userMessage: '帮我生成一份电站维保方案 PPT',
    }) as { appendSystemContext?: string };

    expect(result.appendSystemContext).toContain('简体中文');
    expect(result.appendSystemContext).toContain('真实本地产物');
    expect(result.appendSystemContext).toContain('MEDIA:<absolute-path>');
    expect(result.appendSystemContext).toContain('~/.openclaw/media/outbound/');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('"hasArtifactRule":true'));
    expect(console.warn).not.toHaveBeenCalledWith(expect.stringContaining('做个电站维保'));
  });

  it('blocks internal plumbing messages before transcript write', async () => {
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const writeHook = hooks.get('before_message_write');

    expect(writeHook).toBeTypeOf('function');
    expect(writeHook!({
      message: {
        role: 'user',
        content: '[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.',
      },
    })).toEqual({ block: true });
    expect(writeHook!({
      message: {
        role: 'user',
        content: '[OpenClaw heartbeat poll]',
      },
    })).toEqual({ block: true });
    expect(writeHook!({
      message: {
        role: 'assistant',
        content: 'HEARTBEAT_OK',
      },
    })).toEqual({ block: true });
    expect(writeHook!({
      message: {
        role: 'user',
        content: '帮我分析一下 ClawX 为什么不像 Codex Desktop 聪明',
      },
    })).toBeUndefined();
  });

  it('rewrites bare /tmp screenshot outputs to the managed OpenClaw media directory', async () => {
    vi.stubEnv('OPENCLAW_STATE_DIR', '/tmp/uclaw-test-openclaw');
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const toolHook = hooks.get('before_tool_call');

    expect(toolHook).toBeTypeOf('function');
    const result = await toolHook!({
      runId: 'run-screenshot-rewrite',
      toolName: 'exec',
      params: {
        command: 'screencapture -x /tmp/uclaw_desktop_check2.png && file /tmp/uclaw_desktop_check2.png',
      },
    }) as { params?: { command?: string } };

    const managedDir = join(resolve('/tmp/uclaw-test-openclaw'), 'media', 'outbound');
    const outputPath = join(managedDir, 'uclaw_desktop_check2.png');
    expect(result.params?.command).toBe(
      `mkdir -p ${managedDir} && screencapture -x ${outputPath} && file ${outputPath}`,
    );
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('exec-screenshot-path-rewrite'));
  });

  it('does not rewrite ordinary non-screenshot /tmp file commands', async () => {
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const toolHook = hooks.get('before_tool_call');

    expect(toolHook).toBeTypeOf('function');
    const result = await toolHook!({
      runId: 'run-non-screenshot',
      toolName: 'exec',
      params: {
        command: 'ls -lh /tmp/report.pdf',
      },
    });

    expect(result).toBeUndefined();
  });

  it('blocks image generation tools without calling the host planner for media capability questions', async () => {
    vi.stubEnv('CLAWX_HOST_API_ORIGIN', 'http://127.0.0.1:13210');
    vi.stubEnv('CLAWX_HOST_API_TOKEN', 'host-token');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        plan: {
          action: 'chat',
          source: 'fallback',
          intentKind: 'current_non_media_task',
          currentTurnMediaRequest: false,
          confidence: 1,
          reason: 'local_fast_path_media_capability_inquiry',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const promptHook = hooks.get('before_prompt_build');
    const toolHook = hooks.get('before_tool_call');

    expect(promptHook).toBeTypeOf('function');
    expect(toolHook).toBeTypeOf('function');

    await promptHook!({
      runId: 'run-media-question',
      sessionKey: 'session-media-question',
      prompt: '我问你的是你用的生图模型是什么？',
      messages: [
        { role: 'user', content: '我问你的是你用的生图模型是什么？' },
      ],
    }, {
      runId: 'run-media-question',
      sessionKey: 'session-media-question',
    });

    expect(fetchMock).not.toHaveBeenCalled();

    const result = toolHook!({
      runId: 'run-media-question',
      sessionKey: 'session-media-question',
      toolName: 'image_generate',
      params: { action: 'generate', prompt: '生成一张说明图' },
    }, {
      runId: 'run-media-question',
      sessionKey: 'session-media-question',
    }) as { block?: boolean; blockReason?: string };

    expect(result).toEqual(expect.objectContaining({
      block: true,
      blockReason: expect.stringContaining('没有授权生成图片'),
    }));
  });

  it('does not call the host planner for ordinary chat prompts', async () => {
    vi.stubEnv('CLAWX_HOST_API_ORIGIN', 'http://127.0.0.1:13210');
    vi.stubEnv('CLAWX_HOST_API_TOKEN', 'host-token');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    await hooks.get('before_prompt_build')!({
      runId: 'run-ordinary-chat',
      sessionKey: 'session-ordinary-chat',
      prompt: '帮我分析一下为什么现在像普通聊天壳子',
      messages: [
        { role: 'user', content: '帮我分析一下为什么现在像普通聊天壳子' },
      ],
    }, {
      runId: 'run-ordinary-chat',
      sessionKey: 'session-ordinary-chat',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const result = hooks.get('before_tool_call')!({
      runId: 'run-ordinary-chat',
      sessionKey: 'session-ordinary-chat',
      toolName: 'image_generate',
      params: { action: 'generate', prompt: '配图' },
    }, {
      runId: 'run-ordinary-chat',
      sessionKey: 'session-ordinary-chat',
    }) as { block?: boolean };

    expect(result?.block).toBe(true);
  });

  it('allows image generation tools only when planner authorizes a current media task', async () => {
    vi.stubEnv('CLAWX_HOST_API_ORIGIN', 'http://127.0.0.1:13210');
    vi.stubEnv('CLAWX_HOST_API_TOKEN', 'host-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        plan: {
          action: 'image_generate',
          source: 'fallback',
          intentKind: 'current_media_task',
          currentTurnMediaRequest: true,
          confidence: 1,
          reason: 'local_fast_path_image_generate',
        },
      }),
    }));

    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    await hooks.get('before_prompt_build')!({
      runId: 'run-image-task',
      sessionKey: 'session-image-task',
      prompt: '画一张城市夜景',
    }, {
      runId: 'run-image-task',
      sessionKey: 'session-image-task',
    });

    const result = hooks.get('before_tool_call')!({
      runId: 'run-image-task',
      sessionKey: 'session-image-task',
      toolName: 'image_generate',
      params: { action: 'generate', prompt: '画一张城市夜景' },
    }, {
      runId: 'run-image-task',
      sessionKey: 'session-image-task',
    });

    expect(result).toBeUndefined();
  });

  it('allows read-only media tool actions without current-turn generation authorization', async () => {
    const pluginModule = await loadGuard();
    const hooks = registerHooks(pluginModule);
    const result = hooks.get('before_tool_call')!({
      runId: 'run-media-status',
      sessionKey: 'session-media-status',
      toolName: 'image_generate',
      params: { action: 'status' },
    }, {
      runId: 'run-media-status',
      sessionKey: 'session-media-status',
    });

    expect(result).toBeUndefined();
  });

  it('emits native progress updates before a tool call starts', async () => {
    const pluginModule = await loadGuard();
    const { hooks, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);

    const result = hooks.get('before_tool_call')!({
      runId: 'run-native-progress-start',
      sessionKey: 'session-native-progress-start',
      toolCallId: 'call-open-music',
      toolName: 'exec',
      params: {
        command: 'open -a "QQMusic"',
      },
    }, {
      runId: 'run-native-progress-start',
      sessionKey: 'session-native-progress-start',
    });

    expect(result).toBeUndefined();
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-native-progress-start',
      sessionKey: 'session-native-progress-start',
      stream: 'progress',
      data: expect.objectContaining({
        entry: expect.objectContaining({
          id: 'progress:native:tool:call-open-music:commentary',
          kind: 'commentary',
          text: '我先尝试打开 QQMusic。',
          toolCallId: 'call-open-music',
          source: 'native',
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-native-progress-start',
      sessionKey: 'session-native-progress-start',
      stream: 'progress',
      data: expect.objectContaining({
        entry: expect.objectContaining({
          id: 'progress:native:tool:call-open-music',
          kind: 'action',
          text: '正在执行',
          status: 'running',
          command: 'open -a "QQMusic"',
          toolCallId: 'call-open-music',
          source: 'native',
        }),
      }),
    }));
  });

  it('registers an OpenClaw tool-result middleware as an execution event producer', async () => {
    const pluginModule = await loadGuard();
    const { toolResultMiddlewares } = createHookRegistry(pluginModule);

    expect(toolResultMiddlewares).toHaveLength(1);
    expect(toolResultMiddlewares[0]?.options).toEqual({
      runtimes: ['openclaw'],
    });
  });

  it('emits native completion progress when a tool result arrives', async () => {
    const pluginModule = await loadGuard();
    const { toolResultMiddlewares, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);

    await toolResultMiddlewares[0]?.handler({
      toolCallId: 'call-read-capabilities',
      toolName: 'read',
      result: { summary: 'done' },
      isError: false,
    }, {
      runId: 'run-native-progress-result',
      sessionKey: 'session-native-progress-result',
    });

    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-native-progress-result',
      sessionKey: 'session-native-progress-result',
      stream: 'progress',
      data: expect.objectContaining({
        entry: expect.objectContaining({
          id: 'progress:native:tool:call-read-capabilities',
          kind: 'action',
          text: '已读取相关内容',
          status: 'completed',
          toolCallId: 'call-read-capabilities',
          source: 'native',
        }),
      }),
    }));
  });

  it('summarizes bloated session jsonl exec results before they stay model-visible in transcript', async () => {
    const pluginModule = await loadGuard();
    const { toolResultMiddlewares, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
    const middleware = toolResultMiddlewares[0]?.handler;
    expect(middleware).toBeTypeOf('function');

    const hugeJsonl = Array.from({ length: 90 }, (_, index) => JSON.stringify({
      sessionId: 'agent:main:main',
      messageId: `msg-${index}`,
      role: 'assistant',
      content: `payload-${index}-${'x'.repeat(64)}`,
    })).join('\n');
    const toolEvent = {
      toolCallId: 'call-session-jsonl',
      toolName: 'exec',
      args: {
        command: 'cat ~/.openclaw/agents/main/sessions/agent-main.jsonl',
      },
      result: {
        content: [{ type: 'text', text: hugeJsonl }],
        details: {
          status: 'ok',
          stdout: hugeJsonl,
        },
      },
    };

    const middlewareResult = await middleware!(toolEvent, {
      runId: 'run-session-jsonl',
      sessionKey: 'agent:main:main',
      runtime: 'openclaw',
    }) as { result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } } | undefined;

    const compactText = middlewareResult?.result?.content?.[0]?.text ?? '';
    expect(compactText).toContain('已收敛高膨胀 exec 结果');
    expect(compactText).toContain('session/jsonl');
    expect(compactText).toContain('模型可见 transcript');
    expect(compactText).toContain('agent-main.jsonl');
    expect(compactText).not.toContain('"messageId":"msg-70"');
    expect(toolEvent.result.content[0]?.text).toBe(compactText);
    expect(middlewareResult?.result?.details).toMatchObject({
      summarizedForModel: true,
      summaryKind: 'tool_result_transcript_compaction',
    });
    expect(Array.isArray(middlewareResult?.result?.details?.categories)).toBe(true);
    expect(middlewareResult?.result?.details?.categories).toEqual(expect.arrayContaining(['session/jsonl']));
    expect(Number(middlewareResult?.result?.details?.omittedLines)).toBeGreaterThanOrEqual(90);
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-session-jsonl',
      stream: 'step',
      data: expect.objectContaining({
        step: expect.objectContaining({
          id: 'tool:call-session-jsonl',
          status: 'completed',
        }),
      }),
    }));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('tool-result-transcript-compact'));
  });

  it('keeps MEDIA evidence while compacting bloated transcript or log reads', async () => {
    const pluginModule = await loadGuard();
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-tool-result-media-'));
    const artifactPath = join(tempDir, 'result.png');
    writeFileSync(artifactPath, 'png');

    try {
      const { toolResultMiddlewares } = registerHooksWithRuntimeEvents(pluginModule);
      const middleware = toolResultMiddlewares[0]?.handler;
      expect(middleware).toBeTypeOf('function');

      const bulkyLog = Array.from({ length: 70 }, (_, index) => `log-${index} ${'y'.repeat(72)}`).join('\n');
      const toolEvent = {
        toolCallId: 'call-log-read',
        toolName: 'read',
        args: {
          filePath: '~/.openclaw/agents/main/trajectory/run.trajectory.jsonl',
        },
        result: {
          content: [{
            type: 'text',
            text: `${bulkyLog}\nMEDIA:${artifactPath}\n${bulkyLog}`,
          }],
          details: {
            status: 'ok',
            outputPath: artifactPath,
            stdout: bulkyLog,
          },
        },
      };

      const middlewareResult = await middleware!(toolEvent, {
        runId: 'run-log-read',
        sessionKey: 'agent:main:main',
        runtime: 'openclaw',
      }) as { result?: { content?: Array<{ text?: string }>; details?: Record<string, unknown> } } | undefined;

      const compactText = middlewareResult?.result?.content?.[0]?.text ?? '';
      expect(compactText).toContain('trajectory');
      expect(compactText).toContain(`MEDIA:${artifactPath}`);
      expect(compactText).not.toContain(`log-55 ${'y'.repeat(72)}`);
      expect(middlewareResult?.result?.details).toMatchObject({
        summarizedForModel: true,
        outputPath: artifactPath,
        preservedArtifactRefs: [`MEDIA:${artifactPath}`],
      });
      expect(toolEvent.result.content[0]?.text).toBe(compactText);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('forces heartbeat polls to return only the internal heartbeat sentinel', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      runId: 'run-heartbeat-leaked-promise',
      messages: [
        { role: 'user', content: '太丑了 你自己看看' },
        { role: 'assistant', content: '我直接重做一版更干净高级的。' },
        { role: 'user', content: '[OpenClaw heartbeat poll]' },
        { role: 'assistant', content: '上次确实没完成重做，我现在直接补一版更像发布会风格的高级版。' },
      ],
    }) as { action?: string; retry?: { instruction?: string; maxAttempts?: number }; reason?: string } | undefined;

    expect(result?.action).toBe('revise');
    expect(result?.reason).toContain('heartbeat poll');
    expect(result?.retry?.instruction).toContain('HEARTBEAT_OK');
    expect(result?.retry?.maxAttempts).toBe(1);

    const analysis = pluginModule.__test.analyzeArtifactFinal({
      messages: [
        { role: 'user', content: '[OpenClaw heartbeat poll]' },
        { role: 'assistant', content: '上次确实没完成重做，我现在直接补一版更像发布会风格的高级版。' },
      ],
    });
    expect(analysis).toMatchObject({
      heartbeatPoll: true,
      heartbeatOk: false,
      shouldReviseHeartbeat: true,
      shouldRevise: true,
    });
  });

  it('allows heartbeat polls that return HEARTBEAT_OK', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const event = {
      runId: 'run-heartbeat-ok',
      messages: [
        { role: 'user', content: '[OpenClaw heartbeat poll]' },
        { role: 'assistant', content: 'HEARTBEAT_OK' },
      ],
    };

    expect(finalizeHook(event)).toBeUndefined();
    expect(pluginModule.__test.analyzeArtifactFinal(event)).toMatchObject({
      heartbeatPoll: true,
      heartbeatOk: true,
      shouldReviseHeartbeat: false,
      shouldRevise: false,
    });
  });

  it('treats artifact capability questions as chat instead of artifact delivery requests', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const capabilityPrompts = [
      '你现在能做哪些文件类产物？',
      '普通聊天：你现在能做哪些文件类产物？',
      'PPT/Excel/小程序你能做吗？',
      '你支持生成哪些文件？',
    ];

    for (const prompt of capabilityPrompts) {
      const event = {
        runId: `run-artifact-capability-${capabilityPrompts.indexOf(prompt)}`,
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: '我可以做 PPT、Excel、Word/PDF 文档、网页/小程序、图片、视频和文案等文件类产物。' },
        ],
      };

      expect(pluginModule.__test.isArtifactCapabilityQuestion(prompt)).toBe(true);
      expect(pluginModule.__test.isArtifactRequest(prompt)).toBe(false);
      expect(finalizeHook(event)).toBeUndefined();
      expect(pluginModule.__test.analyzeArtifactFinal(event)).toMatchObject({
        artifactRequest: false,
        requiredEffects: [],
        shouldRevise: false,
      });
    }
  });

  it('classifies promise-only artifact replies as revision candidates', async () => {
    const pluginModule = await loadGuard();

    const analysis = pluginModule.__test.analyzeArtifactFinal({
      messages: [
        { role: 'user', content: '帮我生成一份产品介绍 PPT' },
        { role: 'assistant', content: '我会生成一份 PPT，并整理好页面结构。' },
      ],
    });

    expect(analysis).toMatchObject({
      artifactRequest: true,
      artifactEvidence: false,
      verificationPassed: false,
      explicitBlocker: false,
      promiseOnly: true,
      shouldRevise: true,
    });
    expect(analysis.requiredEffects).toEqual([
      expect.objectContaining({
        type: 'create_artifact',
        intent: 'artifact_delivery',
        kind: 'presentation',
        minCount: 1,
        afterLatestUser: true,
      }),
    ]);
    expect(analysis.effectResults).toEqual([
      expect.objectContaining({
        satisfied: false,
        effect: expect.objectContaining({ type: 'create_artifact' }),
      }),
    ]);
    expect(analysis.artifacts).toEqual([]);
  });

  it('retries artifact requests that end with an unexecuted promise', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      finalPromptText: '做个电站维保的招投标书，做20页',
      lastAssistantMessage: '我会生成一份真实的 Word 标书文件，按 20 页结构排版，并用分页符控制页数。',
      messages: [
        { role: 'user', content: '做个电站维保的招投标书，做20页' },
        { role: 'assistant', content: '我会生成一份真实的 Word 标书文件，按 20 页结构排版，并用分页符控制页数。' },
      ],
    }) as { action?: string; retry?: { instruction?: string; maxAttempts?: number }; reason?: string } | undefined;

    expect(result?.action).toBe('revise');
    expect(result?.reason).toContain('artifact delivery');
    expect(result?.retry?.instruction).toContain('真实本地产物');
    expect(result?.retry?.instruction).toContain('Node/Python/uv');
    expect(result?.retry?.instruction).toContain('MEDIA:<absolute-path>');
    expect(result?.retry?.maxAttempts).toBe(2);
  });

  it('retries artifact requests that claim completion without evidence', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      finalPromptText: '帮我生成一份产品介绍 PPT',
      lastAssistantMessage: '已完成，我把产品介绍内容都整理好了。',
      messages: [
        { role: 'user', content: '帮我生成一份产品介绍 PPT' },
        { role: 'assistant', content: '已完成，我把产品介绍内容都整理好了。' },
      ],
    }) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;

    expect(result?.action).toBe('revise');
    expect(result?.reason).toContain('artifact delivery');
    expect(result?.retry?.instruction).toContain('MEDIA:<absolute-path>');
  });

  it('retries revision feedback on a previous artifact when the assistant only promises to remake it', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-artifact-revision-'));
    const oldPpt = join(tempDir, 'iphone18-old.pptx');
    writeFileSync(oldPpt, 'old');

    try {
      const event = {
        runId: 'run-artifact-revision-feedback',
        messages: [
          { role: 'user', content: '生成一个苹果18的宣传ppt' },
          { role: 'assistant', content: `已生成。\n\nMEDIA:${oldPpt}` },
          { role: 'user', content: '太丑了 你自己看看' },
          { role: 'assistant', content: '我看了，上一版确实太像占位模板。我直接重做一版更干净高级的。' },
        ],
      };

      const result = finalizeHook(event) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;
      expect(result?.action).toBe('revise');
      expect(result?.reason).toContain('artifact revision');
      expect(result?.retry?.instruction).toContain('新的非覆盖改进版');
      expect(result?.retry?.instruction).toContain('MEDIA:<absolute-path>');

      const analysis = pluginModule.__test.analyzeArtifactFinal(event);
      expect(analysis).toMatchObject({
        latestUserText: '太丑了 你自己看看',
        artifactRequest: true,
        artifactRevisionFeedback: true,
        artifactRevisionRequest: true,
        priorArtifactEvidence: true,
        artifactEvidence: false,
        verificationPassed: false,
        shouldRevise: true,
      });
      expect(analysis.requiredEffects).toEqual([
        expect.objectContaining({
          type: 'create_artifact_revision',
          intent: 'artifact_revision',
          kind: 'presentation',
          mustBeNewArtifact: true,
          targetArtifactRef: oldPpt,
        }),
      ]);
      expect(analysis.effectResults).toEqual([
        expect.objectContaining({
          satisfied: false,
          effect: expect.objectContaining({ type: 'create_artifact_revision' }),
        }),
      ]);
      expect(analysis.priorArtifactCount).toBeGreaterThanOrEqual(1);
      expect(analysis.artifacts).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not let an old artifact path satisfy a requested revision', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-artifact-revision-old-path-'));
    const oldPpt = join(tempDir, 'iphone18-old.pptx');
    writeFileSync(oldPpt, 'old');

    try {
      const event = {
        runId: 'run-artifact-revision-old-path',
        messages: [
          { role: 'user', content: '生成一个苹果18的宣传ppt' },
          { role: 'assistant', content: `已生成。\n\nMEDIA:${oldPpt}` },
          { role: 'user', content: '太丑了 你自己看看' },
          { role: 'assistant', content: `我优化好了。\n\nMEDIA:${oldPpt}` },
        ],
      };

      const result = finalizeHook(event) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;
      expect(result?.action).toBe('revise');

      const analysis = pluginModule.__test.analyzeArtifactFinal(event);
      expect(analysis).toMatchObject({
        artifactRevisionRequest: true,
        artifactEvidence: true,
        verificationPassed: true,
        shouldRevise: true,
      });
      expect(analysis.effectResults).toEqual([
        expect.objectContaining({
          satisfied: false,
          reason: expect.stringContaining('非覆盖新产物'),
        }),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('allows revision feedback when the assistant delivers a new artifact after the latest user message', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-artifact-revision-ok-'));
    const oldPpt = join(tempDir, 'iphone18-old.pptx');
    const newPpt = join(tempDir, 'iphone18-new.pptx');
    writeFileSync(oldPpt, 'old');
    writeFileSync(newPpt, 'new');

    try {
      const event = {
        runId: 'run-artifact-revision-ok',
        messages: [
          { role: 'user', content: '生成一个苹果18的宣传ppt' },
          { role: 'assistant', content: `已生成。\n\nMEDIA:${oldPpt}` },
          { role: 'user', content: '太丑了 你自己看看' },
          { role: 'assistant', content: `已重做并验证。\n\nMEDIA:${newPpt}` },
        ],
      };

      expect(finalizeHook(event)).toBeUndefined();
      const analysis = pluginModule.__test.analyzeArtifactFinal(event);
      expect(analysis).toMatchObject({
        artifactRevisionRequest: true,
        priorArtifactEvidence: true,
        artifactEvidence: true,
        verificationPassed: true,
        shouldRevise: false,
      });
      expect(analysis.requiredEffects).toEqual([
        expect.objectContaining({
          type: 'create_artifact_revision',
          kind: 'presentation',
          mustBeNewArtifact: true,
        }),
      ]);
      expect(analysis.effectResults).toEqual([
        expect.objectContaining({
          satisfied: true,
          matchedArtifactIds: [expect.stringMatching(/^artifact:/)],
        }),
      ]);
      expect(analysis.artifacts.map(({ artifact }) => artifact.filePath)).toContain(newPpt);
      expect(analysis.artifacts.map(({ artifact }) => artifact.filePath)).not.toContain(oldPpt);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retries D01-style repair promises even when an earlier artifact exists', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-d01-promise-only-'));
    const deckPath = join(tempDir, 'AI-workflow-team-efficiency.pptx');
    writeFileSync(deckPath, 'pptx');

    try {
      const event = {
        runId: 'run-d01-promise-only',
        messages: [
          { role: 'user', content: '做一个 8 页 PPT：《AI 工作流如何提升团队效率》，要有目录、痛点、方案、案例、ROI、落地计划' },
          { role: 'assistant', content: `已生成初版。\n\nMEDIA:${deckPath}` },
          { role: 'assistant', content: `刚才工具自动额外加了一页封面，实际生成了 9 页。\n\nMEDIA:${deckPath}\n\n我直接重做一个严格 8 页版本并重新校验。` },
        ],
      };

      const result = finalizeHook(event) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;
      expect(result?.action).toBe('revise');
      expect(result?.reason).toContain('artifact delivery');

      const analysis = pluginModule.__test.analyzeArtifactFinal(event);
      expect(analysis).toMatchObject({
        artifactRequest: true,
        artifactEvidence: true,
        verificationPassed: true,
        finalArtifactEvidence: true,
        finalVerificationPassed: true,
        promiseOnly: true,
        artifactRepairPromise: true,
        unfinishedArtifactPromise: true,
        shouldRevise: true,
      });
      expect(analysis.artifacts.map(({ artifact }) => artifact.filePath)).toContain(deckPath);
      expect(analysis.finalArtifacts.map(({ artifact }) => artifact.filePath)).toContain(deckPath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retries F03-style validator repair promises after a web artifact bug is detected', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-f03-validator-promise-'));
    const htmlPath = join(tempDir, 'activity-signup.html');
    writeFileSync(htmlPath, '<!doctype html><html><body><section class="success-state">报名成功</section></body></html>');

    try {
      const event = {
        runId: 'run-f03-validator-promise',
        messages: [
          { role: 'user', content: '做一个活动报名页面，包含表单校验和报名成功状态，单文件 HTML，必须保存成真实本地文件，做完后自己检查主要交互。' },
          { role: 'assistant', content: `已生成并开始自测。\n\nMEDIA:${htmlPath}` },
          { role: 'assistant', content: '浏览器校验发现报名成功状态首屏可见，不符合交互预期。我先修掉再继续测。' },
        ],
      };

      const result = finalizeHook(event) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;
      expect(result?.action).toBe('revise');
      expect(result?.reason).toContain('artifact delivery');

      const analysis = pluginModule.__test.analyzeArtifactFinal(event);
      expect(analysis).toMatchObject({
        artifactRequest: true,
        artifactEvidence: true,
        verificationPassed: true,
        finalArtifactEvidence: false,
        finalVerificationPassed: false,
        promiseOnly: true,
        unfinishedArtifactPromise: true,
        shouldRevise: true,
      });
      expect(analysis.artifacts.map(({ artifact }) => artifact.filePath)).toContain(htmlPath);
      expect(analysis.finalArtifacts).toEqual([]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('counts raw seven-item composite artifact prompts without an injected contract', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-raw-composite-guard-'));
    const imagePath = join(tempDir, 'image.png');
    writeFileSync(imagePath, 'ok');

    try {
      const event = {
        runId: 'run-raw-composite-final',
        messages: [
          { role: 'user', content: RAW_SEVEN_ARTIFACT_PROMPT },
          { role: 'assistant', content: `已生成第一张图。\n\nMEDIA:${imagePath}` },
          { role: 'assistant', content: '只完成了第一项。' },
        ],
      };

      const result = finalizeHook(event) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;
      expect(result?.action).toBe('revise');

      const analysis = pluginModule.__test.analyzeArtifactFinal(event);
      expect(analysis).toMatchObject({
        artifactRequest: true,
        compositeRequiredArtifactCount: 0,
        rawCompositeRequiredArtifactCount: 7,
        requiredArtifactCount: 7,
        passedArtifactCount: 1,
        missingRequiredArtifactCount: 6,
        shouldRevise: true,
      });
      expect(analysis.requiredEffects).toHaveLength(7);
      expect(analysis.requiredEffects.map((effect) => effect.kind)).toEqual([
        'image',
        'presentation',
        'spreadsheet',
        'video',
        'image',
        'webpage',
        'document',
      ]);
      expect(analysis.effectResults.filter((result) => result.satisfied)).toHaveLength(1);
      expect(analysis.missingRequiredEffects).toHaveLength(6);
      expect(analysis.artifacts).toHaveLength(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retries full seven-item composite contracts until every required subtask has artifact evidence', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-composite-guard-'));
    const imagePath = join(tempDir, 'image.png');
    writeFileSync(imagePath, 'ok');

    try {
      const compositePrompt = [
        RAW_SEVEN_ARTIFACT_PROMPT,
        '',
        '【UClaw composite execution contract】',
        '这是一个组合任务，请按下面合同执行：',
        '子任务清单：',
        '1. [图片生成] 生成图片',
        REQUIRED_ARTIFACT_LINE,
        '2. [演示文稿] 制作 PPT',
        REQUIRED_ARTIFACT_LINE,
        '3. [表格] 制作 Excel',
        REQUIRED_ARTIFACT_LINE,
        '4. [视频生成] 生成视频',
        REQUIRED_ARTIFACT_LINE,
        '5. [图片编辑] 根据图片修图',
        REQUIRED_ARTIFACT_LINE,
        '6. [小程序] 做小程序',
        REQUIRED_ARTIFACT_LINE,
        '7. [文案] 生成文案',
        REQUIRED_ARTIFACT_LINE,
      ].join('\n');
      const result = finalizeHook({
        runId: 'run-composite-final',
        messages: [
          { role: 'user', content: compositePrompt },
          { role: 'assistant', content: `已生成第一张图。\n\nMEDIA:${imagePath}` },
          { role: 'assistant', content: '继续收尾：我先把不依赖后台生成的文件产物做出来。' },
        ],
      }) as { action?: string; retry?: { instruction?: string }; reason?: string } | undefined;

      expect(result?.action).toBe('revise');
      const analysis = pluginModule.__test.analyzeArtifactFinal({
        messages: [
          { role: 'user', content: compositePrompt },
          { role: 'assistant', content: `已生成第一张图。\n\nMEDIA:${imagePath}` },
          { role: 'assistant', content: '继续收尾：我先把不依赖后台生成的文件产物做出来。' },
        ],
      });
      expect(analysis).toMatchObject({
        artifactRequest: true,
        compositeRequiredArtifactCount: 7,
        rawCompositeRequiredArtifactCount: 7,
        requiredArtifactCount: 7,
        passedArtifactCount: 1,
        missingRequiredArtifactCount: 6,
        shouldRevise: true,
      });
      expect(analysis.requiredEffects).toHaveLength(7);
      expect(analysis.missingRequiredEffects).toHaveLength(6);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('revises WeChat desktop-message replies when no reliable connector evidence exists', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      runId: 'run-wechat-no-evidence',
      messages: [
        { role: 'user', content: '帮我打开微信并给Uclaw技术保障群发一条消息，内容你随便生成' },
        { role: 'assistant', content: '好的，我现在打开微信并发送一条测试消息。' },
      ],
    }) as { action?: string; retry?: { instruction?: string; maxAttempts?: number }; reason?: string } | undefined;

    expect(result?.action).toBe('revise');
    expect(result?.reason).toContain('desktop or external message action');
    expect(result?.retry?.instruction).toContain('可靠结构化 connector');
    expect(result?.retry?.instruction).toContain('不要建议启用 uclaw-computer-use');
    expect(result?.retry?.instruction).toContain('未发送');
    expect(result?.retry?.maxAttempts).toBe(1);

    const analysis = pluginModule.__test.analyzeArtifactFinal({
      runId: 'run-wechat-no-evidence',
      messages: [
        { role: 'user', content: '帮我打开微信并给Uclaw技术保障群发一条消息，内容你随便生成' },
        { role: 'assistant', content: '好的，我现在打开微信并发送一条测试消息。' },
      ],
    });
    expect(analysis.requiredEffects).toEqual([
      expect.objectContaining({
        type: 'external_action',
        intent: 'desktop_or_message_action',
        kind: 'desktop_or_message',
      }),
    ]);
    expect(analysis.missingRequiredEffects).toHaveLength(1);
  });

  it('allows WeChat desktop-message blockers that clearly say the message was not sent', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      runId: 'run-wechat-blocked',
      messages: [
        { role: 'user', content: '帮我打开微信并给Uclaw技术保障群发一条消息，内容你随便生成' },
        {
          role: 'assistant',
          content: '当前运行时没有可用的可靠微信 connector，不能直接打开本机微信或代发群消息。消息未发送。草稿：UClaw 保障测试消息。',
        },
      ],
    }) as { action?: string } | undefined;

    expect(result).toBeUndefined();
    const analysis = pluginModule.__test.analyzeArtifactFinal({
      messages: [
        { role: 'user', content: '帮我打开微信并给Uclaw技术保障群发一条消息，内容你随便生成' },
        {
          role: 'assistant',
          content: '当前运行时没有可用的可靠微信 connector，不能直接打开本机微信或代发群消息。消息未发送。草稿：UClaw 保障测试消息。',
        },
      ],
    });
    expect(analysis).toMatchObject({
      desktopActionRequest: true,
      desktopActionEvidence: false,
      explicitBlocker: true,
      shouldRevise: false,
    });
  });

  it('allows artifact replies that include a concrete file path', async () => {
    const pluginModule = await loadGuard();
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-artifact-guard-'));
    const artifactPath = join(tempDir, 'station-report.docx');
    writeFileSync(artifactPath, 'ok');

    try {
      const { hooks, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
      const finalizeHook = hooks.get('before_agent_finalize');
      expect(finalizeHook).toBeTypeOf('function');

      const result = finalizeHook!({
        runId: 'run-artifact-ok',
        sessionKey: 'agent:main:main',
        messages: [
          { role: 'user', content: '做个电站维保的招投标书，做20页' },
          {
            role: 'assistant',
            content: `已生成并验证。\n\nMEDIA:${artifactPath}`,
          },
        ],
      });

      expect(result).toBeUndefined();
      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-artifact-ok',
        sessionKey: 'agent:main:main',
        stream: 'artifact',
        contractVersion: 1,
        producer: 'uclaw-artifact-guard',
        ts: expect.any(Number),
        seq: expect.any(Number),
        data: expect.objectContaining({
          artifact: expect.objectContaining({
            filePath: artifactPath,
            kind: 'document',
            mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            sizeBytes: 2,
          }),
        }),
      }));
      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-artifact-ok',
        sessionKey: 'agent:main:main',
        stream: 'verification',
        data: expect.objectContaining({
          verification: expect.objectContaining({
            status: 'passed',
            evidence: 'stat ok; sizeBytes=2',
          }),
        }),
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits artifacts from structured top-level tool result outputPath fields', async () => {
    const pluginModule = await loadGuard();
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-artifact-guard-tool-'));
    const artifactPath = join(tempDir, 'tool-output.docx');
    writeFileSync(artifactPath, 'ok');

    try {
      const { toolResultMiddlewares, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);

      expect(toolResultMiddlewares[0]?.handler).toBeTypeOf('function');
      await toolResultMiddlewares[0]!.handler({
        toolCallId: 'call-structured',
        toolName: 'create_document',
        result: {
          outputPath: artifactPath,
          artifacts: [{ filePath: artifactPath }],
          details: { status: 'ok' },
        },
      }, {
        runId: 'run-tool-structured',
        sessionKey: 'agent:main:main',
      });

      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-tool-structured',
        sessionKey: 'agent:main:main',
        stream: 'artifact',
        contractVersion: 1,
        producer: 'uclaw-artifact-guard',
        ts: expect.any(Number),
        seq: expect.any(Number),
        data: expect.objectContaining({
          artifact: expect.objectContaining({
            filePath: artifactPath,
            sourceToolCallId: 'call-structured',
          }),
        }),
      }));
      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-tool-structured',
        stream: 'verification',
        data: expect.objectContaining({
          verification: expect.objectContaining({
            status: 'passed',
            artifactId: expect.stringMatching(/^artifact:/),
          }),
        }),
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('retries artifact replies when the referenced file is not available', async () => {
    const pluginModule = await loadGuard();
    const { hooks, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
    const finalizeHook = hooks.get('before_agent_finalize');
    expect(finalizeHook).toBeTypeOf('function');
    const missingPath = join(tmpdir(), `uclaw-missing-${Date.now()}-${Math.random()}.docx`);

    const result = finalizeHook!({
      runId: 'run-artifact-missing',
      messages: [
        { role: 'user', content: '做个电站维保的招投标书，做20页' },
        {
          role: 'assistant',
          content: `已生成。\n\nMEDIA:${missingPath}`,
        },
      ],
    }) as { action?: string; reason?: string } | undefined;

    expect(result?.action).toBe('revise');
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-artifact-missing',
      stream: 'artifact',
      data: expect.objectContaining({
        artifact: expect.objectContaining({
          filePath: missingPath,
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-artifact-missing',
      stream: 'verification',
      data: expect.objectContaining({
        verification: expect.objectContaining({
          status: 'blocked',
          evidence: missingPath,
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-artifact-missing',
      stream: 'issue',
      data: expect.objectContaining({
        issue: expect.objectContaining({
          code: 'artifact.required.missing',
          severity: 'blocking',
          recoverable: true,
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-artifact-missing',
      stream: 'checkpoint',
      data: expect.objectContaining({
        recoverable: true,
        reason: expect.stringContaining('没有得到通过'),
        issues: [
          expect.objectContaining({
            code: 'artifact.required.missing',
          }),
        ],
      }),
    }));
  });

  it('allows explicit blockers instead of looping forever', async () => {
    const pluginModule = await loadGuard();
    const { hooks, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
    const finalizeHook = hooks.get('before_agent_finalize');
    expect(finalizeHook).toBeTypeOf('function');

    const result = finalizeHook!({
      runId: 'run-artifact-blocked',
      messages: [
        { role: 'user', content: '做个电站维保的招投标书，做20页' },
        {
          role: 'assistant',
          content: '无法继续：已尝试使用 Node/Python 生成 DOCX，但当前环境缺少写入权限，需要你确认输出目录。',
        },
      ],
    });

    expect(result).toBeUndefined();
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-artifact-blocked',
      stream: 'issue',
      data: expect.objectContaining({
        issue: expect.objectContaining({
          code: 'artifact.delivery.blocked',
          severity: 'blocking',
          recoverable: true,
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-artifact-blocked',
      stream: 'checkpoint',
      data: expect.objectContaining({
        summary: '最终回复声明产物交付存在阻塞。',
        recoverable: true,
        reason: expect.stringContaining('无法继续'),
        issues: [
          expect.objectContaining({
            code: 'artifact.delivery.blocked',
          }),
        ],
      }),
    }));
  });

  it('emits tool step, artifact, and verification events from successful tool results', async () => {
    const pluginModule = await loadGuard();
    const tempDir = mkdtempSync(join(tmpdir(), 'uclaw-tool-result-'));
    const artifactPath = join(tempDir, 'deck.pptx');
    writeFileSync(artifactPath, 'pptx');

    try {
      const { toolResultMiddlewares, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
      const middleware = toolResultMiddlewares[0]?.handler;
      expect(middleware).toBeTypeOf('function');

      await middleware!({
        toolCallId: 'call-create-ppt',
        toolName: 'create_pptx_file',
        args: { title: 'Deck' },
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ filePath: artifactPath, media: `MEDIA:${artifactPath}` }),
          }],
          details: {
            ok: true,
            filePath: artifactPath,
          },
        },
      }, {
        runId: 'run-tool-artifact',
        sessionKey: 'agent:main:main',
        runtime: 'openclaw',
      });

      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-tool-artifact',
        sessionKey: 'agent:main:main',
        stream: 'step',
        data: expect.objectContaining({
          step: expect.objectContaining({
            id: 'tool:call-create-ppt',
            title: '工具 create_pptx_file',
            status: 'completed',
            kind: 'tool',
          }),
        }),
      }));
      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-tool-artifact',
        sessionKey: 'agent:main:main',
        stream: 'artifact',
        data: expect.objectContaining({
          toolCallId: 'call-create-ppt',
          artifact: expect.objectContaining({
            filePath: artifactPath,
            kind: 'presentation',
            sourceToolCallId: 'call-create-ppt',
            sizeBytes: 4,
          }),
        }),
      }));
      expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
        runId: 'run-tool-artifact',
        sessionKey: 'agent:main:main',
        stream: 'verification',
        data: expect.objectContaining({
          toolCallId: 'call-create-ppt',
          verification: expect.objectContaining({
            status: 'passed',
            evidence: 'stat ok; sizeBytes=4',
          }),
        }),
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('emits a checkpoint when a tool result reports failure', async () => {
    const pluginModule = await loadGuard();
    const { toolResultMiddlewares, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
    const middleware = toolResultMiddlewares[0]?.handler;
    expect(middleware).toBeTypeOf('function');

    await middleware!({
      toolCallId: 'call-export',
      toolName: 'export_pdf',
      args: { outputPath: '/tmp/report.pdf' },
      isError: true,
      result: {
        content: [{ type: 'text', text: 'permission denied' }],
        details: {
          status: 'error',
          message: 'permission denied',
        },
      },
    }, {
      runId: 'run-tool-error',
      runtime: 'openclaw',
    });

    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-tool-error',
      stream: 'step',
      data: expect.objectContaining({
        step: expect.objectContaining({
          id: 'tool:call-export',
          status: 'error',
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-tool-error',
      stream: 'issue',
      data: expect.objectContaining({
        issue: expect.objectContaining({
          code: 'tool.failed',
          severity: 'blocking',
          recoverable: true,
        }),
      }),
    }));
    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-tool-error',
      stream: 'checkpoint',
      data: expect.objectContaining({
        summary: '工具 export_pdf 执行失败。',
        reason: 'permission denied',
        recoverable: true,
        issues: [
          expect.objectContaining({
            code: 'tool.failed',
            detail: 'permission denied',
          }),
        ],
      }),
    }));
    expect(emitAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      stream: 'artifact',
    }));
  });

  it('does not promote ordinary read-tool paths into artifacts', async () => {
    const pluginModule = await loadGuard();
    const { toolResultMiddlewares, emitAgentEvent } = registerHooksWithRuntimeEvents(pluginModule);
    const middleware = toolResultMiddlewares[0]?.handler;
    expect(middleware).toBeTypeOf('function');

    await middleware!({
      toolCallId: 'call-read',
      toolName: 'read',
      args: { filePath: '/tmp/source.md' },
      result: {
        content: [{ type: 'text', text: 'Read /tmp/source.md for context.' }],
        details: {
          ok: true,
        },
      },
    }, {
      runId: 'run-tool-read',
      runtime: 'openclaw',
    });

    expect(emitAgentEvent).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-tool-read',
      stream: 'step',
      data: expect.objectContaining({
        step: expect.objectContaining({
          id: 'tool:call-read',
          status: 'completed',
        }),
      }),
    }));
    expect(emitAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      stream: 'artifact',
    }));
    expect(emitAgentEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      stream: 'verification',
    }));
  });

  it('ignores ordinary chat promises', async () => {
    const pluginModule = await loadGuard();
    const finalizeHook = registerFinalizeHook(pluginModule);

    const result = finalizeHook({
      messages: [
        { role: 'user', content: '你明天能提醒我吗？' },
        { role: 'assistant', content: '我会提醒你。' },
      ],
    });

    expect(result).toBeUndefined();
  });
});
