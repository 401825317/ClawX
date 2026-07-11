import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractEffectiveToolEntries,
  normalizeRuntimeSkillEntries,
} from '../electron/services/agent-runtime/runtime-capability-catalog.ts';

test('extracts real tool descriptors without inventing catalog group names', () => {
  const entries = extractEffectiveToolEntries({
    groups: [{
      name: 'media-tools',
      tools: [{
        name: 'video_generate',
        description: 'Generate a video.',
        parameters: { type: 'object' },
      }],
    }],
  });

  assert.deepEqual(entries.map((entry) => entry.id), ['tool:video_generate']);
  assert.equal(entries[0]?.availability, 'available');
});

test('marks disabled runtime skills unavailable without reading disk-only skills as executable', () => {
  const entries = normalizeRuntimeSkillEntries([
    { id: 'presentation-maker', name: 'Presentation maker', enabled: true },
    { id: 'desktop-control', name: 'Desktop control', enabled: false },
  ]);

  assert.equal(entries.length, 2);
  assert.equal(entries.find((entry) => entry.id === 'skill:presentation-maker')?.availability, 'available');
  assert.equal(entries.find((entry) => entry.id === 'skill:desktop-control')?.availability, 'unavailable');
});
