export type ToolErrorKind = 'missing-file' | 'unsupported-file-url' | 'cron-agent-target' | 'web-search-unavailable';

const TOOL_ERROR_HINTS: Array<{
  kind: ToolErrorKind;
  test: (text: string) => boolean;
  zh: string;
  en: string;
}> = [
  {
    kind: 'missing-file',
    test: (text) => /\bENOENT\b/i.test(text) || /no such file or directory/i.test(text),
    zh: '文件不存在或路径不正确，已建议先查看目录内容再继续。',
    en: 'The file does not exist or the path is incorrect. Check the directory contents before continuing.',
  },
  {
    kind: 'unsupported-file-url',
    test: (text) => /unsupported protocol\s+["']?file:?["']?/i.test(text)
      || /Navigation blocked: unsupported protocol\s+["']?file:?["']?/i.test(text),
    zh: '浏览器工具不能直接打开 file:// 本地文件，请使用工作区预览或本地 HTTP 地址。',
    en: 'The browser tool cannot open file:// local files directly. Use the workspace preview or a local HTTP URL.',
  },
  {
    kind: 'cron-agent-target',
    test: (text) => /sessionTarget\s+["']main["']/i.test(text)
      && /default agent|non-default agents?/i.test(text),
    zh: '非默认智能体的定时任务参数不兼容，应使用 isolated 会话和 agentTurn 负载。',
    en: 'The scheduled task used incompatible params for a non-default agent. Use an isolated session and an agentTurn payload.',
  },
  {
    kind: 'web-search-unavailable',
    test: (text) => /web_search is disabled or no provider is available/i.test(text),
    zh: 'web_search 当前不可用或没有配置可用 provider。',
    en: 'web_search is disabled or no provider is available.',
  },
];

export function normalizeToolErrorMessage(value: unknown, locale?: string): string | null {
  const text = typeof value === 'string' ? value : stringifyToolError(value);
  if (!text) return null;
  const match = TOOL_ERROR_HINTS.find((hint) => hint.test(text));
  if (!match) return null;
  return locale?.toLowerCase().startsWith('zh') ? match.zh : match.en;
}

export function appendToolErrorHint(detail: string | undefined, locale?: string): string | undefined {
  const hint = normalizeToolErrorMessage(detail, locale);
  if (!hint || !detail) return detail;
  if (detail.includes(hint)) return detail;
  return `${hint}\n\n${detail}`;
}

function stringifyToolError(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
