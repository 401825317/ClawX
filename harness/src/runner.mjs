import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './specs.mjs';

function isPnpmCommand(command, pathApi) {
  const basename = pathApi.basename(command).toLowerCase();
  return basename === 'pnpm' || basename === 'pnpm.cmd' || basename === 'pnpm.ps1' || basename === 'pnpm.exe';
}

function isExistingAbsolutePath(candidate, pathApi, fileExists) {
  return typeof candidate === 'string' && pathApi.isAbsolute(candidate) && fileExists(candidate);
}

function isPnpmEntry(candidate, pathApi, fileExists) {
  return isExistingAbsolutePath(candidate, pathApi, fileExists)
    && /^pnpm\.(?:cjs|mjs|js)$/i.test(pathApi.basename(candidate));
}

function uniquePaths(candidates) {
  return [...new Set(candidates.filter(Boolean))];
}

function entriesNearNode(nodeExecutable, pathApi) {
  const nodeDirectory = pathApi.dirname(nodeExecutable);
  return [
    pathApi.join(nodeDirectory, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    pathApi.join(nodeDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    pathApi.join(nodeDirectory, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    pathApi.resolve(nodeDirectory, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    pathApi.resolve(nodeDirectory, '..', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ];
}

function pathDirectories(env, pathApi) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const pnpmHome = env.PNPM_HOME;
  const directories = [pnpmHome, ...pathValue.split(pathApi.delimiter)]
    .map((entry) => entry?.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry && pathApi.isAbsolute(entry));
  return uniquePaths(directories);
}

function resolveWindowsPnpm(step, { env, execPath, fileExists }) {
  const pathApi = path.win32;
  const nodeExecutables = uniquePaths([env.npm_node_execpath, execPath])
    .filter((candidate) => isExistingAbsolutePath(candidate, pathApi, fileExists));

  const npmExecPath = env.npm_execpath;
  if (isPnpmEntry(npmExecPath, pathApi, fileExists) && nodeExecutables.length > 0) {
    return { command: nodeExecutables[0], args: [npmExecPath, ...step.args] };
  }

  for (const nodeExecutable of nodeExecutables) {
    const pnpmEntry = entriesNearNode(nodeExecutable, pathApi)
      .find((candidate) => isPnpmEntry(candidate, pathApi, fileExists));
    if (pnpmEntry) {
      return { command: nodeExecutable, args: [pnpmEntry, ...step.args] };
    }
  }

  const explicitDirectory = pathApi.isAbsolute(step.command) ? pathApi.dirname(step.command) : null;
  const searchDirectories = uniquePaths([explicitDirectory, ...pathDirectories(env, pathApi)]);
  for (const directory of searchDirectories) {
    const nativeExecutable = pathApi.join(directory, 'pnpm.exe');
    if (fileExists(nativeExecutable)) {
      return { command: nativeExecutable, args: [...step.args] };
    }

    const hasPnpmShim = ['pnpm.cmd', 'pnpm.ps1', 'pnpm']
      .some((filename) => fileExists(pathApi.join(directory, filename)));
    if (!hasPnpmShim || nodeExecutables.length === 0) continue;

    const pnpmEntry = [
      pathApi.join(directory, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
      pathApi.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      pathApi.join(directory, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
      pathApi.resolve(directory, '..', '..', 'node', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      pathApi.resolve(directory, '..', '..', 'node', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    ].find((candidate) => isPnpmEntry(candidate, pathApi, fileExists));
    if (pnpmEntry) {
      return { command: nodeExecutables[0], args: [pnpmEntry, ...step.args] };
    }
  }

  throw new Error('Unable to resolve a shell-free pnpm executable on Windows; enable Corepack or install pnpm.');
}

export function resolveStepInvocation(step, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const execPath = options.execPath ?? process.execPath;
  const fileExists = options.fileExists ?? existsSync;
  const args = Array.isArray(step.args) ? [...step.args] : [];
  const normalizedStep = { ...step, args };
  const pathApi = platform === 'win32' ? path.win32 : path;

  if (platform === 'win32' && isPnpmCommand(step.command, pathApi)) {
    return resolveWindowsPnpm(normalizedStep, { env, execPath, fileExists });
  }

  return { command: step.command, args };
}

export async function runStep(step) {
  const started = Date.now();
  return await new Promise((resolve) => {
    let child;
    try {
      const invocation = resolveStepInvocation(step);
      child = spawn(invocation.command, invocation.args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false,
      });
    } catch (error) {
      console.error(`[harness] Failed to start ${step.name}: ${error instanceof Error ? error.message : String(error)}`);
      resolve({
        ...step,
        status: 'fail',
        exitCode: 1,
        durationMs: Date.now() - started,
      });
      return;
    }

    let settled = false;
    const finish = (exitCode) => {
      if (settled) return;
      settled = true;
      resolve({
        ...step,
        status: exitCode === 0 ? 'pass' : 'fail',
        exitCode: exitCode ?? 1,
        durationMs: Date.now() - started,
      });
    };

    child.once('error', (error) => {
      console.error(`[harness] Failed to start ${step.name}: ${error.message}`);
      finish(1);
    });
    child.once('close', finish);
  });
}
