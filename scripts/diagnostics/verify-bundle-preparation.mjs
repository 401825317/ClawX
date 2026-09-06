import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = path.resolve(process.argv[2] ?? 'node_modules/openclaw');
const fixture = await mkdtemp(path.join(tmpdir(), 'uclaw-bundle-acceptance-'));
const prior = { state: process.env.OPENCLAW_STATE_DIR, disabled: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS };
try {
  process.env.OPENCLAW_STATE_DIR = path.join(fixture, 'state');
  process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1';
  const pluginRoot = path.join(fixture, 'bundle');
  await mkdir(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  await writeFile(path.join(pluginRoot, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'uclaw-fixture', version: '1.0.0' }));
  const mcpPath = path.join(pluginRoot, '.mcp.json');
  const lspPath = path.join(pluginRoot, '.lsp.json');
  await writeFile(mcpPath, JSON.stringify({ mcpServers: { fixture: { command: 'never-executed-fixture', args: ['one'] } } }));
  await writeFile(lspPath, JSON.stringify({ lspServers: { fixture: { command: 'never-executed-lsp' } } }));
  const chunks = await readdir(path.join(runtime, 'dist'));
  const load = async (prefix) => {
    const names = chunks.filter((name) => new RegExp(`^${prefix}[A-Za-z0-9_-]{8}\\.js$`, 'u').test(name));
    assert.equal(names.length, 1);
    return import(pathToFileURL(path.join(runtime, 'dist', names[0])).href);
  };
  const mcp = await load('bundle-mcp-');
  const lsp = await load('bundle-lsp-');
  const cfg = { plugins: { enabled: true, load: { paths: [pluginRoot] }, entries: { 'uclaw-fixture': { enabled: true } } } };
  const params = { cfg, workspaceDir: fixture };
  assert.equal(mcp.r(params).config.mcpServers.fixture.command, 'never-executed-fixture');
  assert.equal(lsp.n(params).config.lspServers.fixture.command, 'never-executed-lsp');
  // Config file edits must remain visible even when the plugin index is reused.
  await writeFile(mcpPath, JSON.stringify({ mcpServers: { fixture: { command: 'never-executed-fixture', args: ['two'] } } }));
  assert.deepEqual(mcp.r(params).config.mcpServers.fixture.args, ['two']);
  cfg.plugins.entries['uclaw-fixture'].enabled = false;
  assert.deepEqual(mcp.r(params).config.mcpServers, {});
  assert.deepEqual(lsp.n(params).config.lspServers, {});
  cfg.plugins.entries['uclaw-fixture'].enabled = true;
  assert.equal(mcp.r(params).config.mcpServers.fixture.args[0], 'two');
  console.log('PASS: real bundle MCP/LSP discovery, live config edits, disable/re-enable; no servers launched.');
} finally {
  for (const [key, value] of [['OPENCLAW_STATE_DIR', prior.state], ['OPENCLAW_DISABLE_BUNDLED_PLUGINS', prior.disabled]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await rm(fixture, { recursive: true, force: true });
}
