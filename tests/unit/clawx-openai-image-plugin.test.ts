import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const repoRoot = process.cwd();
const PNG_IMAGE_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9+o/0AAAAASUVORK5CYII=',
  'base64',
);
const IMAGE_PLUGIN_CONFIG = {
  defaultModel: 'gpt-image-2',
  defaultSize: '1024x1024',
  defaultQuality: 'medium',
  models: [{
    id: 'gpt-image-2',
    sizes: ['1024x1024', '1536x1024', '1024x1536', '3840x2160', '2160x3840'],
    qualities: ['low', 'medium', 'high'],
    defaultSize: '1024x1024',
    defaultQuality: 'medium',
    enabled: true,
  }],
};

const OVERSIZED_PROVIDER_BODY_BYTES = 65 * 1024 * 1024;
const OVERSIZED_IMAGE_BODY_BYTES = 33 * 1024 * 1024;

function imageAuthStore() {
  return {
    version: 1,
    profiles: {
      'clawx-openai-image:default': {
        type: 'api_key',
        provider: 'clawx-openai-image',
        key: 'test-auth-profile-key',
      },
    },
    order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
    lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
  };
}

function imageGenerationRequest(port: number) {
  return {
    provider: 'clawx-openai-image',
    model: 'gpt-image-2',
    prompt: 'Generate a URL safety fixture.',
    cfg: {
      models: {
        providers: {
          'clawx-openai-image': { baseUrl: `http://127.0.0.1:${port}/v1` },
        },
      },
    },
    authStore: imageAuthStore(),
    agentDir: '/tmp/clawx-openai-image-security-test-agent',
  };
}

async function registeredImageProvider() {
  const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
  let provider: {
    generateImage: (req: Record<string, unknown>) => Promise<unknown>;
  } | undefined;
  plugin.default.register({
    pluginConfig: IMAGE_PLUGIN_CONFIG,
    registerImageGenerationProvider(nextProvider: typeof provider) {
      provider = nextProvider;
    },
  });
  if (!provider) throw new Error('Image provider was not registered');
  return provider;
}

async function captureImageProviderError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: unknown; status?: unknown };
  }
  throw new Error('Expected image provider request to fail');
}

function expectSanitizedImageFailure(error: Error & { code?: unknown }, ...secrets: string[]) {
  expect(error).toBeInstanceOf(Error);
  if (error.code !== undefined) expect(String(error.code)).toMatch(/^IMAGE_/u);
  for (const secret of secrets) expect(error.message).not.toContain(secret);
}

async function writeBodyInChunks(
  response: import('node:http').ServerResponse,
  totalBytes: number,
  prefix = Buffer.alloc(0),
  suffix = Buffer.alloc(0),
) {
  const writeChunk = async (chunk: Buffer) => {
    if (response.destroyed || response.writableEnded) return false;
    if (response.write(chunk)) return true;
    return await new Promise<boolean>((resolve) => {
      const finish = (writable: boolean) => {
        response.off('drain', onDrain);
        response.off('close', onClose);
        response.off('error', onClose);
        resolve(writable);
      };
      const onDrain = () => finish(true);
      const onClose = () => finish(false);
      response.once('drain', onDrain);
      response.once('close', onClose);
      response.once('error', onClose);
    });
  };
  const filler = Buffer.alloc(1024 * 1024, 0x41);
  let remaining = totalBytes - prefix.byteLength - suffix.byteLength;
  if (remaining < 0) throw new Error('Test body is smaller than its prefix and suffix');
  if (!await writeChunk(prefix)) return;
  while (remaining > 0) {
    const chunk = remaining >= filler.byteLength ? filler : filler.subarray(0, remaining);
    if (!await writeChunk(chunk)) return;
    remaining -= chunk.byteLength;
  }
  if (!await writeChunk(suffix)) return;
  response.end();
}

function createHttpTestDisposer(
  server: ReturnType<typeof http.createServer>,
  options: {
    controllers?: AbortController[];
    restore?: Array<() => void>;
  } = {},
): () => Promise<void> {
  let disposePromise: Promise<void> | undefined;
  return () => {
    disposePromise ??= (async () => {
      for (const controller of options.controllers ?? []) controller.abort();
      try {
        if (!server.listening) return;
        const closed = new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        });
        server.closeAllConnections();
        await closed;
      } finally {
        for (const restore of options.restore ?? []) restore();
      }
    })();
    return disposePromise;
  };
}

describe('ClawX OpenAI image plugin request shape', () => {
  it('does not register without a complete non-empty managed image catalog', async () => {
    const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
    const registerImageGenerationProvider = vi.fn();
    const warn = vi.fn();

    for (const pluginConfig of [
      undefined,
      {},
      { models: [] },
      { models: [{ id: 'gpt-image-2', sizes: [], qualities: [], enabled: true }] },
      { models: [{ id: 'gpt-image-2', sizes: ['1024x1024'], qualities: ['high'], enabled: false }] },
    ]) {
      plugin.default.register({ pluginConfig, registerImageGenerationProvider, logger: { warn } });
    }

    expect(registerImageGenerationProvider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it('does not force deprecated OpenAI Images response_format', async () => {
    const pluginSource = await readFile(
      join(repoRoot, 'resources/openclaw-plugins/clawx-openai-image/index.mjs'),
      'utf8',
    );
    const packageJson = await readFile(join(repoRoot, 'package.json'), 'utf8');
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(pluginSource).not.toContain('response_format');
    expect(packageJson).not.toContain('patch-openclaw-image-b64-json');
    expect(bundleScript).not.toContain('response_format: "b64_json"');
  });

  it('resolves the OpenClaw auth-profile key for an OpenAI-compatible request', async () => {
    const requestBodies: string[] = [];
    let authorization = '';
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requestBodies.push(Buffer.concat(chunks).toString('utf8'));
        authorization = req.headers.authorization || '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ b64_json: PNG_IMAGE_BYTES.toString('base64') }],
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const authStore = {
        version: 1,
        profiles: {
          'clawx-openai-image:default': {
            type: 'api_key',
            provider: 'clawx-openai-image',
            key: 'test-auth-profile-key',
          },
        },
        order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
        lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
      };

      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        isConfigured?: (context: Record<string, unknown>) => boolean;
        generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[] }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');

      const cfg = {
        models: {
          providers: {
            'clawx-openai-image': {
              baseUrl: `http://127.0.0.1:${address.port}/v1`,
              api: 'openai-completions',
              models: [{ id: 'gpt-image-2' }],
            },
          },
        },
      };

      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'paint a fox',
        quality: 'high',
        outputFormat: 'png',
        background: 'opaque',
        providerOptions: {
          openai: {
            background: 'opaque',
            moderation: 'auto',
            outputCompression: 90,
            user: 'webchat-user',
          },
        },
        cfg,
        agentDir: '/tmp/clawx-openai-image-test-agent',
        authStore,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(result?.images).toHaveLength(1);
      expect(authorization).toBe('Bearer test-auth-profile-key');
      expect(JSON.parse(requestBodies[0]!)).toEqual({
        model: 'gpt-image-2',
        prompt: 'paint a fox',
        n: 1,
        size: '1024x1024',
        quality: 'high',
        output_format: 'png',
        background: 'opaque',
        moderation: 'auto',
        user: 'webchat-user',
      });

      await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'paint a second fox',
        cfg,
        agentDir: '/tmp/clawx-openai-image-test-agent',
        authStore,
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(JSON.parse(requestBodies[1]!)).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'paint a second fox',
        size: '1024x1024',
        quality: 'medium',
      });
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('[clawx-openai-image] request_done'));
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15_000);

  it('sends a future managed model, exact size, and ultra quality without static fallback', async () => {
    const requestBodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requestBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ b64_json: PNG_IMAGE_BYTES.toString('base64') }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        defaultModel: string;
        models: string[];
        generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[]; model?: string }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: {
          defaultModel: 'future-image-model',
          defaultSize: '2048x3072',
          defaultQuality: 'ultra',
          models: [{
            id: 'future-image-model',
            sizes: ['2048x3072', '3072x2048'],
            qualities: ['studio', 'ultra'],
            defaultSize: '2048x3072',
            defaultQuality: 'ultra',
            enabled: true,
          }],
        },
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      expect(provider).toMatchObject({
        defaultModel: 'future-image-model',
        models: ['future-image-model'],
      });
      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'future-image-model',
        prompt: 'Create a future catalog fixture.',
        size: '3072x2048',
        quality: 'ultra',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': { baseUrl: `http://127.0.0.1:${address.port}/v1` },
            },
          },
        },
        authStore: {
          version: 1,
          profiles: {
            'clawx-openai-image:default': {
              type: 'api_key', provider: 'clawx-openai-image', key: 'test-auth-profile-key',
            },
          },
          order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
          lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
        },
        agentDir: '/tmp/clawx-openai-image-future-model-agent',
      });

      expect(result?.images).toHaveLength(1);
      expect(result?.model).toBe('future-image-model');
      expect(requestBodies).toEqual([expect.objectContaining({
        model: 'future-image-model',
        size: '3072x2048',
        quality: 'ultra',
      })]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('applies composer options only after the model has selected image_generate', async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), 'clawx-image-preference-plugin-'));
    const previousStateDirectory = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDirectory;

    try {
      const preferenceDirectory = join(stateDirectory, 'uclaw-turn-preferences');
      await mkdir(preferenceDirectory, { recursive: true });
      const sessionKey = 'agent:main:image-options';
      const prompt = 'Create a blue coffee cup on a white table.';
      const preference = {
        version: 2,
        id: 'c91ec831-6c3f-43aa-9c77-6aa2f5deeb03',
        sessionKey,
        messageDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
        messageLength: prompt.length,
        imageOptions: { modelId: 'gpt-image-2', size: '3840x2160', quality: 'medium' },
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      await writeFile(
        join(preferenceDirectory, `turn-${preference.id}.json`),
        JSON.stringify(preference),
        { encoding: 'utf8', mode: 0o600 },
      );

      const hooks = new Map<string, (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown>();
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider() {},
        on(name: string, handler: (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown) {
          hooks.set(name, handler);
        },
      });

      const context = { sessionKey, runId: 'run-image-options' };
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
      expect(promptResult).toEqual(expect.objectContaining({ appendContext: expect.stringContaining('image generation mode') }));
      expect(await readdir(preferenceDirectory)).toEqual([]);

      const nonImageResult = await hooks.get('before_tool_call')?.({
        toolName: 'web_search',
        params: { query: 'coffee cup' },
      }, context);
      expect(nonImageResult).toBeUndefined();

      const imageResult = await hooks.get('before_tool_call')?.({
        toolName: 'image_generate',
        params: {
          model: 'model-chosen-by-agent',
          prompt,
          size: '1024x1024',
          quality: 'high',
        },
      }, context);
      expect(imageResult).toEqual({
        params: {
          model: 'gpt-image-2',
          prompt,
          size: '3840x2160',
          quality: 'medium',
        },
      });
    } finally {
      if (previousStateDirectory === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDirectory;
      }
      await rm(stateDirectory, { recursive: true, force: true });
    }
  });

  it('accepts bounded OpenAI-compatible image response shapes', async () => {
    const imageBytes = PNG_IMAGE_BYTES;
    const encoded = imageBytes.toString('base64');
    const dataUrl = `data:image/png;base64,${encoded}`;
    let postRequestCount = 0;
    let mediaRequestCount = 0;
    let postRequestPath = '';
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/compatible.png') {
        mediaRequestCount += 1;
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(imageBytes);
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      postRequestCount += 1;
      postRequestPath = req.url || '';
      req.once('end', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server failed to expose its port');
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'provider-compatible-shapes',
        });
        res.end(JSON.stringify({
          images: [
            { base64: encoded, mime_type: 'image/png' },
            { image: encoded },
          ],
          output: [{ type: 'image_generation_call', result: encoded }],
          data: {
            images: [{ image_url: dataUrl }],
            data: [
              { b64_json: encoded },
              { url: `http://127.0.0.1:${address.port}/compatible.png` },
            ],
          },
          result: { image: { data: dataUrl } },
        }));
      });
      req.resume();
    });
    const controller = new AbortController();
    const dispose = createHttpTestDisposer(server, { controllers: [controller] });
    onTestFinished(dispose);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        generateImage: (req: Record<string, unknown>) => Promise<{ images: Array<{ buffer: Buffer }> }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const authStore = {
        version: 1,
        profiles: {
          'clawx-openai-image:default': {
            type: 'api_key',
            provider: 'clawx-openai-image',
            key: 'test-auth-profile-key',
          },
        },
        order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
        lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
      };
      const request = {
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate a compatibility fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
            },
          },
        },
        authStore,
        agentDir: '/tmp/clawx-openai-image-shape-test-agent',
      };

      const result = await provider?.generateImage({
        ...request,
        inputImages: [{
          buffer: Buffer.from('reference-image-bytes'),
          mimeType: 'image/png',
          fileName: 'reference.png',
        }],
        signal: controller.signal,
      });
      expect(result?.images).toHaveLength(7);
      expect(result?.images.map((image) => image.buffer)).toEqual(
        Array.from({ length: 7 }, () => imageBytes),
      );
      expect(postRequestCount).toBe(1);
      expect(mediaRequestCount).toBe(1);
      expect(postRequestPath).toBe('/v1/images/edits');
    } finally {
      await dispose();
    }
  });

  it('accepts direct image bodies and scalar data-url responses for edit and generate', async () => {
    const requestPaths: string[] = [];
    let postRequests = 0;
    const encoded = PNG_IMAGE_BYTES.toString('base64');
    const dataUrl = `data:image/png;base64,${encoded.slice(0, 40)}\n${encoded.slice(40)}`;
    const server = http.createServer((req, res) => {
      requestPaths.push(req.url || '');
      req.resume();
      req.once('end', () => {
        postRequests += 1;
        if (postRequests === 1) {
          res.writeHead(200, {
            'content-type': 'image/png',
            'x-request-id': 'provider-direct-edit-body',
          });
          res.end(PNG_IMAGE_BYTES);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'provider-scalar-generate-body',
        });
        res.end(JSON.stringify(dataUrl));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        generateImage: (req: Record<string, unknown>) => Promise<{
          images: Array<{ buffer: Buffer; mimeType?: string }>;
        }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const baseRequest = {
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate a direct-body fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': { baseUrl: `http://127.0.0.1:${address.port}/v1` },
            },
          },
        },
        authStore: {
          version: 1,
          profiles: {
            'clawx-openai-image:default': {
              type: 'api_key', provider: 'clawx-openai-image', key: 'test-auth-profile-key',
            },
          },
          order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
          lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
        },
        agentDir: '/tmp/clawx-openai-image-direct-body-test-agent',
      };

      const editResult = await provider?.generateImage({
        ...baseRequest,
        inputImages: [{ buffer: PNG_IMAGE_BYTES, mimeType: 'image/png', fileName: 'reference.png' }],
      });
      const generateResult = await provider?.generateImage(baseRequest);

      expect(editResult?.images).toHaveLength(1);
      expect(editResult?.images[0]?.buffer).toEqual(PNG_IMAGE_BYTES);
      expect(editResult?.images[0]?.mimeType).toBe('image/png');
      expect(generateResult?.images).toHaveLength(1);
      expect(generateResult?.images[0]?.buffer).toEqual(PNG_IMAGE_BYTES);
      expect(requestPaths).toEqual(['/v1/images/edits', '/v1/images/generations']);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining(
        `root=binary bodyBytes=${PNG_IMAGE_BYTES.byteLength}`,
      ));
    } finally {
      infoSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('falls back within one response candidate and preserves each sanitized request id', async () => {
    const encoded = PNG_IMAGE_BYTES.toString('base64');
    let postRequests = 0;
    let mediaRequests = 0;
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        mediaRequests += 1;
        res.writeHead(404, {
          'content-type': 'text/plain',
          'x-request-id': 'provider-media-candidate',
        });
        res.end('signed-candidate-secret=must-not-leak');
        return;
      }
      postRequests += 1;
      req.resume();
      req.once('end', () => {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server failed to expose its port');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          response: {
            request: { trace_id: 'provider-nested-candidate' },
            output: [{
              type: 'image_generation_call',
              result: {
                b64_json: '%%%invalid-candidate-base64%%%',
                image_url: `http://127.0.0.1:${address.port}/missing.png?signature=signed-candidate-secret`,
                image: { data: encoded },
              },
            }],
          },
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        generateImage: (req: Record<string, unknown>) => Promise<{
          images: Array<{ buffer: Buffer }>;
        }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate a candidate fallback fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': { baseUrl: `http://127.0.0.1:${address.port}/v1` },
            },
          },
        },
        authStore: {
          version: 1,
          profiles: {
            'clawx-openai-image:default': {
              type: 'api_key', provider: 'clawx-openai-image', key: 'test-auth-profile-key',
            },
          },
          order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
          lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
        },
        agentDir: '/tmp/clawx-openai-image-candidate-fallback-test-agent',
      });

      expect(result?.images).toHaveLength(1);
      expect(result?.images[0]?.buffer).toEqual(PNG_IMAGE_BYTES);
      expect(postRequests).toBe(1);
      expect(mediaRequests).toBe(1);
      const diagnostics = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(diagnostics).toContain('provider-nested-candidate');
      expect(diagnostics).toContain('provider-media-candidate');
      expect(diagnostics).not.toContain('signed-candidate-secret');
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('delivers valid images and logs a sanitized summary when a sibling candidate is malformed', async () => {
    const imageBytes = PNG_IMAGE_BYTES;
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'provider-mixed-candidates',
      });
      res.end(JSON.stringify({
        data: [
          { b64_json: '%%%not-base64%%%' },
          { b64_json: imageBytes.toString('base64'), mime_type: 'image/png' },
        ],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        generateImage: (req: Record<string, unknown>) => Promise<{ images: Array<{ buffer: Buffer }> }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate a mixed candidate fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': { baseUrl: `http://127.0.0.1:${address.port}/v1` },
            },
          },
        },
        authStore: {
          version: 1,
          profiles: {
            'clawx-openai-image:default': {
              type: 'api_key', provider: 'clawx-openai-image', key: 'test-auth-profile-key',
            },
          },
          order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
          lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
        },
        agentDir: '/tmp/clawx-openai-image-mixed-candidate-agent',
      });

      expect(result?.images).toHaveLength(1);
      expect(result?.images[0]?.buffer).toEqual(imageBytes);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('image_candidates_skipped'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('provider-mixed-candidates'));
    } finally {
      infoSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('keeps only deliverable candidates from one successful response without retrying the generation request', async () => {
    const imageBytes = PNG_IMAGE_BYTES;
    const encoded = imageBytes.toString('base64');
    let postRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      postRequests += 1;
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'provider-mixed-candidates',
      });
      res.end(JSON.stringify({
        data: [
          { b64_json: Buffer.from('not-an-image-payload').toString('base64') },
          { image: { data: encoded }, mime_type: 'image/png' },
        ],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        generateImage: (req: Record<string, unknown>) => Promise<{ images: Array<{ buffer: Buffer }> }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate a mixed-candidate fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
            },
          },
        },
        authStore: {
          version: 1,
          profiles: {
            'clawx-openai-image:default': {
              type: 'api_key',
              provider: 'clawx-openai-image',
              key: 'test-auth-profile-key',
            },
          },
          order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
          lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
        },
        agentDir: '/tmp/clawx-openai-image-mixed-candidate-test-agent',
      });

      expect(result?.images).toHaveLength(1);
      expect(result?.images[0]?.buffer).toEqual(imageBytes);
      expect(postRequests).toBe(1);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('image_payload_candidate_skipped'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('provider-mixed-candidates'));
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('IMAGE_RESPONSE_INCOMPATIBLE'));
    } finally {
      infoSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects a 200 non-image URL payload and keeps a sibling real image without another generation request', async () => {
    let postRequests = 0;
    let mediaRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/not-an-image.png') {
        mediaRequests += 1;
        res.writeHead(200, {
          'content-type': 'image/png',
          'x-request-id': 'provider-false-image-media',
        });
        res.end('not-a-real-image');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      postRequests += 1;
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to expose its port');
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'provider-false-image-envelope',
      });
      res.end(JSON.stringify({
        images: [
          { url: `http://127.0.0.1:${address.port}/not-an-image.png` },
          { b64_json: PNG_IMAGE_BYTES.toString('base64') },
        ],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: {
        generateImage: (req: Record<string, unknown>) => Promise<{ images: Array<{ buffer: Buffer }> }>;
      } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate an image transport fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': { baseUrl: `http://127.0.0.1:${address.port}/v1` },
            },
          },
        },
        authStore: {
          version: 1,
          profiles: {
            'clawx-openai-image:default': {
              type: 'api_key', provider: 'clawx-openai-image', key: 'test-auth-profile-key',
            },
          },
          order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
          lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
        },
        agentDir: '/tmp/clawx-openai-image-false-image-test-agent',
      });

      expect(result?.images).toHaveLength(1);
      expect(result?.images[0]?.buffer).toEqual(PNG_IMAGE_BYTES);
      expect(postRequests).toBe(1);
      expect(mediaRequests).toBe(1);
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('IMAGE_RESPONSE_INCOMPATIBLE'));
      const diagnostics = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(diagnostics).toContain('bodyBytes=16');
      expect(diagnostics).not.toContain('not-a-real-image');
    } finally {
      infoSpy.mockRestore();
      errorSpy.mockRestore();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.each([
    {
      name: 'an incompatible response',
      kind: 'incompatible',
      expectedError: {
        code: 'IMAGE_RESPONSE_INCOMPATIBLE',
        providerRequestId: 'provider-shape-bad',
      },
      responseSummaryFragments: ['root=object', 'keys=[redacted],data'],
    },
    {
      name: 'a nested incompatible response',
      kind: 'nested-incompatible',
      expectedError: {
        code: 'IMAGE_RESPONSE_INCOMPATIBLE',
        providerRequestId: 'provider-nested-shape',
      },
      responseSummaryFragments: ['root=object', 'keys=[redacted],response'],
    },
    {
      name: 'invalid base64',
      kind: 'invalid-base64',
      expectedError: {
        code: 'IMAGE_RESPONSE_INVALID_BASE64',
        providerRequestId: 'provider-base64-bad',
      },
      responseSummaryFragments: [],
    },
    {
      name: 'an HTTP failure',
      kind: 'http',
      expectedError: {
        code: 'IMAGE_PROVIDER_HTTP_ERROR',
        providerRequestId: 'provider-http-503',
        status: 503,
      },
      responseSummaryFragments: [],
    },
    {
      name: 'a media download failure',
      kind: 'media-download',
      expectedError: {
        code: 'IMAGE_MEDIA_DOWNLOAD_FAILED',
        providerRequestId: 'provider-media-404',
        status: 404,
      },
      responseSummaryFragments: [],
    },
  ])('classifies $name without raw response leakage', async ({
    kind,
    expectedError,
    responseSummaryFragments,
  }) => {
    let generationRequests = 0;
    let mediaRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.method === 'GET') {
        mediaRequests += 1;
        res.writeHead(404, {
          'content-type': 'text/plain',
          'x-request-id': 'provider-media-404',
        });
        res.end('signed-url-secret=must-not-leak');
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }
      generationRequests += 1;
      req.once('end', () => {
        if (kind === 'nested-incompatible') {
          res.writeHead(200, {
            'content-type': 'application/json',
          });
          res.end(JSON.stringify({
            response: {
              metadata: { request_id: 'provider-nested-shape' },
              data: [{ image: 'plain-text-is-not-an-image' }],
            },
            secret: 'nested-shape-secret-must-not-leak',
          }));
          return;
        }
        if (kind === 'incompatible') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'provider-shape-bad',
          });
          res.end(JSON.stringify({
            data: [{ image: 'plain-text-is-not-an-image' }],
            secret: 'shape-secret-must-not-leak',
          }));
          return;
        }
        if (kind === 'invalid-base64') {
          res.writeHead(200, {
            'content-type': 'application/json',
            'x-request-id': 'provider-base64-bad',
          });
          res.end(JSON.stringify({ images: [{ base64: '%%%not-base64%%%' }] }));
          return;
        }
        if (kind === 'http') {
          res.writeHead(503, {
            'content-type': 'application/json',
            'x-request-id': 'provider-http-503',
          });
          res.end(JSON.stringify({
            error: {
              type: 'service_unavailable_error',
              message: 'temporarily overloaded token=http-secret-must-not-leak',
            },
          }));
          return;
        }
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server failed to expose its port');
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-request-id': 'provider-media-envelope',
        });
        res.end(JSON.stringify({ images: [{ url: `http://127.0.0.1:${address.port}/missing.png` }] }));
      });
      req.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const controller = new AbortController();
    const dispose = createHttpTestDisposer(server, {
      controllers: [controller],
      restore: [() => infoSpy.mockRestore(), () => errorSpy.mockRestore()],
    });
    onTestFinished(dispose);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: { generateImage: (req: Record<string, unknown>) => Promise<unknown> } | undefined;
      plugin.default.register({
        pluginConfig: IMAGE_PLUGIN_CONFIG,
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });
      if (!provider) throw new Error('Image provider was not registered');
      const authStore = {
        version: 1,
        profiles: {
          'clawx-openai-image:default': {
            type: 'api_key',
            provider: 'clawx-openai-image',
            key: 'test-auth-profile-key',
          },
        },
        order: { 'clawx-openai-image': ['clawx-openai-image:default'] },
        lastGood: { 'clawx-openai-image': 'clawx-openai-image:default' },
      };
      const request = {
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'Generate an error fixture.',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
            },
          },
        },
        authStore,
        agentDir: '/tmp/clawx-openai-image-error-test-agent',
        signal: controller.signal,
      };

      let capturedError: (Error & {
        code?: string;
        providerRequestId?: string;
        responseSummary?: string;
        status?: number;
      }) | undefined;
      try {
        await provider.generateImage(request);
      } catch (error) {
        capturedError = error as typeof capturedError;
      }
      if (!capturedError) throw new Error(`Expected ${kind} image generation to fail`);

      expect(capturedError).toMatchObject(expectedError);
      for (const fragment of responseSummaryFragments) {
        expect(capturedError.responseSummary).toContain(fragment);
      }
      expect(generationRequests).toBe(1);
      expect(mediaRequests).toBe(kind === 'media-download' ? 1 : 0);

      const diagnosticOutput = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      for (const secret of [
        'shape-secret-must-not-leak',
        'nested-shape-secret-must-not-leak',
        'http-secret-must-not-leak',
        'signed-url-secret=must-not-leak',
        'test-auth-profile-key',
      ]) {
        expect(diagnosticOutput).not.toContain(secret);
        expect(capturedError.message).not.toContain(secret);
      }
      expect(diagnosticOutput).not.toContain('responseBody');
    } finally {
      await dispose();
    }
  });

  it.each([
    {
      name: 'a localhost hostname',
      imageHost: 'localhost',
      credential: 'loopback-query-secret',
    },
    {
      name: 'a direct loopback literal outside the provider origin',
      imageHost: '127.0.0.2',
      credential: 'loopback-literal-query-secret',
    },
    {
      name: 'a hostname that DNS resolves to a private address',
      imageHost: '127.0.0.1.nip.io',
      credential: 'dns-private-query-secret',
    },
  ])('rejects $name before downloading image bytes', async ({ imageHost, credential }) => {
    let mediaRequests = 0;
    const mediaServer = http.createServer((_req, res) => {
      mediaRequests += 1;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_IMAGE_BYTES);
    });
    const providerServer = http.createServer((req, res) => {
      const mediaAddress = mediaServer.address();
      if (!mediaAddress || typeof mediaAddress === 'string') {
        throw new Error('Test media server failed to expose its port');
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        images: [{
          url: `http://${imageHost}:${mediaAddress.port}/private.png?api_key=${credential}`,
        }],
      }));
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const disposeProvider = createHttpTestDisposer(providerServer, {
      restore: [() => infoSpy.mockRestore(), () => errorSpy.mockRestore()],
    });
    const disposeMedia = createHttpTestDisposer(mediaServer);
    const dispose = async () => {
      await Promise.all([disposeProvider(), disposeMedia()]);
    };
    onTestFinished(dispose);
    try {
      await Promise.all([
        new Promise<void>((resolve) => providerServer.listen(0, '127.0.0.1', resolve)),
        new Promise<void>((resolve) => mediaServer.listen(0, '127.0.0.1', resolve)),
      ]);
      const providerAddress = providerServer.address();
      const mediaAddress = mediaServer.address();
      if (!providerAddress || typeof providerAddress === 'string') {
        throw new Error('Test provider server failed to bind to a port');
      }
      if (!mediaAddress || typeof mediaAddress === 'string') {
        throw new Error('Test media server failed to bind to a port');
      }
      expect(providerAddress.port).not.toBe(mediaAddress.port);
      const provider = await registeredImageProvider();
      const error = await captureImageProviderError(
        provider.generateImage(imageGenerationRequest(providerAddress.port)),
      );

      expectSanitizedImageFailure(error, credential);
      expect(mediaRequests).toBe(0);
      const diagnostics = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(diagnostics).not.toContain(credential);
    } finally {
      await dispose();
    }
  }, 15_000);

  it('validates every redirect hop and refuses a redirect to a private address', async () => {
    const credential = 'redirect-query-secret';
    let redirectRequests = 0;
    let privateTargetRequests = 0;
    const privateTargetServer = http.createServer((_req, res) => {
      privateTargetRequests += 1;
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(PNG_IMAGE_BYTES);
    });
    const redirectServer = http.createServer((req, res) => {
      const redirectAddress = redirectServer.address();
      const privateTargetAddress = privateTargetServer.address();
      if (!redirectAddress || typeof redirectAddress === 'string') {
        throw new Error('Test redirect server failed to expose its port');
      }
      if (!privateTargetAddress || typeof privateTargetAddress === 'string') {
        throw new Error('Test private target server failed to expose its port');
      }
      if (req.method === 'GET' && req.url?.startsWith('/redirect-image')) {
        redirectRequests += 1;
        res.writeHead(302, {
          location: `http://127.0.0.1:${privateTargetAddress.port}/private-target.png?token=${credential}`,
        });
        res.end();
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        images: [{
          url: `http://127.0.0.1:${redirectAddress.port}/redirect-image?signature=${credential}`,
        }],
      }));
    });
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const disposeRedirect = createHttpTestDisposer(redirectServer, {
      restore: [() => infoSpy.mockRestore(), () => errorSpy.mockRestore()],
    });
    const disposePrivateTarget = createHttpTestDisposer(privateTargetServer);
    const dispose = async () => {
      await Promise.all([disposeRedirect(), disposePrivateTarget()]);
    };
    onTestFinished(dispose);
    try {
      await Promise.all([
        new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve)),
        new Promise<void>((resolve) => privateTargetServer.listen(0, '127.0.0.1', resolve)),
      ]);
      const redirectAddress = redirectServer.address();
      const privateTargetAddress = privateTargetServer.address();
      if (!redirectAddress || typeof redirectAddress === 'string') {
        throw new Error('Test redirect server failed to bind to a port');
      }
      if (!privateTargetAddress || typeof privateTargetAddress === 'string') {
        throw new Error('Test private target server failed to bind to a port');
      }
      expect(redirectAddress.port).not.toBe(privateTargetAddress.port);
      const provider = await registeredImageProvider();
      const error = await captureImageProviderError(
        provider.generateImage(imageGenerationRequest(redirectAddress.port)),
      );

      expectSanitizedImageFailure(error, credential);
      expect(redirectRequests).toBeLessThanOrEqual(1);
      expect(privateTargetRequests).toBe(0);
      const diagnostics = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(diagnostics).not.toContain(credential);
    } finally {
      await dispose();
    }
  }, 15_000);

  it.each([
    { name: 'Content-Length', includeContentLength: true },
    { name: 'actual streamed bytes', includeContentLength: false },
  ])('bounds the provider main response by $name', async ({ includeContentLength }) => {
    const prefix = Buffer.from('{"padding":"', 'utf8');
    const suffix = Buffer.from('","images":[]}', 'utf8');
    const server = http.createServer(async (req, res) => {
      req.resume();
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (includeContentLength) headers['content-length'] = String(OVERSIZED_PROVIDER_BODY_BYTES);
      res.writeHead(200, headers);
      await writeBodyInChunks(res, OVERSIZED_PROVIDER_BODY_BYTES, prefix, suffix);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const dispose = createHttpTestDisposer(server);
    onTestFinished(dispose);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const provider = await registeredImageProvider();
      const error = await captureImageProviderError(
        provider.generateImage(imageGenerationRequest(address.port)),
      );

      expectSanitizedImageFailure(error);
      expect(String(error.code)).toMatch(
        /^IMAGE_(?:PROVIDER_(?:HTTP_ERROR|RESPONSE_TOO_LARGE)|RESPONSE_TOO_LARGE)$/u,
      );
    } finally {
      await dispose();
    }
  }, 30_000);

  it.each([
    { name: 'Content-Length', includeContentLength: true },
    { name: 'actual streamed bytes', includeContentLength: false },
  ])('bounds a compatible image download by $name', async ({ includeContentLength }) => {
    const credential = `oversized-image-${includeContentLength ? 'header' : 'stream'}-secret`;
    let mediaRequests = 0;
    const server = http.createServer(async (req, res) => {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to expose its port');
      if (req.method === 'GET') {
        mediaRequests += 1;
        const headers: Record<string, string> = { 'content-type': 'image/png' };
        if (includeContentLength) headers['content-length'] = String(OVERSIZED_IMAGE_BODY_BYTES);
        res.writeHead(200, headers);
        await writeBodyInChunks(res, OVERSIZED_IMAGE_BODY_BYTES, PNG_IMAGE_BYTES);
        return;
      }
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        images: [{
          url: `http://127.0.0.1:${address.port}/oversized.png?access_token=${credential}`,
        }],
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const dispose = createHttpTestDisposer(server, {
      restore: [() => infoSpy.mockRestore(), () => errorSpy.mockRestore()],
    });
    onTestFinished(dispose);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      const provider = await registeredImageProvider();
      const error = await captureImageProviderError(
        provider.generateImage(imageGenerationRequest(address.port)),
      );

      expectSanitizedImageFailure(error, credential);
      expect(String(error.code)).toMatch(
        /^IMAGE_(?:MEDIA_(?:DOWNLOAD_FAILED|RESPONSE_TOO_LARGE|TOO_LARGE)|RESPONSE_TOO_LARGE)$/u,
      );
      expect(mediaRequests).toBeLessThanOrEqual(1);
      const diagnostics = [...infoSpy.mock.calls, ...errorSpy.mock.calls].flat().join('\n');
      expect(diagnostics).not.toContain(credential);
    } finally {
      await dispose();
    }
  }, 45_000);
});
