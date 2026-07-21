import assert from 'node:assert/strict';
import test from 'node:test';

import { __test } from './openclaw-compaction-session-state-patch.mjs';

test('latest finishing lifecycle clears a recovered overflow error', () => {
  const source = `
const DEFERRED_TERMINAL_METADATA_KEYS = ["livenessState", "replayInvalid"];
function readStringValue(value) {
  return typeof value === "string" && value ? value : undefined;
}
function resolveAgentLifecycleTerminalMetadata(data) {
  const metadata = {};
  for (const key of DEFERRED_TERMINAL_METADATA_KEYS) {
    if (Object.hasOwn(data, key)) metadata[key] = data[key];
  }
  return metadata;
}
function createBackstop() {
	let deferredError;
	const deferredTerminalMetadata = {};
	const note = (evt) => {
		const phase = readStringValue(evt.data.phase);
		if (phase === "finishing") {
			deferredError = readStringValue(evt.data.error) ?? deferredError;
			Object.assign(deferredTerminalMetadata, resolveAgentLifecycleTerminalMetadata(evt.data));
		}
	};
	return {
		note,
		getDeferredError: () => deferredError,
		getMetadata: () => ({ ...deferredTerminalMetadata }),
	};
}
`;

  const patched = __test.patchFileContent(source, 'reply-usage-state.js');
  assert.equal(patched.changed, true);
  assert.deepEqual(patched.categories, ['lifecycle-terminal']);

  const createBackstop = new Function(`${patched.content}\nreturn createBackstop;`)();
  const backstop = createBackstop();
  backstop.note({
    data: {
      phase: 'finishing',
      error: 'Context overflow',
      livenessState: 'blocked',
      replayInvalid: true,
    },
  });
  backstop.note({
    data: {
      phase: 'finishing',
      livenessState: 'working',
    },
  });

  assert.equal(backstop.getDeferredError(), undefined);
  assert.deepEqual(backstop.getMetadata(), { livenessState: 'working' });
});
