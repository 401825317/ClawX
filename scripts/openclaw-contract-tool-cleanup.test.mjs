import assert from 'node:assert/strict';
import test from 'node:test';

import { removeOpenClawRequiredContractToolContent } from './openclaw-contract-tool-cleanup.mjs';

const original = 'const directoryRequiredToolNames = params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [];';
const patched = `const directoryRequiredToolNames = [
			...params.forceMessageTool === true || params.sourceReplyDeliveryMode === "message_tool_only" ? ["message"] : [],
			...effectiveTools.some((tool) => tool.name === "uclaw_declare_turn_contract") ? ["uclaw_declare_turn_contract"] : []
		]; // UCLAW_REQUIRED_TURN_CONTRACT_TOOL_V1`;

test('removes the retired required-contract tool patch', () => {
  const result = removeOpenClawRequiredContractToolContent(patched);
  assert.equal(result.matched, true);
  assert.equal(result.changed, true);
  assert.equal(result.content, original);
});

test('keeps an unpatched directory runtime unchanged', () => {
  const result = removeOpenClawRequiredContractToolContent(original);
  assert.equal(result.matched, true);
  assert.equal(result.changed, false);
  assert.equal(result.content, original);
});
