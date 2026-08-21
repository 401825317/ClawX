/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 */
import { app } from 'electron';
import path from 'path';
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { getPort } from '../utils/config';
import { JsonRpcNotification, isNotification, isResponse } from './protocol';
import { logger } from '../utils/logger';
import { captureTelemetryEvent, trackMetric } from '../utils/telemetry';
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from '../utils/device-identity';
import {
  cancelLocalDeviceAutoApproval,
  scheduleLocalDeviceAutoApproval,
} from '../utils/control-ui-device-pairing';
import {
  DEFAULT_RECONNECT_CONFIG,
  type ReconnectConfig,
  type GatewayLifecycleState,
  getReconnectScheduleDecision,
  getReconnectSkipReason,
} from './process-policy';
import {
  clearPendingGatewayRequests,
  rejectPendingGatewayRequest,
  resolvePendingGatewayRequest,
  type PendingGatewayRequest,
} from './request-store';
import { dispatchJsonRpcNotification, dispatchProtocolEvent } from './event-dispatch';
import { GatewayStateController } from './state';
import { prepareGatewayLaunchContext } from './config-sync';
import { connectGatewaySocket, waitForGatewayReady } from './ws-client';
import {
  findExistingGatewayProcess,
  runOpenClawDoctorRepair,
  terminateOwnedGatewayProcess,
  unloadLaunchctlGatewayService,
  waitForPortFree,
  warmupManagedPythonReadiness,
} from './supervisor';
import { GatewayConnectionMonitor } from './connection-monitor';
import { GatewayLifecycleController, LifecycleSupersededError } from './lifecycle-controller';
import { launchGatewayProcess } from './process-launcher';
import { GatewayRestartController } from './restart-controller';
import { GatewayRestartGovernor } from './restart-governor';
import {
  DEFAULT_GATEWAY_RELOAD_POLICY,
  loadGatewayReloadPolicy,
  type GatewayReloadPolicy,
} from './reload-policy';
import {
  classifyGatewayStderrMessage,
  GATEWAY_STARTUP_SLOW_STAGE_MS,
  GATEWAY_STARTUP_SLOW_TOTAL_MS,
  GatewayStartupTraceCollector,
  recordGatewayStartupStderrLine,
} from './startup-stderr';
import { runGatewayStartupSequence } from './startup-orchestrator';
import {
  commitManagedOpenClawDowngrade,
  isOpenClawCommandTerminationUnconfirmedError,
  isOpenClawDowngradeBlockedError,
  prepareManagedOpenClawDowngrade,
  rollbackOpenClawDowngrade,
  type OpenClawDowngradeTransaction,
} from './openclaw-downgrade';
import {
  GatewayRuntimePackageResolutionError,
  hasDeterministicGatewayRuntimeFailureSignal,
  hasOpenClawFutureConfigGuardSignal,
} from './startup-recovery';
import {
  acquireManagedRuntimeMutationLease as acquireRuntimeMutationLease,
  assertManagedRuntimeLaunchAllowed,
  assertManagedRuntimeStartAllowed,
  isManagedRuntimeMutationActive,
  isManagedRuntimeStartBlockedError,
  releaseManagedRuntimeMutationLease as releaseRuntimeMutationLease,
  type ManagedRuntimeMutationLease,
} from './managed-runtime-mutation-barrier';
import {
  GatewayCapabilityMonitor,
  type GatewayCapabilityName,
  type GatewayCapabilitySnapshot,
} from './capability-monitor';
import {
  isGatewayWsTraceEnabled,
  redactGatewayFrameForTrace,
  summarizeGatewayFrameForTrace,
} from './ws-trace';
import type {
  GatewayChannelStatusEvent,
  GatewayChatMessageEvent,
  GatewayRuntimePayload,
} from '@shared/host-events/contract';
import type { ChatRuntimeEvent } from '@shared/chat-runtime-events';

export interface GatewayStatus {
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
  reconnectMaxAttempts?: number;
  connectionAttempt?: number;
  connectionMaxAttempts?: number;
  /** True once the gateway's internal subsystems (skills, plugins) are ready for RPC calls. */
  gatewayReady?: boolean;
}

export type GatewayHealthState = 'healthy' | 'degraded' | 'unresponsive';

export interface GatewayHealthSummary {
  state: GatewayHealthState;
  reasons: string[];
  consecutiveHeartbeatMisses: number;
  lastAliveAt?: number;
  lastRpcSuccessAt?: number;
  lastRpcFailureAt?: number;
  lastRpcFailureMethod?: string;
  lastChannelsStatusOkAt?: number;
  lastChannelsStatusFailureAt?: number;
}

export interface GatewayHealthReport {
  ok: boolean;
  error?: string;
  uptime?: number;
  version?: string;
  capabilities: GatewayCapabilitySnapshot;
}

export interface GatewayDiagnosticsSnapshot {
  lastAliveAt?: number;
  lastRpcSuccessAt?: number;
  lastRpcFailureAt?: number;
  lastRpcFailureMethod?: string;
  lastHeartbeatTimeoutAt?: number;
  consecutiveHeartbeatMisses: number;
  lastSocketCloseAt?: number;
  lastSocketCloseCode?: number;
  consecutiveRpcFailures: number;
}

type GatewayRestartDrainState = 'waiting' | 'drained' | 'forced' | 'executing' | 'terminal';
type GatewayRestartDrainResult =
  | 'pending'
  | 'joined'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'deferred'
  | 'suppressed';
type GatewayRestartDrainForcedReason =
  | 'none'
  | 'active_runs_deadline'
  | 'runtime_unavailable';

interface GatewayRestartDrainLogContext {
  forcedReason: GatewayRestartDrainForcedReason;
  terminalEmitted: boolean;
}

interface GatewayRestartDrainOperation extends GatewayRestartDrainLogContext {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  lease?: ManagedRuntimeMutationLease;
  forcedCancellation?: Promise<void>;
}

class GatewayNonRetryableAuthenticationError extends Error {
  readonly code = 'gateway_authentication_failed';
  readonly retryable = false;

  constructor() {
    super('Gateway authentication was rejected; automatic recovery is disabled for this launch');
    this.name = 'GatewayNonRetryableAuthenticationError';
  }
}

function isDeterministicGatewayAuthenticationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /(?:token[_ ]mismatch|unauthorized|authentication failed|auth failed|invalid (?:api )?token|token expired|forbidden|\b401\b|\b403\b)/iu.test(message);
}

export const __test = { isDeterministicGatewayAuthenticationError };

function isCoreRpcMethod(method: string): boolean {
  return method === 'system-presence';
}

function isTransportRpcFailure(method: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('RPC timeout:')
    ? isCoreRpcMethod(method)
    : message.includes('Gateway not connected')
    || message.includes('Gateway stopped')
    || message.includes('Failed to send RPC request:');
}

function classifyCapabilityMethod(method: string): GatewayCapabilityName | null {
  if (method === 'health') return 'openclawHealth';
  if (method === 'status') return 'openclawStatus';
  if (method === 'channels.status') return 'channels';
  if (method.startsWith('doctor.memory.')) return 'memory';
  return null;
}

class GatewayLateChildTerminationError extends AggregateError {
  constructor(lifecycleError: unknown, terminationError: unknown, pid?: number) {
    const lifecycleMessage = lifecycleError instanceof Error ? lifecycleError.message : String(lifecycleError);
    const terminationMessage = terminationError instanceof Error ? terminationError.message : String(terminationError);
    super(
      [lifecycleError, terminationError],
      `Gateway child spawned after lifecycle invalidation could not be terminated `
        + `(pid=${pid ?? 'unknown'}): lifecycle=${lifecycleMessage}; termination=${terminationMessage}`,
      { cause: terminationError },
    );
    this.name = 'GatewayLateChildTerminationError';
  }
}

/** Blocks Gateway starts for this manager after an external config writer may have survived. */
export class GatewayProcessIsolationError extends Error {
  constructor(cause: unknown) {
    super(
      'Gateway start is isolated until the application restarts because OpenClaw command termination was not confirmed',
      { cause },
    );
    this.name = 'GatewayProcessIsolationError';
  }
}

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'gateway:health': (data: GatewayRuntimePayload) => void;
  'gateway:presence': (data: GatewayRuntimePayload) => void;
  'channel:status': (data: GatewayChannelStatusEvent) => void;
  'chat:message': (data: GatewayChatMessageEvent) => void;
  'chat:runtime-event': (data: ChatRuntimeEvent) => void;
}

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  private process: Electron.UtilityProcess | null = null;
  private processExitCode: number | null = null; // set by exit event, replaces exitCode/signalCode
  private ownsProcess = false;
  private connectedGatewayOwned = false;
  private connectedGatewayProvenance: 'managed-process' | 'verified-orphan' | 'unknown-external' = 'unknown-external';
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { state: 'stopped', port: getPort('OPENCLAW_GATEWAY') };
  private readonly stateController: GatewayStateController;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private startInFlight: Promise<void> | null = null;
  private lastSpawnSummary: string | null = null;
  private recentStartupStderrLines: string[] = [];
  private startupStderrCollectionActive = false;
  private openClawDowngradeTransaction: OpenClawDowngradeTransaction | null = null;
  private processIsolationError: GatewayProcessIsolationError | null = null;
  private automaticRecoveryDisabledForLaunch = false;
  private readonly startupTraceCollector = new GatewayStartupTraceCollector();
  private pendingRequests: Map<string, PendingGatewayRequest> = new Map();
  private deviceIdentity: DeviceIdentity | null = null;
  private restartInFlight: Promise<void> | null = null;
  private restartInFlightDrainContext: GatewayRestartDrainLogContext | null = null;
  private readonly connectionMonitor = new GatewayConnectionMonitor();
  private readonly lifecycleController = new GatewayLifecycleController();
  private readonly restartController = new GatewayRestartController();
  private readonly restartGovernor = new GatewayRestartGovernor();
  private reloadDebounceTimer: NodeJS.Timeout | null = null;
  private initialReadyHeartbeatRecoveryTimer: NodeJS.Timeout | null = null;
  private reloadPolicy: GatewayReloadPolicy = { ...DEFAULT_GATEWAY_RELOAD_POLICY };
  private reloadPolicyLoadedAt = 0;
  private reloadPolicyRefreshPromise: Promise<void> | null = null;
  private externalShutdownSupported: boolean | null = null;
  private reconnectAttemptsTotal = 0;
  private reconnectSuccessTotal = 0;
  private static readonly RELOAD_POLICY_REFRESH_MS = 15_000;
  /** Keep a config refresh alive until a freshly connected Gateway is stable. */
  private static readonly RECENT_CONNECT_RELOAD_GUARD_MS = 8_000;
  private static readonly HEARTBEAT_INTERVAL_MS = 60_000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 30_000;
  private static readonly HEARTBEAT_MAX_MISSES = 4;
  public static readonly RESTART_COOLDOWN_MS = 5_000;
  private static readonly GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS = [1_500, 3_000, 5_000, 8_000, 12_000, 30_000] as const;
  private static readonly INITIAL_READY_HEARTBEAT_RECOVERY_GRACE_MS = 5 * 60_000;
  private lastRestartAt = 0;
  /** Set by scheduleReconnect() before calling start() to signal auto-reconnect. */
  private isAutoReconnectStart = false;
  private gatewayReadyFallbackTimer: NodeJS.Timeout | null = null;
  private gatewayReadyFallbackAttempt = 0;
  private readonly capabilityMonitor = new GatewayCapabilityMonitor();
  private startupAbortController: AbortController | null = null;
  private processGeneration = 0;
  private socketGeneration = 0;
  private activeRunIds = new Set<string>();
  private activeRuns = new Map<string, string | undefined>();
  private runAdmissionClosed = false;
  private runAdmissionGeneration = 0;
  private processTerminationInFlight: { child: Electron.UtilityProcess; promise: Promise<void> } | null = null;
  private stopInFlight: Promise<void> | null = null;
  private stopRequestGeneration = 0;
  private restartAfterDrainTimer: NodeJS.Timeout | null = null;
  private restartAfterDrainOperation: GatewayRestartDrainOperation | null = null;
  private static readonly RESTART_DRAIN_TIMEOUT_MS = 90_000;
  private static readonly TERMINATION_STABILITY_WINDOW_MS = 250;
  private diagnostics: GatewayDiagnosticsSnapshot = {
    consecutiveHeartbeatMisses: 0,
    consecutiveRpcFailures: 0,
  };

  constructor(config?: Partial<ReconnectConfig>) {
    super();
    this.stateController = new GatewayStateController({
      emitStatus: (status) => {
        this.status = status;
        this.emit('status', status);
      },
      onTransition: (previousState, nextState) => {
        if (nextState === 'running') {
          this.restartGovernor.onRunning();
        }
        if (isManagedRuntimeMutationActive()) {
          this.restartController.resetDeferredRestart();
          return;
        }
        this.restartController.flushDeferredRestart(
          `status:${previousState}->${nextState}`,
          {
            state: this.status.state,
            startLock: this.startLock,
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart().catch((error) => {
              logger.warn('Deferred Gateway restart failed:', error);
            });
          },
        );
      },
    });
    this.reconnectConfig = { ...DEFAULT_RECONNECT_CONFIG, ...config };
    // Device identity is loaded lazily in start() — not in the constructor —
    // so that async file I/O and key generation don't block module loading.

    this.on('gateway:ready', () => {
      this.markGatewayRuntimeReady('event');
    });
    this.on('gateway:health', (payload) => {
      this.capabilityMonitor.recordOpenClawHealth(payload);
    });
    this.on('gateway:presence', (payload) => {
      this.capabilityMonitor.recordPresence(payload);
    });
    this.on('chat:runtime-event', (event: ChatRuntimeEvent) => {
      if (event.type === 'run.started') {
        this.activeRunIds.add(event.runId);
        this.activeRuns.set(event.runId, event.sessionKey);
        return;
      }
      if (event.type === 'run.ended') {
        this.activeRunIds.delete(event.runId);
        this.activeRuns.delete(event.runId);
        // Forced cancellation emits a synthetic run.ended event after it has
        // already removed the run from the local set. Suppress the normal
        // drain callback here; the cancellation owner resumes the restart
        // exactly once after all abort attempts settle.
        if (!this.restartAfterDrainOperation?.forcedCancellation) {
          this.flushRestartAfterDrain();
        }
      }
    });
  }

  private async initDeviceIdentity(): Promise<void> {
    if (this.deviceIdentity) return; // already loaded
    try {
      const identityPath = path.join(app.getPath('userData'), 'clawx-device-identity.json');
      this.deviceIdentity = await loadOrCreateDeviceIdentity(identityPath);
      logger.debug(`Device identity loaded (deviceId=${this.deviceIdentity.deviceId})`);
    } catch (err) {
      logger.warn('Failed to load device identity, scopes will be limited:', err);
    }
  }

  private sanitizeSpawnArgs(args: string[]): string[] {
    const sanitized = [...args];
    const tokenIdx = sanitized.indexOf('--token');
    if (tokenIdx !== -1 && tokenIdx + 1 < sanitized.length) {
      sanitized[tokenIdx + 1] = '[redacted]';
    }
    return sanitized;
  }

  private isUnsupportedShutdownError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unknown method:\s*shutdown/i.test(message);
  }
  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  async getGatewayToken(): Promise<string> {
    return await import('../utils/store').then(({ getSetting }) => getSetting('gatewayToken'));
  }

  /** Acquire exclusive runtime authority before a managed credential transaction. */
  acquireManagedRuntimeMutationLease(): ManagedRuntimeMutationLease {
    const lease = acquireRuntimeMutationLease();
    this.lifecycleController.bump('managed-runtime-mutation-acquire');
    this.shouldReconnect = false;
    this.clearAllTimers();
    this.restartController.resetDeferredRestart();
    return lease;
  }

  /** Release runtime authority after success, safe rollback, or persisted quarantine. */
  releaseManagedRuntimeMutationLease(lease: ManagedRuntimeMutationLease): void {
    releaseRuntimeMutationLease(lease);
  }

  getDiagnostics(): GatewayDiagnosticsSnapshot {
    return { ...this.diagnostics };
  }

  getCapabilitySnapshot(summary?: GatewayHealthSummary): GatewayCapabilitySnapshot {
    return this.capabilityMonitor.buildSnapshot({
      status: this.status,
      transportConnected: this.ws?.readyState === WebSocket.OPEN,
      diagnostics: this.getDiagnostics(),
      summary,
    });
  }

  recordCapabilityFailure(name: GatewayCapabilityName, error: unknown, durationMs?: number): void {
    this.capabilityMonitor.recordCapabilityFailure(name, error, durationMs);
  }

  /**
   * Check if Gateway is connected and ready
   */
  isConnected(): boolean {
    return this.stateController.isConnected(this.ws?.readyState === WebSocket.OPEN);
  }

  /**
   * Start Gateway process
   */
  async start(lease?: ManagedRuntimeMutationLease): Promise<void> {
    if (this.processIsolationError) throw this.processIsolationError;
    await assertManagedRuntimeStartAllowed(lease);
    // Never overlap a new launch with an in-flight stop. The stop path owns
    // the port-release and process-ownership barrier until it settles.
    const stopInFlight = this.stopInFlight;
    if (stopInFlight) {
      await stopInFlight;
    }
    if (this.startInFlight) {
      await this.startInFlight;
      return;
    }

    const current = this.startInternal(lease);
    this.startInFlight = current;
    try {
      await current;
    } finally {
      if (this.startInFlight === current) this.startInFlight = null;
    }
  }

  private async startInternal(lease?: ManagedRuntimeMutationLease): Promise<void> {
    if (this.startLock) {
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      logger.debug('Gateway already running, skipping start');
      return;
    }

    this.startLock = true;
    const startEpoch = this.lifecycleController.bump('start');
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.lastSpawnSummary = null;
    this.automaticRecoveryDisabledForLaunch = false;
    this.shouldReconnect = true;
    await this.refreshReloadPolicy(true);

    // Lazily load device identity (async file I/O + key generation).
    // Must happen before connect() which uses the identity for the handshake.
    await this.initDeviceIdentity();

    // Manual start should override and cancel any pending reconnect timer.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      logger.debug('Cleared pending reconnect timer because start was requested manually');
    }

    // Only reset reconnectAttempts on manual start, not on auto-reconnect.
    // Auto-reconnect calls start() via scheduleReconnect(); those should
    // accumulate attempts so the maxAttempts cap works correctly.
    if (!this.isAutoReconnectStart) {
      this.reconnectAttempts = 0;
    }
    this.isAutoReconnectStart = false; // consume the flag
    this.setStatus({
      state: 'starting',
      error: undefined,
      reconnectAttempts: this.reconnectAttempts,
      reconnectMaxAttempts: this.reconnectConfig.maxAttempts,
      connectionAttempt: undefined,
      connectionMaxAttempts: undefined,
      gatewayReady: false,
    });
    this.resetGatewayReadyFallback();

    // Check if Python environment is ready (self-healing) asynchronously.
    // Fire-and-forget: only needs to run once, not on every retry.
    warmupManagedPythonReadiness();

    const t0 = Date.now();
    let tSpawned = 0;
    let tReady = 0;
    let downgradeMutationStarted = false;
    const startupAbortController = new AbortController();
    this.startupAbortController = startupAbortController;

    try {
      // This must run before prepareGatewayLaunchContext performs any config synchronization.
      this.openClawDowngradeTransaction = await prepareManagedOpenClawDowngrade();
      if (this.openClawDowngradeTransaction) {
        logger.info(
          `Preparing managed OpenClaw config handoff `
          + `(${this.openClawDowngradeTransaction.fromVersion} -> ${this.openClawDowngradeTransaction.toVersion})`,
        );
      }

      await runGatewayStartupSequence({
        port: this.status.port,
        shouldWaitForPortFree: process.platform === 'win32',
        hasOwnedProcess: () => this.process?.pid != null && this.ownsProcess,
        resetStartupStderrLines: () => {
          this.startupStderrCollectionActive = false;
          this.recentStartupStderrLines = [];
        },
        getStartupStderrLines: () => this.recentStartupStderrLines,
        assertLifecycle: (phase) => {
          this.lifecycleController.assert(startEpoch, phase);
          assertManagedRuntimeLaunchAllowed(lease);
        },
        findExistingGateway: async (port) => {
          // Always read the current process pid dynamically so that retries
          // don't treat a just-spawned gateway as an orphan.  The ownedPid
          // snapshot captured at start() entry is stale after startProcess()
          // replaces this.process — leading to the just-started pid being
          // immediately killed as a false orphan on the next retry iteration.
          const existing = await findExistingGatewayProcess({
            port,
            ownedPid: this.process?.pid,
            assertCanContinue: () => {
              this.lifecycleController.assert(startEpoch, 'start/find-existing-identity');
              assertManagedRuntimeLaunchAllowed(lease);
            },
          });
          if (existing && this.openClawDowngradeTransaction) {
            throw new Error('Cannot hand off OpenClaw config while another Gateway is running');
          }
          return existing;
        },
        connect: async (port, externalToken) => {
          await this.connect(port, externalToken, startupAbortController.signal);
        },
        onConnectAttempt: (attemptNo, maxAttempts) => {
          this.setStatus({
            connectionAttempt: attemptNo,
            connectionMaxAttempts: maxAttempts,
          });
        },
        onConnectedToExistingGateway: ({ gateway, source }) => {
          // If the existing gateway is actually our own spawned UtilityProcess
          // (e.g. after a self-restart code=1012), keep ownership so that
          // stop() can still terminate the process during a restart() cycle.
          const isOwnProcess = this.process?.pid != null && this.ownsProcess && (
            source === 'owned-process'
            || (gateway.pid != null && this.process.pid === gateway.pid)
          );
          this.connectedGatewayOwned = isOwnProcess;
          this.connectedGatewayProvenance = isOwnProcess ? 'managed-process' : gateway.provenance;
          if (!isOwnProcess) {
            this.setStatus({ pid: gateway.pid });
          }

          // Treat a successful reconnect to the owned process as a restart
          // completion (e.g. after a Gateway code-1012 in-process restart).
          // This updates lastRestartCompletedAt so that flushDeferredRestart
          // drops any deferred restart requested before this reconnect,
          // avoiding a redundant kill+respawn cycle.
          if (isOwnProcess) {
            this.restartController.recordRestartCompleted();
          }

          this.finishGatewayStartupDiagnostics();
          this.openRunAdmission();
          this.startHealthCheck();
        },
        waitForPortFree: async (port) => {
          await waitForPortFree(port);
        },
        startProcess: async () => {
          // prepareGatewayLaunchContext may write managed config before it forks.
          downgradeMutationStarted = this.openClawDowngradeTransaction !== null;
          await this.startProcess((phase) => {
            this.lifecycleController.assert(startEpoch, phase);
            assertManagedRuntimeLaunchAllowed(lease);
          });
          tSpawned = Date.now();
        },
        waitForReady: async (port) => {
          try {
            await waitForGatewayReady({
              port,
              getProcessExitCode: () => this.processExitCode,
              beforeProbe: () => {
                this.lifecycleController.assert(startEpoch, 'start/wait-ready-probe');
                assertManagedRuntimeLaunchAllowed(lease);
              },
            });
          } catch (error) {
            if (hasDeterministicGatewayRuntimeFailureSignal(error, this.recentStartupStderrLines)) {
              throw new GatewayRuntimePackageResolutionError(error);
            }
            throw error;
          }
          tReady = Date.now();
        },
        afterManagedGatewayReady: async () => {
          const transaction = this.openClawDowngradeTransaction;
          if (!transaction) return;

          // Finalization stamps managed ownership, so failures from this point require a controlled rollback.
          downgradeMutationStarted = true;
          await commitManagedOpenClawDowngrade(transaction);
          this.openClawDowngradeTransaction = null;
          logger.info(
            `Managed OpenClaw config handoff completed `
            + `(${transaction.fromVersion} -> ${transaction.toVersion})`,
          );
        },
        onConnectedToManagedGateway: () => {
          this.connectedGatewayOwned = this.process?.pid != null && this.ownsProcess;
          this.connectedGatewayProvenance = this.connectedGatewayOwned
            ? 'managed-process'
            : 'unknown-external';
          this.finishGatewayStartupDiagnostics();
          this.openRunAdmission();
          this.startHealthCheck();
          const tConnected = Date.now();
          const spawnToReadyMs = tReady && tSpawned ? tReady - tSpawned : undefined;
          const startupTrace = this.startupTraceCollector.getSummary();
          const startupMetric = {
            configSyncMs: tSpawned ? tSpawned - t0 : undefined,
            spawnToReadyMs,
            readyToConnectMs: tReady ? tConnected - tReady : undefined,
            totalMs: tConnected - t0,
            openclawTrace: startupTrace,
          };
          logger.info('[metric] gateway.startup', startupMetric);
          if (spawnToReadyMs !== undefined && spawnToReadyMs >= GATEWAY_STARTUP_SLOW_TOTAL_MS) {
            logger.warn('[gateway-startup] Slow managed Gateway startup detected', {
              pid: this.status.pid,
              spawnToReadyMs,
              openclawTrace: startupTrace,
            });
          }
        },
        runDoctorRepair: async () => await runOpenClawDoctorRepair(),
        onDoctorRepairSuccess: () => {
          this.setStatus({ state: 'starting', error: undefined, reconnectAttempts: 0 });
        },
        delay: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
        canRecoverStartup: () => this.openClawDowngradeTransaction === null,
      });
    } catch (error) {
      let startupError = error;
      const downgradeTransaction = this.openClawDowngradeTransaction;
      const terminationUnconfirmed = isOpenClawCommandTerminationUnconfirmedError(error);
      if (terminationUnconfirmed && !this.processIsolationError) {
        this.processIsolationError = new GatewayProcessIsolationError(error);
      }
      const downgradeBlocked = terminationUnconfirmed
        || downgradeTransaction !== null
        || isOpenClawDowngradeBlockedError(error)
        || hasOpenClawFutureConfigGuardSignal(error, this.recentStartupStderrLines);

      if (downgradeBlocked) {
        this.disableAutomaticRecovery('OpenClaw config handoff failed');
      }

      if (downgradeTransaction) {
        if (terminationUnconfirmed) {
          // The CLI may still own a config writer. Keep the backup untouched and
          // clear handoff state before terminating Gateway can emit an exit event.
          this.openClawDowngradeTransaction = null;
          try {
            await this.terminateGatewayForUnconfirmedOpenClawCommand();
          } catch (terminationError) {
            startupError = new AggregateError(
              [error, terminationError],
              'OpenClaw command termination was not confirmed and Gateway isolation failed',
              { cause: terminationError },
            );
          }
        } else if (!downgradeMutationStarted) {
          this.openClawDowngradeTransaction = null;
          logger.warn('Cancelled OpenClaw config handoff before managed config mutation began');
        } else {
          try {
            await this.abortOpenClawDowngrade(downgradeTransaction);
          } catch (rollbackError) {
            startupError = new AggregateError(
              [error, rollbackError],
              'OpenClaw config handoff failed and could not be rolled back safely',
              { cause: rollbackError },
            );
          }
        }
      }

      if (startupError instanceof LifecycleSupersededError) {
        logger.debug(startupError.message);
        return;
      }
      if (startupError instanceof GatewayLateChildTerminationError) {
        logger.error(startupError.message, startupError);
        this.setStatus({ state: 'error', error: startupError.message });
        throw startupError;
      }
      if (isManagedRuntimeStartBlockedError(startupError)) {
        logger.debug(startupError.message);
        throw startupError;
      }
      if (
        startupError instanceof GatewayRuntimePackageResolutionError
        || hasDeterministicGatewayRuntimeFailureSignal(startupError, this.recentStartupStderrLines)
      ) {
        this.disableAutomaticRecovery('OpenClaw runtime package resolution failed');
      }
      if (startupError instanceof GatewayNonRetryableAuthenticationError) {
        this.disableAutomaticRecovery(startupError.message);
      }
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnectAttempts}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
        startupError
      );
      this.setStatus({ state: 'error', error: String(startupError) });
      if (this.shouldReconnect) {
        logger.warn('Gateway start failed; scheduling auto-reconnect recovery');
        this.scheduleReconnect();
      }
      throw startupError;
    } finally {
      this.startupStderrCollectionActive = false;
      if (this.startupAbortController === startupAbortController) {
        this.startupAbortController = null;
      }
      this.startLock = false;
      if (isManagedRuntimeMutationActive()) {
        this.restartController.resetDeferredRestart();
      } else {
        this.restartController.flushDeferredRestart(
          'start:finally',
          {
            state: this.status.state,
            startLock: this.startLock,
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart().catch((error) => {
              logger.warn('Deferred Gateway restart failed:', error);
            });
          },
        );
      }
    }
  }

  /** Stops the owned Gateway while preserving the backup for later recovery. */
  private async terminateGatewayForUnconfirmedOpenClawCommand(): Promise<void> {
    const child = this.process;
    if (!child || !this.ownsProcess) return;
    const childPid = child.pid;

    await this.confirmTerminationTarget(child, this.processGeneration, childPid);
    await this.terminateOwnedProcessAndWaitForPort(child);
    if (this.process === child) {
      this.process = null;
      this.ownsProcess = false;
    }
    if (childPid !== undefined && this.status.pid === childPid) {
      this.setStatus({ pid: undefined });
    }
  }

  /** Stops every automatic recovery path for a deterministic compatibility failure. */
  private disableAutomaticRecovery(reason: string): void {
    this.automaticRecoveryDisabledForLaunch = true;
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    logger.error(`${reason}; automatic Gateway recovery is disabled for this launch`);
  }

  /** Terminates the controlled child before restoring the pre-handoff config. */
  private async abortOpenClawDowngrade(
    transaction: OpenClawDowngradeTransaction,
  ): Promise<void> {
    const child = this.process;
    if (child && this.ownsProcess) {
      await this.confirmTerminationTarget(child, this.processGeneration, child.pid);
      await this.terminateOwnedProcessAndWaitForPort(child);
      if (this.process === child) {
        this.process = null;
        this.ownsProcess = false;
        if (this.status.pid === child.pid) {
          this.setStatus({ pid: undefined });
        }
      }
    }

    await rollbackOpenClawDowngrade(transaction);
    this.openClawDowngradeTransaction = null;
    logger.warn('Restored OpenClaw config backup after failed managed handoff');
  }

  /**
   * Stop Gateway process
   */
  async stop(): Promise<void> {
    this.stopRequestGeneration = this.nextGeneration(this.stopRequestGeneration);
    await this.runStopOperation();
  }

  /** Join or start the shared stop operation without recording a user stop request. */
  private async runStopOperation(): Promise<void> {
    if (this.stopInFlight) return this.stopInFlight;
    const stopPromise = this.stopInternal();
    this.stopInFlight = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopInFlight === stopPromise) this.stopInFlight = null;
    }
  }

  private async stopInternal(): Promise<void> {
    logger.info('Gateway stop requested');
    const gatewayPortAtStop = this.status.port;
    // Capture the owned child before the shutdown RPC. The child exit handler
    // can clear `this.process` while the RPC is in flight; the stop operation
    // still has to wait for that child's listener to release the port.
    let ownedChildAtStop = this.process && this.ownsProcess
      ? {
        child: this.process,
        processGeneration: this.processGeneration,
        pid: this.process.pid,
      }
      : null;
    if (!this.runAdmissionClosed) this.closeRunAdmission();
    cancelLocalDeviceAutoApproval();
    this.lifecycleController.bump('stop');
    const startupAbortController = this.startupAbortController;
    if (startupAbortController && !startupAbortController.signal.aborted) {
      startupAbortController.abort(new LifecycleSupersededError('Gateway startup cancelled by stop'));
    }
    // Disable auto-reconnect
    this.shouldReconnect = false;

    // Clear all timers
    this.clearAllTimers();

    // A superseded start may still be preparing or launching a child. Wait for
    // its post-launch guard to terminate any late child before stop returns.
    const startToDrain = this.startInFlight;
    if (startToDrain) {
      await startToDrain.catch(() => undefined);
    }

    // A superseded start can fork its child while the stop operation is
    // draining. Capture that late child after the drain so it cannot escape
    // the same termination and port-release barrier.
    if (this.process && this.ownsProcess && ownedChildAtStop?.child !== this.process) {
      ownedChildAtStop = {
        child: this.process,
        processGeneration: this.processGeneration,
        pid: this.process.pid,
      };
    }

    // Ask the connected runtime to shut down gracefully before terminating an
    // owned process. This gives active channel transports and session writers a
    // bounded drain window; unknown listeners are never signalled or killed.
    const connectedGatewayProvenance = this.connectedGatewayProvenance;
    const canGracefullyShutdown = this.ws?.readyState === WebSocket.OPEN
      && this.externalShutdownSupported !== false
      && (this.connectedGatewayOwned || connectedGatewayProvenance === 'verified-orphan');
    if (canGracefullyShutdown) {
      try {
        await this.rpc('shutdown', undefined, 5000);
        this.externalShutdownSupported = true;
      } catch (error) {
        if (this.isUnsupportedShutdownError(error)) {
          this.externalShutdownSupported = false;
          logger.info('Owned Gateway does not support "shutdown"; skipping shutdown RPC for future stops');
        } else {
          logger.warn('Failed to request graceful shutdown for verified Gateway:', error);
        }
      }
      if (connectedGatewayProvenance === 'verified-orphan' && this.externalShutdownSupported !== false) {
        await this.waitForConnectedGatewayPortFree(gatewayPortAtStop);
      }
    }

    // Close WebSocket — use terminate() to force-close the TCP connection
    // immediately without waiting for the WebSocket close handshake.
    // ws.close() sends a close frame and waits for the server to respond;
    // if the gateway process is being killed concurrently, the handshake
    // never completes and the connection stays ESTABLISHED indefinitely,
    // accumulating leaked connections on every restart cycle.
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.connectedGatewayOwned = false;
    this.connectedGatewayProvenance = 'unknown-external';

    // Kill the child captured before shutdown. If the child exited while the
    // shutdown RPC was running, its exit handler may have already cleared the
    // manager references; the port-release wait remains mandatory either way.
    if (ownedChildAtStop) {
      const { child, processGeneration, pid } = ownedChildAtStop;
      if (this.process === child && this.ownsProcess) {
        await this.confirmTerminationTarget(child, processGeneration, pid);
        await this.terminateOwnedProcessAndWaitForPort(child, gatewayPortAtStop);

        if (this.process === child) {
          this.process = null;
        }
      } else {
        await this.waitForConnectedGatewayPortFree(gatewayPortAtStop);
      }
    }
    this.ownsProcess = false;

    clearPendingGatewayRequests(this.pendingRequests, new Error('Gateway stopped'));

    this.restartController.resetDeferredRestart();
    this.isAutoReconnectStart = false;
    this.diagnostics.consecutiveHeartbeatMisses = 0;
    this.setStatus({
      state: 'stopped',
      error: undefined,
      pid: undefined,
      connectedAt: undefined,
      uptime: undefined,
      gatewayReady: undefined,
      reconnectAttempts: undefined,
      reconnectMaxAttempts: undefined,
      connectionAttempt: undefined,
      connectionMaxAttempts: undefined,
    });
  }

  /**
   * Best-effort emergency cleanup for app-quit timeout paths.
   * Only terminates a process this manager still owns.
   */
  async forceTerminateOwnedProcessForQuit(): Promise<boolean> {
    if (!this.process || !this.ownsProcess) {
      return false;
    }

    const child = this.process;
    await this.confirmTerminationTarget(child, this.processGeneration, child.pid);
    await this.terminateOwnedProcessAndWaitForPort(child);
    if (this.process === child) {
      this.process = null;
    }
    this.ownsProcess = false;
    this.setStatus({ pid: undefined });
    return true;
  }

  private terminateOwnedProcess(child: Electron.UtilityProcess): Promise<void> {
    if (this.processTerminationInFlight?.child === child) {
      return this.processTerminationInFlight.promise;
    }
    const promise = terminateOwnedGatewayProcess(child).finally(() => {
      if (this.processTerminationInFlight?.promise === promise) {
        this.processTerminationInFlight = null;
      }
    });
    this.processTerminationInFlight = { child, promise };
    return promise;
  }

  private async terminateOwnedProcessAndWaitForPort(
    child: Electron.UtilityProcess,
    port = this.status.port,
  ): Promise<void> {
    await this.terminateOwnedProcess(child);
    await this.waitForConnectedGatewayPortFree(port);
  }

  private waitForConnectedGatewayPortFree(port = this.status.port): Promise<void> {
    if (process.platform !== 'win32') return Promise.resolve();
    return waitForPortFree(port);
  }

  private async confirmTerminationTarget(
    child: Electron.UtilityProcess,
    processGeneration: number,
    pid: number | undefined,
  ): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, GatewayManager.TERMINATION_STABILITY_WINDOW_MS));
    if (
      this.process !== child
      || !this.ownsProcess
      || this.processGeneration !== processGeneration
      || child.pid !== pid
    ) {
      throw new Error('Gateway termination target changed during the stability window');
    }
  }

  /**
   * Restart Gateway process
   */
  private shouldDrainBeforeRestart(): boolean {
    return this.activeRunIds.size > 0
      && this.status.state === 'running'
      && this.ws?.readyState === WebSocket.OPEN;
  }

  private closeRunAdmission(): number {
    this.runAdmissionClosed = true;
    this.runAdmissionGeneration = this.nextGeneration(this.runAdmissionGeneration);
    return this.runAdmissionGeneration;
  }

  private reopenRunAdmission(generation: number): void {
    if (generation === this.runAdmissionGeneration) this.runAdmissionClosed = false;
  }

  private openRunAdmission(): void {
    this.runAdmissionGeneration = this.nextGeneration(this.runAdmissionGeneration);
    this.runAdmissionClosed = false;
  }

  private nextGeneration(current: number): number {
    return current >= Number.MAX_SAFE_INTEGER ? 1 : current + 1;
  }

  private logRestartDrain(
    state: GatewayRestartDrainState,
    result: GatewayRestartDrainResult,
    forcedReason: GatewayRestartDrainForcedReason,
  ): void {
    const details = {
      event: 'gateway_restart_drain',
      state,
      result,
      forcedReason,
    } as const;
    if (state === 'forced' || (state === 'terminal' && result !== 'succeeded')) {
      logger.warn('Gateway restart drain', details);
      return;
    }
    logger.info('Gateway restart drain', details);
  }

  private logRestartDrainTerminal(
    context: GatewayRestartDrainLogContext,
    result: Extract<GatewayRestartDrainResult, 'succeeded' | 'failed' | 'cancelled' | 'deferred' | 'suppressed'>,
  ): void {
    if (context.terminalEmitted) return;
    context.terminalEmitted = true;
    this.logRestartDrain('terminal', result, context.forcedReason);
  }

  private deferRestartUntilRunsDrain(lease?: ManagedRuntimeMutationLease): Promise<void> {
    if (this.restartAfterDrainOperation) {
      this.logRestartDrain(
        'waiting',
        'joined',
        this.restartAfterDrainOperation.forcedReason,
      );
      return this.restartAfterDrainOperation.promise;
    }

    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const operation: GatewayRestartDrainOperation = {
      promise,
      resolve,
      reject,
      lease,
      forcedReason: 'none',
      terminalEmitted: false,
    };
    this.restartAfterDrainOperation = operation;
    this.logRestartDrain('waiting', 'pending', operation.forcedReason);

    this.restartAfterDrainTimer = setTimeout(() => {
      this.restartAfterDrainTimer = null;
      if (this.restartAfterDrainOperation !== operation) return;

      operation.forcedReason = 'active_runs_deadline';
      this.logRestartDrain('forced', 'pending', operation.forcedReason);
      void this.cancelActiveRunsForForcedRestart(operation).then(() => this.executeDeferredRestart(operation));
    }, GatewayManager.RESTART_DRAIN_TIMEOUT_MS);
    return operation.promise;
  }

  private flushRestartAfterDrain(): void {
    const operation = this.restartAfterDrainOperation;
    if (!operation || this.activeRunIds.size > 0) return;
    this.logRestartDrain('drained', 'pending', operation.forcedReason);
    void this.executeDeferredRestart(operation);
  }

  private async cancelActiveRunsForForcedRestart(operation: GatewayRestartDrainOperation): Promise<void> {
    if (operation.forcedCancellation) return operation.forcedCancellation;
    const activeRuns = [...this.activeRuns.entries()];
    if (activeRuns.length === 0) return;

    operation.forcedCancellation = Promise.allSettled(activeRuns.map(async ([runId, sessionKey]) => {
      try {
        await this.rpc(
          'chat.abort',
          sessionKey ? { sessionKey } : { runId },
          15_000,
        );
      } catch {
        // A dead or already-disconnected Gateway cannot acknowledge abort.
        // The local run still needs an explicit terminal state so restart
        // does not wait forever or replay the request after recovery.
      } finally {
        if (this.activeRuns.has(runId)) {
          this.activeRuns.delete(runId);
          this.activeRunIds.delete(runId);
          this.emit('chat:runtime-event', {
            type: 'run.ended',
            runId,
            sessionKey,
            status: 'aborted',
            error: 'Gateway restart forced cancellation',
            stopReason: 'forced_restart',
          });
        }
      }
    })).then(() => undefined);
    await operation.forcedCancellation;
  }

  private async executeDeferredRestart(operation: GatewayRestartDrainOperation): Promise<void> {
    if (this.restartAfterDrainOperation !== operation) return;
    this.detachDeferredRestartDrain(operation);
    try {
      await assertManagedRuntimeStartAllowed(operation.lease);
      await this.executeRestart(operation.lease, operation);
      operation.resolve();
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      this.logRestartDrainTerminal(operation, 'failed');
      operation.reject(normalized);
    }
  }

  private detachDeferredRestartDrain(operation: GatewayRestartDrainOperation): void {
    if (this.restartAfterDrainOperation !== operation) return;
    if (this.restartAfterDrainTimer) {
      clearTimeout(this.restartAfterDrainTimer);
      this.restartAfterDrainTimer = null;
    }
    this.restartAfterDrainOperation = null;
  }

  private clearDeferredRestartDrain(error?: Error): void {
    const operation = this.restartAfterDrainOperation;
    if (this.restartAfterDrainTimer) {
      clearTimeout(this.restartAfterDrainTimer);
      this.restartAfterDrainTimer = null;
    }
    this.restartAfterDrainOperation = null;
    if (error && operation) {
      this.logRestartDrainTerminal(operation, 'cancelled');
      operation.reject(error);
    }
  }

  async restart(lease?: ManagedRuntimeMutationLease): Promise<void> {
    const admissionGeneration = this.closeRunAdmission();
    try {
      await assertManagedRuntimeStartAllowed(lease);
      if (this.shouldDrainBeforeRestart()) {
        await this.deferRestartUntilRunsDrain(lease);
        return;
      }
      await this.executeRestart(lease, {
        forcedReason: 'none',
        terminalEmitted: false,
      });
    } finally {
      this.reopenRunAdmission(admissionGeneration);
    }
  }

  private async executeRestart(
    lease: ManagedRuntimeMutationLease | undefined,
    drainContext: GatewayRestartDrainLogContext,
  ): Promise<void> {
    if (this.activeRunIds.size > 0) {
      drainContext.forcedReason = 'runtime_unavailable';
      this.logRestartDrain('forced', 'pending', drainContext.forcedReason);
      await this.cancelActiveRunsForForcedRestart({
        ...drainContext,
        promise: Promise.resolve(),
        resolve: () => undefined,
        reject: () => undefined,
      });
    }
    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('restart', {
        state: this.status.state,
        startLock: this.startLock,
      });
      this.logRestartDrainTerminal(drainContext, 'deferred');
      return;
    }

    if (this.restartInFlight) {
      this.logRestartDrain(
        'waiting',
        'joined',
        this.restartInFlightDrainContext?.forcedReason ?? drainContext.forcedReason,
      );
      await this.restartInFlight;
      return;
    }

    const decision = this.restartGovernor.decide();
    if (!decision.allow) {
      const observability = this.restartGovernor.getObservability();
      logger.warn(
        `[gateway-restart-governor] restart suppressed reason=${decision.reason} retryAfterMs=${decision.retryAfterMs} ` +
        `suppressed=${observability.suppressed_total} executed=${observability.executed_total} circuitOpenUntil=${observability.circuit_open_until}`,
      );
      const props = {
        reason: decision.reason,
        retry_after_ms: decision.retryAfterMs,
        gateway_restart_suppressed_total: observability.suppressed_total,
        gateway_restart_executed_total: observability.executed_total,
        gateway_restart_circuit_open_until: observability.circuit_open_until,
      };
      trackMetric('gateway.restart.suppressed', props);
      captureTelemetryEvent('gateway_restart_suppressed', props);
      this.logRestartDrainTerminal(drainContext, 'suppressed');
      return;
    }

    const pidBefore = this.status.pid;
    let managedRuntimeBlocked = false;
    this.lastRestartAt = Date.now();
    logger.info(`[gateway-refresh] mode=restart requested pidBefore=${pidBefore ?? 'n/a'}`);
    this.logRestartDrain('executing', 'pending', drainContext.forcedReason);
    this.restartInFlightDrainContext = drainContext;
    this.restartInFlight = (async () => {
      const stopGenerationBefore = this.stopRequestGeneration;
      await this.stop();
      const expectedStopGeneration = this.nextGeneration(stopGenerationBefore);
      // The real stop() call advances the generation once. A mocked stop in
      // unit/integration adapters may not, so accept the unchanged value too;
      // any additional public stop request during the await is still visible
      // as a third value and cancels the restart.
      if (
        this.stopRequestGeneration !== stopGenerationBefore
        && this.stopRequestGeneration !== expectedStopGeneration
      ) {
        // A user stop joined or superseded the restart's stop phase. Do not
        // undo that explicit request by starting a new Gateway afterward.
        this.shouldReconnect = false;
        logger.info('Gateway restart cancelled by an external stop request');
        return;
      }
      try {
        await this.start(lease);
      } catch (err) {
        if (isManagedRuntimeStartBlockedError(err)) {
          managedRuntimeBlocked = true;
          this.shouldReconnect = false;
          this.restartController.resetDeferredRestart();
          logger.debug('Gateway restart stopped by managed credential mutation');
          throw err;
        }
        if (this.automaticRecoveryDisabledForLaunch) {
          this.shouldReconnect = false;
          this.restartController.resetDeferredRestart();
          logger.debug('Gateway restart stopped because startup disabled automatic recovery');
          throw err;
        }
        // stop() set shouldReconnect=false. Restore it so the gateway
        // can self-heal via scheduleReconnect() instead of dying permanently.
        logger.warn('Gateway restart recovery', {
          event: 'gateway_restart_recovery',
          result: 'start_failed',
          action: 'schedule_reconnect',
        });
        this.shouldReconnect = true;
        this.scheduleReconnect();
        throw err;
      }
    })();

    try {
      await this.restartInFlight;
      this.restartGovernor.recordExecuted();
      this.restartController.recordRestartCompleted();
      const observability = this.restartGovernor.getObservability();
      const props = {
        gateway_restart_executed_total: observability.executed_total,
        gateway_restart_suppressed_total: observability.suppressed_total,
        gateway_restart_circuit_open_until: observability.circuit_open_until,
      };
      trackMetric('gateway.restart.executed', props);
      captureTelemetryEvent('gateway_restart_executed', props);
      logger.info(
        `[gateway-refresh] mode=restart result=applied pidBefore=${pidBefore ?? 'n/a'} pidAfter=${this.status.pid ?? 'n/a'} ` +
        `suppressed=${observability.suppressed_total} executed=${observability.executed_total} circuitOpenUntil=${observability.circuit_open_until}`,
      );
      this.logRestartDrainTerminal(drainContext, 'succeeded');
    } catch (error) {
      this.logRestartDrainTerminal(drainContext, 'failed');
      throw error;
    } finally {
      this.restartInFlight = null;
      this.restartInFlightDrainContext = null;
      if (managedRuntimeBlocked || isManagedRuntimeMutationActive()) {
        this.restartController.resetDeferredRestart();
      } else {
        this.restartController.flushDeferredRestart(
          'restart:finally',
          {
            state: this.status.state,
            startLock: this.startLock,
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart().catch((error) => {
              logger.warn('Deferred Gateway restart failed:', error);
            });
          },
        );
      }
    }
  }

  /**
   * Debounced restart — coalesces multiple rapid restart requests into a
   * single restart after `delayMs` of inactivity.  This prevents the
   * cascading stop/start cycles that occur when provider:save,
   * provider:setDefault and channel:saveConfig all fire within seconds
   * of each other during setup.
   */
  debouncedRestart(delayMs = 2000): void {
    if (isManagedRuntimeMutationActive()) {
      this.restartController.resetDeferredRestart();
      logger.debug('Gateway debounced restart dropped during managed credential mutation');
      return;
    }
    this.restartController.debouncedRestart(delayMs, () => {
      void this.restart().catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    });
  }

  /**
   * Ask the Gateway process to reload config in-place when possible.
   * Falls back to restart on unsupported platforms or signaling failures.
   */
  async reload(lease?: ManagedRuntimeMutationLease): Promise<void> {
    await assertManagedRuntimeStartAllowed(lease);
    await this.refreshReloadPolicy();

    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.info(
        `[gateway-refresh] mode=reload result=policy_forced_restart policy=${this.reloadPolicy.mode}`,
      );
      await this.restart(lease);
      return;
    }

    if (this.restartController.isRestartDeferred({
      state: this.status.state,
      startLock: this.startLock,
    })) {
      this.restartController.markDeferredRestart('reload', {
        state: this.status.state,
        startLock: this.startLock,
      });
      return;
    }

    const pidBefore = this.process?.pid;
    logger.info(`[gateway-refresh] mode=reload requested pid=${pidBefore ?? 'n/a'} state=${this.status.state}`);

    if (!this.process?.pid || this.status.state !== 'running') {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=not_running');
      logger.warn('Gateway reload requested while not running; falling back to restart');
      await this.restart(lease);
      return;
    }

    const connectedForMs = this.status.connectedAt
      ? Date.now() - this.status.connectedAt
      : Number.POSITIVE_INFINITY;

    // Do not discard a config refresh just because the process connected a
    // moment ago. Provider mutations can race with Gateway startup; on
    // Windows this used to leave the old model registry active indefinitely.
    if (connectedForMs < GatewayManager.RECENT_CONNECT_RELOAD_GUARD_MS) {
      const delayMs = Math.max(
        250,
        GatewayManager.RECENT_CONNECT_RELOAD_GUARD_MS - Math.max(0, connectedForMs),
      );
      logger.info(
        `[gateway-refresh] mode=reload result=deferred_recent_connect delayMs=${delayMs} `
          + `connectedForMs=${connectedForMs} pid=${this.process.pid}`,
      );
      this.deferReloadUntilGatewayStable(delayMs, lease);
      return;
    }

    if (process.platform === 'win32') {
      // Windows does not support SIGUSR1 for in-process reload.
      // Fall back to a full restart.  The connectedForMs < 8000 guard above
      // already skips unnecessary restarts for recently-started processes.
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=windows');
      await this.restart(lease);
      return;
    }

    try {
      assertManagedRuntimeLaunchAllowed(lease);
      process.kill(this.process.pid, 'SIGUSR1');
      logger.info(`Sent SIGUSR1 to Gateway for config reload (pid=${this.process.pid})`);
      // Some gateway builds do not handle SIGUSR1 as an in-process reload.
      // If process state doesn't recover quickly, fall back to restart.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.status.state !== 'running' || !this.process?.pid) {
        logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=post_signal_unhealthy');
        logger.warn('Gateway did not stay running after reload signal, falling back to restart');
        await this.restart(lease);
      } else {
        const pidAfter = this.process.pid;
        logger.info(
          `[gateway-refresh] mode=reload result=applied_in_place pidBefore=${pidBefore} pidAfter=${pidAfter}`,
        );
      }
    } catch (error) {
      if (isManagedRuntimeStartBlockedError(error)) {
        throw error;
      }
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=signal_error');
      logger.warn('Gateway reload signal failed, falling back to restart:', error);
      await this.restart(lease);
    }
  }

  /**
   * Debounced reload — coalesces multiple rapid config-change events into one
   * in-process reload when possible.
   */
  debouncedReload(delayMs?: number): void {
    if (isManagedRuntimeMutationActive()) {
      if (this.reloadDebounceTimer) {
        clearTimeout(this.reloadDebounceTimer);
        this.reloadDebounceTimer = null;
      }
      logger.debug('Gateway debounced reload dropped during managed credential mutation');
      return;
    }
    void this.refreshReloadPolicy();
    const effectiveDelay = delayMs ?? this.reloadPolicy.debounceMs;
    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.debug(
        `Gateway reload policy=${this.reloadPolicy.mode}; routing debouncedReload to debouncedRestart (${effectiveDelay}ms)`,
      );
      this.debouncedRestart(effectiveDelay);
      return;
    }

    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    logger.debug(`Gateway reload debounced (will fire in ${effectiveDelay}ms)`);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      void this.reload().catch((err) => {
        logger.warn('Debounced Gateway reload failed:', err);
      });
    }, effectiveDelay);
  }

  /** Retry a refresh after the connection has passed the startup guard. */
  private deferReloadUntilGatewayStable(
    delayMs: number,
    lease?: ManagedRuntimeMutationLease,
  ): void {
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }

    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      void this.reload(lease).catch((err) => {
        logger.warn('Deferred Gateway reload failed:', err);
      });
    }, Math.max(250, delayMs));
  }

  private async refreshReloadPolicy(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.reloadPolicyLoadedAt < GatewayManager.RELOAD_POLICY_REFRESH_MS) {
      return;
    }

    if (this.reloadPolicyRefreshPromise) {
      await this.reloadPolicyRefreshPromise;
      return;
    }

    this.reloadPolicyRefreshPromise = (async () => {
      const nextPolicy = await loadGatewayReloadPolicy();
      this.reloadPolicy = nextPolicy;
      this.reloadPolicyLoadedAt = Date.now();
    })();

    try {
      await this.reloadPolicyRefreshPromise;
    } finally {
      this.reloadPolicyRefreshPromise = null;
    }
  }

  /**
   * Clear all active timers
   */
  private clearAllTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connectionMonitor.clear();
    this.restartController.clearDebounceTimer();
    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
      this.reloadDebounceTimer = null;
    }
    this.resetGatewayReadyFallback();
    this.clearInitialReadyHeartbeatRecoveryTimer();
    this.clearDeferredRestartDrain(new Error('Gateway stop cancelled a pending graceful restart'));
  }

  private clearGatewayReadyFallbackTimer(): void {
    if (this.gatewayReadyFallbackTimer) {
      clearTimeout(this.gatewayReadyFallbackTimer);
      this.gatewayReadyFallbackTimer = null;
    }
  }

  private resetGatewayReadyFallback(): void {
    this.clearGatewayReadyFallbackTimer();
    this.gatewayReadyFallbackAttempt = 0;
  }

  private getNextGatewayReadyFallbackDelayMs(): number {
    const delays = GatewayManager.GATEWAY_READY_FALLBACK_PROBE_DELAYS_MS;
    const index = Math.min(this.gatewayReadyFallbackAttempt, delays.length - 1);
    const delayMs = delays[index]!;
    this.gatewayReadyFallbackAttempt += 1;
    return delayMs;
  }

  private scheduleGatewayReadyFallback(delayMs?: number): void {
    if ((this.status.state !== 'starting' && this.status.state !== 'running') || this.status.gatewayReady) {
      return;
    }
    this.clearGatewayReadyFallbackTimer();
    const effectiveDelayMs = delayMs ?? this.getNextGatewayReadyFallbackDelayMs();
    this.gatewayReadyFallbackTimer = setTimeout(() => {
      this.gatewayReadyFallbackTimer = null;
      void this.probeGatewayReadyFallback();
    }, effectiveDelayMs);
  }

  private async probeGatewayReadyFallback(): Promise<void> {
    if ((this.status.state !== 'starting' && this.status.state !== 'running') || this.status.gatewayReady) {
      return;
    }

    logger.info('Gateway ready fallback triggered; probing RPC router before marking ready');
    const startedAt = Date.now();
    try {
      await this.rpc('system-presence', {}, 5_000);
      this.capabilityMonitor.recordCoreProbe({
        ok: true,
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
      });
      this.markGatewayRuntimeReady('rpc-fallback');
    } catch (error) {
      this.capabilityMonitor.recordCoreProbe({
        ok: false,
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn('Gateway ready fallback RPC router probe failed; waiting for gateway.ready event or heartbeat recovery:', error);
      if ((this.status.state === 'starting' || this.status.state === 'running') && !this.status.gatewayReady) {
        this.scheduleGatewayReadyFallback();
      }
    }
  }

  /**
   * Make an RPC call to the Gateway
   * Uses OpenClaw protocol format: { type: "req", id: "...", method: "...", params: {...} }
   */
  async rpc<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    const startedAt = Date.now();
    return await new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }
      if (this.runAdmissionClosed && method === 'chat.send') {
        reject(new Error('Gateway restart drain is closing run admission'));
        return;
      }

      const id = crypto.randomUUID();

      // Set timeout for request
      const timeout = setTimeout(() => {
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`RPC timeout: ${method}`));
      }, timeoutMs);

      // Store pending request
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      // Send request using OpenClaw protocol format
      const request = {
        type: 'req',
        id,
        method,
        params,
      };

      try {
        if (isGatewayWsTraceEnabled()) {
          logger.debug('[gateway-ws-trace] send', {
            summary: summarizeGatewayFrameForTrace(request),
            frame: redactGatewayFrameForTrace(request),
          });
        }
        this.ws.send(JSON.stringify(request));
      } catch (error) {
        rejectPendingGatewayRequest(this.pendingRequests, id, new Error(`Failed to send RPC request: ${error}`));
      }
    }).then((result) => {
      this.recordRpcSuccess();
      if (isCoreRpcMethod(method)) {
        this.capabilityMonitor.recordCoreProbe({
          ok: true,
          checkedAt: Date.now(),
          durationMs: Date.now() - startedAt,
        });
      }
      const capability = classifyCapabilityMethod(method);
      if (capability) {
        this.capabilityMonitor.recordCapabilitySuccess(
          capability,
          result as GatewayRuntimePayload,
          Date.now() - startedAt,
        );
      }
      return result;
    }).catch((error) => {
      const capability = classifyCapabilityMethod(method);
      if (capability) {
        this.capabilityMonitor.recordCapabilityFailure(capability, error, Date.now() - startedAt);
      }
      if (isTransportRpcFailure(method, error)) {
        this.capabilityMonitor.recordCoreProbe({
          ok: false,
          checkedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        this.recordRpcFailure(method);
      }
      throw error;
    });
  }

  /**
   * Start health check monitoring
   */
  private startHealthCheck(): void {
    this.connectionMonitor.startHealthCheck({
      shouldCheck: () => this.status.state === 'running',
      checkHealth: () => this.checkTransportHealth(),
      onUnhealthy: (errorMessage) => {
        this.emit('error', new Error(errorMessage));
      },
      onError: () => {
        // The monitor already logged the error; nothing else to do here.
      },
    });
  }

  private markGatewayRuntimeReady(source: 'event' | 'rpc-fallback'): void {
    if ((this.status.state !== 'starting' && this.status.state !== 'running') || this.status.gatewayReady) return;
    this.resetGatewayReadyFallback();
    this.clearInitialReadyHeartbeatRecoveryTimer();
    logger.info(`[gateway-ready] source=${source}; Gateway subsystems ready`);
    this.setStatus({
      state: 'running',
      error: undefined,
      gatewayReady: true,
      reconnectAttempts: 0,
      reconnectMaxAttempts: undefined,
      connectionAttempt: undefined,
      connectionMaxAttempts: undefined,
    });
    this.scheduleReadOnlyChannelRecoveryProbe();
  }

  private finishGatewayStartupDiagnostics(): void {
    this.startupStderrCollectionActive = false;
    this.recentStartupStderrLines = [];
  }

  private scheduleReadOnlyChannelRecoveryProbe(): void {
    const epoch = this.lifecycleController.getCurrentEpoch();
    const socketGeneration = this.socketGeneration;
    void this.connectionMonitor.runReadOnlyProbe(async () => {
      await this.rpc('channels.status', { probe: false }, 5_000);
    }).then((result) => {
      if (result.stale || !this.lifecycleController.isCurrent(epoch) || socketGeneration !== this.socketGeneration) return;
      if (result.ok) {
        logger.info(`[gateway-channel-recovery] result=ok mode=readonly elapsedMs=${result.durationMs}`);
        return;
      }
      logger.warn(
        `[gateway-channel-recovery] result=failed mode=readonly elapsedMs=${result.durationMs}; preserving existing runtime and configuration`,
        result.error,
      );
    });
  }

  /**
   * Check Gateway health via WebSocket ping
   * OpenClaw Gateway doesn't have an HTTP /health endpoint
   */
  private async checkTransportHealth(): Promise<{ ok: boolean; error?: string; uptime?: number }> {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        const uptime = this.status.connectedAt
          ? Math.floor((Date.now() - this.status.connectedAt) / 1000)
          : undefined;
        return { ok: true, uptime };
      }
      return { ok: false, error: 'WebSocket not connected' };
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }

  async checkHealth(options?: { probe?: boolean }): Promise<GatewayHealthReport> {
    const transport = await this.checkTransportHealth();
    if (transport.ok && this.status.state === 'running' && this.status.gatewayReady !== false) {
      const timeoutMs = options?.probe ? 8_000 : 3_000;
      const [healthResult, statusResult] = await Promise.allSettled([
        this.rpc('health', { probe: options?.probe === true }, timeoutMs),
        this.rpc('status', {}, timeoutMs),
      ]);

      if (healthResult.status === 'fulfilled') {
        this.capabilityMonitor.recordOpenClawHealth(healthResult.value as GatewayRuntimePayload);
      }
      if (statusResult.status === 'fulfilled') {
        this.capabilityMonitor.recordOpenClawStatus(statusResult.value as GatewayRuntimePayload);
      }
    }

    return {
      ...transport,
      capabilities: this.getCapabilitySnapshot(),
    };
  }

  private recordGatewayAlive(): void {
    this.clearInitialReadyHeartbeatRecoveryTimer();
    this.diagnostics.lastAliveAt = Date.now();
    this.diagnostics.consecutiveHeartbeatMisses = 0;
  }

  private recordRpcSuccess(): void {
    this.diagnostics.lastRpcSuccessAt = Date.now();
    this.diagnostics.consecutiveRpcFailures = 0;
  }

  private recordRpcFailure(method: string): void {
    this.diagnostics.lastRpcFailureAt = Date.now();
    this.diagnostics.lastRpcFailureMethod = method;
    this.diagnostics.consecutiveRpcFailures += 1;
  }

  private recordHeartbeatTimeout(consecutiveMisses: number): void {
    this.diagnostics.lastHeartbeatTimeoutAt = Date.now();
    this.diagnostics.consecutiveHeartbeatMisses = consecutiveMisses;
  }

  private recordSocketClose(code: number): void {
    this.diagnostics.lastSocketCloseAt = Date.now();
    this.diagnostics.lastSocketCloseCode = code;
  }

  /**
   * Start Gateway process
   * Uses OpenClaw npm package from node_modules (dev) or resources (production)
   */
  private async startProcess(assertCanLaunch: (phase: string) => void): Promise<void> {
    const launchContext = await prepareGatewayLaunchContext(this.status.port);
    await unloadLaunchctlGatewayService();
    this.processExitCode = null;

    // Per-process diagnostics reset on each new spawn so retries never mix
    // timings or stderr deduplication state from different Gateway children.
    const stderrDedup = new Map<string, number>();
    this.startupTraceCollector.reset();

    // A managed transaction that superseded startup must win before the child exists.
    assertCanLaunch('start/process-before-fork');
    if (process.platform === 'win32') {
      // Config preparation and service cleanup happen after the orchestrator's
      // first port probe. Recheck at the final launch boundary so a listener
      // that appears in that gap cannot be mistaken for this managed child.
      await waitForPortFree(this.status.port);
      assertCanLaunch('start/process-after-port-check');
    }
    this.externalShutdownSupported = null;
    const processGeneration = ++this.processGeneration;
    const startupStderrLines: string[] = [];
    let childExitedDuringLaunch = false;
    this.recentStartupStderrLines = startupStderrLines;
    this.startupStderrCollectionActive = true;
    const { child, lastSpawnSummary } = await launchGatewayProcess({
      port: this.status.port,
      launchContext,
      sanitizeSpawnArgs: (args) => this.sanitizeSpawnArgs(args),
      getCurrentState: () => this.status.state,
      getShouldReconnect: () => this.shouldReconnect,
      onStderrLine: (line) => {
        const isCurrentStartup = processGeneration === this.processGeneration
          && this.startupStderrCollectionActive;
        if (isCurrentStartup) {
          recordGatewayStartupStderrLine(startupStderrLines, line);
        }
        const traceStage = isCurrentStartup ? this.startupTraceCollector.record(line) : null;
        const classified = classifyGatewayStderrMessage(line);
        if (classified.level === 'drop') return;

        // Dedup: suppress identical stderr lines after the first occurrence.
        const count = (stderrDedup.get(classified.normalized) ?? 0) + 1;
        stderrDedup.set(classified.normalized, count);
        if (count > 1) {
          // Log a summary every 50 duplicates to stay visible without flooding.
          if (count % 50 === 0) {
            logger.debug(`[Gateway stderr] (suppressed ${count} repeats) ${classified.normalized}`);
          }
          return;
        }

        if (traceStage) {
          const message = `[gateway-startup] stage=${traceStage.name} durationMs=${traceStage.durationMs}`
            + (traceStage.totalMs === undefined ? '' : ` totalMs=${traceStage.totalMs}`);
          if (traceStage.durationMs >= GATEWAY_STARTUP_SLOW_STAGE_MS) {
            logger.warn(`${message} slow=true`);
          } else {
            logger.info(message);
          }
          return;
        }
        if (classified.level === 'debug') {
          logger.debug(`[Gateway stderr] ${classified.normalized}`);
          return;
        }
        if (classified.level === 'info') {
          logger.info(`[Gateway stderr] ${classified.normalized}`);
          return;
        }
        logger.warn(`[Gateway stderr] ${classified.normalized}`);
      },
      onSpawn: (pid) => {
        this.setStatus({ pid });
      },
      onSpawnChild: (spawnedChild) => {
        if (processGeneration !== this.processGeneration) return;
        // Register the object before launchGatewayProcess resolves. A very
        // fast child exit must be handled by this generation, not discarded as
        // a stale event before Manager owns the process.
        this.process = spawnedChild;
        this.ownsProcess = true;
      },
      onExit: (exitedChild, code) => {
        childExitedDuringLaunch = true;
        if (processGeneration !== this.processGeneration || this.process !== exitedChild) {
          logger.debug(
            `Ignoring stale Gateway process exit (generation=${processGeneration}, current=${this.processGeneration}, pid=${exitedChild.pid ?? 'unknown'})`,
          );
          return;
        }
        this.processExitCode = code;
        this.ownsProcess = false;
        this.connectedGatewayOwned = false;
        this.connectedGatewayProvenance = 'unknown-external';
        this.connectionMonitor.clear();
        if (this.process === exitedChild) {
          this.process = null;
        }
        this.emit('exit', code);

        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
        }

        if (
          this.openClawDowngradeTransaction
          || (
            this.startupStderrCollectionActive
            && hasOpenClawFutureConfigGuardSignal(undefined, startupStderrLines)
          )
        ) {
          this.disableAutomaticRecovery('OpenClaw config handoff child exited');
          return;
        }

        if (
          this.startupStderrCollectionActive
          && hasDeterministicGatewayRuntimeFailureSignal(undefined, startupStderrLines)
        ) {
          this.disableAutomaticRecovery('OpenClaw runtime package resolution failed');
          return;
        }

        // Always attempt reconnect from process exit.  scheduleReconnect()
        // internally checks shouldReconnect and reconnect-timer guards, so
        // calling it unconditionally is safe — intentional stop() calls set
        // shouldReconnect=false which makes scheduleReconnect() no-op.
        //
        // On Windows, the WS close handler intentionally skips reconnect
        // (to avoid racing with this exit handler).  However, WS close
        // fires *before* process exit and sets state='stopped', which
        // previously caused this handler to also skip reconnect — leaving
        // the gateway permanently dead with no recovery path.
        this.scheduleReconnect();
      },
      onError: (failedChild, spawnError) => {
        childExitedDuringLaunch = true;
        const isCurrentFailedChild = this.processGeneration === processGeneration
          && (this.process === null || this.process === failedChild);
        if (isCurrentFailedChild) {
          this.ownsProcess = false;
          this.connectedGatewayOwned = false;
          this.connectedGatewayProvenance = 'unknown-external';
        }
        if (this.process === failedChild) {
          this.process = null;
        }
        if (hasDeterministicGatewayRuntimeFailureSignal(spawnError, startupStderrLines)) {
          this.disableAutomaticRecovery('OpenClaw runtime package resolution failed');
        }
      },
      allowOlderBinaryDestructiveActions: this.openClawDowngradeTransaction !== null,
    });

    if (childExitedDuringLaunch) {
      throw new Error(`Gateway process exited before Manager completed registration (pid=${child.pid ?? 'unknown'})`);
    }
    // Mocks and non-Electron launch adapters may not provide onSpawnChild;
    // retain the post-await assignment as a compatibility fallback.
    this.process = child;
    this.ownsProcess = true;
    logger.debug(`Gateway manager now owns process pid=${child.pid ?? 'unknown'}`);
    this.lastSpawnSummary = lastSpawnSummary;

    try {
      // fork() may finish after a transaction acquired the barrier. Register
      // first so stop/quit paths can see the child, then validate ownership.
      assertCanLaunch('start/process-after-register');
    } catch (error) {
      try {
        await this.confirmTerminationTarget(child, processGeneration, child.pid);
        await this.terminateOwnedProcessAndWaitForPort(child);
      } catch (terminationError) {
        throw new GatewayLateChildTerminationError(error, terminationError, child.pid);
      }
      if (this.process === child) {
        this.process = null;
        this.ownsProcess = false;
      }
      if (this.process === null && this.status.pid === child.pid) {
        this.setStatus({ pid: undefined });
      }
      throw error;
    }
  }

  /**
   * Connect WebSocket to Gateway
   */
  private async connect(
    port: number,
    _externalToken?: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const socketGeneration = ++this.socketGeneration;
    this.connectedGatewayOwned = false;
    this.connectedGatewayProvenance = 'unknown-external';
    let connectedSocket: WebSocket;
    try {
      connectedSocket = await connectGatewaySocket({
        port,
        deviceIdentity: this.deviceIdentity,
        platform: process.platform,
        pendingRequests: this.pendingRequests,
        getToken: async () => await import('../utils/store').then(({ getSetting }) => getSetting('gatewayToken')),
        onHandshakeComplete: (ws) => {
        if (socketGeneration !== this.socketGeneration) {
          try { ws.terminate(); } catch { /* ignore stale socket cleanup */ }
          return;
        }
        this.ws = ws;
        ws.on('pong', () => {
          this.connectionMonitor.markAlive('pong');
          this.recordGatewayAlive();
        });
        this.recordGatewayAlive();
        this.setStatus({
          state: 'starting',
          port,
          connectedAt: Date.now(),
          error: undefined,
          gatewayReady: false,
        });
        this.startPing();
        this.scheduleGatewayReadyFallback();
        scheduleLocalDeviceAutoApproval(this);
      },
        onMessage: (message) => {
        if (socketGeneration !== this.socketGeneration) return;
        this.handleMessage(message);
      },
        onCloseAfterHandshake: (closeCode) => {
        if (socketGeneration !== this.socketGeneration) {
          logger.debug(`Ignoring stale Gateway socket close (generation=${socketGeneration}, current=${this.socketGeneration}, code=${closeCode})`);
          return;
        }
        cancelLocalDeviceAutoApproval();
        this.connectedGatewayOwned = false;
        this.connectedGatewayProvenance = 'unknown-external';
        this.connectionMonitor.clear();
        this.recordSocketClose(closeCode);
        this.diagnostics.consecutiveHeartbeatMisses = 0;
        if (this.status.state === 'running' || this.status.state === 'starting') {
          this.setStatus({ state: 'stopped' });
          // On Windows, skip reconnect from WS close.  The Gateway is a local
          // child process; actual crashes are already caught by the process exit
          // handler (`onExit`) which calls scheduleReconnect().  Triggering
          // reconnect from WS close as well races with the exit handler and can
          // cause double start() attempts or port conflicts during TCP TIME_WAIT.
          //
          // Exception: code=1012 means the Gateway is performing an in-process
          // restart (e.g. config reload).  The UtilityProcess stays alive, so
          // `onExit` will never fire — we MUST reconnect from the WS close path.
          if (process.platform !== 'win32' || closeCode === 1012) {
            this.scheduleReconnect();
          }
          }
        },
        signal,
      });
    } catch (error) {
      if (isDeterministicGatewayAuthenticationError(error)) {
        throw new GatewayNonRetryableAuthenticationError();
      }
      throw error;
    }
    if (socketGeneration !== this.socketGeneration) {
      try { connectedSocket.terminate(); } catch { /* ignore stale socket cleanup */ }
      throw new LifecycleSupersededError('Gateway socket connection superseded by a newer runtime');
    }
    this.ws = connectedSocket;
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: unknown): void {
    this.connectionMonitor.markAlive('message');
    this.recordGatewayAlive();
    if (isGatewayWsTraceEnabled()) {
      logger.debug('[gateway-ws-trace] recv', {
        summary: summarizeGatewayFrameForTrace(message),
        frame: redactGatewayFrameForTrace(message),
      });
    }

    if (typeof message !== 'object' || message === null) {
      logger.debug('Received non-object Gateway message');
      return;
    }

    const msg = message as Record<string, unknown>;

    // Handle OpenClaw protocol response format: { type: "res", id: "...", ok: true/false, ... }
    if (msg.type === 'res' && typeof msg.id === 'string') {
      if (msg.ok === false || msg.error) {
        const errorObj = msg.error as { message?: string; code?: number } | undefined;
        const errorMsg = errorObj?.message || JSON.stringify(msg.error) || 'Unknown error';
        if (rejectPendingGatewayRequest(this.pendingRequests, msg.id, new Error(errorMsg))) {
          return;
        }
      } else if (resolvePendingGatewayRequest(this.pendingRequests, msg.id, msg.payload ?? msg)) {
        return;
      }
    }

    // Handle OpenClaw protocol event format: { type: "event", event: "...", payload: {...} }
    if (msg.type === 'event' && typeof msg.event === 'string') {
      dispatchProtocolEvent(this, msg.event, msg.payload);
      return;
    }

    // Fallback: Check if this is a JSON-RPC 2.0 response (legacy support)
    if (isResponse(message) && message.id && this.pendingRequests.has(String(message.id))) {
      if (message.error) {
        const errorMsg = typeof message.error === 'object'
          ? (message.error as { message?: string }).message || JSON.stringify(message.error)
          : String(message.error);
        rejectPendingGatewayRequest(this.pendingRequests, String(message.id), new Error(errorMsg));
      } else {
        resolvePendingGatewayRequest(this.pendingRequests, String(message.id), message.result);
      }
      return;
    }

    // Check if this is a JSON-RPC notification (server-initiated event)
    if (isNotification(message)) {
      dispatchJsonRpcNotification(this, message);
      return;
    }

    this.emit('message', message);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPing(): void {
    this.connectionMonitor.startPing({
      intervalMs: GatewayManager.HEARTBEAT_INTERVAL_MS,
      timeoutMs: GatewayManager.HEARTBEAT_TIMEOUT_MS,
      maxConsecutiveMisses: GatewayManager.HEARTBEAT_MAX_MISSES,
      sendPing: () => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.ping();
        }
      },
      onHeartbeatTimeout: ({ consecutiveMisses, timeoutMs }) => {
        this.recordHeartbeatTimeout(consecutiveMisses);
        const pid = this.process?.pid ?? 'unknown';
        const shouldAttemptRecovery = this.shouldReconnect && this.status.state === 'running';
        logger.warn(
          `Gateway heartbeat: ${consecutiveMisses} consecutive pong misses ` +
            `(timeout=${timeoutMs}ms, pid=${pid}, state=${this.status.state}, autoReconnect=${this.shouldReconnect}).`,
        );
        if (!shouldAttemptRecovery) {
          logger.warn('Gateway heartbeat recovery skipped (lifecycle is not in auto-recoverable running state)');
          return;
        }
        const initialReadyRecoveryDelayMs = this.getInitialReadyHeartbeatRecoveryDelayMs();
        if (initialReadyRecoveryDelayMs > 0) {
          logger.warn(
            `Gateway heartbeat recovery deferred while waiting for initial gateway.ready ` +
            `(retryAfterMs=${initialReadyRecoveryDelayMs})`,
          );
          this.scheduleInitialReadyHeartbeatRecovery(initialReadyRecoveryDelayMs);
          return;
        }
        logger.warn('Gateway heartbeat recovery: restarting unresponsive gateway process');
        void this.restart().catch((error) => {
          logger.warn('Gateway heartbeat recovery failed:', error);
        });
      },
    });
  }

  private getInitialReadyHeartbeatRecoveryDelayMs(now = Date.now()): number {
    if (this.status.gatewayReady || !this.status.connectedAt) return 0;
    const connectedForMs = Math.max(0, now - this.status.connectedAt);
    return Math.max(0, GatewayManager.INITIAL_READY_HEARTBEAT_RECOVERY_GRACE_MS - connectedForMs);
  }

  private scheduleInitialReadyHeartbeatRecovery(delayMs: number): void {
    if (this.initialReadyHeartbeatRecoveryTimer) return;
    this.initialReadyHeartbeatRecoveryTimer = setTimeout(() => {
      this.initialReadyHeartbeatRecoveryTimer = null;
      if (
        !this.shouldReconnect
        || this.status.state !== 'running'
        || this.status.gatewayReady
      ) {
        return;
      }
      logger.warn('Gateway heartbeat recovery: initial gateway.ready grace expired, restarting unresponsive gateway process');
      void this.restart().catch((error) => {
        logger.warn('Gateway heartbeat recovery failed:', error);
      });
    }, delayMs);
  }

  private clearInitialReadyHeartbeatRecoveryTimer(): void {
    if (!this.initialReadyHeartbeatRecoveryTimer) return;
    clearTimeout(this.initialReadyHeartbeatRecoveryTimer);
    this.initialReadyHeartbeatRecoveryTimer = null;
  }

  /**
   * Schedule reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (isManagedRuntimeMutationActive()) {
      this.shouldReconnect = false;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      logger.debug('Gateway reconnect dropped during managed credential mutation');
      return;
    }
    const decision = getReconnectScheduleDecision({
      shouldReconnect: this.shouldReconnect,
      hasReconnectTimer: this.reconnectTimer !== null,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.reconnectConfig.maxAttempts,
      baseDelay: this.reconnectConfig.baseDelay,
      maxDelay: this.reconnectConfig.maxDelay,
    });

    if (decision.action === 'skip') {
      logger.debug(`Gateway reconnect skipped (${decision.reason})`);
      return;
    }

    if (decision.action === 'already-scheduled') {
      return;
    }

    if (decision.action === 'fail') {
      logger.error(`Gateway reconnect failed: max attempts reached (${decision.maxAttempts})`);
      this.setStatus({
        state: 'error',
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts,
        reconnectMaxAttempts: decision.maxAttempts,
      });
      return;
    }

    const cooldownRemaining = Math.max(0, GatewayManager.RESTART_COOLDOWN_MS - (Date.now() - this.lastRestartAt));
    const { delay, nextAttempt, maxAttempts } = decision;
    const effectiveDelay = Math.max(delay, cooldownRemaining);
    this.reconnectAttempts = nextAttempt;
    logger.warn(`Scheduling Gateway reconnect attempt ${nextAttempt}/${maxAttempts} in ${effectiveDelay}ms`);

    this.setStatus({
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts,
      reconnectMaxAttempts: maxAttempts,
    });
    const scheduledEpoch = this.lifecycleController.getCurrentEpoch();

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      const skipReason = getReconnectSkipReason({
        scheduledEpoch,
        currentEpoch: this.lifecycleController.getCurrentEpoch(),
        shouldReconnect: this.shouldReconnect,
      });
      if (skipReason) {
        logger.debug(`Skipping reconnect attempt: ${skipReason}`);
        return;
      }
      const attemptNo = this.reconnectAttempts;
      this.reconnectAttemptsTotal += 1;
      try {
        // Use the guarded start() flow so reconnect attempts cannot bypass
        // lifecycle locking and accidentally start duplicate Gateway processes.
        this.isAutoReconnectStart = true;
        await this.start();
        this.reconnectSuccessTotal += 1;
        this.emitReconnectMetric('success', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
        });
        this.reconnectAttempts = 0;
      } catch (error) {
        if (isManagedRuntimeStartBlockedError(error)) {
          this.shouldReconnect = false;
          this.isAutoReconnectStart = false;
          logger.debug('Gateway reconnection stopped by managed credential quarantine');
          return;
        }
        logger.error('Gateway reconnection attempt failed:', error);
        this.emitReconnectMetric('failure', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
      }
    }, effectiveDelay);
  }

  private emitReconnectMetric(
    outcome: 'success' | 'failure',
    payload: {
      attemptNo: number;
      maxAttempts: number;
      delayMs: number;
      error?: string;
    },
  ): void {
    const successRate = this.reconnectAttemptsTotal > 0
      ? this.reconnectSuccessTotal / this.reconnectAttemptsTotal
      : 0;

    const properties = {
      outcome,
      attemptNo: payload.attemptNo,
      maxAttempts: payload.maxAttempts,
      delayMs: payload.delayMs,
      gateway_reconnect_success_count: this.reconnectSuccessTotal,
      gateway_reconnect_attempt_count: this.reconnectAttemptsTotal,
      gateway_reconnect_success_rate: Number(successRate.toFixed(4)),
      ...(payload.error ? { error: payload.error } : {}),
    };

    trackMetric('gateway.reconnect', properties);
    // Keep local metrics only; do not upload reconnect details to PostHog.
  }

  /**
   * Update status and emit event
   */
  private setStatus(update: Partial<GatewayStatus>): void {
    this.stateController.setStatus(update);
  }
}
