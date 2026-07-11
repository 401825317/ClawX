import assert from 'node:assert/strict';
import test from 'node:test';

import { applyRuntimeEventToRuns } from '../src/stores/chat/runtime-graph.ts';

test('a turn contract event is retained on the originating runtime run', () => {
  const runs = applyRuntimeEventToRuns({}, {
    contractVersion: 1,
    producer: 'plugin',
    runId: 'run-contract-graph',
    sessionKey: 'agent:main:contract',
    ts: 1,
    type: 'run.contract.updated',
    contract: {
      version: 1,
      intent: 'media',
      toolRequirement: 'required',
      sideEffect: 'remote_generation',
      sideEffectAuthorized: true,
      capabilityRefs: ['image-generation'],
      acceptance: {
        requiresArtifact: true,
        requiresVerification: true,
        requiresApproval: false,
        requiresToolEvidence: true,
      },
    },
  });

  assert.equal(runs['run-contract-graph']?.turnContract?.intent, 'media');
  assert.equal(runs['run-contract-graph']?.events[0]?.type, 'run.contract.updated');
});
