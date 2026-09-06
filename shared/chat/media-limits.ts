/**
 * A single send must remain comfortably below the memory available to both
 * the Electron Main process and the ACP child.  Binary images are retained as
 * base64 until the request has been handed off, so the encoded budget is kept
 * alongside the source-byte budget instead of relying on file size alone.
 */
export const CHAT_MEDIA_MAX_ITEMS = 8;
export const CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
export const CHAT_MEDIA_MAX_TOTAL_BASE64_CHARS = 32 * 1024 * 1024;
export const CHAT_PROMPT_MAX_UTF8_BYTES = 2 * 1024 * 1024;

/**
 * Historical/assistant ACP blocks can arrive with inline image bytes.  Large
 * data URIs are not useful as React state and create another full-size string
 * when the URI prefix is added, so use a much smaller renderer-side ceiling.
 */
export const ACP_INLINE_IMAGE_MAX_DATA_URI_CHARS = 512 * 1024;

export function base64EncodedLength(byteLength: number): number {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return 4 * Math.ceil(byteLength / 3);
}

export type ChatMediaImageBudget = {
  imageBytes: number;
  base64Chars: number;
};

export const EMPTY_CHAT_MEDIA_IMAGE_BUDGET: ChatMediaImageBudget = {
  imageBytes: 0,
  base64Chars: 0,
};

export function addChatMediaImageToBudget(
  current: ChatMediaImageBudget,
  byteLength: number,
): ChatMediaImageBudget {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw chatMediaImageByteLimitError();
  const imageBytes = current.imageBytes + byteLength;
  if (imageBytes > CHAT_MEDIA_MAX_TOTAL_IMAGE_BYTES) throw chatMediaImageByteLimitError();
  const base64Chars = current.base64Chars + base64EncodedLength(byteLength);
  if (base64Chars > CHAT_MEDIA_MAX_TOTAL_BASE64_CHARS) throw chatMediaBase64LimitError();
  return { imageBytes, base64Chars };
}

export function chatMediaCountLimitError(): Error {
  return new Error(`A message can include at most ${CHAT_MEDIA_MAX_ITEMS} media attachments.`);
}

export function chatMediaImageByteLimitError(): Error {
  return new Error('Attached images exceed the 24 MiB combined memory safety limit.');
}

export function chatMediaBase64LimitError(): Error {
  return new Error('Attached image data exceeds the 32 MiB combined base64 memory safety limit.');
}

export function chatPromptByteLimitError(): Error {
  return new Error('Message exceeds the 2 MiB UTF-8 memory safety limit.');
}
