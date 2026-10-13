// @vitest-environment node

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  LoadSessionRequest,
  LoadSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { patchOpenClawProviderTerminalErrorRuntime } from '../../scripts/openclaw-provider-terminal-error-patch.mjs';
import { patchOpenClawAcpTerminalErrorRuntime } from '../../scripts/openclaw-acp-terminal-error-patch.mjs';
import { patchOpenClawAcpStreamingRuntime } from '../../scripts/openclaw-acp-streaming-patch.mjs';
import {
  ACP_LOAD_SESSION_REPLAY_LIMIT,
  patchOpenClawAcpSessionReplayRuntime,
} from '../../scripts/openclaw-acp-session-replay-guard-patch.mjs';
import {
  patchOpenClawAcpBindingIsolationRuntime,
  rewriteAcpBindingIsolation,
} from '../../scripts/openclaw-acp-binding-isolation-patch.mjs';

const SESSION_KEY = 'agent:pi:s1';
const OTHER_SESSION_KEY = 'agent:pi:s2';
const GATEWAY_KEYS = new Set([SESSION_KEY, OTHER_SESSION_KEY]);
const ACP_CHUNK = 'acp-cli-CDV6Zyhn.js';
const SESSION_CHUNK = 'session-fMJRfWmY.js';
const HISTORY = [
  { role: 'user', content: [{ type: 'text', text: '既有用户历史' }] },
  { role: 'assistant', content: [{ type: 'text', text: '既有助手历史' }] },
];

type Session = {
  sessionId: string;
  sessionKey: string;
  activeRunId: string | null;
  abortController: AbortController | null;
};
type SessionStore = {
  getSession(sessionId: string): Session | undefined;
  deleteSession(sessionId: string): boolean;
  clearAllSessionsForTest(): void;
};
type GatewayParams = Record<string, unknown>;
type GatewayEvent = { event: string; payload: GatewayParams };
type Agent = {
  sessionStore: SessionStore;
  pendingPrompts: Map<string, { idempotencyKey: string; sessionKey: string }>;
  approvalRelays: Map<string, { state: string }>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  newSession(params: unknown): Promise<unknown>;
  prompt(params: PromptRequest): Promise<PromptResponse>;
  cancel(params: { sessionId: string }): Promise<void>;
  handleGatewayEvent(event: GatewayEvent): Promise<void>;
  closeSession(params: { sessionId: string }): Promise<unknown>;
  resumeSession(params: LoadSessionRequest): Promise<unknown>;
  uclawApprovalBindings: Map<string, { sessionId: string; requiresRunId: boolean }>;
  uclawApprovalBindingsOverflow: boolean;
};
type AgentConstructor = new (
  connection: {
    sessionUpdate(params: SessionNotification): Promise<void>;
    requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse>;
  },
  gateway: { request(method: string, params: GatewayParams, options?: unknown): Promise<unknown> },
  opts: { sessionStore: SessionStore; eventLedger: unknown; prefixCwd: boolean },
) => Agent;
type RpcCall = { method: string; params: GatewayParams; options?: unknown };

let root: string;
let installedRoot: string;
let installedAcpSource: string;
let AcpGatewayAgent: AgentConstructor;
let createSessionStore: (options: { maxSessions: number }) => SessionStore;
let createEventLedger: (options: {
  maxSessions: number;
  maxEventsPerSession: number;
  maxSerializedBytes: number;
}) => unknown;

/** Explicit deadlines keep a missing terminal event or abort acknowledgement bounded. */
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('ACP binding test exceeded 1500ms')), 1500);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => { release = done; });
  return { promise, release };
}

/** No socket, provider, config, transcript file, or auth lookup backs this Gateway. */
function fixture() {
  const calls: RpcCall[] = [];
  const updates: SessionNotification[] = [];
  const permissions: RequestPermissionRequest[] = [];
  const abortGate = deferred();
  let delayAbort = false;
  let permissionDecision: 'cancelled' | 'allow-once' = 'cancelled';
  const gateway = {
    request: vi.fn(async (method: string, params: GatewayParams, options?: unknown) => {
      calls.push({ method, params, options });
      if (calls.length > 64) throw new Error('Gateway RPC bound exceeded');
      switch (method) {
        case 'sessions.resolve':
          expect(GATEWAY_KEYS.has(String(params.key))).toBe(true);
          return { key: params.key };
        case 'sessions.list':
          expect(GATEWAY_KEYS.has(String(params.search))).toBe(true);
          return { sessions: [{ key: params.search, displayName: '既有逻辑会话', thinkingLevel: 'off' }] };
        case 'sessions.get':
          expect(GATEWAY_KEYS.has(String(params.key))).toBe(true);
          expect(params.limit).toBe(ACP_LOAD_SESSION_REPLAY_LIMIT);
          return { messages: structuredClone(HISTORY) };
        case 'chat.send':
          expect(GATEWAY_KEYS.has(String(params.sessionKey))).toBe(true);
          expect(params.idempotencyKey).toEqual(expect.any(String));
          return { runId: params.idempotencyKey, status: 'accepted' };
        case 'chat.abort':
          expect(GATEWAY_KEYS.has(String(params.sessionKey))).toBe(true);
          expect(params.runId).toEqual(expect.any(String));
          if (delayAbort) await abortGate.promise;
          return { aborted: true, runIds: [params.runId] };
        case 'exec.approval.get':
          return { commandText: 'synthetic approval only', allowedDecisions: ['allow-once', 'deny'] };
        case 'exec.approval.resolve':
          expect(['allow-once', 'deny']).toContain(params.decision);
          return { ok: true };
        default:
          throw new Error(`Unexpected Gateway RPC: ${method}`);
      }
    }),
  };
  const connection = {
    sessionUpdate: vi.fn(async (value: SessionNotification) => {
      if (updates.length >= 64) throw new Error('ACP update bound exceeded');
      updates.push(structuredClone(value));
    }),
    requestPermission: vi.fn(async (value: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      if (permissions.length >= 4) throw new Error('ACP permission bound exceeded');
      permissions.push(structuredClone(value));
      if (permissionDecision === 'allow-once') return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
      return { outcome: { outcome: 'cancelled' } };
    }),
  };
  const agent = new AcpGatewayAgent(connection, gateway, {
    sessionStore: createSessionStore({ maxSessions: 8 }),
    eventLedger: createEventLedger({ maxSessions: 8, maxEventsPerSession: 32, maxSerializedBytes: 64 * 1024 }),
    prefixCwd: false,
  });
  const newSession = vi.spyOn(agent, 'newSession');
  const prompts: Array<Promise<PromptResponse>> = [];

  return {
    agent, calls, updates, permissions, newSession,
    allowPermissions() { permissionDecision = 'allow-once'; },
    delayAbort() { delayAbort = true; },
    releaseAbort: abortGate.release,
    async load(sessionId: string, requireExistingSession = false, sessionKey = SESSION_KEY) {
      return await bounded(agent.loadSession({
        sessionId, cwd: root, mcpServers: [],
        _meta: { sessionKey, prefixCwd: false, requireExistingSession },
      }));
    },
    async start(sessionId: string, text = '继续既有会话') {
      const result = agent.prompt({ sessionId, prompt: [{ type: 'text', text }] });
      // Observe failures immediately, including when an earlier assertion fails.
      let settled = false;
      void result.then(() => { settled = true; }, () => { settled = true; });
      prompts.push(result);
      await vi.waitFor(() => expect(agent.pendingPrompts.get(sessionId)).toBeDefined(), { timeout: 1000, interval: 5 });
      const runId = agent.pendingPrompts.get(sessionId)!.idempotencyKey;
      await vi.waitFor(() => expect(calls.some((call) =>
        call.method === 'chat.send' && call.params.idempotencyKey === runId)).toBe(true), { timeout: 1000, interval: 5 });
      return { result, runId, isSettled: () => settled };
    },
    async close() {
      abortGate.release();
      for (const sessionId of [...agent.pendingPrompts.keys()]) await bounded(agent.cancel({ sessionId }));
      await bounded(Promise.allSettled(prompts));
      agent.sessionStore.clearAllSessionsForTest();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
let activeFixtures: Fixture[] = [];
function setup() {
  const value = fixture();
  activeFixtures.push(value);
  return value;
}

function bindingId() {
  return `uclaw-binding:${randomUUID()}`;
}

function chatEvent(runId: string, state: string, text?: string, sessionKey = SESSION_KEY): GatewayEvent {
  return {
    event: 'chat',
    payload: {
      sessionKey, runId, seq: 1, state,
      ...(state === 'delta' ? { deltaText: text ?? '' } : {}),
      ...(state === 'error' ? { errorMessage: 'synthetic old failure' } : {}),
      ...(text ? { message: { role: 'assistant', content: [{ type: 'text', text }] } } : {}),
    },
  };
}

function toolEvent(runId: string, phase: string, toolCallId: string): GatewayEvent {
  return {
    event: 'agent',
    payload: {
      sessionKey: SESSION_KEY, runId, seq: 1, ts: 0, stream: 'tool',
      data: { phase, name: 'read', toolCallId, args: { path: '/synthetic' }, partialResult: 'partial', result: 'done' },
    },
  };
}

function approvalEvent(runId: string, approvalId: string): GatewayEvent {
  return {
    event: 'agent',
    payload: {
      sessionKey: SESSION_KEY, runId, seq: 1, ts: 0, stream: 'approval',
      data: { phase: 'requested', kind: 'exec', status: 'pending', approvalId, command: 'synthetic only' },
    },
  };
}

function nativeApproval(approvalId: string, sessionKey = SESSION_KEY, runIds: { payload?: string; request?: string } = {}): GatewayEvent {
  return {
    event: 'exec.approval.requested',
    payload: {
      id: approvalId,
      ...(runIds.payload ? { runId: runIds.payload } : {}),
      request: { sessionKey, command: 'synthetic only', host: 'gateway', ...(runIds.request ? { runId: runIds.request } : {}) },
    },
  };
}

async function expectDecision(value: Fixture, id: string, decision: 'deny' | 'allow-once') {
  await vi.waitFor(() => expect(value.calls).toContainEqual({
    method: 'exec.approval.resolve', params: { id, decision }, options: undefined,
  }), { timeout: 1000, interval: 5 });
}

function expectNoResetOrNewSession(value: Fixture) {
  expect(value.newSession).not.toHaveBeenCalled();
  expect(value.calls.some((call) => ['sessions.reset', 'sessions.create', 'sessions.new', 'newSession'].includes(call.method))).toBe(false);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'uclaw-binding-isolation-'));
  // The runtime must never discover the developer's on-disk auth/config state.
  vi.stubEnv('OPENCLAW_HOME', join(root, 'home'));
  vi.stubEnv('OPENCLAW_STATE_DIR', join(root, 'state'));
  vi.stubEnv('OPENCLAW_CONFIG_PATH', join(root, 'state', 'openclaw.json'));
  vi.stubEnv('XDG_CONFIG_HOME', join(root, 'config'));
  installedRoot = dirname(await realpath(resolve('node_modules/openclaw/package.json')));
  expect(JSON.parse(await readFile(join(installedRoot, 'package.json'), 'utf8')).version).toBe('2026.6.10');
  installedAcpSource = await readFile(join(installedRoot, 'dist', ACP_CHUNK), 'utf8');
  const runtime = join(root, 'runtime');
  await mkdir(join(runtime, 'dist'), { recursive: true });
  await writeFile(join(runtime, 'package.json'), JSON.stringify({ type: 'module', version: '2026.6.10' }));
  // pnpm's bare dependencies are siblings of the actual OpenClaw package.
  const dependencies = installedRoot.includes('/@') ? dirname(dirname(installedRoot)) : dirname(installedRoot);
  await symlink(dependencies, join(runtime, 'node_modules'));
  for (const entry of await readdir(join(installedRoot, 'dist'), { withFileTypes: true })) {
    const from = join(installedRoot, 'dist', entry.name);
    const to = join(runtime, 'dist', entry.name);
    // Every potentially patched JS module is an independent file, never a link.
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) await writeFile(to, await readFile(from));
    else await symlink(from, to);
  }
  // Match postinstall/bundle ACP order on a disposable full runtime graph.
  await patchOpenClawAcpStreamingRuntime(runtime);
  await patchOpenClawProviderTerminalErrorRuntime(runtime);
  await patchOpenClawAcpTerminalErrorRuntime(runtime);
  const acpPath = join(runtime, 'dist', ACP_CHUNK);
  expect(await patchOpenClawAcpBindingIsolationRuntime(runtime)).toEqual({ filesPatched: 1, filesScanned: 1 });
  await patchOpenClawAcpSessionReplayRuntime(runtime);
  const patched = await readFile(acpPath, 'utf8');
  expect(await patchOpenClawAcpBindingIsolationRuntime(runtime)).toEqual({ filesPatched: 0, filesScanned: 1 });
  // A second complete install must remain a no-op, not undo any sibling guard.
  await patchOpenClawAcpStreamingRuntime(runtime);
  await patchOpenClawProviderTerminalErrorRuntime(runtime);
  await patchOpenClawAcpTerminalErrorRuntime(runtime);
  expect(await patchOpenClawAcpBindingIsolationRuntime(runtime)).toEqual({ filesPatched: 0, filesScanned: 1 });
  await patchOpenClawAcpSessionReplayRuntime(runtime);
  expect(await readFile(acpPath, 'utf8')).toBe(patched);
  // Fail if a future patch replaces the real routing methods under test.
  for (const [start, end] of [
    ['\tasync loadSession(params) {', '\tasync listSessions(params) {'],
    ['\tasync prompt(params) {', '\tasync cancel(params) {'],
    ['\tasync cancel(params) {', '\tasync resolveSessionKeyFromMeta(params) {'],
    ['\tasync cancelSessionWork(session) {', '\tasync getGatewaySessionRow(sessionKey) {'],
  ]) {
    const originalBody = installedAcpSource.slice(installedAcpSource.indexOf(start), installedAcpSource.indexOf(end));
    expect(originalBody.length).toBeGreaterThan(50);
    // The only loadSession edit is a real-store wrapper that records ownership.
    expect(patched.slice(patched.indexOf(start), patched.indexOf(end))
      .replaceAll('this.createUclawBoundSession({', 'this.sessionStore.createSession({')).toBe(originalBody);
  }
  // Only test exports are appended; the complete generated import graph remains.
  await writeFile(acpPath, `${patched}\nexport { AcpGatewayAgent, createInMemoryAcpEventLedger };\n`);
  const acp = await import(/* @vite-ignore */ pathToFileURL(acpPath).href);
  const sessions = await import(/* @vite-ignore */ pathToFileURL(join(runtime, 'dist', SESSION_CHUNK)).href);
  AcpGatewayAgent = acp.AcpGatewayAgent;
  createEventLedger = acp.createInMemoryAcpEventLedger;
  createSessionStore = sessions.t;
}, 30000);

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Network/provider requests are forbidden in ACP binding tests');
  });
});

afterEach(async () => {
  try {
    for (const value of activeFixtures) {
      await value.close();
      expectNoResetOrNewSession(value);
    }
    expect(globalThis.fetch).not.toHaveBeenCalled();
  } finally {
    activeFixtures = [];
    vi.restoreAllMocks();
  }
});

afterAll(async () => {
  try {
    if (installedAcpSource) expect(await readFile(join(installedRoot, 'dist', ACP_CHUNK), 'utf8')).toBe(installedAcpSource);
  } finally {
    vi.unstubAllEnvs();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe('installed OpenClaw 2026.6.10 ACP binding isolation', () => {
  it.each([false, true])('loads a fresh binding from existing Gateway history (requireExisting=%s)', async (requireExisting) => {
    const value = setup();
    const sessionId = bindingId();
    const response = await value.load(sessionId, requireExisting);

    expect(sessionId).toMatch(/^uclaw-binding:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(value.agent.sessionStore.getSession(sessionId)).toMatchObject({ sessionId, sessionKey: SESSION_KEY, activeRunId: null });
    expect(response).toMatchObject({ configOptions: expect.any(Array), modes: { currentModeId: 'off' } });
    expect(value.calls.filter((call) => call.method === 'sessions.get')).toHaveLength(1);
    expect(value.updates.filter((update) => ['user_message_chunk', 'agent_message_chunk'].includes(update.update.sessionUpdate))).toEqual([
      { sessionId, update: { sessionUpdate: 'user_message_chunk', messageId: 'uclaw-transcript-user-0', content: { type: 'text', text: '既有用户历史' } } },
      { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '既有助手历史' } } },
    ]);
    expect(value.updates.every((update) => update.sessionId === sessionId)).toBe(true);
    expect(value.calls.some((call) => call.method === 'sessions.resolve')).toBe(requireExisting);
    expectNoResetOrNewSession(value);
  });

  it('routes the following real prompt through the original Gateway key and back to the new binding', async () => {
    const value = setup();
    const sessionId = bindingId();
    await value.load(sessionId);
    value.updates.length = 0;
    const turn = await value.start(sessionId);

    expect(value.calls.filter((call) => call.method === 'chat.send')).toEqual([{
      method: 'chat.send',
      params: expect.objectContaining({ sessionKey: SESSION_KEY, idempotencyKey: turn.runId, message: '继续既有会话' }),
      options: { timeoutMs: null },
    }]);
    expect(turn.runId).not.toBe(sessionId);
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '新轮回复')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
    expect(value.updates).toContainEqual({ sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '新轮回复' } } });
    expect(value.agent.pendingPrompts.size).toBe(0);
    expectNoResetOrNewSession(value);
  });

  it('preserves runless native approval on an ordinary unrotated logical session', async () => {
    const value = setup();
    await value.load(SESSION_KEY);
    // Reloading the same protocol identity is not rotation.
    await value.load(SESSION_KEY);
    const turn = await value.start(SESSION_KEY, '普通轮');
    value.allowPermissions();
    await bounded(value.agent.handleGatewayEvent(nativeApproval('ordinary-native-approval')));
    await expectDecision(value, 'ordinary-native-approval', 'allow-once');
    expect(value.permissions).toHaveLength(1);
    expect(value.permissions[0]).toMatchObject({ sessionId: SESSION_KEY });
    expect(value.calls.some((call) => call.method === 'exec.approval.get')).toBe(true);
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '普通轮完成')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('preserves another logical session native approval while the first session is rotated', async () => {
    const value = setup();
    await value.load(SESSION_KEY);
    await value.load(bindingId());
    await value.load(OTHER_SESSION_KEY, false, OTHER_SESSION_KEY);
    const turn = await value.start(OTHER_SESSION_KEY, '其它会话');
    value.allowPermissions();
    await bounded(value.agent.handleGatewayEvent(nativeApproval('other-native-approval', OTHER_SESSION_KEY)));
    await expectDecision(value, 'other-native-approval', 'allow-once');
    expect(value.permissions).toHaveLength(1);
    expect(value.permissions[0]).toMatchObject({ sessionId: OTHER_SESSION_KEY });
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '其它会话完成', OTHER_SESSION_KEY)));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it.each([
    { delayedAbort: false, originalBinding: true },
    { delayedAbort: true, originalBinding: true },
    { delayedAbort: false, originalBinding: false },
    { delayedAbort: true, originalBinding: false },
  ])('scopes old cancellation to its run while the replacement is active: %j', async ({ delayedAbort, originalBinding }) => {
    const value = setup();
    const oldBinding = originalBinding ? SESSION_KEY : bindingId();
    const newBinding = bindingId();
    await value.load(oldBinding);
    const oldTurn = await value.start(oldBinding, '旧轮');
    const oldController = value.agent.sessionStore.getSession(oldBinding)!.abortController!;
    await value.load(newBinding);
    const newTurn = await value.start(newBinding, '新轮');
    const newController = value.agent.sessionStore.getSession(newBinding)!.abortController!;
    if (delayedAbort) value.delayAbort();
    const cancellation = value.agent.cancel({ sessionId: oldBinding });

    expect(oldController.signal.aborted).toBe(true);
    expect(newController.signal.aborted).toBe(false);
    expect(value.calls.filter((call) => call.method === 'chat.abort')).toEqual([
      { method: 'chat.abort', params: { sessionKey: SESSION_KEY, runId: oldTurn.runId }, options: undefined },
    ]);
    expect(newTurn.isSettled()).toBe(false);
    value.releaseAbort();
    await bounded(cancellation);
    await expect(bounded(oldTurn.result)).resolves.toEqual({ stopReason: 'cancelled' });
    await bounded(value.agent.cancel({ sessionId: oldBinding }));
    expect(value.calls.filter((call) => call.method === 'chat.abort')).toHaveLength(1);
    expect(value.agent.pendingPrompts.get(newBinding)?.idempotencyKey).toBe(newTurn.runId);
    expect(newController.signal.aborted).toBe(false);
    await bounded(value.agent.handleGatewayEvent(chatEvent(newTurn.runId, 'final', '新轮继续')));
    await expect(bounded(newTurn.result)).resolves.toEqual({ stopReason: 'end_turn' });
    expectNoResetOrNewSession(value);
  });

  it.each([SESSION_KEY, 'rotated'])('drops old run text, terminal, tool and approval events from %s without mutating the new binding', async (oldId) => {
    const value = setup();
    const oldBinding = oldId === SESSION_KEY ? SESSION_KEY : bindingId();
    await value.load(oldBinding);
    const oldTurn = await value.start(oldBinding, '旧轮');
    await bounded(value.agent.cancel({ sessionId: oldBinding }));
    await expect(bounded(oldTurn.result)).resolves.toEqual({ stopReason: 'cancelled' });
    const newBinding = bindingId();
    await value.load(newBinding);
    const newTurn = await value.start(newBinding, '新轮');
    value.updates.length = 0;
    const rpcCount = value.calls.length;

    for (const state of ['delta', 'final', 'aborted', 'error']) {
      await bounded(value.agent.handleGatewayEvent(chatEvent(oldTurn.runId, state, '禁止串入的旧文本')));
    }
    for (const phase of ['start', 'update', 'result']) {
      await bounded(value.agent.handleGatewayEvent(toolEvent(oldTurn.runId, phase, 'old-tool')));
    }
    await bounded(value.agent.handleGatewayEvent(approvalEvent(oldTurn.runId, 'old-approval')));
    expect(value.updates).toEqual([]);
    expect(value.permissions).toEqual([]);
    expect(value.calls).toHaveLength(rpcCount);
    expect(value.agent.pendingPrompts.size).toBe(1);
    expect(value.agent.pendingPrompts.get(newBinding)).toMatchObject({ idempotencyKey: newTurn.runId, sessionKey: SESSION_KEY });
    expect(value.agent.sessionStore.getSession(newBinding)).toMatchObject({ activeRunId: newTurn.runId, sessionKey: SESSION_KEY });
    expect(newTurn.isSettled()).toBe(false);

    // Positive controls prove the above payloads exercise actual translator paths.
    for (const phase of ['start', 'update', 'result']) {
      await bounded(value.agent.handleGatewayEvent(toolEvent(newTurn.runId, phase, 'new-tool')));
    }
    await bounded(value.agent.handleGatewayEvent(approvalEvent(newTurn.runId, 'new-approval')));
    await vi.waitFor(() => expect(value.calls).toContainEqual({
      method: 'exec.approval.resolve', params: { id: 'new-approval', decision: 'deny' }, options: undefined,
    }), { timeout: 1000, interval: 5 });
    expect(value.permissions.map((permission) => permission.sessionId)).toEqual([newBinding]);
    expect(value.updates.filter((update) => ['tool_call', 'tool_call_update'].includes(update.update.sessionUpdate))).toHaveLength(3);
    await bounded(value.agent.handleGatewayEvent(chatEvent(newTurn.runId, 'final', '有效新文本')));
    await expect(bounded(newTurn.result)).resolves.toEqual({ stopReason: 'end_turn' });
    expect(value.updates.every((update) => update.sessionId === newBinding)).toBe(true);
    expect(JSON.stringify(value.updates)).not.toContain('禁止串入的旧文本');
    expectNoResetOrNewSession(value);
  });

  it('denies both old and new native runless approvals after rotation without prompting the new binding', async () => {
    const value = setup();
    await value.load(SESSION_KEY);
    const oldTurn = await value.start(SESSION_KEY, '旧轮');
    // This valid native Gateway envelope was produced for the old run but
    // carries neither runId nor ACP binding identity. Do not invent either.
    const oldApproval = nativeApproval('old-native-approval');
    await bounded(value.agent.cancel({ sessionId: SESSION_KEY }));
    await expect(bounded(oldTurn.result)).resolves.toEqual({ stopReason: 'cancelled' });
    const newBinding = bindingId();
    await value.load(newBinding);
    const newTurn = await value.start(newBinding, '新轮');
    await bounded(value.agent.handleGatewayEvent(oldApproval));
    await expectDecision(value, 'old-native-approval', 'deny');
    // 2026.6.10 provides no proof that this second event belongs to the new run.
    await bounded(value.agent.handleGatewayEvent(nativeApproval('new-native-approval')));
    await expectDecision(value, 'new-native-approval', 'deny');
    expect(value.permissions).toEqual([]);
    expect(value.calls.some((call) => call.method === 'exec.approval.get')).toBe(false);
    expect(newTurn.isSettled()).toBe(false);
    await bounded(value.agent.handleGatewayEvent(chatEvent(newTurn.runId, 'final', '新轮完成')));
    await expect(bounded(newTurn.result)).resolves.toEqual({ stopReason: 'end_turn' });
    // Quarantine survives completion, closing both bindings and reloading the
    // original identity: no timestamp or current-run heuristic can clear it.
    await bounded(value.agent.closeSession({ sessionId: SESSION_KEY }));
    await bounded(value.agent.closeSession({ sessionId: newBinding }));
    await value.load(SESSION_KEY);
    const laterTurn = await value.start(SESSION_KEY, '后续轮');
    await bounded(value.agent.handleGatewayEvent(nativeApproval('later-native-approval')));
    await expectDecision(value, 'later-native-approval', 'deny');
    expect(value.permissions).toEqual([]);
    await bounded(value.agent.handleGatewayEvent(chatEvent(laterTurn.runId, 'final', '后续轮完成')));
    await expect(bounded(laterTurn.result)).resolves.toEqual({ stopReason: 'end_turn' });
    expectNoResetOrNewSession(value);
  });

  it.each(['payload', 'request', 'both'] as const)('accepts a native approval with the current runId in %s after rotation', async (source) => {
    const value = setup();
    await value.load(SESSION_KEY);
    const oldTurn = await value.start(SESSION_KEY, '旧轮');
    await bounded(value.agent.cancel({ sessionId: SESSION_KEY }));
    await expect(bounded(oldTurn.result)).resolves.toEqual({ stopReason: 'cancelled' });
    const binding = bindingId();
    await value.load(binding);
    const turn = await value.start(binding, '新轮');
    value.allowPermissions();
    const runIds = {
      ...(source !== 'request' ? { payload: turn.runId } : {}),
      ...(source !== 'payload' ? { request: turn.runId } : {}),
    };
    await bounded(value.agent.handleGatewayEvent(nativeApproval('correlated-native-approval', SESSION_KEY, runIds)));
    await expectDecision(value, 'correlated-native-approval', 'allow-once');
    expect(value.permissions).toHaveLength(1);
    expect(value.permissions[0]).toMatchObject({ sessionId: binding });
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '相关新轮完成')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('denies conflicting, stale and cross-session native runIds without rewriting pending ownership', async () => {
    const value = setup();
    await value.load(SESSION_KEY);
    const oldTurn = await value.start(SESSION_KEY, '旧轮');
    await bounded(value.agent.cancel({ sessionId: SESSION_KEY }));
    await expect(bounded(oldTurn.result)).resolves.toEqual({ stopReason: 'cancelled' });
    const binding = bindingId();
    await value.load(binding);
    const turn = await value.start(binding, '新轮');
    for (const [id, event] of [
      ['conflicting', nativeApproval('conflicting', SESSION_KEY, { payload: turn.runId, request: oldTurn.runId })],
      ['stale', nativeApproval('stale', SESSION_KEY, { request: oldTurn.runId })],
      ['cross-session', nativeApproval('cross-session', OTHER_SESSION_KEY, { payload: turn.runId })],
    ] as const) {
      await bounded(value.agent.handleGatewayEvent(event));
      await expectDecision(value, id, 'deny');
    }
    expect(value.permissions).toEqual([]);
    expect(value.agent.pendingPrompts.get(binding)).toMatchObject({ idempotencyKey: turn.runId, sessionKey: SESSION_KEY });
    expect(value.agent.sessionStore.getSession(binding)?.sessionKey).toBe(SESSION_KEY);
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '新轮完成')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('preserves run-correlated agent approval after rotation', async () => {
    const value = setup();
    await value.load(SESSION_KEY);
    const binding = bindingId();
    await value.load(binding);
    const turn = await value.start(binding);
    value.allowPermissions();
    await bounded(value.agent.handleGatewayEvent(approvalEvent(turn.runId, 'correlated-agent-approval')));
    await expectDecision(value, 'correlated-agent-approval', 'allow-once');
    expect(value.permissions).toHaveLength(1);
    expect(value.permissions[0].sessionId).toBe(binding);
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '新轮完成')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('requires run identity for an explicit uclaw-binding replacement loaded by a fresh ACP agent', async () => {
    const value = setup();
    const binding = bindingId();
    await value.load(binding);
    const turn = await value.start(binding);
    await bounded(value.agent.handleGatewayEvent(nativeApproval('fresh-agent-native')));
    await expectDecision(value, 'fresh-agent-native', 'deny');
    expect(value.permissions).toEqual([]);
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '新轮完成')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('tracks rotation through the real resumeSession path and denies runless agent approvals', async () => {
    const value = setup();
    await value.load(SESSION_KEY);
    const binding = `resume:${randomUUID()}`;
    await bounded(value.agent.resumeSession({
      sessionId: binding, cwd: root, mcpServers: [], _meta: { sessionKey: SESSION_KEY },
    }));
    const turn = await value.start(binding);
    const event = approvalEvent(turn.runId, 'runless-agent-approval');
    delete event.payload.runId;
    await bounded(value.agent.handleGatewayEvent(event));
    await expectDecision(value, 'runless-agent-approval', 'deny');
    expect(value.permissions).toEqual([]);
    await bounded(value.agent.handleGatewayEvent(chatEvent(turn.runId, 'final', '新轮完成')));
    await expect(bounded(turn.result)).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('keeps the binding patch version/layout fail-closed and idempotent', async () => {
    const first = rewriteAcpBindingIsolation(installedAcpSource);
    expect(first.replacements).toBeGreaterThan(0);
    expect(rewriteAcpBindingIsolation(first.content)).toEqual({ content: first.content, replacements: 0 });
    expect(() => rewriteAcpBindingIsolation(first.content.replace('this.uclawApprovalBindingsOverflow = false;', ''))).toThrow(/partial patch|layout/u);

    const badVersion = join(root, 'bad-binding-version');
    await mkdir(join(badVersion, 'dist'), { recursive: true });
    await writeFile(join(badVersion, 'package.json'), JSON.stringify({ version: '2026.6.11' }));
    await expect(patchOpenClawAcpBindingIsolationRuntime(badVersion)).rejects.toThrow('Expected OpenClaw 2026.6.10');

    const badLayout = join(root, 'bad-binding-layout');
    await mkdir(join(badLayout, 'dist'), { recursive: true });
    await writeFile(join(badLayout, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    await writeFile(join(badLayout, 'dist', 'acp-cli-drift.js'), installedAcpSource);
    await expect(patchOpenClawAcpBindingIsolationRuntime(badLayout)).rejects.toThrow(/pinned OpenClaw 2026.6.10 ACP CLI/u);
  });

  it('restores the single ACP file when the binding patch writer fails after writing', async () => {
    const rollbackRoot = join(root, 'binding-rollback');
    await mkdir(join(rollbackRoot, 'dist'), { recursive: true });
    await writeFile(join(rollbackRoot, 'package.json'), JSON.stringify({ version: '2026.6.10' }));
    const target = join(rollbackRoot, 'dist', ACP_CHUNK);
    await writeFile(target, installedAcpSource);
    let firstWrite = true;
    await expect(patchOpenClawAcpBindingIsolationRuntime(rollbackRoot, {
      writeFile: async (...args: Parameters<typeof writeFile>) => {
        await writeFile(...args);
        if (firstWrite) {
          firstWrite = false;
          throw new Error('synthetic single-file write failure');
        }
      },
    })).rejects.toThrow('synthetic single-file write failure');
    expect(await readFile(target, 'utf8')).toBe(installedAcpSource);
  });
});
