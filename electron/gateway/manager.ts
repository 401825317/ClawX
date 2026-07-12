/**
 * Gateway Process Manager
 * Manages the OpenClaw Gateway process lifecycle
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { PORTS } from '../utils/config';
import { JsonRpcNotification, isNotification, isResponse } from './protocol';
import { logger } from '../utils/logger';
import { captureTelemetryEvent, trackMetric } from '../utils/telemetry';
import {
  type DeviceIdentity,
} from '../utils/device-identity';
import { loadOrCreateJunFeiAIDeviceIdentity } from '../utils/junfeiai-device';
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
  isGatewayPortOwnershipConflictError,
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
  classifyGatewayStdoutMessage,
  recordGatewayStartupStderrLine,
} from './startup-stderr';
import { runGatewayStartupSequence } from './startup-orchestrator';
import {
  GatewayCapabilityMonitor,
  type GatewayCapabilityName,
  type GatewayCapabilitySnapshot,
} from './capability-monitor';
import type { ChatRuntimeEvent } from '../../shared/chat-runtime-events';
import { GatewayTaskLedgerMonitor } from './task-ledger-monitor';

export interface GatewayStatus {
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  uptime?: number;
  error?: string;
  connectedAt?: number;
  version?: string;
  reconnectAttempts?: number;
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
  lastLifecycleEventAt?: number;
  lastLifecycleEvent?: string;
  lastStartRequestedAt?: number;
  lastStartReason?: string;
  lastStartSource?: string;
  lastStopRequestedAt?: number;
  lastStopReason?: string;
  lastStopSource?: string;
  lastRestartRequestedAt?: number;
  lastRestartReason?: string;
  lastRestartSource?: string;
  lastRestartCompletedAt?: number;
  lastReconnectScheduledAt?: number;
  lastReconnectReason?: string;
  lastReconnectSource?: string;
  lastProcessExitAt?: number;
  lastProcessExitCode?: number | null;
  lastProcessExitExpected?: boolean;
  recentLifecycleEvents?: GatewayLifecycleEvent[];
}

export interface GatewayLifecycleEvent {
  at: number;
  event: string;
  state: GatewayLifecycleState;
  port: number;
  pid?: number;
  reason?: string;
  source?: string;
  details?: Record<string, unknown>;
}

export interface GatewayLifecycleContext {
  reason?: string;
  source?: string;
  details?: Record<string, unknown>;
}

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

/**
 * Gateway Manager Events
 */
export interface GatewayManagerEvents {
  status: (status: GatewayStatus) => void;
  message: (message: unknown) => void;
  notification: (notification: JsonRpcNotification) => void;
  exit: (code: number | null) => void;
  error: (error: Error) => void;
  'gateway:health': (data: unknown) => void;
  'gateway:presence': (data: unknown) => void;
  'channel:status': (data: { channelId: string; status: string }) => void;
  'chat:message': (data: { message: unknown }) => void;
  'chat:runtime-event': (data: unknown) => void;
}

/**
 * Gateway Manager
 * Handles starting, stopping, and communicating with the OpenClaw Gateway
 */
export class GatewayManager extends EventEmitter {
  private process: Electron.UtilityProcess | null = null;
  private processExitCode: number | null = null; // set by exit event, replaces exitCode/signalCode
  private ownsProcess = false;
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { state: 'stopped', port: PORTS.OPENCLAW_GATEWAY };
  private readonly stateController: GatewayStateController;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private reconnectConfig: ReconnectConfig;
  private shouldReconnect = true;
  private startLock = false;
  private lastSpawnSummary: string | null = null;
  private recentStartupStderrLines: string[] = [];
  private pendingRequests: Map<string, PendingGatewayRequest> = new Map();
  private readonly blockingRpcRequestIds = new Set<string>();
  private readonly activeRuntimeRuns = new Map<string, { startedAt: number; lastEventAt: number; sessionKey?: string }>();
  private deviceIdentity: DeviceIdentity | null = null;
  private restartInFlight: Promise<void> | null = null;
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
  private static readonly LIFECYCLE_EVENT_BUFFER_SIZE = 100;
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
  private readonly taskLedgerMonitor = new GatewayTaskLedgerMonitor({
    listTasks: async ({ cursor, limit, status }) => await this.rpc('tasks.list', {
      limit,
      status,
      ...(cursor ? { cursor } : {}),
    }, 5_000),
    getTask: async (taskId) => await this.rpc('tasks.get', { taskId }, 5_000),
    emit: (event) => this.emit('chat:runtime-event', event),
    warn: (message, details) => logger.warn(message, details),
  });
  private readonly lifecycleEvents: GatewayLifecycleEvent[] = [];
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
        this.restartController.flushDeferredRestart(
          `status:${previousState}->${nextState}`,
          {
            ...this.getRestartDeferralState(),
            shouldReconnect: this.shouldReconnect,
          },
          () => {
            void this.restart({
              reason: 'deferred-restart-flush',
              source: `status:${previousState}->${nextState}`,
            }).catch((error) => {
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
      this.resetGatewayReadyFallback();
      this.clearInitialReadyHeartbeatRecoveryTimer();
      if (this.status.state === 'running' && !this.status.gatewayReady) {
        logger.info('Gateway subsystems ready (event received)');
        this.setStatus({ gatewayReady: true });
      }
    });
    this.on('gateway:health', (payload) => {
      this.capabilityMonitor.recordOpenClawHealth(payload);
    });
    this.on('gateway:presence', (payload) => {
      this.capabilityMonitor.recordPresence(payload);
    });
    this.on('chat:runtime-event', (payload) => {
      this.trackRuntimeWorkEvent(payload);
    });
  }

  private async initDeviceIdentity(): Promise<void> {
    if (this.deviceIdentity) return; // already loaded
    try {
      this.deviceIdentity = await loadOrCreateJunFeiAIDeviceIdentity();
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

  private safeStringifyLifecycleEvent(event: GatewayLifecycleEvent): string {
    try {
      return JSON.stringify(event);
    } catch {
      return JSON.stringify({
        ...event,
        details: '[unserializable]',
      });
    }
  }

  private recordLifecycleEvent(event: string, context?: GatewayLifecycleContext): GatewayLifecycleEvent {
    const pid = this.process?.pid ?? this.status.pid;
    const entry: GatewayLifecycleEvent = {
      at: Date.now(),
      event,
      state: this.status.state,
      port: this.status.port,
      ...(pid ? { pid } : {}),
      ...(context?.reason ? { reason: context.reason } : {}),
      ...(context?.source ? { source: context.source } : {}),
      ...(context?.details ? { details: context.details } : {}),
    };

    this.lifecycleEvents.push(entry);
    if (this.lifecycleEvents.length > GatewayManager.LIFECYCLE_EVENT_BUFFER_SIZE) {
      this.lifecycleEvents.shift();
    }

    this.diagnostics.lastLifecycleEventAt = entry.at;
    this.diagnostics.lastLifecycleEvent = event;

    if (event === 'start_requested') {
      this.diagnostics.lastStartRequestedAt = entry.at;
      this.diagnostics.lastStartReason = entry.reason;
      this.diagnostics.lastStartSource = entry.source;
    } else if (event === 'stop_requested') {
      this.diagnostics.lastStopRequestedAt = entry.at;
      this.diagnostics.lastStopReason = entry.reason;
      this.diagnostics.lastStopSource = entry.source;
    } else if (event === 'restart_requested') {
      this.diagnostics.lastRestartRequestedAt = entry.at;
      this.diagnostics.lastRestartReason = entry.reason;
      this.diagnostics.lastRestartSource = entry.source;
    } else if (event === 'restart_completed') {
      this.diagnostics.lastRestartCompletedAt = entry.at;
    } else if (event === 'reconnect_scheduled') {
      this.diagnostics.lastReconnectScheduledAt = entry.at;
      this.diagnostics.lastReconnectReason = entry.reason;
      this.diagnostics.lastReconnectSource = entry.source;
    } else if (event === 'process_exit') {
      this.diagnostics.lastProcessExitAt = entry.at;
      const code = entry.details?.code;
      const expected = entry.details?.expected;
      this.diagnostics.lastProcessExitCode = typeof code === 'number' ? code : null;
      this.diagnostics.lastProcessExitExpected = typeof expected === 'boolean' ? expected : undefined;
    }

    logger.info(`[gateway-lifecycle] ${this.safeStringifyLifecycleEvent(entry)}`);
    return entry;
  }

  private isUnsupportedShutdownError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /unknown method:\s*shutdown/i.test(message);
  }

  private shouldTrackBlockingRpcMethod(method: string): boolean {
    return method === 'chat.send';
  }

  private shouldBypassActiveWorkDeferral(context?: GatewayLifecycleContext): boolean {
    const source = context?.source ?? '';
    const reason = context?.reason ?? '';
    if (source === 'gateway-heartbeat') return true;
    if (reason === 'heartbeat-timeout' || reason === 'initial-gateway-ready-heartbeat-timeout') {
      return true;
    }
    if (source === 'gateway-reload' && reason.startsWith('reload-fallback-')) {
      return true;
    }
    return false;
  }

  private hasInFlightGatewayWork(): boolean {
    return this.blockingRpcRequestIds.size > 0 || this.activeRuntimeRuns.size > 0;
  }

  private getRestartDeferralState(context?: GatewayLifecycleContext): {
    state: GatewayLifecycleState;
    startLock: boolean;
    hasInFlightWork: boolean;
    activeRunCount: number;
    blockingRpcCount: number;
  } {
    const hasInFlightWork = this.hasInFlightGatewayWork() && !this.shouldBypassActiveWorkDeferral(context);
    return {
      state: this.status.state,
      startLock: this.startLock,
      hasInFlightWork,
      activeRunCount: this.activeRuntimeRuns.size,
      blockingRpcCount: this.blockingRpcRequestIds.size,
    };
  }

  private flushDeferredRestartIfIdle(trigger: string): void {
    this.restartController.flushDeferredRestart(
      trigger,
      {
        ...this.getRestartDeferralState(),
        shouldReconnect: this.shouldReconnect,
      },
      () => {
        void this.restart({
          reason: 'deferred-restart-flush',
          source: trigger,
        }).catch((error) => {
          logger.warn('Deferred Gateway restart failed:', error);
        });
      },
    );
  }

  private trackRuntimeWorkEvent(payload: unknown): void {
    if (typeof payload !== 'object' || payload === null) {
      return;
    }

    const event = payload as Partial<ChatRuntimeEvent>;
    if (typeof event.runId !== 'string' || event.runId.length === 0 || typeof event.type !== 'string') {
      return;
    }
    if (event.producer === 'history') {
      return;
    }

    if (event.type === 'run.ended') {
      if (this.activeRuntimeRuns.delete(event.runId)) {
        this.flushDeferredRestartIfIdle(`runtime:${event.type}`);
      }
      return;
    }

    const now = Date.now();
    const existing = this.activeRuntimeRuns.get(event.runId);
    this.activeRuntimeRuns.set(event.runId, {
      startedAt: existing?.startedAt ?? now,
      lastEventAt: now,
      sessionKey: typeof event.sessionKey === 'string' ? event.sessionKey : existing?.sessionKey,
    });
  }

  /**
   * Get current Gateway status
   */
  getStatus(): GatewayStatus {
    return this.stateController.getStatus();
  }

  getDiagnostics(): GatewayDiagnosticsSnapshot {
    return {
      ...this.diagnostics,
      recentLifecycleEvents: [...this.lifecycleEvents],
    };
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
  async start(context?: GatewayLifecycleContext): Promise<void> {
    if (this.startLock) {
      this.recordLifecycleEvent('start_ignored', {
        reason: context?.reason ?? 'start-already-in-progress',
        source: context?.source ?? 'gateway-manager',
      });
      logger.debug('Gateway start ignored because a start flow is already in progress');
      return;
    }

    if (this.status.state === 'running') {
      this.recordLifecycleEvent('start_ignored', {
        reason: context?.reason ?? 'already-running',
        source: context?.source ?? 'gateway-manager',
      });
      logger.debug('Gateway already running, skipping start');
      return;
    }

    this.startLock = true;
    const startEpoch = this.lifecycleController.bump('start');
    this.recordLifecycleEvent('start_requested', {
      reason: context?.reason ?? (this.isAutoReconnectStart ? 'auto-reconnect' : 'manual-start'),
      source: context?.source ?? 'gateway-manager',
      details: {
        reconnectAttempts: this.reconnectAttempts,
      },
    });
    logger.info(`Gateway start requested (port=${this.status.port})`);
    this.lastSpawnSummary = null;
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
    this.setStatus({ state: 'starting', reconnectAttempts: this.reconnectAttempts, gatewayReady: false });
    this.resetGatewayReadyFallback();

    // Check if Python environment is ready (self-healing) asynchronously.
    // Fire-and-forget: only needs to run once, not on every retry.
    warmupManagedPythonReadiness();

    const t0 = Date.now();
    let tSpawned = 0;
    let tReady = 0;

    try {
      await runGatewayStartupSequence({
        port: this.status.port,
        ownedPid: this.process?.pid,
        shouldWaitForPortFree: process.platform === 'win32',
        hasOwnedProcess: () => this.process?.pid != null && this.ownsProcess,
        resetStartupStderrLines: () => {
          this.recentStartupStderrLines = [];
        },
        getStartupStderrLines: () => this.recentStartupStderrLines,
        assertLifecycle: (phase) => {
          this.lifecycleController.assert(startEpoch, phase);
        },
        findExistingGateway: async (port) => {
          // Always read the current process pid dynamically so that retries
          // don't treat a just-spawned gateway as an orphan.  The ownedPid
          // snapshot captured at start() entry is stale after startProcess()
          // replaces this.process — leading to the just-started pid being
          // immediately killed as a false orphan on the next retry iteration.
          return await findExistingGatewayProcess({ port, ownedPid: this.process?.pid });
        },
        connect: async (port, externalToken) => {
          await this.connect(port, externalToken);
        },
        onConnectedToExistingGateway: () => {
          // If the existing gateway is actually our own spawned UtilityProcess
          // (e.g. after a self-restart code=1012), keep ownership so that
          // stop() can still terminate the process during a restart() cycle.
          const isOwnProcess = this.process?.pid != null && this.ownsProcess;
          if (!isOwnProcess) {
            this.ownsProcess = false;
            this.setStatus({ pid: undefined });
          }

          // Treat a successful reconnect to the owned process as a restart
          // completion (e.g. after a Gateway code-1012 in-process restart).
          // This updates lastRestartCompletedAt so that flushDeferredRestart
          // drops any deferred restart requested before this reconnect,
          // avoiding a redundant kill+respawn cycle.
          if (isOwnProcess) {
            this.restartController.recordRestartCompleted();
          }

          this.startHealthCheck();
        },
        waitForPortFree: async (port) => {
          await waitForPortFree(port);
        },
        startProcess: async () => {
          await this.startProcess();
          tSpawned = Date.now();
        },
        waitForReady: async (port) => {
          await waitForGatewayReady({
            port,
            getProcessExitCode: () => this.processExitCode,
          });
          tReady = Date.now();
        },
        onConnectedToManagedGateway: () => {
          this.startHealthCheck();
          const tConnected = Date.now();
          logger.info('[metric] gateway.startup', {
            configSyncMs: tSpawned ? tSpawned - t0 : undefined,
            spawnToReadyMs: tReady && tSpawned ? tReady - tSpawned : undefined,
            readyToConnectMs: tReady ? tConnected - tReady : undefined,
            totalMs: tConnected - t0,
          });
        },
        runDoctorRepair: async () => await runOpenClawDoctorRepair(),
        onDoctorRepairSuccess: () => {
          this.setStatus({ state: 'starting', error: undefined, reconnectAttempts: 0 });
        },
        delay: async (ms) => {
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        logger.debug(error.message);
        return;
      }
      if (isGatewayPortOwnershipConflictError(error)) {
        const conflictPort = error.port ?? this.status.port;
        this.shouldReconnect = false;
        this.recordLifecycleEvent('start_blocked', {
          reason: 'external-gateway-port-owner',
          source: context?.source ?? 'gateway-start',
          details: {
            port: conflictPort,
            listenerPids: error.listenerPids ?? [],
            gatewayReady: error.gatewayReady ?? false,
          },
        });
        logger.warn(
          `Gateway startup blocked by external port owner on ${conflictPort}; auto-reconnect disabled`,
        );
      }
      logger.error(
        `Gateway start failed (port=${this.status.port}, reconnectAttempts=${this.reconnectAttempts}, spawn=${this.lastSpawnSummary ?? 'n/a'})`,
        error
      );
      this.setStatus({ state: 'error', error: String(error) });
      if (this.shouldReconnect) {
        logger.warn('Gateway start failed; scheduling auto-reconnect recovery');
        this.scheduleReconnect({
          reason: 'start-failed',
          source: context?.source ?? 'gateway-start',
          details: {
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
      throw error;
    } finally {
      this.startLock = false;
      this.restartController.flushDeferredRestart(
        'start:finally',
        {
          ...this.getRestartDeferralState(),
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart({
            reason: 'deferred-restart-flush',
            source: 'start:finally',
          }).catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        },
      );
    }
  }

  /**
   * Stop Gateway process
   */
  async stop(context?: GatewayLifecycleContext): Promise<void> {
    this.recordLifecycleEvent('stop_requested', {
      reason: context?.reason ?? 'manual-stop',
      source: context?.source ?? 'gateway-manager',
    });
    logger.info('Gateway stop requested');
    this.lifecycleController.bump('stop');
    // Disable auto-reconnect
    this.shouldReconnect = false;

    // Clear all timers
    this.clearAllTimers();

    // If this manager is attached to an external gateway process, ask it to shut down
    // over protocol before closing the socket.
    if (!this.ownsProcess && this.ws?.readyState === WebSocket.OPEN && this.externalShutdownSupported !== false) {
      try {
        await this.rpc('shutdown', undefined, 5000);
        this.externalShutdownSupported = true;
      } catch (error) {
        if (this.isUnsupportedShutdownError(error)) {
          this.externalShutdownSupported = false;
          logger.info('External Gateway does not support "shutdown"; skipping shutdown RPC for future stops');
        } else {
          logger.warn('Failed to request shutdown for externally managed Gateway:', error);
        }
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

    // Kill process
    if (this.process && this.ownsProcess) {
      const child = this.process;
      await terminateOwnedGatewayProcess(child);

      if (this.process === child) {
        this.process = null;
      }
    }
    this.ownsProcess = false;

    clearPendingGatewayRequests(this.pendingRequests, new Error('Gateway stopped'));
    this.blockingRpcRequestIds.clear();
    this.activeRuntimeRuns.clear();

    this.restartController.resetDeferredRestart();
    this.isAutoReconnectStart = false;
    this.diagnostics.consecutiveHeartbeatMisses = 0;
    this.setStatus({ state: 'stopped', error: undefined, pid: undefined, connectedAt: undefined, uptime: undefined, gatewayReady: undefined });
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
    await terminateOwnedGatewayProcess(child);
    if (this.process === child) {
      this.process = null;
    }
    this.ownsProcess = false;
    this.setStatus({ pid: undefined });
    return true;
  }

  /**
   * Restart Gateway process
   */
  async restart(context?: GatewayLifecycleContext): Promise<void> {
    const restartDeferralState = this.getRestartDeferralState(context);
    if (this.restartController.isRestartDeferred(restartDeferralState)) {
      this.recordLifecycleEvent('restart_deferred', {
        reason: context?.reason ?? 'restart-deferred',
        source: context?.source ?? 'gateway-manager',
        details: {
          state: restartDeferralState.state,
          startLock: restartDeferralState.startLock,
          activeRunCount: restartDeferralState.activeRunCount,
          blockingRpcCount: restartDeferralState.blockingRpcCount,
        },
      });
      this.restartController.markDeferredRestart(context?.reason ?? 'restart', restartDeferralState);
      return;
    }

    if (this.restartInFlight) {
      this.recordLifecycleEvent('restart_joined_in_flight', {
        reason: context?.reason ?? 'restart-in-flight',
        source: context?.source ?? 'gateway-manager',
      });
      logger.debug('Gateway restart already in progress, joining existing request');
      await this.restartInFlight;
      return;
    }

    const decision = this.restartGovernor.decide();
    if (!decision.allow) {
      const observability = this.restartGovernor.getObservability();
      this.recordLifecycleEvent('restart_suppressed', {
        reason: decision.reason,
        source: context?.source ?? 'gateway-restart-governor',
        details: {
          retryAfterMs: decision.retryAfterMs,
          requestedReason: context?.reason,
          suppressedTotal: observability.suppressed_total,
          executedTotal: observability.executed_total,
        },
      });
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
      return;
    }

    const pidBefore = this.status.pid;
    this.recordLifecycleEvent('restart_requested', {
      reason: context?.reason ?? 'manual-restart',
      source: context?.source ?? 'gateway-manager',
      details: {
        pidBefore,
      },
    });
    logger.info(`[gateway-refresh] mode=restart requested pidBefore=${pidBefore ?? 'n/a'}`);
    this.restartInFlight = (async () => {
      await this.stop({
        reason: `restart:${context?.reason ?? 'manual-restart'}`,
        source: context?.source ?? 'gateway-manager',
      });
      try {
        await this.start({
          reason: `restart:${context?.reason ?? 'manual-restart'}`,
          source: context?.source ?? 'gateway-manager',
        });
      } catch (err) {
        if (isGatewayPortOwnershipConflictError(err)) {
          const conflictPort = err.port ?? this.status.port;
          this.shouldReconnect = false;
          logger.warn(
            `Gateway restart blocked by external port owner on ${conflictPort}; auto-reconnect remains disabled`,
          );
          throw err;
        }
        // stop() set shouldReconnect=false. Restore it so the gateway
        // can self-heal via scheduleReconnect() instead of dying permanently.
        logger.warn('Gateway restart: start() failed after stop(), enabling auto-reconnect recovery', err);
        this.shouldReconnect = true;
        this.scheduleReconnect({
          reason: 'restart-start-failed',
          source: context?.source ?? 'gateway-restart',
          details: {
            requestedReason: context?.reason,
            error: err instanceof Error ? err.message : String(err),
          },
        });
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
      this.recordLifecycleEvent('restart_completed', {
        reason: context?.reason ?? 'manual-restart',
        source: context?.source ?? 'gateway-manager',
        details: {
          pidBefore,
          pidAfter: this.status.pid,
          suppressedTotal: observability.suppressed_total,
          executedTotal: observability.executed_total,
        },
      });
    } finally {
      this.restartInFlight = null;
      this.restartController.flushDeferredRestart(
        'restart:finally',
        {
          ...this.getRestartDeferralState(),
          shouldReconnect: this.shouldReconnect,
        },
        () => {
          void this.restart({
            reason: 'deferred-restart-flush',
            source: 'restart:finally',
          }).catch((error) => {
            logger.warn('Deferred Gateway restart failed:', error);
          });
        },
      );
    }
  }

  /**
   * Debounced restart — coalesces multiple rapid restart requests into a
   * single restart after `delayMs` of inactivity.  This prevents the
   * cascading stop/start cycles that occur when provider:save,
   * provider:setDefault and channel:saveConfig all fire within seconds
   * of each other during setup.
   */
  debouncedRestart(delayMs = 2000, context?: GatewayLifecycleContext): void {
    this.recordLifecycleEvent('restart_debounced', {
      reason: context?.reason ?? 'debounced-restart',
      source: context?.source ?? 'gateway-manager',
      details: {
        delayMs,
      },
    });
    this.restartController.debouncedRestart(delayMs, () => {
      void this.restart({
        reason: context?.reason ?? 'debounced-restart',
        source: context?.source ?? 'gateway-manager',
      }).catch((err) => {
        logger.warn('Debounced Gateway restart failed:', err);
      });
    });
  }

  /**
   * Ask the Gateway process to reload config in-place when possible.
   * Falls back to restart on unsupported platforms or signaling failures.
   */
  async reload(context?: GatewayLifecycleContext): Promise<void> {
    await this.refreshReloadPolicy();

    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.info(
        `[gateway-refresh] mode=reload result=policy_forced_restart policy=${this.reloadPolicy.mode}`,
      );
      await this.restart({
        reason: context?.reason ?? `reload-policy-${this.reloadPolicy.mode}`,
        source: context?.source ?? 'gateway-reload',
      });
      return;
    }

    const restartDeferralState = this.getRestartDeferralState(context);
    if (this.restartController.isRestartDeferred(restartDeferralState)) {
      this.recordLifecycleEvent('reload_deferred', {
        reason: context?.reason ?? 'reload-deferred',
        source: context?.source ?? 'gateway-reload',
        details: {
          state: restartDeferralState.state,
          startLock: restartDeferralState.startLock,
          activeRunCount: restartDeferralState.activeRunCount,
          blockingRpcCount: restartDeferralState.blockingRpcCount,
        },
      });
      this.restartController.markDeferredRestart(context?.reason ?? 'reload', restartDeferralState);
      return;
    }

    const pidBefore = this.process?.pid;
    logger.info(`[gateway-refresh] mode=reload requested pid=${pidBefore ?? 'n/a'} state=${this.status.state}`);

    if (!this.process?.pid || this.status.state !== 'running') {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=not_running');
      logger.warn('Gateway reload requested while not running; falling back to restart');
      await this.restart({
        reason: 'reload-fallback-not-running',
        source: context?.source ?? 'gateway-reload',
      });
      return;
    }

    const connectedForMs = this.status.connectedAt
      ? Date.now() - this.status.connectedAt
      : Number.POSITIVE_INFINITY;

    // Avoid signaling a process that just came up; it will already read latest config.
    if (connectedForMs < 8000) {
      logger.info(
        `[gateway-refresh] mode=reload result=skipped_recent_connect connectedForMs=${connectedForMs} pid=${this.process.pid}`,
      );
      logger.info(`Gateway connected ${connectedForMs}ms ago, skipping reload signal`);
      return;
    }

    if (process.platform === 'win32') {
      // Windows does not support SIGUSR1 for in-process reload.
      // Fall back to a full restart.  The connectedForMs < 8000 guard above
      // already skips unnecessary restarts for recently-started processes.
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=windows');
      await this.restart({
        reason: 'reload-fallback-windows',
        source: context?.source ?? 'gateway-reload',
      });
      return;
    }

    try {
      process.kill(this.process.pid, 'SIGUSR1');
      logger.info(`Sent SIGUSR1 to Gateway for config reload (pid=${this.process.pid})`);
      // Some gateway builds do not handle SIGUSR1 as an in-process reload.
      // If process state doesn't recover quickly, fall back to restart.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      if (this.status.state !== 'running' || !this.process?.pid) {
        logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=post_signal_unhealthy');
        logger.warn('Gateway did not stay running after reload signal, falling back to restart');
        await this.restart({
          reason: 'reload-fallback-post-signal-unhealthy',
          source: context?.source ?? 'gateway-reload',
        });
      } else {
        const pidAfter = this.process.pid;
        logger.info(
          `[gateway-refresh] mode=reload result=applied_in_place pidBefore=${pidBefore} pidAfter=${pidAfter}`,
        );
      }
    } catch (error) {
      logger.warn('[gateway-refresh] mode=reload result=fallback_restart cause=signal_error');
      logger.warn('Gateway reload signal failed, falling back to restart:', error);
      await this.restart({
        reason: 'reload-fallback-signal-error',
        source: context?.source ?? 'gateway-reload',
        details: {
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /**
   * Debounced reload — coalesces multiple rapid config-change events into one
   * in-process reload when possible.
   */
  debouncedReload(delayMs?: number, context?: GatewayLifecycleContext): void {
    void this.refreshReloadPolicy();
    const effectiveDelay = delayMs ?? this.reloadPolicy.debounceMs;
    if (this.reloadPolicy.mode === 'off' || this.reloadPolicy.mode === 'restart') {
      logger.debug(
        `Gateway reload policy=${this.reloadPolicy.mode}; routing debouncedReload to debouncedRestart (${effectiveDelay}ms)`,
      );
      this.debouncedRestart(effectiveDelay, {
        reason: context?.reason ?? `debounced-reload-policy-${this.reloadPolicy.mode}`,
        source: context?.source ?? 'gateway-reload',
      });
      return;
    }

    if (this.reloadDebounceTimer) {
      clearTimeout(this.reloadDebounceTimer);
    }
    this.recordLifecycleEvent('reload_debounced', {
      reason: context?.reason ?? 'debounced-reload',
      source: context?.source ?? 'gateway-manager',
      details: {
        delayMs: effectiveDelay,
        policy: this.reloadPolicy.mode,
      },
    });
    logger.debug(`Gateway reload debounced (will fire in ${effectiveDelay}ms)`);
    this.reloadDebounceTimer = setTimeout(() => {
      this.reloadDebounceTimer = null;
      void this.reload({
        reason: context?.reason ?? 'debounced-reload',
        source: context?.source ?? 'gateway-manager',
      }).catch((err) => {
        logger.warn('Debounced Gateway reload failed:', err);
      });
    }, effectiveDelay);
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
    this.taskLedgerMonitor.stop();
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
    if (this.status.state !== 'running' || this.status.gatewayReady) {
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
    if (this.status.state !== 'running' || this.status.gatewayReady) {
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
      if (this.status.state === 'running' && !this.status.gatewayReady) {
        logger.info('Gateway ready fallback RPC router probe succeeded');
        this.resetGatewayReadyFallback();
        this.setStatus({ gatewayReady: true });
      }
    } catch (error) {
      this.capabilityMonitor.recordCoreProbe({
        ok: false,
        checkedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.warn('Gateway ready fallback RPC router probe failed; waiting for gateway.ready event or heartbeat recovery:', error);
      if (this.status.state === 'running' && !this.status.gatewayReady) {
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
    const id = crypto.randomUUID();
    const trackBlockingRequest = this.shouldTrackBlockingRpcMethod(method);
    return await new Promise<T>((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('Gateway not connected'));
        return;
      }

      if (trackBlockingRequest) {
        this.blockingRpcRequestIds.add(id);
      }

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
        this.capabilityMonitor.recordCapabilitySuccess(capability, result, Date.now() - startedAt);
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
    }).finally(() => {
      this.blockingRpcRequestIds.delete(id);
      this.flushDeferredRestartIfIdle(`rpc:${method}:settled`);
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
        this.capabilityMonitor.recordOpenClawHealth(healthResult.value);
      }
      if (statusResult.status === 'fulfilled') {
        this.capabilityMonitor.recordOpenClawStatus(statusResult.value);
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
  private async startProcess(): Promise<void> {
    const launchContext = await prepareGatewayLaunchContext(this.status.port);
    await unloadLaunchctlGatewayService();
    this.processExitCode = null;

    // Per-process dedup map for stderr lines — resets on each new spawn.
    const stderrDedup = new Map<string, number>();
    const stdoutDedup = new Map<string, number>();

    const { child, lastSpawnSummary } = await launchGatewayProcess({
      port: this.status.port,
      launchContext,
      sanitizeSpawnArgs: (args) => this.sanitizeSpawnArgs(args),
      getCurrentState: () => this.status.state,
      getShouldReconnect: () => this.shouldReconnect,
      onStdoutLine: (line) => {
        const classified = classifyGatewayStdoutMessage(line);
        if (classified.level === 'drop') return;

        const count = (stdoutDedup.get(classified.normalized) ?? 0) + 1;
        stdoutDedup.set(classified.normalized, count);
        if (count > 1) {
          if (count % 50 === 0) {
            logger.debug(`[Gateway stdout] (suppressed ${count} repeats) ${classified.normalized}`);
          }
          return;
        }

        if (classified.level === 'info') {
          logger.info(`[Gateway stdout] ${classified.normalized}`);
          return;
        }
        logger.debug(`[Gateway stdout] ${classified.normalized}`);
      },
      onStderrLine: (line) => {
        recordGatewayStartupStderrLine(this.recentStartupStderrLines, line);
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
      onExit: (exitedChild, code) => {
        const expectedExit = !this.shouldReconnect;
        this.recordLifecycleEvent('process_exit', {
          reason: expectedExit ? 'expected-process-exit' : 'unexpected-process-exit',
          source: 'utility-process',
          details: {
            code,
            expected: expectedExit,
            childPid: exitedChild.pid,
          },
        });
        this.processExitCode = code;
        this.ownsProcess = false;
        this.connectionMonitor.clear();
        if (this.process === exitedChild) {
          this.process = null;
        }
        this.emit('exit', code);

        if (this.status.state === 'running') {
          this.setStatus({ state: 'stopped' });
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
        this.scheduleReconnect({
          reason: 'process-exit',
          source: 'utility-process',
          details: {
            code,
            expected: expectedExit,
            childPid: exitedChild.pid,
          },
        });
      },
      onError: () => {
        this.ownsProcess = false;
        if (this.process === child) {
          this.process = null;
        }
      },
    });

    this.process = child;
    this.ownsProcess = true;
    logger.debug(`Gateway manager now owns process pid=${child.pid ?? 'unknown'}`);
    this.lastSpawnSummary = lastSpawnSummary;
  }

  /**
   * Connect WebSocket to Gateway
   */
  private async connect(port: number, _externalToken?: string): Promise<void> {
    this.ws = await connectGatewaySocket({
      port,
      deviceIdentity: this.deviceIdentity,
      platform: process.platform,
      pendingRequests: this.pendingRequests,
      getToken: async () => await import('../utils/store').then(({ getSetting }) => getSetting('gatewayToken')),
      onHandshakeComplete: (ws) => {
        this.ws = ws;
        ws.on('pong', () => {
          this.connectionMonitor.markAlive('pong');
          this.recordGatewayAlive();
        });
        this.recordGatewayAlive();
        this.setStatus({
          state: 'running',
          port,
          connectedAt: Date.now(),
        });
        this.startPing();
        this.taskLedgerMonitor.start();
        this.scheduleGatewayReadyFallback();
      },
      onMessage: (message) => {
        this.handleMessage(message);
      },
      onCloseAfterHandshake: (closeCode) => {
        this.connectionMonitor.clear();
        this.taskLedgerMonitor.stop();
        this.recordSocketClose(closeCode);
        this.recordLifecycleEvent('websocket_close', {
          reason: closeCode === 1012 ? 'gateway-in-process-restart' : 'websocket-close',
          source: 'gateway-websocket',
          details: {
            closeCode,
          },
        });
        this.diagnostics.consecutiveHeartbeatMisses = 0;
        if (this.status.state === 'running') {
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
            this.scheduleReconnect({
              reason: closeCode === 1012 ? 'gateway-in-process-restart' : 'websocket-close',
              source: 'gateway-websocket',
              details: {
                closeCode,
              },
            });
          }
        }
      },
    });
  }

  /**
   * Handle incoming WebSocket message
   */
  private handleMessage(message: unknown): void {
    this.connectionMonitor.markAlive('message');
    this.recordGatewayAlive();

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
        void this.restart({
          reason: 'heartbeat-timeout',
          source: 'gateway-heartbeat',
          details: {
            consecutiveMisses,
            timeoutMs,
            pid,
          },
        }).catch((error) => {
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
      void this.restart({
        reason: 'initial-gateway-ready-heartbeat-timeout',
        source: 'gateway-heartbeat',
      }).catch((error) => {
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
  private scheduleReconnect(context?: GatewayLifecycleContext): void {
    const decision = getReconnectScheduleDecision({
      shouldReconnect: this.shouldReconnect,
      hasReconnectTimer: this.reconnectTimer !== null,
      reconnectAttempts: this.reconnectAttempts,
      maxAttempts: this.reconnectConfig.maxAttempts,
      baseDelay: this.reconnectConfig.baseDelay,
      maxDelay: this.reconnectConfig.maxDelay,
    });

    if (decision.action === 'skip') {
      this.recordLifecycleEvent('reconnect_skipped', {
        reason: decision.reason,
        source: context?.source ?? 'gateway-reconnect',
        details: {
          requestedReason: context?.reason,
        },
      });
      logger.debug(`Gateway reconnect skipped (${decision.reason})`);
      return;
    }

    if (decision.action === 'already-scheduled') {
      this.recordLifecycleEvent('reconnect_already_scheduled', {
        reason: context?.reason ?? 'already-scheduled',
        source: context?.source ?? 'gateway-reconnect',
      });
      return;
    }

    if (decision.action === 'fail') {
      this.recordLifecycleEvent('reconnect_failed', {
        reason: 'max-attempts-reached',
        source: context?.source ?? 'gateway-reconnect',
        details: {
          attempts: decision.attempts,
          maxAttempts: decision.maxAttempts,
          requestedReason: context?.reason,
        },
      });
      logger.error(`Gateway reconnect failed: max attempts reached (${decision.maxAttempts})`);
      this.setStatus({
        state: 'error',
        error: 'Failed to reconnect after maximum attempts',
        reconnectAttempts: this.reconnectAttempts
      });
      return;
    }

    const cooldownRemaining = Math.max(0, GatewayManager.RESTART_COOLDOWN_MS - (Date.now() - this.lastRestartAt));
    const { delay, nextAttempt, maxAttempts } = decision;
    const effectiveDelay = Math.max(delay, cooldownRemaining);
    this.reconnectAttempts = nextAttempt;
    this.recordLifecycleEvent('reconnect_scheduled', {
      reason: context?.reason ?? 'auto-reconnect',
      source: context?.source ?? 'gateway-reconnect',
      details: {
        delayMs: effectiveDelay,
        attempt: nextAttempt,
        maxAttempts,
        cooldownRemaining,
        ...(context?.details ?? {}),
      },
    });
    logger.warn(`Scheduling Gateway reconnect attempt ${nextAttempt}/${maxAttempts} in ${effectiveDelay}ms`);

    this.setStatus({
      state: 'reconnecting',
      reconnectAttempts: this.reconnectAttempts
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
        await this.start({
          reason: context?.reason ?? 'auto-reconnect',
          source: context?.source ?? 'gateway-reconnect',
        });
        this.reconnectSuccessTotal += 1;
        this.emitReconnectMetric('success', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
        });
        this.reconnectAttempts = 0;
      } catch (error) {
        logger.error('Gateway reconnection attempt failed:', error);
        this.emitReconnectMetric('failure', {
          attemptNo,
          maxAttempts,
          delayMs: effectiveDelay,
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect({
          reason: 'reconnect-attempt-failed',
          source: context?.source ?? 'gateway-reconnect',
          details: {
            previousReason: context?.reason,
            error: error instanceof Error ? error.message : String(error),
          },
        });
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
