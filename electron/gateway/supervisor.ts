import { app, utilityProcess } from 'electron';
import path from 'path';
import { existsSync } from 'fs';
import { getOpenClawDir, getOpenClawEntryPath } from '../utils/paths';
import { getUvMirrorEnv } from '../utils/uv-env';
import { isPythonReady, setupManagedPython } from '../utils/uv-setup';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import { probeGatewayReady } from './ws-client';

const OWNED_GATEWAY_EXIT_TIMEOUT_MS = 5000;

function describeTerminationError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function warmupManagedPythonReadiness(): void {
  void isPythonReady().then((pythonReady) => {
    if (!pythonReady) {
      logger.info('Python environment missing or incomplete, attempting background repair...');
      void setupManagedPython().catch((err) => {
        logger.error('Background Python repair failed:', err);
      });
    }
  }).catch((err) => {
    logger.error('Failed to check Python environment:', err);
  });
}

/** Terminate an owned Gateway child and return only after its exit is confirmed. */
export async function terminateOwnedGatewayProcess(child: Electron.UtilityProcess): Promise<void> {
  const terminateWindowsProcessTree = async (pid: number): Promise<void> => {
    const cp = await import('child_process');
    await new Promise<void>((resolve, reject) => {
      cp.exec(`taskkill /F /PID ${pid} /T`, { timeout: 5000, windowsHide: true }, (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  let exited = false;
  let resolveExit!: () => void;
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const onExit = () => {
    exited = true;
    resolveExit();
  };

  // Register once before the first signal so a fast exit cannot be missed.
  child.once('exit', onExit);

  const waitForExit = async (): Promise<boolean> => {
    if (exited) return true;

    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), OWNED_GATEWAY_EXIT_TIMEOUT_MS);
    });
    const didExit = await Promise.race([
      exitPromise.then(() => true as const),
      timedOut,
    ]);
    if (timeout) clearTimeout(timeout);
    return didExit;
  };

  const pid = child.pid;
  logger.info(`Sending kill to Gateway process (pid=${pid ?? 'unknown'})`);

  try {
    try {
      if (process.platform === 'win32' && pid) {
        await terminateWindowsProcessTree(pid);
      } else {
        const sent = child.kill();
        if (sent === false && !exited) {
          throw new Error('child.kill() returned false');
        }
      }
    } catch (error) {
      if (exited) return;
      const signal = process.platform === 'win32' && pid ? 'taskkill' : 'SIGTERM';
      throw new Error(
        `Failed to terminate Gateway process with ${signal} (pid=${pid ?? 'unknown'}): ${describeTerminationError(error)}`,
        { cause: error },
      );
    }

    if (await waitForExit()) return;

    logger.warn(`Gateway did not exit in time, force-killing (pid=${pid ?? 'unknown'})`);
    try {
      if (!pid) {
        throw new Error('Gateway process PID is unavailable');
      }
      if (process.platform === 'win32') {
        await terminateWindowsProcessTree(pid);
      } else {
        process.kill(pid, 'SIGKILL');
      }
    } catch (error) {
      if (exited) return;
      const signal = process.platform === 'win32' ? 'taskkill' : 'SIGKILL';
      throw new Error(
        `Failed to force-kill Gateway process with ${signal} (pid=${pid ?? 'unknown'}): ${describeTerminationError(error)}`,
        { cause: error },
      );
    }

    if (await waitForExit()) return;

    const signal = process.platform === 'win32' ? 'taskkill' : 'SIGKILL';
    throw new Error(
      `Gateway process did not exit after ${signal} (pid=${pid ?? 'unknown'})`,
    );
  } finally {
    child.removeListener('exit', onExit);
  }
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

async function terminateOrphanedProcessIds(port: number, pids: string[]): Promise<void> {
  logger.info(`Found orphaned process listening on port ${port} (PIDs: ${pids.join(', ')}), attempting to kill...`);

  if (process.platform === 'darwin') {
    await unloadLaunchctlGatewayService();
  }

  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        const cp = await import('child_process');
        await new Promise<void>((resolve) => {
          cp.exec(
            `taskkill /F /PID ${pid} /T`,
            { timeout: 5000, windowsHide: true },
            () => resolve(),
          );
        });
      } else {
        process.kill(parseInt(pid, 10), 'SIGTERM');
      }
    } catch {
      // Ignore processes that have already exited.
    }
  }

  await new Promise((resolve) => setTimeout(resolve, process.platform === 'win32' ? 2000 : 3000));

  if (process.platform !== 'win32') {
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid, 10), 0);
        process.kill(parseInt(pid, 10), 'SIGKILL');
      } catch {
        // Already exited.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function findExistingGatewayProcess(options: {
  port: number;
  ownedPid?: number;
}): Promise<{ port: number; externalToken?: string } | null> {
  const { port, ownedPid } = options;

  try {
    try {
      const pids = await getListeningProcessIds(port);
      if (pids.length > 0 && (!ownedPid || !pids.includes(String(ownedPid)))) {
        await terminateOrphanedProcessIds(port, pids);
        if (process.platform === 'win32') {
          await waitForPortFree(port, 10000);
        }
        return null;
      }
    } catch (err) {
      logger.warn('Error checking for existing process on port:', err);
    }

    const ready = await probeGatewayReady(port, 5000);
    return ready ? { port } : null;
  } catch {
    return null;
  }
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
