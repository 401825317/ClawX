/**
 * OpenClaw CLI utilities — cross-platform auto-install
 */
import { app } from 'electron';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { spawn, type ForkOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { getOpenClawDir, getOpenClawEntryPath } from './paths';
import { logger } from './logger';

// ── Quoting helpers ──────────────────────────────────────────────────────────

function escapeForDoubleQuotes(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function quoteForPosix(value: string): string {
  return `"${escapeForDoubleQuotes(value)}"`;
}

function quoteForPowerShell(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function getPackagedWindowsNodePath(): string | null {
  if (!app.isPackaged || process.platform !== 'win32') return null;
  const nodePath = join(process.resourcesPath, 'bin', 'node.exe');
  return existsSync(nodePath) ? nodePath : null;
}

// ── CLI command string (for display / copy) ──────────────────────────────────

export function getOpenClawCliCommand(): string {
  const entryPath = getOpenClawEntryPath();
  const platform = process.platform;

  if (platform === 'darwin' || platform === 'linux') {
    const localBinPath = join(homedir(), '.local', 'bin', 'openclaw');
    if (existsSync(localBinPath)) {
      return quoteForPosix(localBinPath);
    }
  }

  if (platform === 'linux') {
    if (existsSync('/usr/local/bin/openclaw')) {
      return '/usr/local/bin/openclaw';
    }
  }

  if (!app.isPackaged) {
    const openclawDir = getOpenClawDir();
    const nodeModulesDir = dirname(openclawDir);
    const binName = platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
    const binPath = join(nodeModulesDir, '.bin', binName);

    if (existsSync(binPath)) {
      if (platform === 'win32') {
        return `& ${quoteForPowerShell(binPath)}`;
      }
      return quoteForPosix(binPath);
    }
  }

  if (app.isPackaged) {
    if (platform === 'win32') {
      const cliDir = join(process.resourcesPath, 'cli');
      const cmdPath = join(cliDir, 'openclaw.cmd');
      if (existsSync(cmdPath)) {
        return `& ${quoteForPowerShell(cmdPath)}`;
      }

      const bundledNode = getPackagedWindowsNodePath();
      if (bundledNode) {
        return `& ${quoteForPowerShell(bundledNode)} ${quoteForPowerShell(entryPath)}`;
      }
    }

    const execPath = process.execPath;
    if (platform === 'win32') {
      return `$env:ELECTRON_RUN_AS_NODE=1; & ${quoteForPowerShell(execPath)} ${quoteForPowerShell(entryPath)}`;
    }
    return `ELECTRON_RUN_AS_NODE=1 ${quoteForPosix(execPath)} ${quoteForPosix(entryPath)}`;
  }

  if (platform === 'win32') {
    return `node ${quoteForPowerShell(entryPath)}`;
  }

  return `node ${quoteForPosix(entryPath)}`;
}

export type OpenClawCliSpawnSpec = {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
};

type OpenClawEmbeddedForkOptions = ForkOptions & { windowsHide?: boolean };

export type OpenClawEmbeddedForkSpec = {
  modulePath: string;
  args: string[];
  options: OpenClawEmbeddedForkOptions;
};

function fileExists(path: string): boolean {
  return existsSync(path);
}

function getWindowsCmdWrapperSpawnSpec(cmdPath: string): OpenClawCliSpawnSpec {
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${cmdPath}"`],
  };
}

export function getOpenClawCliSpawnSpec(): OpenClawCliSpawnSpec {
  const entryPath = getOpenClawEntryPath();
  const platform = process.platform;

  if (platform === 'darwin' || platform === 'linux') {
    const localBinPath = join(homedir(), '.local', 'bin', 'openclaw');
    if (fileExists(localBinPath)) {
      return { command: localBinPath, args: [] };
    }
  }

  if (platform === 'linux' && fileExists('/usr/local/bin/openclaw')) {
    return { command: '/usr/local/bin/openclaw', args: [] };
  }

  if (!app.isPackaged) {
    const openclawDir = getOpenClawDir();
    const nodeModulesDir = dirname(openclawDir);
    const binName = platform === 'win32' ? 'openclaw.cmd' : 'openclaw';
    const binPath = join(nodeModulesDir, '.bin', binName);

    if (fileExists(binPath)) {
      if (platform === 'win32') {
        return getWindowsCmdWrapperSpawnSpec(binPath);
      }

      return { command: binPath, args: [], shell: false };
    }
  }

  const packagedWrapper = getPackagedCliWrapperPath();
  if (packagedWrapper) {
    if (platform === 'win32') {
      return getWindowsCmdWrapperSpawnSpec(packagedWrapper);
    }

    return { command: packagedWrapper, args: [], shell: false };
  }

  if (app.isPackaged) {
    if (platform === 'win32') {
      const bundledNode = getPackagedWindowsNodePath();
      if (bundledNode) {
        return { command: bundledNode, args: [entryPath] };
      }
    }

    return {
      command: process.execPath,
      args: [entryPath],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    };
  }

  return { command: 'node', args: [entryPath] };
}

function getOpenClawEmbeddedExecPath(): { execPath: string; electronRunAsNode: boolean } {
  if (!app.isPackaged) {
    // ACP is part of the Electron app runtime. Keep it on Electron's bundled
    // Node instead of inheriting an arbitrary, potentially outdated PATH Node.
    return { execPath: process.execPath, electronRunAsNode: true };
  }

  if (app.isPackaged && process.platform === 'win32') {
    const bundledNode = getPackagedWindowsNodePath();
    if (bundledNode) return { execPath: bundledNode, electronRunAsNode: false };
  }

  if (app.isPackaged && process.platform === 'darwin') {
    const helperPath = getPackagedMacOSHelperPath();
    if (!helperPath) {
      throw new Error('UClaw Helper executable not found for embedded OpenClaw launch');
    }
    return { execPath: helperPath, electronRunAsNode: true };
  }

  return { execPath: process.execPath, electronRunAsNode: Boolean(process.versions?.electron) };
}

export function getOpenClawEmbeddedForkSpec(args: string[] = []): OpenClawEmbeddedForkSpec {
  const { execPath, electronRunAsNode } = getOpenClawEmbeddedExecPath();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_EMBEDDED_IN: 'UClaw',
    OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
  };

  if (electronRunAsNode) {
    env.ELECTRON_RUN_AS_NODE = '1';
  } else {
    delete env.ELECTRON_RUN_AS_NODE;
  }

  return {
    modulePath: getOpenClawEntryPath(),
    args,
    options: {
      cwd: getOpenClawDir(),
      env,
      execPath,
      execArgv: [],
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  };
}

// ── Packaged CLI wrapper path ────────────────────────────────────────────────

function getPackagedCliWrapperPath(): string | null {
  if (!app.isPackaged) return null;
  const platform = process.platform;

  if (platform === 'darwin' || platform === 'linux') {
    const wrapper = join(process.resourcesPath, 'cli', 'openclaw');
    return existsSync(wrapper) ? wrapper : null;
  }
  if (platform === 'win32') {
    const wrapper = join(process.resourcesPath, 'cli', 'openclaw.cmd');
    return existsSync(wrapper) ? wrapper : null;
  }
  return null;
}

function getWindowsPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  return join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/**
 * Return the product name used by Electron's macOS helper bundles.
 *
 * `app.getName()` is not reliable here: in packaged builds it can resolve to
 * the npm/package name (`clawx`) rather than electron-builder's product name
 * (`UClaw`).  The app bundle containing process.execPath is authoritative.
 */
function getPackagedMacOSBundleName(): string | null {
  const appBundleDir = dirname(dirname(dirname(process.execPath)));
  const appBundleBaseName = basename(appBundleDir);
  if (appBundleBaseName.toLowerCase().endsWith('.app')) {
    const bundleName = appBundleBaseName.slice(0, -'.app'.length).trim();
    if (bundleName) return bundleName;
  }

  return null;
}

function getPackagedMacOSApplicationName(): string {
  const bundleName = getPackagedMacOSBundleName();
  if (bundleName) return bundleName;

  const electronName = app.getName().trim();
  if (electronName) {
    // Keep a useful user-facing name even when Electron reports the package
    // identifier.  This also lets older non-bundled launches find UClaw's
    // helper after the product rename.
    if (electronName.toLowerCase() === 'clawx') return 'UClaw';
    return electronName;
  }

  return 'UClaw';
}

function getPackagedMacOSHelperPath(): string | null {
  if (process.platform !== 'darwin' || !app.isPackaged) return null;
  const frameworksDir = join(dirname(process.execPath), '../Frameworks');
  const bundleName = getPackagedMacOSBundleName();
  const electronName = app.getName().trim();
  const names = [
    getPackagedMacOSApplicationName(),
    'UClaw',
    // Keep compatibility with app bundles produced before the UClaw rename.
    // Older helper frameworks can remain in a newly renamed UClaw.app (for
    // example after an in-place copy), so ClawX must be a fallback regardless
    // of the current bundle name.  It stays after the current product name to
    // ensure a matching UClaw Helper is always preferred.
    'ClawX',
    bundleName ? '' : electronName,
    bundleName ? '' : electronName.toLowerCase() === 'clawx' ? 'UClaw' : '',
  ].filter((name, index, all) => {
    if (!name) return false;
    return all.findIndex((candidate) => candidate.toLowerCase() === name.toLowerCase()) === index;
  });

  for (const name of names) {
    const helperName = `${name} Helper`;
    const helperPath = join(
      frameworksDir,
      `${helperName}.app`,
      'Contents/MacOS',
      helperName,
    );
    if (existsSync(helperPath)) return helperPath;
  }

  return null;
}

// ── macOS / Linux install ────────────────────────────────────────────────────

function getCliTargetPath(): string {
  return join(homedir(), '.local', 'bin', 'openclaw');
}

export async function installOpenClawCli(): Promise<{
  success: boolean; path?: string; error?: string;
}> {
  const platform = process.platform;

  if (platform === 'win32') {
    return { success: false, error: 'Windows CLI is configured by the installer.' };
  }

  if (!app.isPackaged) {
    return { success: false, error: 'CLI install is only available in packaged builds.' };
  }

  const wrapperSrc = getPackagedCliWrapperPath();
  if (!wrapperSrc) {
    return { success: false, error: 'CLI wrapper not found in app resources.' };
  }

  const targetDir = join(homedir(), '.local', 'bin');
  const target = getCliTargetPath();

  try {
    mkdirSync(targetDir, { recursive: true });

    // Remove existing file/symlink to avoid EEXIST
    if (existsSync(target)) {
      unlinkSync(target);
    }

    symlinkSync(wrapperSrc, target);
    // The macOS app bundle is commonly mounted read-only (DMG) or protected
    // by the Applications folder.  Its executable bit is set at build time;
    // never try to mutate the bundled resource at runtime.
    if (platform !== 'darwin') {
      chmodSync(wrapperSrc, 0o755);
    }
    logger.info(`OpenClaw CLI symlink created: ${target} -> ${wrapperSrc}`);
    return { success: true, path: target };
  } catch (error) {
    logger.error('Failed to install OpenClaw CLI:', error);
    return { success: false, error: String(error) };
  }
}

// ── Auto-install on first launch ─────────────────────────────────────────────

function isCliInstalled(): boolean {
  const platform = process.platform;

  if (platform === 'win32') return true; // handled by NSIS installer

  const target = getCliTargetPath();
  if (!existsSync(target)) return false;

  // Also check /usr/local/bin/openclaw for deb installs
  if (platform === 'linux' && existsSync('/usr/local/bin/openclaw')) return true;

  return true;
}

function ensureWindowsCliOnPath(): Promise<'updated' | 'already-present'> {
  return new Promise((resolve, reject) => {
    const cliWrapper = getPackagedCliWrapperPath();
    if (!cliWrapper) {
      reject(new Error('CLI wrapper not found in app resources.'));
      return;
    }

    const cliDir = dirname(cliWrapper);
    const helperPath = join(cliDir, 'update-user-path.ps1');
    if (!existsSync(helperPath)) {
      reject(new Error(`PATH helper not found at ${helperPath}`));
      return;
    }

    const child = spawn(
      getWindowsPowerShellPath(),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        helperPath,
        '-Action',
        'add',
        '-CliDir',
        cliDir,
      ],
      {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `PowerShell exited with code ${code}`));
        return;
      }

      const status = stdout.trim();
      if (status === 'updated' || status === 'already-present') {
        resolve(status);
        return;
      }

      reject(new Error(`Unexpected PowerShell output: ${status || '(empty)'}`));
    });
  });
}

function ensureLocalBinInPath(): void {
  if (process.platform === 'win32') return;

  const localBin = join(homedir(), '.local', 'bin');
  const pathEnv = process.env.PATH || '';
  if (pathEnv.split(':').includes(localBin)) return;

  const shell = process.env.SHELL || '/bin/zsh';
  const profileFile = shell.includes('zsh')
    ? join(homedir(), '.zshrc')
    : shell.includes('fish')
      ? join(homedir(), '.config', 'fish', 'config.fish')
      : join(homedir(), '.bashrc');

  try {
    const marker = '.local/bin';
    let content = '';
    try {
      content = readFileSync(profileFile, 'utf-8');
    } catch {
      // file doesn't exist yet
    }

    if (content.includes(marker)) return;

    const line = shell.includes('fish')
      ? '\n# Added by UClaw\nfish_add_path "$HOME/.local/bin"\n'
      : '\n# Added by UClaw\nexport PATH="$HOME/.local/bin:$PATH"\n';

    appendFileSync(profileFile, line);
    logger.info(`Added ~/.local/bin to PATH in ${profileFile}`);
  } catch (error) {
    logger.warn('Failed to add ~/.local/bin to PATH:', error);
  }
}

export async function autoInstallCliIfNeeded(
  notify?: (path: string) => void,
): Promise<void> {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') {
    try {
      const result = await ensureWindowsCliOnPath();
      if (result === 'updated') {
        logger.info('Added Windows CLI directory to user PATH.');
      }
    } catch (error) {
      logger.warn('Failed to ensure Windows CLI is on PATH:', error);
    }
    return;
  }

  const target = getCliTargetPath();
  const wrapperSrc = getPackagedCliWrapperPath();

  if (isCliInstalled()) {
    if (target && wrapperSrc && existsSync(target)) {
      try {
        unlinkSync(target);
        symlinkSync(wrapperSrc, target);
        logger.debug(`Refreshed CLI symlink: ${target} -> ${wrapperSrc}`);
      } catch {
        // non-critical
      }
    }
    return;
  }

  logger.info('Auto-installing openclaw CLI...');
  const result = await installOpenClawCli();
  if (result.success) {
    logger.info(`CLI auto-installed at ${result.path}`);
    ensureLocalBinInPath();
    if (result.path) notify?.(result.path);
  } else {
    logger.warn(`CLI auto-install failed: ${result.error}`);
  }
}

// ── Completion helpers ───────────────────────────────────────────────────────

function getNodeExecForCli(): string {
  const helperPath = getPackagedMacOSHelperPath();
  if (helperPath) return helperPath;
  return process.execPath;
}

export function generateCompletionCache(): void {
  if (!app.isPackaged) return;

  const entryPath = getOpenClawEntryPath();
  if (!existsSync(entryPath)) return;

  const execPath = getNodeExecForCli();

  const child = spawn(execPath, [entryPath, 'completion', '--write-state'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      OPENCLAW_NO_RESPAWN: '1',
      OPENCLAW_EMBEDDED_IN: 'UClaw',
    },
    stdio: 'ignore',
    detached: false,
    windowsHide: true,
  });

  child.on('close', (code) => {
    if (code === 0) {
      logger.info('OpenClaw completion cache generated');
    } else {
      logger.warn(`OpenClaw completion cache generation exited with code ${code}`);
    }
  });

  child.on('error', (err) => {
    logger.warn('Failed to generate completion cache:', err);
  });
}

export function installCompletionToProfile(): void {
  if (!app.isPackaged) return;
  if (process.platform === 'win32') return;

  const entryPath = getOpenClawEntryPath();
  if (!existsSync(entryPath)) return;

  const execPath = getNodeExecForCli();

  const child = spawn(
    execPath,
    [entryPath, 'completion', '--install', '-y'],
    {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        OPENCLAW_NO_RESPAWN: '1',
        OPENCLAW_EMBEDDED_IN: 'UClaw',
      },
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    }
  );

  child.on('close', (code) => {
    if (code === 0) {
      logger.info('OpenClaw completion installed to shell profile');
    } else {
      logger.warn(`OpenClaw completion install exited with code ${code}`);
    }
  });

  child.on('error', (err) => {
    logger.warn('Failed to install completion to shell profile:', err);
  });
}
