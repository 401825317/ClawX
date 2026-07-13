import assert from 'node:assert/strict';
import test from 'node:test';

import {
  patchFinalizeLocalActionContent,
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

test('restores OpenClaw side-effect finalization instead of keeping a UClaw semantic override', () => {
  const customized = `\t\t\t\tif (outcome.action !== "revise") return;
\t\t\t\tconst allowUclawArtifactRevisionAfterSideEffect = event.hadDeterministicSideEffect && typeof outcome.reason === "string" && (outcome.reason.includes("UClaw artifact delivery final reply had no completed artifact evidence."));
\t\t\t\tif (event.hadDeterministicSideEffect && !allowUclawArtifactRevisionAfterSideEffect) {
\t\t\t\t\tlog$2.warn(\`before_agent_finalize requested revision after potential side effects; finalizing runId=\${params.runId} sessionId=\${params.sessionId}\`);
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t\tbeforeAgentFinalizeRevisionReason = outcome.reason;
`;
  const cleaned = patchFinalizeLocalActionContent(customized);
  assert.equal(cleaned.changed, true);
  assert.doesNotMatch(cleaned.content, /allowUclawArtifactRevisionAfterSideEffect/);
  assert.match(cleaned.content, /if \(event\.hadDeterministicSideEffect\)/);
});
