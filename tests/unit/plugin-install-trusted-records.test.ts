import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  state,
  mockUpsertPluginInstallRecordsIntoSqlite,
} = vi.hoisted(() => ({
  state: { stateDir: '' },
  mockUpsertPluginInstallRecordsIntoSqlite: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => process.cwd(),
  },
}));

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@electron/utils/paths', () => ({
  resolveOpenClawConfigPath: () => join(state.stateDir, 'openclaw.json'),
  resolveOpenClawStateDir: () => state.stateDir,
}));

vi.mock('@electron/utils/plugin-install-index', () => ({
  upsertPluginInstallRecordsIntoSqlite: mockUpsertPluginInstallRecordsIntoSqlite,
}));

function seedPlugin(pluginDirName: string, packageName: string, version: string): string {
  const targetDir = join(state.stateDir, 'extensions', pluginDirName);
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(
    join(targetDir, 'openclaw.plugin.json'),
    JSON.stringify({ id: pluginDirName, entry: 'index.js' }),
    'utf-8',
  );
  writeFileSync(
    join(targetDir, 'package.json'),
    JSON.stringify({ name: packageName, version, main: 'index.js' }),
    'utf-8',
  );
  writeFileSync(join(targetDir, 'index.js'), 'export default {};\n', 'utf-8');
  writeFileSync(
    join(targetDir, '.uclaw-managed-plugin.json'),
    JSON.stringify({
      schemaVersion: 1,
      managedBy: 'uclaw',
      pluginId: pluginDirName,
      contentFingerprint: '0'.repeat(64),
      installedAt: '2026-08-19T00:00:00.000Z',
    }),
    'utf-8',
  );
  return targetDir;
}

describe('trusted plugin install record persistence', () => {
  beforeEach(() => {
    state.stateDir = mkdtempSync(join(tmpdir(), 'uclaw-plugin-records-'));
    mockUpsertPluginInstallRecordsIntoSqlite.mockClear();
    writeFileSync(
      join(state.stateDir, 'openclaw.json'),
      JSON.stringify({ plugins: { enabled: true, allow: ['whatsapp'] }, untouched: { keep: true } }),
      'utf-8',
    );
  });

  afterEach(() => {
    rmSync(state.stateDir, { recursive: true, force: true });
  });

  it('repairs all discovered records in one atomic config transaction and one SQLite batch', async () => {
    const whatsappDir = seedPlugin('whatsapp', '@openclaw/whatsapp', '2026.6.10');
    const discordDir = seedPlugin('discord', '@openclaw/discord', '2026.6.10');
    const { repairTrustedOfficialPluginInstallRecords } = await import('@electron/utils/plugin-install');

    await repairTrustedOfficialPluginInstallRecords();

    const config = JSON.parse(readFileSync(join(state.stateDir, 'openclaw.json'), 'utf-8'));
    expect(config.untouched).toEqual({ keep: true });
    expect(config.plugins.installs.whatsapp.installPath).toBe(await realpath(whatsappDir));
    expect(config.plugins.installs.discord.installPath).toBe(await realpath(discordDir));
    expect(config.plugins.installs.whatsapp.integrity).toMatch(/^sha256-/u);
    expect(mockUpsertPluginInstallRecordsIntoSqlite).toHaveBeenCalledTimes(1);
    expect(mockUpsertPluginInstallRecordsIntoSqlite).toHaveBeenCalledWith(expect.objectContaining({
      whatsapp: expect.objectContaining({ resolvedName: '@openclaw/whatsapp' }),
      discord: expect.objectContaining({ resolvedName: '@openclaw/discord' }),
    }));
    expect(readdirSync(state.stateDir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('serializes concurrent record updates so neither read-modify-write is lost', async () => {
    const whatsappDir = seedPlugin('whatsapp', '@openclaw/whatsapp', '2026.6.10');
    const discordDir = seedPlugin('discord', '@openclaw/discord', '2026.6.10');
    const { syncTrustedOfficialPluginInstallRecord } = await import('@electron/utils/plugin-install');

    await Promise.all([
      syncTrustedOfficialPluginInstallRecord('whatsapp', whatsappDir),
      syncTrustedOfficialPluginInstallRecord('discord', discordDir),
    ]);

    const config = JSON.parse(readFileSync(join(state.stateDir, 'openclaw.json'), 'utf-8'));
    expect(Object.keys(config.plugins.installs).sort()).toEqual(['discord', 'whatsapp']);
    expect(readdirSync(state.stateDir).filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('does not manufacture a trusted install record for an unmarked user plugin', async () => {
    const whatsappDir = seedPlugin('whatsapp', '@openclaw/whatsapp', '2026.6.10');
    rmSync(join(whatsappDir, '.uclaw-managed-plugin.json'));
    writeFileSync(join(whatsappDir, 'index.js'), 'export default { owner: "user" };\n', 'utf-8');
    const { repairTrustedOfficialPluginInstallRecords } = await import('@electron/utils/plugin-install');

    await repairTrustedOfficialPluginInstallRecords();

    const config = JSON.parse(readFileSync(join(state.stateDir, 'openclaw.json'), 'utf-8'));
    expect(config.plugins.installs).toBeUndefined();
    expect(mockUpsertPluginInstallRecordsIntoSqlite).not.toHaveBeenCalled();
  });
});
