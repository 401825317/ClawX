import { proxyAwareFetch } from './proxy-fetch';

export type OpenAiPlannerProtocol = 'openai-completions' | 'openai-responses';
export type OpenAiPlannerMessage = { role: 'system' | 'user'; content: string };

type OpenAiPlannerFetchParams = {
  baseUrl: string;
  fallbackBaseUrl: string;
  headers: HeadersInit;
  model: string;
  messages: OpenAiPlannerMessage[];
  protocol: OpenAiPlannerProtocol;
  signal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: string;
};

function normalizedBaseUrl(baseUrl: string, fallbackBaseUrl: string): string {
  return (baseUrl.trim() || fallbackBaseUrl.trim()).replace(/\/+$/, '');
}

export function toOpenAiPlannerEndpoint(
  baseUrl: string,
  fallbackBaseUrl: string,
  protocol: OpenAiPlannerProtocol,
): string {
  let normalized = normalizedBaseUrl(baseUrl, fallbackBaseUrl);
  if (protocol === 'openai-responses') {
    if (/\/responses?$/i.test(normalized)) return normalized.replace(/\/response$/i, '/responses');
    if (!/\/v1$/i.test(normalized)) normalized = `${normalized}/v1`;
    return `${normalized}/responses`;
  }
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  if (/\/responses?$/i.test(normalized)) return normalized.replace(/\/responses?$/i, '/chat/completions');
  if (!/\/v1$/i.test(normalized)) normalized = `${normalized}/v1`;
  return `${normalized}/chat/completions`;
}

export function buildOpenAiPlannerRequest(
  model: string,
  messages: OpenAiPlannerMessage[],
  protocol: OpenAiPlannerProtocol,
  options: Pick<OpenAiPlannerFetchParams, 'maxOutputTokens' | 'temperature' | 'reasoningEffort'> = {},
): Record<string, unknown> {
  const maxOutputTokens = options.maxOutputTokens ?? 350;
  if (protocol === 'openai-responses') {
    return {
      model,
      input: messages,
      max_output_tokens: maxOutputTokens,
      ...(options.reasoningEffort ? { reasoning: { effort: options.reasoningEffort } } : {}),
    };
  }
  return {
    model,
    messages,
    ...(options.temperature === undefined ? { temperature: 0 } : { temperature: options.temperature }),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
    max_tokens: maxOutputTokens,
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The one allowed fallback request still needs to run if cancellation races close.
  }
}

/** Sends a planner request and retries an unsupported Responses endpoint once via Chat Completions. */
export async function fetchOpenAiPlannerResponse(params: OpenAiPlannerFetchParams): Promise<Response> {
  const send = (protocol: OpenAiPlannerProtocol) => proxyAwareFetch(
    toOpenAiPlannerEndpoint(params.baseUrl, params.fallbackBaseUrl, protocol),
    {
      method: 'POST',
      headers: params.headers,
      body: JSON.stringify(buildOpenAiPlannerRequest(params.model, params.messages, protocol, params)),
      signal: params.signal,
    },
  );
  const response = await send(params.protocol);
  if (params.protocol !== 'openai-responses' || response.status !== 404) return response;
  await cancelResponseBody(response);
  return send('openai-completions');
}

/** Extracts assistant text from either Chat Completions or Responses JSON. */
export function extractOpenAiPlannerText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const choices = Array.isArray(record.choices) ? record.choices : [];
  const message = choices[0] && typeof choices[0] === 'object' && !Array.isArray(choices[0])
    ? (choices[0] as { message?: { content?: unknown } }).message
    : undefined;
  if (typeof message?.content === 'string' && message.content.trim()) return message.content;
  if (typeof record.output_text === 'string' && record.output_text.trim()) return record.output_text;

  const texts: string[] = [];
  for (const item of Array.isArray(record.output) ? record.output : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const output = item as { text?: unknown; content?: unknown };
    if (typeof output.text === 'string' && output.text.trim()) texts.push(output.text);
    for (const block of Array.isArray(output.content) ? output.content : []) {
      if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join('') : null;
}
