import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import path from 'node:path';

export type GatewayOwnershipFixtureRecord = {
  version: 1;
  pid: number;
  processCreationIdentity: string;
  runtimeRoot: string;
  launchNonce: string;
  tokenHash: string;
  createdAt: number;
};

type WindowsOwnedGatewayOptions = {
  appRoot: string;
  portableRoot: string;
  osHome: string;
  runtimeCacheRoot: string;
  port: number;
  env?: NodeJS.ProcessEnv;
};

export type WindowsOwnedGatewayFixture = {
  pid: number;
  creationIdentity: string;
  ownershipPath: string;
  record: GatewayOwnershipFixtureRecord;
  isListening: () => Promise<boolean>;
  isAlive: () => Promise<boolean>;
  writeStaleCreationIdentity: () => Promise<void>;
  restoreOwnershipRecord: () => Promise<void>;
  stop: () => Promise<void>;
};

function userDataDir(portableRoot: string): string {
  return path.join(portableRoot, 'UClawData', 'clawx');
}

function ownershipPath(portableRoot: string): string {
  return path.join(userDataDir(portableRoot), 'gateway-ownership.json');
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function readGatewayToken(portableRoot: string): Promise<string> {
  const settingsPath = path.join(userDataDir(portableRoot), 'settings.json');
  const parsed = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  const token = typeof parsed.gatewayToken === 'string' ? parsed.gatewayToken : '';
  if (!token) throw new Error('Packaged Gateway fixture could not find the isolated gateway token.');
  return token;
}

function processCreationIdentity(pid: number): string {
  if (process.platform !== 'win32') {
    throw new Error('Windows owned Gateway fixture requires Windows.');
  }
  const script = `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`;
  const result = spawnSync(
    process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const value = String(result.stdout ?? '').trim();
  if (result.status !== 0 || !/^\d{1,30}$/u.test(value)) {
    throw new Error('Packaged Gateway fixture could not inspect process creation identity.');
  }
  return value;
}

async function writeRecord(filePath: string, record: GatewayOwnershipFixtureRecord): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, 'utf8');
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const listening = await probePort(port);
    if (listening) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Gateway fixture did not listen on its isolated port within ${timeoutMs}ms.`);
}

async function probePort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (value: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(1_000, () => finish(false));
  });
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The fixture may already have exited.
  }
}

export async function readGatewayOwnershipFixtureRecord(
  portableRoot: string,
): Promise<GatewayOwnershipFixtureRecord> {
  return JSON.parse(await readFile(ownershipPath(portableRoot), 'utf8')) as GatewayOwnershipFixtureRecord;
}

export async function startWindowsOwnedGatewayFixture(
  options: WindowsOwnedGatewayOptions,
): Promise<WindowsOwnedGatewayFixture> {
  if (process.platform !== 'win32') throw new Error('Windows owned Gateway fixture requires Windows.');
  const token = await readGatewayToken(options.portableRoot);
  const dataDir = userDataDir(options.portableRoot);
  const wrapperPath = path.join(dataDir, 'gateway-entry-wrapper.cjs');
  await access(wrapperPath);
  const portableId = (await readFile(path.join(options.portableRoot, 'UClawData', '.uclaw-portable-id'), 'utf8')).trim();
  if (!portableId) throw new Error('Packaged Gateway fixture could not find portable identity.');
  const stateDir = path.join(options.runtimeCacheRoot, 'profiles', portableId, 'openclaw-state');
  const openclawDir = path.join(options.appRoot, 'resources', 'openclaw');
  const entryScript = path.join(openclawDir, 'openclaw.mjs');
  const executable = path.join(options.appRoot, 'UClaw.exe');
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    ELECTRON_RUN_AS_NODE: '1',
    CLAWX_OPENCLAW_ENTRY: entryScript,
    OPENCLAW_HOME: path.join(options.portableRoot, 'UClawData', 'openclaw-home'),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, 'openclaw.json'),
    OPENCLAW_CONFIG: path.join(stateDir, 'openclaw.json'),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
  };
  delete env.NODE_OPTIONS;
  const child = spawn(
    executable,
    [wrapperPath, 'gateway', '--port', String(options.port), '--token', token, '--allow-unconfigured'],
    { cwd: openclawDir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  if (!child.pid) throw new Error('Packaged Gateway fixture did not receive a process ID.');
  await waitForPort(options.port);
  const pid = child.pid;
  const creationIdentity = processCreationIdentity(pid);
  const record: GatewayOwnershipFixtureRecord = {
    version: 1,
    pid,
    processCreationIdentity: creationIdentity,
    runtimeRoot: path.normalize(openclawDir).replace(/[\\/]+$/u, '').toLowerCase(),
    launchNonce: randomUUID(),
    tokenHash: sha256(token),
    createdAt: Date.now(),
  };
  const recordPath = ownershipPath(options.portableRoot);
  await writeRecord(recordPath, record);

  const fixture: WindowsOwnedGatewayFixture = {
    pid,
    creationIdentity,
    ownershipPath: recordPath,
    record,
    isListening: () => probePort(options.port),
    isAlive: async () => child.exitCode === null && await probePort(options.port),
    writeStaleCreationIdentity: async () => {
      await writeRecord(recordPath, {
        ...record,
        processCreationIdentity: '1'.repeat(Math.max(1, creationIdentity.length)),
      });
    },
    restoreOwnershipRecord: async () => await writeRecord(recordPath, record),
    stop: async () => {
      if (child.exitCode === null && child.pid) killTree(child.pid);
      await waitForExit(child, 10_000);
    },
  };
  return fixture;
}

export async function crashMainPreservingGateway(childPid: number): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows crash simulation requires Windows.');
  spawnSync('taskkill.exe', ['/pid', String(childPid), '/f'], {
    stdio: 'ignore',
    windowsHide: true,
  });
}
