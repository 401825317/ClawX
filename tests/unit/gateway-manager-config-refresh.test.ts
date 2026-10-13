// @vitest-environment node

import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayManager } from '@electron/gateway/manager';
import { writeAuthProfilesToSqlite } from '@electron/utils/openclaw-auth-sqlite';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  prepare: vi.fn(), launch: vi.fn(), startup: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false } }));
vi.mock('@electron/utils/logger', () => ({ logger: mocks.logger }));
vi.mock('@electron/utils/telemetry', () => ({ trackMetric: vi.fn(), captureTelemetryEvent: vi.fn() }));
vi.mock('@electron/utils/device-identity', () => ({ loadOrCreateDeviceIdentity: async () => ({ deviceId: 'test' }) }));
vi.mock('@electron/services/providers/store-instance', () => ({
  getClawXProviderStore: async () => ({ get: () => undefined, has: () => false }),
}));
vi.mock('@electron/gateway/reload-policy', () => ({
  DEFAULT_GATEWAY_RELOAD_POLICY: { mode: 'hybrid', debounceMs: 20 },
  loadGatewayReloadPolicy: async () => ({ mode: 'hybrid', debounceMs: 20 }),
}));
vi.mock('@electron/gateway/config-sync', () => ({ prepareGatewayLaunchContext: mocks.prepare }));
vi.mock('@electron/gateway/process-launcher', () => ({ launchGatewayProcess: mocks.launch }));
vi.mock('@electron/gateway/startup-orchestrator', () => ({ runGatewayStartupSequence: mocks.startup }));
vi.mock('@electron/gateway/supervisor', () => ({
  unloadLaunchctlGatewayService: vi.fn(), waitForPortFree: vi.fn(), warmupManagedPythonReadiness: vi.fn(),
  findExistingGatewayProcess: vi.fn(), terminateOwnedGatewayProcess: vi.fn(), runOpenClawDoctorRepair: vi.fn(),
}));
vi.mock('@electron/gateway/openclaw-downgrade', () => ({
  prepareManagedOpenClawDowngrade: async () => null,
  commitManagedOpenClawDowngrade: vi.fn(), rollbackOpenClawDowngrade: vi.fn(),
  isOpenClawDowngradeBlockedError: () => false, isOpenClawCommandTerminationUnconfirmedError: () => false,
}));

type Internals = {
  stateController: { setStatus: (update: Record<string, unknown>) => void };
  startLock: boolean;
  process: Electron.UtilityProcess | null;
  appliedRuntimeConfigFingerprint: string | null;
  pendingConfigReload: { fingerprint?: string; reasons: Set<string> } | null;
  flushPendingConfigReload: () => void;
  clearAllTimers: () => void;
};

const originalPlatform = process.platform;
let root: string;
let manager: GatewayManager;
let internals: Internals;
let repositoryArtifactNames: string[];

async function config(value: unknown): Promise<void> {
  await writeFile(join(root, 'openclaw.json'), JSON.stringify(value));
}

describe('Gateway config refresh generations', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    repositoryArtifactNames = (await readdir(process.cwd())).filter((name) => name.includes('clawx-config-refresh-'));
    root = await mkdtemp(join(tmpdir(), 'clawx-config-refresh-'));
    vi.stubEnv('OPENCLAW_STATE_DIR', root);
    vi.stubEnv('OPENCLAW_CONFIG_PATH', join(root, 'openclaw.json'));
    vi.stubEnv('CLAWX_MANAGED_PROVIDER', '0');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-12T00:00:00Z'));
    const { GatewayManager } = await import('@electron/gateway/manager');
    manager = new GatewayManager();
    internals = manager as unknown as Internals;
    internals.process = { pid: 1234 } as Electron.UtilityProcess;
    internals.stateController.setStatus({ state: 'running', connectedAt: Date.now() - 10_000 });
    mocks.prepare.mockResolvedValue({});
    mocks.launch.mockResolvedValue({ child: { pid: 2345 }, lastSpawnSummary: 'test' });
    await config({ agents: { list: [{ id: 'main', model: 'openai/old' }] } });
  });

  afterEach(async () => {
    internals.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
    // Windows-policy mocks must never redirect real host SQLite writes into the repository.
    expect((await readdir(process.cwd())).filter((name) => name.includes('clawx-config-refresh-')))
      .toEqual(repositoryArtifactNames);
  });

  it('ignores JSON ordering/formatting and writer metadata, not real model changes', async () => {
    const before = await manager.captureRuntimeConfigFingerprint();
    await config({ meta: { lastTouchedAt: Date.now() }, agents: { list: [{ model: 'openai/old', id: 'main' }] } });
    expect(await manager.captureRuntimeConfigFingerprint()).toBe(before);
    await config({ agents: { list: [{ id: 'main', model: 'openai/new' }] } });
    expect(await manager.captureRuntimeConfigFingerprint()).not.toBe(before);
  });

  it('includes per-agent model catalogs and custom agentDir, not empty provisioning directories', async () => {
    const before = await manager.captureRuntimeConfigFingerprint();
    await mkdir(join(root, 'agents', 'empty', 'agent'), { recursive: true });
    expect(await manager.captureRuntimeConfigFingerprint()).toBe(before);
    await writeFile(join(root, 'agents', 'empty', 'agent', 'models.json'), '{"providers":{"openai":{"api":"openai-responses"}}}');
    expect(await manager.captureRuntimeConfigFingerprint()).not.toBe(before);
    const customDir = join(root, 'custom-agent');
    await mkdir(customDir);
    await config({ agents: { list: [{ id: 'main', agentDir: customDir }] } });
    const customBefore = await manager.captureRuntimeConfigFingerprint();
    await writeFile(join(customDir, 'models.json'), '{"providers":{"custom":{"baseUrl":"https://example.test"}}}');
    expect(await manager.captureRuntimeConfigFingerprint()).not.toBe(customBefore);
  });

  it('fails conservatively on invalid JSON without logging config content', async () => {
    await writeFile(join(root, 'openclaw.json'), '{secret-invalid');
    expect(await manager.captureRuntimeConfigFingerprint()).toBeNull();
    expect(mocks.logger.warn).toHaveBeenCalledWith('[gateway-refresh] result=fingerprint_unavailable');
  });

  it('compares effective credentials/order, not SQLite timestamps, cooldowns or a JSON-to-SQLite migration', async () => {
    // Exercise real SQLite with the host's path semantics; other tests mock Windows policy only.
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    const agentDir = join(root, 'agents', 'main', 'agent');
    await mkdir(agentDir, { recursive: true });
    const store = { version: 1, profiles: { 'openai:default': { provider: 'openai', type: 'api_key', key: 'test-not-a-real-key' } } };
    await writeFile(join(agentDir, 'auth-profiles.json'), JSON.stringify(store));
    const before = await manager.captureRuntimeConfigFingerprint();
    writeAuthProfilesToSqlite(store, 'main');
    expect(await manager.captureRuntimeConfigFingerprint()).toBe(before);
    await vi.advanceTimersByTimeAsync(1000);
    writeAuthProfilesToSqlite({ ...store, usageStats: { 'openai:default': { cooldownUntil: Date.now() + 50_000 } } }, 'main');
    expect(await manager.captureRuntimeConfigFingerprint()).toBe(before);
    writeAuthProfilesToSqlite({ ...store, order: { openai: ['openai:default'] } }, 'main');
    const changedOrder = await manager.captureRuntimeConfigFingerprint();
    expect(changedOrder).not.toBe(before);
    writeAuthProfilesToSqlite({ ...store, profiles: { 'openai:default': { ...store.profiles['openai:default'], key: 'changed-test-key' } } }, 'main');
    expect(await manager.captureRuntimeConfigFingerprint()).not.toBe(before);
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain('test-not-a-real-key');
  });

  it('tracks custom agentDir JSON and SQLite credentials while ignoring cooldown writes', async () => {
    const customDir = join(root, 'custom-auth');
    await mkdir(customDir);
    await config({ agents: { list: [{ id: 'custom', agentDir: customDir }] } });
    const store = { profiles: { 'openai:default': { provider: 'openai', type: 'api_key', key: 'custom-test-key' } } };
    await writeFile(join(customDir, 'auth-profiles.json'), JSON.stringify(store));
    const before = await manager.captureRuntimeConfigFingerprint();
    await writeFile(join(customDir, 'auth-profiles.json'), JSON.stringify({ profiles: { 'openai:default': { ...store.profiles['openai:default'], key: 'json-changed' } } }));
    expect(await manager.captureRuntimeConfigFingerprint()).not.toBe(before);
    const db = new DatabaseSync(join(customDir, 'openclaw-agent.sqlite'));
    try {
      db.exec('CREATE TABLE auth_profile_store (store_key TEXT PRIMARY KEY, store_json TEXT, updated_at INTEGER)');
      db.prepare('INSERT INTO auth_profile_store VALUES (?, ?, ?)').run('primary', JSON.stringify(store), 1);
      expect(await manager.captureRuntimeConfigFingerprint()).toBe(before);
      db.prepare('UPDATE auth_profile_store SET updated_at = ?, store_json = ?').run(2, JSON.stringify({ ...store, usageStats: { cooldownUntil: 1000 } }));
      expect(await manager.captureRuntimeConfigFingerprint()).toBe(before);
      db.prepare('UPDATE auth_profile_store SET store_json = ?').run(JSON.stringify({ profiles: { 'openai:default': { ...store.profiles['openai:default'], key: 'sqlite-changed' } } }));
      expect(await manager.captureRuntimeConfigFingerprint()).not.toBe(before);
    } finally {
      db.close();
    }
  });

  it('retains external Gateway changes without pretending reconnect applied them', async () => {
    internals.process = null;
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'update-agent-model', 'external-new');
    await vi.advanceTimersByTimeAsync(20);
    expect(restart).not.toHaveBeenCalled();
    expect(internals.pendingConfigReload?.fingerprint).toBe('external-new');
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('pending=retained'));
    await expect(manager.reload()).rejects.toThrow('requires control');
    internals.process = { pid: 1234 } as Electron.UtilityProcess;
    internals.appliedRuntimeConfigFingerprint = 'external-new';
    internals.flushPendingConfigReload();
    expect(internals.pendingConfigReload).toBeNull();
    expect(restart).not.toHaveBeenCalled();
  });

  it('retains a failed refresh for the next mutation without an automatic retry loop', async () => {
    const reload = vi.spyOn(manager, 'reload').mockRejectedValueOnce(new Error('refresh failed')).mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'first');
    await vi.advanceTimersByTimeAsync(100);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(internals.pendingConfigReload?.fingerprint).toBe('first');
    manager.debouncedReload(20, 'update-agent-model', 'second');
    await vi.advanceTimersByTimeAsync(20);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenLastCalledWith(undefined, 'create-agent,update-agent-model', 'second');
  });

  it('does not restart for an already applied config generation', async () => {
    const fingerprint = (await manager.captureRuntimeConfigFingerprint())!;
    internals.appliedRuntimeConfigFingerprint = fingerprint;
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', fingerprint);
    await vi.advanceTimersByTimeAsync(20);
    expect(restart).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('reason=create-agent'));
  });

  it('coalesces duplicate and different writes into one necessary Windows restart with all reasons', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'first');
    manager.debouncedReload(20, 'update-agent-model', 'second');
    manager.debouncedReload(20, 'assign-channel', 'second');
    await vi.advanceTimersByTimeAsync(20);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      'cause=windows reason=create-agent,update-agent-model,assign-channel',
    ));
  });

  it('does not delay a scheduled refresh when the same generation is requested again', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'same');
    await vi.advanceTimersByTimeAsync(15);
    manager.debouncedReload(20, 'update-agent', 'same');
    await vi.advanceTimersByTimeAsync(5);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('merges changes after the launch snapshot and applies once after startup settles', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    internals.startLock = true;
    internals.stateController.setStatus({ state: 'starting' });
    internals.appliedRuntimeConfigFingerprint = 'launch-old';
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'new');
    manager.debouncedReload(20, 'update-agent-model', 'newer');
    await vi.advanceTimersByTimeAsync(20);
    expect(restart).not.toHaveBeenCalled();
    internals.stateController.setStatus({ state: 'running', connectedAt: Date.now() - 10_000 });
    expect(restart).not.toHaveBeenCalled();
    internals.startLock = false;
    internals.flushPendingConfigReload();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('consumes changes included by a real pre-fork snapshot without restarting after start', async () => {
    internals.process = null;
    internals.stateController.setStatus({ state: 'stopped' });
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    mocks.prepare.mockImplementation(async () => {
      await config({ agents: { list: [{ id: 'main', model: 'openai/new' }] } });
      manager.debouncedReload(20, 'update-agent-model', (await manager.captureRuntimeConfigFingerprint())!);
      await vi.advanceTimersByTimeAsync(20);
      return {};
    });
    mocks.startup.mockImplementation(async (hooks: { startProcess: () => Promise<void> }) => {
      await hooks.startProcess();
      internals.stateController.setStatus({ state: 'running', connectedAt: Date.now(), gatewayReady: true });
    });
    await manager.start();
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(restart).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('unchanged_or_included_by_start'));
  });

  it('preserves a real config write after fork and refreshes exactly once when startup settles', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    internals.process = null;
    internals.stateController.setStatus({ state: 'stopped' });
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    mocks.launch.mockImplementationOnce(async () => {
      await config({ agents: { list: [{ id: 'main', model: 'openai/after-fork' }] } });
      manager.debouncedReload(20, 'update-agent-model', (await manager.captureRuntimeConfigFingerprint())!);
      await vi.advanceTimersByTimeAsync(20);
      return { child: { pid: 2345 }, lastSpawnSummary: 'test' };
    });
    mocks.startup.mockImplementation(async (hooks: { startProcess: () => Promise<void> }) => {
      await hooks.startProcess();
      internals.stateController.setStatus({ state: 'running', connectedAt: Date.now(), gatewayReady: true });
    });
    await manager.start();
    expect(restart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('cause=windows reason=update-agent-model'));
  });

  it('waits through recent-connect guard without losing the newest generation or reason', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    internals.stateController.setStatus({ connectedAt: Date.now() });
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'new');
    await vi.advanceTimersByTimeAsync(7_000);
    expect(restart).not.toHaveBeenCalled();
    manager.debouncedReload(20, 'update-agent-model', 'newer');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('reason=create-agent,update-agent-model'));
  });

  it('merges writes included by an in-flight Windows restart instead of scheduling a second restart', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let finish!: () => void;
    const restart = vi.spyOn(manager, 'restart').mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    manager.debouncedReload(20, 'create-agent', 'first');
    await vi.advanceTimersByTimeAsync(20);
    manager.debouncedReload(20, 'update-agent-model', 'second');
    await vi.advanceTimersByTimeAsync(20);
    internals.appliedRuntimeConfigFingerprint = 'second';
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it('does not swallow a later generation that was not included by an in-flight restart', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let finish!: () => void;
    const restart = vi.spyOn(manager, 'restart')
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }))
      .mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'first');
    await vi.advanceTimersByTimeAsync(20);
    manager.debouncedReload(20, 'update-agent-model', 'second');
    await vi.advanceTimersByTimeAsync(20);
    internals.appliedRuntimeConfigFingerprint = 'first';
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('never starts a stopped Gateway just to refresh config', async () => {
    internals.stateController.setStatus({ state: 'stopped' });
    const restart = vi.spyOn(manager, 'restart').mockResolvedValue();
    manager.debouncedReload(20, 'create-agent', 'new');
    await vi.advanceTimersByTimeAsync(100);
    expect(restart).not.toHaveBeenCalled();
  });

  it('does not claim a retained PID after SIGUSR1 acknowledged the new config', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    internals.appliedRuntimeConfigFingerprint = 'older-controlled-launch';
    const signal = vi.spyOn(process, 'kill').mockReturnValue(true);
    const refresh = manager.reload(undefined, 'update-agent-model', 'unconfirmed-new');
    await vi.advanceTimersByTimeAsync(1_500);
    await refresh;
    expect(signal).toHaveBeenCalledWith(1234, 'SIGUSR1');
    expect(manager.getAppliedRuntimeConfigFingerprint()).toBeNull();
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('result=signal_sent'));
    expect(mocks.logger.info).toHaveBeenCalledWith(expect.stringContaining('result=health_retained configAck=unconfirmed'));
    expect(mocks.logger.info.mock.calls.some(([message]) => String(message).includes('applied_in_place'))).toBe(false);
    manager.debouncedReload(20, 'update-agent-model', 'older-controlled-launch');
    await vi.advanceTimersByTimeAsync(1_520);
    expect(signal).toHaveBeenCalledTimes(2);
    expect(manager.getAppliedRuntimeConfigFingerprint()).toBeNull();
  });

  it('never marks a forked generation applied when startup subsequently fails', async () => {
    internals.process = null;
    internals.stateController.setStatus({ state: 'stopped' });
    const reconnect = vi.spyOn(manager as unknown as { scheduleReconnect: () => void }, 'scheduleReconnect')
      .mockImplementation(() => undefined);
    mocks.startup.mockImplementationOnce(async (hooks: { startProcess: () => Promise<void> }) => {
      await hooks.startProcess();
      expect(manager.getAppliedRuntimeConfigFingerprint()).toBeNull();
      throw new Error('startup connection failed');
    });
    await expect(manager.start()).rejects.toThrow('startup connection failed');
    expect(reconnect).toHaveBeenCalled();
    expect(manager.getAppliedRuntimeConfigFingerprint()).toBeNull();
  });
});
