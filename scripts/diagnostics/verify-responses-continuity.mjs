import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Import the installed code, not a reimplementation of the provider adapter.
const runtime = path.resolve(process.argv[2] ?? 'node_modules/openclaw');
const pkg = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
assert.equal(pkg.version, '2026.6.10', 'Review runtime exports after an OpenClaw upgrade');
const chunks = (await readdir(path.join(runtime, 'dist')))
  .filter((name) => /^openai-responses-shared-.*\.js$/u.test(name));
assert.equal(chunks.length, 1);
const adapter = await import(pathToFileURL(path.join(runtime, 'dist', chunks[0])).href);
const model = {
  id: 'continuity-fixture', provider: 'openai', api: 'openai-responses',
  reasoning: true, input: ['text'], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const reasoning = { type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'synthetic-opaque-fixture' };
const commentary = { type: 'message', id: 'msg_fixture', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking the file.', annotations: [] }] };
const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'read', arguments: '{"path":"fixture.txt"}' };
const events = [reasoning, commentary, call].flatMap((item) => [
  { type: 'response.output_item.added', item: structuredClone(item) },
  { type: 'response.output_item.done', item: structuredClone(item) },
]);
events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed' } });
const output = adapter.r(model);
const emitted = [];
async function* source() { yield* events; }
await adapter.i(source(), output, { push: (event) => emitted.push(event) }, model);
assert.equal(output.stopReason, 'toolUse');
assert.ok(emitted.some((event) => event.type === 'toolcall_end'));
assert.equal(JSON.parse(output.content.find((block) => block.type === 'thinking').thinkingSignature).encrypted_content, reasoning.encrypted_content);
// Disk serialization must not erase the opaque state or tool identity.
const history = JSON.parse(JSON.stringify([
  { role: 'user', content: 'Read the fixture.', timestamp: 1 }, output,
  { role: 'toolResult', toolCallId: 'call_fixture|fc_fixture', toolName: 'read', content: [{ type: 'text', text: 'fixture-value=42' }], isError: false, timestamp: 2 },
  { role: 'user', content: 'Use that value in the next step.', timestamp: 3 },
]));
for (const replayResponsesItemIds of [false, true]) {
  const replay = adapter.n(model, { messages: history }, new Set(['openai']), { replayResponsesItemIds });
  assert.equal(replay.find((item) => item.type === 'reasoning').encrypted_content, reasoning.encrypted_content);
  assert.equal(replay.find((item) => item.role === 'assistant').phase, 'commentary');
  const toolCall = replay.find((item) => item.type === 'function_call');
  const result = replay.find((item) => item.type === 'function_call_output');
  assert.equal(toolCall.call_id, result.call_id);
  assert.equal(result.output, 'fixture-value=42');
  assert.deepEqual(JSON.parse(toolCall.arguments), { path: 'fixture.txt' });
}
const params = {};
adapter.t(params, model, { messages: [] }, { reasoningEffort: 'high' });
assert.equal(params.reasoning.effort, 'high');
assert.ok(params.include.includes('reasoning.encrypted_content'));
console.log(JSON.stringify({ runtime, version: pkg.version, passed: ['opaque-reasoning', 'assistant-phase', 'tool-result-correlation', 'serialized-history', 'reasoning-effort'], synthetic: true }));
