import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const REGRESSION_API_KEY = 'sk-uclaw-regression';
export const REGRESSION_MODEL = 'uclaw-regression-model';

type OpenAiTool = {
  type?: string;
  function?: {
    name?: string;
    parameters?: {
      properties?: Record<string, unknown>;
      required?: string[];
    };
  };
};

type OpenAiMessage = {
  role?: string;
  content?: unknown;
};

type OpenAiRequest = {
  model?: string;
  messages?: OpenAiMessage[];
  stream?: boolean;
  tools?: OpenAiTool[];
};

export type RecordedProviderRequest = {
  at: string;
  method: string;
  path: string;
  scenario: string;
  attempt: number;
  model: string | null;
  stream: boolean;
  messageRoles: string[];
  toolNames: string[];
};

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((entry) => {
    if (!entry || typeof entry !== 'object') return '';
    const record = entry as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    return '';
  }).join('\n');
}

function latestUserMessage(messages: OpenAiMessage[]): { index: number; text: string } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return { index, text: contentText(messages[index]?.content) };
  }
  return { index: -1, text: '' };
}

function scenarioFromPrompt(prompt: string): string {
  const match = prompt.match(/\[REGRESSION:([A-Z0-9_]+)\]/u);
  return match?.[1] ?? 'DEFAULT';
}

function functionTool(tool: OpenAiTool): { name: string; properties: Record<string, unknown>; required: string[] } | null {
  const name = tool.function?.name?.trim();
  if (!name) return null;
  return {
    name,
    properties: tool.function?.parameters?.properties ?? {},
    required: tool.function?.parameters?.required ?? [],
  };
}

function findTool(tools: OpenAiTool[], candidates: string[]): ReturnType<typeof functionTool> {
  const normalized = tools.map(functionTool).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool));
  for (const candidate of candidates) {
    const exact = normalized.find((tool) => tool.name === candidate);
    if (exact) return exact;
  }
  for (const candidate of candidates) {
    const partial = normalized.find((tool) => tool.name.includes(candidate));
    if (partial) return partial;
  }
  return null;
}

function firstProperty(properties: Record<string, unknown>, candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate in properties) return candidate;
  }
  return null;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function errorResponse(res: ServerResponse, status: number, message: string): void {
  json(res, status, {
    error: {
      message,
      type: 'uclaw_regression_error',
      code: `regression_http_${status}`,
    },
  }, status === 429 ? { 'retry-after': '0' } : {});
}

function streamChunk(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function completionBase(id: string) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: REGRESSION_MODEL,
  };
}

function sendAssistant(res: ServerResponse, text: string, stream: boolean): void {
  const id = `chatcmpl-uclaw-${Date.now()}`;
  const usage = { prompt_tokens: 32, completion_tokens: 16, total_tokens: 48 };
  if (!stream) {
    json(res, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: REGRESSION_MODEL,
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage,
    });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  });
  streamChunk(res, {
    ...completionBase(id),
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  });
  streamChunk(res, {
    ...completionBase(id),
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  streamChunk(res, { ...completionBase(id), choices: [], usage });
  res.end('data: [DONE]\n\n');
}

function sendToolCall(
  res: ServerResponse,
  name: string,
  args: Record<string, unknown>,
  stream: boolean,
): void {
  const id = `chatcmpl-uclaw-tool-${Date.now()}`;
  const callId = `call_uclaw_${Date.now()}`;
  const argumentText = JSON.stringify(args);
  if (!stream) {
    json(res, 200, {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: REGRESSION_MODEL,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: callId, type: 'function', function: { name, arguments: argumentText } }],
        },
        finish_reason: 'tool_calls',
      }],
      usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 },
    });
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    connection: 'keep-alive',
  });
  streamChunk(res, {
    ...completionBase(id),
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: callId,
          type: 'function',
          function: { name, arguments: argumentText },
        }],
      },
      finish_reason: null,
    }],
  });
  streamChunk(res, {
    ...completionBase(id),
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  });
  res.end('data: [DONE]\n\n');
}

async function readJson(req: IncomingMessage): Promise<OpenAiRequest> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8 * 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as OpenAiRequest;
}

export class DeterministicOpenAiServer {
  readonly requests: RecordedProviderRequest[] = [];
  readonly toolTargetPath: string;
  private server: Server | null = null;
  private pendingTimers = new Set<NodeJS.Timeout>();
  private scenarioAttempts = new Map<string, number>();
  private originValue = '';

  constructor(toolTargetPath: string) {
    this.toolTargetPath = toolTargetPath;
  }

  get origin(): string {
    if (!this.originValue) throw new Error('Deterministic provider is not started.');
    return this.originValue;
  }

  get baseUrl(): string {
    return `${this.origin}/v1`;
  }

  get browserFixtureUrl(): string {
    return `${this.origin}/fixture/browser`;
  }

  async start(): Promise<void> {
    if (this.server) return;
    this.server = createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch (error) {
        if (!res.headersSent) errorResponse(res, 500, error instanceof Error ? error.message : String(error));
        else res.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.originValue = `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    if (!this.server) return;
    const server = this.server;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    this.server = null;
    this.originValue = '';
  }

  private authorized(req: IncomingMessage): boolean {
    return req.headers.authorization === `Bearer ${REGRESSION_API_KEY}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestUrl = new URL(req.url || '/', this.originValue || 'http://127.0.0.1');
    if (requestUrl.pathname === '/health') {
      json(res, 200, { ok: true });
      return;
    }
    if (requestUrl.pathname === '/fixture/browser') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end('<!doctype html><html><head><title>UClaw Browser Regression</title></head><body><main><h1>UCLAW_BROWSER_FIXTURE_OK</h1><button aria-label="Regression action">Ready</button></main></body></html>');
      return;
    }
    if (requestUrl.pathname === '/v1/models' && req.method === 'GET') {
      if (!this.authorized(req)) {
        errorResponse(res, 401, 'UCLAW_REGRESSION_INVALID_KEY');
        return;
      }
      json(res, 200, {
        object: 'list',
        data: [{ id: REGRESSION_MODEL, object: 'model', owned_by: 'uclaw-regression' }],
      });
      return;
    }
    if (requestUrl.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
      errorResponse(res, 404, `No deterministic route for ${req.method} ${requestUrl.pathname}`);
      return;
    }
    if (!this.authorized(req)) {
      errorResponse(res, 401, 'UCLAW_REGRESSION_INVALID_KEY');
      return;
    }

    const body = await readJson(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latestUser = latestUserMessage(messages);
    const scenario = scenarioFromPrompt(latestUser.text);
    const tools = Array.isArray(body.tools) ? body.tools : [];
    const toolNames = tools.map(functionTool).filter((tool): tool is NonNullable<typeof tool> => Boolean(tool)).map((tool) => tool.name);
    const attempt = (this.scenarioAttempts.get(scenario) ?? 0) + 1;
    this.scenarioAttempts.set(scenario, attempt);
    this.requests.push({
      at: new Date().toISOString(),
      method: req.method || 'POST',
      path: requestUrl.pathname,
      scenario,
      attempt,
      model: body.model || null,
      stream: body.stream === true,
      messageRoles: messages.map((message) => message.role || 'unknown'),
      toolNames,
    });

    if (scenario === 'HTTP_401') {
      errorResponse(res, 401, 'UCLAW_REGRESSION_HTTP_401');
      return;
    }
    if (scenario === 'HTTP_429') {
      if (attempt === 1) errorResponse(res, 429, 'UCLAW_REGRESSION_HTTP_429');
      else sendAssistant(res, 'UCLAW_REGRESSION_HTTP_429_RECOVERED', body.stream === true);
      return;
    }
    if (scenario === 'HTTP_500') {
      if (attempt === 1) errorResponse(res, 500, 'UCLAW_REGRESSION_HTTP_500');
      else sendAssistant(res, 'UCLAW_REGRESSION_HTTP_500_RECOVERED', body.stream === true);
      return;
    }
    if (scenario === 'MALFORMED_STREAM') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      res.end('data: {this-is-not-json}\n\n');
      return;
    }
    if (scenario === 'SLOW') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.pendingTimers.delete(timer);
          if (!res.destroyed) sendAssistant(res, 'UCLAW_REGRESSION_SLOW_FINISHED', body.stream === true);
          resolve();
        }, 60_000);
        this.pendingTimers.add(timer);
        res.once('close', () => {
          clearTimeout(timer);
          this.pendingTimers.delete(timer);
          resolve();
        });
      });
      return;
    }

    const toolResults = messages.slice(latestUser.index + 1).filter((message) => message.role === 'tool').length;
    if (scenario === 'TOOL_WRITE') {
      if (toolResults > 0) {
        sendAssistant(res, 'UCLAW_REGRESSION_TOOL_WRITE_OK', body.stream === true);
        return;
      }
      const tool = findTool(tools, ['write', 'write_file', 'writeFile']);
      if (!tool) {
        sendAssistant(res, `UCLAW_REGRESSION_TOOL_WRITE_UNAVAILABLE ${toolNames.join(',')}`, body.stream === true);
        return;
      }
      const pathKey = firstProperty(tool.properties, ['path', 'file_path', 'filePath']) ?? 'path';
      const contentKey = firstProperty(tool.properties, ['content', 'text', 'data']) ?? 'content';
      sendToolCall(res, tool.name, {
        [pathKey]: this.toolTargetPath,
        [contentKey]: 'UCLAW_REGRESSION_TOOL_FILE_OK\n',
      }, body.stream === true);
      return;
    }
    if (scenario === 'BROWSER') {
      const browser = findTool(tools, ['browser']);
      if (!browser) {
        sendAssistant(res, `UCLAW_REGRESSION_BROWSER_UNAVAILABLE ${toolNames.join(',')}`, body.stream === true);
        return;
      }
      if (toolResults === 0) {
        sendToolCall(res, browser.name, {
          action: 'open',
          profile: 'openclaw',
          targetUrl: this.browserFixtureUrl,
        }, body.stream === true);
        return;
      }
      if (toolResults === 1) {
        sendToolCall(res, browser.name, {
          action: 'snapshot',
          profile: 'openclaw',
          refs: 'aria',
        }, body.stream === true);
        return;
      }
      sendAssistant(res, 'UCLAW_REGRESSION_BROWSER_OK', body.stream === true);
      return;
    }

    const responseByScenario: Record<string, string> = {
      SIMPLE: 'UCLAW_REGRESSION_SIMPLE_OK',
      RECOVERY: 'UCLAW_REGRESSION_RECOVERY_OK',
      MULTI_TURN: `UCLAW_REGRESSION_MULTI_TURN_OK user_messages=${messages.filter((message) => message.role === 'user').length}`,
      MARKDOWN: '# UCLAW_REGRESSION_MARKDOWN_OK\n\n| Item | Status |\n| --- | --- |\n| packaged | pass |\n\n```text\nUCLAW_CODE_BLOCK_OK\n```\n\nUnicode: 中文 / 日本語 / Русский',
      DEFAULT: 'UCLAW_REGRESSION_DEFAULT_OK',
    };
    sendAssistant(res, responseByScenario[scenario] ?? `UCLAW_REGRESSION_${scenario}_OK`, body.stream === true);
  }
}
