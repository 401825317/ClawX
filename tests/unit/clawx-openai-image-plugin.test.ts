import http from 'node:http';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const repoRoot = process.cwd();

describe('ClawX OpenAI image plugin request shape', () => {
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
          data: [{ b64_json: Buffer.from('fake-image').toString('base64') }],
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
        version: 1,
        id: 'c91ec831-6c3f-43aa-9c77-6aa2f5deeb03',
        sessionKey,
        messageDigest: createHash('sha256').update(prompt, 'utf8').digest('hex'),
        messageLength: prompt.length,
        imageOptions: { size: '3840x2160', quality: 'medium' },
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
          model: 'model-chosen-by-agent',
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
});
