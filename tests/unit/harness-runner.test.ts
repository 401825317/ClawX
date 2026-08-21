import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveStepInvocation, runStep } from '../../harness/src/runner.mjs';
import { ROOT } from '../../harness/src/specs.mjs';

describe('harness runner', () => {
  it('runs profile commands from the repository root', async () => {
    const originalCwd = process.cwd();

    try {
      process.chdir(path.join(ROOT, 'harness'));

      const result = await runStep({
        name: 'Check child cwd',
        command: process.execPath,
        args: ['-e', `process.exit(process.cwd() === ${JSON.stringify(ROOT)} ? 0 : 1)`],
      });

      expect(result.status).toBe('pass');
      expect(result.exitCode).toBe(0);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('preserves a Windows Node path containing spaces and its argument boundaries', () => {
    const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';
    const args = ['-e', 'process.exit(process.argv[1] === "value with spaces" ? 0 : 1)', 'value with spaces'];

    expect(resolveStepInvocation({
      name: 'Absolute Node command',
      command: nodeExecutable,
      args,
    }, {
      platform: 'win32',
      env: {},
      execPath: nodeExecutable,
      fileExists: () => false,
    })).toEqual({
      command: nodeExecutable,
      args,
    });
  });

  it('runs pnpm through Node and a trusted JavaScript entry on Windows', () => {
    const nodeExecutable = 'C:\\Program Files\\nodejs\\node.exe';
    const pnpmEntry = 'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js';
    const existingPaths = new Set([nodeExecutable.toLowerCase(), pnpmEntry.toLowerCase()]);

    expect(resolveStepInvocation({
      name: 'Check pnpm version',
      command: 'pnpm',
      args: ['--version'],
    }, {
      platform: 'win32',
      env: {},
      execPath: nodeExecutable,
      fileExists: (candidate: string) => existingPaths.has(candidate.toLowerCase()),
    })).toEqual({
      command: nodeExecutable,
      args: [pnpmEntry, '--version'],
    });
  });

  const windowsIt = process.platform === 'win32' ? it : it.skip;
  windowsIt('runs the real pnpm profile entry without DEP0190', async () => {
    const warnings: NodeJS.ErrnoException[] = [];
    const onWarning = (warning: Error) => warnings.push(warning as NodeJS.ErrnoException);
    process.on('warning', onWarning);

    try {
      const result = await runStep({
        name: 'Check real pnpm version',
        command: 'pnpm',
        args: ['--version'],
      });

      expect(result.status).toBe('pass');
      expect(result.exitCode).toBe(0);
      expect(warnings.some((warning) => warning.code === 'DEP0190')).toBe(false);
    } finally {
      process.off('warning', onWarning);
    }
  });
});
