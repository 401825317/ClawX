import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import crypto from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({
  userData: '',
  appData: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return electronState.userData;
      if (name === 'appData') return electronState.appData;
      return electronState.userData;
    }),
    getVersion: vi.fn(() => '0.4.8-test'),
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function deriveDeviceId(publicKeyPem: string): string {
  const spki = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }) as Buffer;
  const raw = spki.length === ED25519_SPKI_PREFIX.length + 32
    && spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ? spki.subarray(ED25519_SPKI_PREFIX.length)
    : spki;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

async function makeIdentityFile(dir: string): Promise<string> {
  const { publicKey, privateKey } = await new Promise<crypto.KeyPairKeyObjectResult>((resolve, reject) => {
    crypto.generateKeyPair('ed25519', (err, publicKey, privateKey) => {
      if (err) reject(err);
      else resolve({ publicKey, privateKey });
    });
  });
  const publicKeyPem = (publicKey.export({ type: 'spki', format: 'pem' }) as Buffer).toString();
  const privateKeyPem = (privateKey.export({ type: 'pkcs8', format: 'pem' }) as Buffer).toString();
  const deviceId = deriveDeviceId(publicKeyPem);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'clawx-device-identity.json'), `${JSON.stringify({
    version: 1,
    deviceId,
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  }, null, 2)}\n`, 'utf8');
  return deviceId;
}

async function writeActivationFile(dir: string, deviceId: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'clawx-device-activation.json'), `${JSON.stringify({
    version: 1,
    deviceId,
    activated: true,
    onboardingCompleted: true,
    activatedAt: '2026-06-22T17:20:10.911Z',
    lastSeenAt: '2026-06-22T17:20:10.911Z',
    source: 'login',
    userId: '21',
    username: 'steven0',
  }, null, 2)}\n`, 'utf8');
}

async function readStoredDeviceId(dir: string): Promise<string> {
  const raw = await readFile(join(dir, 'clawx-device-identity.json'), 'utf8');
  const parsed = JSON.parse(raw);
  return parsed.deviceId;
}

describe('JunFeiAI device identity migration', () => {
  let root: string;

  beforeEach(async () => {
    vi.resetModules();
    root = join(tmpdir(), `uclaw-junfeiai-device-${Math.random().toString(36).slice(2)}`);
    await rm(root, { recursive: true, force: true });
    electronState.userData = join(root, 'new-version', 'UClawData', 'clawx');
    electronState.appData = join(root, 'AppData', 'Roaming');
  });

  it('restores an activated legacy ClawX identity even if the new version already generated a different identity', async () => {
    const currentDeviceId = await makeIdentityFile(electronState.userData);
    const legacyDir = join(electronState.appData, 'clawx');
    const legacyDeviceId = await makeIdentityFile(legacyDir);
    await writeActivationFile(legacyDir, legacyDeviceId);

    const { getJunFeiAIDevicePayload, getStableJunFeiAIDeviceIdentityPath } = await import('@electron/utils/junfeiai-device');

    const payload = await getJunFeiAIDevicePayload();

    expect(currentDeviceId).not.toBe(legacyDeviceId);
    expect(payload.id).toBe(legacyDeviceId);
    expect(await readStoredDeviceId(electronState.userData)).toBe(legacyDeviceId);
    expect(await readStoredDeviceId(join(electronState.appData, 'UClaw'))).toBe(legacyDeviceId);
    expect(getStableJunFeiAIDeviceIdentityPath()).toBe(join(electronState.appData, 'UClaw', 'clawx-device-identity.json'));
  });

  it('restores a legacy identity without a local activation cache when the new data directory is empty', async () => {
    const legacyDir = join(electronState.appData, 'clawx');
    const legacyDeviceId = await makeIdentityFile(legacyDir);
    const { getJunFeiAIDevicePayload } = await import('@electron/utils/junfeiai-device');

    const payload = await getJunFeiAIDevicePayload();

    expect(payload.id).toBe(legacyDeviceId);
    expect(await readStoredDeviceId(electronState.userData)).toBe(legacyDeviceId);
  });

  it('keeps an existing activated identity and mirrors it to the stable backup path', async () => {
    const deviceId = await makeIdentityFile(electronState.userData);
    await writeActivationFile(electronState.userData, deviceId);
    const { getJunFeiAIDevicePayload } = await import('@electron/utils/junfeiai-device');

    const payload = await getJunFeiAIDevicePayload();

    expect(payload.id).toBe(deviceId);
    expect(await readStoredDeviceId(join(electronState.appData, 'UClaw'))).toBe(deviceId);
  });

  it('does not mirror a newly generated unactivated identity into the stable backup path', async () => {
    const { getJunFeiAIDevicePayload } = await import('@electron/utils/junfeiai-device');

    const payload = await getJunFeiAIDevicePayload();

    expect(payload.id).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(join(electronState.appData, 'UClaw', 'clawx-device-identity.json'), 'utf8')).rejects.toThrow();
  });

  it('mirrors the identity after successful activation', async () => {
    const { getJunFeiAIDevicePayload, markJunFeiAIDeviceActivated } = await import('@electron/utils/junfeiai-device');
    const payload = await getJunFeiAIDevicePayload();

    await markJunFeiAIDeviceActivated('login', { id: '21', username: 'steven0' });

    expect(await readStoredDeviceId(join(electronState.appData, 'UClaw'))).toBe(payload.id);
  });
});
