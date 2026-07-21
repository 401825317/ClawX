import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChatRuntimeArtifact } from '../shared/chat-runtime-events';
import type { ConversationMessageSnapshot } from '../shared/conversation-events';
import { projectArtifactOwnedFinalMessage } from '../src/pages/Chat/timeline/media-ownership';

const OUTPUT_DATA = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
const OUTPUT_PREVIEW = `data:image/png;base64,${OUTPUT_DATA}`;
const REFERENCE_PREVIEW = 'data:image/png;base64,cmVmZXJlbmNl';

function artifactOwner(artifacts: ChatRuntimeArtifact[]) {
  return [{ artifacts, changes: [] }];
}

test('artifact ownership removes output attachments by any matching path or URL identity', () => {
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: 'Output ready.',
    attachments: [{
      fileName: 'output.png',
      mimeType: 'image/png',
      fileSize: 128,
      preview: null,
      filePath: '/local/cache/output.png',
      gatewayUrl: '/api/chat/media/outgoing/output/full',
      disposition: 'output-delivery',
    }, {
      fileName: 'windows-output.png',
      mimeType: 'image/png',
      fileSize: 128,
      preview: null,
      filePath: String.raw`C:\OpenClaw\output.png`,
      disposition: 'output-delivery',
    }],
  };

  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'url-output',
    url: '/api/chat/media/outgoing/output/full',
  }, {
    id: 'path-output',
    filePath: 'c:/OpenClaw/output.png',
  }]));

  assert.deepEqual(projected.attachments, []);
  assert.equal(projected.content, 'Output ready.');
});

test('artifact ownership removes matching content URL and preview-only base64 media', () => {
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Images ready.' }, {
      type: 'image',
      source: {
        type: 'url',
        media_type: 'image/png',
        url: 'https://cdn.example.test/output.png',
      },
    }, {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: OUTPUT_DATA,
      },
    }, {
      type: 'image',
      source: {
        type: 'url',
        media_type: 'image/png',
        url: 'https://cdn.example.test/unowned.png',
      },
    }],
    attachments: [{
      fileName: 'output.png',
      mimeType: 'image/png',
      fileSize: 128,
      preview: OUTPUT_PREVIEW,
      disposition: 'output-delivery',
    }, {
      fileName: 'reference.png',
      mimeType: 'image/png',
      fileSize: 64,
      preview: REFERENCE_PREVIEW,
      disposition: 'input-reference',
    }],
  };

  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'url-output',
    url: 'https://cdn.example.test/output.png',
  }, {
    id: 'preview-output',
    preview: OUTPUT_PREVIEW,
  }]));

  assert.deepEqual(projected.content, [{ type: 'text', text: 'Images ready.' }, {
    type: 'image',
    source: {
      type: 'url',
      media_type: 'image/png',
      url: 'https://cdn.example.test/unowned.png',
    },
  }]);
  assert.deepEqual(projected.attachments, [message.attachments![1]]);
});

test('projection preserves the original snapshot when no artifact identity matches', () => {
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: [{
      type: 'image',
      source: { type: 'url', media_type: 'image/png', url: 'https://cdn.example.test/final-only.png' },
    }],
  };
  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'different-output',
    filePath: '/tmp/different-output.png',
  }]));
  assert.equal(projected, message);
});

test('preview fallback does not override conflicting strong media identities', () => {
  const preview = `data:image/png;base64,${OUTPUT_DATA}`;
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: 'Two references share a thumbnail.',
    attachments: [{
      fileName: 'final.png',
      mimeType: 'image/png',
      fileSize: 128,
      preview,
      filePath: '/tmp/final.png',
      disposition: 'output-delivery',
    }],
  };
  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'different-file',
    filePath: '/tmp/another.png',
    preview,
  }]));
  assert.deepEqual(projected.attachments, message.attachments);
});

test('preview fallback removes pathless output content while retaining input attachments', () => {
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Output ready.' }, {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: OUTPUT_DATA },
    }],
    attachments: [{
      fileName: 'reference.png',
      mimeType: 'image/png',
      fileSize: 64,
      preview: REFERENCE_PREVIEW,
      source: 'user-upload',
      disposition: 'input-reference',
    }],
  };
  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'output',
    filePath: '/tmp/output.png',
    preview: OUTPUT_PREVIEW,
  }]));

  assert.deepEqual(projected.content, [{ type: 'text', text: 'Output ready.' }]);
  assert.deepEqual(projected.attachments, message.attachments);
});

test('legacy user-upload attachments remain input references without disposition metadata', () => {
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: 'Reference retained.',
    attachments: [{
      fileName: 'reference.png',
      mimeType: 'image/png',
      fileSize: 64,
      preview: REFERENCE_PREVIEW,
      filePath: '/tmp/reference.png',
      source: 'user-upload',
    }],
  };
  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'same-path-output',
    filePath: '/tmp/reference.png',
  }]));
  assert.deepEqual(projected.attachments, message.attachments);
});

test('artifact ownership removes matching MEDIA directive from hydrated history final', () => {
  const outputPath = '/Users/test/.openclaw/media/output image.png';
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: [
      'Image ready.',
      `MEDIA:${outputPath}`,
      `The output remains available at ${outputPath}.`,
      'MEDIA:/Users/test/.openclaw/media/unmatched.png',
    ].join('\n'),
    attachments: [{
      fileName: 'output image.png',
      mimeType: 'image/png',
      fileSize: 128,
      preview: OUTPUT_PREVIEW,
      filePath: outputPath,
      source: 'gateway-media',
      disposition: 'output-delivery',
    }, {
      fileName: 'reference.png',
      mimeType: 'image/png',
      fileSize: 64,
      preview: REFERENCE_PREVIEW,
      filePath: '/Users/test/reference.png',
      source: 'user-upload',
      disposition: 'input-reference',
    }],
  };

  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'output',
    filePath: outputPath,
  }]));

  assert.equal(projected.content, [
    'Image ready.',
    `The output remains available at ${outputPath}.`,
    'MEDIA:/Users/test/.openclaw/media/unmatched.png',
  ].join('\n'));
  assert.deepEqual(projected.attachments, [message.attachments![1]]);
});

test('artifact ownership removes matching MEDIA directive from text content block only', () => {
  const outputPath = String.raw`C:\OpenClaw\media\output.png`;
  const unmatchedPath = String.raw`C:\OpenClaw\media\other.png`;
  const ordinaryPathBlock = {
    type: 'text',
    text: `Ordinary path: ${outputPath}`,
  };
  const message: ConversationMessageSnapshot = {
    role: 'assistant',
    content: [{
      type: 'text',
      text: `Done.\nMEDIA:c:/OpenClaw/media/output.png\nMEDIA:${unmatchedPath}`,
    }, ordinaryPathBlock],
  };

  const projected = projectArtifactOwnedFinalMessage(message, artifactOwner([{
    id: 'output',
    filePath: outputPath,
  }]));

  assert.deepEqual(projected.content, [{
    type: 'text',
    text: `Done.\nMEDIA:${unmatchedPath}`,
  }, ordinaryPathBlock]);
});
