export function stripJsonBom(text: string): string {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export function parseJsonWithBom<T = unknown>(text: string): T {
  return JSON.parse(stripJsonBom(text)) as T;
}
