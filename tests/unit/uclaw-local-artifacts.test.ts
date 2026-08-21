// @vitest-environment node

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpath as realpathCallback,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path, { resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const canonicalRealpath = promisify(realpathCallback.native);

async function canonicalCandidate(candidate: string): Promise<string> {
  return path.join(await canonicalRealpath(path.dirname(candidate)), path.basename(candidate));
}

const EXPECTED_TOOLS = [
  'create_designed_pptx_file',
  'repair_designed_pptx_file',
  'create_pptx_file',
  'create_docx_file',
  'create_xlsx_file',
  'create_dxf_file',
  'create_text_file',
  'create_html_app_file',
  'prepare_workspace_html_preview',
] as const;

describe('uclaw-local-artifacts plugin', () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('registers the local artifact tools without transcript or prompt hooks', async () => {
    const pluginPath = '../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs';
    const plugin = await import(pluginPath).catch(() => null);
    expect(plugin).not.toBeNull();

    const tools = plugin!.__test.createTools();
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(EXPECTED_TOOLS);

    const source = readFileSync(resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-local-artifacts/index.mjs'), 'utf8');
    expect(source).toContain('api.registerTool(tool)');
    expect(source).not.toMatch(/registerHook|before_prompt_build|before_message_write|transcript/iu);
  });

  it('publishes the bundled CAD skill through the active plugin manifest', () => {
    const manifest = JSON.parse(readFileSync(
      resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-local-artifacts/openclaw.plugin.json'),
      'utf8',
    )) as { skills?: string[]; contracts?: { tools?: string[] } };

    expect(manifest.skills).toEqual(['skills']);
    expect(manifest.contracts?.tools).toContain('create_dxf_file');
    expect(manifest.contracts?.tools).toContain('prepare_workspace_html_preview');
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

  it('keeps output directories inside the canonical workspace', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-output-boundary-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    tempRoots.push(root);

    const valid = await plugin.__test.uniqueOutputPath(
      { cwd: workspace },
      { outputDir: 'nested/exports', filename: 'report' },
      'txt',
      'fallback',
    );
    expect(path.relative(
      await canonicalRealpath(workspace),
      await canonicalCandidate(valid),
    )).toBe(path.join('nested', 'exports', 'report.txt'));

    await expect(plugin.__test.uniqueOutputPath(
      { cwd: workspace },
      { outputDir: '../outside', filename: 'escape' },
      'txt',
      'fallback',
    )).rejects.toThrow(/parent-directory traversal/u);
    await expect(plugin.__test.uniqueOutputPath(
      { cwd: workspace },
      { outputDir: outside, filename: 'escape' },
      'txt',
      'fallback',
    )).rejects.toThrow(/must stay inside/u);
  });

  it('treats Windows short and long workspace paths as one canonical location and preserves collision suffixes', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-output-alias-'));
    const shortWorkspace = path.join(root, 'workspace');
    mkdirSync(shortWorkspace);
    tempRoots.push(root);

    const longWorkspace = await canonicalRealpath(shortWorkspace);
    const firstCandidate = await plugin.__test.uniqueOutputPath(
      { cwd: shortWorkspace },
      { outputDir: 'nested/exports', filename: 'report' },
      'txt',
      'fallback',
    );
    writeFileSync(firstCandidate, 'first');

    const collisionCandidate = await plugin.__test.uniqueOutputPath(
      { cwd: longWorkspace },
      { outputDir: path.join(longWorkspace, 'nested', 'exports'), filename: 'report' },
      'txt',
      'fallback',
    );

    const canonicalOutputDir = await canonicalRealpath(path.join(longWorkspace, 'nested', 'exports'));
    expect(await canonicalCandidate(firstCandidate)).toBe(path.join(canonicalOutputDir, 'report.txt'));
    expect(await canonicalCandidate(collisionCandidate)).toBe(path.join(canonicalOutputDir, 'report_2.txt'));
    expect(readFileSync(firstCandidate, 'utf8')).toBe('first');
    expect(existsSync(collisionCandidate)).toBe(false);
  });

  it('rejects output directories that escape through a symlink or junction', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-output-link-'));
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside');
    const linkedOutput = path.join(workspace, 'linked-output');
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, linkedOutput, process.platform === 'win32' ? 'junction' : 'dir');
    tempRoots.push(root);

    await expect(plugin.__test.uniqueOutputPath(
      { cwd: workspace },
      { outputDir: 'linked-output', filename: 'escape' },
      'txt',
      'fallback',
    )).rejects.toThrow(/resolves outside/u);
  });

  it('does not select an existing symlink as the output candidate', async () => {
    const plugin = await import('../../resources/openclaw-plugins/uclaw-local-artifacts/index.mjs');
    const root = mkdtempSync(path.join(tmpdir(), 'uclaw-output-candidate-'));
    const workspace = path.join(root, 'workspace');
    const outputs = path.join(workspace, 'outputs');
    const outsideFile = path.join(root, 'outside.txt');
    mkdirSync(outputs, { recursive: true });
    writeFileSync(outsideFile, 'unchanged');
    symlinkSync(outsideFile, path.join(outputs, 'report.txt'), 'file');
    tempRoots.push(root);

    const candidate = await plugin.__test.uniqueOutputPath(
      { cwd: workspace },
      { filename: 'report' },
      'txt',
      'fallback',
    );
    expect(await canonicalRealpath(path.dirname(candidate))).toBe(await canonicalRealpath(outputs));
    expect(path.basename(candidate)).toBe('report_2.txt');
    expect(readFileSync(outsideFile, 'utf8')).toBe('unchanged');
    expect(existsSync(candidate)).toBe(false);
  });

  it('never invokes a command shell for openAfterCreate', () => {
    const source = readFileSync(resolve(process.cwd(), 'resources/openclaw-plugins/uclaw-local-artifacts/index.mjs'), 'utf8');
    expect(source).not.toMatch(/node:child_process|cmd(?:\.exe)?|\/c['"],\s*['"]start/iu);
    expect(source).toContain('The host UI owns opening generated files');
  });
});
