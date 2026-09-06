import { describe, expect, it } from 'vitest';
import {
  addChatMediaImageToBudget,
  base64EncodedLength,
  CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES,
  CHAT_PROMPT_MAX_UTF8_BYTES,
  EMPTY_CHAT_MEDIA_IMAGE_BUDGET,
} from '@shared/chat/media-limits';

describe('chat media memory limits', () => {
  it('calculates base64 expansion without allocating the encoded string', () => {
    expect(base64EncodedLength(0)).toBe(0);
    expect(base64EncodedLength(1)).toBe(4);
    expect(base64EncodedLength(3)).toBe(4);
    expect(base64EncodedLength(4)).toBe(8);
  });

  it('accepts one image that exactly fills both aggregate budgets', () => {
    expect(addChatMediaImageToBudget(
      EMPTY_CHAT_MEDIA_IMAGE_BUDGET,
      CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES,
    )).toEqual({
      imageBytes: CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES,
      base64Chars: 32 * 1024 * 1024,
    });
  });

  it('rejects aggregate binary bytes before a base64 allocation is attempted', () => {
    expect(() => addChatMediaImageToBudget(
      EMPTY_CHAT_MEDIA_IMAGE_BUDGET,
      CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES + 1,
    )).toThrow('24 MiB combined memory safety limit');
  });

  it('also accounts for base64 padding across multiple images', () => {
    const first = addChatMediaImageToBudget(EMPTY_CHAT_MEDIA_IMAGE_BUDGET, 1);
    expect(() => addChatMediaImageToBudget(
      first,
      CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES - 1,
    )).toThrow('32 MiB combined base64 memory safety limit');
  });

  it('uses a two MiB UTF-8 budget for the textual prompt', () => {
    expect(CHAT_PROMPT_MAX_UTF8_BYTES).toBe(2 * 1024 * 1024);
  });
});
