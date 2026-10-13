// @vitest-environment node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { normalizeAcpChatError } from '@shared/acp-chat/errors';
import { DeterministicOpenAiServer } from '../packaged-e2e/fixtures/deterministic-openai-server';
import {
  patchOpenClawProviderTerminalErrorRuntime,
  PROVIDER_RUNTIME_FILES,
  TERMINAL_HELPER_FILE,
  TERMINAL_HELPER_SOURCE,
  rewriteProviderTerminalErrors,
} from '../../scripts/openclaw-provider-terminal-error-patch.mjs';
import { patchOpenClawAcpTerminalErrorRuntime } from '../../scripts/openclaw-acp-terminal-error-patch.mjs';

type Model = Record<string | symbol, unknown>;
type Assistant = { role: string; stopReason: string; errorMessage?: string; errorCode?: string; errorType?: string; tlsCauseCode?: string };
type Stream = { result(): Promise<Assistant> };

// These are the real complete generated modules, imported only from a disposable
// copy. No edits to installed node_modules or outbound paid model requests.
let root: string;
let runtime: string;
let tlsServer: HttpsServer;
let tlsOrigin: string;
let tlsConnections = 0;
let helper: {
  createUclawTerminalFetch(fn: typeof fetch): typeof fetch;
  getUclawTerminalFailure(value: unknown): { code: string; errorMessage: string; tlsCauseCode?: string } | undefined;
  assignUclawTerminalFailure(output: Record<string, unknown>, value: unknown): void;
  throwUclawTerminalFailure(value: unknown): void;
};
let classifier: {
  i(signal: unknown): unknown;
  n(message: Assistant): unknown;
  d(message: Assistant): boolean;
  f(message: Assistant): boolean;
  S(message: Assistant): boolean;
};
let transport: { r(): (model: Model, context: unknown, options: unknown) => Stream };
let completions: { n(model: Model, context: unknown, options: unknown): Stream };
let fallback: { o(options: unknown): Promise<unknown> };
let acp: { AcpGatewayAgent: new (...args: unknown[]) => {
  pendingPrompts: Map<string, unknown>;
  sessionStore: { clearActiveRun(sessionId: string): void };
  sessionUpdates: { emit(value: unknown): Promise<void> };
  rejectPendingPromptWithFailure(pending: unknown, value: unknown, fallback: string): Promise<void>;
  replaySessionTranscript(sessionId: string, transcript: unknown[]): Promise<void>;
} };
let embedded: { resolveAuthProfileFailureReason(params: unknown): unknown };
let OpenAI: typeof import('openai').default;
const provider = new DeterministicOpenAiServer('unused');

function modelFor(baseUrl: string): Model {
  return {
    id: 'uclaw-regression-model', name: 'Terminal regression', provider: 'uclaw-test',
    api: 'openai-completions', baseUrl, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32000, maxTokens: 512,
    // A test-local endpoint permission is not a TLS trust exception.
    [Symbol.for('openclaw.modelProviderRequestTransport')]: { allowPrivateNetwork: true },
  };
}

function context(scenario: string) {
  return { messages: [{ role: 'user', content: `[REGRESSION:${scenario}] test`, timestamp: Date.now() }] };
}

async function importRuntime(file: string) {
  return await import(/* @vite-ignore */ pathToFileURL(join(runtime, 'dist', file)).href);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'uclaw-terminal-e2e-'));
  runtime = join(root, 'runtime');
  const installed = resolve('node_modules/openclaw');
  const actualRoot = dirname(await import('node:fs/promises').then((fs) => fs.realpath(join(installed, 'package.json'))));
  expect(JSON.parse(await readFile(join(actualRoot, 'package.json'), 'utf8')).version).toBe('2026.6.10');
  // Resolve exactly the SDK that this installed OpenClaw uses, not a top-level
  // or test-double client. HTTP status SDK errors do not natively have a cause.
  const sdkPath = createRequire(join(actualRoot, 'package.json')).resolve('openai');
  OpenAI = (await import(/* @vite-ignore */ pathToFileURL(sdkPath).href)).default;
  await mkdir(join(runtime, 'dist'), { recursive: true });
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ version: '2026.6.10', type: 'module' }));
  // OpenClaw's bare dependencies are siblings in pnpm's virtual node_modules.
  const depDir = actualRoot.includes('/@') ? dirname(dirname(actualRoot)) : dirname(actualRoot);
  await symlink(depDir, join(runtime, 'node_modules'));
  for (const entry of await readdir(join(installed, 'dist'), { withFileTypes: true })) {
    const from = join(installed, 'dist', entry.name);
    const to = join(runtime, 'dist', entry.name);
    if (entry.isFile() && entry.name.endsWith('.js')) await writeFile(to, await readFile(from));
    else if (entry.name !== TERMINAL_HELPER_FILE) await symlink(from, to);
  }
  await patchOpenClawProviderTerminalErrorRuntime(runtime);
  await patchOpenClawAcpTerminalErrorRuntime(runtime);
  // Test-only exports leave full implementations and import graphs intact.
  const acpPath = join(runtime, 'dist', 'acp-cli-CDV6Zyhn.js');
  await writeFile(acpPath, `${await readFile(acpPath, 'utf8')}\nexport { AcpGatewayAgent };\n`);
  const embeddedPath = join(runtime, 'dist', PROVIDER_RUNTIME_FILES.embedded);
  await writeFile(embeddedPath, `${await readFile(embeddedPath, 'utf8')}\nexport { resolveAuthProfileFailureReason };\n`);
  helper = await importRuntime(TERMINAL_HELPER_FILE);
  classifier = await importRuntime('errors-BmvajW3H.js');
  transport = await importRuntime(PROVIDER_RUNTIME_FILES.transport);
  completions = await importRuntime(PROVIDER_RUNTIME_FILES.completions);
  fallback = await importRuntime(PROVIDER_RUNTIME_FILES.fallback);
  acp = await importRuntime('acp-cli-CDV6Zyhn.js');
  embedded = await importRuntime(PROVIDER_RUNTIME_FILES.embedded);
  await provider.start();
  // Fresh disposable self-signed cert. Neither CA loading nor verification bypass.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'),
    '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  tlsServer = createHttpsServer({
    key: await readFile(join(root, 'key.pem')), cert: await readFile(join(root, 'cert.pem')),
  }, (_req, res) => { res.writeHead(500); res.end('must not reach HTTP'); });
  tlsServer.on('connection', () => { tlsConnections += 1; });
  tlsServer.on('tlsClientError', () => {});
  await new Promise<void>((done) => tlsServer.listen(0, '127.0.0.1', done));
  const address = tlsServer.address() as { port: number };
  tlsOrigin = `https://127.0.0.1:${address.port}/v1`;
}, 30000);

afterAll(async () => {
  vi.restoreAllMocks();
  await provider.close();
  if (tlsServer) await new Promise<void>((done) => tlsServer.close(() => done()));
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('real OpenClaw provider terminal boundaries', () => {
  it.each([
    { status: 403, message: '403 订阅额度不足或未配置订阅: no active subscription' },
    { status: 403, message: 'Connection error.', code: 'insufficient_user_quota', provider: 'openai' },
    { status: 429, message: 'try again', errorType: 'insufficient_user_quota' },
    { status: 403, message: 'Internal error', details: ['insufficient_user_quota'] },
    { message: 'Connection error. (timeout)', code: 'TLS_CERT_INVALID' },
    { message: 'Connection error.', cause: { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } } },
  ])('runs the complete classifier before HTTP/plugin override: %j', (signal) => {
    expect(classifier.i(signal)).toEqual({ kind: 'reason', reason: 'format' });
    const assistant = {
      role: 'assistant', stopReason: 'error', errorMessage: signal.message,
      errorCode: helper.getUclawTerminalFailure(signal)?.code,
    };
    expect(classifier.n(assistant)).toBe('format');
    expect(classifier.d(assistant)).toBe(false);
    expect(classifier.f(assistant)).toBe(false);
    expect(classifier.S(assistant)).toBe(false);
    expect(embedded.resolveAuthProfileFailureReason({ failoverReason: 'format', providerStarted: true })).toBeNull();
  });

  it.each([
    [{ status: 401, message: 'invalid API key' }, 'auth'],
    [{ status: 403, message: 'Forbidden: permission denied' }, 'auth'],
    [{ status: 429, message: 'too many requests' }, 'rate_limit'],
    [{ status: 503, message: 'service unavailable' }, 'timeout'],
  ])('retains ordinary full-classifier behavior: %j', (signal, reason) => {
    expect(classifier.i(signal)).toEqual({ kind: 'reason', reason });
  });

  it('preserves an actual self-signed fetch cause without changing TLS trust', async () => {
    const failingFetch = vi.fn(fetch);
    await expect(fetch(tlsOrigin)).rejects.toMatchObject({ cause: { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' } });
    const response = await helper.createUclawTerminalFetch(failingFetch)(tlsOrigin);
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(495);
    expect(response.headers.get('x-should-retry')).toBe('false');
    const body = await response.json();
    expect(body.error.code).toBe('TLS_CERT_INVALID');
    expect(body.error.tlsCauseCode).toBe('DEPTH_ZERO_SELF_SIGNED_CERT');
    expect(JSON.stringify(body)).not.toMatch(/sk-|BEGIN CERTIFICATE|BEGIN PRIVATE KEY/);
  });

  it.each(['transport', 'completions'] as const)(
    'real %s SDK emits stable TLS code after exactly one handshake', async (kind) => {
      const before = tlsConnections;
      const model = modelFor(tlsOrigin);
      const stream = kind === 'transport'
        ? transport.r()(model, context('TLS'), { apiKey: 'sk-uclaw-regression' })
        : completions.n(model, context('TLS'), { apiKey: 'sk-uclaw-regression', maxRetries: 2 });
      const output = await stream.result();
      expect(output).toMatchObject({ stopReason: 'error', errorCode: 'TLS_CERT_INVALID', tlsCauseCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
      expect(output.errorMessage).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
      expect(tlsConnections - before).toBe(1);
      expect(normalizeAcpChatError(output)).toMatchObject({ code: 'TLS_CERT_INVALID', retryable: false });
    },
  );

  it.each(['DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'retains only allowlisted TLS cause %s through SDK, provider, ACP and replay', async (tlsCauseCode) => {
      const secret = 'private-transport-options-must-not-leak';
      const cause = Object.assign(new Error('fetch failed'), { cause: { code: tlsCauseCode, request: { apiKey: secret } } });
      const fetcher = vi.fn().mockRejectedValue(cause);
      const client = new OpenAI({
        apiKey: 'sk-uclaw-regression', baseURL: provider.baseUrl, maxRetries: 2,
        fetch: helper.createUclawTerminalFetch(fetcher),
      });
      const sdkError = await client.chat.completions.create({
        model: 'uclaw-regression-model', messages: [{ role: 'user', content: 'TLS cause regression' }],
      }).catch((error: unknown) => error);
      const output: Assistant = { role: 'assistant', stopReason: 'error' };
      helper.assignUclawTerminalFailure(output, sdkError);
      expect(output).toMatchObject({ errorCode: 'TLS_CERT_INVALID', tlsCauseCode });
      expect(output.errorMessage).toBe(`TLS_CERT_INVALID: ${tlsCauseCode}`);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(() => helper.throwUclawTerminalFailure(output)).toThrow(`TLS_CERT_INVALID: ${tlsCauseCode}`);
      const transcript = [{ role: 'user', content: 'current', id: 'user' }, output];
      const emitted: Array<{ update?: Record<string, unknown> }> = [];
      const reject = vi.fn();
      const agent = new acp.AcpGatewayAgent({}, { request: async () => ({ messages: transcript }) });
      agent.sessionUpdates = { emit: async (value: unknown) => { emitted.push(value as { update?: Record<string, unknown> }); } };
      agent.sessionStore = { clearActiveRun: () => {} };
      const pending = { sessionId: 'tls', sessionKey: 'agent:main:tls', userMessageId: 'user', idempotencyKey: 'run', reject };
      agent.pendingPrompts.set('tls', pending);
      await agent.rejectPendingPromptWithFailure(pending, new Error('Connection error.', { cause }), 'failed');
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ tlsCauseCode, cause: { code: tlsCauseCode } }));
      expect(emitted.at(-1)?.update).toMatchObject({ errorCode: 'TLS_CERT_INVALID', errorMessage: `TLS_CERT_INVALID: ${tlsCauseCode}` });
      await agent.replaySessionTranscript('tls', transcript);
      expect(emitted.at(-1)?.update).toMatchObject({ errorCode: 'TLS_CERT_INVALID', errorMessage: `TLS_CERT_INVALID: ${tlsCauseCode}` });
      expect(JSON.stringify({ output, emitted, error: reject.mock.calls[0][0] })).not.toContain(secret);
      expect(helper.getUclawTerminalFailure({ code: 'TLS_CERT_INVALID', tlsCauseCode: secret })).not.toHaveProperty('tlsCauseCode');
    },
  );

  it.each([
    [429, 'insufficient_user_quota'],
    [403, 'insufficient_user_quota'],
    [429, 'SUBSCRIPTION_UNAVAILABLE'],
  ] as const)('does not retry a delayed %s %s body within the SDK deadline', async (status, code) => {
    const fetcher = vi.fn(async () => {
      let timer: ReturnType<typeof setTimeout>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setTimeout(() => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code, message: 'managed failure' } })));
            controller.close();
          }, 350);
        },
        cancel() { clearTimeout(timer); },
      });
      return new Response(body, { status, headers: { 'content-type': 'application/json', 'x-should-retry': 'true' } });
    });
    const client = new OpenAI({
      apiKey: 'sk-uclaw-regression', baseURL: provider.baseUrl, maxRetries: 2, timeout: 2000,
      fetch: helper.createUclawTerminalFetch(fetcher),
    });
    const error = await client.chat.completions.create({
      model: 'uclaw-regression-model', messages: [{ role: 'user', content: 'delayed managed failure' }],
    }).catch((value: unknown) => value);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(helper.getUclawTerminalFailure(error)?.code).toBe(code);
    expect(classifier.i(error)).toEqual({ kind: 'reason', reason: 'format' });
    expect(embedded.resolveAuthProfileFailureReason({ failoverReason: 'format', providerStarted: true })).toBeNull();
    const run = vi.fn(async () => { throw error; });
    await expect(fallback.o({
      provider: 'uclaw-test', model: 'uclaw-regression-model', fallbacksOverride: ['uclaw-test/alternate'],
      run, skipAuthProfileRuntime: true, agentDir: join(root, 'agent'),
    })).rejects.toMatchObject({ code });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each(['QUOTA_403', 'QUOTA_429', 'SUBSCRIPTION_403'])(
    'real SDK makes one request for %s, with stable code', async (scenario) => {
      const before = provider.requests.filter((r) => r.scenario === scenario).length;
      const output = await transport.r()(modelFor(provider.baseUrl), context(scenario), { apiKey: 'sk-uclaw-regression' }).result();
      expect(output.stopReason).toBe('error');
      expect(provider.requests.filter((r) => r.scenario === scenario).length - before).toBe(1);
      expect(output.errorCode).toBe(scenario === 'SUBSCRIPTION_403' ? 'SUBSCRIPTION_UNAVAILABLE' : 'insufficient_user_quota');
      expect(normalizeAcpChatError(output)).toMatchObject({
        code: scenario === 'SUBSCRIPTION_403' ? 'SUBSCRIPTION_UNAVAILABLE' : 'INSUFFICIENT_QUOTA', retryable: false,
      });
    },
  );

  it('retains real SDK transient 429 retry and success', async () => {
    const before = provider.requests.filter((r) => r.scenario === 'HTTP_429').length;
    const output = await transport.r()(modelFor(provider.baseUrl), context('HTTP_429'), { apiKey: 'sk-uclaw-regression' }).result();
    expect(output.stopReason).toBe('stop');
    expect(provider.requests.filter((r) => r.scenario === 'HTTP_429').length - before).toBe(2);
  });

  it('retains ordinary thrown network errors, without converting them into terminal TLS', async () => {
    const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetcher = vi.fn().mockRejectedValue(error);
    await expect(helper.createUclawTerminalFetch(fetcher)(provider.baseUrl)).rejects.toBe(error);
    expect(helper.getUclawTerminalFailure('Connection error. (timeout)')).toBeUndefined();
  });

  it('real SDK retains ECONNRESET retry without weakening the terminal TLS boundary', async () => {
    const error = Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const fetcher = vi.fn(fetch).mockRejectedValueOnce(error);
    const client = new OpenAI({
      apiKey: 'sk-uclaw-regression', baseURL: provider.baseUrl, maxRetries: 2,
      fetch: helper.createUclawTerminalFetch(fetcher),
    });
    const output = await client.chat.completions.create({
      model: 'uclaw-regression-model', messages: [{ role: 'user', content: '[REGRESSION:RECOVERY] ordinary network retry' }],
    });
    expect(output.choices[0]?.message.content).toBe('UCLAW_REGRESSION_RECOVERY_OK');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('leaves unknown and oversized error bodies with their original retry advice', async () => {
    for (const text of [
      JSON.stringify({ error: { code: 'unknown', message: 'try again later' } }),
      JSON.stringify({ error: { code: 'unknown', message: 'x'.repeat(17000) } }),
    ]) {
      const response = new Response(text, { status: 429, headers: { 'content-type': 'application/json', 'x-should-retry': 'true' } });
      const result = await helper.createUclawTerminalFetch(vi.fn().mockResolvedValue(response))(provider.baseUrl, { signal: AbortSignal.timeout(2000) });
      expect(result).toBe(response);
      expect(result.headers.get('x-should-retry')).toBe('true');
      expect(await result.text()).toBe(text);
    }
  });

  it('uses the original SDK deadline for a stalled body, not an independent short timeout', async () => {
    const bodies: Array<{ controller: ReadableStreamDefaultController<Uint8Array>; cancelled: boolean }> = [];
    const cancel = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { bodies.push({ controller, cancelled: false }); },
      cancel() { bodies.at(-1)!.cancelled = true; cancel(); },
    }), { status: 429, headers: { 'content-type': 'application/json' } }));
    const client = new OpenAI({
      apiKey: 'sk-uclaw-regression', baseURL: provider.baseUrl, maxRetries: 0, timeout: 80,
      fetch: helper.createUclawTerminalFetch(fetcher),
    });
    try {
      await expect(client.chat.completions.create({
        model: 'uclaw-regression-model', messages: [{ role: 'user', content: 'deadline regression' }],
      })).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await new Promise((done) => setTimeout(done, 10));
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { for (const body of bodies) if (!body.cancelled) body.controller.close(); }
  });

  it('honors caller abort during body inspection without classifying timeout as terminal TLS', async () => {
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({ start(value) { bodyController = value; }, cancel }),
      { status: 429, headers: { 'content-type': 'application/json' } });
    const controller = new AbortController();
    const aborted = new DOMException('Caller cancelled', 'AbortError');
    const fetcher = helper.createUclawTerminalFetch(vi.fn().mockResolvedValue(response));
    const pending = fetcher(provider.baseUrl, { signal: controller.signal });
    const rejection = expect(pending).rejects.toBe(aborted);
    await new Promise((done) => setTimeout(done, 10));
    controller.abort(aborted);
    await rejection;
    expect(helper.getUclawTerminalFailure(aborted)).toBeUndefined();
    await new Promise((done) => setTimeout(done, 10));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(bodyController!).toBeDefined();
  });

  it('does not inspect an error body without a caller-owned abort boundary', async () => {
    const response = new Response(JSON.stringify({ error: { code: 'unknown' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'x-should-retry': 'true' } });
    expect(await helper.createUclawTerminalFetch(vi.fn().mockResolvedValue(response))(provider.baseUrl)).toBe(response);
    expect(response.headers.get('x-should-retry')).toBe('true');
  });

  it('retains delayed ordinary 429 retry after bounded body inspection', async () => {
    const fetcher = vi.fn(async () => {
      if (fetcher.mock.calls.length > 1) return new Response(JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }),
        { headers: { 'content-type': 'application/json' } });
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        setTimeout(() => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: 'rate_limit', message: 'too many requests' } })));
          controller.close();
        }, 350);
      } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' } });
    });
    const client = new OpenAI({ apiKey: 'sk-uclaw-regression', baseURL: provider.baseUrl, maxRetries: 1, timeout: 2000,
      fetch: helper.createUclawTerminalFetch(fetcher) });
    await expect(client.chat.completions.create({ model: 'test', messages: [{ role: 'user', content: 'normal retry' }] }))
      .resolves.toMatchObject({ choices: [{ message: { content: 'recovered' } }] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(['QUOTA_403', 'SUBSCRIPTION_403'])(
    'real SDK %s wrapped as Error cause reaches ACP without transcript or retries', async (scenario) => {
      const before = provider.requests.filter((request) => request.scenario === scenario).length;
      const client = new OpenAI({
        apiKey: 'sk-uclaw-regression', baseURL: provider.baseUrl, maxRetries: 2,
        fetch: helper.createUclawTerminalFetch(fetch),
      });
      const sdkError = await client.chat.completions.create({
        model: 'uclaw-regression-model',
        messages: [{ role: 'user', content: `[REGRESSION:${scenario}] test cause` }],
      }).catch((error: unknown) => error);
      expect(sdkError).toBeInstanceOf(OpenAI.PermissionDeniedError);
      expect(sdkError).toMatchObject({ status: 403 });
      const code = scenario === 'SUBSCRIPTION_403' ? 'SUBSCRIPTION_UNAVAILABLE' : 'insufficient_user_quota';
      const wrapped = new Error('Connection error. (timeout)', { cause: sdkError });
      expect(helper.getUclawTerminalFailure(wrapped)?.code).toBe(code);
      expect(classifier.i({ message: wrapped.message, status: 403, cause: wrapped.cause })).toEqual({ kind: 'reason', reason: 'format' });
      const emitted: Array<{ update?: Record<string, unknown> }> = [];
      const reject = vi.fn();
      const agent = new acp.AcpGatewayAgent({}, { request: async () => ({ messages: [] }) });
      agent.sessionUpdates = { emit: async (value: unknown) => { emitted.push(value as { update?: Record<string, unknown> }); } };
      agent.sessionStore = { clearActiveRun: () => {} };
      const pending = { sessionId: 's', sessionKey: 'agent:main:s', userMessageId: 'user', idempotencyKey: 'run', reject };
      agent.pendingPrompts.set('s', pending);
      await agent.rejectPendingPromptWithFailure(pending, wrapped, 'failed');
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ code, errorCode: code }));
      expect(emitted.at(-1)?.update).toMatchObject({ errorCode: code });
      expect(normalizeAcpChatError(emitted.at(-1)?.update)).toMatchObject({
        code: scenario === 'SUBSCRIPTION_403' ? 'SUBSCRIPTION_UNAVAILABLE' : 'INSUFFICIENT_QUOTA', retryable: false,
      });
      expect(JSON.stringify(emitted)).not.toContain('sk-uclaw-regression');
      expect(provider.requests.filter((request) => request.scenario === scenario).length - before).toBe(1);
    },
  );

  it.each(['QUOTA_403', 'SUBSCRIPTION_403'])(
    'real %s SDK output survives generic ACP failure and transcript replay', async (scenario) => {
      const output = await transport.r()(modelFor(provider.baseUrl), context(scenario), { apiKey: 'sk-uclaw-regression' }).result();
      const code = scenario === 'SUBSCRIPTION_403' ? 'SUBSCRIPTION_UNAVAILABLE' : 'insufficient_user_quota';
      const transcript = [{ role: 'user', content: 'current', id: 'user-current' }, output];
      const emitted: Array<{ update?: Record<string, unknown> }> = [];
      const reject = vi.fn();
      const agent = new acp.AcpGatewayAgent({}, { request: async () => ({ messages: transcript }) });
      agent.sessionUpdates = { emit: async (value: unknown) => { emitted.push(value as { update?: Record<string, unknown> }); } };
      agent.sessionStore = { clearActiveRun: () => {} };
      const pending = { sessionId: 's', sessionKey: 'agent:main:s', userMessageId: 'user-current', idempotencyKey: 'run', reject };
      agent.pendingPrompts.set('s', pending);
      await agent.rejectPendingPromptWithFailure(pending, { errorMessage: 'LLM request failed.' }, 'failed');
      expect(emitted.at(-1)?.update).toMatchObject({ errorCode: code });
      expect(reject).toHaveBeenCalledWith(expect.objectContaining({ code }));
      await agent.replaySessionTranscript('s', transcript);
      expect(emitted.at(-1)?.update).toMatchObject({ errorCode: code });
    },
  );

  it('leaves image model fallback unchanged and rejects duplicate guarded-fetch layouts', async () => {
    const source = await readFile(resolve('node_modules/openclaw/dist', PROVIDER_RUNTIME_FILES.fallback), 'utf8');
    const rewritten = rewriteProviderTerminalErrors(source, 'fallback');
    const imageStart = 'async function runWithImageModelFallback(params) {';
    expect(rewritten.slice(rewritten.indexOf(imageStart))).toBe(source.slice(source.indexOf(imageStart)));
    const transportSource = await readFile(resolve('node_modules/openclaw/dist', PROVIDER_RUNTIME_FILES.transport), 'utf8');
    expect(() => rewriteProviderTerminalErrors(`${transportSource}\nfunction buildGuardedModelFetch(model, timeoutMs, options) {}`, 'transport')).toThrow('Unsupported OpenClaw provider layout');
  });

  it('repairs missing provider helper imports, rejects duplicates and retains a single non-leading import', async () => {
    const helperImport = `import { createUclawTerminalFetch, assignUclawTerminalFailure, throwUclawTerminalFailure } from "./${TERMINAL_HELPER_FILE}";\n`;
    for (const [kind, file] of Object.entries(PROVIDER_RUNTIME_FILES)) {
      const patched = rewriteProviderTerminalErrors(await readFile(resolve('node_modules/openclaw/dist', file), 'utf8'), kind);
      expect(rewriteProviderTerminalErrors(patched.replace(helperImport, ''), kind)).toBe(patched);
      expect(() => rewriteProviderTerminalErrors(helperImport + patched, kind)).toThrow('duplicate terminal helper import');
      expect(rewriteProviderTerminalErrors('// license\n' + patched, kind)).toBe('// license\n' + patched);
    }
  });

  it('fails the late chunk preflight without writing any earlier runtime or helper', async () => {
    const isolated = join(root, 'late-drift');
    await mkdir(join(isolated, 'dist'), { recursive: true });
    await writeFile(join(isolated, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    for (const file of Object.values(PROVIDER_RUNTIME_FILES)) {
      await writeFile(join(isolated, 'dist', file), await readFile(resolve('node_modules/openclaw/dist', file)));
    }
    await writeFile(join(isolated, 'dist', PROVIDER_RUNTIME_FILES['responses-shared']), 'layout drift');
    const before = await readFile(join(isolated, 'dist', PROVIDER_RUNTIME_FILES.transport), 'utf8');
    await expect(patchOpenClawProviderTerminalErrorRuntime(isolated)).rejects.toThrow('Unsupported OpenClaw provider layout');
    expect(await readFile(join(isolated, 'dist', PROVIDER_RUNTIME_FILES.transport), 'utf8')).toBe(before);
    await expect(readFile(join(isolated, 'dist', TERMINAL_HELPER_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([false, true])('rolls back truncated provider writes and restores a pre-existing helper=%s', async (existingHelper) => {
    const isolated = join(root, `write-fault-${existingHelper}`);
    await mkdir(join(isolated, 'dist'), { recursive: true });
    await writeFile(join(isolated, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    const originals = new Map<string, string>();
    for (const file of Object.values(PROVIDER_RUNTIME_FILES)) {
      const original = await readFile(resolve('node_modules/openclaw/dist', file), 'utf8');
      const filePath = join(isolated, 'dist', file);
      originals.set(filePath, original);
      await writeFile(filePath, original);
    }
    const helperPath = join(isolated, 'dist', TERMINAL_HELPER_FILE);
    if (existingHelper) await writeFile(helperPath, TERMINAL_HELPER_SOURCE);
    let writes = 0;
    const failure = Object.assign(new Error('injected provider write failure'), { code: 'ENOSPC' });
    const fileOps = { rm, writeFile: async (filePath: string, content: string) => {
      writes += 1;
      if (writes === 2) { await writeFile(filePath, 'truncated module'); throw failure; }
      await writeFile(filePath, content);
    } };
    await expect(patchOpenClawProviderTerminalErrorRuntime(isolated, fileOps)).rejects.toBe(failure);
    for (const [filePath, original] of originals) expect(await readFile(filePath, 'utf8')).toBe(original);
    if (existingHelper) expect(await readFile(helperPath, 'utf8')).toBe(TERMINAL_HELPER_SOURCE);
    else await expect(readFile(helperPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await patchOpenClawProviderTerminalErrorRuntime(isolated)).filesPatched).toBeGreaterThan(0);
  });

  it('upgrades exactly the previous helper and restores it when an upgrade write fails', async () => {
    // Reconstruct the known pre-fix helper without accepting arbitrary compatible-looking sources.
    const oldHelper = `// UClaw terminal provider errors: no trust changes and no generic network retry changes.
const TLS_CODES = new Set([
  "TLS_CERT_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED", "INVALID_CA"
]);
// Bound traversal and body inspection; do not persist untrusted transport data.
export function getUclawTerminalFailure(value) {
  const seen = new Set();
  const queue = [value];
  let quota = false;
  let subscription = false;
  for (let count = 0; queue.length && count < 48; count += 1) {
    const item = queue.shift();
    if (typeof item === "string") {
      if (item.length > 16384) continue;
      if (/\\b(?:TLS_CERT_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY|CERT_HAS_EXPIRED|CERT_NOT_YET_VALID|ERR_TLS_CERT_ALTNAME_INVALID|CERT_UNTRUSTED|INVALID_CA)\\b/.test(item)) return { code: "TLS_CERT_INVALID", errorMessage: "TLS_CERT_INVALID: certificate validation failed" };
      if (/\\bSUBSCRIPTION_UNAVAILABLE\\b|订阅额度不足或未配置订阅|\\bno active subscription\\b/i.test(item)) subscription = true;
      if (/\\binsufficient_user_quota\\b|用户额度不足|预扣费额度失败/.test(item)) quota = true;
      if (item.trim().startsWith("{")) {
        try { queue.push(JSON.parse(item)); } catch { /* Not a structured provider body. */ }
      }
      continue;
    }
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (Array.isArray(item)) { queue.push(...item.slice(0, 12)); continue; }
    for (const key of ["code", "errorCode", "errorType", "type"]) {
      const code = item[key];
      if (TLS_CODES.has(code)) return { code: "TLS_CERT_INVALID", errorMessage: "TLS_CERT_INVALID: " + code };
      if (code === "SUBSCRIPTION_UNAVAILABLE") subscription = true;
      if (code === "insufficient_user_quota") quota = true;
    }
    for (const key of ["message", "errorMessage", "error", "cause", "details", "detail", "body", "errorBody", "data", "response"]) {
      if (item[key] !== undefined) queue.push(item[key]);
    }
  }
  if (subscription) return { code: "SUBSCRIPTION_UNAVAILABLE", errorMessage: "SUBSCRIPTION_UNAVAILABLE: no active subscription or subscription quota exhausted" };
  if (quota) return { code: "insufficient_user_quota", errorMessage: "insufficient_user_quota: user quota exhausted" };
}
export function throwUclawTerminalFailure(value) {
  const failure = getUclawTerminalFailure(value);
  if (!failure) return;
  // Only safe stable metadata is exposed to Gateway/ACP; no transport cause is serialized.
  throw Object.assign(new Error(failure.errorMessage), { code: failure.code, errorCode: failure.code });
}
export function assignUclawTerminalFailure(output, error) {
  const failure = getUclawTerminalFailure(error);
  if (!failure) return;
  output.errorCode = failure.code;
  output.errorType = failure.code;
  output.errorMessage = failure.errorMessage;
}
async function readBoundedErrorBody(response) {
  if (response.ok || !/json/i.test(response.headers.get("content-type") ?? "")) return;
  const length = Number(response.headers.get("content-length"));
  if (length > 16384) return;
  let reader;
  try { reader = response.clone().body?.getReader(); } catch { return; }
  if (!reader) return;
  const chunks = [];
  let size = 0;
  // An error body may stall; never add an unbounded wait before SDK retry logic.
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve({ done: true, timedOut: true }), 250); });
  try {
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.timedOut) return;
      if (next.done) break;
      size += next.value.length;
      if (size > 16384) return;
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  } catch {
    // Failed body inspection is not new evidence of a terminal failure.
    return;
  } finally {
    clearTimeout(timer);
    // Do not await tee cancellation: the SDK has not yet consumed the other branch.
    void reader.cancel().catch(() => {});
  }
}
export function createUclawTerminalFetch(fetchImpl) {
  return async (input, init) => {
    let response;
    try { response = await fetchImpl(input, init); }
    catch (error) {
      const failure = getUclawTerminalFailure(error);
      if (failure?.code !== "TLS_CERT_INVALID") throw error;
      // Local SDK sentinel, NOT an upstream HTTP response. The SDK retries thrown
      // fetch errors before exposing their causes; this non-retryable response
      // preserves the certificate code without modifying trust or SDK globals.
      return new Response(JSON.stringify({ error: {
        code: failure.code, type: failure.code, message: failure.errorMessage
      } }), { status: 495, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    }
    if (response.ok) return response;
    const failure = getUclawTerminalFailure(await readBoundedErrorBody(response));
    if (!failure) return response;
    const headers = new Headers(response.headers);
    headers.set("x-should-retry", "false");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}
`;
    expect(createHash('sha256').update(oldHelper).digest('hex')).toBe('ca76861b96d318b7c4e8ea5de2342ffe4701f9c56934b0fa82133614575ad3b5');
    const isolated = join(root, 'helper-upgrade');
    await mkdir(join(isolated, 'dist'), { recursive: true });
    await writeFile(join(isolated, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    for (const file of Object.values(PROVIDER_RUNTIME_FILES)) {
      await writeFile(join(isolated, 'dist', file), await readFile(resolve('node_modules/openclaw/dist', file)));
    }
    const helperPath = join(isolated, 'dist', TERMINAL_HELPER_FILE);
    await writeFile(helperPath, oldHelper);
    let writes = 0;
    const failure = new Error('upgrade write failed');
    await expect(patchOpenClawProviderTerminalErrorRuntime(isolated, { rm, writeFile: async (filePath: string, content: string) => {
      writes += 1;
      if (writes === 2) throw failure;
      await writeFile(filePath, content);
    } })).rejects.toBe(failure);
    expect(await readFile(helperPath, 'utf8')).toBe(oldHelper);
    await patchOpenClawProviderTerminalErrorRuntime(isolated);
    expect(await readFile(helperPath, 'utf8')).toBe(TERMINAL_HELPER_SOURCE);
    expect((await patchOpenClawProviderTerminalErrorRuntime(isolated)).filesPatched).toBe(0);
  });

  it('rejects unknown helper content before touching provider chunks', async () => {
    const isolated = join(root, 'helper-drift');
    await mkdir(join(isolated, 'dist'), { recursive: true });
    await writeFile(join(isolated, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    for (const file of Object.values(PROVIDER_RUNTIME_FILES)) {
      await writeFile(join(isolated, 'dist', file), await readFile(resolve('node_modules/openclaw/dist', file)));
    }
    const helperPath = join(isolated, 'dist', TERMINAL_HELPER_FILE);
    await writeFile(helperPath, 'unknown helper source');
    const target = join(isolated, 'dist', PROVIDER_RUNTIME_FILES.transport);
    const before = await readFile(target, 'utf8');
    await expect(patchOpenClawProviderTerminalErrorRuntime(isolated)).rejects.toThrow('Unsupported UClaw terminal helper layout');
    expect(await readFile(target, 'utf8')).toBe(before);
    expect(await readFile(helperPath, 'utf8')).toBe('unknown helper source');
  });

  it('reports provider rollback failure while still restoring earlier writes and removing the new helper', async () => {
    const isolated = join(root, 'provider-rollback-failure');
    await mkdir(join(isolated, 'dist'), { recursive: true });
    await writeFile(join(isolated, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    for (const file of Object.values(PROVIDER_RUNTIME_FILES)) {
      await writeFile(join(isolated, 'dist', file), await readFile(resolve('node_modules/openclaw/dist', file)));
    }
    const target = join(isolated, 'dist', PROVIDER_RUNTIME_FILES.transport);
    const before = await readFile(target, 'utf8');
    let writes = 0;
    const failure = new Error('provider write failed');
    const rollbackFailure = new Error('provider rollback failed');
    const error = await patchOpenClawProviderTerminalErrorRuntime(isolated, { rm, writeFile: async (filePath: string, content: string) => {
      writes += 1;
      if (writes === 3) throw failure;
      if (writes === 4) throw rollbackFailure;
      await writeFile(filePath, content);
    } }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error).toMatchObject({ message: 'Provider patch write failed; rollback incomplete', cause: failure, errors: [failure, rollbackFailure] });
    expect(await readFile(target, 'utf8')).toBe(before);
    await expect(readFile(join(isolated, 'dist', TERMINAL_HELPER_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['QUOTA_403', 'SUBSCRIPTION_403', 'TLS'])(
    'real model fallback runs only the primary for %s and emits no failed-candidate step', async (scenario) => {
      const run = vi.fn(async () => {
        const output = await transport.r()(modelFor(scenario === 'TLS' ? tlsOrigin : provider.baseUrl), context(scenario), { apiKey: 'sk-uclaw-regression' }).result();
        helper.throwUclawTerminalFailure(output);
        return output;
      });
      const step = vi.fn();
      await expect(fallback.o({
        provider: 'uclaw-test', model: 'uclaw-regression-model',
        fallbacksOverride: ['uclaw-test/alternate'], run, onFallbackStep: step,
        skipAuthProfileRuntime: true, agentDir: join(root, 'agent'),
      })).rejects.toMatchObject({ code: scenario === 'TLS' ? 'TLS_CERT_INVALID' : scenario === 'SUBSCRIPTION_403' ? 'SUBSCRIPTION_UNAVAILABLE' : 'insufficient_user_quota' });
      expect(run).toHaveBeenCalledTimes(1);
      expect(step.mock.calls.filter(([value]) => value?.decision === 'candidate_failed')).toHaveLength(0);
    },
  );

  it('real ACP failure and transcript replay keep TLS terminal after a generic upper envelope', async () => {
    const output = await transport.r()(modelFor(tlsOrigin), context('TLS'), { apiKey: 'sk-uclaw-regression' }).result();
    const transcript = [ { role: 'user', content: 'current', id: 'user-current' }, output ];
    const emitted: Array<{ update?: Record<string, unknown> }> = [];
    const reject = vi.fn();
    const agent = new acp.AcpGatewayAgent({}, { request: async () => ({ messages: transcript }) });
    agent.sessionUpdates = { emit: async (value: unknown) => { emitted.push(value as { update?: Record<string, unknown> }); } };
    const pending = { sessionId: 's', sessionKey: 'agent:main:s', userMessageId: 'user-current', idempotencyKey: 'run', reject };
    agent.pendingPrompts.set('s', pending);
    agent.sessionStore = { clearActiveRun: () => {} };
    await agent.rejectPendingPromptWithFailure(pending, { errorMessage: 'Connection error. (timeout)' }, 'failed');
    expect(emitted.at(-1)?.update).toMatchObject({ errorCode: 'TLS_CERT_INVALID' });
    expect(normalizeAcpChatError(emitted.at(-1)?.update)).toMatchObject({ code: 'TLS_CERT_INVALID', retryable: false });
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ code: 'TLS_CERT_INVALID' }));
    await agent.replaySessionTranscript('s', transcript);
    expect(emitted.at(-1)?.update).toMatchObject({ errorCode: 'TLS_CERT_INVALID' });
  });

  it('patches idempotently, refuses version/layout drift before any writes', async () => {
    expect(await patchOpenClawProviderTerminalErrorRuntime(runtime)).toEqual({ filesPatched: 0, filesScanned: 8 });
    const target = join(runtime, 'dist', PROVIDER_RUNTIME_FILES.transport);
    const original = await readFile(target, 'utf8');
    await writeFile(target, 'unknown transport layout');
    await expect(patchOpenClawProviderTerminalErrorRuntime(runtime)).rejects.toThrow('Unsupported OpenClaw provider layout');
    expect(await readFile(join(runtime, 'dist', TERMINAL_HELPER_FILE), 'utf8')).toBe(TERMINAL_HELPER_SOURCE);
    await writeFile(target, original);
    await writeFile(join(runtime, 'package.json'), JSON.stringify({ version: '2026.6.11' }));
    await expect(patchOpenClawProviderTerminalErrorRuntime(runtime)).rejects.toThrow('Expected OpenClaw 2026.6.10');
    expect(await readFile(target, 'utf8')).toBe(original);
  });
});
