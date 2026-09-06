import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Session } from 'node:inspector/promises';
import { createHash } from 'node:crypto';

// Read-only component profile: no model calls, credential refresh, or MCP connections.
const runtime = path.resolve(process.argv[2] ?? 'node_modules/openclaw');
const output = path.resolve(process.argv[3] ?? '.codex/diagnostics/preparation-components.json');
const stateDir = path.join(process.env.USERPROFILE, '.openclaw');
const cfg = JSON.parse(await readFile(path.join(stateDir, 'openclaw.json'), 'utf8'));
const store = JSON.parse(await readFile(path.join(stateDir, 'agents/main/agent/auth-profiles.json'), 'utf8'));
const workspaceDir = cfg.agents?.defaults?.workspace ?? path.join(stateDir, 'workspace');
const chunks = await readdir(path.join(runtime, 'dist'));
async function load(prefix) {
  const names = chunks.filter((name) => name.startsWith(prefix) && name.endsWith('.js'));
  if (names.length !== 1) throw new Error(`Expected one ${prefix} runtime chunk`);
  return import(pathToFileURL(path.join(runtime, 'dist', names[0])).href);
}
const auth = await load('external-cli-auth-selection-');
const mcp = await load('agent-bundle-mcp-runtime-');
const lsp = await load('bundle-lsp-');
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const [name, run] of [
    ['auth-scope', () => auth.t({ provider: 'openai', modelId: 'smart-latest', cfg, store, workspaceDir })],
    ['mcp-config', () => mcp.b({ cfg, workspaceDir })],
    ['lsp-config', () => lsp.n({ cfg, workspaceDir })],
  ]) {
    const outputHash = createHash('sha256').update(JSON.stringify(run()) ?? 'undefined').digest('hex');
    await inspector.post('Profiler.enable');
    await inspector.post('Profiler.start');
    const durations = [];
    for (let i = 0; i < 15; i += 1) {
      const start = performance.now();
      run();
      durations.push(Number((performance.now() - start).toFixed(2)));
    }
    const { profile } = await inspector.post('Profiler.stop');
    const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
    const parents = new Map(profile.nodes.flatMap((node) => (node.children ?? []).map((id) => [id, node.id])));
    const totals = new Map();
    profile.samples.forEach((id, index) => {
      const frames = [];
      for (let current = id; current && frames.length < 18; current = parents.get(current)) {
        const frame = nodes.get(current).callFrame;
        frames.push(`${frame.functionName || '(anonymous)'}@${frame.url.split('/').pop()}:${frame.lineNumber + 1}`);
      }
      const key = frames.join(' <- ');
      totals.set(key, (totals.get(key) ?? 0) + profile.timeDeltas[index] / 1000);
    });
    results.push({ name, outputHash, durations, hotStacks: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 12) });
  }
} finally {
  inspector.disconnect();
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ name, durations, outputHash }) => ({ name, durations, outputHash }))));
