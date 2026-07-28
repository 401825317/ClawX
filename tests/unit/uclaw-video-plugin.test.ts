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
  contentDownloadMaxAttempts: 2,
  timeoutMs: 10_000,
  maxDownloadBytes: 1024 * 1024,
  maxInputImageBytes: 1024 * 1024,
  models: [
    {
      id: 'grok-image-video',
      modes: ['text-to-video'],
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

function mp4Box(type: string, payload = Buffer.alloc(0), declaredSize = payload.length + 8): Buffer {
  const box = Buffer.alloc(payload.length + 8);
  box.writeUInt32BE(declaredSize, 0);
  box.write(type, 4, 4, 'ascii');
  payload.copy(box, 8);
  return box;
}

function completeMp4Bytes(payload = Buffer.from('complete-video-payload')): Buffer {
  const ftyp = Buffer.alloc(16);
  ftyp.write('isom', 0, 4, 'ascii');
  ftyp.writeUInt32BE(0x200, 4);
  ftyp.write('isom', 8, 4, 'ascii');
  ftyp.write('mp41', 12, 4, 'ascii');
  return Buffer.concat([
    mp4Box('ftyp', ftyp),
    mp4Box('moov', mp4Box('mvhd', Buffer.alloc(8))),
    mp4Box('mdat', payload),
  ]);
}

function truncatedMp4Bytes(): Buffer {
  const complete = completeMp4Bytes(Buffer.from('partial'));
  complete.writeUInt32BE(4_096, complete.length - Buffer.byteLength('partial') - 8);
  return complete;
}

describe('UClaw video plugin', () => {
  it('submits, polls, and downloads the OpenAI-compatible video result with managed defaults', async () => {
    const requests: Array<{ method?: string; url?: string; authorization?: string; body?: unknown }> = [];
    const videoBytes = completeMp4Bytes();
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
        if (req.url === '/v1/videos/task-video-1/content') {
          res.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': String(videoBytes.length),
          });
          res.end(videoBytes);
          return;
        }
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
          videos: Array<{ buffer?: Buffer; url?: string; mimeType: string }>;
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

      const textResult = await provider?.generateVideo({
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
      const imageResult = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Animate this blue cup.',
        aspectRatio: '16:9',
        resolution: '720P',
        durationSeconds: 10,
        inputImages: [{ buffer: Buffer.from('reference-image'), mimeType: 'image/png' }],
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
        {
          method: 'GET',
          url: '/v1/videos/task-video-1/content',
          authorization: 'Bearer video-test-key',
        },
        {
          method: 'POST',
          url: '/v1/videos',
          authorization: 'Bearer video-test-key',
          body: {
            model: 'grok-video-1.5',
            prompt: 'Animate this blue cup.',
            seconds: '10',
            size: '1280x720',
            aspect_ratio: '16:9',
            resolution: '720p',
            image: `data:image/png;base64,${Buffer.from('reference-image').toString('base64')}`,
          },
        },
        {
          method: 'GET',
          url: '/v1/videos/task-video-1',
          authorization: 'Bearer video-test-key',
        },
        {
          method: 'GET',
          url: '/v1/videos/task-video-1/content',
          authorization: 'Bearer video-test-key',
        },
      ]);
      expect(textResult).toMatchObject({
        model: 'grok-image-video',
        videos: [{ buffer: videoBytes, url: 'https://media.example.test/video-1.mp4', mimeType: 'video/mp4' }],
      });
      expect(imageResult).toMatchObject({
        model: 'grok-video-1.5',
        videos: [{ buffer: videoBytes, url: 'https://media.example.test/video-1.mp4', mimeType: 'video/mp4' }],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it('retries a completed task until the MP4 content response is no longer truncated', async () => {
    const truncatedVideo = truncatedMp4Bytes();
    const completeVideo = completeMp4Bytes(Buffer.alloc(128, 7));
    let statusRequestCount = 0;
    let contentRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'task-video-truncated',
          status: 'processing',
          result_url: 'https://media.example.test/not-ready.mp4',
        }));
        return;
      }
      if (req.url === '/v1/videos/task-video-truncated') {
        statusRequestCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-truncated', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-truncated/content') {
        contentRequestCount += 1;
        const body = contentRequestCount === 1 ? truncatedVideo : completeVideo;
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(body.length),
        });
        res.end(body);
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<{
        videos: Array<{ buffer?: Buffer }>;
      }> } | undefined;
      plugin.default.register({
        pluginConfig: { ...VIDEO_PLUGIN_CONFIG, contentDownloadMaxAttempts: 2 },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Generate a complete video.',
        cfg: {
          models: {
            providers: {
              'uclaw-video': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'video-test-key',
              },
            },
          },
        },
      });

      expect(statusRequestCount).toBe(1);
      expect(contentRequestCount).toBe(2);
      expect(result?.videos[0]?.buffer).toEqual(completeVideo);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('fails after the configured number of incomplete MP4 downloads', async () => {
    const truncatedVideo = truncatedMp4Bytes();
    let contentRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-always-truncated', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-always-truncated/content') {
        contentRequestCount += 1;
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(truncatedVideo.length),
        });
        res.end(truncatedVideo);
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<unknown> } | undefined;
      plugin.default.register({
        pluginConfig: { ...VIDEO_PLUGIN_CONFIG, contentDownloadMaxAttempts: 2 },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      await expect(provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Generate a complete video.',
        cfg: {
          models: {
            providers: {
              'uclaw-video': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'video-test-key',
              },
            },
          },
        },
      })).rejects.toThrow('Video content remained incomplete after 2 download attempts');
      expect(contentRequestCount).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects an oversized generated video while streaming the content response', async () => {
    const videoBytes = Buffer.from('video-over-managed-limit');
    let contentRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-large', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-large/content') {
        contentRequestCount += 1;
        res.writeHead(200, { 'content-type': 'video/mp4' });
        res.end(videoBytes);
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<unknown> } | undefined;
      plugin.default.register({
        pluginConfig: { ...VIDEO_PLUGIN_CONFIG, maxDownloadBytes: 8 },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      await expect(provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Generate an oversized video.',
        cfg: {
          models: {
            providers: {
              'uclaw-video': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'video-test-key',
              },
            },
          },
        },
      })).rejects.toThrow('Generated video exceeds 8 bytes');
      expect(contentRequestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects more than one reference image before calling the provider', async () => {
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
      inputImages: [
        { buffer: Buffer.from('image-one'), mimeType: 'image/png' },
        { buffer: Buffer.from('image-two'), mimeType: 'image/png' },
      ],
      cfg: {},
    })).rejects.toThrow('supports at most one reference image');
  });

  it('rejects a normalized reference image that still exceeds the managed byte limit', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
    let provider: { generateVideo: (request: Record<string, unknown>) => Promise<unknown> } | undefined;
    plugin.default.register({
      pluginConfig: { ...VIDEO_PLUGIN_CONFIG, maxInputImageBytes: 8 },
      registerVideoGenerationProvider(nextProvider: typeof provider) {
        provider = nextProvider;
      },
    });

    await expect(provider?.generateVideo({
      provider: 'uclaw-video',
      model: 'grok-image-video',
      prompt: 'Animate this image.',
      inputImages: [{ buffer: Buffer.from('larger-than-eight-bytes'), mimeType: 'image/png' }],
      cfg: {},
    })).rejects.toThrow('exceeds the 8 bytes reference-image limit');
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
        messageLength: prompt.length,
        videoOptions: {
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
      const wrappedPrompt = [
        'Sender (untrusted metadata):',
        '```json',
        '{"label":"ACP (cli)"}',
        '```',
        '',
        '[Working directory: ~/.openclaw/workspace]',
        '',
        prompt,
      ].join('\n');
      const promptResult = await hooks.get('before_prompt_build')?.({ prompt: wrappedPrompt }, context);
      expect(promptResult).toEqual(expect.objectContaining({ appendContext: expect.stringContaining('video generation mode') }));
      expect(await readdir(preferenceDirectory)).toEqual([]);

      expect(await hooks.get('before_tool_call')?.({
        toolName: 'web_search',
        params: { query: 'product video' },
      }, context)).toBeUndefined();

      expect(await hooks.get('before_tool_call')?.({
        toolName: 'video_generate',
        params: {
          prompt,
          image: '/tmp/reference.png',
          model: 'model-selected-by-agent',
          aspectRatio: '16:9',
          resolution: '480P',
          durationSeconds: 6,
          size: '1920x1080',
          timeoutMs: 300_000,
        },
      }, context)).toEqual({
        params: {
          prompt,
          image: '/tmp/reference.png',
          model: 'uclaw-video/grok-video-1.5',
          aspectRatio: '9:16',
          resolution: '720P',
          durationSeconds: 10,
          size: '720x1280',
          timeoutMs: 10_000,
        },
      });

      expect(await hooks.get('before_tool_call')?.({
        toolName: 'video_generate',
        params: { prompt, size: '1920x1080', timeoutMs: 300_000 },
      }, context)).toEqual({
        params: {
          prompt,
          model: 'uclaw-video/grok-image-video',
          aspectRatio: '9:16',
          resolution: '720P',
          durationSeconds: 10,
          size: '720x1280',
          timeoutMs: 10_000,
        },
      });

      await expect(Promise.resolve().then(() => hooks.get('before_tool_call')?.({
        toolName: 'video_generate',
        params: { prompt, images: ['/tmp/one.png', '/tmp/two.png'] },
      }, context))).rejects.toThrow('supports at most one reference image');
    } finally {
      if (previousStateDirectory === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDirectory;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('binds the managed current-turn image to a model-owned tool call and cleans it after success', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-video-reference-plugin-'));
    const previousStateDirectory = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDirectory;
    try {
      const preferenceDirectory = join(stateDirectory, 'uclaw-turn-preferences');
      await mkdir(preferenceDirectory, { recursive: true });
      const sessionKey = 'agent:main:video-reference';
      const runId = 'run-video-reference';
      const prompt = 'Animate this image.';
      const id = '27c3d85f-0d5e-4bf5-b5d3-c8316db9ddde';
      const referenceFileName = `video-reference-${id}.jpg`;
      const referencePath = join(preferenceDirectory, referenceFileName);
      await writeFile(referencePath, Buffer.from('bounded-reference-image'), { mode: 0o600 });
      await writeFile(
        join(preferenceDirectory, `video-turn-${id}.json`),
        JSON.stringify({
          version: 1,
          id,
          sessionKey,
          messageDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
          messageLength: prompt.length,
          videoOptions: {
            aspectRatio: '9:16',
            resolution: '720P',
            durationSeconds: 10,
          },
          referenceImage: {
            filePath: referencePath,
            fileName: 'reference.jpg',
            mimeType: 'image/jpeg',
          },
          createdAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        }),
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

      const context = { sessionKey, runId };
      await hooks.get('before_prompt_build')?.({ prompt }, context);
      expect(await readdir(preferenceDirectory)).toEqual([referenceFileName]);

      expect(await hooks.get('before_tool_call')?.({
        toolName: 'video_generate',
        params: { prompt, images: ['/tmp/model-invented-reference.png'] },
        runId,
      }, context)).toEqual({
        params: {
          prompt,
          image: referencePath,
          model: 'uclaw-video/grok-video-1.5',
          aspectRatio: '9:16',
          resolution: '720P',
          durationSeconds: 10,
          size: '720x1280',
          timeoutMs: 10_000,
        },
      });

      await hooks.get('after_tool_call')?.({
        toolName: 'video_generate',
        params: { prompt, image: referencePath },
        runId,
        error: 'provider temporarily unavailable',
      }, context);
      expect(await readdir(preferenceDirectory)).toEqual([referenceFileName]);

      await hooks.get('after_tool_call')?.({
        toolName: 'video_generate',
        params: { prompt, image: referencePath },
        runId,
      }, context);
      await expect.poll(() => readdir(preferenceDirectory)).toEqual([]);
    } finally {
      if (previousStateDirectory === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDirectory;
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });
});
