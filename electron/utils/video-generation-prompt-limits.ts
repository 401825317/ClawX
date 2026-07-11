export const MAX_VIDEO_GENERATION_PROMPT_CHARS = 4096;

export function countVideoPromptCharacters(prompt: string): number {
  return Array.from(prompt).length;
}

export function getVideoPromptLengthError(prompt: string): string | null {
  const promptChars = countVideoPromptCharacters(prompt);
  if (promptChars <= MAX_VIDEO_GENERATION_PROMPT_CHARS) {
    return null;
  }

  return `Video prompt is too long (${promptChars}/${MAX_VIDEO_GENERATION_PROMPT_CHARS} characters). Shorten it before generating video.`;
}
