import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  patchOpenClawPluginToolRunContextContent,
  patchOpenClawPluginToolRunContextRuntime,
} from './openclaw-plugin-tool-run-context-patch.mjs';

const runtimeFixture = `function resolveOpenClawPluginToolInputs(params) {
\treturn {
\t\tcontext: {
\t\t\tagentId: sessionAgentId,
\t\t\tsessionKey: options?.agentSessionKey,
\t\t\tsessionId: options?.sessionId,
\t\t\tactiveModel,
\t\t},
\t};
}`;
const typeFixture = `type OpenClawPluginToolContext = {
  sessionKey?: string; /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  sessionId?: string;
};`;
const forwardFixture = `function buildTools(options) {
\tconst pluginToolsOnly = includeOpenClawTools || !includePluginTools ? [] : resolveOpenClawPluginToolsForOptions({
\t\toptions: {
\t\t\tagentSessionKey: options?.sessionKey,
\t\t\tagentChannel: resolveGatewayMessageChannel(options?.messageProvider),
\t\t},
\t});
}`;
const resultMiddlewareFixture = `function buildAgentToolResultMiddlewareFactory(sessionManager, runId) {
\tconst runner = createAgentToolResultMiddlewareRunner({ runtime: "openclaw" });
\treturn (agent) => agent;
}`;

const patchedRuntime = patchOpenClawPluginToolRunContextContent(runtimeFixture, 'runtime.js');
assert.equal(patchedRuntime.category, 'runtime-context');
assert.equal(patchedRuntime.changed, true);
assert.match(patchedRuntime.content, /runId: options\?\.runId/);

const patchedForward = patchOpenClawPluginToolRunContextContent(forwardFixture, 'agent-tools.js');
assert.equal(patchedForward.category, 'runtime-forward');
assert.equal(patchedForward.changed, true);
assert.match(patchedForward.content, /runId: options\?\.runId/);

const patchedType = patchOpenClawPluginToolRunContextContent(typeFixture, 'types.d.ts');
assert.equal(patchedType.category, 'type');
assert.equal(patchedType.changed, true);
assert.match(patchedType.content, /runId\?: string/);

const patchedResultMiddleware = patchOpenClawPluginToolRunContextContent(
  resultMiddlewareFixture,
  'attempt.model-diagnostic-events.js',
);
assert.equal(patchedResultMiddleware.category, 'result-middleware-context');
assert.equal(patchedResultMiddleware.changed, true);
assert.match(patchedResultMiddleware.content, /runtime: "openclaw",\s+runId/);

const distDir = mkdtempSync(join(tmpdir(), 'uclaw-plugin-context-'));
mkdirSync(join(distDir, 'plugin-sdk'));
writeFileSync(join(distDir, 'runtime.js'), runtimeFixture, 'utf8');
writeFileSync(join(distDir, 'agent-tools.js'), forwardFixture, 'utf8');
writeFileSync(join(distDir, 'attempt.model-diagnostic-events.js'), resultMiddlewareFixture, 'utf8');
writeFileSync(join(distDir, 'types.d.ts'), typeFixture, 'utf8');
writeFileSync(join(distDir, 'plugin-sdk', 'types.d.ts'), typeFixture, 'utf8');

const first = patchOpenClawPluginToolRunContextRuntime(distDir, { logger: { log() {} } });
assert.equal(first.patchedFiles, 5);
assert.equal(first.categoryCounts['runtime-context'], 1);
assert.equal(first.categoryCounts['runtime-forward'], 1);
assert.equal(first.categoryCounts['result-middleware-context'], 1);
assert.equal(first.categoryCounts.type, 2);
assert.match(readFileSync(join(distDir, 'runtime.js'), 'utf8'), /UCLAW_PLUGIN_TOOL_RUN_CONTEXT/);
assert.match(
  readFileSync(join(distDir, 'attempt.model-diagnostic-events.js'), 'utf8'),
  /UCLAW_PLUGIN_TOOL_RUN_CONTEXT_RESULT_MIDDLEWARE/,
);

const second = patchOpenClawPluginToolRunContextRuntime(distDir, { logger: { log() {} } });
assert.equal(second.patchedFiles, 0);
assert.equal(second.alreadyPatchedFiles, 5);

console.log('openclaw plugin tool run context patch tests passed');
