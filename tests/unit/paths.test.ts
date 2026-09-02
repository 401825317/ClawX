// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE_CWD } from '@shared/workspace';
import {
  collapseOpenClawWorkspacePath,
  resolveOpenClawWorkspacePath,
} from '@electron/utils/paths';

const PORTABLE_ID = 'portable-1234';
const portableEnv = {
  CLAWX_PORTABLE: '1',
  CLAWX_PORTABLE_ID: PORTABLE_ID,
} as NodeJS.ProcessEnv;

describe('collapseOpenClawWorkspacePath portable recovery', () => {
  it('collapses the current physical default workspace', () => {
    expect(collapseOpenClawWorkspacePath(
      '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state/workspace/project',
      '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state',
      portableEnv,
    )).toBe(`${DEFAULT_WORKSPACE_CWD}/project`);
  });

  it('recovers a Windows legacy USB workspace after its drive letter changes', () => {
    expect(collapseOpenClawWorkspacePath(
      'E:\\UClaw\\UClawData\\openclaw-home\\.openclaw\\workspace\\projects\\demo',
      'F:\\UClawRuntime\\profiles\\portable-1234\\openclaw-state',
      portableEnv,
    )).toBe(`${DEFAULT_WORKSPACE_CWD}/projects/demo`);
  });

  it('recovers a Windows local runtime workspace copied from another computer', () => {
    expect(collapseOpenClawWorkspacePath(
      'C:\\Users\\old-user\\AppData\\Local\\UClawRuntime\\profiles\\portable-1234\\openclaw-state\\workspace',
      'C:\\Users\\new-user\\AppData\\Local\\UClawRuntime\\profiles\\portable-1234\\openclaw-state',
      portableEnv,
    )).toBe(DEFAULT_WORKSPACE_CWD);
  });

  it('recovers macOS legacy and local runtime workspaces after a volume or computer change', () => {
    expect(collapseOpenClawWorkspacePath(
      '/Volumes/UClaw-old/UClawData/openclaw-home/.openclaw/workspace',
      '/Users/new-user/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state',
      portableEnv,
    )).toBe(DEFAULT_WORKSPACE_CWD);
    expect(collapseOpenClawWorkspacePath(
      '/Users/old-user/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state/workspace/design',
      '/Users/new-user/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state',
      portableEnv,
    )).toBe(`${DEFAULT_WORKSPACE_CWD}/design`);
  });

  it('does not rewrite another portable identity or an arbitrary user workspace', () => {
    const otherPortableWorkspace = '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-other/openclaw-state/workspace';
    const customWorkspace = '/Volumes/UClaw-old/projects/customer-a';

    expect(collapseOpenClawWorkspacePath(otherPortableWorkspace, '/current/state', portableEnv))
      .toBe(otherPortableWorkspace);
    expect(collapseOpenClawWorkspacePath(customWorkspace, '/current/state', portableEnv))
      .toBe(customWorkspace);
  });

  it('does not apply portable aliases outside portable mode', () => {
    const legacyWorkspace = '/tmp/UClawData/openclaw-home/.openclaw/workspace';
    expect(collapseOpenClawWorkspacePath(legacyWorkspace, '/current/state', {}))
      .toBe(legacyWorkspace);
  });
});

describe('resolveOpenClawWorkspacePath portable routing', () => {
  it('routes the logical default workspace and managed secondary aliases to local state', () => {
    const env = {
      CLAWX_PORTABLE: '1',
      CLAWX_PORTABLE_RUNTIME_STATE: 'local',
      OPENCLAW_HOME: '/Volumes/UClaw/UClawData/openclaw-home',
      OPENCLAW_STATE_DIR: '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state',
    } as NodeJS.ProcessEnv;

    expect(resolveOpenClawWorkspacePath(DEFAULT_WORKSPACE_CWD, env)).toBe(
      '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state/workspace',
    );
    expect(resolveOpenClawWorkspacePath('~/.openclaw/workspace-research', env)).toBe(
      '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state/workspace-research',
    );
  });

  it('keeps an external custom workspace on its configured OpenClaw home', () => {
    const env = {
      CLAWX_PORTABLE: '1',
      CLAWX_PORTABLE_RUNTIME_STATE: 'local',
      OPENCLAW_HOME: '/Volumes/UClaw/UClawData/openclaw-home',
      OPENCLAW_STATE_DIR: '/Users/alex/Library/Caches/UClawRuntime/profiles/portable-1234/openclaw-state',
    } as NodeJS.ProcessEnv;

    expect(resolveOpenClawWorkspacePath('/Volumes/projects/customer-a', env))
      .toBe('/Volumes/projects/customer-a');
    expect(resolveOpenClawWorkspacePath('~/Projects/customer-a', env))
      .toBe('/Volumes/UClaw/UClawData/openclaw-home/Projects/customer-a');
  });

  it('honors OPENCLAW_WORKSPACE_DIR when callers use the environment fallback', () => {
    const env = {
      OPENCLAW_WORKSPACE_DIR: '/Volumes/projects/customer-a',
      OPENCLAW_STATE_DIR: '/tmp/openclaw-state',
    } as NodeJS.ProcessEnv;

    expect(resolveOpenClawWorkspacePath(env.OPENCLAW_WORKSPACE_DIR!, env))
      .toBe('/Volumes/projects/customer-a');
  });
});
