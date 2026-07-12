import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractEffectiveToolEntries,
  normalizeReportedCapability,
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

test('uses the concrete Host capability status instead of treating any response object as available', () => {
  const capabilities = {
    capabilities: [
      { name: 'desktop.capture', status: 'unavailable', reason: 'Screen Recording permission is denied.' },
      { name: 'desktop.actions', status: 'not-implemented', reason: 'Native action driver is missing.' },
    ],
  };

  assert.deepEqual(normalizeReportedCapability(capabilities, 'desktop.capture'), {
    availability: 'unavailable',
    reason: 'Screen Recording permission is denied.',
  });
  assert.deepEqual(normalizeReportedCapability(capabilities, 'desktop.actions'), {
    availability: 'not_implemented',
    reason: 'Native action driver is missing.',
  });
  assert.deepEqual(normalizeReportedCapability(capabilities, 'desktop.accessibility'), {
    availability: 'unknown',
    reason: 'Host did not report desktop.accessibility.',
  });
});
