import { app } from 'electron';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const OWNERSHIP_VERSION = 1;
const OWNERSHIP_FILE = 'gateway-ownership.json';
const PRESERVED_RECORD_SUFFIX = '.preserved';
const OWNERSHIP_LOCK_SUFFIX = '.lock';
const OWNERSHIP_LOCK_RETRY_MS = 25;
const OWNERSHIP_LOCK_TIMEOUT_MS = 10_000;
const OWNERSHIP_LOCK_STALE_MS = 5 * 60_000;

type OwnershipLockMetadata = {
  pid: number;
  createdAt: number | null;
  nonce: string | null;
};

type OwnershipLockSnapshot = {
  body: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

export type WindowsProcessIdentity = {
  processId: number;
  creationIdentity: string;
  parentProcessId?: number;
  executablePath?: string;
  commandLine?: string;
  parentExecutablePath?: string;
  /** Calculated by the canonical .NET implementation used by inspection and termination. */
  commandIdentityHash?: string;
};

export type GatewayOwnershipRecord = {
  version: 1;
  pid: number;
  processCreationIdentity: string;
  runtimeRoot: string;
  launchNonce: string;
  tokenHash: string;
  createdAt: number;
};

export type GatewayOwnershipInput = {
  pid: number;
  processCreationIdentity: string;
  runtimeRoot: string;
  token?: string;
  tokenHash?: string;
  launchNonce?: string;
};

export type GatewayOwnershipMatch = Pick<GatewayOwnershipRecord,
  'pid' | 'processCreationIdentity' | 'runtimeRoot' | 'launchNonce' | 'tokenHash'>;

export type OwnedGatewayChildMetadata = {
  record: GatewayOwnershipRecord;
  commandIdentityHash: string | null;
  exited: boolean;
  port: number;
};

export type WindowsOwnedProcessTerminationResult =
  | 'terminated'
  | 'not_found'
  | 'creation_identity_mismatch'
  | 'command_identity_mismatch'
  | 'ownership_record_mismatch'
  | 'verification_failed';

type OwnedGatewayChildState = {
  metadata: Omit<OwnedGatewayChildMetadata, 'exited'> | null;
  exited: boolean;
};

const ownedGatewayChildren = new WeakMap<object, OwnedGatewayChildState>();

function ownershipPath(): string {
  return path.join(app.getPath('userData'), OWNERSHIP_FILE);
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function snapshotFromStats(body: string, stats: Awaited<ReturnType<typeof fs.stat>>): OwnershipLockSnapshot {
  return {
    body,
    dev: Number(stats.dev),
    ino: Number(stats.ino),
    size: Number(stats.size),
    mtimeMs: Number(stats.mtimeMs),
    ctimeMs: Number(stats.ctimeMs),
    birthtimeMs: Number(stats.birthtimeMs),
  };
}

function lockSnapshotsMatch(left: OwnershipLockSnapshot, right: OwnershipLockSnapshot): boolean {
  return left.body === right.body
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

async function readOwnershipLockSnapshot(lockPath: string): Promise<OwnershipLockSnapshot | null> {
  try {
    const before = await fs.stat(lockPath);
    const body = await fs.readFile(lockPath, 'utf8');
    const after = await fs.stat(lockPath);
    const beforeSnapshot = snapshotFromStats(body, before);
    const afterSnapshot = snapshotFromStats(body, after);
    return lockSnapshotsMatch(beforeSnapshot, afterSnapshot) ? afterSnapshot : null;
  } catch {
    return null;
  }
}

function parseOwnershipLock(body: string): OwnershipLockMetadata | null {
  const value = body.trim();
  if (/^\d+$/u.test(value)) {
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0
      ? { pid, createdAt: null, nonce: null }
      : null;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    const pid = record.pid;
    const createdAt = record.createdAt;
    const nonce = record.nonce;
    if (
      !Number.isSafeInteger(pid)
      || Number(pid) <= 0
      || typeof createdAt !== 'number'
      || !Number.isFinite(createdAt)
      || typeof nonce !== 'string'
      || !/^[A-Za-z0-9_-]{8,128}$/u.test(nonce)
    ) {
      return null;
    }
    return { pid: Number(pid), createdAt, nonce };
  } catch {
    return null;
  }
}

function isDefinitelyDeadProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and other failures mean that liveness is unknown. Never reclaim
    // on an uncertain probe; the age check below remains the safe fallback.
    return isErrno(error, 'ESRCH');
  }
}

function isSignificantlyOldLock(snapshot: OwnershipLockSnapshot, metadata: OwnershipLockMetadata | null): boolean {
  const createdAt = metadata?.createdAt ?? snapshot.mtimeMs;
  return Number.isFinite(createdAt) && Date.now() - createdAt >= OWNERSHIP_LOCK_STALE_MS;
}

async function unlinkOwnershipLockIfUnchanged(
  lockPath: string,
  expected: OwnershipLockSnapshot,
): Promise<boolean> {
  const current = await readOwnershipLockSnapshot(lockPath);
  if (!current || !lockSnapshotsMatch(expected, current)) return false;
  try {
    await fs.unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function reclaimStaleOwnershipLock(lockPath: string): Promise<boolean> {
  const snapshot = await readOwnershipLockSnapshot(lockPath);
  if (!snapshot) return false;
  const metadata = parseOwnershipLock(snapshot.body);
  const dead = metadata ? isDefinitelyDeadProcess(metadata.pid) : false;
  if (!dead && !isSignificantlyOldLock(snapshot, metadata)) return false;

  // Re-read the exact body and file identity immediately before unlinking so
  // a contender that replaced the lock is never intentionally removed.
  return unlinkOwnershipLockIfUnchanged(lockPath, snapshot);
}

function createOwnershipLockBody(): string {
  return `${JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
    nonce: randomUUID(),
  })}\n`;
}

async function withOwnershipLock<T>(task: () => Promise<T>): Promise<T> {
  const target = ownershipPath();
  const lockPath = `${target}${OWNERSHIP_LOCK_SUFFIX}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const deadline = Date.now() + OWNERSHIP_LOCK_TIMEOUT_MS;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let lockSnapshot: OwnershipLockSnapshot | null = null;
  let lockBody = '';
  while (!handle) {
    let acquired = false;
    try {
      handle = await fs.open(lockPath, 'wx');
      acquired = true;
      lockBody = createOwnershipLockBody();
      await handle.writeFile(lockBody, 'utf8');
      await handle.sync();
      lockSnapshot = snapshotFromStats(lockBody, await handle.stat());
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (acquired) {
        const partialSnapshot = await readOwnershipLockSnapshot(lockPath);
        if (partialSnapshot && partialSnapshot.body === lockBody) {
          await unlinkOwnershipLockIfUnchanged(lockPath, partialSnapshot);
        }
      } else if (isErrno(error, 'EEXIST') && await reclaimStaleOwnershipLock(lockPath)) {
        continue;
      }
      handle = null;
      lockSnapshot = null;
      lockBody = '';
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the Gateway ownership lock', { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, OWNERSHIP_LOCK_RETRY_MS));
    }
  }

  try {
    return await task();
  } finally {
    await handle.close().catch(() => undefined);
    if (lockSnapshot) await unlinkOwnershipLockIfUnchanged(lockPath, lockSnapshot);
  }
}

function normalizeRecord(record: GatewayOwnershipRecord): GatewayOwnershipRecord {
  return { ...record, runtimeRoot: normalizeRoot(record.runtimeRoot) };
}

async function readRecordAt(filePath: string): Promise<GatewayOwnershipRecord | null> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
    return isValidRecord(parsed) ? normalizeRecord(parsed) : null;
  } catch {
    return null;
  }
}

function recordsMatch(expected: GatewayOwnershipMatch, record: GatewayOwnershipRecord, runtimeRoot: string): boolean {
  const expectedTokenHash = Buffer.from(expected.tokenHash, 'utf8');
  const recordTokenHash = Buffer.from(record.tokenHash, 'utf8');
  return expectedTokenHash.length === recordTokenHash.length
    && timingSafeEqual(expectedTokenHash, recordTokenHash)
    && record.pid === expected.pid
    && record.processCreationIdentity === expected.processCreationIdentity
    && record.launchNonce === expected.launchNonce
    && record.runtimeRoot === runtimeRoot;
}

async function preservedRecordPaths(target: string): Promise<string[]> {
  try {
    return (await fs.readdir(path.dirname(target)))
      .filter((name) => name.startsWith(`${OWNERSHIP_FILE}.`) && name.endsWith(PRESERVED_RECORD_SUFFIX))
      .map((name) => path.join(path.dirname(target), name));
  } catch {
    return [];
  }
}

async function clearMatchingPreservedRecord(expected: GatewayOwnershipMatch, runtimeRoot: string): Promise<boolean> {
  const target = ownershipPath();
  for (const filePath of await preservedRecordPaths(target)) {
    const record = await readRecordAt(filePath);
    if (!record || !recordsMatch(expected, record, runtimeRoot)) continue;
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function normalizeRoot(value: string): string {
  return path.normalize(path.resolve(value)).replace(/[\\/]+$/u, '').toLowerCase();
}

export function createWindowsProcessCommandIdentityHash(
  identity: Pick<WindowsProcessIdentity, 'commandIdentityHash'>,
): string | null {
  return identity.commandIdentityHash?.trim() && isSha256(identity.commandIdentityHash.trim())
    ? identity.commandIdentityHash.trim()
    : null;
}

export function gatewayOwnershipRecordsMatch(
  expected: GatewayOwnershipMatch,
  record: GatewayOwnershipRecord,
): boolean {
  return recordsMatch(expected, normalizeRecord(record), normalizeRoot(expected.runtimeRoot));
}

export function trackOwnedGatewayChild(child: object): void {
  if (!ownedGatewayChildren.has(child)) {
    ownedGatewayChildren.set(child, { metadata: null, exited: false });
  }
}

export function registerOwnedGatewayChildMetadata(
  child: object,
  options: {
    record: GatewayOwnershipRecord;
    processIdentity: WindowsProcessIdentity;
    port: number;
  },
): void {
  if (options.processIdentity.processId !== options.record.pid) {
    throw new Error('Gateway child ownership PID does not match the inspected process');
  }
  if (options.processIdentity.creationIdentity !== options.record.processCreationIdentity) {
    throw new Error('Gateway child ownership creation identity does not match the inspected process');
  }
  if (!Number.isSafeInteger(options.port) || options.port <= 0 || options.port > 65535) {
    throw new Error('Gateway child ownership requires a valid port');
  }

  const current = ownedGatewayChildren.get(child);
  ownedGatewayChildren.set(child, {
    exited: current?.exited ?? false,
    metadata: {
      record: { ...options.record },
      commandIdentityHash: createWindowsProcessCommandIdentityHash(options.processIdentity),
      port: options.port,
    },
  });
}

export function markOwnedGatewayChildExited(child: object): void {
  const current = ownedGatewayChildren.get(child);
  ownedGatewayChildren.set(child, {
    metadata: current?.metadata ?? null,
    exited: true,
  });
}

export function getOwnedGatewayChildMetadata(child: object): OwnedGatewayChildMetadata | null {
  const current = ownedGatewayChildren.get(child);
  if (!current?.metadata) return null;
  return {
    ...current.metadata,
    record: { ...current.metadata.record },
    exited: current.exited,
  };
}

export function hasOwnedGatewayChildExited(child: object): boolean {
  return ownedGatewayChildren.get(child)?.exited === true;
}

export function hashGatewayToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function isValidRecord(value: unknown): value is GatewayOwnershipRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === OWNERSHIP_VERSION
    && typeof record.pid === 'number'
    && Number.isSafeInteger(record.pid)
    && record.pid > 0
    && typeof record.processCreationIdentity === 'string'
    && record.processCreationIdentity.length > 0
    && typeof record.runtimeRoot === 'string'
    && record.runtimeRoot.length > 0
    && typeof record.launchNonce === 'string'
    && /^[A-Za-z0-9_-]{8,128}$/u.test(record.launchNonce)
    && isSha256(record.tokenHash)
    && typeof record.createdAt === 'number'
    && Number.isFinite(record.createdAt);
}

async function canonicalizeRoot(value: string): Promise<string> {
  try {
    return normalizeRoot(await fs.realpath(value));
  } catch {
    return normalizeRoot(value);
  }
}

export async function createGatewayOwnershipRecord(input: GatewayOwnershipInput): Promise<GatewayOwnershipRecord> {
  if (!Number.isSafeInteger(input.pid) || input.pid <= 0) {
    throw new Error('Cannot create Gateway ownership record without a valid PID');
  }
  if (!input.processCreationIdentity.trim()) {
    throw new Error('Cannot create Gateway ownership record without process creation identity');
  }
  const tokenHash = input.tokenHash ?? (input.token ? hashGatewayToken(input.token) : '');
  if (!isSha256(tokenHash)) {
    throw new Error('Cannot create Gateway ownership record without a token hash');
  }
  return {
    version: OWNERSHIP_VERSION,
    pid: input.pid,
    processCreationIdentity: input.processCreationIdentity.trim(),
    runtimeRoot: await canonicalizeRoot(input.runtimeRoot),
    launchNonce: input.launchNonce ?? randomUUID(),
    tokenHash,
    createdAt: Date.now(),
  };
}

export async function writeGatewayOwnershipRecord(record: GatewayOwnershipRecord): Promise<void> {
  if (!isValidRecord(record)) throw new Error('Refusing to write an invalid Gateway ownership record');
  await withOwnershipLock(async () => {
    const target = ownershipPath();
    const temporary = `${target}.${record.launchNonce}.tmp`;
    const body = `${JSON.stringify(record)}\n`;
    try {
      await fs.writeFile(temporary, body, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, target);
    } finally {
      await fs.unlink(temporary).catch(() => undefined);
    }
  });
}

export async function readGatewayOwnershipRecord(): Promise<GatewayOwnershipRecord | null> {
  const target = ownershipPath();
  const current = await readRecordAt(target);
  if (current) return current;

  try {
    const records = await Promise.all((await preservedRecordPaths(target)).map(readRecordAt));
    return records.filter((record): record is GatewayOwnershipRecord => record !== null)
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
  } catch {
    // An inaccessible userData directory means ownership is unknown.
  }
  return null;
}

export async function clearGatewayOwnershipRecordIfMatches(expected: GatewayOwnershipMatch): Promise<boolean> {
  const runtimeRoot = await canonicalizeRoot(expected.runtimeRoot);
  return await withOwnershipLock(async () => {
    const target = ownershipPath();
    // Read and unlink while holding the same lock as writers. Never move the
    // canonical path to a quarantine name: doing so can steal a newer record
    // written by another process between an old read and this cleanup.
    const current = await readRecordAt(target);
    if (current && recordsMatch(expected, current, runtimeRoot)) {
      await fs.unlink(target);
      return true;
    }
    return await clearMatchingPreservedRecord(expected, runtimeRoot);
  });
}

function powershellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

const TERMINATE_OWNED_WINDOWS_PROCESS_TREE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class UClawGatewayNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public UInt32 Low;
    public UInt32 High;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(
    IntPtr processHandle,
    out FILETIME creationTime,
    out FILETIME exitTime,
    out FILETIME kernelTime,
    out FILETIME userTime
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);
}
'@

Add-Type -TypeDefinition @'
using System;
using System.Security.Cryptography;
using System.Text;

public static class UClawGatewayIdentity {
  public static string NormalizePath(string value) {
    var normalized = (value ?? string.Empty).Trim().Replace('/', '\\');
    if (normalized.StartsWith("\\\\?\\", StringComparison.Ordinal)) normalized = normalized.Substring(4);
    return normalized.ToLowerInvariant();
  }

  public static string CommandIdentityHash(string executablePath, string commandLine) {
    if (string.IsNullOrWhiteSpace(executablePath) || string.IsNullOrWhiteSpace(commandLine)) return string.Empty;
    var material = NormalizePath(executablePath) + "\n" + (commandLine ?? string.Empty).Trim().ToLowerInvariant();
    using (var sha256 = SHA256.Create()) {
      var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(material));
      var builder = new StringBuilder(bytes.Length * 2);
      foreach (var value in bytes) builder.Append(value.ToString("x2"));
      return builder.ToString();
    }
  }
}
'@

function Write-UClawResult([string]$status) {
  [pscustomobject]@{ Status = $status } | ConvertTo-Json -Compress
}

$targetPid = [UInt32]$env:UCLAW_GATEWAY_TARGET_PID
$expectedCreation = [string]$env:UCLAW_GATEWAY_CREATION_IDENTITY
$expectedCommandHash = [string]$env:UCLAW_GATEWAY_COMMAND_IDENTITY_HASH
$ownershipPath = [string]$env:UCLAW_GATEWAY_OWNERSHIP_PATH
$expectedOwnershipHash = [string]$env:UCLAW_GATEWAY_OWNERSHIP_RECORD_HASH
$queryLimitedInformation = [UInt32]0x1000
$synchronize = [UInt32]0x00100000
$handle = [UClawGatewayNative]::OpenProcess(
  ($queryLimitedInformation -bor $synchronize),
  $false,
  $targetPid
)

if ($handle -eq [IntPtr]::Zero) {
  $openProcessError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($openProcessError -eq 87 -or $openProcessError -eq 1168) {
    Write-UClawResult 'not_found'
  } else {
    Write-UClawResult 'verification_failed'
  }
  exit 0
}

$ownershipStream = $null
try {
  try {
    $ownershipStream = [System.IO.File]::Open(
      $ownershipPath,
      [System.IO.FileMode]::Open,
      [System.IO.FileAccess]::Read,
      [System.IO.FileShare]::Read
    )
  } catch [System.IO.FileNotFoundException] {
    Write-UClawResult 'ownership_record_mismatch'
    exit 0
  } catch [System.IO.DirectoryNotFoundException] {
    Write-UClawResult 'ownership_record_mismatch'
    exit 0
  } catch {
    Write-UClawResult 'verification_failed'
    exit 0
  }

  $ownershipSha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $ownershipHashBytes = $ownershipSha256.ComputeHash($ownershipStream)
    $actualOwnershipHash = ([BitConverter]::ToString($ownershipHashBytes)).Replace('-', '').ToLowerInvariant()
  } finally {
    $ownershipSha256.Dispose()
  }
  if ($actualOwnershipHash -ne $expectedOwnershipHash) {
    Write-UClawResult 'ownership_record_mismatch'
    exit 0
  }

  $creation = New-Object UClawGatewayNative+FILETIME
  $exit = New-Object UClawGatewayNative+FILETIME
  $kernel = New-Object UClawGatewayNative+FILETIME
  $user = New-Object UClawGatewayNative+FILETIME
  if (-not [UClawGatewayNative]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) {
    throw 'GetProcessTimes failed'
  }

  $handleCreation = [Int64]((([UInt64]$creation.High) -shl 32) -bor [UInt64]$creation.Low)
  if ($handleCreation.ToString() -ne $expectedCreation) {
    Write-UClawResult 'creation_identity_mismatch'
    exit 0
  }

  $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $targetPid)
  if ($null -eq $process) {
    Write-UClawResult 'not_found'
    exit 0
  }
  $cimCreation = [Int64]$process.CreationDate.ToFileTimeUtc()
  if ([Math]::Abs($handleCreation - $cimCreation) -gt 10) {
    Write-UClawResult 'creation_identity_mismatch'
    exit 0
  }

  $executablePath = [string]$process.ExecutablePath
  $commandLine = [string]$process.CommandLine
  if ([string]::IsNullOrWhiteSpace($executablePath) -or [string]::IsNullOrWhiteSpace($commandLine)) {
    Write-UClawResult 'command_identity_mismatch'
    exit 0
  }
  $actualCommandHash = [UClawGatewayIdentity]::CommandIdentityHash($executablePath, $commandLine)
  if ($actualCommandHash -ne $expectedCommandHash) {
    Write-UClawResult 'command_identity_mismatch'
    exit 0
  }

  $taskkillPath = Join-Path $env:SystemRoot 'System32\taskkill.exe'
  & $taskkillPath '/F' '/PID' $targetPid.ToString() '/T' *> $null
  if ($LASTEXITCODE -ne 0) {
    if ([UClawGatewayNative]::WaitForSingleObject($handle, 0) -eq 0) {
      Write-UClawResult 'not_found'
      exit 0
    }
    throw 'taskkill failed'
  }
  Write-UClawResult 'terminated'
} finally {
  if ($null -ne $ownershipStream) {
    $ownershipStream.Dispose()
  }
  [void][UClawGatewayNative]::CloseHandle($handle)
}
`;

function parseWindowsTerminationResult(stdout: string): WindowsOwnedProcessTerminationResult | null {
  const lines = stdout.trim().split(/\r?\n/u).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as { Status?: unknown };
      if (
        parsed.Status === 'terminated'
        || parsed.Status === 'not_found'
        || parsed.Status === 'creation_identity_mismatch'
        || parsed.Status === 'command_identity_mismatch'
        || parsed.Status === 'ownership_record_mismatch'
        || parsed.Status === 'verification_failed'
      ) {
        return parsed.Status;
      }
    } catch {
      // Ignore non-JSON PowerShell startup output and inspect the next line.
    }
  }
  return null;
}

export async function terminateWindowsProcessTreeIfOwned(options: {
  record: GatewayOwnershipRecord;
  commandIdentityHash: string;
}): Promise<WindowsOwnedProcessTerminationResult> {
  if (process.platform !== 'win32') {
    throw new Error('Windows Gateway process-tree termination is only available on Windows');
  }
  if (!isValidRecord(options.record)) {
    throw new Error('Refusing to terminate a Gateway process tree without a valid ownership record');
  }
  if (!Number.isSafeInteger(options.record.pid) || options.record.pid <= 0) {
    throw new Error('Refusing to terminate a Gateway process tree without a valid PID');
  }
  if (!/^\d{1,20}$/u.test(options.record.processCreationIdentity.trim()) || !isSha256(options.commandIdentityHash)) {
    throw new Error('Refusing to terminate a Gateway process tree without verified process identity');
  }

  const encodedCommand = Buffer.from(TERMINATE_OWNED_WINDOWS_PROCESS_TREE_SCRIPT, 'utf16le').toString('base64');
  const expectedRecordHash = createHash('sha256')
    .update(`${JSON.stringify(options.record)}\n`, 'utf8')
    .digest('hex');
  return await new Promise<WindowsOwnedProcessTerminationResult>((resolve, reject) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      {
        timeout: 10_000,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          UCLAW_GATEWAY_TARGET_PID: String(options.record.pid),
          UCLAW_GATEWAY_CREATION_IDENTITY: options.record.processCreationIdentity,
          UCLAW_GATEWAY_COMMAND_IDENTITY_HASH: options.commandIdentityHash,
          UCLAW_GATEWAY_OWNERSHIP_PATH: ownershipPath(),
          UCLAW_GATEWAY_OWNERSHIP_RECORD_HASH: expectedRecordHash,
        },
      },
      (error, stdout) => {
        if (error) {
          reject(new Error('Verified Windows Gateway termination helper failed', { cause: error }));
          return;
        }
        const result = parseWindowsTerminationResult(String(stdout));
        if (!result) {
          reject(new Error('Verified Windows Gateway termination helper returned an invalid result'));
          return;
        }
        resolve(result);
      },
    );
  });
}

const INSPECT_WINDOWS_GATEWAY_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class UClawGatewayInspectionNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME {
    public UInt32 Low;
    public UInt32 High;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetProcessTimes(
    IntPtr processHandle,
    out FILETIME creationTime,
    out FILETIME exitTime,
    out FILETIME kernelTime,
    out FILETIME userTime
  );

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

Add-Type -TypeDefinition @'
using System;
using System.Security.Cryptography;
using System.Text;

public static class UClawGatewayIdentity {
  public static string NormalizePath(string value) {
    var normalized = (value ?? string.Empty).Trim().Replace('/', '\\');
    if (normalized.StartsWith("\\\\?\\", StringComparison.Ordinal)) normalized = normalized.Substring(4);
    return normalized.ToLowerInvariant();
  }

  public static string CommandIdentityHash(string executablePath, string commandLine) {
    if (string.IsNullOrWhiteSpace(executablePath) || string.IsNullOrWhiteSpace(commandLine)) return string.Empty;
    var material = NormalizePath(executablePath) + "\n" + (commandLine ?? string.Empty).Trim().ToLowerInvariant();
    using (var sha256 = SHA256.Create()) {
      var bytes = sha256.ComputeHash(Encoding.UTF8.GetBytes(material));
      var builder = new StringBuilder(bytes.Length * 2);
      foreach (var value in bytes) builder.Append(value.ToString("x2"));
      return builder.ToString();
    }
  }
}
'@

$targetPid = [UInt32]$env:UCLAW_GATEWAY_TARGET_PID
$queryLimitedInformation = [UInt32]0x1000
$handle = [UClawGatewayInspectionNative]::OpenProcess($queryLimitedInformation, $false, $targetPid)
if ($handle -eq [IntPtr]::Zero) {
  exit 3
}

try {
  $creation = New-Object UClawGatewayInspectionNative+FILETIME
  $exit = New-Object UClawGatewayInspectionNative+FILETIME
  $kernel = New-Object UClawGatewayInspectionNative+FILETIME
  $user = New-Object UClawGatewayInspectionNative+FILETIME
  if (-not [UClawGatewayInspectionNative]::GetProcessTimes($handle, [ref]$creation, [ref]$exit, [ref]$kernel, [ref]$user)) {
    exit 4
  }
  $nativeCreation = [Int64]((([UInt64]$creation.High) -shl 32) -bor [UInt64]$creation.Low)

  $process = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $targetPid)
  if ($null -eq $process) {
    exit 3
  }
  $cimCreation = [Int64]$process.CreationDate.ToFileTimeUtc()
  if ([Math]::Abs($nativeCreation - $cimCreation) -gt 10) {
    exit 4
  }

  $parent = $null
  if ($process.ParentProcessId) {
    $parent = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $process.ParentProcessId) -ErrorAction SilentlyContinue
  }
  [pscustomobject]@{
    ProcessId = $process.ProcessId
    CreationIdentity = $nativeCreation.ToString()
    ParentProcessId = $process.ParentProcessId
    ExecutablePath = $process.ExecutablePath
    CommandLine = $process.CommandLine
    ParentExecutablePath = $parent.ExecutablePath
    CommandIdentityHash = [UClawGatewayIdentity]::CommandIdentityHash($process.ExecutablePath, $process.CommandLine)
  } | ConvertTo-Json -Compress
} finally {
  [void][UClawGatewayInspectionNative]::CloseHandle($handle)
}
`;

export async function inspectWindowsGatewayProcess(pid: number): Promise<WindowsProcessIdentity | null> {
  if (process.platform !== 'win32') return null;
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const encodedCommand = Buffer.from(INSPECT_WINDOWS_GATEWAY_PROCESS_SCRIPT, 'utf16le').toString('base64');
  return await new Promise<WindowsProcessIdentity | null>((resolve) => {
    execFile(
      powershellPath(),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand],
      {
        timeout: 5000,
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          UCLAW_GATEWAY_TARGET_PID: String(pid),
        },
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const parsed = JSON.parse(String(stdout)) as Record<string, unknown>;
          if (Number(parsed.ProcessId) !== pid || !String(parsed.CreationIdentity ?? '').trim()) {
            resolve(null);
            return;
          }
          resolve({
            processId: pid,
            creationIdentity: String(parsed.CreationIdentity),
            parentProcessId: typeof parsed.ParentProcessId === 'number' ? parsed.ParentProcessId : undefined,
            executablePath: typeof parsed.ExecutablePath === 'string' ? parsed.ExecutablePath : undefined,
            commandLine: typeof parsed.CommandLine === 'string' ? parsed.CommandLine : undefined,
            parentExecutablePath: typeof parsed.ParentExecutablePath === 'string' ? parsed.ParentExecutablePath : undefined,
            commandIdentityHash: typeof parsed.CommandIdentityHash === 'string' ? parsed.CommandIdentityHash : undefined,
          });
        } catch {
          resolve(null);
        }
      },
    );
  });
}

export async function getWindowsProcessCreationIdentity(pid: number): Promise<string | null> {
  return (await inspectWindowsGatewayProcess(pid))?.creationIdentity ?? null;
}
