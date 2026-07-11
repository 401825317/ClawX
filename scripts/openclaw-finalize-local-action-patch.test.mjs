import assert from 'node:assert/strict';
import test from 'node:test';

import {
  hasSuccessfulDesignedPresentationArtifact,
  patchArtifactRevisionToolChoiceContent,
} from './openclaw-finalize-local-action-patch.mjs';

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

test('does not force a schema-less tool on artifact retry attempts', () => {
  const once = patchArtifactRevisionToolChoiceContent(fixture);
  assert.equal(once.changed, false);
  assert.doesNotMatch(once.content, /nextAttemptToolChoiceOverride/);
  assert.doesNotMatch(once.content, /toolChoice: forcedToolChoice/);
  assert.doesNotMatch(once.content, /presentationExecutionContractActive/);
  assert.doesNotMatch(once.content, /persistentPresentationToolChoice/);
  assert.doesNotMatch(once.content, /hasSuccessfulPresentationArtifact/);

  const twice = patchArtifactRevisionToolChoiceContent(once.content);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
});

test('leaves unrelated runtime bundles unchanged', () => {
  const result = patchArtifactRevisionToolChoiceContent('const unrelated = true;');
  assert.equal(result.changed, false);
});

test('only a passed designed or repaired PPT after the latest user releases the tool requirement', () => {
  const passed = (toolId) => ({
    role: 'toolResult',
    content: JSON.stringify({
      tool: { id: toolId },
      result: {
        ok: true,
        kind: 'presentation',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        verification: { status: 'passed' },
      },
    }),
  });
  assert.equal(hasSuccessfulDesignedPresentationArtifact([
    { role: 'user', content: 'make a PPT' },
    passed('openclaw:uclaw-local-artifacts:create_pptx_file'),
  ]), false);
  assert.equal(hasSuccessfulDesignedPresentationArtifact([
    { role: 'user', content: 'make a PPT' },
    {
      role: 'toolResult',
      content: JSON.stringify({
        tool: { id: 'openclaw:uclaw-local-artifacts:create_designed_pptx_file' },
        result: { ok: false, verification: { status: 'blocked' } },
      }),
    },
    passed('openclaw:uclaw-local-artifacts:create_pptx_file'),
  ]), false);
  assert.equal(hasSuccessfulDesignedPresentationArtifact([
    passed('openclaw:uclaw-local-artifacts:create_designed_pptx_file'),
    { role: 'user', content: 'make another PPT' },
    { role: 'toolResult', content: '{"ok":false,"verification":{"status":"blocked"}}' },
  ]), false);
  assert.equal(hasSuccessfulDesignedPresentationArtifact([
    { role: 'user', content: 'make a PPT' },
    passed('openclaw:uclaw-local-artifacts:repair_designed_pptx_file'),
  ]), true);
});
