// @vitest-environment node

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pathState = vi.hoisted(() => ({ configRoot: '' }));
const runtimeState = vi.hoisted(() => ({ longTermRulesEnabled: true, epoch: 1, snapshotReads: 0 }));

vi.mock('@electron/utils/paths', () => ({
  expandOpenClawPath: (value: string) => value,
  getOpenClawConfigDir: () => pathState.configRoot,
}));

vi.mock('@electron/services/managed-client-config-service', () => ({
  getManagedClientRuntimeConfigSnapshot: () => {
    runtimeState.snapshotReads += 1;
    return {
      epoch: runtimeState.epoch,
      verifiedAt: Date.now(),
      config: {
        features: {
          longTermRules: runtimeState.longTermRulesEnabled === undefined
            ? undefined
            : { enabled: runtimeState.longTermRulesEnabled },
        },
      },
    };
  },
}));

import { LongTermRuleService } from '@electron/services/long-term-rule-service';
import {
  atomicTextFileTestApi,
  resetAtomicTextFileStateForTests,
  updateAtomicTextFile,
} from '../../electron/utils/atomic-text-file';

function errno(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('LongTermRuleService', () => {
  let root = '';
  let workspace = '';

  beforeEach(async () => {
    resetAtomicTextFileStateForTests();
    root = await mkdtemp(join(tmpdir(), 'uclaw-long-term-rules-'));
    pathState.configRoot = join(root, 'openclaw-state');
    runtimeState.longTermRulesEnabled = true;
    runtimeState.epoch = 1;
    runtimeState.snapshotReads = 0;
    workspace = join(root, 'workspace-main');
    await mkdir(workspace, { recursive: true });
    await writeFile(
      join(workspace, 'AGENTS.md'),
      '# User content\n\n<!-- UCLAW_AGENT_PROFILE_START -->\nProfile content\n<!-- UCLAW_AGENT_PROFILE_END -->\n',
      'utf8',
    );
  });

  afterEach(async () => {
    resetAtomicTextFileStateForTests();
    await rm(root, { recursive: true, force: true });
  });

  it('persists scoped rules, preserves user content, projects globally, and supports undo', async () => {
    const service = new LongTermRuleService();
    const agentContext = { agentId: 'main', workspaceRoot: workspace };
    const agentCreate = await service.create({
      ...agentContext,
      scope: 'agent',
      content: 'Always use the approved report template.',
    });
    const globalCreate = await service.create({
      ...agentContext,
      scope: 'global',
      content: 'Never expose authentication secrets.',
    });

    expect(agentCreate.undoToken).toBeTruthy();
    expect(globalCreate.rules).toHaveLength(2);
    let projected = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    expect(projected).toContain('# User content');
    expect(projected).toContain('Profile content');
    expect(projected).toContain('<!-- UCLAW_LONG_TERM_RULES_START -->');
    expect(projected).toContain('Always use the approved report template.');
    expect(projected).toContain('Never expose authentication secrets.');

    const agentRule = globalCreate.rules.find((rule) => rule.scope === 'agent');
    expect(agentRule).toBeTruthy();
    const disabled = await service.update({
      ...agentContext,
      id: agentRule!.id,
      enabled: false,
    });
    projected = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    expect(projected).not.toContain('Always use the approved report template.');
    expect(projected).toContain('Never expose authentication secrets.');

    await service.undo({ ...agentContext, undoToken: disabled.undoToken! });
    projected = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    expect(projected).toContain('Always use the approved report template.');

    const secondWorkspace = join(root, 'workspace-second');
    await mkdir(secondWorkspace, { recursive: true });
    await service.repair({ agentId: 'secondary', workspaceRoot: secondWorkspace });
    const secondProjection = await readFile(join(secondWorkspace, 'AGENTS.md'), 'utf8');
    expect(secondProjection).toContain('Never expose authentication secrets.');
    expect(secondProjection).not.toContain('Always use the approved report template.');

    const reloaded = new LongTermRuleService();
    expect(await reloaded.list()).toMatchObject({ status: 'enabled', rules: expect.any(Array) });
    expect((await reloaded.list()).rules).toHaveLength(2);
  });

  it('captures only explicit non-negated memory intent with the correct scope', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };

    expect(await service.capture({ ...context, message: 'Please answer in Chinese today.' }))
      .toMatchObject({ captured: false });
    expect(await service.capture({ ...context, message: '不要记住这条临时要求。' }))
      .toMatchObject({ captured: false });

    const agentCapture = await service.capture({
      ...context,
      message: '请记住，以后一直使用简洁标题。',
    });
    expect(agentCapture).toMatchObject({
      captured: true,
      rule: {
        scope: 'agent',
        agentId: 'main',
        content: '请记住，以后一直使用简洁标题。',
      },
    });

    const globalCapture = await service.capture({
      ...context,
      message: '全局长期规则：所有 Agent 始终遵守品牌用词。',
    });
    expect(globalCapture).toMatchObject({
      captured: true,
      rule: {
        scope: 'global',
        content: '全局长期规则：所有 Agent 始终遵守品牌用词。',
      },
    });

    await service.update({
      ...context,
      id: agentCapture.rule!.id,
      enabled: false,
    });
    const recaptured = await service.capture({
      ...context,
      message: '请记住，以后一直使用简洁标题。',
    });
    expect(recaptured).toMatchObject({
      captured: true,
      rule: { id: agentCapture.rule!.id, enabled: true, version: 3 },
      undoToken: expect.any(String),
    });
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
      .toContain('请记住，以后一直使用简洁标题。');
  });

  it('captures with snapshot-only gate checks and does not re-enter list or create gate refreshes', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const readsBefore = runtimeState.snapshotReads;

    await expect(service.capture({ ...context, message: '请记住，以后一直使用短标题。' }))
      .resolves.toMatchObject({ captured: true });

    // One request-time snapshot and one in-queue epoch check. There is no
    // capture -> create/list recursion and this mock has no network API at all.
    expect(runtimeState.snapshotReads - readsBefore).toBe(2);
  });

  it('fails a queued mutation closed when the gate epoch changes before its serial section starts', async () => {
    const service = new LongTermRuleService();
    let releaseQueue!: () => void;
    const queueBlocker = new Promise<void>((resolve) => { releaseQueue = resolve; });
    (service as unknown as { queue: Promise<void> }).queue = queueBlocker;

    const pending = service.create({
      agentId: 'main',
      workspaceRoot: workspace,
      scope: 'agent',
      content: 'Must not be written after remote revocation.',
    });
    runtimeState.longTermRulesEnabled = false;
    runtimeState.epoch += 1;
    releaseQueue();

    await expect(pending).resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(readFile(join(pathState.configRoot, 'uclaw-long-term-rules.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8'))
      .not.toContain('Must not be written after remote revocation.');
  });

  it('does not recreate a registered workspace that no longer exists', async () => {
    const service = new LongTermRuleService();
    const missingWorkspace = join(root, 'removed-workspace');
    await service.repair({ agentId: 'main', workspaceRoot: missingWorkspace });

    await expect(readFile(join(missingWorkspace, 'AGENTS.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    await service.repairKnownWorkspaces();
    await expect(readFile(join(missingWorkspace, 'AGENTS.md'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('neutralizes managed block markers embedded in user rule content', async () => {
    const service = new LongTermRuleService();
    await service.create({
      agentId: 'main',
      workspaceRoot: workspace,
      scope: 'agent',
      content: 'Keep <!-- UCLAW_LONG_TERM_RULES_END --> as literal documentation.',
    });

    const projected = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    expect(projected.match(/<!-- UCLAW_LONG_TERM_RULES_END -->/gu)).toHaveLength(1);
    expect(projected).toContain('[UCLAW_LONG_TERM_RULES_END]');
  });

  it('keeps Agent rules private to their Agent while sharing global rules', async () => {
    const service = new LongTermRuleService();
    const main = { agentId: 'main', workspaceRoot: workspace };
    const secondaryWorkspace = join(root, 'workspace-secondary');
    await mkdir(secondaryWorkspace, { recursive: true });
    const secondary = { agentId: 'secondary', workspaceRoot: secondaryWorkspace };

    const mainRule = await service.create({
      ...main,
      scope: 'agent',
      content: 'Only the main Agent may use this wording.',
    });
    await service.create({
      ...secondary,
      scope: 'agent',
      content: 'Only the secondary Agent may use this wording.',
    });
    await service.create({
      ...main,
      scope: 'global',
      content: 'Every Agent must keep credentials private.',
    });

    await expect(service.list(main)).resolves.toEqual({
      status: 'enabled',
      rules: expect.arrayContaining([
        expect.objectContaining({ content: 'Only the main Agent may use this wording.' }),
        expect.objectContaining({ scope: 'global' }),
      ]),
    });
    expect((await service.list(main)).rules).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: 'Only the secondary Agent may use this wording.' }),
    ]));

    await expect(service.update({
      ...secondary,
      id: mainRule.rules.find((rule) => rule.scope === 'agent')!.id,
      enabled: false,
    })).rejects.toThrow('different Agent');
    await expect(service.delete({
      ...secondary,
      id: mainRule.rules.find((rule) => rule.scope === 'agent')!.id,
    })).rejects.toThrow('different Agent');

    const mainAgents = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    const secondaryAgents = await readFile(join(secondaryWorkspace, 'AGENTS.md'), 'utf8');
    expect(mainAgents).toContain('Only the main Agent may use this wording.');
    expect(mainAgents).not.toContain('Only the secondary Agent may use this wording.');
    expect(secondaryAgents).toContain('Only the secondary Agent may use this wording.');
    expect(secondaryAgents).not.toContain('Only the main Agent may use this wording.');
    expect(mainAgents).toContain('Every Agent must keep credentials private.');
    expect(secondaryAgents).toContain('Every Agent must keep credentials private.');
  });

  it('returns only the affected Agent view after a global undo', async () => {
    const service = new LongTermRuleService();
    const main = { agentId: 'main', workspaceRoot: workspace };
    const secondaryWorkspace = join(root, 'workspace-secondary');
    await mkdir(secondaryWorkspace, { recursive: true });
    const secondary = { agentId: 'secondary', workspaceRoot: secondaryWorkspace };

    await service.create({ ...secondary, scope: 'agent', content: 'Secondary-only policy.' });
    const global = await service.create({ ...main, scope: 'global', content: 'Shared policy.' });
    const undone = await service.undo({ ...main, undoToken: global.undoToken! });

    expect(undone.rules).toEqual([]);
    expect(await service.list(secondary)).toEqual({
      status: 'enabled',
      rules: [expect.objectContaining({ scope: 'agent', agentId: 'secondary', content: 'Secondary-only policy.' })],
    });
  });

  it('repairs a removed managed block without changing user or Agent Profile content', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    await service.create({ ...context, scope: 'agent', content: 'Keep approved terminology.' });
    await writeFile(
      join(workspace, 'AGENTS.md'),
      '# User content\n\n<!-- UCLAW_AGENT_PROFILE_START -->\nProfile content\n<!-- UCLAW_AGENT_PROFILE_END -->\n',
      'utf8',
    );

    await service.repair(context);

    const repaired = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    expect(repaired).toContain('# User content');
    expect(repaired).toContain('Profile content');
    expect(repaired).toContain('Keep approved terminology.');
  });

  it('changes only the managed marker range and preserves surrounding bytes', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    await service.create({ ...context, scope: 'agent', content: 'Use the replacement managed rule.' });
    const prefix = '\uFEFF# User content  \r\n\r\nUser spacing stays here.   \r\n\r\n';
    const suffix = '\r\n\r\n<!-- UCLAW_AGENT_PROFILE_START -->\r\nProfile content  \r\n<!-- UCLAW_AGENT_PROFILE_END -->\r\nTail text.   \r\n';
    await writeFile(
      agentsPath,
      `${prefix}<!-- UCLAW_LONG_TERM_RULES_START -->\r\nOld managed text\r\n<!-- UCLAW_LONG_TERM_RULES_END -->${suffix}`,
      'utf8',
    );

    await service.repair(context);

    const projected = await readFile(agentsPath, 'utf8');
    const start = projected.indexOf('<!-- UCLAW_LONG_TERM_RULES_START -->');
    const end = projected.indexOf('<!-- UCLAW_LONG_TERM_RULES_END -->')
      + '<!-- UCLAW_LONG_TERM_RULES_END -->'.length;
    expect(projected.slice(0, start)).toBe(prefix);
    expect(projected.slice(end)).toBe(suffix);
    expect(projected).toContain('Use the replacement managed rule.');
    expect(projected).not.toContain('Old managed text');

    const withoutManagedBlock = '\uFEFF# User-only file\r\n\r\nTrailing spaces stay.   \r\n';
    await writeFile(agentsPath, withoutManagedBlock, 'utf8');
    await service.repair(context);
    expect((await readFile(agentsPath, 'utf8')).startsWith(withoutManagedBlock)).toBe(true);
  });

  it('re-reads and merges an external AGENTS.md edit detected before rename', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    const externalLine = 'User edit committed while UClaw was projecting.';
    await service.create({
      ...context,
      scope: 'agent',
      content: 'Keep the managed rule after a concurrent edit.',
    });
    await writeFile(
      agentsPath,
      '# User content\n\n<!-- UCLAW_AGENT_PROFILE_START -->\nProfile content\n<!-- UCLAW_AGENT_PROFILE_END -->\n',
      'utf8',
    );
    let targetReads = 0;

    atomicTextFileTestApi.setRuntimeOverrides({
      readBuffer: async (filePath) => {
        targetReads += 1;
        if (targetReads === 2) {
          const current = await readFile(filePath, 'utf8');
          await writeFile(filePath, `${current.trimEnd()}\n\n${externalLine}\n`, 'utf8');
        }
        return readFile(filePath);
      },
    });

    await service.repair(context);

    const projected = await readFile(agentsPath, 'utf8');
    expect(targetReads).toBeGreaterThanOrEqual(4);
    expect(projected).toContain('# User content');
    expect(projected).toContain('Profile content');
    expect(projected).toContain(externalLine);
    expect(projected).toContain('Keep the managed rule after a concurrent edit.');
  });

  it('fails closed when external edits exhaust the CAS retry budget', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    const privateRule = 'RULE_BODY_MUST_NOT_APPEAR_IN_ERRORS';
    await service.create({ ...context, scope: 'agent', content: privateRule });
    await writeFile(agentsPath, '# User content\n', 'utf8');
    const storePath = join(pathState.configRoot, 'uclaw-long-term-rules.json');
    const storeBefore = await readFile(storePath, 'utf8');
    let targetReads = 0;
    let externalEdits = 0;

    atomicTextFileTestApi.setRuntimeOverrides({
      readBuffer: async (filePath) => {
        targetReads += 1;
        if (targetReads % 2 === 0) {
          externalEdits += 1;
          const current = await readFile(filePath, 'utf8');
          await writeFile(
            filePath,
            `${current.trimEnd()}\n\nExternal user edit ${externalEdits}.\n`,
            'utf8',
          );
        }
        return readFile(filePath);
      },
    });

    const error = await service.repair(context).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'ATOMIC_TEXT_RETRY_EXHAUSTED' });
    expect(String(error)).not.toContain(privateRule);
    expect(String(error)).not.toContain(root);
    expect(error instanceof Error ? error.stack : '').not.toContain(privateRule);
    expect(error instanceof Error ? error.stack : '').not.toContain(root);
    expect(await readFile(storePath, 'utf8')).toBe(storeBefore);
    const projected = await readFile(agentsPath, 'utf8');
    expect(externalEdits).toBe(3);
    expect(projected).toContain('# User content');
    expect(projected).toContain('External user edit 1.');
    expect(projected).toContain('External user edit 2.');
    expect(projected).toContain('External user edit 3.');
    expect(projected).not.toContain(privateRule);
    expect(projected).not.toContain('<!-- UCLAW_LONG_TERM_RULES_START -->');
    expect(atomicTextFileTestApi.getWriteQueueCount()).toBe(0);
    expect((await readdir(workspace)).filter((name) => name.includes('.uclaw-'))).toEqual([]);
  });

  it('recovers a sibling lock left by a dead process without losing user content', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    await service.create({
      ...context,
      scope: 'agent',
      content: 'Recover safely from an abandoned projection lock.',
    });
    await writeFile(
      agentsPath,
      '# User content\n\n<!-- UCLAW_AGENT_PROFILE_START -->\nProfile content\n<!-- UCLAW_AGENT_PROFILE_END -->\n',
      'utf8',
    );
    const identity = await atomicTextFileTestApi.resolvePathIdentity(agentsPath);
    const deadPid = 2_147_000_000;
    await writeFile(identity.lockPath, `${JSON.stringify({
      version: 1,
      ownerToken: 'dead-owner-token-0000000000000000',
      pid: deadPid,
      createdAtMs: 1,
      state: 'held',
    })}\n`, 'utf8');
    atomicTextFileTestApi.setRuntimeOverrides({
      processAlive: async (pid) => pid !== deadPid,
      random: () => 0,
      sleep: async () => undefined,
    });

    await service.repair(context);

    const projected = await readFile(agentsPath, 'utf8');
    expect(projected).toContain('# User content');
    expect(projected).toContain('Profile content');
    expect(projected).toContain('Recover safely from an abandoned projection lock.');
    await expect(readFile(identity.lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses one canonical lock identity for workspace path aliases', async () => {
    const alias = join(root, 'workspace-alias');
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');

    const canonical = await atomicTextFileTestApi.resolvePathIdentity(join(workspace, 'AGENTS.md'));
    const throughAlias = await atomicTextFileTestApi.resolvePathIdentity(join(alias, 'AGENTS.md'));

    expect(throughAlias.lockKey).toBe(canonical.lockKey);
    expect(throughAlias.lockPath).toBe(canonical.lockPath);
    expect(throughAlias.pathHash).toBe(canonical.pathHash);
  });

  it('serializes in-process updates made through canonical workspace aliases', async () => {
    const alias = join(root, 'workspace-queue-alias');
    await symlink(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const agentsPath = join(workspace, 'AGENTS.md');
    const aliasPath = join(alias, 'AGENTS.md');
    await writeFile(agentsPath, 'Base content.\n', 'utf8');
    let releaseFirst!: () => void;
    let markFirstRenameStarted!: () => void;
    const firstRenameStarted = new Promise<void>((resolve) => { markFirstRenameStarted = resolve; });
    const firstRenameGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let renameCalls = 0;
    let secondTransforms = 0;
    atomicTextFileTestApi.setRuntimeOverrides({
      rename: async (source, target) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          markFirstRenameStarted();
          await firstRenameGate;
        }
        await rename(source, target);
      },
    });

    const first = updateAtomicTextFile(
      agentsPath,
      (current) => `${current}First update.\n`,
      { createParent: false },
    );
    await firstRenameStarted;
    const second = updateAtomicTextFile(
      aliasPath,
      (current) => {
        secondTransforms += 1;
        return `${current}Second update.\n`;
      },
      { createParent: false },
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondTransforms).toBe(0);
    releaseFirst();
    await Promise.all([first, second]);

    expect(await readFile(agentsPath, 'utf8')).toBe('Base content.\nFirst update.\nSecond update.\n');
    expect(renameCalls).toBe(2);
    expect(secondTransforms).toBe(1);
    expect(atomicTextFileTestApi.getWriteQueueCount()).toBe(0);
  });

  it('retries transient Windows rename failures without dropping non-managed content', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    await service.create({
      ...context,
      scope: 'agent',
      content: 'Retry only transient atomic replacement failures.',
    });
    await writeFile(
      agentsPath,
      '# User content\n\n<!-- UCLAW_AGENT_PROFILE_START -->\nProfile content\n<!-- UCLAW_AGENT_PROFILE_END -->\n',
      'utf8',
    );
    let renameAttempts = 0;
    const sleepDelays: number[] = [];

    atomicTextFileTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async (milliseconds) => { sleepDelays.push(milliseconds); },
      rename: async (source, target) => {
        renameAttempts += 1;
        if (renameAttempts === 1) throw errno('EPERM');
        if (renameAttempts === 2) throw errno('EACCES');
        if (renameAttempts === 3) throw errno('EBUSY');
        await rename(source, target);
      },
    });

    await service.repair(context);

    const projected = await readFile(agentsPath, 'utf8');
    expect(renameAttempts).toBe(4);
    expect(sleepDelays).toEqual([15, 30, 60]);
    expect(projected).toContain('# User content');
    expect(projected).toContain('Profile content');
    expect(projected).toContain('Retry only transient atomic replacement failures.');
  });

  it('sanitizes non-transient filesystem failures and cleans temporary files', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    const privateRule = 'PRIVATE_RULE_BODY_FOR_ERROR_TEST';
    await service.create({ ...context, scope: 'agent', content: privateRule });
    await writeFile(agentsPath, '# User content\n', 'utf8');
    const unlinkAttempts = { lock: 0, temporary: 0 };
    const retryCodes = ['EPERM', 'EACCES', 'EBUSY'] as const;
    atomicTextFileTestApi.setRuntimeOverrides({
      random: () => 0,
      sleep: async () => undefined,
      rename: async () => {
        const raw = errno('EIO') as NodeJS.ErrnoException & { dest?: string };
        raw.message = `raw failure ${root} ${privateRule}`;
        raw.path = agentsPath;
        raw.dest = `${agentsPath}.dest`;
        raw.cause = new Error(`${privateRule} ${root}`);
        throw raw;
      },
      unlink: async (filePath) => {
        const kind = filePath.endsWith('.tmp') ? 'temporary' : 'lock';
        unlinkAttempts[kind] += 1;
        const code = retryCodes[unlinkAttempts[kind] - 1];
        if (code) throw errno(code);
        await unlink(filePath);
      },
    });

    const error = await service.repair(context).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'ATOMIC_TEXT_OPERATION_FAILED',
      failureKind: 'fs_eio',
    });
    const exposed = error instanceof Error
      ? [error.name, error.message, error.stack, String(error), String((error as Error & { cause?: unknown }).cause)]
      : [String(error)];
    expect(exposed.join('\n')).not.toContain(privateRule);
    expect(exposed.join('\n')).not.toContain(root);
    expect(await readFile(agentsPath, 'utf8')).toBe('# User content\n');
    expect(unlinkAttempts).toEqual({ lock: 4, temporary: 4 });
    expect((await readdir(workspace)).filter((name) => name.includes('.uclaw-'))).toEqual([]);
  });

  it('never steals a sibling lock owned by a live process', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    await service.create({ ...context, scope: 'agent', content: 'Keep the live lock untouched.' });
    const agentsBefore = await readFile(agentsPath, 'utf8');
    const storePath = join(pathState.configRoot, 'uclaw-long-term-rules.json');
    const storeBefore = await readFile(storePath, 'utf8');
    const identity = await atomicTextFileTestApi.resolvePathIdentity(agentsPath);
    const livePid = 2_147_000_001;
    const lockBytes = `${JSON.stringify({
      version: 1,
      ownerToken: 'live-owner-token-0000000000000000',
      pid: livePid,
      createdAtMs: 1,
      state: 'held',
    })}\n`;
    await writeFile(identity.lockPath, lockBytes, 'utf8');
    let now = 0;
    atomicTextFileTestApi.setRuntimeOverrides({
      now: () => now,
      processAlive: async (pid) => pid === livePid,
      random: () => 0,
      sleep: async () => { now = 5_000; },
    });

    const error = await service.repair(context).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'ATOMIC_TEXT_LOCK_TIMEOUT' });
    expect(await readFile(identity.lockPath, 'utf8')).toBe(lockBytes);
    expect(await readFile(agentsPath, 'utf8')).toBe(agentsBefore);
    expect(await readFile(storePath, 'utf8')).toBe(storeBefore);
    expect(atomicTextFileTestApi.getWriteQueueCount()).toBe(0);
  });

  it('does not recreate a workspace removed between validation and lock acquisition', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    await service.create({ ...context, scope: 'agent', content: 'Do not recreate a removed workspace.' });
    let removed = false;
    atomicTextFileTestApi.setRuntimeOverrides({
      realpath: async (filePath) => {
        if (!removed) {
          removed = true;
          await rm(workspace, { recursive: true, force: true });
        }
        return realpath(filePath);
      },
    });

    const error = await service.repair(context).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'ATOMIC_TEXT_OPERATION_FAILED',
      failureKind: 'fs_enoent',
    });
    await expect(readFile(join(workspace, 'AGENTS.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed on malformed managed markers without changing user bytes', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const agentsPath = join(workspace, 'AGENTS.md');
    await service.create({ ...context, scope: 'agent', content: 'Do not rewrite malformed user content.' });
    const malformed = '# User content\n\n<!-- UCLAW_LONG_TERM_RULES_START -->\nUser-authored trailing text.\n';
    await writeFile(agentsPath, malformed, 'utf8');

    const error = await service.repair(context).then(() => null, (caught: unknown) => caught);

    expect(error).toMatchObject({
      code: 'ATOMIC_TEXT_OPERATION_FAILED',
      failureKind: 'operation_failed',
    });
    expect(await readFile(agentsPath, 'utf8')).toBe(malformed);
    expect((await readdir(workspace)).filter((name) => name.includes('.uclaw-'))).toEqual([]);
  });

  it('does not overwrite a malformed stored rule file', async () => {
    await mkdir(pathState.configRoot, { recursive: true });
    const storePath = join(pathState.configRoot, 'uclaw-long-term-rules.json');
    const privateStoreFragment = 'PRIVATE_STORE_RULE_FRAGMENT';
    const malformed = `{"rules":["${privateStoreFragment}"]`;
    await writeFile(storePath, malformed, 'utf8');

    const service = new LongTermRuleService();
    const error = await service.repair({ agentId: 'main', workspaceRoot: workspace })
      .then(() => null, (caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'LONG_TERM_RULE_STORE_READ_FAILED',
      failureKind: 'invalid_json',
    });
    const exposed = error instanceof Error
      ? [error.name, error.message, error.stack, String(error), String((error as Error & { cause?: unknown }).cause)]
      : [String(error)];
    expect(exposed.join('\n')).not.toContain(privateStoreFragment);
    expect(exposed.join('\n')).not.toContain(root);
    expect(await readFile(storePath, 'utf8')).toBe(malformed);
  });

  it('fails closed without configuration and performs no rule-store or AGENTS.md I/O', async () => {
    runtimeState.longTermRulesEnabled = undefined as unknown as boolean;
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const originalAgents = await readFile(join(workspace, 'AGENTS.md'), 'utf8');

    await expect(service.list(context)).resolves.toEqual({ status: 'disabled', rules: [] });
    await expect(service.create({ ...context, scope: 'agent', content: 'Must not persist.' }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.update({ ...context, id: 'missing-rule', enabled: false }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.delete({ ...context, id: 'missing-rule' }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.undo({ ...context, undoToken: 'missing-undo' }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.capture({ ...context, message: '请记住，以后一直不要写入。' }))
      .resolves.toMatchObject({ captured: false, disabled: true, rules: [] });
    await expect(service.repair(context)).resolves.toEqual([]);
    await expect(service.repairKnownWorkspaces()).resolves.toBeUndefined();
    await expect(service.unregisterAgent('main')).resolves.toBeUndefined();
    await expect(readFile(join(pathState.configRoot, 'uclaw-long-term-rules.json'), 'utf8'))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe(originalAgents);
  });

  it('preserves existing rules while disabled and resumes projection after the gate reopens', async () => {
    const service = new LongTermRuleService();
    const context = { agentId: 'main', workspaceRoot: workspace };
    const created = await service.create({ ...context, scope: 'agent', content: 'Persist across a remote pause.' });
    const rule = created.rules[0]!;
    const persistedBeforePause = await readFile(join(pathState.configRoot, 'uclaw-long-term-rules.json'), 'utf8');
    const agentsBeforePause = await readFile(join(workspace, 'AGENTS.md'), 'utf8');

    runtimeState.longTermRulesEnabled = false;
    await expect(service.update({ ...context, id: rule.id, enabled: false }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.delete({ ...context, id: rule.id }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.undo({ ...context, undoToken: created.undoToken! }))
      .resolves.toMatchObject({ disabled: true, rules: [] });
    await expect(service.repair(context)).resolves.toEqual([]);
    expect(await readFile(join(pathState.configRoot, 'uclaw-long-term-rules.json'), 'utf8')).toBe(persistedBeforePause);
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toBe(agentsBeforePause);

    runtimeState.longTermRulesEnabled = true;
    await expect(service.list(context)).resolves.toEqual({
      status: 'enabled',
      rules: [expect.objectContaining({ id: rule.id, content: 'Persist across a remote pause.' })],
    });
    await service.repair(context);
    expect(await readFile(join(workspace, 'AGENTS.md'), 'utf8')).toContain('Persist across a remote pause.');
  });
});
