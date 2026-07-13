import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatVideoAttachmentMetadata,
  hasUsefulVideoAttachmentMetadata,
  parseAvMediaInfo,
} from '../shared/video-attachment-metadata.ts';

test('parses actual video dimensions, duration, and audio from avmediainfo', () => {
  const metadata = parseAvMediaInfo(`
Asset: /tmp/video.mp4
Duration: 8.042 seconds (8042/1000)
Track count: 2
Track 1: Video 'vide'
  Format Description 1:
    Dimensions: 480 x 848
    Presentation Dimensions: 480 x 848
Track 2: Sound 'soun'
  Format Description 1:
    Format: MPEG-4 AAC 'aac '
`);

  assert.deepEqual(metadata, {
    width: 480,
    height: 848,
    durationSeconds: 8.042,
    hasAudio: true,
  });
  assert.equal(formatVideoAttachmentMetadata(metadata), '480 x 848 · 8.0s · 有音轨');
  assert.equal(hasUsefulVideoAttachmentMetadata(metadata), true);
});

test('reports a valid silent video without inventing missing dimensions', () => {
  const metadata = parseAvMediaInfo(`
Asset: /tmp/video.mp4
Duration: 12.000 seconds (12/1)
Track count: 1
Track 1: Video 'vide'
`);

  assert.deepEqual(metadata, {
    width: undefined,
    height: undefined,
    durationSeconds: 12,
    hasAudio: false,
  });
  assert.equal(formatVideoAttachmentMetadata(metadata), '12s · 无音轨');
});

test('returns no label when no metadata is known', () => {
  assert.equal(formatVideoAttachmentMetadata({}), null);
  assert.equal(hasUsefulVideoAttachmentMetadata({}), false);
});
