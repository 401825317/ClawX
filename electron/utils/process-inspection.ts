import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PROCESS_ANCESTRY_DEPTH = 32;
const KNOWN_PRODUCT_NAMES = new Set(['uclaw', 'clawx']);
const KNOWN_EXECUTABLE_NAMES = new Set(['uclaw', 'uclaw.exe', 'clawx', 'clawx.exe']);
const DEV_ELECTRON_EXECUTABLE_NAMES = new Set(['electron', 'electron.exe']);

export interface ProcessDescriptor {
  pid: number;
  parentPid?: number;
  name?: string;
  executablePath?: string;
  commandLine?: string;
  productName?: string;
  productVersion?: string;
}

export interface VerifiedUClawProcess {
  root: ProcessDescriptor;
  fingerprint: string;
}

function parsePositivePid(value: string | number | undefined): number | undefined {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/u.test(normalized)) return undefined;
  const pid = Number.parseInt(normalized, 10);
  return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

async function runProcessCommand(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function getListeningProcessIds(port: number): Promise<number[]> {
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return [];

  if (process.platform === 'win32') {
    const stdout = await runProcessCommand('netstat', ['-ano', '-p', 'tcp']);
    const pids = new Set<number>();
    for (const line of stdout.split(/\r?\n/u)) {
      const parts = line.trim().split(/\s+/u);
      if (parts.length < 5 || parts[0]?.toUpperCase() !== 'TCP' || parts[3]?.toUpperCase() !== 'LISTENING') {
        continue;
      }
      const localAddress = parts[1] ?? '';
      if (!localAddress.endsWith(`:${port}`)) continue;
      const pid = parsePositivePid(parts[4]);
      if (pid) pids.add(pid);
    }
    return [...pids];
  }

  const stdout = await runProcessCommand('lsof', [
    '-nP',
    `-iTCP:${port}`,
    '-sTCP:LISTEN',
    '-t',
  ]);
  return [...new Set(
    stdout
      .split(/\r?\n/u)
      .map((value) => parsePositivePid(value))
      .filter((value): value is number => value !== undefined),
  )];
}

export function buildWindowsProcessInspectionScript(pid: number): string {
  return [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";`,
    'if ($null -eq $p) { exit 1 };',
    '$productName = $null;',
    '$productVersion = $null;',
    'if ($p.ExecutablePath) {',
    '  try {',
    '    $versionInfo = (Get-Item -LiteralPath $p.ExecutablePath).VersionInfo;',
    '    $productName = $versionInfo.ProductName;',
    '    $productVersion = $versionInfo.ProductVersion;',
    '  } catch {}',
    '};',
    '[pscustomobject]@{',
    '  pid = [int]$p.ProcessId;',
    '  parentPid = [int]$p.ParentProcessId;',
    '  name = $p.Name;',
    '  executablePath = $p.ExecutablePath;',
    '  commandLine = $p.CommandLine;',
    '  productName = $productName;',
    '  productVersion = $productVersion;',
    '} | ConvertTo-Json -Compress',
  ].join(' ');
}

async function inspectWindowsProcess(pid: number): Promise<ProcessDescriptor | null> {
  const script = buildWindowsProcessInspectionScript(pid);
  const stdout = await runProcessCommand('powershell', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ]);
  if (!stdout) return null;

  try {
    const parsed = JSON.parse(stdout) as Partial<ProcessDescriptor>;
    const parsedPid = parsePositivePid(parsed.pid);
    if (!parsedPid) return null;
    return {
      pid: parsedPid,
      parentPid: parsePositivePid(parsed.parentPid),
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      executablePath: typeof parsed.executablePath === 'string' ? parsed.executablePath : undefined,
      commandLine: typeof parsed.commandLine === 'string' ? parsed.commandLine : undefined,
      productName: typeof parsed.productName === 'string' ? parsed.productName : undefined,
      productVersion: typeof parsed.productVersion === 'string' ? parsed.productVersion : undefined,
    };
  } catch {
    return null;
  }
}

async function inspectPosixProcess(pid: number): Promise<ProcessDescriptor | null> {
  const [parentRaw, commandRaw, argsRaw] = await Promise.all([
    runProcessCommand('ps', ['-p', String(pid), '-o', 'ppid=']),
    runProcessCommand('ps', ['-p', String(pid), '-o', 'comm=']),
    runProcessCommand('ps', ['-p', String(pid), '-o', 'args=']),
  ]);
  if (!parentRaw && !commandRaw && !argsRaw) return null;

  const executablePath = commandRaw || undefined;
  return {
    pid,
    parentPid: parsePositivePid(parentRaw.split(/\s+/u)[0]),
    name: executablePath ? basename(executablePath) : undefined,
    executablePath,
    commandLine: argsRaw || undefined,
  };
}

export async function inspectProcess(
  pidValue: string | number,
): Promise<ProcessDescriptor | null> {
  const pid = parsePositivePid(pidValue);
  if (!pid) return null;
  return process.platform === 'win32'
    ? await inspectWindowsProcess(pid)
    : await inspectPosixProcess(pid);
}

export function buildProcessFingerprint(processInfo: ProcessDescriptor): string {
  return [
    processInfo.pid,
    processInfo.name ?? '',
    processInfo.executablePath ?? '',
    processInfo.productName ?? '',
    processInfo.productVersion ?? '',
  ].join('|').toLowerCase();
}

export function isVerifiedUClawProcess(
  processInfo: ProcessDescriptor,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const executablePath = (processInfo.executablePath ?? '').replace(/\\/gu, '/');
  const executableName = basename(executablePath || processInfo.name || '').toLowerCase();
  const productName = (processInfo.productName ?? '').trim().toLowerCase();

  if (platform === 'win32') {
    return KNOWN_EXECUTABLE_NAMES.has(executableName)
      && KNOWN_PRODUCT_NAMES.has(productName);
  }

  if (platform === 'darwin') {
    return /\/(uclaw|clawx)\.app\/contents\/macos\/(uclaw|clawx)$/iu.test(executablePath);
  }

  return KNOWN_EXECUTABLE_NAMES.has(executableName);
}

export function isLikelyUClawRuntimeProcess(
  processInfo: ProcessDescriptor,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (isVerifiedUClawProcess(processInfo, platform)) return true;

  const executablePath = (processInfo.executablePath ?? '').replace(/\\/gu, '/');
  const executableName = basename(executablePath || processInfo.name || '').toLowerCase();
  const productName = (processInfo.productName ?? '').trim().toLowerCase();

  if (KNOWN_EXECUTABLE_NAMES.has(executableName)) return true;
  if (KNOWN_PRODUCT_NAMES.has(productName)) return true;
  if (DEV_ELECTRON_EXECUTABLE_NAMES.has(executableName) || productName === 'electron') return true;

  if (platform === 'darwin') {
    return /\/(uclaw|clawx)\.app\//iu.test(executablePath);
  }

  return false;
}

export function isClearlyForeignUClawLockOwner(
  processInfo: ProcessDescriptor,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return !isLikelyUClawRuntimeProcess(processInfo, platform);
}

export async function findVerifiedUClawOwner(
  pidValue: string | number,
): Promise<VerifiedUClawProcess | null> {
  const initialPid = parsePositivePid(pidValue);
  if (!initialPid) return null;

  const visited = new Set<number>();
  let currentPid: number | undefined = initialPid;
  for (let depth = 0; currentPid && depth < MAX_PROCESS_ANCESTRY_DEPTH; depth += 1) {
    if (visited.has(currentPid)) return null;
    visited.add(currentPid);

    const processInfo = await inspectProcess(currentPid);
    if (!processInfo) return null;
    if (isVerifiedUClawProcess(processInfo)) {
      return {
        root: processInfo,
        fingerprint: buildProcessFingerprint(processInfo),
      };
    }
    currentPid = processInfo.parentPid;
  }
  return null;
}

export async function isProcessDescendantOf(
  pidValue: string | number,
  ancestorValue: string | number | undefined,
): Promise<boolean> {
  return await isProcessDescendantByParentResolver(
    pidValue,
    ancestorValue,
    async (pid) => (await inspectProcess(pid))?.parentPid,
  );
}

export async function isProcessDescendantByParentResolver(
  pidValue: string | number,
  ancestorValue: string | number | undefined,
  resolveParentPid: (pid: number) => Promise<string | number | undefined>,
): Promise<boolean> {
  const pid = parsePositivePid(pidValue);
  const ancestor = parsePositivePid(ancestorValue);
  if (!pid || !ancestor) return false;
  if (pid === ancestor) return true;

  const visited = new Set<number>();
  let currentPid: number | undefined = pid;
  for (let depth = 0; currentPid && depth < MAX_PROCESS_ANCESTRY_DEPTH; depth += 1) {
    if (visited.has(currentPid)) return false;
    visited.add(currentPid);
    const parentPid = parsePositivePid(await resolveParentPid(currentPid));
    if (!parentPid) return false;
    if (parentPid === ancestor) return true;
    currentPid = parentPid;
  }
  return false;
}

export async function isProcessAlive(pidValue: string | number): Promise<boolean> {
  const pid = parsePositivePid(pidValue);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function getPosixDescendantProcessIds(rootPid: number): Promise<number[]> {
  const stdout = await runProcessCommand('ps', ['-axo', 'pid=,ppid=']);
  const childrenByParent = new Map<number, number[]>();
  for (const line of stdout.split(/\r?\n/u)) {
    const [pidRaw, parentRaw] = line.trim().split(/\s+/u);
    const pid = parsePositivePid(pidRaw);
    const parentPid = parsePositivePid(parentRaw);
    if (!pid || !parentPid) continue;
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid);
    childrenByParent.set(parentPid, children);
  }

  const descendants: number[] = [];
  const visit = (parentPid: number): void => {
    for (const childPid of childrenByParent.get(parentPid) ?? []) {
      visit(childPid);
      descendants.push(childPid);
    }
  };
  visit(rootPid);
  return descendants;
}

export async function terminateProcessTree(
  pidValue: string | number,
  force: boolean,
): Promise<void> {
  const pid = parsePositivePid(pidValue);
  if (!pid) return;

  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (force) args.push('/F');
    await runProcessCommand('taskkill', args);
    return;
  }

  if (force) {
    const descendants = await getPosixDescendantProcessIds(pid);
    for (const descendantPid of descendants) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // The process may have exited while the tree was being enumerated.
      }
    }
  }

  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // The process may already be gone.
  }
}
