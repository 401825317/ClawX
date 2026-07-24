// @vitest-environment node

import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { root, userData, appData } = vi.hoisted(() => {
  const root = `/tmp/uclaw-device-${Math.random().toString(36).slice(2)}`;
  return {
    root,
    userData: `${root}/user-data`,
    appData: `${root}/app-data`,
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => name === 'appData' ? appData : userData,
    getVersion: () => '1.2.3-test',
  },
}));

import { loadOrCreateDeviceIdentity } from '@electron/utils/device-identity';
import {
  getStableUclawDeviceIdentityPath,
  getUclawDeviceActivationPath,
  getUclawDeviceIdentityPath,
  loadOrCreateUclawDeviceIdentity,
  markManagedDeviceActivated,
  markUclawDeviceActivated,
  readUclawDeviceActivationState,
  restoreManagedDeviceActivationFiles,
  snapshotManagedDeviceActivationFiles,
} from '@electron/utils/junfeiai-device';

const legacyIdentityPath = join(userData, 'clawx-device-identity.json');
const legacyActivationPath = join(userData, 'clawx-device-activation.json');
const stableActivationPath = join(appData, 'UClaw', 'uclaw-device-activation.json');

async function mode(filePath: string): Promise<number> {
  return (await stat(filePath)).mode & 0o777;
}

describe('UClaw managed device identity', () => {
  beforeEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads activation status without creating or migrating device files', async () => {
    await expect(readUclawDeviceActivationState()).resolves.toBeNull();
    await expect(readFile(getUclawDeviceIdentityPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(getStableUclawDeviceIdentityPath(), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots both activation files byte-for-byte without creating or hardening files', async () => {
    const currentBytes = Buffer.from([0x00, 0xff, 0x7b, 0x0a]);
    const stableBytes = Buffer.from([0xfe, 0x01, 0x7d, 0x0a]);
    await mkdir(userData, { recursive: true });
    await mkdir(join(appData, 'UClaw'), { recursive: true });
    await writeFile(getUclawDeviceActivationPath(), currentBytes);
    await writeFile(stableActivationPath, stableBytes);
    await chmod(getUclawDeviceActivationPath(), 0o644);
    await chmod(stableActivationPath, 0o640);

    const snapshot = await snapshotManagedDeviceActivationFiles();

    expect(snapshot.current.path).toBe(getUclawDeviceActivationPath());
    expect(snapshot.current.bytes).toEqual(currentBytes);
    expect(snapshot.stable.path).toBe(stableActivationPath);
    expect(snapshot.stable.bytes).toEqual(stableBytes);
    expect(await mode(getUclawDeviceActivationPath())).toBe(0o644);
    expect(await mode(stableActivationPath)).toBe(0o640);
    await expect(readFile(getUclawDeviceIdentityPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(getStableUclawDeviceIdentityPath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records missing activation files without creating their parent directories', async () => {
    const snapshot = await snapshotManagedDeviceActivationFiles();

    expect(snapshot.current.bytes).toBeNull();
    expect(snapshot.stable.bytes).toBeNull();
    await expect(stat(userData)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(join(appData, 'UClaw'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores existing activation files byte-for-byte with private permissions', async () => {
    const currentBytes = Buffer.from([0x00, 0xff, 0x01]);
    const stableBytes = Buffer.from([0xfe, 0x02, 0x00]);
    await mkdir(userData, { recursive: true });
    await mkdir(join(appData, 'UClaw'), { recursive: true });
    await writeFile(getUclawDeviceActivationPath(), currentBytes);
    await writeFile(stableActivationPath, stableBytes);
    const snapshot = await snapshotManagedDeviceActivationFiles();
    await writeFile(getUclawDeviceActivationPath(), 'changed');
    await rm(stableActivationPath);
    await chmod(getUclawDeviceActivationPath(), 0o666);

    await restoreManagedDeviceActivationFiles(snapshot);

    expect(await readFile(getUclawDeviceActivationPath())).toEqual(currentBytes);
    expect(await readFile(stableActivationPath)).toEqual(stableBytes);
    expect(await mode(getUclawDeviceActivationPath())).toBe(0o600);
    expect(await mode(stableActivationPath)).toBe(0o600);
  });

  it('removes activation files created after a missing snapshot and ignores ENOENT', async () => {
    const snapshot = await snapshotManagedDeviceActivationFiles();
    await mkdir(userData, { recursive: true });
    await mkdir(join(appData, 'UClaw'), { recursive: true });
    await writeFile(getUclawDeviceActivationPath(), 'new-current');
    await writeFile(stableActivationPath, 'new-stable');

    await restoreManagedDeviceActivationFiles(snapshot);
    await expect(readFile(getUclawDeviceActivationPath())).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(stableActivationPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(restoreManagedDeviceActivationFiles(snapshot)).resolves.toBeUndefined();
  });

  it('restores the stable file when current restoration fails and aggregates the error', async () => {
    const stableBytes = Buffer.from([0xfe, 0x03, 0x00]);
    await mkdir(join(appData, 'UClaw'), { recursive: true });
    await writeFile(stableActivationPath, stableBytes);
    const snapshot = await snapshotManagedDeviceActivationFiles();
    await mkdir(snapshot.current.path, { recursive: true });
    await writeFile(stableActivationPath, 'changed-stable');

    const failure = await restoreManagedDeviceActivationFiles(snapshot).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) }),
    ]);
    expect(await readFile(stableActivationPath)).toEqual(stableBytes);
    expect(await mode(stableActivationPath)).toBe(0o600);
  });

  it('keeps one identity across loads and protects every persisted copy', async () => {
    const [first, second] = await Promise.all([
      loadOrCreateUclawDeviceIdentity(),
      loadOrCreateUclawDeviceIdentity(),
    ]);

    expect(second).toEqual(first);
    expect(first.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(await mode(getUclawDeviceIdentityPath())).toBe(0o600);
    expect(await mode(getStableUclawDeviceIdentityPath())).toBe(0o600);
  });

  it('restores an activated stable identity before an unactivated legacy identity', async () => {
    const stablePath = getStableUclawDeviceIdentityPath();
    const stableIdentity = await loadOrCreateDeviceIdentity(stablePath);
    await writeFile(join(appData, 'UClaw', 'uclaw-device-activation.json'), JSON.stringify({
      version: 1,
      deviceId: stableIdentity.deviceId,
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-02T00:00:00.000Z',
      source: 'login',
    }), { mode: 0o600 });
    await loadOrCreateDeviceIdentity(legacyIdentityPath);

    const restored = await loadOrCreateUclawDeviceIdentity();

    expect(restored.deviceId).toBe(stableIdentity.deviceId);
    expect((await readUclawDeviceActivationState())?.deviceId).toBe(stableIdentity.deviceId);
  });

  it('binds activation to the current device and persists only sanitized user fields', async () => {
    const state = await markUclawDeviceActivated('login', {
      id: '  42  ',
      username: '  test-user  ',
      email: '  user@example.com  ',
      password: 'must-not-be-stored',
      accessToken: 'must-not-be-stored',
      activationTicket: 'must-not-be-stored',
    } as { id: unknown; username: unknown; email: unknown });

    expect(state.userId).toBe('42');
    expect(state.username).toBe('test-user');
    expect(state.email).toBe('user@example.com');
    expect(await readUclawDeviceActivationState()).toEqual(state);
    expect(await mode(getUclawDeviceActivationPath())).toBe(0o600);

    const persisted = JSON.parse(await readFile(getUclawDeviceActivationPath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(persisted).sort()).toEqual([
      'activated',
      'activatedAt',
      'deviceId',
      'email',
      'lastSeenAt',
      'onboardingCompleted',
      'source',
      'userId',
      'username',
      'version',
    ]);
    expect(JSON.stringify(persisted)).not.toContain('must-not-be-stored');
  });

  it('makes the managed stable mirror strict and records each write intent before I/O', async () => {
    await loadOrCreateUclawDeviceIdentity();
    await mkdir(stableActivationPath);
    const applied: Parameters<typeof markManagedDeviceActivated>[2] = {};

    await expect(markManagedDeviceActivated('login', { id: 'user-1' }, applied))
      .rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|EPERM)$/) });

    expect(applied.current?.path).toBe(getUclawDeviceActivationPath());
    expect(applied.stable?.path).toBe(stableActivationPath);
    expect(applied.current?.bytes).toEqual(await readFile(getUclawDeviceActivationPath()));
    expect(applied.stable?.bytes).not.toBeNull();

    // The legacy public flow keeps the stable backup best-effort.
    await expect(markUclawDeviceActivated('login', { id: 'user-1' })).resolves.toBeDefined();
  });

  it('rejects an activation record that belongs to another device', async () => {
    await loadOrCreateUclawDeviceIdentity();
    await writeFile(getUclawDeviceActivationPath(), JSON.stringify({
      version: 1,
      deviceId: 'different-device',
      activated: true,
      onboardingCompleted: true,
      activatedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      source: 'login',
    }), { mode: 0o600 });

    expect(await readUclawDeviceActivationState()).toBeNull();
  });

  it('migrates valid legacy state without changing the legacy files', async () => {
    const legacyIdentity = await loadOrCreateDeviceIdentity(legacyIdentityPath);
    await writeFile(legacyActivationPath, JSON.stringify({
      version: 1,
      deviceId: legacyIdentity.deviceId,
      activated: true,
      onboardingCompleted: true,
      activatedAt: '2026-07-01T00:00:00.000Z',
      lastSeenAt: '2026-07-02T00:00:00.000Z',
      source: 'register',
      userId: '  7  ',
      username: '  legacy-user  ',
      refreshToken: 'must-not-be-migrated',
    }), { mode: 0o600 });
    const originalIdentityFile = await readFile(legacyIdentityPath, 'utf8');
    const originalActivationFile = await readFile(legacyActivationPath, 'utf8');

    const migrated = await loadOrCreateUclawDeviceIdentity();
    const activation = await readUclawDeviceActivationState();

    expect(migrated).toEqual(legacyIdentity);
    expect(activation?.deviceId).toBe(legacyIdentity.deviceId);
    expect(activation?.userId).toBe('7');
    expect(activation?.username).toBe('legacy-user');
    expect(JSON.stringify(activation)).not.toContain('must-not-be-migrated');
    expect(await readFile(legacyIdentityPath, 'utf8')).toBe(originalIdentityFile);
    expect(await readFile(legacyActivationPath, 'utf8')).toBe(originalActivationFile);
    expect(await mode(getUclawDeviceIdentityPath())).toBe(0o600);
    expect(await mode(getUclawDeviceActivationPath())).toBe(0o600);
  });

  it('does not trust a legacy deviceId that differs from its public-key fingerprint', async () => {
    const legacyIdentity = await loadOrCreateDeviceIdentity(legacyIdentityPath);
    const legacyJson = JSON.parse(await readFile(legacyIdentityPath, 'utf8')) as Record<string, unknown>;
    legacyJson.deviceId = 'tampered-device-id';
    await writeFile(legacyIdentityPath, JSON.stringify(legacyJson, null, 2), { mode: 0o600 });

    const migrated = await loadOrCreateUclawDeviceIdentity();

    expect(migrated.deviceId).toBe(legacyIdentity.deviceId);
    expect(migrated.deviceId).not.toBe('tampered-device-id');
  });

  it('leaves malformed legacy data untouched when creating a fresh identity', async () => {
    await mkdir(userData, { recursive: true });
    const malformed = '{not-valid-json';
    await writeFile(legacyIdentityPath, malformed, { mode: 0o600 });

    const identity = await loadOrCreateUclawDeviceIdentity();

    expect(identity.deviceId).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(legacyIdentityPath, 'utf8')).toBe(malformed);
  });
});
