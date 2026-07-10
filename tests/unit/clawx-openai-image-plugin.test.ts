import http from 'node:http';
import { Buffer } from 'node:buffer';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();

vi.mock('undici', () => ({
  Agent: class TestAgent {
    options: Record<string, unknown>;

    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  },
  fetch: (url: string | URL, init?: RequestInit & { dispatcher?: unknown }) => {
    const { dispatcher: _dispatcher, ...fetchInit } = init ?? {};
    return fetch(url, fetchInit);
  },
}));

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
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
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
              },
            },
          },
        },
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(result?.images).toHaveLength(1);
      const image = result?.images[0] as { fileName?: string };
      expect(image.fileName).toMatch(/^uclaw-image-1-\d{8}-\d{6}-[0-9a-f]{8}\.png$/u);
      expect(JSON.parse(requestBody)).toEqual({
        model: 'gpt-image-2',
        prompt: 'paint a fox',
        n: 1,
        size: '1024x1024',
        quality: 'high',
      });
    } finally {
      server.close();
    }
  }, 15_000);

  it('logs sanitized upstream diagnostics for failed image responses', async () => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'xAI upstream returned status 400',
            type: 'invalid_request_error',
            code: 'bad_request',
            param: 'size',
          },
          debug: 'Authorization: Bearer sk-secret-test-token',
        }));
      });
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

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

      await expect(provider?.generateImage({
        provider: 'clawx-openai-image',
        model: 'gpt-image-2',
        prompt: 'paint a fox',
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
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      })).rejects.toThrow('UClaw OpenAI image generation failed: xAI upstream returned status 400');

      const responseErrorLine = consoleErrorSpy.mock.calls
        .map((call) => String(call[0] || ''))
        .find((line) => line.includes('[clawx-openai-image] response_error '));
      expect(responseErrorLine).toBeTruthy();
      const details = JSON.parse(String(responseErrorLine).replace(/^\[clawx-openai-image\] response_error /u, ''));
      expect(details).toMatchObject({
        status: 400,
        upstreamMessage: 'xAI upstream returned status 400',
        upstreamType: 'invalid_request_error',
        upstreamCode: 'bad_request',
        upstreamParam: 'size',
      });
      expect(details.responseBody).toContain('xAI upstream returned status 400');
      expect(details.responseBody).toContain('Authorization: [REDACTED]');
      expect(details.responseBody).not.toContain('sk-secret-test-token');
    } finally {
      consoleErrorSpy.mockRestore();
      server.close();
    }
  }, 15_000);

  it('uses bundled undici fetch with the matching dispatcher implementation', async () => {
    const pluginSource = await readFile(
      join(repoRoot, 'resources/openclaw-plugins/clawx-openai-image/index.mjs'),
      'utf8',
    );

    expect(pluginSource).toContain("import { Agent, fetch as undiciFetch } from 'undici';");
    expect(pluginSource).toContain('const imageFetchDispatcher = new Agent({');
    expect(pluginSource).toContain('headersTimeout: DEFAULT_TIMEOUT_MS');
    expect(pluginSource).toContain('bodyTimeout: DEFAULT_TIMEOUT_MS');
    expect(pluginSource).toContain('const upstreamUrl = appendImagesPath(baseUrl, mode);');
    expect(pluginSource).toContain('await undiciFetch(upstreamUrl, {');
    expect(pluginSource).toContain('dispatcher: imageFetchDispatcher');
    expect(pluginSource).not.toContain('await globalThis.fetch');
  });

  it('accepts OpenAI-compatible URL image responses', async () => {
    const imageBytes = Buffer.from('url-image-bytes');
    const server = http.createServer((req, res) => {
      if (req.url === '/generated.png') {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(imageBytes);
        return;
      }

      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server failed to bind to a port');
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [{ url: `http://127.0.0.1:${address.port}/generated.png` }],
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
        agentDir: '/tmp/clawx-openai-image-test-agent',
        ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
      });

      expect(result?.images).toHaveLength(1);
      const image = result?.images[0] as { buffer?: Buffer; mimeType?: string; fileName?: string };
      expect(Buffer.from(image.buffer || [])).toEqual(imageBytes);
      expect(image.mimeType).toBe('image/png');
      expect(image.fileName).toMatch(/^uclaw-image-1-\d{8}-\d{6}-[0-9a-f]{8}\.png$/u);
    } finally {
      server.close();
    }
  }, 15_000);

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
});
