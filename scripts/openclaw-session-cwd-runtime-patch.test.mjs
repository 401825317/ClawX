import assert from 'node:assert/strict';
import test from 'node:test';
import { patchOpenClawSessionCwdContent } from './openclaw-session-cwd-runtime-patch.mjs';

test('OpenClaw tools use the current coding root as their workspace', () => {
  const fixture = `\t\t\tfsPolicy,
\t\t\tworkspaceDir: workspaceRoot,
\t\t\tspawnWorkspaceDir: capabilityProfile.workspace.spawnWorkspaceRoot,`;
  const result = patchOpenClawSessionCwdContent(fixture);
  assert.equal(result.changed, true);
  assert.ok(result.changedRules.includes('agent-tools-current-cwd-workspace'));
  assert.match(result.content, /workspaceDir: codingRoot/u);
  assert.equal(patchOpenClawSessionCwdContent(result.content).changed, false);
});
