import assert from 'node:assert/strict';
import test from 'node:test';

import { patchArtifactRevisionToolChoiceContent } from './openclaw-finalize-local-action-patch.mjs';

const fixture = `
\t\t\tlet nextAttemptPromptOverride = null;
\t\t\tlet rateLimitProfileRotations = 0;
\t\t\t\t\tconst prompt = promptAdditions.length > 0 ? \`\${basePrompt}\\n\\n\${promptAdditions.join("\\n\\n")}\` : basePrompt;
\t\t\t\t\tconst resolvedStreamApiKey = resolveAttemptDispatchApiKey({
\t\t\t\t\t\textraParamsOverride: {
\t\t\t\t\t\t\t...params.streamParams,
\t\t\t\t\t\t\tfastMode: attemptFastMode
\t\t\t\t\t\t}
\t\t\t\t\t\tstreamParams: params.streamParams,
\t\t\t\t\t\tnextAttemptPromptOverride = buildBeforeAgentFinalizeRetryPrompt(beforeAgentFinalizeRevisionReason);
\t\t\t\t\t\tsuppressNextUserMessagePersistence = true;
\t\t\t\tnativeWebSearchPolicyContext
\t\t\t});
\t\t\tif (codeModeControlsEnabledForRun)
`;

test('forces the designed PPT tool only on marked artifact retry attempts', () => {
  const once = patchArtifactRevisionToolChoiceContent(fixture);
  assert.equal(once.changed, true);
  assert.match(once.content, /nextAttemptToolChoiceOverride/);
  assert.match(once.content, /beforeAgentFinalizeRevisionReason\.includes\("UClaw force artifact tool choice: create_designed_pptx_file\."\)/);
  assert.match(once.content, /toolChoice: nextAttemptToolChoiceOverride/);
  assert.match(once.content, /function: \{ name: "tool_call" \}/);
  assert.match(once.content, /streamParams: attemptStreamParams/);
  assert.match(once.content, /toolChoice: forcedToolChoice/);
  assert.match(once.content, /let forceToolChoiceOnNextCall = true/);

  const twice = patchArtifactRevisionToolChoiceContent(once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('leaves unrelated runtime bundles unchanged', () => {
  const result = patchArtifactRevisionToolChoiceContent('const unrelated = true;');
  assert.equal(result.changed, false);
});

test('upgrades the legacy hidden-tool pin to the visible directory executor', () => {
  const current = patchArtifactRevisionToolChoiceContent(fixture).content;
  const legacy = current.replace(
    'function: { name: "tool_call" }',
    'function: { name: "create_designed_pptx_file" }',
  );
  const upgraded = patchArtifactRevisionToolChoiceContent(legacy);
  assert.equal(upgraded.changed, true);
  assert.match(upgraded.content, /function: \{ name: "tool_call" \}/);
});
