import { app, utilityProcess } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { getOpenClawDir, getOpenClawEntryPath } from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { isPythonReady, setupManagedPython } from '../utils/uv-setup';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import { probeGatewayReady } from './ws-client';

const PYTHON_STARTUP_READINESS_DELAY_MS = 45_000;
const PYTHON_STARTUP_READINESS_MIN_INTERVAL_MS = 6 * 60 * 60_000;

let pythonReadinessWarmupTimer: NodeJS.Timeout | null = null;
let lastPythonReadinessWarmupAt = 0;

export function warmupManagedPythonReadiness(): void {
  if (process.env.CLAWX_DISABLE_PYTHON_STARTUP_WARMUP === '1') return;

  const now = Date.now();
  if (pythonReadinessWarmupTimer || now - lastPythonReadinessWarmupAt < PYTHON_STARTUP_READINESS_MIN_INTERVAL_MS) {
    return;
  }

  pythonReadinessWarmupTimer = setTimeout(() => {
    pythonReadinessWarmupTimer = null;
    lastPythonReadinessWarmupAt = Date.now();

    void isPythonReady().then((pythonReady) => {
      if (!pythonReady) {
        if (process.env.CLAWX_ENABLE_STARTUP_PYTHON_REPAIR === '1') {
          logger.info('Python environment missing or incomplete, attempting delayed background repair...');
          void setupManagedPython().catch((err) => {
            logger.error('Background Python repair failed:', err);
          });
          return;
        }

        logger.info(
          'Python environment missing or incomplete; startup repair skipped. ' +
          'Python-dependent features will repair the runtime when explicitly requested.',
        );
      }
    }).catch((err) => {
      logger.error('Failed to check Python environment:', err);
    });
  }, PYTHON_STARTUP_READINESS_DELAY_MS);
  pythonReadinessWarmupTimer.unref?.();
}

export async function terminateOwnedGatewayProcess(child: Electron.UtilityProcess): Promise<void> {
  const terminateWindowsProcessTree = async (pid: number): Promise<void> => {
    const cp = await import('child_process');
    await new Promise<void>((resolve) => {
      cp.exec(`taskkill /F /PID ${pid} /T`, { timeout: 5000, windowsHide: true }, () => resolve());
    });
  };

  await new Promise<void>((resolve) => {
    let exited = false;

    // Register a single exit listener before any kill attempt to avoid
    // the race where exit fires between two separate `once('exit')` calls.
    child.once('exit', () => {
      exited = true;
      clearTimeout(timeout);
      resolve();
    });

    const pid = child.pid;
    logger.info(`Sending kill to Gateway process (pid=${pid ?? 'unknown'})`);

    if (process.platform === 'win32' && pid) {
      void terminateWindowsProcessTree(pid).catch((err) => {
        logger.warn(`Windows process-tree kill failed for Gateway pid=${pid}:`, err);
      });
    } else {
      try {
        child.kill();
      } catch {
        // ignore if already exited
      }
    }

    const timeout = setTimeout(() => {
      if (!exited) {
        logger.warn(`Gateway did not exit in time, force-killing (pid=${pid ?? 'unknown'})`);
        if (pid) {
          if (process.platform === 'win32') {
            void terminateWindowsProcessTree(pid).catch((err) => {
              logger.warn(`Forced Windows process-tree kill failed for Gateway pid=${pid}:`, err);
            });
          } else {
            try {
              process.kill(pid, 'SIGKILL');
            } catch {
              // ignore
            }
          }
        }
      }
      resolve();
    }, 5000);
  });
}

export async function unloadLaunchctlGatewayService(): Promise<void> {
  if (process.platform !== 'darwin') return;

  try {
    const uid = process.getuid?.();
    if (uid === undefined) return;

    const launchdLabel = 'ai.openclaw.gateway';
    const serviceTarget = `gui/${uid}/${launchdLabel}`;
    const cp = await import('child_process');
    const fsPromises = await import('fs/promises');
    const os = await import('os');

    const loaded = await new Promise<boolean>((resolve) => {
      cp.exec(`launchctl print ${serviceTarget}`, { timeout: 5000 }, (err) => {
        resolve(!err);
      });
    });

    if (!loaded) return;

    logger.info(`Unloading launchctl service ${serviceTarget} to prevent auto-respawn`);
    await new Promise<void>((resolve) => {
      cp.exec(`launchctl bootout ${serviceTarget}`, { timeout: 10000 }, (err) => {
        if (err) {
          logger.warn(`Failed to bootout launchctl service: ${err.message}`);
        } else {
          logger.info('Successfully unloaded launchctl gateway service');
        }
        resolve();
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    try {
      const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
      await fsPromises.access(plistPath);
      await fsPromises.unlink(plistPath);
      logger.info(`Removed legacy launchd plist to prevent reload on next login: ${plistPath}`);
    } catch {
      // File doesn't exist or can't be removed -- not fatal
    }
  } catch (err) {
    logger.warn('Error while unloading launchctl gateway service:', err);
  }
}

export async function waitForPortFree(port: number, timeoutMs = 30000): Promise<void> {
  const net = await import('net');
  const start = Date.now();
  const pollInterval = 500;
  let logged = false;

  while (Date.now() - start < timeoutMs) {
    const available = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    });

    if (available) {
      const elapsed = Date.now() - start;
      if (elapsed > pollInterval) {
        logger.info(`Port ${port} became available after ${elapsed}ms`);
      }
      return;
    }

    if (!logged) {
      logger.info(`Waiting for port ${port} to become available (Windows TCP TIME_WAIT)...`);
      logged = true;
    }
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  logger.error(`Port ${port} still occupied after ${timeoutMs}ms; aborting startup to avoid port conflict`);
  throw new Error(`Port ${port} still occupied after ${timeoutMs}ms`);
}

async function getListeningProcessIds(port: number): Promise<string[]> {
  const cmd = process.platform === 'win32'
    ? `netstat -ano | findstr :${port}`
    : `lsof -i :${port} -sTCP:LISTEN -t`;

  const cp = await import('child_process');
  const { stdout } = await new Promise<{ stdout: string }>((resolve) => {
    cp.exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve({ stdout: '' });
      } else {
        resolve({ stdout });
      }
    });
  });

  if (!stdout.trim()) {
    return [];
  }

  if (process.platform === 'win32') {
    const pids: string[] = [];
    for (const line of stdout.trim().split(/\r?\n/)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 5 && parts[3] === 'LISTENING') {
        pids.push(parts[4]);
      }
    }
    return [...new Set(pids)];
  }

  return [...new Set(stdout.trim().split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

export const GATEWAY_PORT_OWNERSHIP_CONFLICT = 'GATEWAY_PORT_OWNERSHIP_CONFLICT' as const;

export interface GatewayPortOwnershipConflict {
  code: typeof GATEWAY_PORT_OWNERSHIP_CONFLICT;
  port?: number;
  listenerPids?: readonly string[];
  gatewayReady?: boolean;
}

export class GatewayPortOwnershipConflictError extends Error {
  readonly code = GATEWAY_PORT_OWNERSHIP_CONFLICT;

  constructor(
    readonly port: number,
    readonly listenerPids: string[],
    readonly gatewayReady: boolean,
  ) {
    const owner = listenerPids.length > 0
      ? `PID ${listenerPids.join(', ')}`
      : 'an unknown process';
    super(
      `Gateway port ${port} is already owned by ${owner}. `
      + 'Close the other UClaw/OpenClaw instance before retrying.',
    );
    this.name = 'GatewayPortOwnershipConflictError';
  }
}

export function isGatewayPortOwnershipConflictError(
  error: unknown,
): error is GatewayPortOwnershipConflict {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === GATEWAY_PORT_OWNERSHIP_CONFLICT;
}

export async function findExistingGatewayProcess(options: {
  port: number;
  ownedPid?: number;
}): Promise<{ port: number; externalToken?: string } | null> {
  const { port, ownedPid } = options;

  let pids: string[] = [];
  try {
    pids = await getListeningProcessIds(port);
  } catch (error) {
    logger.warn('Error checking for existing process on port:', error);
  }

  const externalPids = pids.filter((pid) => !ownedPid || pid !== String(ownedPid));
  if (externalPids.length > 0) {
    const ready = await probeGatewayReady(port, 5000).catch(() => false);
    logger.warn(
      `Gateway port ${port} is owned by an external process (PIDs: ${externalPids.join(', ')}); `
      + 'leaving it untouched and blocking local Gateway startup',
    );
    throw new GatewayPortOwnershipConflictError(port, externalPids, ready);
  }

  const ready = await probeGatewayReady(port, 5000).catch(() => false);
  if (ready && !ownedPid) {
    logger.warn(
      `Gateway port ${port} answered a readiness probe but its owner PID could not be verified; `
      + 'leaving it untouched and blocking local Gateway startup',
    );
    throw new GatewayPortOwnershipConflictError(port, [], true);
  }

  return ready ? { port } : null;
}

export async function runOpenClawDoctorRepair(): Promise<boolean> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();
  if (!existsSync(entryScript)) {
    logger.error(`Cannot run OpenClaw doctor repair: entry script not found at ${entryScript}`);
    return false;
  }

  const platform = process.platform;
  const arch = process.arch;
  const target = `${platform}-${arch}`;
  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(process.cwd(), 'resources', 'bin', target);
  const binPathExists = existsSync(binPath);
  const baseProcessEnv = process.env as Record<string, string | undefined>;
  const baseEnvPatched = binPathExists
    ? prependPathEntry(baseProcessEnv, binPath).env
    : baseProcessEnv;

  const uvEnv = await getUvMirrorEnv();
  const doctorArgs = ['doctor', '--fix', '--yes', '--non-interactive'];
  logger.info(
    `Running OpenClaw doctor repair (entry="${entryScript}", args="${doctorArgs.join(' ')}", cwd="${openclawDir}", bundledBin=${binPathExists ? 'yes' : 'no'})`,
  );

  return await new Promise<boolean>((resolve) => {
    const forkEnv: Record<string, string | undefined> = {
      ...baseEnvPatched,
      ...uvEnv,
      OPENCLAW_NO_RESPAWN: '1',
    };

    const child = utilityProcess.fork(entryScript, doctorArgs, {
      cwd: openclawDir,
      stdio: 'pipe',
      env: forkEnv as NodeJS.ProcessEnv,
    });

    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    const timeout = setTimeout(() => {
      logger.error('OpenClaw doctor repair timed out after 120000ms');
      try {
        child.kill();
      } catch {
        // ignore
      }
      finish(false);
    }, 120000);

    child.on('error', (err) => {
      clearTimeout(timeout);
      logger.error('Failed to spawn OpenClaw doctor repair process:', err);
      finish(false);
    });

    child.stdout?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        const normalized = line.trim();
        if (!normalized) continue;
        logger.debug(`[Gateway doctor stdout] ${normalized}`);
      }
    });

    child.stderr?.on('data', (data) => {
      const raw = data.toString();
      for (const line of raw.split(/\r?\n/)) {
        const normalized = line.trim();
        if (!normalized) continue;
        logger.warn(`[Gateway doctor stderr] ${normalized}`);
      }
    });

    child.on('exit', (code: number) => {
      clearTimeout(timeout);
      if (code === 0) {
        logger.info('OpenClaw doctor repair completed successfully');
        finish(true);
        return;
      }
      logger.warn(`OpenClaw doctor repair exited (code=${code})`);
      finish(false);
    });
  });
}
