import { logger } from '../utils/logger';
import { LifecycleSupersededError } from './lifecycle-controller';
import {
  connectGatewayWithStartupRetry,
  getGatewayStartupRecoveryAction,
  isGatewayConnectRetryExhaustedError,
} from './startup-recovery';
import { runPrelaunchPhase, type PrelaunchPhaseSample } from './prelaunch-liveness';
import { markChannelStartupSnapshotConnected } from '../utils/channel-config';

export interface ExistingGatewayInfo {
  port: number;
  pid?: number;
  externalToken?: string;
  /** Provenance survives connection handoff so restart can only shut down verified runtimes. */
  provenance: 'managed-process' | 'verified-orphan' | 'unknown-external';
}

type StartupHooks = {
  port: number;
  ownedPid?: never; // Removed: pid is now read dynamically in findExistingGateway to avoid stale-snapshot bug
  shouldWaitForPortFree: boolean;
  maxStartAttempts?: number;
  /** Returns true when the manager still owns a living Gateway process (e.g. after a code-1012 in-process restart). */
  hasOwnedProcess: () => boolean;
  resetStartupStderrLines: () => void;
  getStartupStderrLines: () => string[];
  assertLifecycle: (phase: string) => void;
  findExistingGateway: (port: number) => Promise<ExistingGatewayInfo | null>;
  connect: (port: number, externalToken?: string) => Promise<void>;
  onConnectAttempt?: (attemptNo: number, maxAttempts: number) => void;
  onConnectedToExistingGateway: (connection: {
    gateway: ExistingGatewayInfo;
    source: 'discovered' | 'owned-process';
  }) => void;
  waitForPortFree: (port: number) => Promise<void>;
  startProcess: () => Promise<void>;
  waitForReady: (port: number) => Promise<void>;
  afterManagedGatewayReady?: () => Promise<void>;
  onConnectedToManagedGateway: () => void;
  runDoctorRepair: () => Promise<boolean>;
  onDoctorRepairSuccess: () => void;
  delay: (ms: number) => Promise<void>;
  canRecoverStartup?: () => boolean;
};

async function runStartupPhase<T>(
  phase: string,
  task: () => T | Promise<T>,
): Promise<T> {
  const { result } = await runPrelaunchPhase(phase, task, (phaseSample) => {
    logStartupPhaseSample(phaseSample);
  });
  return result;
}

function logStartupPhaseSample(sample: PrelaunchPhaseSample): void {
  logger.info('[metric] gateway.startup.phase', sample);
  if (sample.slow) {
    logger.warn('[gateway-startup] Slow main-process startup phase', sample);
  }
}

async function connectWithStartupRetry(
  hooks: StartupHooks,
  port: number,
  externalToken?: string,
): Promise<void> {
  await connectGatewayWithStartupRetry({
    connect: hooks.connect,
    port,
    externalToken,
    delay: hooks.delay,
    beforeAttempt: (attemptNo, maxAttempts) => {
      hooks.assertLifecycle('start/connect-retry');
      hooks.onConnectAttempt?.(attemptNo, maxAttempts);
    },
    logWarn: (message) => logger.warn(message),
    logInfo: (message) => logger.info(message),
  });
}

export async function runGatewayStartupSequence(hooks: StartupHooks): Promise<void> {
  let configRepairAttempted = false;
  let startAttempts = 0;
  const maxStartAttempts = hooks.maxStartAttempts ?? 3;

  while (true) {
    startAttempts++;
    hooks.assertLifecycle('start');
    hooks.resetStartupStderrLines();

    try {
      logger.debug('Checking for existing Gateway...');
      const existing = await runStartupPhase('find-existing-gateway', () => hooks.findExistingGateway(hooks.port));
      hooks.assertLifecycle('start/find-existing');
      if (existing) {
        logger.debug(`Found existing Gateway on port ${existing.port}`);
        await runStartupPhase(
          'connect-existing-gateway',
          () => connectWithStartupRetry(hooks, existing.port, existing.externalToken),
        );
        hooks.assertLifecycle('start/connect-existing');
        markChannelStartupSnapshotConnected();
        hooks.onConnectedToExistingGateway({ gateway: existing, source: 'discovered' });
        return;
      }

      // When the Gateway did an in-process restart (WS close 1012), the
      // UtilityProcess is still alive but its WS server may be mid-rebuild,
      // so findExistingGateway's quick probe returns null.  Rather than
      // waiting for the port to free (it never will — the process holds it)
      // and then spawning a duplicate, wait for the existing process to
      // become ready and reconnect to it.
      if (hooks.hasOwnedProcess()) {
        logger.info('Owned Gateway process still alive (likely in-process restart); waiting for it to become ready');
        await runStartupPhase('wait-for-ready-owned-gateway', () => hooks.waitForReady(hooks.port));
        hooks.assertLifecycle('start/wait-ready-owned');
        await runStartupPhase(
          'after-ready-owned-gateway',
          () => hooks.afterManagedGatewayReady?.(),
        );
        hooks.assertLifecycle('start/after-ready-owned');
        await runStartupPhase(
          'connect-owned-gateway',
          () => connectWithStartupRetry(hooks, hooks.port),
        );
        hooks.assertLifecycle('start/connect-owned');
        markChannelStartupSnapshotConnected();
        hooks.onConnectedToExistingGateway({
          gateway: { port: hooks.port, provenance: 'managed-process' },
          source: 'owned-process',
        });
        return;
      }

      logger.debug('No existing Gateway found, starting new process...');

      if (hooks.shouldWaitForPortFree) {
        await runStartupPhase('wait-for-port-free', () => hooks.waitForPortFree(hooks.port));
        hooks.assertLifecycle('start/wait-port');
      }

      await runStartupPhase('start-gateway-process', () => hooks.startProcess());
      hooks.assertLifecycle('start/start-process');

      await runStartupPhase('wait-for-ready-gateway', () => hooks.waitForReady(hooks.port));
      hooks.assertLifecycle('start/wait-ready');

      await runStartupPhase(
        'after-ready-gateway',
        () => hooks.afterManagedGatewayReady?.(),
      );
      hooks.assertLifecycle('start/after-ready');

      await runStartupPhase(
        'connect-gateway',
        () => connectWithStartupRetry(hooks, hooks.port),
      );
      hooks.assertLifecycle('start/connect');

      markChannelStartupSnapshotConnected();
      hooks.onConnectedToManagedGateway();
      return;
    } catch (error) {
      if (error instanceof LifecycleSupersededError) {
        throw error;
      }

      // connectGatewayWithStartupRetry owns the complete connection retry
      // budget. Re-entering this outer startup loop would replay it after a
      // process restart (formerly 7 connection attempts x 3 start attempts).
      if (isGatewayConnectRetryExhaustedError(error)) {
        throw error;
      }

      if (hooks.canRecoverStartup?.() === false) {
        throw error;
      }

      const recoveryAction = getGatewayStartupRecoveryAction({
        startupError: error,
        startupStderrLines: hooks.getStartupStderrLines(),
        configRepairAttempted,
        attempt: startAttempts,
        maxAttempts: maxStartAttempts,
      });

      if (recoveryAction === 'repair') {
        configRepairAttempted = true;
        logger.warn(
          'Detected invalid OpenClaw config during Gateway startup; running doctor repair before retry',
        );
        const repaired = await hooks.runDoctorRepair();
        if (repaired) {
          logger.info('OpenClaw doctor repair completed; retrying Gateway startup');
          hooks.onDoctorRepairSuccess();
          continue;
        }
        logger.error('OpenClaw doctor repair failed; not retrying Gateway startup');
      }

      if (recoveryAction === 'retry') {
        logger.warn(`Transient start error: ${String(error)}. Retrying... (${startAttempts}/${maxStartAttempts})`);
        await hooks.delay(1000);
        continue;
      }

      throw error;
    }
  }
}
