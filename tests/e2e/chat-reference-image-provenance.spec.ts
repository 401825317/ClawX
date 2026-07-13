import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';
import type { ElectronApplication } from '@playwright/test';

const SESSION_KEY = 'agent:main:reference-video';
const REFERENCE_PATH = '/Users/test/.openclaw/media/outbound/reference.png';
const REFERENCE_PREVIEW = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const GENERATED_URL = '/api/chat/media/outgoing/agent%3Amain%3Areference-video/generated-1/full';
const GENERATED_VIDEO_URL = '/api/chat/media/outgoing/agent%3Amain%3Areference-video/generated-video-1/full';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

async function installHistoryMocks(
  app: ElectronApplication,
  messages: unknown[],
  thumbnails: Record<string, { preview: string; fileSize: number }>,
): Promise<void> {
  const sessions = [{
    key: SESSION_KEY,
    displayName: 'Reference video',
    status: 'done',
    hasActiveRun: false,
  }];
  const historyResult = {
    messages,
    sessionInfo: { hasActiveRun: false },
  };

  await installIpcMocks(app, {
    gatewayStatus: { state: 'running', port: 18789, pid: 12345, gatewayReady: true },
    gatewayRpc: {
      [stableStringify(['sessions.list', { includeDerivedTitles: true, includeLastMessage: true }])]: {
        success: true,
        result: { sessions },
      },
      [stableStringify(['chat.history', { sessionKey: SESSION_KEY, limit: 200, maxChars: 500000 }])]: {
        success: true,
        result: historyResult,
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
        data: { status: 200, ok: true, json: { success: true, result: { sessions } } },
      },
      [stableStringify(['/api/chat/history', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { success: true, result: historyResult } },
      },
      [stableStringify(['/api/agents', 'GET'])]: {
        ok: true,
        data: {
          status: 200,
          ok: true,
          json: { success: true, agents: [{ id: 'main', name: 'Main' }] },
        },
      },
      [stableStringify(['/api/settings', 'GET'])]: {
        ok: true,
        data: { status: 200, ok: true, json: { devModeUnlocked: true, language: 'zh' } },
      },
      [stableStringify(['/api/files/thumbnails', 'POST'])]: {
        ok: true,
        data: { status: 200, ok: true, json: thumbnails },
      },
    },
  });
}

const history = [
  {
    id: 'reference-user',
    role: 'user',
    content: `参考图帮我做一个横屏登山视频\n[media attached: ${REFERENCE_PATH} (image/png) | ${REFERENCE_PATH}]`,
    timestamp: 1_000,
  },
  {
    id: 'reference-plan',
    role: 'assistant',
    content: [
      { type: 'text', text: '我会以参考图的雪山为主体制作横屏登山镜头。' },
      { type: 'toolCall', id: 'describe-video', name: 'tool_describe', arguments: { id: 'video_generate' } },
    ],
    timestamp: 1_001,
  },
  {
    role: 'toolResult',
    toolCallId: 'describe-video',
    toolName: 'tool_describe',
    content: [{ type: 'text', text: 'Video generation tool description' }],
    details: { status: 'completed' },
    timestamp: 1_002,
  },
  {
    id: 'reference-video-call',
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'call-video-wrapper',
      name: 'tool_call',
      arguments: {
        id: 'video_generate',
        args: { action: 'generate', image: REFERENCE_PATH },
      },
    }],
    timestamp: 1_003,
  },
  {
    role: 'toolResult',
    toolCallId: 'call-video-wrapper',
    toolName: 'tool_call',
    content: [{ type: 'text', text: 'Video request was accepted without producing an image.' }],
    details: { status: 'completed' },
    isError: false,
    timestamp: 1_004,
  },
];

test.describe('chat reference image provenance', () => {
  test('does not replay a user reference image as an assistant-generated artifact', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installHistoryMocks(app, history, {
        [REFERENCE_PATH]: { preview: REFERENCE_PREVIEW, fileSize: 68 },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByText('我会以参考图的雪山为主体制作横屏登山镜头。')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('chat-image-thumbnail')).toHaveCount(1);
      await expect.soft(page.getByTestId('chat-image-preview-card')).toHaveCount(0);
      await expect.soft(page.getByText('图片已生成')).toHaveCount(0);

      await page.reload();
      await expect(page.getByText('我会以参考图的雪山为主体制作横屏登山镜头。')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('chat-image-thumbnail')).toHaveCount(1);
      await expect(page.getByTestId('chat-image-preview-card')).toHaveCount(0);
      await expect(page.getByText('图片已生成')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps image-generated summary for an explicit image tool with delivered output', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const generatedHistory = [
      {
        id: 'generated-user',
        role: 'user',
        content: '生成一张雪山海报',
        timestamp: 2_000,
      },
      {
        id: 'generated-tool',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'image-generate-call',
          name: 'image_generate',
          arguments: { prompt: 'snow mountain poster' },
        }],
        timestamp: 2_001,
      },
      {
        role: 'toolResult',
        toolCallId: 'image-generate-call',
        toolName: 'image_generate',
        content: [{ type: 'text', text: 'Image generated successfully.' }],
        details: { status: 'completed' },
        timestamp: 2_002,
      },
      {
        id: 'generated-output',
        role: 'assistant',
        content: [{
          type: 'image',
          url: GENERATED_URL,
          mimeType: 'image/png',
          alt: 'snow-mountain.png',
        }],
        timestamp: 2_003,
      },
    ];

    try {
      await installHistoryMocks(app, generatedHistory, {
        [GENERATED_URL]: { preview: REFERENCE_PREVIEW, fileSize: 68 },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('chat-image-preview-card')).toHaveCount(1, { timeout: 30_000 });
      await expect(page.getByText('图片已生成')).toBeVisible();
      await expect(page.getByTestId('chat-image-thumbnail')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('recognizes wrapped video generation only when a video output is delivered', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const generatedHistory = [
      {
        id: 'video-user',
        role: 'user',
        content: '生成一段雪山视频',
        timestamp: 3_000,
      },
      {
        id: 'video-tool-wrapper',
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'video-generate-wrapper-call',
          name: 'tool_call',
          arguments: { id: 'video_generate', args: { prompt: 'snow mountain video' } },
        }],
        timestamp: 3_001,
      },
      {
        role: 'toolResult',
        toolCallId: 'video-generate-wrapper-call',
        toolName: 'tool_call',
        content: [{ type: 'text', text: 'Video generated successfully.' }],
        details: { status: 'completed' },
        timestamp: 3_002,
      },
      {
        id: 'video-output',
        role: 'assistant',
        content: [{
          type: 'video',
          url: GENERATED_VIDEO_URL,
          mimeType: 'video/mp4',
          fileName: 'snow-mountain.mp4',
        }],
        timestamp: 3_003,
      },
    ];

    try {
      await installHistoryMocks(app, generatedHistory, {
        [GENERATED_VIDEO_URL]: { preview: '', fileSize: 1_024 },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByText('视频已生成')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText('图片已生成')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });
});
