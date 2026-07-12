import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  patchOpenClawSystemPromptReasoningLabelContent,
  patchOpenClawSystemPromptReasoningLabelRuntime,
} from './openclaw-system-prompt-reasoning-label-patch.mjs';

const fixture = `function buildSystemPrompt(params) {
\tconst lines = [];
\tconst runtimeInfo = {};
\tconst runtimeChannel = "webchat";
\tconst runtimeCapabilities = [];
\tconst reasoningLevel = params.reasoningLevel ?? "off";
\tlines.push("## Runtime", buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities, params.defaultThinkLevel), \`Reasoning: \${reasoningLevel} (hidden unless on/stream). Toggle /reasoning; /status shows Reasoning when enabled.\`);
\treturn lines.join("\\n");
}
function buildRuntimeLine(runtimeInfo, runtimeChannel, runtimeCapabilities = [], defaultThinkLevel) {
\treturn \`Runtime: thinking=\${defaultThinkLevel ?? "off"}\`;
}`;

const patched = patchOpenClawSystemPromptReasoningLabelContent(fixture, 'system-prompt.js');
assert.equal(patched.changed, true);
assert.equal(patched.matched, true);
assert.match(patched.content, /Thinking effort:/u);
assert.match(patched.content, /change it with \/think/u);
assert.match(patched.content, /Reasoning visibility:/u);
assert.match(patched.content, /"off" does not disable model thinking/u);
assert.match(patched.content, /answer from Thinking effort only/u);
const rendered = Function(`${patched.content}\nreturn buildSystemPrompt({ reasoningLevel: "off", defaultThinkLevel: "xhigh" });`)();
assert.match(rendered, /Thinking effort: xhigh/u);
assert.match(rendered, /Reasoning visibility: off/u);

const idempotent = patchOpenClawSystemPromptReasoningLabelContent(patched.content, 'system-prompt.js');
assert.equal(idempotent.changed, false);
assert.equal(idempotent.matched, true);

const distDir = mkdtempSync(join(tmpdir(), 'uclaw-reasoning-label-'));
const targetFile = join(distDir, 'system-prompt-config.js');
writeFileSync(targetFile, fixture, 'utf8');
writeFileSync(join(distDir, 'unrelated.js'), 'export const value = 1;', 'utf8');

const first = patchOpenClawSystemPromptReasoningLabelRuntime(distDir, { logger: { log() {} } });
assert.equal(first.patchedFiles, 1);
assert.match(readFileSync(targetFile, 'utf8'), /UCLAW_REASONING_VISIBILITY_LABEL_V2/u);

const second = patchOpenClawSystemPromptReasoningLabelRuntime(distDir, { logger: { log() {} } });
assert.equal(second.patchedFiles, 0);
assert.equal(second.alreadyPatchedFiles, 1);

console.log('openclaw system prompt reasoning label patch tests passed');
