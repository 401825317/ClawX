import { app } from 'electron';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'path';
import { loadOrCreateDeviceIdentity } from './device-identity';

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
  source: 'auth-token' | 'register';
};

export const JUNFEIAI_DEVICE_IDENTITY_FILE = 'clawx-device-identity.json';
export const JUNFEIAI_DEVICE_ACTIVATION_FILE = 'clawx-device-activation.json';

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function getJunFeiAIDeviceIdentityPath(): string {
  return join(app.getPath('userData'), JUNFEIAI_DEVICE_IDENTITY_FILE);
}

export function getJunFeiAIDeviceActivationPath(): string {
  return join(app.getPath('userData'), JUNFEIAI_DEVICE_ACTIVATION_FILE);
}

export async function getJunFeiAIDevicePayload(): Promise<JunFeiAIDevicePayload> {
  const identity = await loadOrCreateDeviceIdentity(getJunFeiAIDeviceIdentityPath());
  return {
    id: identity.deviceId,
    name: process.env.COMPUTERNAME || process.env.HOSTNAME || 'ClawX Desktop',
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
      && (parsed.source === 'auth-token' || parsed.source === 'register')
    ) {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

export async function markJunFeiAIDeviceActivated(source: 'auth-token' | 'register'): Promise<JunFeiAIDeviceActivationState> {
  const device = await getJunFeiAIDevicePayload();
  const existing = await readJunFeiAIDeviceActivationState();
  const now = new Date().toISOString();
  const state: JunFeiAIDeviceActivationState = {
    version: 1,
    deviceId: device.id,
    activated: true,
    onboardingCompleted: true,
    activatedAt: existing?.activatedAt ?? now,
    lastSeenAt: now,
    source,
  };
  const activationPath = getJunFeiAIDeviceActivationPath();
  await mkdir(dirname(activationPath), { recursive: true });
  await writeFile(activationPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return state;
}
