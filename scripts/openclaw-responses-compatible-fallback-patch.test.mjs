import assert from 'node:assert/strict';
import {
  patchInstalledOpenClawResponsesCompatibleFallbackRuntime,
} from './openclaw-responses-compatible-fallback-patch.mjs';

const first = patchInstalledOpenClawResponsesCompatibleFallbackRuntime(process.cwd(), {
  logger: { log() {} },
});
assert.equal(first.registryMatches, 1);
assert.equal(first.transportMatches, 1);

const second = patchInstalledOpenClawResponsesCompatibleFallbackRuntime(process.cwd(), {
  logger: { log() {} },
});
assert.equal(second.registryMatches, 1);
assert.equal(second.transportMatches, 1);
assert.equal(second.patchedFiles, 0, 'the fallback patch must be idempotent');

console.log('openclaw Responses compatibility fallback patch tests passed');
