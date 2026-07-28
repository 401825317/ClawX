import { describe, expect, it } from 'vitest';
import { restoreBackgroundMediaProjections } from '@/lib/acp/background-media-projections';
import { createEmptyAcpTimeline } from '@/lib/acp/reducer';
import type {
  AcpTimelineSnapshot,
  AttachmentRenderPart,
  MessageSegmentItem,
  RenderPart,
  TimelineItem,
  ToolCallItem,
} from '@/lib/acp/timeline-types';

/** Builds a complete snapshot while keeping message segment counters consistent. */
function timeline(items: TimelineItem[], generation = 1): AcpTimelineSnapshot {
  const snapshot = createEmptyAcpTimeline('agent:main:previous', generation);
  for (const item of items) {
    snapshot.itemOrder.push(item.id);
    snapshot.itemsById[item.id] = item;
    if (item.kind === 'message-segment') {
      snapshot.segmentCounts[item.messageId] = Math.max(
        snapshot.segmentCounts[item.messageId] ?? 0,
        item.segmentIndex + 1,
      );
    }
  }
  return snapshot;
}

/** Creates one text message segment with independently controlled item and message ids. */
function message(
  id: string,
  role: MessageSegmentItem['role'],
  text: string,
  options: Partial<Pick<MessageSegmentItem, 'messageId' | 'parts' | 'compat'>> = {},
): MessageSegmentItem {
  return {
    kind: 'message-segment',
    id,
    role,
    messageId: options.messageId ?? `${id}-message`,
    segmentIndex: 0,
    parts: options.parts ?? [{ kind: 'markdown', text }],
    ...(options.compat ? { compat: options.compat } : {}),
  };
}

/** Creates a completed tool item so replay matching cannot accidentally depend on tool ids. */
function tool(id: string): ToolCallItem {
  return {
    kind: 'tool-call',
    id,
    toolCallId: `${id}-call`,
    title: 'Generate media',
    status: 'completed',
    outputParts: [],
    locations: [],
  };
}

/** Creates a Renderer-owned synthetic image projection for a completed generation. */
function imageProjection(input: {
  id: string;
  evidenceId: string;
  identity: string;
  caption?: string;
  attachmentFileRef?: Extract<RenderPart, { kind: 'image' }>['attachmentFileRef'];
}): MessageSegmentItem {
  return message(input.id, 'assistant', input.caption ?? 'Generated image.', {
    messageId: `compat:image-generation:${input.evidenceId}`,
    compat: { source: 'image-generation', evidenceId: input.evidenceId },
    parts: [
      { kind: 'markdown', text: input.caption ?? 'Generated image.' },
      {
        kind: 'image',
        source: `data:image/png;base64,${input.identity}`,
        mimeType: 'image/png',
        mediaIdentity: input.identity,
        ...(input.attachmentFileRef ? { attachmentFileRef: input.attachmentFileRef } : {}),
      },
    ],
  });
}

/** Creates an available OpenClaw MEDIA attachment with a local or remote access target. */
function mediaAttachment(input: {
  id: string;
  identity: string;
  target: AttachmentRenderPart['access'] & { status: 'available' } extends infer Access
    ? Access extends { target: infer Target } ? Target : never
    : never;
}): AttachmentRenderPart {
  return {
    kind: 'attachment',
    attachmentId: input.id,
    reference: { uri: input.target.ref.uri, name: `${input.id}.mp4`, mimeType: 'video/mp4' },
    source: 'openclaw-media',
    evidenceId: `attachment:${input.id}`,
    access: {
      status: 'available',
      identity: input.identity,
      target: input.target,
      mimeType: 'video/mp4',
      size: 128,
    },
  };
}

/** Creates a Renderer-owned OpenClaw MEDIA projection. */
function mediaProjection(
  id: string,
  evidenceId: string,
  attachments: AttachmentRenderPart[],
): MessageSegmentItem {
  return message(id, 'assistant', '', {
    messageId: `compat:openclaw-media:${evidenceId}`,
    compat: { source: 'openclaw-media', evidenceId },
    parts: attachments,
  });
}

/** Returns all media identities in one timeline item. */
function itemMediaIdentities(item: TimelineItem | undefined): string[] {
  if (item?.kind !== 'message-segment') return [];
  return item.parts.flatMap((part) => {
    if (part.kind === 'image' && part.mediaIdentity) return [part.mediaIdentity];
    if (part.kind === 'attachment' && part.access.status === 'available') return [part.access.identity];
    return [];
  });
}

describe('background ACP media projections', () => {
  it('matches repeated user turns by text and tail occurrence when every ACP id changes', () => {
    const previous = timeline([
      message('old-user-older', 'user', 'Repeat this request'),
      tool('old-tool-older'),
      message('old-assistant-older', 'assistant', 'Older reply'),
      imageProjection({ id: 'older-image', evidenceId: 'older', identity: 'older-identity' }),
      message('old-user-newer', 'user', 'Repeat this request'),
      tool('old-tool-newer'),
      message('old-assistant-newer', 'assistant', 'Newer reply'),
      imageProjection({ id: 'newer-image', evidenceId: 'newer', identity: 'newer-identity' }),
    ]);
    const replay = timeline([
      message('new-user-older', 'user', 'Repeat this request'),
      tool('new-tool-older'),
      message('new-assistant-older', 'assistant', 'Older authoritative reply'),
      message('new-user-newer', 'user', 'Repeat this request'),
      tool('new-tool-newer'),
      message('new-assistant-newer', 'assistant', 'Newer authoritative reply'),
    ], 8);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 8,
    });

    expect(result.timeline.itemOrder).toEqual([
      'new-user-older',
      'new-tool-older',
      'new-assistant-older',
      'older-image',
      'new-user-newer',
      'new-tool-newer',
      'new-assistant-newer',
      'newer-image',
    ]);
    expect(itemMediaIdentities(result.timeline.itemsById['older-image'])).toEqual(['older-identity']);
    expect(itemMediaIdentities(result.timeline.itemsById['newer-image'])).toEqual(['newer-identity']);
    expect(result.timeline.itemsById['old-user-older']).toBeUndefined();
    expect(result.timeline.itemsById['old-tool-newer']).toBeUndefined();
    expect(result.timeline.itemsById['old-assistant-newer']).toBeUndefined();
  });

  it('keeps the same media identity when it belongs to different turns', () => {
    const firstAttachment = mediaAttachment({
      id: 'first-attachment',
      identity: 'shared-media',
      target: {
        kind: 'local',
        scope: 'openclaw-media',
        ref: { sessionKey: 'old-session', generation: 1, uri: 'file:///media/shared.mp4' },
      },
    });
    const secondAttachment = mediaAttachment({
      id: 'second-attachment',
      identity: 'shared-media',
      target: {
        kind: 'local',
        scope: 'openclaw-media',
        ref: { sessionKey: 'old-session', generation: 1, uri: 'file:///media/shared.mp4' },
      },
    });
    const previous = timeline([
      message('old-user-first', 'user', 'Use this media first'),
      mediaProjection('first-media', 'first-evidence', [firstAttachment]),
      message('old-user-second', 'user', 'Use this media again'),
      mediaProjection('second-media', 'second-evidence', [secondAttachment]),
    ]);
    const replay = timeline([
      message('new-user-first', 'user', 'Use this media first'),
      message('new-user-second', 'user', 'Use this media again'),
    ], 4);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 4,
    });

    expect(itemMediaIdentities(result.timeline.itemsById['first-media'])).toEqual(['shared-media']);
    expect(itemMediaIdentities(result.timeline.itemsById['second-media'])).toEqual(['shared-media']);
    expect(result.timeline.itemOrder).toEqual([
      'new-user-first',
      'first-media',
      'new-user-second',
      'second-media',
    ]);
  });

  it('does not restore stale native reply text when replay has no matching caption', () => {
    const nativeReply = message('old-native-reply', 'assistant', 'Stale generated caption', {
      messageId: 'old-native-reply-message',
      compat: { source: 'image-generation', evidenceId: 'native-evidence' },
      parts: [
        { kind: 'markdown', text: 'Stale generated caption' },
        {
          kind: 'image',
          source: 'data:image/png;base64,stale',
          mediaIdentity: 'stale-native-image',
        },
      ],
    });
    const previous = timeline([
      message('old-user', 'user', 'Generate a city image'),
      nativeReply,
    ]);
    const replay = timeline([
      message('new-user', 'user', 'Generate a city image'),
      message('new-native-reply', 'assistant', 'Authoritative replay reply'),
    ], 5);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 5,
    });

    expect(result.unrestoredImageEvidenceIds).toEqual(['native-evidence']);
    expect(result.timeline).toEqual(replay);
    expect(JSON.stringify(result.timeline)).not.toContain('Stale generated caption');
    expect(JSON.stringify(result.timeline)).not.toContain('stale-native-image');
  });

  it('rebinds image, local MEDIA, and remote MEDIA refs to the active load', () => {
    const image = imageProjection({
      id: 'generated-image',
      evidenceId: 'image-evidence',
      identity: 'image-identity',
      attachmentFileRef: {
        sessionKey: 'agent:main:old',
        generation: 2,
        uri: 'file:///media/generated.png',
        transcriptMessageId: 'transcript-image',
      },
    });
    const localAttachment = mediaAttachment({
      id: 'local-video',
      identity: 'local-video-identity',
      target: {
        kind: 'local',
        scope: 'openclaw-media',
        ref: {
          sessionKey: 'agent:main:old',
          generation: 2,
          uri: 'file:///media/generated.mp4',
          transcriptMessageId: 'transcript-local',
        },
      },
    });
    const remoteAttachment = mediaAttachment({
      id: 'remote-video',
      identity: 'remote-video-identity',
      target: {
        kind: 'remote',
        url: 'https://media.example.test/generated.mp4',
        ref: {
          sessionKey: 'agent:main:old',
          generation: 2,
          uri: 'https://media.example.test/generated.mp4',
          transcriptMessageId: 'transcript-remote',
        },
      },
    });
    const previous = timeline([
      message('old-user', 'user', 'Generate media'),
      image,
      mediaProjection('generated-media', 'media-evidence', [localAttachment, remoteAttachment]),
    ]);
    const replay = timeline([message('new-user', 'user', 'Generate media')], 11);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 11,
    });
    const restoredImage = result.timeline.itemsById['generated-image'];
    const restoredMedia = result.timeline.itemsById['generated-media'];

    expect(restoredImage).toMatchObject({
      parts: [{ kind: 'markdown' }, {
        kind: 'image',
        attachmentFileRef: {
          sessionKey: 'agent:main:current',
          generation: 11,
          uri: 'file:///media/generated.png',
          transcriptMessageId: 'transcript-image',
        },
      }],
    });
    expect(restoredMedia).toMatchObject({
      parts: [
        {
          access: {
            target: {
              kind: 'local',
              scope: 'openclaw-media',
              ref: {
                sessionKey: 'agent:main:current',
                generation: 11,
                uri: 'file:///media/generated.mp4',
                transcriptMessageId: 'transcript-local',
              },
            },
          },
        },
        {
          access: {
            target: {
              kind: 'remote',
              url: 'https://media.example.test/generated.mp4',
              ref: {
                sessionKey: 'agent:main:current',
                generation: 11,
                uri: 'https://media.example.test/generated.mp4',
                transcriptMessageId: 'transcript-remote',
              },
            },
          },
        },
      ],
    });
  });

  it('does not duplicate a media identity already present in the matching replay turn', () => {
    const previous = timeline([
      message('old-user', 'user', 'Generate one image'),
      imageProjection({
        id: 'old-image-projection',
        evidenceId: 'old-image-evidence',
        identity: 'canonical-image',
        caption: 'Stale compatibility caption',
      }),
    ]);
    const replay = timeline([
      message('new-user', 'user', 'Generate one image'),
      message('new-assistant', 'assistant', 'Authoritative reply', {
        parts: [
          { kind: 'markdown', text: 'Authoritative reply' },
          {
            kind: 'image',
            source: 'data:image/png;base64,canonical',
            mediaIdentity: 'canonical-image',
          },
        ],
      }),
    ], 9);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 9,
    });
    const identities = result.timeline.itemOrder.flatMap((itemId) => (
      itemMediaIdentities(result.timeline.itemsById[itemId])
    ));

    expect(identities.filter((identity) => identity === 'canonical-image')).toHaveLength(1);
    expect(result.timeline.itemsById['old-image-projection']).toBeUndefined();
    expect(JSON.stringify(result.timeline)).not.toContain('Stale compatibility caption');
    expect(result.unrestoredImageEvidenceIds).toEqual([]);
  });

  it('does not treat user input media as existing assistant output', () => {
    const previous = timeline([
      message('old-user', 'user', 'Transform this image'),
      imageProjection({
        id: 'assistant-output',
        evidenceId: 'assistant-output-evidence',
        identity: 'shared-input-output',
      }),
    ]);
    const replay = timeline([
      message('new-user', 'user', 'Transform this image', {
        parts: [
          { kind: 'markdown', text: 'Transform this image' },
          {
            kind: 'image',
            source: 'data:image/png;base64,input',
            mediaIdentity: 'shared-input-output',
          },
        ],
      }),
    ], 6);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 6,
    });
    const identities = result.timeline.itemOrder.flatMap((itemId) => (
      itemMediaIdentities(result.timeline.itemsById[itemId])
    ));

    expect(identities.filter((identity) => identity === 'shared-input-output')).toHaveLength(2);
    expect(result.timeline.itemsById['assistant-output']).toBeDefined();
  });

  it('accepts native replay media without restoring stale native caption text', () => {
    const previousNative = message('old-native', 'assistant', 'Stale native caption', {
      messageId: 'old-native-message',
      compat: { source: 'image-generation', evidenceId: 'native-replay-evidence' },
      parts: [
        { kind: 'markdown', text: 'Stale native caption' },
        {
          kind: 'image',
          source: 'data:image/png;base64,native',
          mediaIdentity: 'native-replay-image',
        },
      ],
    });
    const previous = timeline([
      message('old-user', 'user', 'Generate native media'),
      previousNative,
    ]);
    const replay = timeline([
      message('new-user', 'user', 'Generate native media'),
      message('new-native', 'assistant', 'Authoritative native caption', {
        parts: [
          { kind: 'markdown', text: 'Authoritative native caption' },
          {
            kind: 'image',
            source: 'data:image/png;base64,native',
            mediaIdentity: 'native-replay-image',
          },
        ],
      }),
    ], 7);

    const result = restoreBackgroundMediaProjections({
      replay,
      previous,
      sessionKey: 'agent:main:current',
      generation: 7,
    });

    expect(result.timeline).toEqual(replay);
    expect(result.unrestoredImageEvidenceIds).toEqual([]);
    expect(JSON.stringify(result.timeline)).not.toContain('Stale native caption');
  });
});
