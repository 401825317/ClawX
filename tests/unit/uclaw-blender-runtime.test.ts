// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('uclaw-blender packaged runtime', () => {
  it('registers only the bounded Blender tools and requires bridge launch variables', async () => {
    const tools: Array<{
      name: string;
      execute: (...args: unknown[]) => Promise<unknown>;
    }> = [];
    const plugin = await import('../../resources/openclaw-plugins/uclaw-blender/index.mjs');
    plugin.default.register({
      registerTool(tool: typeof tools[number]) {
        tools.push(tool);
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'blender_get_capabilities',
      'create_blender_scene',
      'get_blender_job',
      'repair_blender_scene',
    ]);

    const previousOrigin = process.env.CLAWX_HOST_API_ORIGIN;
    const previousToken = process.env.CLAWX_HOST_API_TOKEN;
    delete process.env.CLAWX_HOST_API_ORIGIN;
    delete process.env.CLAWX_HOST_API_TOKEN;
    try {
      await expect(tools[0]!.execute()).rejects.toThrow('bridge origin');
    } finally {
      if (previousOrigin === undefined) delete process.env.CLAWX_HOST_API_ORIGIN;
      else process.env.CLAWX_HOST_API_ORIGIN = previousOrigin;
      if (previousToken === undefined) delete process.env.CLAWX_HOST_API_TOKEN;
      else process.env.CLAWX_HOST_API_TOKEN = previousToken;
    }
  });

  it('ships the fixed runner, schema and local plugin dependencies', () => {
    const root = process.cwd();
    const pluginSource = readFileSync(
      resolve(root, 'resources/openclaw-plugins/uclaw-blender/index.mjs'),
      'utf8',
    );
    const packageJson = JSON.parse(readFileSync(
      resolve(root, 'resources/openclaw-plugins/uclaw-blender/package.json'),
      'utf8',
    )) as { dependencies?: Record<string, string> };
    const processRunner = readFileSync(
      resolve(root, 'electron/services/blender/process-runner.ts'),
      'utf8',
    );
    const runner = readFileSync(
      resolve(root, 'resources/blender/runtime/uclaw_scene_runner.py'),
      'utf8',
    );
    const schema = JSON.parse(readFileSync(
      resolve(root, 'resources/blender/runtime/scene-spec.schema.json'),
      'utf8',
    )) as { additionalProperties?: boolean; required?: string[] };

    expect(pluginSource).not.toContain('DEFAULT_HOST_API_ORIGIN');
    expect(pluginSource).not.toContain('127.0.0.1:13210');
    expect(packageJson.dependencies).toEqual({ '@sinclair/typebox': '^0.34.48' });
    expect(processRunner).toContain("'--factory-startup', '--disable-autoexec'");
    expect(processRunner).toContain("'--python', runner");
    expect(runner).toContain('def main():');
    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ['schema', 'title', 'objects'],
    });
  });

  it('checks the Blender runtime at its Electron packaged path', () => {
    const root = process.cwd();
    const usbBuilder = readFileSync(resolve(root, 'scripts/build-usb-release.mjs'), 'utf8');
    const selfCheck = readFileSync(
      resolve(root, 'scripts/windows-support/UClaw-SelfCheck.mjs'),
      'utf8',
    );
    for (const relativePath of [
      'resources/resources/blender/runtime/uclaw_scene_runner.py',
      'resources/resources/blender/runtime/scene-spec.schema.json',
    ]) {
      expect(usbBuilder).toContain(relativePath);
      expect(selfCheck).toContain(relativePath);
    }
    for (const stalePath of [
      "'resources/blender/runtime/uclaw_scene_runner.py'",
      "'resources/blender/runtime/scene-spec.schema.json'",
    ]) {
      expect(usbBuilder).not.toContain(stalePath);
      expect(selfCheck).not.toContain(stalePath);
    }
    expect(selfCheck).toContain("'uclaw-local-artifacts'");
    expect(selfCheck).toContain("'uclaw-blender'");
  });
});
