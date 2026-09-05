#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildWindowsSelfCheck } from './build-windows-self-check.mjs';
import { BUNDLED_OPENCLAW_PLUGINS, LOCAL_OPENCLAW_PLUGIN_IDS } from './openclaw-bundle-config.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ARCH = readArg('--arch') || 'x64';
const FILE_NAME = `UClaw-${PACKAGE_JSON.version}-win-${ARCH}-usb.zip`;
const OUTPUT_PATH = path.join(RELEASE_DIR, FILE_NAME);
const METADATA_PATH = path.join(RELEASE_DIR, FILE_NAME.replace(/\.zip$/i, '.json'));
const PACKAGED_IDENTITY_FILE = 'resources/uclaw-build.json';
const USB_IDENTITY_FILE = 'uclaw-usb-build.json';
const SELF_CHECK_FILE = 'UClaw-SelfCheck.cmd';
const BOOTSTRAP_GATE_TIMEOUT_MS = 30_000;
const BOOTSTRAP_GATE_STABILITY_MS = 2_000;
const BOOTSTRAP_GATE_POLL_MS = 100;
const BOOTSTRAP_GATE_OUTPUT_LIMIT = 24_000;
const WINDOWS_PE_FILES = [
  'UClaw.exe',
  'resources/bin/node.exe',
  'resources/bin/uv.exe',
  'resources/bin/agent-browser.exe',
];
const REQUIRED_FILES = [
  ...WINDOWS_PE_FILES,
  'portable.flag',
  'resources/app.asar',
  'resources/cli/openclaw.cmd',
  'resources/openclaw/openclaw.mjs',
  'resources/openclaw/package.json',
  'resources/openclaw/node_modules/sharp/package.json',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/package.json',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'resources/openclaw/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  'resources/app.asar.unpacked/node_modules/sharp/package.json',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
  'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  ...BUNDLED_OPENCLAW_PLUGINS.flatMap(({ pluginId }) => [
    `resources/openclaw-plugins/${pluginId}/package.json`,
    `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
  ]),
  ...LOCAL_OPENCLAW_PLUGIN_IDS.flatMap((pluginId) => [
    `resources/openclaw-plugins/${pluginId}/package.json`,
    `resources/openclaw-plugins/${pluginId}/openclaw.plugin.json`,
  ]),
  'resources/openclaw-plugins/clawx-openai-image/index.mjs',
  'resources/openclaw-plugins/clawx-openai-image/node_modules/undici/package.json',
  'resources/openclaw-plugins/uclaw-video/index.mjs',
  'resources/resources/blender/runtime/uclaw_scene_runner.py',
  'resources/resources/blender/runtime/scene-spec.schema.json',
  'resources/resources/updater/win32-x64/uclaw-portable-updater.exe',
  PACKAGED_IDENTITY_FILE,
  USB_IDENTITY_FILE,
  SELF_CHECK_FILE,
];

const requireFromElectronBuilder = createRequire(
  path.join(ROOT, 'node_modules', 'electron-builder', 'package.json'),
);
const appBuilderPackagePath = requireFromElectronBuilder.resolve('app-builder-lib/package.json');
const requireFromAppBuilder = createRequire(appBuilderPackagePath);
const { extractFile: extractAsarFile } = requireFromAppBuilder('@electron/asar');

function readArg(name) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  if (match) return match.slice(prefix.length);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function isDirectInvocation() {
  if (!process.argv[1]) return false;
  const invokedPath = path.resolve(process.argv[1]);
  const modulePath = fileURLToPath(import.meta.url);
  return process.platform === 'win32'
    ? invokedPath.toLowerCase() === modulePath.toLowerCase()
    : invokedPath === modulePath;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function allocateLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral loopback port.')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function allocateBootstrapPorts(allocatePort) {
  const ports = [];
  for (let attempt = 0; ports.length < 3 && attempt < 12; attempt += 1) {
    const port = await allocatePort();
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error('Bootstrap gate received an invalid loopback port.');
    }
    if (!ports.includes(port)) ports.push(port);
  }
  if (ports.length !== 3) throw new Error('Bootstrap gate could not allocate three distinct loopback ports.');
  return {
    cdpPort: ports[0],
    hostApiPort: ports[1],
    gatewayPort: ports[2],
  };
}

function isolatedChildEnvironment(baseEnvironment) {
  const environment = { ...baseEnvironment };
  for (const key of Object.keys(environment)) {
    if (/^(?:CLAWX|OPENCLAW|UCLAW|SENTRY|POSTHOG)_/iu.test(key)
      || /^(?:PW_|PLAYWRIGHT_)/iu.test(key)
      || /^(?:HTTP|HTTPS|ALL|NO)_PROXY$/iu.test(key)
      || key === 'ELECTRON_RUN_AS_NODE'
      || key === 'NODE_OPTIONS'
      || /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?)(?:$|_)/iu.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}

export function createBootstrapEnvironment({
  baseEnvironment,
  sandboxRoot,
  portableRoot,
  cdpPort,
  hostApiPort,
  gatewayPort,
}) {
  if (!portableRoot) throw new Error('Bootstrap environment requires a portable root.');
  const homeDir = path.join(sandboxRoot, 'home');
  const appDataDir = path.join(homeDir, 'AppData', 'Roaming');
  const localAppDataDir = path.join(homeDir, 'AppData', 'Local');
  const tempDir = path.join(sandboxRoot, 'temp');
  const isolatedPortableDataRoot = path.join(sandboxRoot, 'portable');
  const runtimeRoot = path.join(sandboxRoot, 'runtime');
  const openClawHome = path.join(sandboxRoot, 'openclaw-home');
  const openClawState = path.join(sandboxRoot, 'openclaw-state');
  const userDataDir = path.join(isolatedPortableDataRoot, 'UClawData', 'clawx');
  const driveRoot = path.parse(homeDir).root.replace(/[\\/]$/u, '');
  const homePath = driveRoot && homeDir.toLowerCase().startsWith(driveRoot.toLowerCase())
    ? homeDir.slice(driveRoot.length)
    : homeDir;

  return {
    ...isolatedChildEnvironment(baseEnvironment),
    HOME: homeDir,
    USERPROFILE: homeDir,
    HOMEDRIVE: driveRoot,
    HOMEPATH: homePath,
    APPDATA: appDataDir,
    LOCALAPPDATA: localAppDataDir,
    TEMP: tempDir,
    TMP: tempDir,
    TMPDIR: tempDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
    XDG_CACHE_HOME: path.join(runtimeRoot, 'xdg-cache'),
    CLAWX_E2E: '1',
    CLAWX_E2E_SKIP_SETUP: '1',
    CLAWX_MANAGED_PROVIDER: '0',
    CLAWX_PORTABLE: '1',
    CLAWX_PORTABLE_ROOT: portableRoot,
    CLAWX_BOOTSTRAP_PORTABLE_DATA_ROOT: path.join(isolatedPortableDataRoot, 'UClawData'),
    CLAWX_PORTABLE_RUNTIME_ROOT: runtimeRoot,
    CLAWX_RUNTIME_CACHE_ROOT: runtimeRoot,
    CLAWX_USER_DATA_DIR: userDataDir,
    CLAWX_REMOTE_DEBUGGING_PORT: String(cdpPort),
    CLAWX_PORT_CLAWX_HOST_API: String(hostApiPort),
    CLAWX_PORT_OPENCLAW_GATEWAY: String(gatewayPort),
    OPENCLAW_HOME: openClawHome,
    OPENCLAW_STATE_DIR: openClawState,
    OPENCLAW_CONFIG_PATH: path.join(openClawState, 'openclaw.json'),
    OPENCLAW_CONFIG: path.join(openClawState, 'openclaw.json'),
    OPENCLAW_DISABLE_UPDATE_CHECK: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_NO_RESPAWN: '1',
    VITE_DEV_SERVER_URL: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ELECTRON_ENABLE_LOGGING: '1',
  };
}

function replaceKnownPath(text, value, replacement) {
  if (!value) return text;
  const variants = new Set([
    String(value),
    String(value).replaceAll('\\', '/'),
    String(value).replaceAll('/', '\\'),
  ]);
  let result = text;
  for (const variant of variants) {
    if (!variant) continue;
    const escaped = variant.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    result = result.replace(new RegExp(escaped, 'giu'), replacement);
  }
  return result;
}

export function redactBootstrapOutput(value, { sensitivePaths = [] } = {}) {
  let text = String(value ?? '').replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '');
  for (const { value: sensitivePath, replacement } of sensitivePaths) {
    text = replaceKnownPath(text, sensitivePath, replacement);
  }
  text = text
    .replace(/(\b(?:https?|wss?):\/\/)[^/@\s]+@/giu, '$1[credentials-redacted]@')
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/giu, '$1[secret-redacted]')
    .replace(
      /((?:"|')?(?:api[_-]?key|access[_-]?key|[a-z0-9_-]*token|password|passwd|secret|authorization|cookie|credential|private[_-]?key|client[_-]?secret|signature)(?:"|')?\s*(?::|=|\s)\s*)(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,;}\]]+)/giu,
      '$1[secret-redacted]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[secret-redacted]')
    .replace(/\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+(?:[\\/][^\r\n"'`<>|]*)?/giu, '[UserPath]');
  return text.length > BOOTSTRAP_GATE_OUTPUT_LIMIT
    ? `[output truncated]\n${text.slice(-BOOTSTRAP_GATE_OUTPUT_LIMIT)}`
    : text;
}

function createOutputCollector() {
  let output = '';
  return {
    append(chunk) {
      output += String(chunk);
      if (output.length > BOOTSTRAP_GATE_OUTPUT_LIMIT * 2) {
        output = output.slice(-BOOTSTRAP_GATE_OUTPUT_LIMIT);
      }
    },
    read() {
      return output;
    },
  };
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function describeChildExit(child) {
  return `exit=${child.exitCode ?? 'none'}, signal=${child.signalCode ?? 'none'}`;
}

async function probeCdpPage(cdpPort, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${cdpPort}/json/list`, {
      signal: controller.signal,
    });
    if (!response.ok) return { ready: false, detail: `HTTP ${response.status}` };
    const targets = await response.json();
    const ready = Array.isArray(targets) && targets.some((target) => (
      target && typeof target === 'object' && target.type === 'page'
    ));
    return {
      ready,
      detail: ready ? '' : `CDP exposed ${Array.isArray(targets) ? targets.length : 0} targets without a page`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function waitForBootstrapReady({
  child,
  cdpPort,
  fetchImpl,
  timeoutMs,
  stabilityMs,
  pollIntervalMs,
  sleep,
  getSpawnError,
}) {
  const deadline = Date.now() + timeoutMs;
  let lastProbe = 'CDP has not responded';
  while (Date.now() < deadline) {
    const spawnError = getSpawnError();
    if (spawnError) throw new Error(`UClaw.exe could not start: ${spawnError.message}`);
    if (childHasExited(child)) {
      throw new Error(`UClaw.exe exited before Bootstrap completed (${describeChildExit(child)}).`);
    }

    let probe;
    try {
      const remaining = Math.max(50, deadline - Date.now());
      probe = await probeCdpPage(cdpPort, fetchImpl, Math.min(1_000, remaining));
    } catch (error) {
      if (childHasExited(child)) {
        throw new Error(`UClaw.exe exited before Bootstrap completed (${describeChildExit(child)}).`);
      }
      lastProbe = error instanceof Error ? error.message : String(error);
      await sleep(pollIntervalMs);
      continue;
    }
    if (probe.ready) {
      const stableUntil = Date.now() + stabilityMs;
      while (Date.now() < stableUntil) {
        if (childHasExited(child)) {
          throw new Error(`UClaw.exe exited during Bootstrap stability check (${describeChildExit(child)}).`);
        }
        await sleep(Math.min(pollIntervalMs, Math.max(1, stableUntil - Date.now())));
      }
      if (childHasExited(child)) {
        throw new Error(`UClaw.exe exited during Bootstrap stability check (${describeChildExit(child)}).`);
      }
      return;
    }
    lastProbe = probe.detail;
    await sleep(pollIntervalMs);
  }
  throw new Error(`UClaw.exe did not expose a page over CDP within ${timeoutMs}ms (${lastProbe}).`);
}

function waitForProcessExit(child, timeoutMs) {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}

async function waitForChildOutput(child, timeoutMs = 250) {
  if (!child || typeof child.once !== 'function') return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener?.('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    child.once('close', finish);
    if (child.stdout?.readableEnded && child.stderr?.readableEnded) finish();
  });
}

async function terminateBootstrapProcessTree(child) {
  if (!child || childHasExited(child) || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } else {
    child.kill('SIGKILL');
  }
  if (!(await waitForProcessExit(child, 5_000))) {
    throw new Error('Bootstrap probe process tree did not stop within 5000ms.');
  }
}

export async function runPackagedBootstrapGate({
  portableRoot,
  platform = process.platform,
  baseEnvironment = process.env,
  timeoutMs = BOOTSTRAP_GATE_TIMEOUT_MS,
  stabilityMs = BOOTSTRAP_GATE_STABILITY_MS,
  pollIntervalMs = BOOTSTRAP_GATE_POLL_MS,
  allocatePort = allocateLoopbackPort,
  spawnProcess = spawn,
  fetchImpl = globalThis.fetch,
  sleep = delay,
  terminateProcess = terminateBootstrapProcessTree,
  tempParent = os.tmpdir(),
  removeDirectory = (directory) => fs.promises.rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }),
} = {}) {
  if (platform !== 'win32') throw new Error('Packaged Bootstrap integrity gate requires Windows.');
  if (!portableRoot) throw new Error('Packaged Bootstrap integrity gate requires a portable root.');
  const executablePath = path.join(portableRoot, 'UClaw.exe');
  if (!fs.existsSync(executablePath)) throw new Error('Packaged Bootstrap integrity gate cannot find UClaw.exe.');

  const startedAt = Date.now();
  const output = createOutputCollector();
  let sandboxRoot = '';
  let child = null;
  let spawnError = null;
  let ports = null;
  let failure = null;
  try {
    sandboxRoot = await fs.promises.mkdtemp(path.join(tempParent, 'uclaw-bootstrap-gate-'));
    ports = await allocateBootstrapPorts(allocatePort);
    const environment = createBootstrapEnvironment({
      baseEnvironment,
      sandboxRoot,
      portableRoot,
      ...ports,
    });
    await Promise.all([
      environment.USERPROFILE,
      environment.APPDATA,
      environment.LOCALAPPDATA,
      environment.TEMP,
      environment.CLAWX_PORTABLE_ROOT,
      environment.CLAWX_RUNTIME_CACHE_ROOT,
      environment.OPENCLAW_HOME,
      environment.OPENCLAW_STATE_DIR,
      environment.XDG_CONFIG_HOME,
      environment.XDG_DATA_HOME,
      environment.XDG_CACHE_HOME,
    ].map((directory) => fs.promises.mkdir(directory, { recursive: true })));
    // The packaged root must remain the real package so the first-launch gate
    // can validate its immutable payload. Mutable state stays under sandboxRoot.
    await fs.promises.writeFile(
      path.join(environment.CLAWX_PORTABLE_ROOT, 'portable.flag'),
      'UClaw USB portable mode\n',
      'utf8',
    );

    child = spawnProcess(executablePath, [
      `--remote-debugging-port=${ports.cdpPort}`,
      `--user-data-dir=${environment.CLAWX_USER_DATA_DIR}`,
      '--no-first-run',
    ], {
      cwd: portableRoot,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error : new Error(String(error));
    });
    child.stdout?.on('data', (chunk) => output.append(chunk));
    child.stderr?.on('data', (chunk) => output.append(chunk));
    await waitForBootstrapReady({
      child,
      cdpPort: ports.cdpPort,
      fetchImpl,
      timeoutMs,
      stabilityMs,
      pollIntervalMs,
      sleep,
      getSpawnError: () => spawnError,
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  try {
    await terminateProcess(child);
  } catch (error) {
    const cleanupError = error instanceof Error ? error : new Error(String(error));
    failure ??= cleanupError;
    if (failure !== cleanupError) output.append(`\nCleanup error: ${cleanupError.message}`);
  }
  await waitForChildOutput(child);
  if (sandboxRoot) {
    try {
      await removeDirectory(sandboxRoot);
    } catch (error) {
      const cleanupError = error instanceof Error ? error : new Error(String(error));
      failure ??= cleanupError;
      if (failure !== cleanupError) output.append(`\nSandbox cleanup error: ${cleanupError.message}`);
    }
  }

  if (failure) {
    const sensitivePaths = [
      { value: sandboxRoot, replacement: '[BootstrapTemp]' },
      { value: portableRoot, replacement: '[AppRoot]' },
      { value: baseEnvironment.USERPROFILE, replacement: '[UserPath]' },
      { value: baseEnvironment.HOME, replacement: '[UserPath]' },
      { value: baseEnvironment.APPDATA, replacement: '[UserPath]' },
      { value: baseEnvironment.LOCALAPPDATA, replacement: '[UserPath]' },
    ];
    const reason = redactBootstrapOutput(failure.message, { sensitivePaths });
    const captured = redactBootstrapOutput(output.read(), { sensitivePaths }).trim();
    const category = /MODULE_NOT_FOUND|Cannot find (?:package|module)/iu.test(`${failure.message}\n${output.read()}`)
      ? 'MODULE_NOT_FOUND'
      : 'startup_failure';
    throw new Error([
      `Packaged main-process Bootstrap integrity gate failed (${category}): ${reason}`,
      `Captured startup output:\n${captured || '[no process output]'}`,
    ].join('\n'));
  }

  return {
    durationMs: Date.now() - startedAt,
    cdpPort: ports.cdpPort,
  };
}

function resolveSourceCommit() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/i.test(commit)) return commit.toLowerCase();
  } catch { /* use CI fallback below */ }

  const fallback = String(process.env.UCLAW_BUILD_COMMIT || process.env.GITHUB_SHA || '').trim();
  if (/^[0-9a-f]{40}$/i.test(fallback)) return fallback.toLowerCase();
  throw new Error('Cannot resolve the source Git commit.');
}

function resolveSourceTreeState() {
  try {
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=normal'], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return status ? 'dirty' : 'clean';
  } catch {
    return 'unknown';
  }
}

function cleanExistingArtifacts({ includeUnpacked = false } = {}) {
  if (!fs.existsSync(RELEASE_DIR)) return [];
  const removed = [];
  for (const entry of fs.readdirSync(RELEASE_DIR, { withFileTypes: true })) {
    const usbArtifact = entry.isFile() && /^UClaw-.+-win-.+-usb\.(?:zip|json)$/i.test(entry.name);
    const unpacked = includeUnpacked && entry.isDirectory() && /^win(?:-.+)?-unpacked$/i.test(entry.name);
    if (!usbArtifact && !unpacked) continue;
    fs.rmSync(path.join(RELEASE_DIR, entry.name), {
      recursive: entry.isDirectory(),
      force: true,
      maxRetries: 5,
      retryDelay: 500,
    });
    removed.push(entry.name);
  }
  return removed;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is missing or invalid: ${filePath} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function readPeMachine(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const dosHeader = Buffer.alloc(64);
    if (fs.readSync(descriptor, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) {
      throw new Error('truncated DOS header');
    }
    if (dosHeader.readUInt16LE(0) !== 0x5a4d) throw new Error('missing MZ header');
    const peOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error('truncated PE header');
    }
    if (peHeader.readUInt32LE(0) !== 0x00004550) throw new Error('missing PE signature');
    return peHeader.readUInt16LE(4);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensurePortableMarkers(portableRoot) {
  const dataDir = path.join(portableRoot, 'UClawData');
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  fs.mkdirSync(path.join(dataDir, 'updates'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.keep'), '', 'utf8');
  fs.writeFileSync(path.join(portableRoot, 'portable.flag'), 'UClaw USB portable mode\n', 'utf8');
}

function assertPortableDataClean(portableRoot) {
  const dataDir = path.join(portableRoot, 'UClawData');
  const entries = fs.readdirSync(dataDir).sort();
  if (entries.join('\n') !== ['.keep', 'updates'].sort().join('\n')) {
    throw new Error(`UClawData contains unexpected files: ${entries.join(', ')}`);
  }
  const updates = fs.readdirSync(path.join(dataDir, 'updates'));
  if (updates.length > 0) throw new Error(`UClawData/updates is not empty: ${updates.join(', ')}`);
}

function getDeclaredPluginEntries(pkg, manifest) {
  return [...new Set([
    manifest.entry,
    pkg.main,
    pkg.module,
    ...(Array.isArray(pkg.openclaw?.runtimeExtensions) ? pkg.openclaw.runtimeExtensions : []),
    ...(Array.isArray(pkg.openclaw?.extensions) ? pkg.openclaw.extensions : []),
  ].filter((entry) => typeof entry === 'string' && entry.trim()))];
}

function assertPluginRuntimeDependencies(pluginDir, pkg, label) {
  const dependencies = Object.keys({
    ...(pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
    ...(pkg.optionalDependencies && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {}),
  });
  const missingDependencies = dependencies.filter((dependencyName) => (
    !fs.existsSync(path.join(pluginDir, 'node_modules', ...dependencyName.split('/'), 'package.json'))
  ));
  if (missingDependencies.length > 0) {
    throw new Error(`${label} is missing runtime dependencies: ${missingDependencies.join(', ')}`);
  }
}

function assertBundledPluginMetadata(pluginsRoot, plugin) {
  const pluginDir = path.join(pluginsRoot, plugin.pluginId);
  const pkg = readJson(path.join(pluginDir, 'package.json'), `Plugin ${plugin.pluginId} package.json`);
  const manifest = readJson(path.join(pluginDir, 'openclaw.plugin.json'), `Plugin ${plugin.pluginId} manifest`);
  if (pkg.name !== plugin.npmName) {
    throw new Error(`Plugin ${plugin.pluginId} package name mismatch: ${String(pkg.name)}`);
  }
  if (manifest.id !== plugin.manifestId) {
    throw new Error(`Plugin ${plugin.pluginId} manifest id mismatch: ${String(manifest.id)}`);
  }
  if (!pkg.version) throw new Error(`Plugin ${plugin.pluginId} package version is missing.`);
  if (manifest.version !== undefined && pkg.version !== manifest.version) {
    throw new Error(
      `Plugin ${plugin.pluginId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  const declaredEntries = getDeclaredPluginEntries(pkg, manifest);
  if (declaredEntries.length === 0
    || !declaredEntries.some((entry) => fs.existsSync(path.join(pluginDir, entry)))) {
    throw new Error(`Plugin ${plugin.pluginId} has no existing declared entrypoint.`);
  }
  assertPluginRuntimeDependencies(pluginDir, pkg, `Plugin ${plugin.pluginId}`);
}

function assertLocalPluginMetadata(pluginsRoot, pluginId) {
  const pluginDir = path.join(pluginsRoot, pluginId);
  const pkg = readJson(path.join(pluginDir, 'package.json'), `Plugin ${pluginId} package.json`);
  const manifest = readJson(path.join(pluginDir, 'openclaw.plugin.json'), `Plugin ${pluginId} manifest`);
  if (manifest.id !== pluginId) {
    throw new Error(`Plugin directory/id mismatch: expected ${pluginId}, manifest has ${String(manifest.id)}`);
  }
  if (pkg.name !== pluginId && pkg.name !== `${pluginId}-plugin`) {
    throw new Error(`Plugin ${pluginId} package name mismatch: ${String(pkg.name)}`);
  }
  if (!pkg.version || pkg.version !== manifest.version) {
    throw new Error(
      `Plugin ${pluginId} version mismatch: package=${String(pkg.version)} manifest=${String(manifest.version)}`,
    );
  }
  if (!pkg.main || pkg.main !== manifest.entry || !fs.existsSync(path.join(pluginDir, manifest.entry))) {
    throw new Error(
      `Plugin ${pluginId} entry mismatch or missing: package.main=${String(pkg.main)} manifest.entry=${String(manifest.entry)}`,
    );
  }
  if (pkg.openclaw?.extensions !== undefined
    && (!Array.isArray(pkg.openclaw.extensions) || !pkg.openclaw.extensions.includes(`./${manifest.entry}`))) {
    throw new Error(`Plugin ${pluginId} package.json declares an inconsistent OpenClaw entry`);
  }
  assertPluginRuntimeDependencies(pluginDir, pkg, `Plugin ${pluginId}`);
}

function validatePackagedPlugins(portableRoot) {
  const pluginsRoot = path.join(portableRoot, 'resources', 'openclaw-plugins');
  if (!fs.existsSync(pluginsRoot)) throw new Error('Packaged OpenClaw plugins directory is missing.');

  for (const plugin of BUNDLED_OPENCLAW_PLUGINS) {
    assertBundledPluginMetadata(pluginsRoot, plugin);
  }
  for (const pluginId of LOCAL_OPENCLAW_PLUGIN_IDS) {
    assertLocalPluginMetadata(pluginsRoot, pluginId);
  }
}

function validateBuildIdentity(portableRoot) {
  const currentCommit = resolveSourceCommit();
  const currentTreeState = resolveSourceTreeState();
  const identity = readJson(path.join(portableRoot, PACKAGED_IDENTITY_FILE), 'Packaged build identity');
  const asarPackage = JSON.parse(
    extractAsarFile(path.join(portableRoot, 'resources', 'app.asar'), 'package.json').toString('utf8'),
  );
  if (asarPackage.version !== PACKAGE_JSON.version || identity.appVersion !== PACKAGE_JSON.version) {
    throw new Error(`Stale app payload: source=${PACKAGE_JSON.version}, asar=${String(asarPackage.version)}, identity=${String(identity.appVersion)}`);
  }
  if (String(identity.gitCommit).toLowerCase() !== currentCommit) {
    throw new Error(`Stale win-unpacked commit: source=${currentCommit}, package=${String(identity.gitCommit)}`);
  }
  if (identity.sourceTreeState !== 'clean' || currentTreeState !== 'clean') {
    throw new Error(`Windows USB builds require clean source: package=${String(identity.sourceTreeState)}, current=${currentTreeState}`);
  }
  if (identity.platform !== 'win32' || identity.arch !== 'x64' || ARCH !== 'x64') {
    throw new Error(`Windows USB identity must be win32/x64: package=${String(identity.platform)}/${String(identity.arch)}, requested=${ARCH}`);
  }

  const executableMachines = Object.fromEntries(WINDOWS_PE_FILES.map((relativePath) => {
    const machine = readPeMachine(path.join(portableRoot, relativePath));
    return [relativePath, `0x${machine.toString(16)}`];
  }));
  const wrongArchitecture = Object.entries(executableMachines)
    .filter(([, machine]) => machine !== '0x8664')
    .map(([file, machine]) => `${file}=${machine}`);
  if (wrongArchitecture.length > 0) {
    throw new Error(`Windows runtime contains non-x64 executables: ${wrongArchitecture.join(', ')}`);
  }

  return {
    ...identity,
    packageType: 'portable_zip',
    appAsarVersion: asarPackage.version,
    executableMachine: executableMachines['UClaw.exe'],
    executableMachines,
    finalizedAt: new Date().toISOString(),
  };
}

function writeUsbIdentity(portableRoot, identity) {
  fs.writeFileSync(
    path.join(portableRoot, USB_IDENTITY_FILE),
    `${JSON.stringify(identity, null, 2)}\n`,
    'utf8',
  );
}

function assertPortableContents(portableRoot) {
  const missing = REQUIRED_FILES.filter((relativePath) => !fs.existsSync(path.join(portableRoot, relativePath)));
  if (missing.length > 0) throw new Error(`Windows USB package is incomplete. Missing: ${missing.join(', ')}`);
  validatePackagedPlugins(portableRoot);
}

function addDirectoryToZip(zip, sourceDir, archiveDate, prefix = '') {
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const zipPath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (zipPath.endsWith('.download')) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing to package symbolic link: ${zipPath}`);
    if (entry.isDirectory()) {
      addDirectoryToZip(zip, sourcePath, archiveDate, zipPath);
    } else if (entry.isFile()) {
      zip.file(zipPath, fs.readFileSync(sourcePath), { date: archiveDate });
    }
  }
}

async function writeZip(portableRoot, archiveDate) {
  if (!(archiveDate instanceof Date) || Number.isNaN(archiveDate.getTime())) {
    throw new Error('Windows USB archive timestamp is invalid.');
  }
  const zip = new JSZip();
  addDirectoryToZip(zip, portableRoot, archiveDate);
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
  });
  fs.writeFileSync(OUTPUT_PATH, buffer);
  return buffer;
}

function writeMetadata(buffer, identity) {
  const metadata = {
    version: PACKAGE_JSON.version,
    platform: 'win',
    arch: ARCH,
    packageType: 'portable_zip',
    package_type: 'portable_zip',
    fileName: FILE_NAME,
    file_name: FILE_NAME,
    size: buffer.length,
    sha512: createHash('sha512').update(buffer).digest('hex'),
    releaseDate: new Date().toISOString(),
    buildId: identity.buildId,
    gitCommit: identity.gitCommit,
    sourceCreatedAt: identity.createdAt,
    appAsarVersion: identity.appAsarVersion,
    executableMachine: identity.executableMachine,
    executableMachines: identity.executableMachines,
  };
  fs.writeFileSync(METADATA_PATH, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return metadata;
}

const DIRECT_INVOCATION = isDirectInvocation();

if (DIRECT_INVOCATION && process.argv.includes('--clean-only')) {
  if (process.argv.includes('--require-clean-source') && resolveSourceTreeState() !== 'clean') {
    console.error('[build-usb-release] Windows USB builds require a committed, clean source tree.');
    process.exit(1);
  }
  const removed = cleanExistingArtifacts({ includeUnpacked: true });
  console.log(`[build-usb-release] Removed ${removed.length} stale USB artifacts/build directories.`);
  process.exit(0);
}

if (DIRECT_INVOCATION) try {
  if (process.platform !== 'win32') {
    throw new Error('Windows USB packages must be built on a Windows host. Use the Package Windows workflow.');
  }
  if (ARCH !== 'x64') throw new Error(`Unsupported Windows USB architecture: ${ARCH}`);
  const portableRoot = path.join(RELEASE_DIR, 'win-unpacked');
  if (!fs.existsSync(portableRoot)) {
    throw new Error('release/win-unpacked does not exist. Run electron-builder --win dir --x64 first.');
  }

  cleanExistingArtifacts();
  ensurePortableMarkers(portableRoot);
  const identity = validateBuildIdentity(portableRoot);
  writeUsbIdentity(portableRoot, identity);
  buildWindowsSelfCheck(path.join(portableRoot, SELF_CHECK_FILE));
  assertPortableDataClean(portableRoot);
  assertPortableContents(portableRoot);
  const bootstrapGate = await runPackagedBootstrapGate({ portableRoot });
  console.log(`[build-usb-release] Main-process Bootstrap integrity gate passed (${bootstrapGate.durationMs}ms).`);
  assertPortableDataClean(portableRoot);
  const buffer = await writeZip(portableRoot, new Date(identity.finalizedAt));
  const metadata = writeMetadata(buffer, identity);
  console.log(`[build-usb-release] Created ${path.relative(ROOT, OUTPUT_PATH)} (${metadata.size} bytes).`);
  console.log(`[build-usb-release] Metadata: ${path.relative(ROOT, METADATA_PATH)}`);
  console.log(`[build-usb-release] sha512: ${metadata.sha512}`);
} catch (error) {
  console.error(`[build-usb-release] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
