import { app } from 'electron';
import { join } from 'path';
import { loadOrCreateDeviceIdentity } from './device-identity';

export type JunFeiAIDevicePayload = {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  appVersion: string;
};

export async function getJunFeiAIDevicePayload(): Promise<JunFeiAIDevicePayload> {
  const identityPath = join(app.getPath('userData'), 'clawx-device-identity.json');
  const identity = await loadOrCreateDeviceIdentity(identityPath);
  return {
    id: identity.deviceId,
    name: process.env.COMPUTERNAME || process.env.HOSTNAME || 'ClawX Desktop',
    platform: process.platform,
    arch: process.arch,
    appVersion: app.getVersion(),
  };
}
