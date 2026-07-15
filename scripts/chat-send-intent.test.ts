import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cloneChatSendIntent,
  cloneChatSendReplayIntent,
  createChatSendIntent,
} from '../src/stores/chat/send-intent.ts';

test('send-intent ledger preserves exact media and model inputs without lifecycle state', () => {
  const attachment = {
    fileName: 'prompt.txt',
    mimeType: 'text/plain',
    fileSize: 12,
    stagedPath: '/tmp/prompt.txt',
    preview: null,
  };
  const implicitReference = {
    fileName: 'source.png',
    mimeType: 'image/png',
    fileSize: 42,
    stagedPath: '/tmp/source.png',
    preview: 'data:image/png;base64,source',
  };
  const clientPreferences = {
    mode: 'image' as const,
    image: {
      model: 'image-model-v2',
      size: '2048x2048',
      quality: 'high' as const,
    },
    selectedArtifacts: [{
      filePath: implicitReference.stagedPath,
      mimeType: implicitReference.mimeType,
      title: implicitReference.fileName,
    }],
  };

  const intent = createChatSendIntent({
    text: 'Edit the previous image',
    attachments: [attachment],
    targetAgentId: 'main',
    mode: 'image',
    imageOptions: {
      model: 'image-model-v2',
      size: '2048x2048',
      quality: 'high',
    },
    thinkingLevel: 'high',
    referenceImages: [implicitReference],
    clientPreferences,
    recordedAt: 123,
  });

  attachment.stagedPath = '/tmp/mutated.txt';
  implicitReference.stagedPath = '/tmp/mutated.png';
  clientPreferences.image.model = 'mutated-model';
  clientPreferences.selectedArtifacts[0]!.filePath = '/tmp/mutated.png';

  assert.equal(intent.attachments?.[0]?.stagedPath, '/tmp/prompt.txt');
  assert.equal(intent.referenceImages[0]?.stagedPath, '/tmp/source.png');
  assert.equal(intent.imageOptions?.model, 'image-model-v2');
  assert.equal(intent.thinkingLevel, 'high');
  assert.equal(intent.clientPreferences.image?.model, 'image-model-v2');
  assert.equal(intent.clientPreferences.selectedArtifacts?.[0]?.filePath, '/tmp/source.png');
  assert.equal(intent.recordedAt, 123);
  assert.equal('runId' in intent, false);
  assert.equal('taskId' in intent, false);
  assert.equal('status' in intent, false);
});

test('retry clones cannot mutate the recorded send intent', () => {
  const intent = createChatSendIntent({
    text: 'Create a video',
    mode: 'video',
    videoOptions: {
      model: 'video-model-v3',
      size: '1920x1080',
      durationSeconds: 10,
    },
    referenceImages: [{
      fileName: 'frame.png',
      mimeType: 'image/png',
      fileSize: 80,
      stagedPath: '/tmp/frame.png',
      preview: null,
    }],
    clientPreferences: {
      mode: 'video',
      video: {
        model: 'video-model-v3',
        size: '1920x1080',
        durationSeconds: 10,
      },
      selectedArtifacts: [{
        filePath: '/tmp/frame.png',
        mimeType: 'image/png',
        title: 'frame.png',
      }],
    },
    recordedAt: 456,
  });

  const fullClone = cloneChatSendIntent(intent);
  const replayClone = cloneChatSendReplayIntent(intent);
  fullClone.referenceImages[0]!.stagedPath = '/tmp/changed-full.png';
  replayClone.clientPreferences.video!.durationSeconds = 5;
  replayClone.clientPreferences.selectedArtifacts![0]!.filePath = '/tmp/changed-replay.png';

  assert.equal(intent.referenceImages[0]?.stagedPath, '/tmp/frame.png');
  assert.equal(intent.clientPreferences.video?.durationSeconds, 10);
  assert.equal(intent.clientPreferences.selectedArtifacts?.[0]?.filePath, '/tmp/frame.png');
});
