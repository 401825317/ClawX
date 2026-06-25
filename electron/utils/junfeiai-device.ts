import { app } from 'electron';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, normalize, resolve } from 'path';
import { homedir } from 'node:os';
import {
  loadOrCreateDeviceIdentity,
  readDeviceIdentity,
  writeDeviceIdentity,
  type DeviceIdentity,
} from './device-identity';
import { logger } from './logger';

export type JunFeiAIDevicePayload = {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
};

export type JunFeiAIDeviceActivationState = {
  version: 1;
  deviceId: string;
  activated: boolean;
  onboardingCompleted: boolean;
  activatedAt: string;
  lastSeenAt: string;
  source: 'auth-token' | 'login' | 'register';
  userId?: string;
  username?: string;
  email?: string;
};

export const JUNFEIAI_DEVICE_IDENTITY_FILE = 'clawx-device-identity.json';
export const JUNFEIAI_DEVICE_ACTIVATION_FILE = 'clawx-device-activation.json';
const JUNFEIAI_DEVICE_IDENTITY_BACKUP_DIR = 'UClaw';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizePath(path: string): string {
  return normalize(resolve(path));
}

function uniquePaths(paths: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    if (!path) continue;
    const normalized = normalizePath(path);
    const key = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

export function getJunFeiAIDeviceIdentityPath(): string {
  return join(app.getPath('userData'), JUNFEIAI_DEVICE_IDENTITY_FILE);
}

export function getJunFeiAIDeviceActivationPath(): string {
  return join(app.getPath('userData'), JUNFEIAI_DEVICE_ACTIVATION_FILE);
}

function getStableJunFeiAIIdentityDir(): string {
  if (process.platform === 'win32') {
    const appDataDir = app.getPath('appData') || process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
    return join(appDataDir, JUNFEIAI_DEVICE_IDENTITY_BACKUP_DIR);
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', JUNFEIAI_DEVICE_IDENTITY_BACKUP_DIR);
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), JUNFEIAI_DEVICE_IDENTITY_BACKUP_DIR);
}

export function getStableJunFeiAIDeviceIdentityPath(): string {
  return join(getStableJunFeiAIIdentityDir(), JUNFEIAI_DEVICE_IDENTITY_FILE);
}

export function getJunFeiAIDeviceIdentityCandidatePaths(): string[] {
  const appDataDir = process.platform === 'win32'
    ? (app.getPath('appData') || process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'))
    : '';
  return uniquePaths([
    getStableJunFeiAIDeviceIdentityPath(),
    appDataDir ? join(appDataDir, 'clawx', JUNFEIAI_DEVICE_IDENTITY_FILE) : null,
    appDataDir ? join(appDataDir, 'ClawX', JUNFEIAI_DEVICE_IDENTITY_FILE) : null,
  ]);
}

async function readActivationStateAt(path: string, deviceId: string): Promise<JunFeiAIDeviceActivationState | null> {
  const activationPath = join(dirname(path), JUNFEIAI_DEVICE_ACTIVATION_FILE);
  if (!(await fileExists(activationPath))) {
    return null;
  }

  try {
    const raw = await readFile(activationPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      parsed?.version === 1 &&
      parsed.deviceId === deviceId &&
      parsed.activated === true &&
      parsed.onboardingCompleted === true &&
      typeof parsed.activatedAt === 'string' &&
      typeof parsed.lastSeenAt === 'string' &&
      (parsed.source === 'auth-token' || parsed.source === 'login' || parsed.source === 'register')
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function findActivatedIdentityCandidate(currentPath: string): Promise<{ path: string; identity: DeviceIdentity } | null> {
  for (const candidatePath of getJunFeiAIDeviceIdentityCandidatePaths()) {
    if (normalizePath(candidatePath) === normalizePath(currentPath)) {
      continue;
    }
    const identity = await readDeviceIdentity(candidatePath);
    if (!identity) {
      continue;
    }
    if (await readActivationStateAt(candidatePath, identity.deviceId)) {
      return { path: candidatePath, identity };
    }
  }
  return null;
}

async function findLegacyIdentityCandidate(currentPath: string): Promise<{ path: string; identity: DeviceIdentity } | null> {
  for (const candidatePath of getJunFeiAIDeviceIdentityCandidatePaths()) {
    if (normalizePath(candidatePath) === normalizePath(currentPath)) {
      continue;
    }
    const identity = await readDeviceIdentity(candidatePath);
    if (identity) {
      return { path: candidatePath, identity };
    }
  }
  return null;
}

async function copyActivationStateIfCompatible(sourceIdentityPath: string, targetIdentityPath: string, identity: DeviceIdentity): Promise<void> {
  const sourceActivationPath = join(dirname(sourceIdentityPath), JUNFEIAI_DEVICE_ACTIVATION_FILE);
  const targetActivationPath = join(dirname(targetIdentityPath), JUNFEIAI_DEVICE_ACTIVATION_FILE);
  if (normalizePath(sourceActivationPath) === normalizePath(targetActivationPath)) {
    return;
  }
  if (await readActivationStateAt(targetIdentityPath, identity.deviceId)) {
    return;
  }
  if (!(await readActivationStateAt(sourceIdentityPath, identity.deviceId))) {
    return;
  }
  await mkdir(dirname(targetActivationPath), { recursive: true });
  await copyFile(sourceActivationPath, targetActivationPath);
}

async function mirrorIdentityToStablePath(identity: DeviceIdentity, sourcePath: string): Promise<void> {
  const stablePath = getStableJunFeiAIDeviceIdentityPath();
  if (normalizePath(stablePath) === normalizePath(sourcePath)) {
    return;
  }
  const stableIdentity = await readDeviceIdentity(stablePath);
  if (stableIdentity?.deviceId === identity.deviceId) {
    return;
  }
  await writeDeviceIdentity(stablePath, identity);
  await copyActivationStateIfCompatible(sourcePath, stablePath, identity).catch((error) => {
    logger.warn('[junfeiai] Failed to mirror device activation state:', error);
  });
}

export async function loadOrCreateJunFeiAIDeviceIdentity(): Promise<DeviceIdentity> {
  const currentPath = getJunFeiAIDeviceIdentityPath();
  const currentIdentity = await readDeviceIdentity(currentPath);
  const currentActivation = currentIdentity
    ? await readActivationStateAt(currentPath, currentIdentity.deviceId)
    : null;
  if (currentIdentity && currentActivation) {
    await mirrorIdentityToStablePath(currentIdentity, currentPath).catch((error) => {
      logger.warn('[junfeiai] Failed to back up device identity:', error);
    });
    return currentIdentity;
  }

  const migrated = await findActivatedIdentityCandidate(currentPath);
  if (migrated) {
    await writeDeviceIdentity(currentPath, migrated.identity);
    await copyActivationStateIfCompatible(migrated.path, currentPath, migrated.identity).catch((error) => {
      logger.warn('[junfeiai] Failed to copy migrated device activation state:', error);
    });
    await mirrorIdentityToStablePath(migrated.identity, migrated.path).catch((error) => {
      logger.warn('[junfeiai] Failed to back up migrated device identity:', error);
    });
    logger.info(`[junfeiai] Restored activated device identity from ${migrated.path}`);
    return migrated.identity;
  }

  const legacy = !currentIdentity ? await findLegacyIdentityCandidate(currentPath) : null;
  if (legacy) {
    await writeDeviceIdentity(currentPath, legacy.identity);
    await copyActivationStateIfCompatible(legacy.path, currentPath, legacy.identity).catch((error) => {
      logger.warn('[junfeiai] Failed to copy legacy device activation state:', error);
    });
    logger.info(`[junfeiai] Restored device identity from ${legacy.path}`);
    return legacy.identity;
  }

  const identity = currentIdentity ?? await loadOrCreateDeviceIdentity(currentPath);
  return identity;
}

export async function getJunFeiAIDevicePayload(): Promise<JunFeiAIDevicePayload> {
  const identity = await loadOrCreateJunFeiAIDeviceIdentity();
  return {
    id: identity.deviceId,
    name: process.env.COMPUTERNAME || process.env.HOSTNAME || 'UClaw Desktop',
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
  };
}

export async function readJunFeiAIDeviceActivationState(): Promise<JunFeiAIDeviceActivationState | null> {
  const activationPath = getJunFeiAIDeviceActivationPath();
  if (!(await fileExists(activationPath))) {
    return null;
  }

  try {
    const raw = await readFile(activationPath, 'utf8');
    const parsed = JSON.parse(raw);
    const device = await getJunFeiAIDevicePayload();
    if (
      parsed?.version === 1
      && parsed.deviceId === device.id
      && parsed.activated === true
      && parsed.onboardingCompleted === true
      && typeof parsed.activatedAt === 'string'
      && typeof parsed.lastSeenAt === 'string'
      && (parsed.source === 'auth-token' || parsed.source === 'login' || parsed.source === 'register')
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export async function markJunFeiAIDeviceActivated(
  source: 'auth-token' | 'login' | 'register',
  user?: { id?: unknown; username?: unknown; email?: unknown } | null,
): Promise<JunFeiAIDeviceActivationState> {
  const device = await getJunFeiAIDevicePayload();
  const existing = await readJunFeiAIDeviceActivationState();
  const now = new Date().toISOString();
  const userId = typeof user?.id === 'number' || typeof user?.id === 'string'
    ? String(user.id)
    : undefined;
  const username = typeof user?.username === 'string' && user.username.trim()
    ? user.username.trim()
    : undefined;
  const email = typeof user?.email === 'string' && user.email.trim()
    ? user.email.trim()
    : undefined;
  const state: JunFeiAIDeviceActivationState = {
    version: 1,
    deviceId: device.id,
    activated: true,
    onboardingCompleted: true,
    activatedAt: existing?.activatedAt ?? now,
    lastSeenAt: now,
    source,
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
    ...(email ? { email } : {}),
  };
  const activationPath = getJunFeiAIDeviceActivationPath();
  await mkdir(dirname(activationPath), { recursive: true });
  await writeFile(activationPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  const identity = await readDeviceIdentity(getJunFeiAIDeviceIdentityPath());
  if (identity) {
    await mirrorIdentityToStablePath(identity, getJunFeiAIDeviceIdentityPath()).catch((error) => {
      logger.warn('[junfeiai] Failed to back up activated device identity:', error);
    });
  }
  return state;
}
