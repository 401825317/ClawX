// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CWD } from '@shared/workspace';
import { migratePortableDefaultWorkspaceConfig } from '@electron/utils/portable-workspace-migration';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const portableEnv = {
  CLAWX_PORTABLE: '1',
  CLAWX_PORTABLE_ID: 'portable-1234',
} as NodeJS.ProcessEnv;

describe('portable default workspace config migration', () => {
  it('removes legacy managed workspace fields, keeps custom paths, and creates a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-workspace-migration-'));
    tempDirs.push(root);
    const configPath = join(root, 'openclaw.json');
    const stateDir = join(root, 'runtime-state');
    const legacyWorkspace = 'E:\\UClaw\\UClawData\\openclaw-home\\.openclaw\\workspace';
    const customWorkspace = 'E:\\customer-projects\\demo';
    const originalContent = `${JSON.stringify({
      agents: {
        defaults: { workspace: legacyWorkspace },
        list: [
          { id: 'main', default: true, workspace: legacyWorkspace },
          { id: 'research', workspace: 'E:\\UClaw\\UClawData\\openclaw-home\\.openclaw\\workspace-research' },
          { id: 'custom', workspace: customWorkspace },
        ],
      },
    }, null, 2)}\n`;
    await writeFile(configPath, originalContent, 'utf8');

    const result = await migratePortableDefaultWorkspaceConfig({
      portable: true,
      env: portableEnv,
      configPath,
      stateDir,
    });

    expect(result.changed).toBe(true);
    expect(result.migratedFields).toBe(3);
    expect(result.backupPath).toBeTruthy();
    const migrated = JSON.parse(await readFile(configPath, 'utf8')) as {
      agents: { defaults: Record<string, unknown>; list: Array<Record<string, unknown>> };
    };
    expect(migrated.agents.defaults.workspace).toBeUndefined();
    expect(migrated.agents.list[0].workspace).toBeUndefined();
    expect(migrated.agents.list[1].workspace).toBeUndefined();
    expect(migrated.agents.list[2].workspace).toBe(customWorkspace);
    await expect(readFile(result.backupPath!, 'utf8')).resolves.toBe(originalContent);
  });

  it('removes the current isolated default workspace and is idempotent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-workspace-migration-'));
    tempDirs.push(root);
    const configPath = join(root, 'openclaw.json');
    const stateDir = join(root, 'runtime-state');
    const physicalWorkspace = join(stateDir, 'workspace');
    await writeFile(configPath, JSON.stringify({ agents: { defaults: { workspace: physicalWorkspace } } }), 'utf8');

    const first = await migratePortableDefaultWorkspaceConfig({
      portable: true,
      env: portableEnv,
      configPath,
      stateDir,
    });
    const second = await migratePortableDefaultWorkspaceConfig({
      portable: true,
      env: portableEnv,
      configPath,
      stateDir,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(JSON.parse(await readFile(configPath, 'utf8')).agents.defaults.workspace).toBeUndefined();
    expect((await readdir(root)).filter((name) => name.endsWith('.bak'))).toHaveLength(1);
  });

  it('removes managed secondary-agent aliases but preserves custom descendants and unknown paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-workspace-migration-'));
    tempDirs.push(root);
    const configPath = join(root, 'openclaw.json');
    const stateDir = join(root, 'runtime-state');
    const customChild = `${DEFAULT_WORKSPACE_CWD}/projects/demo`;
    const unknownAbsolute = join(root, 'customer-workspace');
    await writeFile(configPath, JSON.stringify({
      agents: {
        defaults: { workspace: customChild },
        list: [
          { id: 'main', default: true, workspace: customChild },
          { id: 'research', workspace: '~/.openclaw/workspace-research' },
          { id: 'designer', workspace: join(stateDir, 'workspace-designer') },
          { id: 'external', workspace: unknownAbsolute },
          { id: 'nested', workspace: `${DEFAULT_WORKSPACE_CWD}/workspace-nested/docs` },
        ],
      },
    }, null, 2), 'utf8');

    const result = await migratePortableDefaultWorkspaceConfig({
      portable: true,
      env: portableEnv,
      configPath,
      stateDir,
    });

    expect(result.changed).toBe(true);
    expect(result.migratedFields).toBe(5);
    const migrated = JSON.parse(await readFile(configPath, 'utf8')) as {
      agents: { defaults: Record<string, unknown>; list: Array<Record<string, unknown>> };
    };
    expect(migrated.agents.defaults.workspace).toBe(join(stateDir, 'workspace', 'projects', 'demo'));
    expect(migrated.agents.list[0].workspace).toBe(join(stateDir, 'workspace', 'projects', 'demo'));
    expect(migrated.agents.list[1].workspace).toBeUndefined();
    expect(migrated.agents.list[2].workspace).toBeUndefined();
    expect(migrated.agents.list[3].workspace).toBe(unknownAbsolute);
    expect(migrated.agents.list[4].workspace).toBe(join(stateDir, 'workspace', 'workspace-nested', 'docs'));
  });

  it('does nothing outside portable mode or for malformed config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uclaw-workspace-migration-'));
    tempDirs.push(root);
    const configPath = join(root, 'openclaw.json');
    const legacyWorkspace = '/Volumes/UClaw/UClawData/openclaw-home/.openclaw/workspace';
    await writeFile(configPath, `{"agents":{"defaults":{"workspace":"${legacyWorkspace}"}}}`, 'utf8');

    await expect(migratePortableDefaultWorkspaceConfig({
      env: {},
      configPath,
      stateDir: join(root, 'state'),
    })).resolves.toMatchObject({ changed: false, migratedFields: 0 });
    await expect(readFile(configPath, 'utf8')).resolves.toContain(legacyWorkspace);

    await writeFile(configPath, '{not-json', 'utf8');
    await expect(migratePortableDefaultWorkspaceConfig({
      portable: true,
      env: portableEnv,
      configPath,
      stateDir: join(root, 'state'),
    })).resolves.toMatchObject({ changed: false, migratedFields: 0 });
    await expect(readFile(configPath, 'utf8')).resolves.toBe('{not-json');
  });
});
