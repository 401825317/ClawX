import assert from 'node:assert/strict';
import { enrichWithCachedImages } from '../src/stores/chat/helpers';
import {
  buildRuntimeArtifactEventsFromAttachedFiles,
  hasDeliveredArtifactEvidence,
} from '../src/stores/chat/runtime-evidence';
import type { AttachedFileMeta, RawMessage } from '../src/stores/chat/types';

const referencePath = '/Users/test/.openclaw/media/outbound/reference.png';
const userText = `做一个视频\n[media attached: ${referencePath} (image/png) | ${referencePath}]`;

const replayed = enrichWithCachedImages([
  { role: 'user', content: userText },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '我会按参考图制作视频。' },
      { type: 'toolCall', id: 'call-video', name: 'tool_call', arguments: { id: 'video_generate' } },
    ],
  },
] as RawMessage[]);

assert.equal(replayed[0]?._attachedFiles?.length, 1);
assert.equal(replayed[0]?._attachedFiles?.[0]?.source, 'user-upload');
assert.equal(replayed[0]?._attachedFiles?.[0]?.disposition, 'input-reference');
assert.equal(replayed[1]?._attachedFiles?.length ?? 0, 0);

const inputReference = replayed[0]!._attachedFiles![0]!;
assert.deepEqual(buildRuntimeArtifactEventsFromAttachedFiles({
  runId: 'reference-run',
  sessionKey: 'agent:main:reference-run',
  ts: 1,
}, [inputReference]), []);
assert.equal(hasDeliveredArtifactEvidence(undefined, [inputReference]), false);

const deliveredOutput: AttachedFileMeta = {
  ...inputReference,
  source: 'gateway-media',
  disposition: 'output-delivery',
  gatewayUrl: '/api/chat/media/outgoing/reference-run/output/full',
};
const outputEvents = buildRuntimeArtifactEventsFromAttachedFiles({
  runId: 'output-run',
  sessionKey: 'agent:main:output-run',
  ts: 2,
}, [deliveredOutput]);
assert.deepEqual(outputEvents.map((event) => event.type), [
  'artifact.produced',
  'verification.completed',
]);
assert.equal(
  outputEvents.find((event) => event.type === 'artifact.produced')?.artifact.source,
  'gateway-media',
);
assert.equal(hasDeliveredArtifactEvidence(undefined, [deliveredOutput]), true);

const explicitSamePathDelivery = enrichWithCachedImages([
  { role: 'user', content: userText },
  { role: 'assistant', content: `已交付。\nMEDIA:${referencePath}` },
] as RawMessage[]);
assert.equal(explicitSamePathDelivery[1]?._attachedFiles?.length, 1);
assert.equal(explicitSamePathDelivery[1]?._attachedFiles?.[0]?.disposition, 'output-delivery');

const plainSamePathMention = enrichWithCachedImages([
  { role: 'user', content: userText },
  { role: 'assistant', content: `我读取了参考文件 ${referencePath}，尚未生成结果。` },
] as RawMessage[]);
assert.equal(plainSamePathMention[1]?._attachedFiles?.length ?? 0, 0);
assert.equal(hasDeliveredArtifactEvidence(undefined, plainSamePathMention[1]?._attachedFiles ?? []), false);

const legacyUserAttachment = enrichWithCachedImages([{
  role: 'user',
  content: '旧历史附件',
  _attachedFiles: [{
    fileName: 'reference.png',
    mimeType: 'image/png',
    fileSize: 10,
    preview: null,
    filePath: referencePath,
  }],
}] as RawMessage[]);
assert.equal(legacyUserAttachment[0]?._attachedFiles?.[0]?.source, 'user-upload');
assert.equal(legacyUserAttachment[0]?._attachedFiles?.[0]?.disposition, 'input-reference');

console.log('chat reference image provenance replay: 16 assertions passed');
