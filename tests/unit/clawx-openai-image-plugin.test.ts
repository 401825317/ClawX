import http from 'node:http';
import { Buffer } from 'node:buffer';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('ClawX OpenAI image plugin request shape', () => {
  it('does not force deprecated OpenAI Images response_format', async () => {
    const pluginSource = await readFile(
      join(repoRoot, 'resources/openclaw-plugins/clawx-openai-image/index.mjs'),
      'utf8',
    );
    const packageJson = await readFile(join(repoRoot, 'package.json'), 'utf8');
    const bundleScript = await readFile(join(repoRoot, 'scripts/bundle-openclaw.mjs'), 'utf8');

    expect(pluginSource).not.toContain('response_format');
    expect(pluginSource).not.toContain('Content-Length');
    expect(pluginSource).not.toContain('contentLength');
    expect(packageJson).not.toContain('patch-openclaw-image-b64-json');
    expect(bundleScript).not.toContain('response_format: "b64_json"');
  });

  it('omits response_format from generated OpenAI-compatible requests', async () => {
    let requestBody = '';
    let requestHeaders: http.IncomingHttpHeaders = {};
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      requestHeaders = req.headers;
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requestBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: { generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[] }> } | undefined;
      plugin.default.register({
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');

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
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                apiKey: 'test-key',
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                headers: {
                  'X-UClaw-Version': '0.7.2-test',
                  'X-UClaw-Mode': 'portable',
                },
              },
            },
          },
        },
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(result?.images).toHaveLength(1);
      const image = result?.images[0] as { fileName?: string };
      expect(image.fileName).toMatch(/^clawx-image-1-\d{8}-\d{6}-[0-9a-f]{8}\.png$/u);
      expect(JSON.parse(requestBody)).toEqual({
        model: 'gpt-image-2',
        prompt: 'paint a fox',
        n: 1,
        size: '1024x1024',
        quality: 'high',
      });
      expect(requestHeaders['x-uclaw-client']).toBe('UClaw');
      expect(requestHeaders['x-uclaw-version']).toBe('0.7.2-test');
      expect(requestHeaders['x-uclaw-mode']).toBe('portable');
      expect(requestHeaders['x-uclaw-provider']).toBe('clawx-openai-image');
    } finally {
      server.close();
    }
  }, 15_000);

  it('does not set a manual Content-Length header for multipart edits', async () => {
    const originalFetch = globalThis.fetch;
    let requestHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = init?.headers;
      return new Response(JSON.stringify({
        data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: { generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[] }> } | undefined;
      plugin.default.register({
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'edit the reference',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                apiKey: 'test-key',
                baseUrl: 'http://127.0.0.1:12345/v1',
              },
            },
          },
        },
        inputImages: [
          {
            buffer: Buffer.from('fake image bytes'),
            mimeType: 'image/png',
            fileName: 'reference.png',
          },
        ],
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(result?.images).toHaveLength(1);
      const headers = requestHeaders as Record<string, string>;
      expect(headers['Content-Type']).toContain('multipart/form-data');
      expect(Object.keys(headers).map((key) => key.toLowerCase())).not.toContain('content-length');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('sends reference-image edits as multipart image uploads', async () => {
    let requestContentType = '';
    let requestBody = Buffer.alloc(0);
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      requestContentType = String(req.headers['content-type'] || '');
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requestBody = Buffer.concat(chunks);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
        }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
      let provider: { generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[] }> } | undefined;
      plugin.default.register({
        registerImageGenerationProvider(nextProvider: typeof provider) {
          provider = nextProvider;
        },
      });

      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');

      const result = await provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'remove the logo',
        quality: 'high',
        cfg: {
          models: {
            providers: {
              'clawx-openai-image': {
                apiKey: 'test-key',
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
              },
            },
          },
        },
        inputImages: [
          {
            buffer: Buffer.from('fake image bytes'),
            mimeType: 'image/png',
            fileName: 'bike.png',
          },
        ],
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(result?.images).toHaveLength(1);
      expect(requestContentType).toContain('multipart/form-data');
      const bodyText = requestBody.toString('utf8');
      expect(bodyText).toContain('name="image"');
      expect(bodyText).toContain('filename="bike.png"');
      expect(bodyText).toContain(
        'Content-Disposition: form-data; name="image"; filename="bike.png"\r\nContent-Type: image/png\r\n\r\nfake image bytes',
      );
      expect(bodyText).not.toContain('filename="bike.png"\r\n\r\nContent-Type: image/png');
      expect(bodyText).toContain('name="prompt"');
      expect(bodyText).toContain('remove the logo');
      expect(bodyText).toContain('name="model"');
      expect(bodyText).toContain('gpt-image-2');
    } finally {
      server.close();
    }
  }, 15_000);

  it('does not set a manual Content-Length header for multipart edits', async () => {
    const plugin = await import('../../resources/openclaw-plugins/clawx-openai-image/index.mjs');
    let provider: { generateImage: (req: Record<string, unknown>) => Promise<{ images: unknown[] }> } | undefined;
    plugin.default.register({
      registerImageGenerationProvider(nextProvider: typeof provider) {
        provider = nextProvider;
      },
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await provider?.generateImage({
      provider: 'clawx-openai-image',
      model: 'gpt-image-2',
      prompt: 'remove the logo',
      cfg: {
        models: {
          providers: {
            'clawx-openai-image': {
              apiKey: 'test-key',
              baseUrl: 'https://example.invalid/v1',
            },
          },
        },
      },
      inputImages: [
        {
          buffer: Buffer.from('fake image bytes'),
          mimeType: 'image/png',
          fileName: 'bike.png',
        },
      ],
    });

    expect(result?.images).toHaveLength(1);
    const init = fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined;
    expect(init?.headers).toEqual(expect.objectContaining({
      Authorization: 'Bearer test-key',
      'Content-Type': expect.stringContaining('multipart/form-data'),
    }));
    expect(init?.headers).not.toHaveProperty('Content-Length');
    expect(init?.headers).not.toHaveProperty('content-length');
  });
});
