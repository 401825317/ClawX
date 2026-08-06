import { constants as fsConstants } from 'node:fs';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import JSON5 from 'json5';
import { stripEnvironmentKeys } from './config-sync-env';

const SUPPORTED_FROM_VERSION = '2026.6.11';
const SUPPORTED_TO_VERSION = '2026.6.10';
const DOWNGRADE_OVERRIDE_ENV = 'OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS';
const OPENCLAW_COMMAND_TIMEOUT_MS = 120_000;
const OPENCLAW_COMMAND_TERMINATION_CONFIRMATION_TIMEOUT_MS = 5_000;
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

type OpenClawDowngradeDecision =
  | { action: 'none' }
  | { action: 'migrate'; fromVersion: string; toVersion: string }
  | { action: 'block'; fromVersion: string; toVersion: string };

export type OpenClawDowngradeTransaction = {
  configPath: string;
  backupPath: string;
  fromVersion: string;
  toVersion: string;
};

export class OpenClawDowngradeBlockedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenClawDowngradeBlockedError';
  }
}

/** Raised when config restoration is unsafe because the bundled writer may still be alive. */
export class OpenClawCommandTerminationUnconfirmedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OpenClawCommandTerminationUnconfirmedError';
  }
}

function appendBoundedOutput(current: string, data: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_COMMAND_OUTPUT_BYTES) return current;
  const chunk = typeof data === 'string' ? Buffer.from(data) : data;
  const remaining = MAX_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current);
  return current + chunk.subarray(0, remaining).toString();
}

type OpenClawCommandDependencies = {
  forkProcess?: typeof fork;
  timeoutMs?: number;
  terminationConfirmationTimeoutMs?: number;
};

/** Runs the bundled OpenClaw CLI without allowing a user-installed binary onto this path. */
export async function runBundledOpenClawCommand(options: {
  args: string[];
  configPath: string;
  allowOlderBinaryDestructiveActions: boolean;
}, dependencies: OpenClawCommandDependencies = {}): Promise<void> {
  const { getOpenClawEmbeddedForkSpec } = await import('../utils/openclaw-cli');
  const spec = getOpenClawEmbeddedForkSpec(options.args);
  const forkProcess = dependencies.forkProcess ?? fork;
  const timeoutMs = dependencies.timeoutMs ?? OPENCLAW_COMMAND_TIMEOUT_MS;
  const terminationConfirmationTimeoutMs = dependencies.terminationConfirmationTimeoutMs
    ?? OPENCLAW_COMMAND_TERMINATION_CONFIRMATION_TIMEOUT_MS;
  const env: NodeJS.ProcessEnv = stripEnvironmentKeys({
    ...spec.options.env,
    OPENCLAW_CONFIG_PATH: options.configPath,
    OPENCLAW_CONFIG: options.configPath,
  }, [DOWNGRADE_OVERRIDE_ENV, 'OPENCLAW_SERVICE_MARKER']);

  // The override is child-scoped and cannot leak in from the desktop process.
  if (options.allowOlderBinaryDestructiveActions) {
    env[DOWNGRADE_OVERRIDE_ENV] = '1';
  }

  await new Promise<void>((resolve, reject) => {
    const child = forkProcess(spec.modulePath, spec.args, {
      ...spec.options,
      env,
    });
    let stderr = '';
    let settled = false;
    let timeoutError: Error | null = null;
    let timeout: NodeJS.Timeout | null = null;
    let terminationConfirmationTimeout: NodeJS.Timeout | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (terminationConfirmationTimeout) clearTimeout(terminationConfirmationTimeout);
      if (error) reject(error);
      else resolve();
    };
    timeout = setTimeout(() => {
      timeoutError = new Error(`Bundled OpenClaw command timed out after ${timeoutMs}ms`);
      // Do not let the caller restore the config until the writer has actually exited.
      try {
        child.kill('SIGKILL');
      } catch (error) {
        finish(new OpenClawCommandTerminationUnconfirmedError(
          `Bundled OpenClaw command timed out after ${timeoutMs}ms and termination could not be confirmed`,
          { cause: error },
        ));
        return;
      }

      // A test double or platform API may report exit synchronously from kill().
      if (settled) return;
      terminationConfirmationTimeout = setTimeout(() => {
        finish(new OpenClawCommandTerminationUnconfirmedError(
          `Bundled OpenClaw command timed out after ${timeoutMs}ms and did not exit within `
          + `${terminationConfirmationTimeoutMs}ms after termination`,
          { cause: timeoutError },
        ));
      }, terminationConfirmationTimeoutMs);
    }, timeoutMs);

    child.stdout?.on('data', (data) => {
      // Drain stdout so verbose plugin diagnostics cannot block the child pipe.
      appendBoundedOutput('', data);
    });
    child.stderr?.on('data', (data) => {
      stderr = appendBoundedOutput(stderr, data);
    });
    child.on('error', (error) => {
      // A failed kill can emit error while the process is still alive; exit remains authoritative.
      if (timeoutError) return;
      finish(error instanceof Error ? error : new Error(String(error)));
    });
    child.on('exit', (code) => {
      if (timeoutError) {
        finish(timeoutError);
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const hasOutput = stderr.trim().length > 0;
      finish(new Error(
        `Bundled OpenClaw command failed (code=${code ?? 'null'}${hasOutput ? ', stderr captured' : ''})`,
      ));
    });
  });
}

async function readBundledOpenClawVersion(): Promise<string> {
  const { getOpenClawDir } = await import('../utils/paths');
  const packageJson = JSON.parse(await readFile(join(getOpenClawDir(), 'package.json'), 'utf8')) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== 'string' || !packageJson.version.trim()) {
    throw new OpenClawDowngradeBlockedError('Bundled OpenClaw version is unavailable');
  }
  return packageJson.version.trim();
}

function parseComparableVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: string, right: string): number | null {
  const leftParts = parseComparableVersion(left);
  const rightParts = parseComparableVersion(right);
  if (!leftParts || !rightParts) return null;

  for (let index = 0; index < leftParts.length; index += 1) {
    const delta = leftParts[index]! - rightParts[index]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function readLastTouchedVersion(rawConfig: string): string | null {
  const parsed = JSON5.parse(rawConfig) as { meta?: { lastTouchedVersion?: unknown } };
  const value = parsed.meta?.lastTouchedVersion;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readGatewayMode(rawConfig: string): 'local' | 'remote' {
  const parsed = JSON5.parse(rawConfig) as { gateway?: { mode?: unknown } };
  const mode = parsed.gateway?.mode;
  if (mode !== 'local' && mode !== 'remote') {
    throw new OpenClawDowngradeBlockedError(
      'OpenClaw Gateway mode is unavailable for the managed config handoff',
    );
  }
  return mode;
}

/** Resolves whether the active config needs the one approved managed handoff. */
export function resolveOpenClawDowngradeDecision(
  runtimeVersion: string,
  lastTouchedVersion: string | null,
): OpenClawDowngradeDecision {
  if (!lastTouchedVersion) return { action: 'none' };

  const comparison = compareVersions(lastTouchedVersion, runtimeVersion);
  if (comparison === null || comparison <= 0) return { action: 'none' };

  if (
    runtimeVersion === SUPPORTED_TO_VERSION
    && lastTouchedVersion === SUPPORTED_FROM_VERSION
  ) {
    return {
      action: 'migrate',
      fromVersion: SUPPORTED_FROM_VERSION,
      toVersion: SUPPORTED_TO_VERSION,
    };
  }

  return {
    action: 'block',
    fromVersion: lastTouchedVersion,
    toVersion: runtimeVersion,
  };
}

async function createConfigBackup(configPath: string, backupPath: string): Promise<void> {
  try {
    await copyFile(configPath, backupPath, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  // The config may contain credentials; keep the backup private on supporting filesystems.
  await chmod(backupPath, 0o600).catch(() => undefined);
}

/** Validates and snapshots the config before any managed startup write occurs. */
export async function prepareOpenClawDowngrade(options: {
  configPath: string;
  runtimeVersion: string;
  validateConfig: () => Promise<void>;
}): Promise<OpenClawDowngradeTransaction | null> {
  let rawConfig: string;
  try {
    rawConfig = await readFile(options.configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OpenClawDowngradeBlockedError(
      'OpenClaw config cannot be read for the managed handoff',
      { cause: error },
    );
  }

  let lastTouchedVersion: string | null;
  try {
    lastTouchedVersion = readLastTouchedVersion(rawConfig);
  } catch {
    // Existing invalid-config recovery remains authoritative for malformed files.
    return null;
  }

  const decision = resolveOpenClawDowngradeDecision(
    options.runtimeVersion,
    lastTouchedVersion,
  );
  if (decision.action === 'none') return null;
  if (decision.action === 'block') {
    throw new OpenClawDowngradeBlockedError(
      `Automatic OpenClaw downgrade from ${decision.fromVersion} to ${decision.toVersion} is not approved`,
    );
  }

  try {
    // The bundled runtime must accept the complete source config before UClaw changes it.
    await options.validateConfig();
  } catch (error) {
    throw new OpenClawDowngradeBlockedError(
      `OpenClaw ${decision.toVersion} cannot validate the ${decision.fromVersion} config`,
      { cause: error },
    );
  }

  try {
    const currentRawConfig = await readFile(options.configPath, 'utf8');
    if (currentRawConfig !== rawConfig) {
      throw new OpenClawDowngradeBlockedError(
        'OpenClaw config changed during downgrade validation; retry with a stable config',
      );
    }

    const backupPath = `${options.configPath}.uclaw-${decision.fromVersion}-to-${decision.toVersion}-${randomUUID()}.bak`;
    await createConfigBackup(options.configPath, backupPath);
    return {
      configPath: options.configPath,
      backupPath,
      fromVersion: decision.fromVersion,
      toVersion: decision.toVersion,
    };
  } catch (error) {
    if (error instanceof OpenClawDowngradeBlockedError) throw error;
    throw new OpenClawDowngradeBlockedError(
      'OpenClaw config cannot be snapshotted for the managed handoff',
      { cause: error },
    );
  }
}

/** Uses the bundled writer, then verifies that the runtime version owns the config. */
export async function commitOpenClawDowngrade(
  transaction: OpenClawDowngradeTransaction,
  stampConfig: () => Promise<void>,
): Promise<void> {
  await stampConfig();

  const rawConfig = await readFile(transaction.configPath, 'utf8');
  const lastTouchedVersion = readLastTouchedVersion(rawConfig);
  if (lastTouchedVersion !== transaction.toVersion) {
    throw new OpenClawDowngradeBlockedError(
      `OpenClaw config ownership was not stamped as ${transaction.toVersion}`,
    );
  }
}

/** Restores the exact pre-handoff config after a failed controlled startup. */
export async function rollbackOpenClawDowngrade(
  transaction: OpenClawDowngradeTransaction,
): Promise<void> {
  await copyFile(transaction.backupPath, transaction.configPath);
  await chmod(transaction.configPath, 0o600).catch(() => undefined);
}

/** Prepares the active config using the exact OpenClaw runtime bundled with UClaw. */
export async function prepareManagedOpenClawDowngrade(): Promise<OpenClawDowngradeTransaction | null> {
  const { resolveOpenClawConfigPath } = await import('../utils/paths');
  const configPath = resolveOpenClawConfigPath();
  const runtimeVersion = await readBundledOpenClawVersion();
  return await prepareOpenClawDowngrade({
    configPath,
    runtimeVersion,
    validateConfig: async () => {
      await runBundledOpenClawCommand({
        args: ['config', 'validate', '--json'],
        configPath,
        allowOlderBinaryDestructiveActions: false,
      });
    },
  });
}

/** Stamps 6.10 ownership through OpenClaw's validated, atomic config writer. */
export async function commitManagedOpenClawDowngrade(
  transaction: OpenClawDowngradeTransaction,
): Promise<void> {
  const gatewayMode = readGatewayMode(await readFile(transaction.configPath, 'utf8'));
  await commitOpenClawDowngrade(transaction, async () => {
    await runBundledOpenClawCommand({
      // Re-write an existing managed value so OpenClaw stamps its version without changing user behavior.
      args: ['config', 'set', 'gateway.mode', JSON.stringify(gatewayMode), '--strict-json'],
      configPath: transaction.configPath,
      allowOlderBinaryDestructiveActions: true,
    });
  });
}

/** Identifies fatal compatibility failures that must not enter reconnect recovery. */
export function isOpenClawDowngradeBlockedError(error: unknown): boolean {
  return error instanceof OpenClawDowngradeBlockedError
    || (error instanceof Error && error.name === 'OpenClawDowngradeBlockedError');
}

/** Identifies an unsafe writer state even when the error crosses a mocked module boundary. */
export function isOpenClawCommandTerminationUnconfirmedError(
  error: unknown,
): error is OpenClawCommandTerminationUnconfirmedError {
  return error instanceof OpenClawCommandTerminationUnconfirmedError
    || (error instanceof Error && error.name === 'OpenClawCommandTerminationUnconfirmedError');
}
