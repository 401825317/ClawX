#!/usr/bin/env node

/**
 * Validate the Windows NSIS artifact as an installer product.
 *
 * This is deliberately separate from the USB ZIP regression. The installer
 * must be tested after signing and metadata repair, because signing changes
 * the installer bytes and therefore its update hashes and block map.
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  access,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parse as parseYaml } from 'yaml';

const require = createRequire(import.meta.url);
const { extractFile } = require('@electron/asar');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PRODUCT_NAME = readProductName();
const INSTALL_TIMEOUT_MS = 12 * 60_000;
const STARTUP_TIMEOUT_MS = 4 * 60_000;
const UNINSTALL_TIMEOUT_MS = 8 * 60_000;

function readProductName() {
  try {
    const text = require('node:fs').readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    const match = text.match(/^productName:\s*([^\r\n#]+?)\s*$/mu);
    if (match?.[1]) return match[1].trim();
  } catch {
    // Use the product name from the current release convention if the config
    // cannot be read. The artifact name check will still be strict by version.
  }
  return 'UClaw';
}

function parseArgs(argv) {
  const options = {
    installer: '',
    reportDir: '',
    requireUpdateMetadata: false,
    requireBlockmap: false,
    requireCleanSource: false,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--installer':
        options.installer = readValue();
        break;
      case '--report-dir':
        options.reportDir = readValue();
        break;
      case '--require-update-metadata':
        options.requireUpdateMetadata = true;
        break;
      case '--require-blockmap':
        options.requireBlockmap = true;
        break;
      case '--require-clean-source':
        options.requireCleanSource = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.requireBlockmap) options.requireUpdateMetadata = true;
  return options;
}

function printHelp() {
  console.log(`UClaw NSIS release validation

Usage:
  node scripts/windows-support/validate-nsis-release.mjs --require-update-metadata --require-blockmap
  node scripts/windows-support/validate-nsis-release.mjs --installer <release/UClaw-...-win-x64.exe>

Checks:
  - final x64 PE and packaged identity/runtime files
  - latest*.yml URL, size and SHA-512 against the final installer
  - block map regenerated from the final installer
  - isolated silent install and real installed-app startup
  - silent uninstall, process cleanup and user-data retention

Options:
  --report-dir <dir>       Write the JSON/Markdown report to this directory.
  --require-update-metadata Fail when latest*.yml is absent or inconsistent.
  --require-blockmap       Also require and verify the NSIS block map.
  --require-clean-source   Require the packaged build identity to come from a clean Git tree.
  --keep                   Keep the isolated installer sandbox for inspection.
`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function safeTempChild(targetPath) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(targetPath);
  const relative = path.relative(tempRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe temporary path: ${resolved}`);
  }
  return resolved;
}

function redact(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|relay[_-]?token|password|secret|credential)"?\s*[:=]\s*")([^"]+)(")/giu, '$1[REDACTED]$3')
    .replace(/([?&](?:token|signature|sig|key)=)[^&\s]+/giu, '$1[REDACTED]');
}

function runSync(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw result.error;
  return result;
}

function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The process may already have exited.
  }
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
    }, options.timeoutMs ?? 120_000);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
        stdout,
        stderr,
        timedOut,
        pid: child.pid ?? null,
      });
    });
  });
}

async function sha512(filePath, encoding = 'hex') {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest(encoding);
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate an ephemeral port.')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForCdp(origin, child, timeoutMs = STARTUP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Installed UClaw exited before CDP was ready (exit=${child.exitCode}).`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    try {
      const response = await fetch(`${origin}/json/version`, { signal: controller.signal });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Installed UClaw CDP endpoint did not become ready: ${lastError}`);
}

async function getStablePage(browser) {
  const context = browser.contexts()[0];
  if (!context) throw new Error('Installed UClaw exposed no Chromium browser context.');
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const candidate = context.pages().filter((page) => !page.isClosed()).at(-1);
    if (candidate) {
      try {
        await candidate.waitForLoadState('domcontentloaded', { timeout: 3_000 });
        return candidate;
      } catch {
        // Poll while Electron is replacing the initial document.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('No stable installed UClaw window became available.');
}

async function waitForRenderedBody(page) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastLength = 0;
  while (Date.now() < deadline) {
    try {
      lastLength = (await page.locator('body').innerText({ timeout: 3_000 })).trim().length;
      if (lastLength >= 20) return;
    } catch {
      // The renderer may replace the document during Electron startup.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Installed UClaw window rendered an empty body (length=${lastLength}).`);
}

async function invokeHostApi(page, requestPath) {
  return await page.evaluate(async (pathValue) => {
    const api = window.electron;
    return await api.ipcRenderer.invoke('hostapi:fetch', {
      path: pathValue,
      method: 'GET',
      headers: {},
      body: null,
    });
  }, requestPath);
}

function unwrapHostApiResponse(response) {
  const outer = response && typeof response === 'object' ? response : {};
  const data = outer.data && typeof outer.data === 'object' ? outer.data : outer;
  return {
    ok: data.ok !== false && outer.ok !== false,
    json: data.json,
    error: data.error || outer.error || '',
  };
}

function isolatedEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:CLAWX|OPENCLAW|UCLAW)_/iu.test(key)
      || /^(?:PW_|PLAYWRIGHT_|ELECTRON_RUN_AS_NODE$)/iu.test(key)
      || key === 'NODE_OPTIONS'
      || /(?:^|_)(?:API_?KEY|ACCESS_?KEY|TOKEN|PASSWORD|PASSWD|SECRET|CREDENTIALS?)(?:$|_)/iu.test(key)) {
      delete env[key];
    }
  }
  return env;
}

async function seedIsolatedUserData(sandboxRoot, gatewayPort) {
  const profileRoot = path.join(sandboxRoot, 'profile');
  const appData = path.join(profileRoot, 'AppData', 'Roaming');
  const localAppData = path.join(profileRoot, 'AppData', 'Local');
  const tempDir = path.join(profileRoot, 'Temp');
  const clawxData = path.join(appData, PRODUCT_NAME);
  const openclawHome = path.join(profileRoot, 'openclaw-home');
  const openclawState = path.join(openclawHome, '.openclaw');
  await mkdir(clawxData, { recursive: true });
  await mkdir(localAppData, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  await mkdir(openclawState, { recursive: true });
  await writeFile(path.join(clawxData, 'settings.json'), `${JSON.stringify({
    setupComplete: true,
    gatewayAutoStart: true,
    gatewayPort,
    gatewayToken: randomBytes(24).toString('hex'),
    autoCheckUpdates: false,
    proxyEnabled: false,
    proxyServer: '',
    proxyHttpServer: '',
  }, null, 2)}\n`, 'utf8');
  return { profileRoot, appData, localAppData, tempDir, openclawHome, openclawState, clawxData };
}

async function killProcessesUnder(rootDir) {
  if (process.platform !== 'win32') return;
  const escaped = rootDir.replaceAll("'", "''");
  const command = `$root='${escaped}'; Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  runSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
}

async function hasProcessAtPath(filePath) {
  if (process.platform !== 'win32') return false;
  const escaped = filePath.replaceAll("'", "''");
  const command = `$target='${escaped}'; $p=Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) }; if ($p) { exit 1 } else { exit 0 }`;
  return runSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]).status !== 0;
}

async function killProcessesAtPath(filePath) {
  if (process.platform !== 'win32') return;
  const escaped = filePath.replaceAll("'", "''");
  const command = `$target='${escaped}'; Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($target, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  runSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
}

async function assertNoActiveUclawProcesses() {
  if (process.platform !== 'win32') return;
  const command = "$names=@('UClaw.exe','ClawX.exe','openclaw-gateway.exe'); $p=Get-CimInstance -ClassName Win32_Process | Where-Object { $names -contains $_.Name }; if ($p) { exit 1 } else { exit 0 }";
  const result = runSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]);
  if (result.status !== 0) {
    throw new Error('An existing UClaw/ClawX/Gateway process is running. Use a clean test account before running the NSIS lifecycle gate.');
  }
}

async function waitForProcessPathExit(filePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await hasProcessAtPath(filePath))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`NSIS process did not settle: ${filePath}`);
}

async function waitForInstalledTree(installRoot, timeoutMs) {
  const executable = path.join(installRoot, `${PRODUCT_NAME}.exe`);
  const asar = path.join(installRoot, 'resources', 'app.asar');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fileExists(executable) && await fileExists(asar)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function runNsisInstaller(installerPath, args, env, installRoot) {
  const result = await runProcess(installerPath, args, { env, timeoutMs: INSTALL_TIMEOUT_MS });
  if (result.timedOut) {
    await killProcessesAtPath(installerPath);
    throw new Error(`Installer timed out after ${INSTALL_TIMEOUT_MS}ms.`);
  }
  // Assisted NSIS can leave a second copy of the bootstrap process running
  // after the first stub reports an access-violation exit. Wait for the actual
  // installer path to settle before judging the result by the installed tree.
  await waitForProcessPathExit(installerPath, INSTALL_TIMEOUT_MS);
  const installed = await waitForInstalledTree(installRoot, INSTALL_TIMEOUT_MS);
  if (result.code !== 0 && !installed) {
    throw new Error(`Installer exited with code ${result.code} and did not produce a complete install.`);
  }
  return { ...result, installed, detachedBootstrap: result.code !== 0 };
}

async function hasProcessesUnder(rootDir) {
  if (process.platform !== 'win32') return false;
  const escaped = rootDir.replaceAll("'", "''");
  const command = `$root='${escaped}'; $p=Get-CimInstance -ClassName Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase) }; if ($p) { exit 1 } else { exit 0 }`;
  return runSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ]).status !== 0;
}

async function launchInstalledApp(installerRoot, sandboxRoot, gatewayPort, hostApiPort) {
  const profile = await seedIsolatedUserData(sandboxRoot, gatewayPort);
  const cdpPort = await allocatePort();
  const env = {
    ...isolatedEnvironment(),
    HOME: profile.profileRoot,
    USERPROFILE: profile.profileRoot,
    APPDATA: profile.appData,
    LOCALAPPDATA: profile.localAppData,
    TEMP: profile.tempDir,
    TMP: profile.tempDir,
    CLAWX_RUNTIME_CACHE_ROOT: path.join(profile.localAppData, 'UClawRuntime'),
    CLAWX_MANAGED_PROVIDER: '0',
    CLAWX_E2E: '0',
    CLAWX_E2E_SKIP_SETUP: '0',
    CLAWX_PORT_CLAWX_HOST_API: String(hostApiPort),
    CLAWX_PORT_OPENCLAW_GATEWAY: String(gatewayPort),
    CLAWX_REMOTE_DEBUGGING_PORT: String(cdpPort),
    OPENCLAW_HOME: profile.openclawHome,
    OPENCLAW_STATE_DIR: profile.openclawState,
    OPENCLAW_CONFIG_PATH: path.join(profile.openclawState, 'openclaw.json'),
    OPENCLAW_CONFIG: path.join(profile.openclawState, 'openclaw.json'),
    OPENCLAW_DISABLE_UPDATE_CHECK: '1',
    VITE_DEV_SERVER_URL: '',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const executablePath = path.join(installerRoot, `${PRODUCT_NAME}.exe`);
  const child = spawn(executablePath, [`--remote-debugging-port=${cdpPort}`], {
    cwd: installerRoot,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  let browser = null;
  try {
    await waitForCdp(`http://127.0.0.1:${cdpPort}`, child);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 120_000 });
    const page = await getStablePage(browser);
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(60_000);
    await waitForRenderedBody(page);
    const mainLayout = page.locator('[data-testid="main-layout"]');
    const setupPage = page.locator('[data-testid="setup-page"]');
    if (await mainLayout.count() === 0 && await setupPage.count() === 0) {
      throw new Error('Installed UClaw rendered neither the setup page nor the main layout.');
    }
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let lastStatus = null;
    let lastError = '';
    while (Date.now() < deadline) {
      const response = unwrapHostApiResponse(await invokeHostApi(page, '/api/gateway/status'));
      if (response.ok && response.json && typeof response.json === 'object') {
        lastStatus = response.json;
        if (lastStatus.state === 'running' && lastStatus.gatewayReady !== false) {
          return { child, browser, page, output, env, profile, status: lastStatus };
        }
      } else {
        lastError = response.error || 'Host API returned an unsuccessful response';
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Installed Gateway did not reach running. Last status=${JSON.stringify(lastStatus)} error=${lastError}`);
  } catch (error) {
    await browser?.close().catch(() => undefined);
    terminateProcessTree(child.pid);
    await killProcessesUnder(installerRoot);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      startupOutput: output.join(''),
    });
  }
}

async function closeInstalledApp(session, installerRoot) {
  if (!session) return;
  await session.browser?.close().catch(() => undefined);
  terminateProcessTree(session.child?.pid);
  await killProcessesUnder(installerRoot);
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!(await hasProcessesUnder(installerRoot))) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function readPeMachine(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('Installer or executable is not a valid PE file.');
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== 0x00004550) {
    throw new Error('PE signature is missing.');
  }
  return buffer.readUInt16LE(peOffset + 4);
}

async function peMachine(filePath) {
  const buffer = await readFile(filePath);
  return `0x${readPeMachine(buffer).toString(16)}`;
}

function urlBasename(value) {
  try {
    return path.posix.basename(new URL(String(value), 'https://invalid.local').pathname);
  } catch {
    return path.basename(String(value).replaceAll('\\', '/'));
  }
}

async function resolveInstaller(options, version) {
  if (options.installer) {
    const explicit = path.resolve(options.installer);
    if (!(await fileExists(explicit))) throw new Error(`Installer not found: ${explicit}`);
    return explicit;
  }
  const expected = new RegExp(`^${escapeRegExp(PRODUCT_NAME)}-${escapeRegExp(version)}-win-x64\\.exe$`, 'u');
  const entries = await readdir(RELEASE_DIR, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile() && expected.test(entry.name))
    .map((entry) => path.join(RELEASE_DIR, entry.name));
  if (candidates.length !== 1) {
    throw new Error(`Expected exactly one ${PRODUCT_NAME}-${version}-win-x64.exe under ${RELEASE_DIR}; found ${candidates.length}. Pass --installer explicitly to override.`);
  }
  return candidates[0];
}

async function validatePackagedContents(installerRoot, sourcePackage, sourceCommit, requireCleanSource) {
  const requiredFiles = [
    `${PRODUCT_NAME}.exe`,
    'resources/app.asar',
    'resources/uclaw-build.json',
    'resources/app.asar.unpacked/node_modules/sharp/package.json',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
    'resources/bin/node.exe',
    'resources/bin/uv.exe',
    'resources/bin/agent-browser.exe',
    'resources/bin/ffmpeg.exe',
    'resources/bin/ffprobe.exe',
    'resources/bin/ffmpeg-runtime.json',
    'resources/cli/openclaw.cmd',
    'resources/openclaw/openclaw.mjs',
    'resources/openclaw/package.json',
    'resources/openclaw-plugins/uclaw-task-bridge/package.json',
    'resources/openclaw-plugins/uclaw-video-project/package.json',
  ];
  const missing = [];
  for (const relativePath of requiredFiles) {
    if (!(await fileExists(path.join(installerRoot, relativePath)))) missing.push(relativePath);
  }
  if (missing.length > 0) throw new Error(`Installed NSIS tree is incomplete: ${missing.join(', ')}`);
  if (await fileExists(path.join(installerRoot, 'portable.flag')) || await fileExists(path.join(installerRoot, 'UClawData'))) {
    throw new Error('NSIS install tree contains USB portable markers.');
  }
  if (await peMachine(path.join(installerRoot, `${PRODUCT_NAME}.exe`)) !== '0x8664') {
    throw new Error('Installed UClaw.exe is not win32/x64.');
  }
  const identity = JSON.parse(await readFile(path.join(installerRoot, 'resources', 'uclaw-build.json'), 'utf8'));
  const asarPackage = JSON.parse(extractFile(path.join(installerRoot, 'resources', 'app.asar'), 'package.json').toString('utf8'));
  if (identity.appVersion !== sourcePackage.version || asarPackage.version !== sourcePackage.version) {
    throw new Error(`Installed version mismatch: source=${sourcePackage.version}, identity=${identity.appVersion}, asar=${asarPackage.version}`);
  }
  if (identity.platform !== 'win32' || identity.arch !== 'x64') {
    throw new Error(`Installed build identity is not win32/x64: ${identity.platform}/${identity.arch}`);
  }
  if (requireCleanSource && identity.sourceTreeState !== 'clean') {
    throw new Error(`Packaged source tree was not clean: ${identity.sourceTreeState}`);
  }
  if (sourceCommit && String(identity.gitCommit).toLowerCase() !== sourceCommit.toLowerCase()) {
    throw new Error(`Installed commit mismatch: source=${sourceCommit}, package=${identity.gitCommit}`);
  }
  const uninstallerEntries = (await readdir(installerRoot, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^Uninstall .*\.exe$/iu.test(entry.name));
  if (uninstallerEntries.length !== 1) {
    throw new Error(`Expected one installed uninstaller, found ${uninstallerEntries.length}.`);
  }
  return { identity, asarPackage, uninstallerPath: path.join(installerRoot, uninstallerEntries[0].name) };
}

async function findMetadataFiles(installerPath) {
  const entries = await readdir(RELEASE_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && /^latest.*\.yml$/iu.test(entry.name))
    .map((entry) => path.join(RELEASE_DIR, entry.name));
}

function assertMetadataRecord(record, label, fileName, actualSize, actualSha512) {
  if (!record || typeof record !== 'object') throw new Error(`${label} is not an object.`);
  const recordName = urlBasename(record.url ?? record.path ?? '');
  if (recordName !== fileName) throw new Error(`${label} points to ${recordName || '(empty)'}, expected ${fileName}.`);
  if (record.sha512 !== actualSha512) throw new Error(`${label} SHA-512 does not match ${fileName}.`);
  if (record.size !== undefined && Number(record.size) !== actualSize) {
    throw new Error(`${label} size does not match ${fileName}: metadata=${record.size}, actual=${actualSize}.`);
  }
}

function resolveAppBuilderBinary() {
  const candidate = path.join(ROOT, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
  return candidate;
}

async function validateBlockmap(installerPath, blockmapPath, reportDir) {
  const appBuilder = resolveAppBuilderBinary();
  if (!(await fileExists(appBuilder))) throw new Error(`app-builder.exe is missing; cannot verify ${path.basename(blockmapPath)}.`);
  const generated = path.join(reportDir, `${path.basename(blockmapPath)}.regenerated`);
  const result = runSync(appBuilder, ['blockmap', '--input', installerPath, '--output', generated], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || !(await fileExists(generated))) {
    throw new Error(`Failed to regenerate the NSIS block map: ${redact(result.stderr || result.stdout || 'unknown error')}`);
  }
  const expectedHash = await sha512(blockmapPath);
  const generatedHash = await sha512(generated);
  if (expectedHash !== generatedHash) {
    throw new Error('The NSIS block map does not describe the final installer. Regenerate it after code signing.');
  }
  return { blockmap: path.basename(blockmapPath), sha512: expectedHash };
}

async function validateUpdateMetadata(installerPath, version, options, reportDir) {
  const installerName = path.basename(installerPath);
  const installerStat = await stat(installerPath);
  const installerSha512 = await sha512(installerPath, 'base64');
  const metadataFiles = await findMetadataFiles(installerPath);
  if (metadataFiles.length === 0) {
    if (options.requireUpdateMetadata) throw new Error('No latest*.yml was produced for the Windows installer.');
    return { status: 'not-present', installerSha512, installerSize: installerStat.size, metadata: [] };
  }
  const metadata = [];
  let matchedInstaller = false;
  for (const metadataPath of metadataFiles) {
    const parsed = parseYaml(await readFile(metadataPath, 'utf8'));
    if (parsed?.version && String(parsed.version) !== version) {
      throw new Error(`${path.basename(metadataPath)} version is ${parsed.version}, expected ${version}.`);
    }
    const matches = [];
    if (urlBasename(parsed?.path ?? '') === installerName) matches.push({ record: parsed, label: 'top-level' });
    if (Array.isArray(parsed?.files)) {
      for (const [index, record] of parsed.files.entries()) {
        if (urlBasename(record?.url ?? '') === installerName) matches.push({ record, label: `files[${index}]` });
      }
    }
    if (matches.length > 0) {
      matchedInstaller = true;
      for (const match of matches) assertMetadataRecord(match.record, `${path.basename(metadataPath)} ${match.label}`, installerName, installerStat.size, installerSha512);
    }
    const blockmapRecords = Array.isArray(parsed?.files)
      ? parsed.files.filter((record) => /\.blockmap$/iu.test(urlBasename(record?.url ?? '')))
      : [];
    for (const record of blockmapRecords) {
      const blockmapName = urlBasename(record.url);
      const blockmapPath = path.join(RELEASE_DIR, blockmapName);
      if (!(await fileExists(blockmapPath))) throw new Error(`${path.basename(metadataPath)} references missing ${blockmapName}.`);
      const blockmapStat = await stat(blockmapPath);
      const blockmapSha512 = await sha512(blockmapPath, 'base64');
      assertMetadataRecord(record, `${path.basename(metadataPath)} blockmap`, blockmapName, blockmapStat.size, blockmapSha512);
      await validateBlockmap(installerPath, blockmapPath, reportDir);
    }
    metadata.push({ file: path.basename(metadataPath), installerMatched: matches.length > 0, blockmaps: blockmapRecords.map((record) => urlBasename(record.url)) });
  }
  if (!matchedInstaller && options.requireUpdateMetadata) {
    throw new Error(`No latest*.yml entry points to ${installerName}.`);
  }
  const expectedBlockmap = `${installerName}.blockmap`;
  if (options.requireBlockmap) {
    const blockmapPath = path.join(RELEASE_DIR, expectedBlockmap);
    if (!(await fileExists(blockmapPath))) throw new Error(`Required NSIS block map is missing: ${expectedBlockmap}.`);
    await validateBlockmap(installerPath, blockmapPath, reportDir);
  }
  return { status: 'validated', installerSha512, installerSize: installerStat.size, metadata };
}

async function snapshotShortcuts() {
  const userProfile = process.env.USERPROFILE || os.homedir();
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const candidates = [
    path.join(userProfile, 'Desktop', `${PRODUCT_NAME}.lnk`),
    path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`),
  ];
  const snapshots = [];
  for (const filePath of candidates) {
    snapshots.push({ filePath, content: await fileExists(filePath) ? await readFile(filePath) : null });
  }
  return snapshots;
}

async function restoreShortcuts(snapshots) {
  for (const snapshot of snapshots) {
    if (snapshot.content) {
      await mkdir(path.dirname(snapshot.filePath), { recursive: true });
      await writeFile(snapshot.filePath, snapshot.content);
    } else {
      await rm(snapshot.filePath, { force: true });
    }
  }
}

async function removeSandbox(sandboxRoot) {
  const safeRoot = safeTempChild(sandboxRoot);
  if (process.platform === 'win32') {
    runSync('attrib.exe', ['-R', '-S', '-H', '/S', '/D', `${safeRoot}\\*`]);
  }
  await rm(safeRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 1_000 });
}

async function listDirectory(rootDir) {
  try {
    return (await readdir(rootDir, { withFileTypes: true })).map((entry) => entry.name).slice(0, 40);
  } catch {
    return [];
  }
}

async function waitForProgramRemoval(installRoot, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  const markers = [
    path.join(installRoot, `${PRODUCT_NAME}.exe`),
    path.join(installRoot, 'resources', 'app.asar'),
    path.join(installRoot, `Uninstall ${PRODUCT_NAME}.exe`),
  ];
  while (Date.now() < deadline) {
    if (!(await Promise.all(markers.map((marker) => fileExists(marker))).then((values) => values.some(Boolean)))) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('NSIS uninstaller returned, but its asynchronous cleanup did not remove the program files.');
}

function sourceCommit() {
  try {
    const result = runSync('git', ['rev-parse', 'HEAD']);
    if (result.status === 0 && /^[0-9a-f]{40}$/iu.test(result.stdout.trim())) return result.stdout.trim();
  } catch {
    // A downloaded artifact may be validated outside a Git checkout.
  }
  return '';
}

async function main() {
  if (process.platform !== 'win32') throw new Error('NSIS release validation must run on Windows.');
  const options = parseArgs(process.argv.slice(2));
  await assertNoActiveUclawProcesses();
  const sourcePackage = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const installerPath = await resolveInstaller(options, sourcePackage.version);
  const installerStat = await stat(installerPath);
  if (installerStat.size < 1024 * 1024) throw new Error(`Installer is unexpectedly small: ${installerStat.size} bytes.`);
  const installerMachine = await peMachine(installerPath);
  // NSIS uses a 32-bit bootstrap stub even when the embedded application is
  // x64. The installed UClaw.exe is the authoritative payload architecture.
  if (!new Set(['0x14c', '0x8664']).has(installerMachine)) {
    throw new Error(`NSIS installer has an unsupported PE machine: ${installerMachine}.`);
  }
  const runId = `${sourcePackage.version}-${new Date().toISOString().replace(/[:.]/gu, '')}`;
  const reportDir = path.resolve(options.reportDir || path.join(RELEASE_DIR, 'regression', `nsis-${runId}`));
  await mkdir(reportDir, { recursive: true });
  const sandboxRoot = safeTempChild(path.join(os.tmpdir(), `UClaw NSIS Validation ${runId}`));
  const installRoot = path.join(sandboxRoot, 'install');
  await rm(sandboxRoot, { recursive: true, force: true });
  await mkdir(sandboxRoot, { recursive: true });
  const checks = [];
  let session = null;
  let installResult = null;
  let upgradeResult = null;
  let uninstallResult = null;
  let installedInfo = null;
  let uninstallEnv = process.env;
  let failure = null;
  const shortcuts = await snapshotShortcuts();

  const step = async (id, title, fn) => {
    const startedAt = Date.now();
    try {
      const details = await fn();
      checks.push({ id, title, status: 'passed', durationMs: Date.now() - startedAt, details: details ?? null });
      return details;
    } catch (error) {
      const message = redact(error instanceof Error ? error.stack || error.message : error);
      checks.push({ id, title, status: 'failed', durationMs: Date.now() - startedAt, error: message });
      throw error;
    }
  };

  try {
    await step('installer.artifact', 'Validate the final NSIS installer artifact', async () => ({
      file: installerPath,
      size: installerStat.size,
      sha512: await sha512(installerPath),
      machine: installerMachine,
    }));
    await step('installer.metadata', 'Validate update metadata and block map', async () => await validateUpdateMetadata(installerPath, sourcePackage.version, options, reportDir));
    installResult = await step('installer.install', 'Install silently into an isolated directory', async () => {
      const result = await runNsisInstaller(installerPath, ['/S', `/D=${installRoot}`], isolatedEnvironment(), installRoot);
      await writeFile(path.join(reportDir, 'installer-output.log'), redact(`${result.stdout}\n${result.stderr}`), 'utf8');
      return { exitCode: result.code, detachedBootstrap: result.detachedBootstrap, installRoot };
    });
    installedInfo = await step('installer.contents', 'Validate installed files and build identity', async () => await validatePackagedContents(installRoot, sourcePackage, sourceCommit(), options.requireCleanSource));
    await step('installer.startup', 'Start the installed executable and reach Gateway running', async () => {
      const gatewayPort = await allocatePort();
      const hostApiPort = await allocatePort();
      const launched = await launchInstalledApp(installRoot, sandboxRoot, gatewayPort, hostApiPort);
      session = launched;
      uninstallEnv = launched.env;
      return { gatewayPort, hostApiPort, status: launched.status };
    });
    await writeFile(path.join(reportDir, 'startup-output.log'), redact(session.output.join('')), 'utf8');
    await closeInstalledApp(session, installRoot);
    session = null;
    const userDataPath = path.join(sandboxRoot, 'profile', 'AppData', 'Roaming', PRODUCT_NAME, 'settings.json');
    const upgradeSentinelPath = path.join(sandboxRoot, 'profile', 'AppData', 'Roaming', PRODUCT_NAME, 'nsis-upgrade-sentinel.txt');
    await writeFile(upgradeSentinelPath, 'preserve-through-overwrite-upgrade\n', 'utf8');
    upgradeResult = await step('installer.overwrite-upgrade', 'Overwrite an existing installation and preserve user data', async () => {
      const result = await runNsisInstaller(installerPath, ['/S', `/D=${installRoot}`], uninstallEnv, installRoot);
      await writeFile(path.join(reportDir, 'upgrade-installer-output.log'), redact(`${result.stdout}\n${result.stderr}`), 'utf8');
      const upgradedInfo = await validatePackagedContents(installRoot, sourcePackage, sourceCommit(), options.requireCleanSource);
      if (!(await fileExists(upgradeSentinelPath))) throw new Error('User data sentinel disappeared during overwrite install.');
      installedInfo = upgradedInfo;
      return { exitCode: result.code, detachedBootstrap: result.detachedBootstrap, userDataPreserved: true };
    });
    uninstallResult = await step('installer.uninstall', 'Uninstall silently and verify cleanup boundaries', async () => {
      const result = await runProcess(installedInfo.uninstallerPath, ['/S', '/KEEP_APP_DATA'], {
        timeoutMs: UNINSTALL_TIMEOUT_MS,
        env: uninstallEnv,
      });
      await writeFile(path.join(reportDir, 'uninstaller-output.log'), redact(`${result.stdout}\n${result.stderr}`), 'utf8');
      if (result.timedOut || result.code !== 0) throw new Error(`Uninstaller exited with code ${result.code}${result.timedOut ? ' after timeout' : ''}.`);
      await waitForProgramRemoval(installRoot);
      const residual = await listDirectory(installRoot);
      if (await fileExists(path.join(installRoot, `${PRODUCT_NAME}.exe`)) || await fileExists(path.join(installRoot, 'resources', 'app.asar'))) {
        throw new Error(`Installed program files remain after uninstall: ${residual.join(', ')}`);
      }
      if (await hasProcessesUnder(installRoot)) throw new Error('A process from the install directory remains after uninstall.');
      if (!(await fileExists(userDataPath))) throw new Error('User data was deleted even though deleteAppDataOnUninstall=false.');
      if (!(await fileExists(upgradeSentinelPath))) throw new Error('User data sentinel was deleted during uninstall.');
      return { exitCode: result.code, residual, userDataRetained: true };
    });
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    const startupOutput = failure.startupOutput || session?.output?.join('') || '';
    if (startupOutput) await writeFile(path.join(reportDir, 'startup-output.log'), redact(startupOutput), 'utf8').catch(() => undefined);
  } finally {
    await closeInstalledApp(session, installRoot).catch(() => undefined);
    await restoreShortcuts(shortcuts).catch(() => undefined);
    const report = {
      schemaVersion: 1,
      packageType: 'nsis_installer',
      status: failure ? 'failed' : 'passed',
      installer: {
        file: installerPath,
        name: path.basename(installerPath),
        size: installerStat.size,
        sha512: await sha512(installerPath).catch(() => null),
        version: sourcePackage.version,
      },
      checks,
      install: installResult ? { exitCode: installResult.exitCode } : null,
      overwriteUpgrade: upgradeResult ? { exitCode: upgradeResult.exitCode } : null,
      uninstall: uninstallResult ? { exitCode: uninstallResult.exitCode } : null,
      failure: failure ? redact(failure.stack || failure.message) : null,
      sandbox: options.keep || failure ? sandboxRoot : null,
      finishedAt: new Date().toISOString(),
    };
    await writeFile(path.join(reportDir, 'nsis-release-validation.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    const passed = checks.filter((check) => check.status === 'passed').length;
    const failed = checks.filter((check) => check.status === 'failed').length;
    const markdown = [
      `# UClaw NSIS 发布门禁报告`,
      '',
      `- 结果：${failure ? '失败' : '通过'}`,
      `- 安装包：${path.basename(installerPath)}`,
      `- 版本：${sourcePackage.version}`,
      `- SHA-512（hex）：${report.installer.sha512 || '[unavailable]'}`,
      `- 通过：${passed}`,
      `- 失败：${failed}`,
      '',
      '## 检查项',
      ...checks.map((check) => `- [${check.status === 'passed' ? 'x' : ' '}] ${check.title} (${check.id})`),
      '',
      failure ? `## 阻断原因\n\n${redact(failure.stack || failure.message)}` : '## 结论\n\n最终 NSIS 安装包已完成构建、元数据、安装、启动和卸载验证。',
      '',
    ];
    await writeFile(path.join(reportDir, 'nsis-release-validation.zh-CN.md'), `${markdown.join('\n')}\n`, 'utf8');
    if (!options.keep && !failure) {
      try {
        await removeSandbox(sandboxRoot);
      } catch (error) {
        console.warn(`[nsis-validation] Cleanup warning: ${redact(error instanceof Error ? error.message : error)}`);
        console.log(`[nsis-validation] Sandbox kept: ${sandboxRoot}`);
      }
    } else console.log(`[nsis-validation] Sandbox kept: ${sandboxRoot}`);
  }
  if (failure) throw failure;
  console.log(`[nsis-validation] PASS: ${reportDir}`);
}

main().catch((error) => {
  console.error(`[nsis-validation] FAIL: ${redact(error instanceof Error ? error.stack || error.message : error)}`);
  process.exit(1);
});
