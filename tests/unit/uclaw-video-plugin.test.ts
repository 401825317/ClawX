import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const VIDEO_PLUGIN_CONFIG = {
  defaultModel: 'grok-image-video',
  defaultAspectRatio: '16:9',
  defaultResolution: '480P',
  defaultDurationSeconds: 6,
  pollIntervalMs: 1,
  timeoutMs: 10_000,
  maxDownloadBytes: 1024 * 1024,
  models: [
    {
      id: 'grok-image-video',
      modes: ['text-to-video', 'image-to-video'],
      aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
      resolutions: ['480P', '720P'],
      durations: [6, 10, 15],
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultDurationSeconds: 6,
      requiresImage: false,
    },
    {
      id: 'grok-video-1.5',
      modes: ['image-to-video'],
      aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
      resolutions: ['480P', '720P'],
      durations: [6, 10, 15],
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultDurationSeconds: 6,
      requiresImage: true,
    },
  ],
};

describe('UClaw video plugin', () => {
  it('submits and polls the OpenAI-compatible video protocol with managed defaults', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body?: unknown }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        requests.push({
          method: req.method,
          url: req.url,
          authorization: req.headers.authorization,
          ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.method === 'POST') {
          res.end(JSON.stringify({ data: { task_id: 'task-video-1', status: 'queued' } }));
          return;
        }
        res.end(JSON.stringify({
          data: {
            task_id: 'task-video-1',
            status: 'completed',
            result_url: 'https://media.example.test/video-1.mp4',
            model: 'grok-image-video',
          },
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: {
        capabilities: unknown;
        models?: string[];
        generateVideo: (request: Record<string, unknown>) => Promise<{
          videos: Array<{ url?: string; mimeType: string }>;
          model?: string;
        }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: VIDEO_PLUGIN_CONFIG,
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const cfg = {
        models: {
          providers: {
            'uclaw-video': {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: 'openai-completions',
              request: { allowPrivateNetwork: true },
            },
          },
        },
      };
      const authStore = {
        version: 1,
        profiles: {
          'uclaw-video:default': {
            type: 'api_key',
            provider: 'uclaw-video',
            key: 'video-test-key',
          },
        },
        order: { 'uclaw-video': ['uclaw-video:default'] },
        lastGood: { 'uclaw-video': 'uclaw-video:default' },
      };

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'A blue cup rotating on a white table.',
        aspectRatio: '9:16',
        resolution: '480P',
        durationSeconds: 6,
        timeoutMs: 10_000,
        cfg,
        authStore,
        agentDir: '/tmp/uclaw-video-test-agent',
      });

      expect(provider?.models).toEqual(['grok-image-video', 'grok-video-1.5']);
      expect(provider?.capabilities).toMatchObject({
        generate: {
          aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
          resolutions: ['480P', '720P'],
          sizes: [
            '480x720', '720x480', '480x480', '480x854', '854x480',
            '720x1080', '1080x720', '720x720', '720x1280', '1280x720',
          ],
        },
      });
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/v1/videos',
          authorization: 'Bearer video-test-key',
          body: {
            model: 'grok-image-video',
            prompt: 'A blue cup rotating on a white table.',
            seconds: '6',
            size: '480x854',
            aspect_ratio: '9:16',
            resolution: '480p',
          },
        },
        {
          method: 'GET',
          url: '/v1/videos/task-video-1',
          authorization: 'Bearer video-test-key',
        },
      ]);
      expect(result).toMatchObject({
        model: 'grok-image-video',
        videos: [{ url: 'https://media.example.test/video-1.mp4', mimeType: 'video/mp4' }],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it('requires one reference image for grok-video-1.5', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
    let provider: { generateVideo: (request: Record<string, unknown>) => Promise<unknown> } | undefined;
    plugin.default.register({
      pluginConfig: VIDEO_PLUGIN_CONFIG,
      registerVideoGenerationProvider(nextProvider: typeof provider) {
        provider = nextProvider;
      },
    });

    await expect(provider?.generateVideo({
      provider: 'uclaw-video',
      model: 'grok-video-1.5',
      prompt: 'Animate this image.',
      aspectRatio: '16:9',
      resolution: '480P',
      durationSeconds: 6,
      cfg: {},
    })).rejects.toThrow('requires exactly one reference image');
  });

  it('applies composer options only after the model selects video_generate', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-video-preference-plugin-'));
    const previousStateDirectory = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDirectory;
    try {
      const preferenceDirectory = join(stateDirectory, 'uclaw-turn-preferences');
      await mkdir(preferenceDirectory, { recursive: true });
      const sessionKey = 'agent:main:video-options';
      const prompt = 'Create a short product video.';
      const preference = {
        version: 1,
        id: '926c91d1-b450-4fc4-887e-dad9df8d8c98',
        sessionKey,
        messageDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
        videoOptions: {
          model: 'grok-video-1.5',
          aspectRatio: '9:16',
          resolution: '720P',
          durationSeconds: 10,
        },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      await writeFile(
        join(preferenceDirectory, `video-turn-${preference.id}.json`),
        JSON.stringify(preference),
        { encoding: 'utf8', mode: 0o600 },
      );

      const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      plugin.default.register({
        pluginConfig: VIDEO_PLUGIN_CONFIG,
        registerVideoGenerationProvider() {},
        on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
          hooks.set(name, handler);
        },
      });

      const context = { sessionKey, runId: 'run-video-options' };
      const promptResult = await hooks.get('before_prompt_build')?.({ prompt }, context);
      expect(promptResult).toEqual(expect.objectContaining({ appendContext: expect.stringContaining('video generation mode') }));
      expect(await readdir(preferenceDirectory)).toEqual([]);

      expect(await hooks.get('before_tool_call')?.({
        toolName: 'web_search',
        params: { query: 'product video' },
      }, context)).toBeUndefined();

      expect(await hooks.get('before_tool_call')?.({
        toolName: 'video_generate',
        params: { prompt, model: 'model-selected-by-agent', aspectRatio: '16:9', resolution: '480P', durationSeconds: 6 },
      }, context)).toEqual({
        params: {
          prompt,
          model: 'uclaw-video/grok-video-1.5',
          aspectRatio: '9:16',
          resolution: '720P',
          durationSeconds: 10,
        },
      });
    } finally {
      if (previousStateDirectory === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDirectory;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
