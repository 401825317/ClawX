// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const EXPECTED_TOOLS = [
  'create_designed_pptx_file',
  'repair_designed_pptx_file',
  'create_pptx_file',
  'create_docx_file',
  'create_xlsx_file',
  'create_text_file',
  'create_html_app_file',
] as const;

describe('uclaw-local-artifacts plugin', () => {
  it('registers the document tools without transcript or prompt hooks', async () => {
    const pluginPath = '../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs';
    const plugin = await import(pluginPath).catch(() => null);
    expect(plugin).not.toBeNull();

    const tools = plugin!.__test.createTools();
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(EXPECTED_TOOLS);

    const source = readFileSync(resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-local-artifacts/index.mjs'), 'utf8');
    expect(source).toContain('api.registerTool(tool)');
    expect(source).not.toMatch(/registerHook|before_prompt_build|before_message_write|transcript/iu);
  });

  it('declares every runtime dependency required by packaged copies', () => {
    const packageJson = JSON.parse(readFileSync(
      resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-local-artifacts/package.json'),
      'utf8',
    )) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies).toEqual({
      '@sinclair/typebox': '^0.34.48',
      jszip: '3.10.1',
      pptxgenjs: '4.0.1',
      xlsx: '^0.18.5',
    });
  });
});
