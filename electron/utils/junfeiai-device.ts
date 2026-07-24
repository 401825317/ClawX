import { app } from 'electron';
import crypto from 'node:crypto';
import { access, chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize, resolve } from 'node:path';
import {
  loadOrCreateDeviceIdentity,
  type DeviceIdentity,
} from './device-identity';

export type UclawDevicePayload = {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
};

export type UclawDeviceActivationState = {
  version: 1;
  deviceId: string;
  activated: true;
  onboardingCompleted: true;
  activatedAt: string;
  lastSeenAt: string;
  source: 'auth-token' | 'login' | 'register';
  userId?: string;
  username?: string;
  email?: string;
};

export type ManagedDeviceActivationFileSnapshot = {
  path: string;
  bytes: Buffer | null;
};

export type ManagedDeviceActivationFilesSnapshot = {
  current: ManagedDeviceActivationFileSnapshot;
  stable: ManagedDeviceActivationFileSnapshot;
};

export type ManagedDeviceActivationFilesApplied = Partial<ManagedDeviceActivationFilesSnapshot>;

type ActivationWriteObserver = (snapshot: ManagedDeviceActivationFileSnapshot) => void;

export const UCLAW_DEVICE_IDENTITY_FILE = 'uclaw-device-identity.json';
export const UCLAW_DEVICE_ACTIVATION_FILE = 'uclaw-device-activation.json';

const LEGACY_DEVICE_IDENTITY_FILE = 'clawx-device-identity.json';
const LEGACY_DEVICE_ACTIVATION_FILE = 'clawx-device-activation.json';
const STABLE_IDENTITY_DIR = 'UClaw';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

type ParsedJson = Record<string, unknown>;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(filePath: string): string {
  return normalize(resolve(filePath));
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const filePath of paths) {
    if (!filePath) continue;
    const normalized = normalizePath(filePath);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function getAppDataPath(): string {
  try {
    const appData = app.getPath('appData');
    if (appData) return appData;
  } catch {
    // Electron may not expose appData during early test/bootstrap execution.
  }
  return process.env.APPDATA || process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

function getStableIdentityDir(): string {
  return join(getAppDataPath(), STABLE_IDENTITY_DIR);
}

function getStableUclawDeviceActivationPath(): string {
  return join(getStableIdentityDir(), UCLAW_DEVICE_ACTIVATION_FILE);
}

export function getUclawDeviceIdentityPath(): string {
  return join(app.getPath('userData'), UCLAW_DEVICE_IDENTITY_FILE);
}

export function getUclawDeviceActivationPath(): string {
  return join(app.getPath('userData'), UCLAW_DEVICE_ACTIVATION_FILE);
}

export function getStableUclawDeviceIdentityPath(): string {
  return join(getStableIdentityDir(), UCLAW_DEVICE_IDENTITY_FILE);
}

async function snapshotActivationFile(filePath: string): Promise<ManagedDeviceActivationFileSnapshot> {
  try {
    return { path: filePath, bytes: await readFile(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: filePath, bytes: null };
    }
    throw error;
  }
}

/** Capture managed-auth activation files without triggering migration or permission changes. */
export async function snapshotManagedDeviceActivationFiles(): Promise<ManagedDeviceActivationFilesSnapshot> {
  const currentPath = getUclawDeviceActivationPath();
  const stablePath = getStableUclawDeviceActivationPath();
  const [current, stable] = await Promise.all([
    snapshotActivationFile(currentPath),
    snapshotActivationFile(stablePath),
  ]);
  return { current, stable };
}

async function restoreActivationFile(snapshot: ManagedDeviceActivationFileSnapshot): Promise<void> {
  if (snapshot.bytes !== null) {
    await mkdir(dirname(snapshot.path), { recursive: true });
    await writeFile(snapshot.path, snapshot.bytes, { mode: 0o600 });
    await chmod(snapshot.path, 0o600);
    return;
  }

  // The file did not exist before the managed-auth transaction.
  try {
    await unlink(snapshot.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Restore the exact managed-auth activation files captured before a transaction. */
export async function restoreManagedDeviceActivationFiles(
  snapshot: ManagedDeviceActivationFilesApplied,
): Promise<void> {
  const errors: unknown[] = [];
  for (const fileSnapshot of [snapshot.current, snapshot.stable]) {
    if (!fileSnapshot) continue;
    try {
      await restoreActivationFile(fileSnapshot);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Failed to restore managed device activation files');
  }
}

/** Candidate paths are read-only migration sources; callers must never edit them in place. */
export function getUclawDeviceIdentityCandidatePaths(): string[] {
  const userData = app.getPath('userData');
  const appData = getAppDataPath();
  const stableDir = getStableIdentityDir();
  return uniquePaths([
    join(userData, LEGACY_DEVICE_IDENTITY_FILE),
    join(stableDir, UCLAW_DEVICE_IDENTITY_FILE),
    join(stableDir, LEGACY_DEVICE_IDENTITY_FILE),
    join(appData, 'clawx', LEGACY_DEVICE_IDENTITY_FILE),
    join(appData, 'ClawX', LEGACY_DEVICE_IDENTITY_FILE),
  ]);
}

function readPublicKeyBytes(publicKeyPem: string): Buffer {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  if (
    der.length === ED25519_SPKI_PREFIX.length + 32
    && der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    return der.subarray(ED25519_SPKI_PREFIX.length);
  }
  return der;
}

function fingerprintPublicKey(publicKeyPem: string): string {
  return crypto.createHash('sha256').update(readPublicKeyBytes(publicKeyPem)).digest('hex');
}

function isRecord(value: unknown): value is ParsedJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<ParsedJson | null> {
  try {
    if (!(await fileExists(filePath))) return null;
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseIdentity(parsed: ParsedJson | null): DeviceIdentity | null {
  if (
    !parsed
    || parsed.version !== 1
    || typeof parsed.deviceId !== 'string'
    || typeof parsed.publicKeyPem !== 'string'
    || typeof parsed.privateKeyPem !== 'string'
  ) {
    return null;
  }

  try {
    const publicKey = crypto.createPublicKey(parsed.publicKeyPem);
    const privateKey = crypto.createPrivateKey(parsed.privateKeyPem);
    const derivedPublicKey = crypto.createPublicKey(privateKey);
    const publicBytes = readPublicKeyBytes(parsed.publicKeyPem);
    const derivedPrivatePublicBytes = readPublicKeyBytes(
      derivedPublicKey.export({ type: 'spki', format: 'pem' }).toString(),
    );
    if (!publicBytes.equals(derivedPrivatePublicBytes)) return null;
    // Calling createPublicKey above also rejects malformed PEM before any migration occurs.
    void publicKey;
    return {
      deviceId: fingerprintPublicKey(parsed.publicKeyPem),
      publicKeyPem: parsed.publicKeyPem,
      privateKeyPem: parsed.privateKeyPem,
    };
  } catch {
    return null;
  }
}

async function readIdentity(filePath: string): Promise<DeviceIdentity | null> {
  return parseIdentity(await readJson(filePath));
}

async function writeIdentity(filePath: string, identity: DeviceIdentity): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ version: 1, ...identity, createdAtMs: Date.now() }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
}

async function hardenFilePermissions(filePath: string): Promise<void> {
  try {
    await chmod(filePath, 0o600);
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.trim();
  return cleaned || undefined;
}

function cleanUserId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return cleanString(value);
}

function parseActivation(
  parsed: ParsedJson | null,
  deviceId: string,
): UclawDeviceActivationState | null {
  if (
    !parsed
    || parsed.version !== 1
    || parsed.deviceId !== deviceId
    || parsed.activated !== true
    || parsed.onboardingCompleted !== true
    || typeof parsed.activatedAt !== 'string'
    || typeof parsed.lastSeenAt !== 'string'
    || (parsed.source !== 'auth-token' && parsed.source !== 'login' && parsed.source !== 'register')
  ) {
    return null;
  }

  return {
    version: 1,
    deviceId,
    activated: true,
    onboardingCompleted: true,
    activatedAt: parsed.activatedAt,
    lastSeenAt: parsed.lastSeenAt,
    source: parsed.source,
    ...(cleanUserId(parsed.userId) ? { userId: cleanUserId(parsed.userId) } : {}),
    ...(cleanString(parsed.username) ? { username: cleanString(parsed.username) } : {}),
    ...(cleanString(parsed.email) ? { email: cleanString(parsed.email) } : {}),
  };
}

async function readActivationAt(
  identityPath: string,
  deviceId: string,
): Promise<UclawDeviceActivationState | null> {
  const activationPath = join(dirname(identityPath),
    identityPath.endsWith(LEGACY_DEVICE_IDENTITY_FILE)
      ? LEGACY_DEVICE_ACTIVATION_FILE
      : UCLAW_DEVICE_ACTIVATION_FILE);
  return parseActivation(await readJson(activationPath), deviceId);
}

async function writeActivationAt(
  identityPath: string,
  state: UclawDeviceActivationState,
  beforeWrite?: ActivationWriteObserver,
): Promise<void> {
  const activationPath = join(dirname(identityPath), UCLAW_DEVICE_ACTIVATION_FILE);
  await mkdir(dirname(activationPath), { recursive: true });
  const bytes = Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
  beforeWrite?.({ path: activationPath, bytes });
  await writeFile(activationPath, bytes, { mode: 0o600 });
  try {
    await chmod(activationPath, 0o600);
  } catch {
    // Best effort on filesystems that do not expose POSIX modes.
  }
}

async function mirrorToStablePath(
  identity: DeviceIdentity,
  sourceIdentityPath: string,
  activation: UclawDeviceActivationState | null,
  beforeActivationWrite?: ActivationWriteObserver,
): Promise<void> {
  const stablePath = getStableUclawDeviceIdentityPath();
  if (normalizePath(stablePath) === normalizePath(sourceIdentityPath)) return;
  const stableIdentity = await readIdentity(stablePath);
  if (stableIdentity && stableIdentity.deviceId !== identity.deviceId) return;
  if (!stableIdentity) {
    await writeIdentity(stablePath, identity);
  } else {
    await hardenFilePermissions(stablePath);
  }
  if (activation) {
    const stableActivation = await readActivationAt(stablePath, identity.deviceId);
    if (!stableActivation) {
      await writeActivationAt(stablePath, activation, beforeActivationWrite);
    } else {
      await hardenFilePermissions(join(dirname(stablePath), UCLAW_DEVICE_ACTIVATION_FILE));
    }
  }
}

type DeviceIdentityCandidate = {
  path: string;
  identity: DeviceIdentity;
  activation: UclawDeviceActivationState | null;
};

async function loadOrCreateUclawDeviceIdentityInternal(): Promise<DeviceIdentity> {
  const currentPath = getUclawDeviceIdentityPath();
  const current = await readIdentity(currentPath);
  const currentActivation = current
    ? await readActivationAt(currentPath, current.deviceId)
    : null;
  if (current && currentActivation) {
    await hardenFilePermissions(currentPath);
    try {
      await mirrorToStablePath(current, currentPath, currentActivation);
    } catch {
      // A backup location must never make the primary identity unavailable.
    }
    return current;
  }

  const candidates: DeviceIdentityCandidate[] = [];
  for (const candidatePath of getUclawDeviceIdentityCandidatePaths()) {
    const candidate = await readIdentity(candidatePath);
    if (!candidate) continue;
    const activation = await readActivationAt(candidatePath, candidate.deviceId);
    candidates.push({ path: candidatePath, identity: candidate, activation });
  }

  // An activated identity is authoritative even when a newer app data folder
  // contains an unactivated identity created during Gateway startup.
  const activatedCandidate = candidates.find((candidate) => candidate.activation !== null);
  if (activatedCandidate) {
    await writeIdentity(currentPath, activatedCandidate.identity);
    await writeActivationAt(currentPath, activatedCandidate.activation!);
    try {
      await mirrorToStablePath(
        activatedCandidate.identity,
        activatedCandidate.path,
        activatedCandidate.activation,
      );
    } catch {
      // A backup location must never make the primary identity unavailable.
    }
    return activatedCandidate.identity;
  }

  if (current) {
    await hardenFilePermissions(currentPath);
    try {
      await mirrorToStablePath(current, currentPath, null);
    } catch {
      // A backup location must never make the primary identity unavailable.
    }
    return current;
  }

  const legacyCandidate = candidates[0];
  if (legacyCandidate) {
    await writeIdentity(currentPath, legacyCandidate.identity);
    try {
      await mirrorToStablePath(legacyCandidate.identity, legacyCandidate.path, null);
    } catch {
      // A backup location must never make the primary identity unavailable.
    }
    return legacyCandidate.identity;
  }

  const generated = await loadOrCreateDeviceIdentity(currentPath);
  try {
    await mirrorToStablePath(generated, currentPath, null);
  } catch {
    // A backup location must never make the primary identity unavailable.
  }
  return generated;
}

let deviceIdentityInFlight: Promise<DeviceIdentity> | null = null;

export async function loadOrCreateUclawDeviceIdentity(): Promise<DeviceIdentity> {
  if (!deviceIdentityInFlight) {
    deviceIdentityInFlight = loadOrCreateUclawDeviceIdentityInternal();
  }
  try {
    return await deviceIdentityInFlight;
  } finally {
    deviceIdentityInFlight = null;
  }
}

export async function getUclawDevicePayload(): Promise<UclawDevicePayload> {
  const identity = await loadOrCreateUclawDeviceIdentity();
  return {
    id: identity.deviceId,
    name: process.env.COMPUTERNAME || process.env.HOSTNAME || 'UClaw Desktop',
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
  };
}

export async function readUclawDeviceActivationState(): Promise<UclawDeviceActivationState | null> {
  // Status reads must not create, migrate, mirror, or chmod device files.
  const identity = await readIdentity(getUclawDeviceIdentityPath());
  if (!identity) return null;
  return readActivationAt(getUclawDeviceIdentityPath(), identity.deviceId);
}

async function markDeviceActivated(
  source: UclawDeviceActivationState['source'],
  user?: { id?: unknown; username?: unknown; email?: unknown } | null,
  options: {
    strictStableMirror: boolean;
    beforeActivationWrite?: ActivationWriteObserver;
  } = { strictStableMirror: false },
): Promise<UclawDeviceActivationState> {
  const identity = await loadOrCreateUclawDeviceIdentity();
  const currentPath = getUclawDeviceIdentityPath();
  const existing = await readActivationAt(currentPath, identity.deviceId);
  const now = new Date().toISOString();
  const userId = cleanUserId(user?.id);
  const username = cleanString(user?.username);
  const email = cleanString(user?.email);
  const state: UclawDeviceActivationState = {
    version: 1,
    deviceId: identity.deviceId,
    activated: true,
    onboardingCompleted: true,
    activatedAt: existing?.activatedAt ?? now,
    lastSeenAt: now,
    source,
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
  };
  await writeActivationAt(currentPath, state, options.beforeActivationWrite);
  if (options.strictStableMirror) {
    await mirrorToStablePath(identity, currentPath, state, options.beforeActivationWrite);
  } else {
    try {
      await mirrorToStablePath(identity, currentPath, state);
    } catch {
      // A backup location must never make the primary identity unavailable.
    }
  }
  return state;
}

/** Preserve the historical best-effort stable mirror for ordinary device flows. */
export async function markUclawDeviceActivated(
  source: UclawDeviceActivationState['source'],
  user?: { id?: unknown; username?: unknown; email?: unknown } | null,
): Promise<UclawDeviceActivationState> {
  return markDeviceActivated(source, user);
}

/**
 * Managed authentication treats both activation files as one transaction.
 * Each intended file generation is recorded before its write starts.
 */
export async function markManagedDeviceActivated(
  source: UclawDeviceActivationState['source'],
  user: { id?: unknown; username?: unknown; email?: unknown } | null | undefined,
  applied: ManagedDeviceActivationFilesApplied = {},
): Promise<UclawDeviceActivationState> {
  const currentPath = normalizePath(getUclawDeviceActivationPath());
  const stablePath = normalizePath(getStableUclawDeviceActivationPath());
  return markDeviceActivated(source, user, {
    strictStableMirror: true,
    beforeActivationWrite: (fileSnapshot) => {
      const targetPath = normalizePath(fileSnapshot.path);
      if (targetPath === currentPath) applied.current = fileSnapshot;
      else if (targetPath === stablePath) applied.stable = fileSnapshot;
    },
  });
}

/** Managed-auth names used by the Main-process service boundary. */
export type ManagedDevicePayload = UclawDevicePayload;
export type ManagedDeviceActivationState = UclawDeviceActivationState;
export const getManagedDeviceIdentityPath = getUclawDeviceIdentityPath;
export const getManagedDeviceActivationPath = getUclawDeviceActivationPath;
export const getStableManagedDeviceIdentityPath = getStableUclawDeviceIdentityPath;
export const getManagedDeviceIdentityCandidatePaths = getUclawDeviceIdentityCandidatePaths;
export const loadOrCreateManagedDeviceIdentity = loadOrCreateUclawDeviceIdentity;
export const getManagedDevicePayload = getUclawDevicePayload;
export const readManagedDeviceActivationState = readUclawDeviceActivationState;
