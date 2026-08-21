import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertLocalMediaAllowed } from 'openclaw/plugin-sdk/media-runtime';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';

const VIDEO_PLUGIN_CONFIG = {
  enabled: true,
  defaultModel: 'grok-image-video',
  defaultSize: '1280x720',
  defaultDurationSeconds: 6,
  pollIntervalMs: 1,
  requestTimeoutMs: 100,
  contentDownloadAttemptTimeoutMs: 100,
  contentDownloadMaxAttempts: 2,
  timeoutMs: 10_000,
  maxDownloadBytes: 1024 * 1024,
  maxInputImageBytes: 1024 * 1024,
  models: [
    {
      id: 'grok-image-video',
      modes: ['text-to-video'],
      sizes: [
        '480x720', '720x480', '480x480', '480x854', '854x480',
        '720x1080', '1080x720', '720x720', '720x1280', '1280x720',
      ],
      aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
      resolutions: ['480P', '720P'],
      durations: [6, 10],
      defaultSize: '1280x720',
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultDurationSeconds: 6,
      requiresImage: false,
    },
    {
      id: 'grok-video-1.5',
      modes: ['image-to-video'],
      sizes: [
        '480x720', '720x480', '480x480', '480x854', '854x480',
        '720x1080', '1080x720', '720x720', '720x1280', '1280x720',
      ],
      aspectRatios: ['2:3', '3:2', '1:1', '9:16', '16:9'],
      resolutions: ['480P', '720P'],
      durations: [6, 10],
      defaultAspectRatio: '16:9',
      defaultResolution: '480P',
      defaultSize: '1280x720',
      defaultDurationSeconds: 6,
      requiresImage: true,
    },
  ],
};
const VALID_PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

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
  it('does not register a provider without an explicit valid runtime catalog', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
    let registrations = 0;
    const api = {
      logger: { warn() {} },
      registerVideoGenerationProvider() {
        registrations += 1;
      },
    };

    plugin.default.register({ ...api, pluginConfig: undefined });
    plugin.default.register({ ...api, pluginConfig: { enabled: true, models: [] } });
    plugin.default.register({ ...api, pluginConfig: { enabled: false, models: VIDEO_PLUGIN_CONFIG.models } });

    expect(registrations).toBe(0);
  });

  it('passes a future model, exact size, dynamic resolution, and duration to the upstream request', async () => {
    const requests: unknown[] = [];
    const videoBytes = completeMp4Bytes(Buffer.from('future-video'));
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
          requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'future-task', status: 'completed' }));
        });
        return;
      }
      if (req.url === '/v1/videos/future-task/content') {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(videoBytes.length),
        });
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
      let provider: {
        generateVideo: (request: Record<string, unknown>) => Promise<unknown>;
        resolveModelCapabilities?: (request: { model: string }) => {
          generate?: { aspectRatios?: string[]; resolutions?: string[] };
        };
      } | undefined;
      plugin.default.register({
        pluginConfig: {
          ...VIDEO_PLUGIN_CONFIG,
          defaultModel: 'future-video-model',
          defaultSize: '2048x858',
          defaultDurationSeconds: 21,
          models: [{
            id: 'future-video-model',
            modes: ['text-to-video'],
            sizes: ['2048x858'],
            aspectRatios: ['1024:429'],
            resolutions: ['cinema-ultra'],
            durations: [21],
            defaultSize: '2048x858',
            defaultAspectRatio: '1024:429',
            defaultResolution: 'cinema-ultra',
            defaultDurationSeconds: 21,
            requiresImage: false,
          }],
        },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'future-video-model',
        prompt: 'Future catalog request.',
        size: '2048x858',
        aspectRatio: '1024:429',
        resolution: 'cinema-ultra',
        durationSeconds: 21,
        cfg: {
          models: {
            providers: {
              'uclaw-video': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'future-video-key',
              },
            },
          },
        },
      });

      expect(provider?.resolveModelCapabilities?.({ model: 'future-video-model' })).toMatchObject({
        generate: {
          aspectRatios: ['1024:429'],
          resolutions: ['cinema-ultra'],
        },
      });
      expect(requests).toEqual([{
        model: 'future-video-model',
        prompt: 'Future catalog request.',
        seconds: '21',
        size: '2048x858',
        aspect_ratio: '1024:429',
        quality: 'cinema-ultra',
        resolution: 'cinema-ultra',
      }]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns a completed URL-only result when submission has no task id', async () => {
    let requestCount = 0;
    const resultUrl = 'https://media.example.test/completed-without-task.mp4';
    const server = http.createServer((req, res) => {
      requestCount += 1;
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ result_url: resultUrl, status: 'completed' }));
        return;
      }
      res.writeHead(500).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<{
        videos: Array<{ url?: string; mimeType?: string; fileName?: string }>;
      }> } | undefined;
      plugin.default.register({
        pluginConfig: VIDEO_PLUGIN_CONFIG,
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Return the completed video URL.',
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

      expect(requestCount).toBe(1);
      expect(result).toMatchObject({
        model: 'grok-image-video',
        videos: [{
          url: resultUrl,
          mimeType: 'video/mp4',
          fileName: 'generated-video.mp4',
        }],
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('submits, polls, and downloads the OpenAI-compatible video result with managed defaults', async () => {
    const requests: Array<{
      method?: string;
      url?: string;
      authorization?: string;
      contentType?: string;
      body?: unknown;
    }> = [];
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
          ...(req.headers['content-type'] ? { contentType: req.headers['content-type'] } : {}),
          ...(bodyText ? { body: JSON.parse(bodyText) } : {}),
        });
        if (req.url === '/v1/videos/task-video-1/content') {
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
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
        resolveModelCapabilities?: (request: { model: string }) => unknown;
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
        size: '720x1280',
        aspectRatio: '9:16',
        resolution: '720P',
        durationSeconds: 6,
        timeoutMs: 10_000,
        cfg,
        authStore,
        agentDir: '/tmp/uclaw-video-test-agent',
      });
      const imageResult = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-video-1.5',
        prompt: 'Animate this blue cup.',
        size: '1280x720',
        aspectRatio: '16:9',
        resolution: '720P',
        durationSeconds: 10,
        audio: false,
        watermark: false,
        inputImages: [{
          buffer: VALID_PNG_BYTES,
          mimeType: 'image/png',
          url: 'https://stale.example.test/reference.png',
        }],
        timeoutMs: 10_000,
        cfg,
        authStore,
        agentDir: '/tmp/uclaw-video-test-agent',
      });

      expect(provider?.models).toEqual(['grok-image-video', 'grok-video-1.5']);
      expect(provider?.capabilities).toMatchObject({
        generate: {
          maxInputAudios: 0,
          supportedDurationSeconds: [6, 10],
          supportsAudio: false,
          supportsWatermark: false,
          aspectRatios: expect.arrayContaining(['2:3', '3:2', '1:1', '9:16', '16:9']),
          resolutions: ['480P', '720P'],
          sizes: [
            '480x720', '720x480', '480x480', '480x854', '854x480',
            '720x1080', '1080x720', '720x720', '720x1280', '1280x720',
          ],
        },
        imageToVideo: {
          enabled: true,
          maxInputImages: 1,
          maxInputAudios: 0,
          supportedDurationSeconds: [6, 10],
          supportsAudio: false,
          supportsWatermark: false,
          aspectRatios: expect.arrayContaining(['2:3', '3:2', '1:1', '9:16', '16:9']),
          resolutions: ['480P', '720P'],
        },
      });
      expect(provider?.resolveModelCapabilities?.({ model: 'grok-image-video' })).toMatchObject({
        generate: expect.any(Object),
      });
      expect(provider?.resolveModelCapabilities?.({ model: 'grok-image-video' })).not.toHaveProperty('imageToVideo');
      expect(provider?.resolveModelCapabilities?.({ model: 'grok-video-1.5' })).toMatchObject({
        imageToVideo: { enabled: true, maxInputImages: 1 },
      });
      expect(provider?.resolveModelCapabilities?.({ model: 'grok-video-1.5' })).not.toHaveProperty('generate');
      expect(requests).toEqual([
        {
          method: 'POST',
          url: '/v1/videos',
          authorization: 'Bearer video-test-key',
          contentType: 'application/json',
          body: {
            model: 'grok-image-video',
            prompt: 'A blue cup rotating on a white table.',
            seconds: '6',
            size: '720x1280',
            aspect_ratio: '9:16',
            quality: '720p',
            resolution: '720p',
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
          contentType: 'application/json',
          body: {
            model: 'grok-video-1.5',
            prompt: 'Animate this blue cup.',
            seconds: '10',
            size: '1280x720',
            aspect_ratio: '16:9',
            quality: '720p',
            resolution: '720p',
            input_reference: `data:image/png;base64,${VALID_PNG_BYTES.toString('base64')}`,
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

  it('retries a transient video status failure without resubmitting the generation task', async () => {
    const videoBytes = completeMp4Bytes();
    let submitRequestCount = 0;
    let statusRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        submitRequestCount += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-status-retry', status: 'queued' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-status-retry') {
        statusRequestCount += 1;
        if (statusRequestCount === 1) {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'temporary status outage' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-status-retry', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-status-retry/content') {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(videoBytes.length),
        });
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
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<{
        videos: Array<{ buffer?: Buffer }>;
      }> } | undefined;
      plugin.default.register({
        pluginConfig: VIDEO_PLUGIN_CONFIG,
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Generate after a transient status failure.',
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

      expect(submitRequestCount).toBe(1);
      expect(statusRequestCount).toBe(2);
      expect(result?.videos[0]?.buffer).toEqual(videoBytes);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resumes an interrupted video download with a validated byte range', async () => {
    const videoBytes = completeMp4Bytes(Buffer.alloc(256, 9));
    const splitAt = Math.floor(videoBytes.length / 2);
    const requestedRanges: Array<string | undefined> = [];
    const requestedIfRanges: Array<string | undefined> = [];
    let contentRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-resume', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-resume/content') {
        contentRequestCount += 1;
        requestedRanges.push(typeof req.headers.range === 'string' ? req.headers.range : undefined);
        requestedIfRanges.push(typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined);
        if (contentRequestCount === 1) {
          res.writeHead(200, {
            'accept-ranges': 'bytes',
            'content-type': 'video/mp4',
            'content-length': String(videoBytes.length),
            etag: '"video-resume-v1"',
          });
          res.write(videoBytes.subarray(0, splitAt));
          setImmediate(() => res.destroy());
          return;
        }
        res.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-type': 'video/mp4',
          'content-length': String(videoBytes.length - splitAt),
          'content-range': `bytes ${splitAt}-${videoBytes.length - 1}/${videoBytes.length}`,
          etag: '"video-resume-v1"',
        });
        res.end(videoBytes.subarray(splitAt));
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
        prompt: 'Resume this generated video download.',
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

      expect(contentRequestCount).toBe(2);
      expect(requestedRanges).toEqual([undefined, `bytes=${splitAt}-`]);
      expect(requestedIfRanges).toEqual([undefined, '"video-resume-v1"']);
      expect(result?.videos[0]?.buffer).toEqual(videoBytes);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('resumes from received bytes after a video download attempt times out', async () => {
    const videoBytes = completeMp4Bytes(Buffer.alloc(256, 5));
    const splitAt = Math.floor(videoBytes.length / 2);
    const requestedRanges: Array<string | undefined> = [];
    const requestedIfRanges: Array<string | undefined> = [];
    let contentRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-timeout-resume', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-timeout-resume/content') {
        contentRequestCount += 1;
        requestedRanges.push(typeof req.headers.range === 'string' ? req.headers.range : undefined);
        requestedIfRanges.push(typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined);
        if (contentRequestCount === 1) {
          res.writeHead(200, {
            'accept-ranges': 'bytes',
            'content-type': 'video/mp4',
            'content-length': String(videoBytes.length),
            etag: '"video-timeout-v1"',
          });
          res.write(videoBytes.subarray(0, splitAt));
          return;
        }
        res.writeHead(206, {
          'accept-ranges': 'bytes',
          'content-type': 'video/mp4',
          'content-length': String(videoBytes.length - splitAt),
          'content-range': `bytes ${splitAt}-${videoBytes.length - 1}/${videoBytes.length}`,
          etag: '"video-timeout-v1"',
        });
        res.end(videoBytes.subarray(splitAt));
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
        pluginConfig: {
          ...VIDEO_PLUGIN_CONFIG,
          contentDownloadAttemptTimeoutMs: 30,
          contentDownloadMaxAttempts: 2,
        },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Resume after the content request times out.',
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

      expect(contentRequestCount).toBe(2);
      expect(requestedRanges).toEqual([undefined, `bytes=${splitAt}-`]);
      expect(requestedIfRanges).toEqual([undefined, '"video-timeout-v1"']);
      expect(result?.videos[0]?.buffer).toEqual(videoBytes);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('restarts a resumed download when the provider changes its entity validator', async () => {
    const originalVideo = completeMp4Bytes(Buffer.alloc(256, 3));
    const replacementVideo = completeMp4Bytes(Buffer.alloc(256, 7));
    const splitAt = Math.floor(originalVideo.length / 2);
    const requestedRanges: Array<string | undefined> = [];
    const requestedIfRanges: Array<string | undefined> = [];
    let contentRequestCount = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'task-video-validator-change', status: 'completed' }));
        return;
      }
      if (req.url === '/v1/videos/task-video-validator-change/content') {
        contentRequestCount += 1;
        requestedRanges.push(typeof req.headers.range === 'string' ? req.headers.range : undefined);
        requestedIfRanges.push(typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined);
        if (contentRequestCount === 1) {
          res.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': String(originalVideo.length),
            etag: '"video-validator-v1"',
          });
          res.write(originalVideo.subarray(0, splitAt));
          setImmediate(() => res.destroy());
          return;
        }
        if (contentRequestCount === 2) {
          res.writeHead(206, {
            'content-type': 'video/mp4',
            'content-length': String(replacementVideo.length - splitAt),
            'content-range': `bytes ${splitAt}-${replacementVideo.length - 1}/${replacementVideo.length}`,
            etag: '"video-validator-v2"',
          });
          res.end(replacementVideo.subarray(splitAt));
          return;
        }
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(replacementVideo.length),
          etag: '"video-validator-v2"',
        });
        res.end(replacementVideo);
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
        pluginConfig: { ...VIDEO_PLUGIN_CONFIG, contentDownloadMaxAttempts: 3 },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Restart if the generated video changes during resume.',
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

      expect(contentRequestCount).toBe(3);
      expect(requestedRanges).toEqual([undefined, `bytes=${splitAt}-`, undefined]);
      expect(requestedIfRanges).toEqual([undefined, '"video-validator-v1"', undefined]);
      expect(result?.videos[0]?.buffer).toEqual(replacementVideo);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns a structured video asset for a URL-only completion after local downloads fail', async () => {
    let contentRequestCount = 0;
    let fallbackAuthorization: string | undefined;
    const server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'task-video-url-fallback',
          result_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/fallback/video.mp4`,
        }));
        return;
      }
      if (req.url === '/v1/videos/task-video-url-fallback/content') {
        contentRequestCount += 1;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'content is temporarily unavailable' } }));
        return;
      }
      if (req.url === '/fallback/video.mp4') {
        fallbackAuthorization = typeof req.headers.authorization === 'string'
          ? req.headers.authorization
          : undefined;
        res.writeHead(500).end();
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const resultUrl = `http://127.0.0.1:${address.port}/fallback/video.mp4`;
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<{
        videos: Array<{ buffer?: Buffer; url?: string; metadata?: Record<string, unknown> }>;
      }> } | undefined;
      plugin.default.register({
        pluginConfig: { ...VIDEO_PLUGIN_CONFIG, contentDownloadMaxAttempts: 4 },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Fall back to the completed provider URL.',
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

      expect(contentRequestCount).toBe(4);
      expect(fallbackAuthorization).toBeUndefined();
      expect(result?.videos).toEqual([expect.objectContaining({
        url: resultUrl,
        mimeType: 'video/mp4',
        fileName: 'task-video-url-fallback.mp4',
        metadata: expect.objectContaining({ localDownloadFailed: true }),
      })]);
      expect(result?.videos[0]).not.toHaveProperty('buffer');
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
        res.end(JSON.stringify({
          id: 'task-video-large',
          status: 'completed',
          result_url: 'https://media.example.test/oversized-video.mp4',
        }));
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

  it('rejects unsupported duration and reference combinations before any provider request', async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(500).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<unknown> } | undefined;
      plugin.default.register({
        pluginConfig: VIDEO_PLUGIN_CONFIG,
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const request = {
        provider: 'uclaw-video',
        model: 'grok-image-video',
        prompt: 'Generate a short clip.',
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
      };

      await expect(provider?.generateVideo({ ...request, durationSeconds: 8 }))
        .rejects.toThrow('does not support 8 second videos; supported durations: 6, 10');
      await expect(provider?.generateVideo({ ...request, durationSeconds: 15 }))
        .rejects.toThrow('does not support 15 second videos; supported durations: 6, 10');
      await expect(provider?.generateVideo({
        ...request,
        inputImages: [{ buffer: Buffer.from('image'), mimeType: 'image/png' }],
        inputVideos: [{ buffer: Buffer.from('video'), mimeType: 'video/mp4' }],
      })).rejects.toThrow('does not support combined image/video reference inputs');
      await expect(provider?.generateVideo({ ...request, inputAudios: [{ buffer: Buffer.from('audio') }] }))
        .rejects.toThrow('does not support audio reference inputs');
      await expect(provider?.generateVideo({ ...request, audio: true }))
        .rejects.toThrow('does not support generated audio');
      await expect(provider?.generateVideo({ ...request, watermark: true }))
        .rejects.toThrow('does not support watermarks');
      await expect(provider?.generateVideo({ ...request, audio: 'enabled' }))
        .rejects.toThrow('does not support generated audio');
      await expect(provider?.generateVideo({ ...request, watermark: 1 }))
        .rejects.toThrow('does not support watermarks');
      await expect(provider?.generateVideo({
        ...request,
        size: '1280x720',
        resolution: '480P',
      })).rejects.toThrow('requires 720P resolution for 1280x720 size');
      await expect(provider?.generateVideo({ ...request, resolution: '1080P' }))
        .rejects.toThrow('does not support 1080P resolution');
      expect(requestCount).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('blocks unsupported references and normalizes duration in the video tool hook', async () => {
    const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
    const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
    plugin.default.register({
      pluginConfig: VIDEO_PLUGIN_CONFIG,
      registerVideoGenerationProvider() {},
      on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
        hooks.set(name, handler);
      },
    });

    const hook = hooks.get('before_tool_call');
    await expect(Promise.resolve().then(() => hook?.({
      toolName: 'video_generate',
      params: {
        prompt: 'Animate this image and video.',
        image: '/tmp/reference.png',
        video: '/tmp/reference.mp4',
      },
    }, {}))).rejects.toThrow('does not support combined image/video reference inputs');

    await expect(Promise.resolve().then(() => hook?.({
      toolName: 'video_generate',
      params: {
        prompt: 'Generate a short clip.',
        aspectRatio: '16:9',
        resolution: '720P',
        durationSeconds: 8,
      },
    }, {}))).resolves.toEqual({
      params: expect.objectContaining({
        model: 'uclaw-video/grok-image-video',
        aspectRatio: '16:9',
        resolution: '720P',
        durationSeconds: 6,
        size: '1280x720',
      }),
    });

    await expect(Promise.resolve().then(() => hook?.({
      toolName: 'video_generate',
      params: {
        prompt: 'Generate a short clip.',
        size: '1280x720',
        resolution: '480P',
      },
    }, {}))).resolves.toEqual({
      params: expect.objectContaining({
        size: '1280x720',
        resolution: '720P',
      }),
    });

    await expect(Promise.resolve().then(() => hook?.({
      toolName: 'video_generate',
      params: { prompt: 'Generate a short clip.', audio: true },
    }, {}))).rejects.toThrow('does not support generated audio');
    await expect(Promise.resolve().then(() => hook?.({
      toolName: 'video_generate',
      params: { prompt: 'Generate a short clip.', watermark: true },
    }, {}))).rejects.toThrow('does not support watermarks');
  });

  it('uses the service-declared model duration catalog without a client-side allowlist', async () => {
    const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
    const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
    let provider: {
      resolveModelCapabilities?: (request: { model: string }) => {
        generate?: { supportedDurationSeconds?: number[] };
      };
    } | undefined;
    plugin.default.register({
      pluginConfig: {
        ...VIDEO_PLUGIN_CONFIG,
        defaultDurationSeconds: 8,
        models: VIDEO_PLUGIN_CONFIG.models.map((model) => ({
          ...model,
          durations: [8],
          defaultDurationSeconds: 8,
        })),
      },
      registerVideoGenerationProvider(nextProvider: typeof provider) {
        provider = nextProvider;
      },
      on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
        hooks.set(name, handler);
      },
    });

    expect(provider?.resolveModelCapabilities?.({ model: 'grok-image-video' }))
      .toMatchObject({ generate: { supportedDurationSeconds: [8] } });
    await expect(Promise.resolve().then(() => hooks.get('before_tool_call')?.({
      toolName: 'video_generate',
      params: { prompt: 'Generate a service-catalog fixture.', durationSeconds: 7 },
    }, {}))).resolves.toEqual({
      params: expect.objectContaining({ durationSeconds: 8 }),
    });
  });

  it('does not retry reference-image upload 404 and preserves sanitized diagnostics', async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(404, {
        'content-type': 'application/json',
        'x-request-id': 'req-image-upload-404',
      });
      res.end(JSON.stringify({
        error: {
          type: 'upstream_error',
          code: 'image_upload_not_found',
          message: 'APIMart image upload failed with status 404 token=secret-value',
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
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
        durationSeconds: 6,
        inputImages: [{ buffer: VALID_PNG_BYTES, mimeType: 'image/png' }],
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
      })).rejects.toThrow(
        /APIMart image upload failed with status 404.*providerRequestId=req-image-upload-404.*token=\[REDACTED\]/u,
      );
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('preserves diagnostics for an HTTP-200 terminal reference upload failure', async () => {
    let requestCount = 0;
    const server = http.createServer((_req, res) => {
      requestCount += 1;
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req-task-upload-404',
      });
      res.end(JSON.stringify({
        data: {
          task_id: 'failed-reference-task',
          status: 'failed',
          error: {
            type: 'upstream_error',
            message: 'APIMart image upload failed with status 404 api_key=do-not-log',
          },
        },
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
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
        durationSeconds: 6,
        inputImages: [{ buffer: VALID_PNG_BYTES, mimeType: 'image/png' }],
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
      })).rejects.toThrow(
        /APIMart image upload failed with status 404.*providerRequestId=req-task-upload-404.*api_key=\[REDACTED\]/u,
      );
      expect(requestCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('normalizes oversized and unsupported reference images before submitting the video request', async () => {
    const maxInputImageBytes = 1024 * 1024;
    const source = await sharp(randomBytes(700 * 700 * 3), {
      raw: { width: 700, height: 700, channels: 3 },
    }).png().toBuffer();
    expect(source.byteLength).toBeGreaterThan(maxInputImageBytes);
    const smallTiff = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#4477aa' },
    }).tiff({ compression: 'none' }).toBuffer();
    expect(smallTiff.byteLength).toBeLessThan(maxInputImageBytes);

    const submittedImages: string[] = [];
    const videoBytes = completeMp4Bytes();
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        if (req.method === 'POST') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            image?: string;
            input_reference?: string;
          };
          expect(body).not.toHaveProperty('image');
          submittedImages.push(body.input_reference ?? '');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { task_id: 'compressed-image-task', status: 'queued' } }));
          return;
        }
        if (req.url?.endsWith('/content')) {
          res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) });
          res.end(videoBytes);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: { task_id: 'compressed-image-task', status: 'completed', result_url: 'https://example.test/video.mp4' },
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind');
      const plugin = await import('../../resources/openclaw-plugins/uclaw-video/index.mjs');
      let provider: { generateVideo: (request: Record<string, unknown>) => Promise<unknown> } | undefined;
      plugin.default.register({
        pluginConfig: { ...VIDEO_PLUGIN_CONFIG, maxInputImageBytes },
        registerVideoGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-video-1.5',
        prompt: 'Animate this image.',
        inputImages: [{ buffer: source, mimeType: 'image/png' }],
        cfg: {
          models: {
            providers: {
              'uclaw-video': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'video-test-key',
                request: { allowPrivateNetwork: true },
              },
            },
          },
        },
      });

      await provider?.generateVideo({
        provider: 'uclaw-video',
        model: 'grok-video-1.5',
        prompt: 'Animate this TIFF image.',
        inputImages: [{ buffer: smallTiff, mimeType: 'image/tiff' }],
        cfg: {
          models: {
            providers: {
              'uclaw-video': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'video-test-key',
                request: { allowPrivateNetwork: true },
              },
            },
          },
        },
      });

      expect(submittedImages).toHaveLength(2);
      for (const submittedImage of submittedImages) {
        expect(submittedImage).toMatch(/^data:image\/jpeg;base64,/u);
        const encoded = submittedImage.split(',', 2)[1] ?? '';
        expect(Buffer.from(encoded, 'base64').byteLength).toBeLessThanOrEqual(maxInputImageBytes);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

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
      model: 'grok-video-1.5',
      prompt: 'Animate this image.',
      inputImages: [{ buffer: VALID_PNG_BYTES, mimeType: 'image/png' }],
      cfg: {},
    })).rejects.toThrow('exceeds the 8 bytes reference-image limit');
  });

  it('applies composer options only after the model selects video_generate', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'uclaw-video-preference-plugin-'));
    const previousStateDirectory = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDirectory;
    try {
      const preferenceDirectory = join(stateDirectory, 'media', 'uclaw-turn-preferences');
      await mkdir(preferenceDirectory, { recursive: true });
      const sessionKey = 'agent:main:video-options';
      const prompt = 'Create a short product video.';
      const preference = {
        version: 2,
        id: '926c91d1-b450-4fc4-887e-dad9df8d8c98',
        sessionKey,
        messageDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
        messageLength: prompt.length,
        videoOptions: {
          modelId: 'grok-image-video',
          size: '720x1280',
          mode: 'text-to-video',
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
          model: 'uclaw-video/grok-image-video',
          modelId: 'grok-image-video',
          mode: 'text-to-video',
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
          modelId: 'grok-image-video',
          mode: 'text-to-video',
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
      const preferenceDirectory = join(stateDirectory, 'media', 'uclaw-turn-preferences');
      await mkdir(preferenceDirectory, { recursive: true });
      const sessionKey = 'agent:main:video-reference';
      const runId = 'run-video-reference';
      const prompt = 'Animate this image.';
      const id = '27c3d85f-0d5e-4bf5-b5d3-c8316db9ddde';
      const referenceFileName = `video-reference-${id}.jpg`;
      const referencePath = join(preferenceDirectory, referenceFileName);
      await writeFile(referencePath, Buffer.from('bounded-reference-image'), { mode: 0o600 });
      await expect(assertLocalMediaAllowed(referencePath)).resolves.toBeUndefined();
      await writeFile(
        join(preferenceDirectory, `video-turn-${id}.json`),
        JSON.stringify({
          version: 2,
          id,
          sessionKey,
          messageDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
          messageLength: prompt.length,
          videoOptions: {
            modelId: 'grok-video-1.5',
            size: '720x1280',
            mode: 'image-to-video',
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
      expect(hooks.has('agent_end')).toBe(false);

      const context = { sessionKey, runId };
      const wrappedPrompt = [
        '[media attached: media://inbound/reference.png (image/png)]',
        '[Image]',
        'User text:',
        '[Working directory: ~/.openclaw/workspace]',
        '',
        prompt,
        'Description:',
        'A bounded visual description appended by the ACP attachment pipeline.',
      ].join('\n');
      const promptResult = await hooks.get('before_prompt_build')?.({ prompt: wrappedPrompt }, context);
      expect(promptResult).toEqual(expect.objectContaining({
        appendContext: expect.stringContaining('video generation mode'),
      }));
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
          modelId: 'grok-video-1.5',
          mode: 'image-to-video',
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
