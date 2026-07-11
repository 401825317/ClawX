import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeAgentTurnContract,
  turnContractRequiresArtifact,
  turnContractRequiresApproval,
  turnContractRequiresToolEvidence,
  turnContractRequiresVerification,
} from '../shared/agent-turn-contract.ts';

test('artifact contracts derive delivery evidence requirements', () => {
  const contract = normalizeAgentTurnContract({
    intent: 'artifact',
    toolRequirement: 'required',
    sideEffect: 'local_artifact',
    sideEffectAuthorized: true,
    capabilityRefs: ['presentation-maker', 'presentation-maker'],
  });

  assert.deepEqual(contract.capabilityRefs, ['presentation-maker']);
  assert.equal(turnContractRequiresArtifact(contract), true);
  assert.equal(turnContractRequiresVerification(contract), true);
  assert.equal(turnContractRequiresToolEvidence(contract), true);
  assert.equal(turnContractRequiresApproval(contract), false);
});

test('external contracts require approval and do not default to user authorization', () => {
  const contract = normalizeAgentTurnContract({
    intent: 'desktop',
    toolRequirement: 'required',
    sideEffect: 'external_action',
  });

  assert.equal(contract.sideEffectAuthorized, false);
  assert.equal(turnContractRequiresApproval(contract), true);
});

test('a side-effecting contract cannot pretend no tool is required', () => {
  assert.throws(() => normalizeAgentTurnContract({
    intent: 'media',
    toolRequirement: 'none',
    sideEffect: 'remote_generation',
  }), /side-effecting/u);
});
