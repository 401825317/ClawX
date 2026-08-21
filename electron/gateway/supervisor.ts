import { app, utilityProcess } from 'electron';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'path';
import { existsSync } from 'fs';
import { getOpenClawDir, getOpenClawEntryPath } from '../utils/paths';
import { getSetting } from '../utils/store';
import { getUvMirrorEnv } from '../utils/uv-env';
import { isPythonReady, setupManagedPython } from '../utils/uv-setup';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import {
  gatewayOwnershipRecordsMatch,
  getOwnedGatewayChildMetadata,
  hashGatewayToken,
  hasOwnedGatewayChildExited,
  inspectWindowsGatewayProcess,
  markOwnedGatewayChildExited,
  readGatewayOwnershipRecord,
  terminateWindowsProcessTreeIfOwned,
} from './gateway-ownership';
import { probeGatewayReady } from './ws-client';

const OWNED_GATEWAY_EXIT_TIMEOUT_MS = 5000;
const VERIFIED_GATEWAY_READY_TIMEOUT_MS = 90_000;
const VERIFIED_GATEWAY_READY_POLL_MS = 500;

type GatewayOwnershipEvent = {
  action: 'inspect' | 'wait' | 'takeover' | 'preserve' | 'refuse_terminate';
  result: 'started' | 'accepted' | 'completed' | 'free' | 'not_found' | 'rejected' | 'timeout' | 'cancelled';
  reason:
    | 'listener_scan'
    | 'listener_lookup_failed'
    | 'no_listener'
    | 'owned_listener_ready'
    | 'owned_listener_not_ready'
    | 'responsive_non_windows_listener'
    | 'unverified_non_windows_listener'
    | 'invalid_pid'
    | 'unknown_pid'
    | 'identity_mismatch'
    | 'verified_candidate'
    | 'awaiting_readiness'
    | 'readiness_confirmed'
    | 'ownership_verified'
    | 'listener_changed'
    | 'listener_exited'
    | 'ready_deadline_exceeded'
    | 'takeover_cancelled';
  pid: number | null;
  port: number;
};

function logGatewayOwnership(
  level: 'debug' | 'info' | 'warn',
  event: GatewayOwnershipEvent,
): void {
  logger[level]('gateway_ownership', {
    event: 'gateway_ownership',
    ...event,
  });
}

function safeGatewayOwnershipPid(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

export type WindowsGatewayProcessIdentity = {
  processId: number;
  creationIdentity: string;
  parentProcessId?: number;
  executablePath?: string;
  commandLine?: string;
  parentExecutablePath?: string;
};

export class GatewayPortConflictError extends Error {
  constructor(port: number) {
    super(`Gateway port ${port} is already in use by another process`);
    this.name = 'GatewayPortConflictError';
  }
}

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

  const terminateVerifiedWindowsProcessTree = async (): Promise<'signalled' | 'original_ended'> => {
    if (!pid || !Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error('Refusing to terminate a Windows Gateway process without a valid PID');
    }

    const metadata = getOwnedGatewayChildMetadata(child);
    if (exited || metadata?.exited || hasOwnedGatewayChildExited(child)) {
      return 'original_ended';
    }
    if (!metadata || metadata.record.pid !== pid) {
      logger.warn(`Refusing PID-targeted Gateway termination because child ownership metadata is unavailable (pid=${pid})`);
      throw new Error('Refusing to terminate a Windows Gateway process without child-bound ownership metadata');
    }
    if (!metadata.commandIdentityHash) {
      logger.warn(`Refusing PID-targeted Gateway termination because command identity is unavailable (pid=${pid})`);
      throw new Error('Refusing to terminate a Windows Gateway process without command identity');
    }

    const currentRecord = await readGatewayOwnershipRecord();
    const refreshedMetadata = getOwnedGatewayChildMetadata(child);
    if (exited || refreshedMetadata?.exited || hasOwnedGatewayChildExited(child)) {
      return 'original_ended';
    }
    if (!currentRecord || !gatewayOwnershipRecordsMatch(metadata.record, currentRecord)) {
      logger.warn(`Refusing PID-targeted Gateway termination because the ownership record changed (pid=${pid})`);
      throw new Error('Refusing to terminate a Windows Gateway process after ownership record mismatch');
    }

    const result = await terminateWindowsProcessTreeIfOwned({
      record: metadata.record,
      commandIdentityHash: metadata.commandIdentityHash,
    });
    if (result === 'not_found' || result === 'creation_identity_mismatch') {
      // The original process object is gone. The helper holds a Windows process
      // handle while checking identity, so taskkill can never target a reused PID.
      markOwnedGatewayChildExited(child);
      logger.info(`Owned Gateway child already ended before PID-targeted termination (pid=${pid})`);
      return 'original_ended';
    }
    if (result === 'command_identity_mismatch') {
      logger.warn(`Refusing PID-targeted Gateway termination because command identity changed (pid=${pid})`);
      throw new Error('Refusing to terminate a Windows Gateway process after command identity mismatch');
    }
    if (result === 'ownership_record_mismatch') {
      logger.warn(`Refusing PID-targeted Gateway termination because ownership changed during verification (pid=${pid})`);
      throw new Error('Refusing to terminate a Windows Gateway process after ownership record mismatch');
    }
    if (result === 'verification_failed') {
      logger.warn(`Refusing PID-targeted Gateway termination because process ownership could not be verified (pid=${pid})`);
      throw new Error('Refusing to terminate a Windows Gateway process after ownership verification failed');
    }
    return 'signalled';
  };

  try {
    if (process.platform === 'win32') {
      let directKillError: unknown;
      try {
        const sent = child.kill();
        if (sent === false && !exited) {
          directKillError = new Error('child.kill() returned false');
        }
      } catch (error) {
        directKillError = error;
      }

      if (exited || hasOwnedGatewayChildExited(child)) return;
      if (await waitForExit()) return;

      if (directKillError) {
        logger.warn(
          `Object-bound Gateway termination failed; escalating to verified process-tree termination (pid=${pid ?? 'unknown'}): ${describeTerminationError(directKillError)}`,
        );
      } else {
        logger.warn(
          `Gateway did not exit after object-bound termination; escalating to verified process-tree termination (pid=${pid ?? 'unknown'})`,
        );
      }

      try {
        if (await terminateVerifiedWindowsProcessTree() === 'original_ended') return;
      } catch (error) {
        if (exited || hasOwnedGatewayChildExited(child)) return;
        throw new Error(
          `Failed to force-kill Gateway process with taskkill (pid=${pid ?? 'unknown'}): ${describeTerminationError(error)}`,
          { cause: error },
        );
      }

      if (await waitForExit()) return;
      throw new Error(
        `Gateway process did not exit after taskkill (pid=${pid ?? 'unknown'})`,
      );
    }

    try {
      const sent = child.kill();
      if (sent === false && !exited) {
        throw new Error('child.kill() returned false');
      }
    } catch (error) {
      if (exited) return;
      throw new Error(
        `Failed to terminate Gateway process with SIGTERM (pid=${pid ?? 'unknown'}): ${describeTerminationError(error)}`,
        { cause: error },
      );
    }

    if (await waitForExit()) return;

    logger.warn(`Gateway did not exit in time, force-killing (pid=${pid ?? 'unknown'})`);
    try {
      if (!pid) {
        throw new Error('Gateway process PID is unavailable');
      }
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (exited) return;
      throw new Error(
        `Failed to force-kill Gateway process with SIGKILL (pid=${pid ?? 'unknown'}): ${describeTerminationError(error)}`,
        { cause: error },
      );
    }

    if (await waitForExit()) return;

    throw new Error(
      `Gateway process did not exit after SIGKILL (pid=${pid ?? 'unknown'})`,
    );
  } finally {
    child.removeListener('exit', onExit);
  }
}

function decodePlistXml(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function extractPlistString(plist: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = plist.match(new RegExp(`<key>\\s*${escapedKey}\\s*</key>\\s*<string>([\\s\\S]*?)</string>`, 'iu'));
  return match ? decodePlistXml(match[1]).trim() : null;
}

function extractPlistProgramArguments(plist: string): string[] {
  const block = plist.match(/<key>\s*ProgramArguments\s*<\/key>\s*<array>([\s\S]*?)<\/array>/iu)?.[1];
  if (!block) return [];
  return Array.from(block.matchAll(/<string>([\s\S]*?)<\/string>/giu))
    .map((match) => decodePlistXml(match[1]).trim())
    .filter(Boolean);
}

function extractPlistEnvironment(plist: string): Map<string, string> {
  const block = plist.match(/<key>\s*EnvironmentVariables\s*<\/key>\s*<dict>([\s\S]*?)<\/dict>/iu)?.[1];
  const environment = new Map<string, string>();
  if (!block) return environment;
  for (const match of block.matchAll(/<key>([\s\S]*?)<\/key>\s*<string>([\s\S]*?)<\/string>/giu)) {
    environment.set(decodePlistXml(match[1]).trim(), decodePlistXml(match[2]).trim());
  }
  return environment;
}

function hasManagedGatewayProgramArguments(programArguments: string[]): boolean {
  const normalized = programArguments.map((argument) => argument.trim().replace(/\\/gu, '/').toLowerCase());
  const hasGatewaySubcommand = normalized.some((argument) => argument === 'gateway');
  const referencesOpenClawRuntime = normalized.some((argument) => {
    return argument.includes('gateway-entry-wrapper.cjs')
      || argument.includes('/openclaw/')
      || /(?:^|\/)openclaw(?:$|[._-])/u.test(argument);
  });
  return hasGatewaySubcommand && referencesOpenClawRuntime;
}

function hasGeneratedOpenClawEnvironmentWrapper(
  programArguments: string[],
  expectedLabel: string,
): boolean {
  const normalizedArguments = programArguments.map((argument) => {
    return argument.trim().replace(/\\/gu, '/').toLowerCase();
  });
  return normalizedArguments.some((argument) => {
    return argument.endsWith(`/${expectedLabel.toLowerCase()}-env-wrapper.sh`);
  }) && normalizedArguments.some((argument) => {
    return argument.endsWith(`/${expectedLabel.toLowerCase()}.env`);
  });
}

export function isManagedOpenClawLaunchAgentPlist(
  plist: string,
  expectedLabel = 'ai.openclaw.gateway',
): boolean {
  if (!plist.trim() || plist.length > 1024 * 1024) return false;
  if (extractPlistString(plist, 'Label') !== expectedLabel) return false;
  const programArguments = extractPlistProgramArguments(plist);
  if (!hasManagedGatewayProgramArguments(programArguments)) return false;

  const environment = extractPlistEnvironment(plist);
  const hasCanonicalMarker = environment.get('OPENCLAW_SERVICE_MARKER') === 'openclaw'
    && environment.get('OPENCLAW_SERVICE_KIND') === 'gateway';
  const comment = extractPlistString(plist, 'Comment') ?? '';
  const hasLegacyManagedComment = /^(?:UClaw|OpenClaw) Gateway(?:\s|\(|$)/iu.test(comment);
  return hasCanonicalMarker
    || (hasLegacyManagedComment && hasGeneratedOpenClawEnvironmentWrapper(programArguments, expectedLabel));
}

function extractLaunchctlScalar(output: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return output.match(new RegExp(`(?:^|\\n)\\s*${escapedKey}\\s*=\\s*([^\\r\\n]+)`, 'iu'))?.[1]?.trim() ?? '';
}

function getManagedOpenClawLaunchctlServiceIdentity(
  output: string,
  expectedLabel = 'ai.openclaw.gateway',
): string | null {
  const normalized = output.replace(/\\/gu, '/');
  const escapedLabel = expectedLabel.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const hasLabel = new RegExp(`(?:^|[\\s/])${escapedLabel}(?:\\s*=|\\s|$)`, 'imu').test(normalized);
  const hasCanonicalMarker = /OPENCLAW_SERVICE_MARKER\s*=>\s*openclaw(?:\s|$)/iu.test(normalized)
    && /OPENCLAW_SERVICE_KIND\s*=>\s*gateway(?:\s|$)/iu.test(normalized);
  const argumentsBlock = normalized.match(/arguments\s*=\s*\{([\s\S]*?)(?:^|\n)\s*\}/imu)?.[1] ?? '';
  const programArguments = argumentsBlock
    .split(/\r?\n/u)
    .map((line) => line.replace(/^\s*\d+\s*=\s*/u, '').trim())
    .filter(Boolean);
  const hasGeneratedEnvironmentWrapper = hasGeneratedOpenClawEnvironmentWrapper(
    programArguments,
    expectedLabel,
  );
  if (
    !hasLabel
    || !hasManagedGatewayProgramArguments(programArguments)
    || (!hasCanonicalMarker && !hasGeneratedEnvironmentWrapper)
  ) {
    return null;
  }

  const identity = JSON.stringify({
    label: expectedLabel,
    path: extractLaunchctlScalar(normalized, 'path'),
    program: extractLaunchctlScalar(normalized, 'program'),
    pid: extractLaunchctlScalar(normalized, 'pid'),
    programArguments,
    marker: hasCanonicalMarker ? 'canonical' : 'generated-wrapper',
  });
  return createHash('sha256').update(identity, 'utf8').digest('hex');
}

export function isManagedOpenClawLaunchctlService(
  output: string,
  expectedLabel = 'ai.openclaw.gateway',
): boolean {
  return getManagedOpenClawLaunchctlServiceIdentity(output, expectedLabel) !== null;
}

async function removeManagedLaunchAgentPlist(options: {
  fs: typeof import('node:fs/promises');
  label: string;
  plistPath: string;
}): Promise<'removed' | 'missing' | 'preserved'> {
  const quarantinePath = `${options.plistPath}.${randomUUID()}.uclaw-delete-check`;
  try {
    await options.fs.rename(options.plistPath, quarantinePath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'preserved';
  }

  const restoreWithoutOverwrite = async (): Promise<void> => {
    try {
      await options.fs.link(quarantinePath, options.plistPath);
      await options.fs.unlink(quarantinePath).catch(() => undefined);
    } catch {
      // Content remains at the quarantine path and is never deleted.
    }
  };

  let quarantinedPlist: string;
  try {
    quarantinedPlist = await options.fs.readFile(quarantinePath, 'utf8');
  } catch {
    await restoreWithoutOverwrite();
    return 'preserved';
  }

  if (isManagedOpenClawLaunchAgentPlist(quarantinedPlist, options.label)) {
    try {
      await options.fs.unlink(quarantinePath);
      return 'removed';
    } catch {
      await restoreWithoutOverwrite();
      return 'preserved';
    }
  }

  // The file changed after the first ownership check. Restore it without
  // overwriting a new writer's path; if the target is occupied, retain the
  // quarantined file rather than deleting user content.
  await restoreWithoutOverwrite();
  return 'preserved';
}

export async function unloadLaunchctlGatewayService(options: { homeDir?: string; uid?: number } = {}): Promise<void> {
  if (process.platform !== 'darwin') return;

  try {
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) return;

    const launchdLabel = 'ai.openclaw.gateway';
    const serviceTarget = `gui/${uid}/${launchdLabel}`;
    const cp = await import('child_process');
    const fsPromises = await import('fs/promises');
    const os = await import('os');

    const plistPath = path.join(options.homeDir ?? os.homedir(), 'Library', 'LaunchAgents', `${launchdLabel}.plist`);
    let plist: string | null = null;
    let plistReadFailed = false;
    try {
      plist = await fsPromises.readFile(plistPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') plistReadFailed = true;
    }
    const plistIsManaged = plist !== null && isManagedOpenClawLaunchAgentPlist(plist, launchdLabel);

    const inspectLoadedService = async (): Promise<{ loaded: boolean; output: string }> => {
      return await new Promise((resolve) => {
        cp.execFile('launchctl', ['print', serviceTarget], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
          resolve({ loaded: !err, output: err ? '' : String(stdout) });
        });
      });
    };
    const loaded = await inspectLoadedService();

    const loadedServiceIdentity = loaded.loaded
      ? getManagedOpenClawLaunchctlServiceIdentity(loaded.output, launchdLabel)
      : null;
    if (loadedServiceIdentity) {
      const confirmed = await inspectLoadedService();
      const confirmedIdentity = confirmed.loaded
        ? getManagedOpenClawLaunchctlServiceIdentity(confirmed.output, launchdLabel)
        : null;
      if (confirmedIdentity !== loadedServiceIdentity) {
        logger.warn(`Preserving launchctl service because ownership changed before bootout for ${launchdLabel}`);
      } else {
        logger.info(`Unloading verified launchctl service ${serviceTarget} to prevent auto-respawn`);
        await new Promise<void>((resolve) => {
          cp.execFile('launchctl', ['bootout', serviceTarget], { timeout: 10_000, encoding: 'utf8' }, (err) => {
            if (err) {
              logger.warn(`Failed to bootout verified launchctl service: ${err.message}`);
            } else {
              logger.info('Successfully unloaded verified launchctl gateway service');
            }
            resolve();
          });
        });
      }
    } else if (loaded.loaded) {
      logger.warn(`Preserving unverified launchctl service for label ${launchdLabel}`);
    }

    if (plistIsManaged) {
      const removal = await removeManagedLaunchAgentPlist({
        fs: fsPromises,
        label: launchdLabel,
        plistPath,
      });
      if (removal === 'removed') {
        logger.info(`Removed verified managed launchd plist for ${launchdLabel}`);
      } else if (removal === 'preserved') {
        logger.warn(`Preserved launchd plist after ownership changed or removal failed for ${launchdLabel}`);
      }
    } else if (plist !== null || plistReadFailed) {
      logger.warn(`Preserving unverified launchd plist for label ${launchdLabel}`);
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

type ListeningProcessLookup =
  | { state: 'free' }
  | { state: 'listening'; pids: string[] }
  | { state: 'failed'; error: unknown };

type VerifiedWindowsGatewayCandidate = {
  pid: number;
  creationIdentity: string;
  kind: 'wrapper' | 'direct' | 'orphan-direct';
  ownershipRecordMatched: boolean;
};

type ExistingGatewayProvenance = 'managed-process' | 'verified-orphan' | 'unknown-external';

type GatewayCandidateVerification =
  | { status: 'verified'; candidate: VerifiedWindowsGatewayCandidate }
  | { status: 'rejected'; reason: 'unknown_pid' | 'identity_mismatch' };

function parseWindowsListeningProcessIds(stdout: string, port: number): string[] {
  const pids = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP' || parts[3].toUpperCase() !== 'LISTENING') {
      continue;
    }

    const separator = parts[1].lastIndexOf(':');
    const localPort = separator === -1 ? NaN : Number(parts[1].slice(separator + 1));
    if (localPort === port && /^\d+$/u.test(parts[4])) {
      pids.add(parts[4]);
    }
  }
  return [...pids];
}

async function getListeningProcessIds(port: number): Promise<ListeningProcessLookup> {
  const cp = await import('child_process');

  if (process.platform === 'win32') {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        cp.execFile(
          'netstat.exe',
          ['-ano', '-p', 'tcp'],
          { timeout: 5000, windowsHide: true, encoding: 'utf8' },
          (error, output) => {
            if (error) {
              reject(error);
              return;
            }
            resolve(String(output));
          },
        );
      });
      const pids = parseWindowsListeningProcessIds(stdout, port);
      return pids.length === 0 ? { state: 'free' } : { state: 'listening', pids };
    } catch (error) {
      return { state: 'failed', error };
    }
  }

  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      cp.exec(`lsof -i :${port} -sTCP:LISTEN -t`, { timeout: 5000, windowsHide: true }, (error, output) => {
        if (error) {
          const exitCode = (error as { code?: unknown }).code;
          if (exitCode === 1 || exitCode === '1') {
            resolve('');
            return;
          }
          reject(error);
          return;
        }
        resolve(String(output));
      });
    });
    const pids = [...new Set(stdout.trim().split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
    return pids.length === 0 ? { state: 'free' } : { state: 'listening', pids };
  } catch (error) {
    return { state: 'failed', error };
  }
}

function normalizeWindowsPath(value: string | undefined): string {
  return (value ?? '')
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .toLowerCase();
}

/**
 * Verify that a Windows listener was launched by this UClaw runtime.
 * The command line itself is never logged because older builds may contain a token argument.
 */
export function isExpectedUClawGatewayProcess(
  identity: WindowsGatewayProcessIdentity,
  options: {
    port: number;
    currentPid?: number;
    executablePath?: string;
    gatewayEntryPath?: string;
    gatewayWrapperPath?: string;
  },
): boolean {
  const commandLine = normalizeWindowsPath(identity.commandLine);
  const executablePath = normalizeWindowsPath(identity.executablePath);
  const expectedExecutablePath = normalizeWindowsPath(options.executablePath);
  const gatewayEntryPath = normalizeWindowsPath(options.gatewayEntryPath);
  const gatewayWrapperPath = normalizeWindowsPath(options.gatewayWrapperPath);
  const executableMatches = Boolean(expectedExecutablePath) && executablePath === expectedExecutablePath;
  const gatewayArgumentMatches = /(?:^|\s)gateway(?:\s|$)/i.test(commandLine);
  const portArgumentMatches = new RegExp(`(?:^|\\s)--port(?:=|\\s+)${options.port}(?:\\s|$)`, 'i').test(commandLine);
  const wrapperMatches = Boolean(gatewayWrapperPath) && commandLine.includes(gatewayWrapperPath);
  const entryMatches = Boolean(gatewayEntryPath) && commandLine.includes(gatewayEntryPath);
  const parentMatches = identity.parentProcessId === options.currentPid;

  // Direct-entry candidates with no live parent must also match the durable
  // ownership record. That check is intentionally performed by the takeover
  // path, where the current gateway token hash is available.
  return executableMatches
    && gatewayArgumentMatches
    && portArgumentMatches
    && (wrapperMatches || (entryMatches && parentMatches));
}

function getGatewayCandidateKind(
  identity: WindowsGatewayProcessIdentity,
  options: {
    port: number;
    currentPid?: number;
    executablePath?: string;
    gatewayEntryPath?: string;
    gatewayWrapperPath?: string;
  },
): VerifiedWindowsGatewayCandidate['kind'] | null {
  const commandLine = normalizeWindowsPath(identity.commandLine);
  const executablePath = normalizeWindowsPath(identity.executablePath);
  const expectedExecutablePath = normalizeWindowsPath(options.executablePath);
  const gatewayEntryPath = normalizeWindowsPath(options.gatewayEntryPath);
  const gatewayWrapperPath = normalizeWindowsPath(options.gatewayWrapperPath);
  const parentExecutablePath = normalizeWindowsPath(identity.parentExecutablePath);

  const executableMatches = Boolean(expectedExecutablePath) && executablePath === expectedExecutablePath;
  const gatewayArgumentMatches = /(?:^|\s)gateway(?:\s|$)/i.test(commandLine);
  const portArgumentMatches = new RegExp(`(?:^|\\s)--port(?:=|\\s+)${options.port}(?:\\s|$)`, 'i').test(commandLine);
  if (!executableMatches || !gatewayArgumentMatches || !portArgumentMatches) return null;

  if (gatewayWrapperPath && commandLine.includes(gatewayWrapperPath)) return 'wrapper';
  if (!gatewayEntryPath || !commandLine.includes(gatewayEntryPath)) return null;

  const parentMatches = identity.parentProcessId === options.currentPid;
  if (parentMatches) return 'direct';

  // Get-CimInstance leaves ParentExecutablePath empty when the launching
  // ClawX process has exited. A persisted record must prove that orphan.
  return parentExecutablePath ? null : 'orphan-direct';
}

function gatewayTokenHashesMatch(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

async function getCurrentGatewayTokenHash(options: { tokenHash?: string }): Promise<string | null> {
  if (options.tokenHash !== undefined) {
    return options.tokenHash.trim() || null;
  }

  const token = await getSetting('gatewayToken');
  return token.trim() ? hashGatewayToken(token) : null;
}

function normalizeProcessCreationIdentity(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const identity = (value as Record<string, unknown>).processCreationIdentity;
    return typeof identity === 'string' && identity.trim() ? identity.trim() : null;
  }
  return null;
}

async function ownershipRecordMatchesGatewayCandidate(options: {
  pid: number;
  creationIdentity: string;
  runtimeRoot: string;
  tokenHash?: string;
}): Promise<boolean> {
  const record = await readGatewayOwnershipRecord();
  if (!record) return false;

  const tokenHash = await getCurrentGatewayTokenHash(options);
  const recordTokenHash = record.tokenHash;
  const recordRuntimeRoot = record.runtimeRoot;
  const recordCreationIdentity = record.processCreationIdentity;
  if (!tokenHash || !recordTokenHash || !recordRuntimeRoot || !recordCreationIdentity) return false;

  return record.pid === options.pid
    && recordCreationIdentity === options.creationIdentity
    && normalizeWindowsPath(recordRuntimeRoot) === normalizeWindowsPath(options.runtimeRoot)
    && Boolean(record.launchNonce)
    && gatewayTokenHashesMatch(recordTokenHash, tokenHash);
}

function assertGatewayTakeoverCanContinue(options: {
  assertCanContinue?: () => void;
  signal?: AbortSignal;
}): void {
  options.signal?.throwIfAborted();
  options.assertCanContinue?.();
  options.signal?.throwIfAborted();
}

async function delayGatewayTakeoverPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  const abortSignal: AbortSignal = signal;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      finish(abortSignal.reason instanceof Error ? abortSignal.reason : new Error('Gateway takeover cancelled'));
    };
    let settled = false;
    function finish(error?: Error): void {
      if (settled) return;
      settled = true;
      abortSignal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve();
    }
    abortSignal.addEventListener('abort', onAbort, { once: true });
    if (abortSignal.aborted) onAbort();
  });
}

async function verifyWindowsGatewayCandidate(options: {
  pid: number;
  port: number;
  currentPid: number;
  executablePath: string;
  gatewayEntryPath: string;
  gatewayWrapperPath: string;
  tokenHash?: string;
  assertCanContinue?: () => void;
  signal?: AbortSignal;
}): Promise<GatewayCandidateVerification> {
  assertGatewayTakeoverCanContinue(options);
  const identity = await inspectWindowsGatewayProcess(options.pid);
  assertGatewayTakeoverCanContinue(options);
  if (!identity) return { status: 'rejected', reason: 'unknown_pid' };
  const creationIdentity = normalizeProcessCreationIdentity(identity.creationIdentity);
  if (!creationIdentity) return { status: 'rejected', reason: 'identity_mismatch' };

  const kind = getGatewayCandidateKind(identity, options);
  if (!kind) return { status: 'rejected', reason: 'identity_mismatch' };

  let ownershipRecordMatched = false;
  if (kind === 'wrapper' || kind === 'orphan-direct') {
    try {
      ownershipRecordMatched = await ownershipRecordMatchesGatewayCandidate({
        pid: options.pid,
        creationIdentity,
        runtimeRoot: getOpenClawDir(),
        tokenHash: options.tokenHash,
      });
    } catch {
      return { status: 'rejected', reason: 'identity_mismatch' };
    }
    assertGatewayTakeoverCanContinue(options);
  }

  // A wrapper path can survive an application upgrade in the same userData
  // directory. Every parentless candidate therefore needs all durable fields
  // (PID creation identity, runtime root, nonce, and current token hash).
  if ((kind === 'wrapper' || kind === 'orphan-direct') && !ownershipRecordMatched) {
    return { status: 'rejected', reason: 'identity_mismatch' };
  }
  return {
    status: 'verified',
    candidate: { pid: options.pid, creationIdentity, kind, ownershipRecordMatched },
  };
}

function sameVerifiedGatewayCandidates(
  before: VerifiedWindowsGatewayCandidate[],
  after: VerifiedWindowsGatewayCandidate[],
): boolean {
  if (before.length !== after.length) return false;
  const byPid = new Map(after.map((candidate) => [candidate.pid, candidate]));
  return before.every((candidate) => byPid.get(candidate.pid)?.creationIdentity === candidate.creationIdentity);
}

async function waitForVerifiedGatewayReady(options: {
  port: number;
  timeoutMs: number;
  assertCanContinue?: () => void;
  signal?: AbortSignal;
}): Promise<boolean> {
  const startedAt = Date.now();
  while (true) {
    assertGatewayTakeoverCanContinue(options);
    const remainingMs = options.timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return false;

    if (await probeGatewayReady(options.port, Math.min(1500, remainingMs))) {
      assertGatewayTakeoverCanContinue(options);
      return true;
    }
    await delayGatewayTakeoverPoll(Math.min(VERIFIED_GATEWAY_READY_POLL_MS, remainingMs), options.signal);
  }
}

export async function findExistingGatewayProcess(options: {
  port: number;
  ownedPid?: number;
  candidateReadyTimeoutMs?: number;
  assertCanContinue?: () => void;
  /** Test-only override; production callers always hash the current store token. */
  tokenHash?: string;
  signal?: AbortSignal;
}): Promise<{ port: number; pid?: number; externalToken?: string; provenance: ExistingGatewayProvenance } | null> {
  const { port, ownedPid } = options;
  assertGatewayTakeoverCanContinue(options);

  logGatewayOwnership('debug', {
    action: 'inspect',
    result: 'started',
    reason: 'listener_scan',
    pid: safeGatewayOwnershipPid(ownedPid),
    port,
  });

  const listenerLookup = await getListeningProcessIds(port);
  assertGatewayTakeoverCanContinue(options);
  if (listenerLookup.state === 'failed') {
    logGatewayOwnership('warn', {
      action: 'refuse_terminate',
      result: 'rejected',
      reason: 'listener_lookup_failed',
      pid: null,
      port,
    });
    throw new GatewayPortConflictError(port);
  }
  if (listenerLookup.state === 'free') {
    logGatewayOwnership('debug', {
      action: 'inspect',
      result: 'not_found',
      reason: 'no_listener',
      pid: null,
      port,
    });
    return null;
  }

  const pids = listenerLookup.pids;

  const ownedPidText = ownedPid === undefined ? undefined : String(ownedPid);
  if (ownedPidText && pids.length === 1 && pids[0] === ownedPidText) {
    try {
      const ready = await probeGatewayReady(port, 5000);
      assertGatewayTakeoverCanContinue(options);
      if (ready) {
        logGatewayOwnership('info', {
          action: 'takeover',
          result: 'accepted',
          reason: 'owned_listener_ready',
          pid: safeGatewayOwnershipPid(ownedPid),
          port,
        });
        return { port, pid: ownedPid, provenance: 'managed-process' };
      }
    } catch {
      // The fixed event below records the safe ownership decision.
    }
    logGatewayOwnership('info', {
      action: 'preserve',
      result: 'completed',
      reason: 'owned_listener_not_ready',
      pid: safeGatewayOwnershipPid(ownedPid),
      port,
    });
    return null;
  }

  const externalPids = pids.filter((pid) => !ownedPid || pid !== String(ownedPid));
  if (externalPids.length === 0) {
    logGatewayOwnership('info', {
      action: 'preserve',
      result: 'completed',
      reason: 'owned_listener_not_ready',
      pid: safeGatewayOwnershipPid(ownedPid),
      port,
    });
    return null;
  }

  // Preserve the established non-Windows behavior. The identity hardening is
  // intentionally Windows-specific because listener process metadata differs
  // substantially across launchd and Linux process namespaces.
  if (process.platform !== 'win32') {
    try {
      const ready = await probeGatewayReady(port, 5000);
      if (ready) {
        const pid = Number(externalPids[0]);
        logGatewayOwnership('info', {
          action: 'takeover',
          result: 'accepted',
          reason: 'responsive_non_windows_listener',
          pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
          port,
        });
        return { port, pid: pid || undefined, provenance: 'unknown-external' };
      }
    } catch {
      // Preserve the listener and report only the fixed ownership decision.
    }
    const pid = Number(externalPids[0]);
    logGatewayOwnership('warn', {
      action: 'refuse_terminate',
      result: 'rejected',
      reason: 'unverified_non_windows_listener',
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      port,
    });
    throw new GatewayPortConflictError(port);
  }

  const expectedIdentityOptions = {
    port,
    currentPid: process.pid,
    executablePath: process.execPath,
    gatewayEntryPath: getOpenClawEntryPath(),
    gatewayWrapperPath: path.join(app.getPath('userData'), 'gateway-entry-wrapper.cjs'),
  };
  const verified: VerifiedWindowsGatewayCandidate[] = [];
  for (const pidText of externalPids) {
    const pid = Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      logGatewayOwnership('warn', {
        action: 'refuse_terminate',
        result: 'rejected',
        reason: 'invalid_pid',
        pid: null,
        port,
      });
      throw new GatewayPortConflictError(port);
    }
    const verification = await verifyWindowsGatewayCandidate({ ...expectedIdentityOptions, pid, ...options });
    if (verification.status === 'rejected') {
      logGatewayOwnership('warn', {
        action: 'refuse_terminate',
        result: 'rejected',
        reason: verification.reason,
        pid,
        port,
      });
      throw new GatewayPortConflictError(port);
    }
    verified.push(verification.candidate);
    logGatewayOwnership('debug', {
      action: 'inspect',
      result: 'accepted',
      reason: 'verified_candidate',
      pid,
      port,
    });
  }

  if (verified.length !== externalPids.length) {
    logGatewayOwnership('warn', {
      action: 'refuse_terminate',
      result: 'rejected',
      reason: 'identity_mismatch',
      pid: null,
      port,
    });
    throw new GatewayPortConflictError(port);
  }

  logGatewayOwnership('info', {
    action: 'wait',
    result: 'started',
    reason: 'awaiting_readiness',
    pid: verified.length === 1 ? verified[0].pid : null,
    port,
  });
  let ready: boolean;
  try {
    ready = await waitForVerifiedGatewayReady({
      port,
      timeoutMs: options.candidateReadyTimeoutMs ?? VERIFIED_GATEWAY_READY_TIMEOUT_MS,
      assertCanContinue: options.assertCanContinue,
      signal: options.signal,
    });
  } catch (error) {
    logGatewayOwnership('warn', {
      action: 'wait',
      result: 'cancelled',
      reason: 'takeover_cancelled',
      pid: verified.length === 1 ? verified[0].pid : null,
      port,
    });
    throw error;
  }
  if (ready) {
    logGatewayOwnership('info', {
      action: 'wait',
      result: 'completed',
      reason: 'readiness_confirmed',
      pid: verified.length === 1 ? verified[0].pid : null,
      port,
    });
    assertGatewayTakeoverCanContinue(options);
    const afterReadyLookup = await getListeningProcessIds(port);
    assertGatewayTakeoverCanContinue(options);
    if (afterReadyLookup.state === 'failed') {
      logGatewayOwnership('warn', {
        action: 'refuse_terminate',
        result: 'rejected',
        reason: 'listener_lookup_failed',
        pid: null,
        port,
      });
      throw new GatewayPortConflictError(port);
    }
    if (afterReadyLookup.state === 'free') {
      logGatewayOwnership('info', {
        action: 'inspect',
        result: 'free',
        reason: 'listener_exited',
        pid: null,
        port,
      });
      return null;
    }

    const afterReadyVerified: VerifiedWindowsGatewayCandidate[] = [];
    for (const pidText of afterReadyLookup.pids) {
      const pid = Number(pidText);
      if (!Number.isSafeInteger(pid) || pid <= 0) {
        logGatewayOwnership('warn', {
          action: 'refuse_terminate',
          result: 'rejected',
          reason: 'unknown_pid',
          pid: null,
          port,
        });
        throw new GatewayPortConflictError(port);
      }
      const verification = await verifyWindowsGatewayCandidate({ ...expectedIdentityOptions, pid, ...options });
      if (verification.status === 'rejected') {
        logGatewayOwnership('warn', {
          action: 'refuse_terminate',
          result: 'rejected',
          reason: verification.reason,
          pid,
          port,
        });
        throw new GatewayPortConflictError(port);
      }
      afterReadyVerified.push(verification.candidate);
    }

    if (sameVerifiedGatewayCandidates(verified, afterReadyVerified)) {
      logGatewayOwnership('info', {
        action: 'takeover',
        result: 'accepted',
        reason: 'ownership_verified',
        pid: verified.length === 1 ? verified[0].pid : null,
        port,
      });
       return {
         port,
         pid: verified[0]?.pid,
         provenance: 'verified-orphan',
       };
    }

    logGatewayOwnership('warn', {
      action: 'refuse_terminate',
      result: 'rejected',
      reason: 'listener_changed',
      pid: null,
      port,
    });
    throw new GatewayPortConflictError(port);
  }

  const remainingLookup = await getListeningProcessIds(port);
  assertGatewayTakeoverCanContinue(options);
  if (remainingLookup.state === 'failed') {
    logGatewayOwnership('warn', {
      action: 'refuse_terminate',
      result: 'rejected',
      reason: 'listener_lookup_failed',
      pid: null,
      port,
    });
    throw new GatewayPortConflictError(port);
  }
  if (remainingLookup.state === 'free') {
    logGatewayOwnership('info', {
      action: 'inspect',
      result: 'free',
      reason: 'listener_exited',
      pid: null,
      port,
    });
    return null;
  }

  const remainingPid = remainingLookup.pids.length === 1 ? Number(remainingLookup.pids[0]) : NaN;
  logGatewayOwnership('warn', {
    action: 'preserve',
    result: 'timeout',
    reason: 'ready_deadline_exceeded',
    pid: Number.isSafeInteger(remainingPid) && remainingPid > 0 ? remainingPid : null,
    port,
  });
  throw new GatewayPortConflictError(port);
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
