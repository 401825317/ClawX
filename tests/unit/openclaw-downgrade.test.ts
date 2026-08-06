// @vitest-environment node

import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenClawCommandTerminationUnconfirmedError,
  OpenClawDowngradeBlockedError,
  commitOpenClawDowngrade,
  commitManagedOpenClawDowngrade,
  isOpenClawCommandTerminationUnconfirmedError,
  prepareOpenClawDowngrade,
  prepareManagedOpenClawDowngrade,
  resolveOpenClawDowngradeDecision,
  rollbackOpenClawDowngrade,
  runBundledOpenClawCommand,
} from '@electron/gateway/openclaw-downgrade';

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/uclaw-openclaw-downgrade-electron',
    isPackaged: false,
  },
}));

const roots: string[] = [];

class FakeCommandChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);
  exitCode: number | null = null;
}

async function createConfig(lastTouchedVersion: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-openclaw-downgrade-'));
  roots.push(root);
  const configPath = join(root, 'openclaw.json');
  await writeFile(configPath, JSON.stringify({
    meta: { lastTouchedVersion },
    commands: { restart: true },
    preserved: { value: 'keep-me' },
  }, null, 2));
  return configPath;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OpenClaw managed downgrade policy', () => {
  it('allows only the explicit 2026.6.11 to 2026.6.10 handoff', () => {
    expect(resolveOpenClawDowngradeDecision('2026.6.10', '2026.6.10')).toEqual({ action: 'none' });
    expect(resolveOpenClawDowngradeDecision('2026.6.10', '2026.6.11')).toEqual({
      action: 'migrate',
      fromVersion: '2026.6.11',
      toVersion: '2026.6.10',
    });
    expect(resolveOpenClawDowngradeDecision('2026.6.10', '2026.6.12')).toEqual({
      action: 'block',
      fromVersion: '2026.6.12',
      toVersion: '2026.6.10',
    });
    expect(resolveOpenClawDowngradeDecision('2026.6.10', '2026.6.9')).toEqual({ action: 'none' });
  });

  it('validates and backs up the 6.11 config before returning a transaction', async () => {
    const configPath = await createConfig('2026.6.11');
    const validateConfig = vi.fn().mockResolvedValue(undefined);

    const transaction = await prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig,
    });

    expect(transaction).not.toBeNull();
    expect(validateConfig).toHaveBeenCalledTimes(1);
    expect(await readFile(transaction!.backupPath, 'utf8')).toBe(await readFile(configPath, 'utf8'));
  });

  it('aborts when the config changes during read-only validation', async () => {
    const configPath = await createConfig('2026.6.11');

    await expect(prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: async () => {
        const config = JSON.parse(await readFile(configPath, 'utf8'));
        config.preserved.value = 'changed-during-validation';
        await writeFile(configPath, JSON.stringify(config, null, 2));
      },
    })).rejects.toBeInstanceOf(OpenClawDowngradeBlockedError);
  });

  it('blocks retry when the config disappears after validation', async () => {
    const configPath = await createConfig('2026.6.11');
    const { rm } = await import('node:fs/promises');

    await expect(prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: async () => {
        await rm(configPath);
      },
    })).rejects.toBeInstanceOf(OpenClawDowngradeBlockedError);
  });

  it('creates a fresh backup for each interrupted handoff attempt', async () => {
    const configPath = await createConfig('2026.6.11');
    const first = await prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: vi.fn().mockResolvedValue(undefined),
    });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.preserved.value = 'newer-user-change';
    await writeFile(configPath, JSON.stringify(config, null, 2));

    const second = await prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: vi.fn().mockResolvedValue(undefined),
    });

    expect(second!.backupPath).not.toBe(first!.backupPath);
    expect(JSON.parse(await readFile(second!.backupPath, 'utf8'))).toMatchObject({
      preserved: { value: 'newer-user-change' },
    });
  });

  it('does nothing for an already-owned 6.10 config', async () => {
    const configPath = await createConfig('2026.6.10');
    const validateConfig = vi.fn();

    await expect(prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig,
    })).resolves.toBeNull();
    expect(validateConfig).not.toHaveBeenCalled();
  });

  it('blocks unapproved newer versions without changing the config', async () => {
    const configPath = await createConfig('2026.6.12');
    const original = await readFile(configPath, 'utf8');

    await expect(prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: vi.fn(),
    })).rejects.toBeInstanceOf(OpenClawDowngradeBlockedError);
    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('commits only after the 6.10 writer stamps the config', async () => {
    const configPath = await createConfig('2026.6.11');
    const transaction = await prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: vi.fn().mockResolvedValue(undefined),
    });

    await commitOpenClawDowngrade(transaction!, async () => {
      const config = JSON.parse(await readFile(configPath, 'utf8'));
      config.meta.lastTouchedVersion = '2026.6.10';
      await writeFile(configPath, JSON.stringify(config, null, 2));
    });

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      meta: { lastTouchedVersion: '2026.6.10' },
      preserved: { value: 'keep-me' },
    });
  });

  it('restores the exact backup when the controlled startup fails', async () => {
    const configPath = await createConfig('2026.6.11');
    const original = await readFile(configPath, 'utf8');
    const transaction = await prepareOpenClawDowngrade({
      configPath,
      runtimeVersion: '2026.6.10',
      validateConfig: vi.fn().mockResolvedValue(undefined),
    });
    await writeFile(configPath, '{"changed":true}\n');

    await rollbackOpenClawDowngrade(transaction!);

    expect(await readFile(configPath, 'utf8')).toBe(original);
  });

  it('keeps an ordinary timeout pending until the killed command exits', async () => {
    const child = new FakeCommandChild();
    const forkProcess = vi.fn(() => child as unknown as ChildProcess);
    const command = runBundledOpenClawCommand({
      args: ['config', 'set', 'commands.restart', 'true', '--strict-json'],
      configPath: '/tmp/openclaw.json',
      allowOlderBinaryDestructiveActions: true,
    }, {
      forkProcess: forkProcess as typeof fork,
      timeoutMs: 10,
      terminationConfirmationTimeoutMs: 1_000,
    });
    let settled = false;
    const observed = command.then(
      () => ({ error: null }),
      (error: unknown) => ({ error }),
    ).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    });
    expect(settled).toBe(false);

    child.emit('error', new Error('termination signal failed'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);

    child.exitCode = 1;
    child.emit('exit', 1, 'SIGKILL');

    const result = await observed;
    expect(result.error).toEqual(expect.objectContaining({
      message: expect.stringContaining('timed out'),
    }));
    expect(result.error).not.toBeInstanceOf(OpenClawCommandTerminationUnconfirmedError);
  });

  it('rejects with an isolation error when command termination cannot be confirmed', async () => {
    const child = new FakeCommandChild();
    const forkProcess = vi.fn(() => child as unknown as ChildProcess);
    const command = runBundledOpenClawCommand({
      args: ['config', 'set', 'commands.restart', 'true', '--strict-json'],
      configPath: '/tmp/openclaw.json',
      allowOlderBinaryDestructiveActions: true,
    }, {
      forkProcess: forkProcess as typeof fork,
      timeoutMs: 10,
      terminationConfirmationTimeoutMs: 10,
    });

    const outcome = await Promise.race([
      command.then(
        () => ({ state: 'resolved' as const, error: null }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      ),
      new Promise<{ state: 'pending'; error: null }>((resolve) => {
        setTimeout(() => resolve({ state: 'pending', error: null }), 250);
      }),
    ]);

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(OpenClawCommandTerminationUnconfirmedError);
    expect(isOpenClawCommandTerminationUnconfirmedError(outcome.error)).toBe(true);
  });

  it('rejects immediately with an isolation error when force-kill throws', async () => {
    const killError = new Error('force-kill failed');
    const child = new FakeCommandChild();
    child.kill.mockImplementationOnce(() => {
      throw killError;
    });
    const forkProcess = vi.fn(() => child as unknown as ChildProcess);
    const command = runBundledOpenClawCommand({
      args: ['config', 'set', 'commands.restart', 'true', '--strict-json'],
      configPath: '/tmp/openclaw.json',
      allowOlderBinaryDestructiveActions: true,
    }, {
      forkProcess: forkProcess as typeof fork,
      timeoutMs: 10,
      terminationConfirmationTimeoutMs: 1_000,
    });

    const outcome = await Promise.race([
      command.then(
        () => ({ state: 'resolved' as const, error: null }),
        (error: unknown) => ({ state: 'rejected' as const, error }),
      ),
      new Promise<{ state: 'pending'; error: null }>((resolve) => {
        setTimeout(() => resolve({ state: 'pending', error: null }), 250);
      }),
    ]);

    expect(outcome.state).toBe('rejected');
    expect(outcome.error).toBeInstanceOf(OpenClawCommandTerminationUnconfirmedError);
    expect(outcome.error).toEqual(expect.objectContaining({ cause: killError }));
  });

  it('removes inherited downgrade permission regardless of environment key casing', async () => {
    const inheritedKey = 'OpenClaw_Allow_Older_Binary_Destructive_Actions';
    const child = new FakeCommandChild();
    let childEnv: NodeJS.ProcessEnv | undefined;
    const forkProcess = ((_modulePath, _args, options) => {
      childEnv = options.env;
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('exit', 0, null);
      });
      return child as unknown as ChildProcess;
    }) as typeof fork;
    process.env[inheritedKey] = '1';

    try {
      await runBundledOpenClawCommand({
        args: ['config', 'validate', '--json'],
        configPath: '/tmp/openclaw.json',
        allowOlderBinaryDestructiveActions: false,
      }, { forkProcess });

      expect(Object.keys(childEnv ?? {}).some(
        (key) => key.toUpperCase() === 'OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS',
      )).toBe(false);
    } finally {
      delete process.env[inheritedKey];
    }
  });
});

const integrationTest = process.env.RUN_OPENCLAW_DOWNGRADE_INTEGRATION === '1' ? it : it.skip;

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to reserve a local Gateway port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForIsolatedGatewayReady(child: ChildProcess, port: number): Promise<void> {
  const { probeGatewayReady } = await import('@electron/gateway/ws-client');
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Isolated Gateway exited before ready (code=${child.exitCode})`);
    }
    if (await probeGatewayReady(port, 500)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Isolated Gateway did not become ready on port ${port}`);
}

async function stopIsolatedGateway(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = once(child, 'exit').then(() => true);
  child.kill();
  const timedOut = new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000));
  if (await Promise.race([exited, timedOut])) return;
  child.kill('SIGKILL');
  await exited;
}

async function startIsolatedGateway(options: {
  port: number;
  configPath: string;
  stateDir: string;
  home: string;
  allowOlderBinaryDestructiveActions: boolean;
}): Promise<ChildProcess> {
  const { getOpenClawEmbeddedForkSpec } = await import('@electron/utils/openclaw-cli');
  const spec = getOpenClawEmbeddedForkSpec([
    'gateway',
    '--port', String(options.port),
    '--token', 'uclaw-downgrade-integration-token',
    '--allow-unconfigured',
  ]);
  const env: NodeJS.ProcessEnv = {
    ...spec.options.env,
    HOME: options.home,
    USERPROFILE: options.home,
    OPENCLAW_HOME: options.home,
    OPENCLAW_STATE_DIR: options.stateDir,
    OPENCLAW_CONFIG_PATH: options.configPath,
    OPENCLAW_CONFIG: options.configPath,
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
    OPENCLAW_NO_RESPAWN: '1',
  };
  delete env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS;
  delete env.OPENCLAW_SERVICE_MARKER;
  if (options.allowOlderBinaryDestructiveActions) {
    env.OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = '1';
  }

  const child = fork(spec.modulePath, spec.args, {
    ...spec.options,
    env,
  });
  child.stdout?.resume();
  child.stderr?.resume();
  try {
    await waitForIsolatedGatewayReady(child, options.port);
    return child;
  } catch (error) {
    await stopIsolatedGateway(child);
    throw error;
  }
}

integrationTest('hands an isolated 6.11 config to the real bundled 6.10 writer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-openclaw-real-downgrade-'));
  roots.push(root);
  const home = join(root, 'home');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const configPath = join(configDir, 'openclaw.json');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);
  await writeFile(configPath, JSON.stringify({
    meta: { lastTouchedVersion: '2026.6.11' },
    commands: { restart: false },
    gateway: { mode: 'local' },
    agents: { defaults: { workspace: join(root, 'workspace') } },
  }, null, 2));

  const keys = [
    'HOME',
    'USERPROFILE',
    'OPENCLAW_HOME',
    'OPENCLAW_STATE_DIR',
    'OPENCLAW_CONFIG_PATH',
    'OPENCLAW_CONFIG',
    'CLAWX_USER_DATA_DIR',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CONFIG: configPath,
    CLAWX_USER_DATA_DIR: join(root, 'clawx-user-data'),
  });

  try {
    const transaction = await prepareManagedOpenClawDowngrade();
    expect(transaction).not.toBeNull();
    await commitManagedOpenClawDowngrade(transaction!);

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      meta: { lastTouchedVersion: '2026.6.10' },
      commands: { restart: false },
      gateway: { mode: 'local' },
      agents: { defaults: { workspace: join(root, 'workspace') } },
    });
    await expect(readFile(join(stateDir, 'logs', 'config-audit.jsonl'), 'utf8')).resolves.toContain(
      '"event":"config.write"',
    );
    await expect(readFile(join(configDir, 'logs', 'config-audit.jsonl'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(prepareManagedOpenClawDowngrade()).resolves.toBeNull();
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 180_000);

integrationTest('starts again without downgrade permission after the controlled 6.11 handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-openclaw-gateway-downgrade-'));
  roots.push(root);
  const home = join(root, 'home');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const configPath = join(configDir, 'openclaw.json');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);
  await writeFile(configPath, JSON.stringify({
    meta: { lastTouchedVersion: '2026.6.11' },
    commands: { restart: false },
    gateway: { mode: 'local' },
    agents: { defaults: { workspace: join(root, 'workspace') } },
  }, null, 2));

  const keys = [
    'HOME',
    'USERPROFILE',
    'OPENCLAW_HOME',
    'OPENCLAW_STATE_DIR',
    'OPENCLAW_CONFIG_PATH',
    'OPENCLAW_CONFIG',
    'CLAWX_USER_DATA_DIR',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    OPENCLAW_HOME: home,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_CONFIG: configPath,
    CLAWX_USER_DATA_DIR: join(root, 'clawx-user-data'),
  });

  let firstGateway: ChildProcess | null = null;
  let secondGateway: ChildProcess | null = null;
  try {
    const transaction = await prepareManagedOpenClawDowngrade();
    expect(transaction).not.toBeNull();

    const firstPort = await reserveLocalPort();
    firstGateway = await startIsolatedGateway({
      port: firstPort,
      configPath,
      stateDir,
      home,
      allowOlderBinaryDestructiveActions: true,
    });
    await commitManagedOpenClawDowngrade(transaction!);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(firstGateway.exitCode).toBeNull();
    await waitForIsolatedGatewayReady(firstGateway, firstPort);
    await stopIsolatedGateway(firstGateway);
    firstGateway = null;

    expect(JSON.parse(await readFile(configPath, 'utf8'))).toMatchObject({
      meta: { lastTouchedVersion: '2026.6.10' },
      commands: { restart: false },
      agents: { defaults: { workspace: join(root, 'workspace') } },
    });

    secondGateway = await startIsolatedGateway({
      port: await reserveLocalPort(),
      configPath,
      stateDir,
      home,
      allowOlderBinaryDestructiveActions: false,
    });
    expect(secondGateway.exitCode).toBeNull();
  } finally {
    if (firstGateway) await stopIsolatedGateway(firstGateway);
    if (secondGateway) await stopIsolatedGateway(secondGateway);
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}, 180_000);
