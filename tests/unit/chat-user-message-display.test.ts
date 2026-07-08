import { describe, expect, it } from 'vitest';
import { extractText } from '@/pages/Chat/message-utils';
import { matchesOptimisticUserMessage } from '@/stores/chat/helpers';

const gatewayImageEcho = [
  'Sender (untrusted metadata):',
  '```json',
  '{',
  '  "label": "ClawX (gateway-client)",',
  '  "id": "gateway-client",',
  '  "name": "ClawX",',
  '  "username": "ClawX"',
  '}',
  '```',
  '',
  '[media attached: media://inbound/image---abc.png (image/png)]',
  '[Image]',
  'User text:',
  'Process the attached file(s).',
  '[media attached: /Users/test/.openclaw/media/outbound/out.png (image/png) | /Users/test/.openclaw/media/outbound/out.png]',
  'Description:',
  'An astronaut in a white space suit floats in space, reaching a gloved hand toward the viewer.',
].join('\n');

describe('user message display cleanup', () => {
  it('hides the inbound-image vision envelope for attachment-only uploads', () => {
    expect(extractText({ role: 'user', content: gatewayImageEcho })).toBe('');
  });

  it('keeps the user caption while stripping auto-generated description', () => {
    const content = gatewayImageEcho
      .replace('Process the attached file(s).', '改成西装加领带');

    expect(extractText({ role: 'user', content })).toBe('改成西装加领带');
  });

  it('matches optimistic attachment-only bubbles against the gateway vision echo', () => {
    const optimistic = {
      role: 'user' as const,
      content: '(file attached)',
      timestamp: 1_700_000_000,
      _attachedFiles: [{
        fileName: 'out.png',
        mimeType: 'image/png',
        fileSize: 123,
        preview: null,
        filePath: '/Users/test/.openclaw/media/outbound/out.png',
      }],
    };
    const candidate = {
      role: 'user' as const,
      content: gatewayImageEcho,
      timestamp: 1_700_000_000,
    };

    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('hides the composite execution contract from user bubbles and optimistic dedupe', () => {
    const original = '生图，PPT，Excel，生视频，根据图片修图，做小程序，生成文案，每个事儿都随便给我来一个';
    const gatewayEcho = [
      original,
      '',
      '【UClaw composite execution contract】',
      '这是一个组合任务，请按下面合同执行：',
      '- 不要询问用户先做哪个。',
    ].join('\n');
    const optimistic = {
      role: 'user' as const,
      content: original,
      timestamp: 1_700_000_000,
    };
    const candidate = {
      role: 'user' as const,
      content: gatewayEcho,
      timestamp: 1_700_000_000,
    };

    expect(extractText(candidate)).toBe(original);
    expect(matchesOptimisticUserMessage(candidate, optimistic, 1_700_000_000_000)).toBe(true);
  });

  it('keeps queued user text while stripping OpenClaw restart continuation prompts', () => {
    const content = [
      '[Queued user message that arrived while the previous turn was still active]',
      '随便生成个ppt',
      '',
      '[System] Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool/model work. Continue from the existing transcript and finish the interrupted response.',
    ].join('\n');

    expect(extractText({ role: 'user', content })).toBe('随便生成个ppt');
  });
});
