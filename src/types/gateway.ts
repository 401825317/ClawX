/**
 * Gateway Type Definitions
 * Types for Gateway communication and data structures
 */

/**
 * Gateway connection status
 */
export interface GatewayStatus {
  state: 'stopped' | 'starting' | 'running' | 'error' | 'reconnecting';
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

/**
 * Gateway RPC response
 */
export interface GatewayRpcResponse<T = unknown> {
  success: boolean;
  result?: T;
  error?: string;
}

/**
 * Gateway health check response
 */
export interface GatewayCapabilityProbe {
  state: 'unknown' | 'healthy' | 'degraded';
  checkedAt?: number;
  durationMs?: number;
  error?: string;
  payload?: unknown;
}

export interface GatewayLifecycleEvent {
  at: number;
  event: string;
  state: GatewayStatus['state'];
  port: number;
  pid?: number;
  reason?: string;
  source?: string;
  details?: Record<string, unknown>;
}

export interface GatewayCapabilitySnapshot {
  core: {
    process: GatewayStatus['state'];
    transport: 'connected' | 'disconnected';
    rpcRouter: 'unknown' | 'ready' | 'blocked';
    lastProbe?: {
      ok: boolean;
      checkedAt: number;
      durationMs?: number;
      error?: string;
    };
  };
  openclawHealth: GatewayCapabilityProbe;
  openclawStatus: GatewayCapabilityProbe;
  presence: GatewayCapabilityProbe;
  channels: GatewayCapabilityProbe;
  memory: GatewayCapabilityProbe;
  diagnostics: {
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
  };
}

export interface GatewayHealth {
  ok: boolean;
  error?: string;
  uptime?: number;
  version?: string;
  capabilities?: GatewayCapabilitySnapshot;
  openclawHealth?: unknown;
  presence?: unknown;
}

/**
 * Gateway notification (server-initiated event)
 */
export interface GatewayNotification {
  method: string;
  params?: unknown;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: 'openai' | 'anthropic' | 'ollama' | 'custom';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  enabled: boolean;
}
