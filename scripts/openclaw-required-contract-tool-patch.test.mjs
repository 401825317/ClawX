import assert from 'node:assert/strict';
import test from 'node:test';

import { patchOpenClawRequiredContractToolContent } from './openclaw-required-contract-tool-patch.mjs';

const fixture = `function selectDirectoryTools(params, effectiveTools) {
	const directoryRequiredToolNames = params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];
	return directoryRequiredToolNames;
}`;

test('keeps the UClaw contract schema directly visible in directory mode', () => {
  const patched = patchOpenClawRequiredContractToolContent(fixture);
  assert.equal(patched.matched, true);
  assert.equal(patched.changed, true);

  const selectDirectoryTools = Function(`${patched.content}; return selectDirectoryTools;`)();
  assert.deepEqual(selectDirectoryTools({}, [
    { name: 'image_generate' },
    { name: 'uclaw_declare_turn_contract' },
  ]), ['uclaw_declare_turn_contract']);
  assert.deepEqual(selectDirectoryTools({ forceMessageTool: true }, [
    { name: 'uclaw_declare_turn_contract' },
  ]), ['message', 'uclaw_declare_turn_contract']);
  assert.deepEqual(selectDirectoryTools({}, [{ name: 'image_generate' }]), []);
});

test('is idempotent and ignores unrelated runtime files', () => {
  const once = patchOpenClawRequiredContractToolContent(fixture);
  const twice = patchOpenClawRequiredContractToolContent(once.content);
  assert.equal(twice.matched, true);
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);

  const unrelated = patchOpenClawRequiredContractToolContent('const value = 1;');
  assert.equal(unrelated.matched, false);
  assert.equal(unrelated.changed, false);
});
