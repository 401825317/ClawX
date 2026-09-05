import type { BrowserWindow } from 'electron';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type ContentBlock,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import { HOST_EVENT_CHANNELS } from '@shared/host-events/contract';
import { UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES } from '@shared/junfeiai-endpoints';
import type {
  AcpChatCancelPayload,
  AcpChatLoadPayload,
  AcpChatOperationResult,
  AcpChatPromptPayload,
  AcpChatRespondPermissionPayload,
  AcpPermissionRequestEnvelope,
  AcpSessionUpdateEnvelope,
  AcpTurnFailureUpdate,
} from '@shared/acp-chat/types';
import {
  normalizeAcpChatError,
  type AcpChatErrorCode,
} from '@shared/acp-chat/errors';
import { getOpenClawEmbeddedForkSpec } from '../utils/openclaw-cli';
import {
  approvePendingLocalDeviceRequests,
  type GatewayPairingRpcClient,
} from '../utils/control-ui-device-pairing';
import { logger } from '../utils/logger';
import { recordAcpTrace } from './acp-trace';
import { AcpSessionAccessRegistry, type AcpSessionAccessContext } from './acp-session-access-registry';
import {
  acpTurnImagePreferenceStore,
  type AcpTurnImagePreferenceStore,
} from './acp-turn-image-preference-store';
import {
  acpTurnVideoPreferenceStore,
  type AcpTurnVideoPreferenceStore,
} from './acp-turn-video-preference-store';
import { resolveOpenClawWorkspacePath } from '../utils/paths';
import { prepareAcpChatImage, prepareVideoReferenceImage } from '../utils/video-reference-image';
import { artifactTaskService } from './artifact-task-service';

type AcpConnection = Pick<
  ClientSideConnection,
  | 'initialize'
  | 'newSession'
  | 'loadSession'
  | 'prompt'
  | 'cancel'
  | 'setSessionConfigOption'
  | 'unstable_setSessionModel'
>;
type MainWindowLike = {
  webContents: Pick<BrowserWindow['webContents'], 'send'>;
};
type PermissionWaiter = {
  sessionKey: string;
  generation: number;
  resolve: (response: RequestPermissionResponse) => void;
};
type AcpSessionLoadBatch = {
  sessionKey: string;
  generation: number;
  sessionUpdates: Array<{
    acpSessionId: string;
    envelope: AcpSessionUpdateEnvelope;
  }>;
};
type AcpLivePromptContext = {
  sessionKey: string;
  acpSessionId: string;
  generation: number;
  accessGrant: AcpSessionAccessContext;
  clientStartedAtMs: number;
  mainReceivedAtMs: number;
  dispatchedAtMs: number | null;
  firstTextAtMs: number | null;
  toolCallObserved: boolean;
  pendingTerminalFailure: SessionNotification | null;
  /** Rejects the current prompt wait when ACP has already emitted a terminal failure. */
  terminalFailureReject: ((reason?: unknown) => void) | null;
};
type AcpChildProcess = ChildProcess & {
  stdin: NonNullable<ChildProcess['stdin']>;
  stdout: NonNullable<ChildProcess['stdout']>;
  stderr: NonNullable<ChildProcess['stderr']>;
};
type AcpPromptBuildResult = {
  blocks: ContentBlock[];
  videoReferenceImage?: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
  };
};

const ACP_GATEWAY_READY_WAIT_TIMEOUT_MS = 90_000;
const ACP_GATEWAY_READY_POLL_INTERVAL_MS = 250;
const ACP_PROMPT_RETRY_BASE_DELAY_MS = 500;
const ACP_PROMPT_RETRY_MAX_DELAY_MS = 4_000;
const ACP_PROMPT_TRANSIENT_MAX_ATTEMPTS = 3;
const ACP_PROMPT_CONTEXT_RECOVERY_MAX_ATTEMPTS = 2;
const ACP_RECOVERY_SUMMARY_MAX_CHARS = 12_000;
const ACP_RECOVERY_SUMMARY_HEADINGS = [
  '## Decisions',
  '## Open TODOs',
  '## Constraints/Rules',
  '## Pending user asks',
  '## Exact identifiers',
] as const;

function gatewayNeedsReadinessWait(status: ReturnType<NonNullable<GatewayPairingRpcClient['getStatus']>>): boolean {
  return status?.state === 'stopped'
    || status?.state === 'starting'
    || status?.state === 'reconnecting'
    || (status?.state === 'running' && status.gatewayReady === false);
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

const GATEWAY_TRANSITION_ERROR = 'Gateway is starting or reconnecting. Please wait and try again.';

function ok(generation?: number, sessionUpdates?: AcpSessionUpdateEnvelope[]): AcpChatOperationResult {
  return {
    success: true,
    ...(generation != null ? { generation } : {}),
    ...(sessionUpdates?.length ? { sessionUpdates } : {}),
  };
}

function fail(error: unknown): AcpChatOperationResult {
  const failure = normalizeAcpChatError(error);
  return {
    success: false,
    error: failure.message,
    ...(failure.code !== 'UNKNOWN' ? {
      errorCode: failure.code,
      retryable: failure.retryable,
    } : {}),
    ...(failure.httpStatus ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.upstreamCode ? { upstreamCode: failure.upstreamCode } : {}),
  };
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

function isValidSessionKey(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('agent:') && value.length > 'agent:'.length;
}

function sessionUpdateType(notification: SessionNotification): string | undefined {
  const update = (notification as { update?: { sessionUpdate?: unknown } }).update;
  return typeof update?.sessionUpdate === 'string' ? update.sessionUpdate : undefined;
}

function normalizedClientStartedAtMs(value: unknown, mainReceivedAtMs: number): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= mainReceivedAtMs
    ? value
    : mainReceivedAtMs;
}

function elapsedMs(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.round(endedAtMs - startedAtMs));
}

function isVisibleAgentText(notification: SessionNotification): boolean {
  const update = (notification as {
    update?: {
      sessionUpdate?: unknown;
      content?: { type?: unknown; text?: unknown };
    };
  }).update;
  return update?.sessionUpdate === 'agent_message_chunk'
    && update.content?.type === 'text'
    && typeof update.content.text === 'string'
    && update.content.text.trim().length > 0;
}

function artifactToolUpdate(notification: SessionNotification): {
  toolCallId?: string;
  title?: string;
  status?: string;
  rawOutput?: unknown;
} | null {
  const update = (notification as { update?: Record<string, unknown> }).update;
  if (!update || (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) return null;
  return {
    ...(typeof update.toolCallId === 'string' ? { toolCallId: update.toolCallId } : {}),
    ...(typeof update.title === 'string' ? { title: update.title } : {}),
    ...(typeof update.status === 'string' ? { status: update.status } : {}),
    ...('rawOutput' in update ? { rawOutput: update.rawOutput } : {}),
  };
}

function isTerminalPromptFailure(notification: SessionNotification): boolean {
  return sessionUpdateType(notification) === 'uclaw_turn_failure';
}

function isPromptRetryableUpstreamError(code: AcpChatErrorCode): boolean {
  return code === 'RATE_LIMIT' || code === 'SERVICE_UNAVAILABLE';
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function findStructuredRecoverySummary(value: unknown): string | null {
  const queue: unknown[] = [value];
  const seen = new Set<object>();
  let inspected = 0;

  while (queue.length > 0 && inspected < 24) {
    const candidate = queue.shift();
    const record = errorRecord(candidate);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    inspected += 1;

    for (const key of ['recoverySummary', 'fallbackSummary', 'compactionSummary', 'summary']) {
      const summary = record[key];
      if (typeof summary !== 'string') continue;
      const trimmed = summary.trim();
      if (trimmed && ACP_RECOVERY_SUMMARY_HEADINGS.every((heading) => trimmed.includes(heading))) {
        return trimmed.slice(0, ACP_RECOVERY_SUMMARY_MAX_CHARS);
      }
    }
    for (const key of ['cause', 'data', 'details', 'response', 'error']) {
      if (record[key] != null) queue.push(record[key]);
    }
  }
  return null;
}

function buildMinimalStructuredRecoverySummary(): string {
  return [
    '## Decisions',
    'Preserve the current session and continue from its recorded state.',
    '',
    '## Open TODOs',
    'Complete the latest unresolved user request.',
    '',
    '## Constraints/Rules',
    'Do not repeat completed tool actions or invent missing results.',
    '',
    '## Pending user asks',
    'Use the latest user request already recorded in this session.',
    '',
    '## Exact identifiers',
    'Recover exact identifiers from the recorded request and session state.',
  ].join('\n');
}

function buildContextRecoveryPrompt(error: unknown): ContentBlock[] {
  const summary = findStructuredRecoverySummary(error) ?? buildMinimalStructuredRecoverySummary();
  return [{
    type: 'text',
    text: [
      '[UClaw automatic context recovery]',
      'Continue the latest unresolved user request already recorded in this session.',
      'Use the structured recovery summary below and do not repeat completed tool actions.',
      '',
      summary,
    ].join('\n'),
  }];
}

function buildTransientRetryPrompt(): ContentBlock[] {
  return [{
    type: 'text',
    text: [
      '[UClaw automatic upstream retry]',
      'Continue the latest unresolved user request already recorded in this session.',
      'The previous attempt stopped before any tool call or visible assistant reply.',
    ].join('\n'),
  }];
}

function promptRecoveryError(message: string, cause: unknown): Error {
  return new Error(message, { cause });
}

function promptRetryDelay(attempt: number): number {
  return Math.min(
    ACP_PROMPT_RETRY_MAX_DELAY_MS,
    ACP_PROMPT_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 2)),
  );
}

function terminalFailureNotification(
  sessionId: string,
  userMessageId: string,
  failure: ReturnType<typeof normalizeAcpChatError>,
): SessionNotification {
  const update: AcpTurnFailureUpdate = {
    sessionUpdate: 'uclaw_turn_failure',
    userMessageId,
    errorMessage: failure.message,
    errorCode: failure.code,
    retryable: failure.retryable,
    ...(failure.httpStatus != null ? { httpStatus: failure.httpStatus } : {}),
    ...(failure.upstreamCode ? { upstreamCode: failure.upstreamCode } : {}),
  };
  return { sessionId, update } as unknown as SessionNotification;
}

function terminalFailureError(notification: SessionNotification): Record<string, unknown> {
  const update = (notification as {
    update?: {
      errorMessage?: unknown;
      errorCode?: unknown;
      httpStatus?: unknown;
      upstreamCode?: unknown;
    };
  }).update;
  return {
    message: typeof update?.errorMessage === 'string' ? update.errorMessage : 'ACP turn failed',
    ...(typeof update?.errorCode === 'string' ? { code: update.errorCode } : {}),
    ...(typeof update?.httpStatus === 'number' ? { status: update.httpStatus } : {}),
    ...(typeof update?.upstreamCode === 'string' ? { upstreamCode: update.upstreamCode } : {}),
  };
}

function promptCompletionDurations(context: AcpLivePromptContext, completedAtMs: number): Record<string, unknown> {
  return {
    clientToMainMs: elapsedMs(context.clientStartedAtMs, context.mainReceivedAtMs),
    ...(context.dispatchedAtMs != null ? {
      mainToDispatchMs: elapsedMs(context.mainReceivedAtMs, context.dispatchedAtMs),
      dispatchToCompleteMs: elapsedMs(context.dispatchedAtMs, completedAtMs),
      clientToCompleteMs: elapsedMs(context.clientStartedAtMs, completedAtMs),
    } : {}),
  };
}

// OpenClaw can emit clack/doctor diagnostics to stdout during ACP startup.
// Keep those lines away from the SDK's strict NDJSON parser.
// Upstream fixed this in https://github.com/openclaw/openclaw/pull/89997 .
function filterAcpStdoutDiagnostics(output: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = output.getReader();
      let buffered = '';

      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!value) continue;

          buffered += decoder.decode(value, { stream: true });
          const lines = buffered.split('\n');
          buffered = lines.pop() ?? '';

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;
            if (trimmedLine.startsWith('{')) {
              controller.enqueue(encoder.encode(`${line}\n`));
            } else {
              logger.info(`[acp-chat] [stdout] ${line}`);
            }
          }
        }
      } finally {
        reader.releaseLock();
        controller.close();
      }
    },
  });
}

export class AcpChatService {
  private child: AcpChildProcess | null = null;
  private connection: AcpConnection | null;
  private initializing: Promise<AcpConnection> | null = null;
  private initialized = false;
  private connectionRuntimeIdentity: string | null = null;
  private generation = 0;
  private generationSeq = 0;
  private activeSessionKey: string | null = null;
  private activeAcpSessionId: string | null = null;
  private loadedSessionKey: string | null = null;
  private loadedAcpSessionId: string | null = null;
  private historicalSessionKey: string | null = null;
  private historicalGeneration: number | null = null;
  private permissionsEnabled = false;
  private loadQueue: Promise<void> | null = null;
  private activeLoadBatch: AcpSessionLoadBatch | null = null;
  private readonly livePrompts = new Map<string, AcpLivePromptContext>();
  private permissionSeq = 0;
  private readonly permissionWaiters = new Map<string, PermissionWaiter>();
  readonly client: Client;

  constructor(
    private readonly mainWindow: MainWindowLike,
    private readonly accessRegistry: AcpSessionAccessRegistry,
    injectedConnection?: AcpConnection,
    private readonly gateway?: GatewayPairingRpcClient,
    private readonly turnImagePreferenceStore: AcpTurnImagePreferenceStore = acpTurnImagePreferenceStore,
    private readonly turnVideoPreferenceStore: AcpTurnVideoPreferenceStore = acpTurnVideoPreferenceStore,
  ) {
    this.connection = injectedConnection ?? null;
    this.client = {
      sessionUpdate: async (notification) => this.emitSessionUpdate(notification),
      requestPermission: async (request) => this.requestPermission(request),
    };
  }

  private trace(
    event: string,
    input: { direction?: string; sessionKey?: string | null; generation?: number; details?: unknown } = {},
  ): void {
    try {
      const sessionKey = input.sessionKey === null
        ? undefined
        : input.sessionKey ?? this.activeSessionKey ?? undefined;
      const generation = input.generation ?? (this.generation > 0 ? this.generation : undefined);
      recordAcpTrace({
        source: 'main',
        event,
        ...(input.direction ? { direction: input.direction } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        ...(generation != null ? { generation } : {}),
        ...(input.details !== undefined ? { details: input.details } : {}),
      });
    } catch (error) {
      logger.warn(`[acp-chat] trace failed: ${String(error)}`);
    }
  }

  async warmupConnection(): Promise<void> {
    this.trace('connection/warmup:start', { sessionKey: null });
    try {
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      await this.ensureConnection(runtimeIdentity);
      this.requireSameGatewayRuntime(runtimeIdentity);
      this.trace('connection/warmup:success', { sessionKey: null });
    } catch (error) {
      logger.warn(`[acp-chat] ACP connection warmup failed; normal session loading will retry: ${String(error)}`);
      this.trace('connection/warmup:failed', {
        sessionKey: null,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  loadSession(payload: AcpChatLoadPayload): Promise<AcpChatOperationResult> {
    const previousLoad = this.loadQueue;
    let releaseLoad!: () => void;
    const currentLoad = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    this.loadQueue = currentLoad;

    const run = async () => {
      if (previousLoad) await previousLoad;
      try {
        return await this.performLoadSession(payload);
      } finally {
        releaseLoad();
        if (this.loadQueue === currentLoad) this.loadQueue = null;
      }
    };
    return run();
  }

  private async performLoadSession(payload: AcpChatLoadPayload): Promise<AcpChatOperationResult> {
    if (!isValidSessionKey(payload.sessionKey) || !payload.workspaceRoot || !payload.cwd) {
      return fail('Invalid ACP session load payload');
    }
    const previousPermissionsEnabled = this.permissionsEnabled;
    this.permissionsEnabled = false;
    this.trace('session/load:start', {
      sessionKey: payload.sessionKey,
      details: { createIfMissing: !!payload.createIfMissing, cwdPresent: Boolean(payload.cwd) },
    });

    let previousSessionKey = this.activeSessionKey;
    let previousAcpSessionId = this.activeAcpSessionId;
    let previousLoadedSessionKey = this.loadedSessionKey;
    let previousLoadedAcpSessionId = this.loadedAcpSessionId;
    let previousHistoricalSessionKey = this.historicalSessionKey;
    let previousHistoricalGeneration = this.historicalGeneration;
    let previousGeneration = this.generation;
    let nextGeneration = this.generationSeq + 1;
    let stateAdvanced = false;
    let loadBatch: AcpSessionLoadBatch | null = null;
    let previousAccessGrant: AcpSessionAccessContext | null = null;

    try {
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      const connection = await this.ensureConnection(runtimeIdentity);
      this.requireSameGatewayRuntime(runtimeIdentity);
      const livePrompt = this.livePrompts.get(payload.sessionKey);
      if (livePrompt) {
        const preparedAccessGrant = await this.accessRegistry.prepareGrant({
          sessionKey: payload.sessionKey,
          generation: livePrompt.generation,
          workspaceRoot: payload.workspaceRoot,
          executionCwd: payload.cwd,
        });
        if (
          preparedAccessGrant.workspaceRoot !== livePrompt.accessGrant.workspaceRoot
          || preparedAccessGrant.executionCwd !== livePrompt.accessGrant.executionCwd
        ) {
          throw new Error('Cannot change workspace while an ACP prompt is active');
        }
        this.generation = livePrompt.generation;
        this.activeSessionKey = livePrompt.sessionKey;
        this.activeAcpSessionId = livePrompt.acpSessionId;
        this.loadedSessionKey = livePrompt.sessionKey;
        this.loadedAcpSessionId = livePrompt.acpSessionId;
        this.historicalSessionKey = null;
        this.historicalGeneration = null;
        this.permissionsEnabled = true;
        this.accessRegistry.commitGrant(livePrompt.accessGrant);
        this.trace('session/load:resumed-active-prompt', {
          sessionKey: livePrompt.sessionKey,
          generation: livePrompt.generation,
          details: { acpSessionId: livePrompt.acpSessionId },
        });
        return {
          success: true,
          generation: livePrompt.generation,
          resumedActivePrompt: true,
        };
      }
      previousSessionKey = this.activeSessionKey;
      previousAcpSessionId = this.activeAcpSessionId;
      previousLoadedSessionKey = this.loadedSessionKey;
      previousLoadedAcpSessionId = this.loadedAcpSessionId;
      previousHistoricalSessionKey = this.historicalSessionKey;
      previousHistoricalGeneration = this.historicalGeneration;
      previousGeneration = this.generation;
      nextGeneration = this.generationSeq + 1;
      previousAccessGrant = this.accessRegistry.snapshot();
      const preparedAccessGrant = await this.accessRegistry.prepareGrant({
        sessionKey: payload.sessionKey,
        generation: nextGeneration,
        workspaceRoot: payload.workspaceRoot,
        executionCwd: payload.cwd,
      });
      this.requireSameGatewayRuntime(runtimeIdentity);

      this.generation = nextGeneration;
      this.activeSessionKey = payload.sessionKey;
      this.activeAcpSessionId = payload.createIfMissing ? null : payload.sessionKey;
      this.loadedSessionKey = null;
      this.loadedAcpSessionId = null;
      this.historicalSessionKey = payload.createIfMissing ? null : payload.sessionKey;
      this.historicalGeneration = payload.createIfMissing ? null : nextGeneration;
      loadBatch = {
        sessionKey: payload.sessionKey,
        generation: nextGeneration,
        sessionUpdates: [],
      };
      this.activeLoadBatch = loadBatch;
      stateAdvanced = true;
      if (previousSessionKey && !this.livePrompts.has(previousSessionKey)) {
        this.resolvePermissionWaitersForSession(previousSessionKey, cancelledPermissionResponse());
      }

      let acpSessionId = payload.sessionKey;
      if (payload.createIfMissing) {
        const created = await connection.newSession({
          cwd: preparedAccessGrant.executionCwd,
          mcpServers: [],
          _meta: { sessionKey: payload.sessionKey, prefixCwd: true },
        });
        acpSessionId = created.sessionId;
      } else {
        await connection.loadSession({
          sessionId: payload.sessionKey,
          cwd: preparedAccessGrant.executionCwd,
          mcpServers: [],
        });
      }
      this.requireSameGatewayRuntime(runtimeIdentity);
      this.activeAcpSessionId = acpSessionId;
      this.loadedSessionKey = payload.sessionKey;
      this.loadedAcpSessionId = acpSessionId;
      this.generationSeq = nextGeneration;
      this.accessRegistry.commitGrant(preparedAccessGrant);
      this.trace('session/load:success', {
        sessionKey: payload.sessionKey,
        generation: nextGeneration,
        details: { createIfMissing: !!payload.createIfMissing, acpSessionId },
      });
      if (this.activeLoadBatch === loadBatch) this.activeLoadBatch = null;
      return ok(
        nextGeneration,
        loadBatch.sessionUpdates
          .filter((entry) => entry.acpSessionId === acpSessionId)
          .map((entry) => entry.envelope),
      );
    } catch (error) {
      if (this.activeLoadBatch === loadBatch) this.activeLoadBatch = null;
      this.resolvePermissionWaitersForSession(payload.sessionKey, cancelledPermissionResponse());
      if (
        stateAdvanced
        && this.activeSessionKey === payload.sessionKey
        && this.generation === nextGeneration
      ) {
        this.generation = previousGeneration;
        this.activeSessionKey = previousSessionKey;
        this.activeAcpSessionId = previousAcpSessionId;
        this.loadedSessionKey = previousLoadedSessionKey;
        this.loadedAcpSessionId = previousLoadedAcpSessionId;
        this.historicalSessionKey = previousHistoricalSessionKey;
        this.historicalGeneration = previousHistoricalGeneration;
        this.permissionsEnabled = previousPermissionsEnabled;
        this.accessRegistry.restore(previousAccessGrant);
      }
      logger.error(`[acp-chat] loadSession failed: ${String(error)}`);
      this.trace('session/load:failed', {
        sessionKey: payload.sessionKey,
        generation: previousGeneration,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      return fail(error);
    }
  }

  async sendPrompt(payload: AcpChatPromptPayload): Promise<AcpChatOperationResult> {
    const mainReceivedAtMs = Date.now();
    const phaseDurations: Record<string, number> = {};
    let connectionPromptWaitMs = 0;
    if (!isValidSessionKey(payload.sessionKey) || !payload.cwd) return fail('Invalid ACP prompt payload');
    if (!this.activeSessionKey) return fail('No active ACP session');
    if (payload.sessionKey !== this.activeSessionKey) return fail('ACP prompt session is not active');
    if (this.loadedSessionKey !== payload.sessionKey || !this.loadedAcpSessionId) return fail('ACP session is not loaded');
    if (this.livePrompts.has(payload.sessionKey)) return fail('ACP prompt is already active');
    const generation = this.generation;
    const acpSessionId = this.loadedAcpSessionId;
    const accessGrant = this.accessRegistry.get(payload.sessionKey, generation);
    if (!accessGrant) return fail('ACP session access grant is not active');
    const clientStartedAtMs = normalizedClientStartedAtMs(payload.clientStartedAtMs, mainReceivedAtMs);
    const promptContext: AcpLivePromptContext = {
      sessionKey: payload.sessionKey,
      acpSessionId,
      generation,
      accessGrant,
      clientStartedAtMs,
      mainReceivedAtMs,
      dispatchedAtMs: null,
      firstTextAtMs: null,
      toolCallObserved: false,
      pendingTerminalFailure: null,
      terminalFailureReject: null,
    };
    this.livePrompts.set(payload.sessionKey, promptContext);
    const userMessageId = payload.messageId ?? randomUUID();
    let imagePreferenceId: string | undefined;
    let videoPreferenceId: string | undefined;
    try {
      let phaseStartedAtMs = Date.now();
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      phaseDurations.readyGatewayMs = Date.now() - phaseStartedAtMs;
      const promptCwd = payload.cwd === accessGrant.executionCwd
        ? payload.cwd
        : await import('node:fs/promises')
          .then((fsP) => fsP.realpath(resolveOpenClawWorkspacePath(payload.cwd)))
          .catch(() => null);
      if (promptCwd !== accessGrant.executionCwd) {
        return fail('ACP prompt cwd does not match the registered execution cwd');
      }
      this.trace('session/prompt:start', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          messageLength: payload.message?.length ?? 0,
          mediaCount: payload.media?.length ?? 0,
          clientToMainMs: elapsedMs(clientStartedAtMs, mainReceivedAtMs),
        },
      });
      phaseStartedAtMs = Date.now();
      const connection = await this.ensureConnection(runtimeIdentity);
      phaseDurations.ensureConnectionMs = Date.now() - phaseStartedAtMs;
      this.requireSameGatewayRuntime(runtimeIdentity);
      phaseStartedAtMs = Date.now();
      const promptBuild = await this.buildPromptBlocks(payload);
      phaseDurations.promptBuildMs = Date.now() - phaseStartedAtMs;
      const prompt = promptBuild.blocks;
      const artifactPolicy = artifactTaskService.getPolicy(payload.sessionKey);
      if (artifactPolicy) {
        phaseStartedAtMs = Date.now();
        const controls = [
          connection.setSessionConfigOption({
            sessionId: acpSessionId,
            configId: 'thought_level',
            value: artifactPolicy.thinkingLevel,
          }),
          connection.setSessionConfigOption({
            sessionId: acpSessionId,
            configId: 'fast_mode',
            value: artifactPolicy.fastMode ? 'on' : 'off',
          }),
          connection.unstable_setSessionModel({
            sessionId: acpSessionId,
            modelId: artifactPolicy.modelAlias,
          }),
        ];
        const results = await Promise.allSettled(controls);
        const rejected = results.filter((result) => result.status === 'rejected');
        phaseDurations.sessionControlsMs = Date.now() - phaseStartedAtMs;
        if (rejected.length > 0) {
          logger.warn(`[artifact-task] ${rejected.length} ACP session control(s) were rejected; runtime plugin policy remains active`);
        }
      }
      const message = payload.message?.trim();
      phaseStartedAtMs = Date.now();
      if (payload.imageOptions && message) {
        const preference = await this.turnImagePreferenceStore.enqueue({
          sessionKey: payload.sessionKey,
          message,
          imageOptions: payload.imageOptions,
        }).catch((error) => {
          // Composer preferences must never prevent a normal ACP prompt from running.
          logger.warn(`[acp-chat] Could not queue image generation preferences: ${String(error)}`);
          return null;
        });
        imagePreferenceId = preference?.id;
      }
      if (payload.videoOptions && message) {
        const preference = await this.turnVideoPreferenceStore.enqueue({
          sessionKey: payload.sessionKey,
          message,
          videoOptions: payload.videoOptions,
          ...(promptBuild.videoReferenceImage
            ? { referenceImage: promptBuild.videoReferenceImage }
            : {}),
        }).catch((error) => {
          // Composer preferences must never prevent a normal ACP prompt from running.
          logger.warn(`[acp-chat] Could not queue video generation preferences: ${String(error)}`);
          return null;
        });
        videoPreferenceId = preference?.id;
      }
      phaseDurations.preferenceEnqueueMs = Date.now() - phaseStartedAtMs;
      if (this.historicalSessionKey === payload.sessionKey) {
        this.historicalSessionKey = null;
        this.historicalGeneration = null;
      }
      this.permissionsEnabled = true;
      this.requireSameGatewayRuntime(runtimeIdentity);
      artifactTaskService.markDispatched(payload.sessionKey);
      promptContext.dispatchedAtMs = Date.now();
      this.trace('session/prompt:dispatched', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          requestId: userMessageId,
          clientToMainMs: elapsedMs(clientStartedAtMs, mainReceivedAtMs),
          mainToDispatchMs: elapsedMs(mainReceivedAtMs, promptContext.dispatchedAtMs),
          clientToDispatchMs: elapsedMs(clientStartedAtMs, promptContext.dispatchedAtMs),
          preDispatchPhases: phaseDurations,
        },
      });
      const originalMessageId = userMessageId;
      let attempt = 1;
      let attemptPrompt = prompt;
      let attemptMessageId = originalMessageId;
      let contextRecoveryAttempted = false;
      while (true) {
        promptContext.pendingTerminalFailure = null;
        let rejectTerminalFailure: ((reason?: unknown) => void) | null = null;
        const terminalFailureWait = new Promise<never>((_, reject) => {
          rejectTerminalFailure = reject;
        });
        promptContext.terminalFailureReject = rejectTerminalFailure;
        const promptWaiter = promptContext.terminalFailureReject;
        const promptAttemptStartedAtMs = Date.now();
        try {
          await Promise.race([
            connection.prompt({
              sessionId: acpSessionId,
              prompt: attemptPrompt,
              messageId: attemptMessageId,
              _meta: { sessionKey: payload.sessionKey, prefixCwd: true },
            }),
            terminalFailureWait,
          ]);
          connectionPromptWaitMs += Date.now() - promptAttemptStartedAtMs;
          if (attempt > 1) {
            this.trace('session/prompt:recovered', {
              sessionKey: payload.sessionKey,
              generation,
              details: { requestId: userMessageId, attempt, contextRecoveryAttempted },
            });
          }
          promptContext.pendingTerminalFailure = null;
          break;
        } catch (attemptError) {
          connectionPromptWaitMs += Date.now() - promptAttemptStartedAtMs;
          this.requireSameGatewayRuntime(runtimeIdentity);
          const failure = normalizeAcpChatError(attemptError);
          const replaySafe = !promptContext.toolCallObserved && promptContext.firstTextAtMs == null;
          const isContextRecovery = failure.code === 'CONTEXT_OVERFLOW';
          const isTransientUpstream = isPromptRetryableUpstreamError(failure.code);
          const maxAttempts = isContextRecovery
            ? ACP_PROMPT_CONTEXT_RECOVERY_MAX_ATTEMPTS
            : ACP_PROMPT_TRANSIENT_MAX_ATTEMPTS;

          if (!replaySafe && (isContextRecovery || isTransientUpstream)) {
            throw promptRecoveryError(
              promptContext.toolCallObserved
                ? 'The upstream request failed after a tool started. UClaw did not replay the turn to avoid repeating side effects.'
                : 'The upstream request failed after assistant output started. UClaw did not replay the turn to avoid duplicate output.',
              attemptError,
            );
          }

          if (isContextRecovery && !contextRecoveryAttempted && attempt < maxAttempts) {
            contextRecoveryAttempted = true;
            attempt += 1;
            attemptPrompt = buildContextRecoveryPrompt(attemptError);
            attemptMessageId = `${originalMessageId}:context-recovery:${attempt}`;
            const delayMs = ACP_PROMPT_RETRY_BASE_DELAY_MS;
            this.trace('session/prompt:retry', {
              sessionKey: payload.sessionKey,
              generation,
              details: { requestId: userMessageId, attempt, delayMs, reason: failure.code, recovery: 'structured-summary' },
            });
            logger.warn(`[acp-chat] Context recovery retry ${attempt}/${maxAttempts} scheduled after ${delayMs}ms`);
            await waitForDelay(delayMs);
            this.requireSameGatewayRuntime(runtimeIdentity);
            continue;
          }

          if (isTransientUpstream && attempt < maxAttempts) {
            attempt += 1;
            attemptPrompt = buildTransientRetryPrompt();
            attemptMessageId = `${originalMessageId}:upstream-retry:${attempt}`;
            const delayMs = promptRetryDelay(attempt);
            this.trace('session/prompt:retry', {
              sessionKey: payload.sessionKey,
              generation,
              details: { requestId: userMessageId, attempt, delayMs, reason: failure.code, recovery: 'continue-recorded-request' },
            });
            logger.warn(`[acp-chat] Replay-safe upstream retry ${attempt}/${maxAttempts} scheduled after ${delayMs}ms`);
            await waitForDelay(delayMs);
            this.requireSameGatewayRuntime(runtimeIdentity);
            continue;
          }

          if (isContextRecovery && contextRecoveryAttempted) {
            throw promptRecoveryError(
              'Automatic context recovery failed after one replay-safe attempt. The current session and original request were preserved.',
              attemptError,
            );
          }
          if (isTransientUpstream && attempt >= maxAttempts) {
            throw promptRecoveryError(
              `The upstream service remained unavailable after ${attempt} replay-safe attempts. Please try again later.`,
              attemptError,
            );
          }
          throw attemptError;
        } finally {
          if (promptContext.terminalFailureReject === promptWaiter) {
            promptContext.terminalFailureReject = null;
          }
        }
      }
      this.requireSameGatewayRuntime(runtimeIdentity);
      const completedAtMs = Date.now();
      this.trace('session/prompt:complete', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          requestId: userMessageId,
          outcome: 'success',
          firstTextObserved: promptContext.firstTextAtMs != null,
          connectionPromptWaitMs,
          preDispatchPhases: phaseDurations,
          ...promptCompletionDurations(promptContext, completedAtMs),
          ...(promptContext.firstTextAtMs != null ? {
            firstTextToCompleteMs: elapsedMs(promptContext.firstTextAtMs, completedAtMs),
          } : {}),
        },
      });
      this.trace('session/prompt:success', {
        sessionKey: payload.sessionKey,
        generation,
        details: { requestId: userMessageId, blockCount: prompt.length, acpSessionId },
      });
      artifactTaskService.complete(payload.sessionKey, 'success');
      return ok(generation);
    } catch (error) {
      const failure = normalizeAcpChatError(error);
      const terminalFailure = promptContext.pendingTerminalFailure
        ?? terminalFailureNotification(acpSessionId, userMessageId, failure);
      promptContext.pendingTerminalFailure = null;
      if (terminalFailure.update && typeof (terminalFailure.update as { userMessageId?: unknown }).userMessageId === 'string') {
        this.emitSessionUpdate(terminalFailure, true);
      }
      if (imagePreferenceId) {
        await this.turnImagePreferenceStore.discard(imagePreferenceId).catch((discardError) => {
          logger.warn(`[acp-chat] Could not discard image generation preferences: ${String(discardError)}`);
        });
      }
      if (videoPreferenceId) {
        await this.turnVideoPreferenceStore.discard(videoPreferenceId).catch((discardError) => {
          logger.warn(`[acp-chat] Could not discard video generation preferences: ${String(discardError)}`);
        });
      }
      logger.error(`[acp-chat] prompt failed: ${String(error)}`);
      const completedAtMs = Date.now();
      this.trace('session/prompt:complete', {
        sessionKey: payload.sessionKey,
        generation,
        details: {
          requestId: userMessageId,
          outcome: 'failure',
          firstTextObserved: promptContext.firstTextAtMs != null,
          ...promptCompletionDurations(promptContext, completedAtMs),
          ...(promptContext.firstTextAtMs != null ? {
            firstTextToCompleteMs: elapsedMs(promptContext.firstTextAtMs, completedAtMs),
          } : {}),
        },
      });
      this.trace('session/prompt:failed', {
        sessionKey: payload.sessionKey,
        details: { requestId: userMessageId, error: error instanceof Error ? error.message : String(error) },
      });
      artifactTaskService.reportFailure(payload.sessionKey, error);
      artifactTaskService.complete(payload.sessionKey, 'failure');
      return fail(error);
    } finally {
      if (this.livePrompts.get(payload.sessionKey) === promptContext) {
        this.livePrompts.delete(payload.sessionKey);
        this.resolvePermissionWaitersForSession(payload.sessionKey, cancelledPermissionResponse());
      }
      this.permissionsEnabled = this.activeSessionKey != null && this.livePrompts.has(this.activeSessionKey);
    }
  }

  async cancelSession(payload: AcpChatCancelPayload): Promise<AcpChatOperationResult> {
    if (!isValidSessionKey(payload.sessionKey)) return fail('Invalid ACP cancel payload');
    if (payload.sessionKey !== this.activeSessionKey || !this.loadedAcpSessionId) return fail('ACP session is not loaded');

    try {
      this.trace('session/cancel:start', { sessionKey: payload.sessionKey });
      const runtimeIdentity = await this.requireReadyGatewayRuntime();
      const connection = await this.ensureConnection(runtimeIdentity);
      this.requireSameGatewayRuntime(runtimeIdentity);
      await connection.cancel({ sessionId: this.loadedAcpSessionId });
      this.permissionsEnabled = false;
      this.resolvePermissionWaitersForSession(payload.sessionKey, cancelledPermissionResponse());
      this.trace('session/cancel:success', { sessionKey: payload.sessionKey });
      return ok(this.generation);
    } catch (error) {
      logger.error(`[acp-chat] cancel failed: ${String(error)}`);
      this.trace('session/cancel:failed', {
        sessionKey: payload.sessionKey,
        details: { error: error instanceof Error ? error.message : String(error) },
      });
      return fail(error);
    }
  }

  async respondPermission(payload: AcpChatRespondPermissionPayload): Promise<AcpChatOperationResult> {
    const waiter = this.permissionWaiters.get(payload.requestId);
    if (!waiter || waiter.sessionKey !== payload.sessionKey) return fail('Unknown ACP permission request');

    waiter.resolve({ outcome: payload.outcome });
    this.permissionWaiters.delete(payload.requestId);
    this.trace('permission/responded', {
      sessionKey: payload.sessionKey,
      details: { requestId: payload.requestId, outcome: payload.outcome.outcome },
    });
    return ok(waiter.generation);
  }

  private getReadyGatewayRuntimeIdentity(): string | null {
    if (!this.gateway) return null;
    const status = this.gateway.getStatus?.();
    // `gatewayReady` was added after the original running-state contract. An
    // older Gateway (or a compatible host bridge) may omit it; only an
    // explicit false means that the runtime is still transitioning. The
    // GatewayManager in current builds sets false while booting and true once
    // its readiness event/probe succeeds, so this preserves the strict path
    // without deadlocking legacy status payloads.
    if (!status || status.state !== 'running' || status.gatewayReady === false) {
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }
    return `${status.pid ?? 'none'}:${status.connectedAt ?? 'none'}:${status.port}`;
  }

  private async requireReadyGatewayRuntime(): Promise<string | null> {
    await this.waitForGatewayReady();
    return this.getReadyGatewayRuntimeIdentity();
  }

  private requireSameGatewayRuntime(expectedIdentity: string | null): void {
    const currentIdentity = this.getReadyGatewayRuntimeIdentity();
    if (currentIdentity !== expectedIdentity) {
      this.invalidateConnectionForGatewayTransition();
      throw new Error(GATEWAY_TRANSITION_ERROR);
    }
  }

  private invalidateConnectionForGatewayTransition(): void {
    const child = this.child;
    if (child) {
      try {
        child.kill();
      } catch {
        // The child may already be exiting after its Gateway disappeared.
      }
      this.dropConnectionForChild(child);
      return;
    }
    this.initialized = false;
    this.initializing = null;
    this.connection = null;
    this.connectionRuntimeIdentity = null;
  }

  private async ensureConnection(runtimeIdentity: string | null): Promise<AcpConnection> {
    if (this.connection && this.initialized) {
      if (this.connectionRuntimeIdentity === runtimeIdentity) return this.connection;
      this.invalidateConnectionForGatewayTransition();
    }
    if (this.initializing) return this.initializing;

    this.initializing = this.initializeConnection(runtimeIdentity);
    try {
      return await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  private async initializeConnection(runtimeIdentity: string | null): Promise<AcpConnection> {
    this.requireSameGatewayRuntime(runtimeIdentity);
    await this.approveLocalDeviceRequests();

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const connection = await this.initializeConnectionOnce(attempt);
        this.requireSameGatewayRuntime(runtimeIdentity);
        this.connectionRuntimeIdentity = runtimeIdentity;
        return connection;
      } catch (error) {
        if (attempt >= 2) throw error;
        logger.info(
          `[acp-chat] ACP connect failed on attempt ${attempt}; auto-approving local device requests and retrying: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await this.approveLocalDeviceRequests();
      }
    }

    throw new Error('ACP connection failed');
  }

  private async initializeConnectionOnce(attempt: number): Promise<AcpConnection> {
    if (!this.connection) this.connection = await this.spawnConnection();
    const connection = this.connection;
    const child = this.child;

    this.trace('connection/initialize:start', { details: { attempt } });
    const initOutcome = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }).then((result) => ({ kind: 'initialized' as const, result })),
      this.waitForChildExit(child).then((exitCode) => ({ kind: 'exited' as const, exitCode })),
    ]);

    if (initOutcome.kind === 'exited') {
      if (child) this.dropConnectionForChild(child);
      throw new Error(`ACP process exited with code ${String(initOutcome.exitCode)}`);
    }

    const result = initOutcome.result;
    if (this.connection !== connection) {
      throw new Error('ACP connection closed during initialization');
    }
    if (!result.agentCapabilities?.loadSession) {
      this.trace('connection/initialize:failed', { details: { reason: 'missing-loadSession-capability' } });
      throw new Error('ACP agent does not support session/load');
    }
    this.initialized = true;
    this.trace('connection/initialize:success', { details: { protocolVersion: PROTOCOL_VERSION, attempt } });

    return connection;
  }

  private async approveLocalDeviceRequests(): Promise<void> {
    if (!this.gateway) return;
    try {
      await approvePendingLocalDeviceRequests(this.gateway);
    } catch (error) {
      logger.debug(`[acp-chat] Local device auto-approve skipped: ${String(error)}`);
    }
  }

  private async waitForGatewayReady(): Promise<void> {
    if (!this.gateway?.getStatus) return;

    const initialStatus = this.gateway.getStatus();
    if (!gatewayNeedsReadinessWait(initialStatus)) return;

    const startedAt = Date.now();
    this.trace('connection/wait-for-gateway-ready:start', {
      details: {
        state: initialStatus?.state,
        gatewayReady: initialStatus?.gatewayReady,
      },
    });

    while (Date.now() - startedAt < ACP_GATEWAY_READY_WAIT_TIMEOUT_MS) {
      await waitForDelay(ACP_GATEWAY_READY_POLL_INTERVAL_MS);
      const status = this.gateway.getStatus();
      if (gatewayNeedsReadinessWait(status)) continue;

      this.trace('connection/wait-for-gateway-ready:success', {
        details: {
          waitedMs: Date.now() - startedAt,
          state: status?.state,
          gatewayReady: status?.gatewayReady,
        },
      });
      return;
    }

    const status = this.gateway.getStatus();
    this.trace('connection/wait-for-gateway-ready:timeout', {
      details: {
        waitedMs: Date.now() - startedAt,
        state: status?.state,
        gatewayReady: status?.gatewayReady,
      },
    });
  }

  private waitForChildExit(child: AcpChildProcess | null): Promise<number | null> {
    // An injected connection has no child process to supervise. It must not win
    // the initialization race as a synthetic process-exit event.
    if (!child) return new Promise<number | null>(() => {});
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    if (child.signalCode) return Promise.resolve(child.exitCode);

    return new Promise((resolve) => {
      const onExit = (code: number | null) => {
        child.off('exit', onExit);
        resolve(code);
      };
      child.on('exit', onExit);
    });
  }

  private async spawnConnection(): Promise<ClientSideConnection> {
    const gatewayPort = this.gateway?.getStatus?.().port;
    const gatewayUrl = typeof gatewayPort === 'number'
      && Number.isInteger(gatewayPort)
      && gatewayPort > 0
      && gatewayPort <= 65_535
      ? `ws://127.0.0.1:${gatewayPort}`
      : undefined;
    const spec = getOpenClawEmbeddedForkSpec(['acp']);
    const gatewayToken = await this.gateway?.getGatewayToken?.();
    if (gatewayUrl || gatewayToken) {
      spec.options.env = {
        ...spec.options.env,
        ...(gatewayUrl ? { OPENCLAW_GATEWAY_URL: gatewayUrl } : {}),
        ...(gatewayToken ? { OPENCLAW_GATEWAY_TOKEN: gatewayToken } : {}),
      };
    }
    const forked = fork(spec.modulePath, spec.args, spec.options);
    if (!forked.stdin || !forked.stdout || !forked.stderr) {
      forked.kill();
      throw new Error('ACP process did not expose stdio pipes');
    }
    this.child = forked as AcpChildProcess;

    const child = this.child;

    child.stderr.on('data', (chunk) => {
      const message = String(chunk).trimEnd();
      if (message) logger.info(`[acp-chat] ${message}`);
    });
    child.on('error', (error) => {
      logger.error(`[acp-chat] ACP process error: ${String(error)}`);
      this.dropConnectionForChild(child);
    });
    child.on('exit', (code) => {
      logger.info(`[acp-chat] ACP process exited with code ${String(code)}`);
      this.dropConnectionForChild(child);
    });

    const input = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const output = filterAcpStdoutDiagnostics(Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>);
    const stream = ndJsonStream(input, output);
    return new ClientSideConnection(() => this.client, stream);
  }

  private dropConnectionForChild(child: AcpChildProcess): void {
    if (this.child !== child) return;
    this.trace('connection/dropped', { details: { pendingPermissionCount: this.permissionWaiters.size } });
    this.resolveAllPermissionWaiters(cancelledPermissionResponse());
    this.initialized = false;
    this.initializing = null;
    this.connection = null;
    this.connectionRuntimeIdentity = null;
    this.child = null;
    this.loadedSessionKey = null;
    this.loadedAcpSessionId = null;
    this.historicalSessionKey = null;
    this.historicalGeneration = null;
    this.permissionsEnabled = false;
    this.livePrompts.clear();
  }

  private emitSessionUpdate(notification: SessionNotification, forwardTerminalFailure = false): void {
    const acpSessionId = notification.sessionId;
    const livePrompt = [...this.livePrompts.values()].find((context) => context.acpSessionId === acpSessionId);
    const sessionKey = livePrompt?.sessionKey ?? this.activeSessionKey;
    const generation = livePrompt?.generation ?? this.generation;
    const updateType = sessionUpdateType(notification);
    this.trace('session-update:received', {
      direction: 'upstream',
      sessionKey: sessionKey ?? null,
      details: { acpSessionId, updateType },
    });
    if (!sessionKey) {
      this.trace('session-update:ignored', {
        direction: 'upstream',
        sessionKey: null,
        details: { reason: 'no-active-session', acpSessionId, updateType },
      });
      return;
    }
    if (!livePrompt && this.activeAcpSessionId && acpSessionId !== this.activeAcpSessionId) {
      this.trace('session-update:ignored', {
        direction: 'upstream',
        sessionKey,
        details: { reason: 'session-mismatch', acpSessionId, activeAcpSessionId: this.activeAcpSessionId, updateType },
      });
      return;
    }
    if (livePrompt && isTerminalPromptFailure(notification) && !forwardTerminalFailure) {
      livePrompt.pendingTerminalFailure = notification;
      livePrompt.terminalFailureReject?.(terminalFailureError(notification));
      this.trace('session-update:buffered', {
        direction: 'downstream',
        sessionKey,
        details: { acpSessionId, updateType, reason: 'retryable-terminal-failure' },
      });
      return;
    }

    const envelope: AcpSessionUpdateEnvelope = {
      sessionKey,
      generation,
      ...(!livePrompt && this.historicalSessionKey === sessionKey && this.historicalGeneration === generation
        ? { historical: true }
        : {}),
      notification: { ...notification, sessionId: sessionKey },
    };
    const loadBatch = this.activeLoadBatch;
    if (loadBatch?.sessionKey === sessionKey && loadBatch.generation === generation) {
      loadBatch.sessionUpdates.push({ acpSessionId, envelope });
      this.trace('session-update:buffered', {
        direction: 'downstream',
        sessionKey,
        details: { acpSessionId, updateType, historical: !!envelope.historical },
      });
      return;
    }
    this.mainWindow.webContents.send(HOST_EVENT_CHANNELS.chat.acpSessionUpdate, envelope);
    const toolUpdate = artifactToolUpdate(notification);
    if (livePrompt && toolUpdate) {
      livePrompt.toolCallObserved = true;
      artifactTaskService.recordTool(sessionKey, toolUpdate);
    }
    if (
      livePrompt
      && livePrompt.dispatchedAtMs != null
      && livePrompt.firstTextAtMs == null
      && isVisibleAgentText(notification)
    ) {
      const firstTextAtMs = Date.now();
      livePrompt.firstTextAtMs = firstTextAtMs;
      artifactTaskService.markFirstText(sessionKey);
      this.trace('session/prompt:first-text', {
        direction: 'downstream',
        sessionKey,
        generation,
        details: {
          clientToMainMs: elapsedMs(livePrompt.clientStartedAtMs, livePrompt.mainReceivedAtMs),
          mainToDispatchMs: elapsedMs(livePrompt.mainReceivedAtMs, livePrompt.dispatchedAtMs),
          dispatchToFirstTextMs: elapsedMs(livePrompt.dispatchedAtMs, firstTextAtMs),
          clientToFirstTextMs: elapsedMs(livePrompt.clientStartedAtMs, firstTextAtMs),
        },
      });
    }
    this.trace('session-update:forwarded', {
      direction: 'downstream',
      sessionKey,
      details: { acpSessionId, updateType, historical: !!envelope.historical },
    });
  }

  private requestPermission(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const acpSessionId = request.sessionId;
    const livePrompt = [...this.livePrompts.values()].find((context) => context.acpSessionId === acpSessionId);
    const sessionKey = livePrompt?.sessionKey ?? this.activeSessionKey;
    const generation = livePrompt?.generation ?? this.generation;
    if (!livePrompt && !this.permissionsEnabled) {
      this.trace('permission:ignored', {
        direction: 'upstream',
        sessionKey: sessionKey ?? null,
        details: { reason: 'no-active-prompt', acpSessionId },
      });
      return Promise.resolve(cancelledPermissionResponse());
    }
    if (this.activeLoadBatch && !livePrompt) {
      this.trace('permission:ignored', {
        direction: 'upstream',
        sessionKey: sessionKey ?? null,
        details: { reason: 'session-loading', acpSessionId },
      });
      return Promise.resolve(cancelledPermissionResponse());
    }
    if (!sessionKey || (!livePrompt && this.activeAcpSessionId && acpSessionId !== this.activeAcpSessionId)) {
      this.trace('permission:ignored', {
        direction: 'upstream',
        sessionKey: sessionKey ?? null,
        details: {
          reason: !sessionKey ? 'no-active-session' : 'session-mismatch',
          acpSessionId,
          activeAcpSessionId: this.activeAcpSessionId,
        },
      });
      return Promise.resolve(cancelledPermissionResponse());
    }

    const requestId = `acp-permission-${Date.now()}-${this.permissionSeq += 1}`;
    const envelope: AcpPermissionRequestEnvelope = {
      sessionKey,
      generation,
      requestId,
      request: { ...request, sessionId: sessionKey },
    };
    this.mainWindow.webContents.send(HOST_EVENT_CHANNELS.chat.acpPermissionRequest, envelope);
    this.trace('permission:forwarded', {
      direction: 'downstream',
      sessionKey,
      details: { requestId, acpSessionId, optionCount: request.options.length },
    });

    return new Promise((resolve) => {
      this.permissionWaiters.set(requestId, { sessionKey, generation, resolve });
    });
  }

  private resolvePermissionWaitersForSession(sessionKey: string, response: RequestPermissionResponse): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      if (waiter.sessionKey !== sessionKey) continue;
      waiter.resolve(response);
      this.permissionWaiters.delete(requestId);
    }
  }

  private resolveAllPermissionWaiters(response: RequestPermissionResponse): void {
    for (const [requestId, waiter] of this.permissionWaiters) {
      waiter.resolve(response);
      this.permissionWaiters.delete(requestId);
    }
  }

  private async buildPromptBlocks(payload: AcpChatPromptPayload): Promise<AcpPromptBuildResult> {
    const blocks: ContentBlock[] = [];
    let videoReferenceImage: AcpPromptBuildResult['videoReferenceImage'];
    const text = payload.message?.trim();
    if (text) blocks.push({ type: 'text', text });

    const media = payload.media ?? [];
    if (media.length > 0) {
      const imageCount = media.filter((item) => (item.mimeType || '').startsWith('image/')).length;
      if (payload.videoOptions && imageCount > 1) {
        throw new Error('Video generation supports at most one reference image.');
      }

      for (const item of media) {
        const mimeType = item.mimeType || 'application/octet-stream';
        if (mimeType.startsWith('image/')) {
          const prepared = payload.videoOptions
            ? await prepareVideoReferenceImage({
              filePath: item.filePath,
              fileName: item.fileName,
              mimeType,
              maxBytes: UCLAW_VIDEO_GENERATION_MAX_INPUT_IMAGE_BYTES,
            })
            : await prepareAcpChatImage({
              filePath: item.filePath,
              fileName: item.fileName,
              mimeType,
            });
          const data = prepared.buffer.toString('base64');
          if (prepared.compressed) {
            logger.info(
              `[acp-chat] Compressed ${payload.videoOptions ? 'video reference' : 'chat'} image from ${prepared.inputBytes} to ${prepared.outputBytes} bytes`,
            );
          }
          if (payload.videoOptions) {
            videoReferenceImage = {
              buffer: prepared.buffer,
              fileName: prepared.fileName,
              mimeType: prepared.mimeType,
            };
          }
          blocks.push({
            type: 'image',
            data,
            mimeType: prepared.mimeType,
            uri: item.filePath,
            _meta: {
              clawx: {
                stagingId: item.stagingId,
                ...(item.fileName ? { fileName: item.fileName } : {}),
              },
            },
          });
        } else {
          blocks.push({
            type: 'resource_link',
            uri: item.filePath,
            name: item.fileName ?? item.filePath,
            mimeType: item.mimeType,
            _meta: {
              clawx: {
                stagingId: item.stagingId,
              },
            },
          });
        }
      }
    }

    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    return {
      blocks,
      ...(videoReferenceImage ? { videoReferenceImage } : {}),
    };
  }
}

export function createAcpChatService(
  mainWindow: MainWindowLike,
  accessRegistry: AcpSessionAccessRegistry,
  gateway?: GatewayPairingRpcClient,
): AcpChatService {
  return new AcpChatService(mainWindow, accessRegistry, undefined, gateway);
}
