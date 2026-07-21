#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import YAML from 'yaml';
import { assertBlockmapMatchesInstaller } from '../refresh-signed-windows-update-metadata.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PACKAGE_JSON = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const TARGET_VERSION = PACKAGE_JSON.version;
const PROFILE_MARKER_DIR = 'uclaw-upgrade-matrix';
const PROCESS_TIMEOUT_MS = 15 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const DOWNLOAD_ATTEMPTS = 3;

const PUBLIC_INSTALLERS = [
  installerSource('0.3.2'),
  installerSource('0.4.6'),
  installerSource('0.4.8'),
  installerSource('0.5.0'),
  installerSource('0.7.1', {
    repository: '401825317/ClawX',
    productName: 'UClaw',
  }),
];

const OPTIONAL_INSTALLERS = [
  optionalInstallerSource(
    '1.0.1',
    'UCLAW_UPGRADE_INSTALLER_101_URL',
    'UCLAW_UPGRADE_INSTALLER_101_SHA512',
  ),
];

const PUBLIC_PORTABLES = [
  portableSource('0.7.1'),
  portableSource('1.0.1'),
];

function installerSource(version, options = {}) {
  const repository = options.repository || 'ValueCell-ai/ClawX';
  const productName = options.productName || 'ClawX';
  const fileName = `${productName}-${version}-win-x64.exe`;
  const base = `https://github.com/${repository}/releases/download/v${version}`;
  return {
    version,
    productName,
    fileName,
    url: `${base}/${fileName}`,
    manifestUrl: `${base}/latest.yml`,
    required: true,
  };
}

function optionalInstallerSource(version, urlEnvName, sha512EnvName) {
  const url = process.env[urlEnvName]?.trim() || '';
  return {
    version,
    productName: 'UClaw',
    fileName: `UClaw-${version}-win-x64.exe`,
    url,
    manifestUrl: '',
    expectedSha512: process.env[sha512EnvName]?.trim().toLowerCase() || '',
    required: false,
    urlEnvName,
    sha512EnvName,
  };
}

function portableSource(version) {
  const fileName = `UClaw-${version}-win-x64-usb.zip`;
  const base = 'https://uclaw-ver.oss-cn-beijing.aliyuncs.com/releases/latest';
  return {
    version,
    fileName,
    url: `${base}/${fileName}`,
    metadataUrl: `${base}/${fileName.replace(/\.zip$/u, '.json')}`,
  };
}

// v0.7.1 is the first installed customer release whose real updater path is exercised.
function installedScenarioKind(version) {
  return version === '0.7.1'
    ? 'installed-electron-updater'
    : 'installed-nsis-overwrite';
}

function parseArgs(argv) {
  const options = {
    mode: 'all',
    targetInstaller: '',
    targetZip: '',
    keep: false,
    skipRollback: false,
    requireCompleteInstallers: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--':
        break;
      case '--mode':
        options.mode = readValue();
        break;
      case '--target-installer':
        options.targetInstaller = readValue();
        break;
      case '--target-zip':
        options.targetZip = readValue();
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--skip-rollback':
        options.skipRollback = true;
        break;
      case '--require-complete-installers':
        options.requireCompleteInstallers = true;
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
  if (!['all', 'installed', 'portable'].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  return options;
}

function printHelp() {
  console.log(`UClaw Windows cross-version upgrade matrix

Usage:
  node scripts/windows-support/run-upgrade-matrix.mjs [options]

Options:
  --mode all|installed|portable       Select the upgrade paths to execute.
  --target-installer <path>           Target NSIS installer; defaults to release/UClaw-<version>-win-x64.exe.
  --target-zip <path>                 Target USB ZIP; defaults to release/UClaw-<version>-win-x64-usb.zip.
  --require-complete-installers       Require the optional v1.0.1 customer installer.
  --skip-rollback                     Skip the 90-second current-helper startup rollback scenario.
  --keep                              Keep isolated sandboxes after successful scenarios.

Optional historical installer environment variables:
  UCLAW_UPGRADE_INSTALLER_101_URL
  UCLAW_UPGRADE_INSTALLER_101_SHA512  (128-character lowercase or uppercase hex)

This script mutates isolated markers under the current Windows test profile.
Run on GitHub Actions or set UCLAW_UPGRADE_ALLOW_PROFILE_MUTATION=1 explicitly.
`);
}

function assertExecutionEnvironment() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`Windows upgrade matrix requires win32/x64, got ${process.platform}/${process.arch}`);
  }
  if (process.env.GITHUB_ACTIONS !== 'true'
    && process.env.UCLAW_UPGRADE_ALLOW_PROFILE_MUTATION !== '1') {
    throw new Error(
      'Refusing to create upgrade markers in the Windows profile. Use an isolated runner or set UCLAW_UPGRADE_ALLOW_PROFILE_MUTATION=1.',
    );
  }
}

function sanitizedUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[invalid-url]';
  }
}

function redact(value) {
  return String(value)
    .replace(/https?:\/\/[^\s"'<>]+/giu, (url) => sanitizedUrl(url))
    .replace(/([?&](?:token|signature|sig|key)=)[^&\s]+/giu, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]');
}

function assertSafeTempChild(targetPath) {
  const tempRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(targetPath);
  const relative = path.relative(tempRoot, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing unsafe temporary path: ${resolved}`);
  }
  return resolved;
}

async function sha512(filePath, encoding = 'hex') {
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest(encoding);
}

async function assertPortableMetadata(zipPath, metadata) {
  const zipStat = await stat(zipPath);
  const actualHash = await sha512(zipPath);
  const fileName = path.basename(zipPath);
  const mismatches = [];
  if (metadata.version !== undefined && String(metadata.version) === '') mismatches.push('version');
  if ((metadata.fileName || metadata.file_name) !== fileName) mismatches.push('fileName');
  if (Number(metadata.size) !== zipStat.size) mismatches.push('size');
  if (String(metadata.sha512 || '').toLowerCase() !== actualHash) mismatches.push('sha512');
  if (metadata.packageType !== 'portable_zip' && metadata.package_type !== 'portable_zip') {
    mismatches.push('packageType');
  }
  if (mismatches.length > 0) {
    throw new Error(`Portable metadata mismatch for ${fileName}: ${mismatches.join(', ')}`);
  }
  return { size: zipStat.size, sha512: actualHash };
}

async function downloadFile(url, destination) {
  if (existsSync(destination) && (await stat(destination)).size > 0) return destination;
  await mkdir(path.dirname(destination), { recursive: true });
  const partialPath = `${destination}.download`;
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    await rm(partialPath, { force: true });
    console.log(
      `[upgrade-matrix] Downloading ${sanitizedUrl(url)} -> ${path.basename(destination)} `
      + `(attempt ${attempt}/${DOWNLOAD_ATTEMPTS})`,
    );
    try {
      const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status}`);
      }
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partialPath, { mode: 0o600 }),
      );
      await rename(partialPath, destination);
      return destination;
    } catch (error) {
      lastError = error;
      await rm(partialPath, { force: true });
      if (attempt < DOWNLOAD_ATTEMPTS) await delay(attempt * 1_000);
    }
  }
  throw new Error(
    `Download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${sanitizedUrl(url)}: `
    + redact(lastError instanceof Error ? lastError.message : lastError),
  );
}

async function assertPeFile(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const header = Buffer.alloc(2);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead !== 2 || header.toString('ascii') !== 'MZ') {
      throw new Error(`Not a Windows executable: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function runProcess(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const output = [];
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out: ${path.basename(command)}`));
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, signal, output: redact(output.join('')) });
    });
  });
}

async function extractZip(zipPath, destination) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  const tar = await runProcess('tar.exe', ['-xf', zipPath, '-C', destination]);
  if (tar.code === 0) return;
  const escapedZip = zipPath.replaceAll("'", "''");
  const escapedDestination = destination.replaceAll("'", "''");
  const powershell = await runProcess('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDestination}' -Force`,
  ]);
  if (powershell.code !== 0) {
    throw new Error(`ZIP extraction failed: ${tar.output || powershell.output}`);
  }
}

async function findNewestArtifact(pattern, explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!existsSync(resolved)) throw new Error(`Artifact not found: ${resolved}`);
    return resolved;
  }
  const candidates = [];
  for (const entry of await readdir(RELEASE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const filePath = path.join(RELEASE_DIR, entry.name);
    candidates.push({ filePath, modifiedMs: (await stat(filePath)).mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (!candidates[0]) throw new Error(`No matching artifact found under ${RELEASE_DIR}`);
  return candidates[0].filePath;
}

function scenarioEnvironment(profileRoot) {
  const roaming = path.join(profileRoot, 'AppData', 'Roaming');
  const local = path.join(profileRoot, 'AppData', 'Local');
  const temp = path.join(profileRoot, 'Temp');
  return {
    ...process.env,
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    TEMP: temp,
    TMP: temp,
    CLAWX_MANAGED_PROVIDER: '0',
    OPENCLAW_DISABLE_UPDATE_CHECK: '1',
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

async function allocatePort() {
  return await new Promise((resolve, reject) => {
    const server = createNetServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else if (port > 0) resolve(port);
        else reject(new Error('Failed to allocate an isolated runtime port'));
      });
    });
  });
}

async function probeRuntimeReadiness(hostApiPort, gatewayPort) {
  const [hostResponse, gatewayResponse] = await Promise.all([
    fetch(`http://127.0.0.1:${hostApiPort}/api/gateway/status`, {
      signal: AbortSignal.timeout(2_000),
    }),
    fetch(`http://127.0.0.1:${gatewayPort}/health`, {
      signal: AbortSignal.timeout(2_000),
    }),
  ]);
  const hostStatus = hostResponse.ok ? await hostResponse.json() : null;
  const gatewayHealth = gatewayResponse.ok ? await gatewayResponse.json() : null;
  const hostReady = hostResponse.status === 401
    || (hostStatus?.state === 'running' && hostStatus?.gatewayReady !== false);
  if (!hostReady || gatewayHealth?.ok !== true) {
    throw new Error(
      `host=${hostResponse.status}/${JSON.stringify(hostStatus)} gateway=${gatewayResponse.status}/${JSON.stringify(gatewayHealth)}`,
    );
  }
  return { hostStatus, hostStatusCode: hostResponse.status, gatewayHealth };
}

async function stopProcessTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  await runProcess('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
    timeoutMs: 60_000,
  }).catch(() => undefined);
}

async function waitForTargetRuntime(child, hostApiPort, gatewayPort, output, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Target application exited before runtime readiness (exit=${child.exitCode}): ${redact(output.join('').slice(-4_000))}`,
      );
    }
    try {
      return await probeRuntimeReadiness(hostApiPort, gatewayPort);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`Target runtime readiness timed out: ${lastError}`);
}

async function runTargetRuntimeSmoke(appRoot, profileRoot, options = {}) {
  const executablePath = path.join(appRoot, 'UClaw.exe');
  if (!existsSync(executablePath)) throw new Error(`Target executable missing: ${executablePath}`);
  await ensureScenarioProfile(profileRoot);
  const [hostApiPort, gatewayPort] = await Promise.all([allocatePort(), allocatePort()]);
  const env = {
    ...scenarioEnvironment(profileRoot),
    CLAWX_PORT_CLAWX_HOST_API: String(hostApiPort),
    CLAWX_PORT_OPENCLAW_GATEWAY: String(gatewayPort),
    CLAWX_RUNTIME_CACHE_ROOT: path.join(profileRoot, 'AppData', 'Local', 'UClawRuntime'),
    ...(options.portableRoot ? { CLAWX_PORTABLE_ROOT: options.portableRoot } : {}),
  };
  const output = [];
  const startedAt = Date.now();
  const child = spawn(executablePath, [], {
    cwd: appRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  try {
    const ready = await waitForTargetRuntime(child, hostApiPort, gatewayPort, output);
    return {
      startupMs: Date.now() - startedAt,
      hostApiPort,
      gatewayPort,
      hostApiStatus: ready.hostStatusCode,
      gatewayState: ready.hostStatus?.state || 'running',
      gatewayReady: ready.gatewayHealth.ok,
    };
  } finally {
    await stopProcessTree(child);
  }
}

async function createPortableRuntimeProbe(profileRoot, appRoot) {
  await ensureScenarioProfile(profileRoot);
  const [hostApiPort, gatewayPort] = await Promise.all([allocatePort(), allocatePort()]);
  return {
    hostApiPort,
    gatewayPort,
    env: {
      ...scenarioEnvironment(profileRoot),
      CLAWX_PORT_CLAWX_HOST_API: String(hostApiPort),
      CLAWX_PORT_OPENCLAW_GATEWAY: String(gatewayPort),
      CLAWX_RUNTIME_CACHE_ROOT: path.join(profileRoot, 'AppData', 'Local', 'UClawRuntime'),
      CLAWX_PORTABLE_ROOT: appRoot,
    },
  };
}

async function waitForExistingRuntime(probe, startedAt, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const ready = await probeRuntimeReadiness(probe.hostApiPort, probe.gatewayPort);
      return {
        startupMs: Date.now() - startedAt,
        hostApiPort: probe.hostApiPort,
        gatewayPort: probe.gatewayPort,
        hostApiStatus: ready.hostStatusCode,
        gatewayState: ready.hostStatus?.state || 'running',
        gatewayReady: ready.gatewayHealth.ok,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`Helper-launched runtime readiness timed out: ${lastError}`);
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function serveUpdateArtifact(request, response, filePath, contentType, counters) {
  const fileStat = await stat(filePath);
  const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/u);
  let start = 0;
  let end = fileStat.size - 1;
  let status = 200;
  if (range) {
    start = Number(range[1]);
    end = range[2] ? Number(range[2]) : end;
    if (!Number.isSafeInteger(start)
      || !Number.isSafeInteger(end)
      || start < 0
      || end < start
      || end >= fileStat.size) {
      response.writeHead(416, { 'content-range': `bytes */${fileStat.size}` });
      response.end();
      return;
    }
    status = 206;
    counters.rangeRequests += 1;
  }
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'content-length': String(end - start + 1),
    'content-type': contentType,
  };
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${fileStat.size}`;
  response.writeHead(status, headers);
  if (request.method === 'HEAD') {
    response.end();
    return;
  }
  createReadStream(filePath, { start, end }).pipe(response);
}

async function startInstalledUpdateServer(targetInstaller) {
  const installerName = path.basename(targetInstaller.installerPath);
  const blockmapName = path.basename(targetInstaller.blockmapPath);
  const counters = {
    manifestRequests: 0,
    installerRequests: 0,
    blockmapRequests: 0,
    rangeRequests: 0,
  };
  const server = createHttpServer((request, response) => {
    void (async () => {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      if (requestUrl.pathname === '/feed/latest/latest.yml') {
        counters.manifestRequests += 1;
        await serveUpdateArtifact(
          request,
          response,
          targetInstaller.manifestPath,
          'application/yaml',
          counters,
        );
        return;
      }
      if (requestUrl.pathname === `/feed/latest/${installerName}`) {
        counters.installerRequests += 1;
        await serveUpdateArtifact(
          request,
          response,
          targetInstaller.installerPath,
          'application/octet-stream',
          counters,
        );
        return;
      }
      if (requestUrl.pathname === `/feed/latest/${blockmapName}`) {
        counters.blockmapRequests += 1;
        await serveUpdateArtifact(
          request,
          response,
          targetInstaller.blockmapPath,
          'application/octet-stream',
          counters,
        );
        return;
      }
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    })().catch((error) => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (typeof address === 'object' && address?.port) resolve(address.port);
      else reject(new Error('Failed to bind the isolated update server'));
    });
  });
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    counters,
  };
}

async function waitForCdp(child, cdpPort, output, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Updater source application exited before CDP readiness (exit=${child.exitCode}): ${redact(output.join('').slice(-4_000))}`,
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(500);
  }
  throw new Error(`Updater source CDP readiness timed out: ${lastError}`);
}

async function waitForUpdatedInstalledRuntime(
  appRoot,
  hostApiPort,
  gatewayPort,
  timeoutMs = 8 * 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const identity = await readBuildIdentity(appRoot);
      assertTargetBuildIdentity(identity, 'electron-updater installed target');
      const ready = await probeRuntimeReadiness(hostApiPort, gatewayPort);
      return {
        targetBuildId: identity.buildId,
        hostApiStatus: ready.hostStatusCode,
        gatewayState: ready.hostStatus?.state || 'running',
        gatewayReady: ready.gatewayHealth.ok,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(1_000);
  }
  throw new Error(`electron-updater did not install and restart the target runtime: ${lastError}`);
}

async function runInstalledElectronUpdater(source, targetInstaller, installDir, profileRoot) {
  const updateServer = await startInstalledUpdateServer(targetInstaller);
  const [hostApiPort, gatewayPort, cdpPort] = await Promise.all([
    allocatePort(),
    allocatePort(),
    allocatePort(),
  ]);
  const executablePath = path.join(installDir, 'UClaw.exe');
  const env = {
    ...scenarioEnvironment(profileRoot),
    CLAWX_PORT_CLAWX_HOST_API: String(hostApiPort),
    CLAWX_PORT_OPENCLAW_GATEWAY: String(gatewayPort),
    CLAWX_REMOTE_DEBUGGING_PORT: String(cdpPort),
    CLAWX_RUNTIME_CACHE_ROOT: path.join(profileRoot, 'AppData', 'Local', 'UClawRuntime'),
    CLAWX_UPDATE_FEED_BASE_URL: `${updateServer.origin}/feed`,
    ELECTRON_ENABLE_LOGGING: '1',
  };
  const output = [];
  const startedAt = Date.now();
  const child = spawn(executablePath, [`--remote-debugging-port=${cdpPort}`], {
    cwd: installDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout?.on('data', (chunk) => output.push(String(chunk)));
  child.stderr?.on('data', (chunk) => output.push(String(chunk)));
  let browser = null;
  try {
    await waitForCdp(child, cdpPort, output);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 120_000 });
    const context = browser.contexts()[0];
    if (!context) throw new Error('Updater source exposed no browser context');
    const page = context.pages().filter((candidate) => !candidate.isClosed()).at(-1)
      || await context.waitForEvent('page', { timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded', { timeout: 60_000 });

    const check = await page.evaluate(async () => (
      await globalThis.electron.ipcRenderer.invoke('update:check')
    ));
    if (!check?.success
      || check.status?.status !== 'available'
      || check.status?.info?.version !== TARGET_VERSION) {
      throw new Error(`v${source.version} update check failed: ${JSON.stringify(check)}`);
    }

    const download = await page.evaluate(async () => (
      await globalThis.electron.ipcRenderer.invoke('update:download')
    ));
    if (!download?.success || download.status?.status !== 'downloaded') {
      throw new Error(`v${source.version} update download failed: ${JSON.stringify(download)}`);
    }

    await page.evaluate(() => {
      void globalThis.electron.ipcRenderer.invoke('update:install');
      return true;
    });
    const runtime = await waitForUpdatedInstalledRuntime(installDir, hostApiPort, gatewayPort);
    if (updateServer.counters.manifestRequests < 1 || updateServer.counters.installerRequests < 1) {
      throw new Error(`v${source.version} updater did not request the target manifest and installer`);
    }
    return {
      transport: 'electron-updater',
      durationMs: Date.now() - startedAt,
      sourceVersion: source.version,
      ...runtime,
      requests: updateServer.counters,
    };
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await stopProcessTree(child);
    await closeHttpServer(updateServer.server);
  }
}

async function ensureScenarioProfile(profileRoot) {
  for (const directory of [
    profileRoot,
    path.join(profileRoot, 'AppData', 'Roaming'),
    path.join(profileRoot, 'AppData', 'Local'),
    path.join(profileRoot, 'Temp'),
  ]) await mkdir(directory, { recursive: true });
}

async function seedInstalledMarkers(runId, version, profileRoot) {
  const marker = `${runId}:${version}`;
  // NSIS resolves Windows shell folders from the runner profile, not child-process env aliases.
  const markerPaths = [
    path.join(os.homedir(), '.openclaw', PROFILE_MARKER_DIR, `${runId}-${version}.txt`),
    path.join(process.env.APPDATA || '', 'clawx', PROFILE_MARKER_DIR, `${runId}-${version}.txt`),
    path.join(process.env.LOCALAPPDATA || '', 'clawx', PROFILE_MARKER_DIR, `${runId}-${version}.txt`),
    path.join(profileRoot, '.openclaw', PROFILE_MARKER_DIR, `${runId}-${version}.txt`),
    path.join(profileRoot, 'AppData', 'Roaming', 'clawx', PROFILE_MARKER_DIR, `${runId}-${version}.txt`),
    path.join(profileRoot, 'AppData', 'Local', 'clawx', PROFILE_MARKER_DIR, `${runId}-${version}.txt`),
  ];
  for (const markerPath of markerPaths) {
    if (!path.isAbsolute(markerPath)) throw new Error(`Cannot resolve installed marker path: ${markerPath}`);
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, marker, { encoding: 'utf8', mode: 0o600 });
  }
  return { marker, markerPaths };
}

async function verifyMarkers(markers) {
  for (const markerPath of markers.markerPaths) {
    const content = await readFile(markerPath, 'utf8');
    if (content !== markers.marker) throw new Error(`Upgrade marker changed: ${markerPath}`);
  }
}

async function cleanupMarkers(markers) {
  for (const markerPath of markers?.markerPaths ?? []) {
    await rm(markerPath, { force: true }).catch(() => undefined);
  }
}

async function stopExecutable(executablePath) {
  if (!existsSync(executablePath)) return;
  const escaped = path.resolve(executablePath).replaceAll("'", "''");
  await runProcess('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$target=[IO.Path]::GetFullPath('${escaped}'); Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath) -ieq $target } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
  ], { timeoutMs: 60_000 }).catch(() => undefined);
}

async function cleanupInstallerRegistry(installDir) {
  const escaped = path.resolve(installDir).replaceAll("'", "''");
  await runProcess('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$target=[IO.Path]::GetFullPath('${escaped}'); Get-ChildItem 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall' -ErrorAction SilentlyContinue | ForEach-Object { $item=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue; if ($item.InstallLocation -and [IO.Path]::GetFullPath($item.InstallLocation) -ieq $target) { Remove-Item $_.PSPath -Recurse -Force } }`,
  ], { timeoutMs: 60_000 }).catch(() => undefined);
}

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || '')).replace(/[\\/]+$/u, '').toLowerCase();
}

function shortcutTargetsInstallDir(shortcut, installDir) {
  const target = normalizeWindowsPath(shortcut.target);
  const root = normalizeWindowsPath(installDir);
  return target === root || target.startsWith(`${root}\\`);
}

async function inspectProductShortcuts() {
  // NSIS resolves shell folders from the Windows account rather than the
  // child-process HOME aliases, so query the authoritative shell locations.
  const command = [
    "$ErrorActionPreference='Stop'",
    '$shell=New-Object -ComObject WScript.Shell',
    "$roots=@([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'),[Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms')) | Where-Object { $_ } | Select-Object -Unique",
    "$names=@('ClawX.lnk','UClaw.lnk')",
    '$items=@()',
    'foreach($root in $roots){foreach($name in $names){$shortcutPath=Join-Path $root $name;if(Test-Path -LiteralPath $shortcutPath -PathType Leaf){$shortcut=$shell.CreateShortcut($shortcutPath);$items += [pscustomobject]@{path=$shortcutPath;target=$shortcut.TargetPath}}}}',
    '[Console]::Out.Write((ConvertTo-Json -InputObject @($items) -Compress))',
  ].join(';');
  const result = await runProcess('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ], { timeoutMs: 60_000 });
  if (result.code !== 0) {
    throw new Error(`Failed to inspect Windows shortcuts: ${result.output}`);
  }
  const raw = result.output.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  if (parsed === null) return [];
  return (Array.isArray(parsed) ? parsed : [parsed]).filter((item) => (
    item && typeof item.path === 'string' && typeof item.target === 'string'
  ));
}

function assertProductShortcut(shortcuts, shortcutName, executablePath, context) {
  const fileName = `${shortcutName}.lnk`.toLowerCase();
  const expectedTarget = normalizeWindowsPath(executablePath);
  const matches = shortcuts.filter((shortcut) => (
    path.win32.basename(shortcut.path || '').toLowerCase() === fileName
      && normalizeWindowsPath(shortcut.target) === expectedTarget
  ));
  if (matches.length === 0) {
    throw new Error(`${context} did not create a working ${shortcutName} shortcut`);
  }
  return matches.length;
}

function assertNoLegacyShortcut(shortcuts, installDir, context) {
  const leftovers = shortcuts.filter((shortcut) => (
    path.win32.basename(shortcut.path || '').toLowerCase() === 'clawx.lnk'
      && shortcutTargetsInstallDir(shortcut, installDir)
  ));
  if (leftovers.length > 0) {
    throw new Error(`${context} left obsolete ClawX shortcuts: ${leftovers.map((item) => item.path).join(', ')}`);
  }
}

function assertNoScenarioShortcuts(shortcuts, installDir, context) {
  const leftovers = shortcuts.filter((shortcut) => shortcutTargetsInstallDir(shortcut, installDir));
  if (leftovers.length > 0) {
    throw new Error(`${context} left shortcuts targeting the scenario install: ${leftovers.map((item) => item.path).join(', ')}`);
  }
}

async function cleanupScenarioShortcuts(installDir) {
  const shortcuts = await inspectProductShortcuts().catch(() => []);
  for (const shortcut of shortcuts) {
    if (shortcutTargetsInstallDir(shortcut, installDir)) {
      await rm(shortcut.path, { force: true }).catch(() => undefined);
    }
  }
}

async function readBuildIdentity(appRoot) {
  const identityPath = path.join(appRoot, 'resources', 'uclaw-build.json');
  if (!existsSync(identityPath)) return null;
  return JSON.parse(await readFile(identityPath, 'utf8'));
}

function assertTargetBuildIdentity(identity, context) {
  if (identity?.appVersion !== TARGET_VERSION
    || identity?.platform !== 'win32'
    || identity?.arch !== 'x64'
    || identity?.sourceTreeState !== 'clean') {
    throw new Error(`Target build identity mismatch: ${context}`);
  }
}

async function runNsisInstaller(installerPath, installDir, env) {
  await assertPeFile(installerPath);
  const result = await runProcess(installerPath, ['/S', `/D=${installDir}`], {
    cwd: path.dirname(installerPath),
    env,
  });
  if (result.code !== 0) {
    throw new Error(`NSIS installer exited ${result.code}: ${result.output}`);
  }
}

async function runNsisUninstaller(installDir, env) {
  const uninstallers = (await readdir(installDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^uninstall.*\.exe$/iu.test(entry.name))
    .map((entry) => path.join(installDir, entry.name));
  if (uninstallers.length !== 1) {
    throw new Error(`Expected one NSIS uninstaller under ${installDir}, found ${uninstallers.length}`);
  }
  const result = await runProcess(uninstallers[0], ['/S'], {
    cwd: installDir,
    env,
  });
  if (result.code !== 0) {
    throw new Error(`NSIS uninstaller exited ${result.code}: ${result.output}`);
  }
  return path.basename(uninstallers[0]);
}

async function prepareInstallerSource(source, cacheDir) {
  if (!source.url) return null;
  const installerPath = await downloadFile(source.url, path.join(cacheDir, source.fileName));
  await assertPeFile(installerPath);
  const installerStat = await stat(installerPath);
  if (source.sha512EnvName) {
    if (!/^[a-f0-9]{128}$/u.test(source.expectedSha512)) {
      throw new Error(`Missing or invalid SHA-512 in ${source.sha512EnvName} for ${source.version}`);
    }
    const actualHash = await sha512(installerPath);
    if (actualHash !== source.expectedSha512) {
      throw new Error(`Historical installer SHA-512 mismatch: ${source.version}`);
    }
    return {
      installerPath,
      manifest: null,
      integrity: { size: installerStat.size, sha512: actualHash, sha512Encoding: 'hex' },
    };
  }
  if (!source.manifestUrl) {
    throw new Error(`Historical installer integrity metadata missing: ${source.version}`);
  }

  const manifestPath = await downloadFile(
    source.manifestUrl,
    path.join(cacheDir, `${source.version}-latest.yml`),
  );
  const manifest = YAML.parse(await readFile(manifestPath, 'utf8'));
  const actualHash = await sha512(installerPath, 'base64');
  const file = manifest.files?.find((entry) => path.basename(entry.url) === source.fileName);
  if (manifest.version !== source.version
    || path.basename(manifest.path) !== source.fileName
    || !file
    || Number(file.size) !== installerStat.size
    || file.sha512 !== actualHash
    || manifest.sha512 !== actualHash) {
    throw new Error(`Historical installer manifest mismatch: ${source.version}`);
  }
  return {
    installerPath,
    manifest,
    integrity: { size: installerStat.size, sha512: actualHash, sha512Encoding: 'base64' },
  };
}

async function prepareTargetInstaller(installerPath) {
  await assertPeFile(installerPath);
  const manifestPath = path.join(path.dirname(installerPath), 'latest.yml');
  const blockmapPath = `${installerPath}.blockmap`;
  if (!existsSync(manifestPath)) throw new Error(`Target installer manifest missing: ${manifestPath}`);
  if (!existsSync(blockmapPath) || (await stat(blockmapPath)).size <= 0) {
    throw new Error(`Target installer blockmap missing or empty: ${blockmapPath}`);
  }
  await assertBlockmapMatchesInstaller(installerPath, blockmapPath);

  const manifest = YAML.parse(await readFile(manifestPath, 'utf8'));
  const installerStat = await stat(installerPath);
  const actualHash = await sha512(installerPath, 'base64');
  const fileName = path.basename(installerPath);
  const file = manifest.files?.find((entry) => path.basename(entry.url) === fileName);
  if (manifest.version !== TARGET_VERSION
    || path.basename(manifest.path) !== fileName
    || !file
    || Number(file.size) !== installerStat.size
    || file.sha512 !== actualHash
    || manifest.sha512 !== actualHash) {
    throw new Error('Target installer manifest mismatch');
  }
  return {
    installerPath,
    manifestPath,
    blockmapPath,
    evidence: {
      fileName,
      size: installerStat.size,
      sha512: actualHash,
      sha512Encoding: 'base64',
      manifestFileName: path.basename(manifestPath),
      blockmapFileName: path.basename(blockmapPath),
    },
  };
}

async function runCleanInstalledScenario(targetInstaller, sandboxRoot, runId, keep) {
  const startedAt = Date.now();
  const scenarioRoot = path.join(sandboxRoot, 'installed-clean');
  const profileRoot = path.join(scenarioRoot, 'profile');
  const installDir = path.join(scenarioRoot, 'app');
  const env = scenarioEnvironment(profileRoot);
  let markers = null;
  try {
    await ensureScenarioProfile(profileRoot);
    await runNsisInstaller(targetInstaller, installDir, env);
    await stopExecutable(path.join(installDir, 'UClaw.exe'));
    const identity = await readBuildIdentity(installDir);
    assertTargetBuildIdentity(identity, 'clean NSIS install');
    const installedShortcuts = await inspectProductShortcuts();
    const installedShortcutCount = assertProductShortcut(
      installedShortcuts,
      'UClaw',
      path.join(installDir, 'UClaw.exe'),
      'Clean NSIS install',
    );
    assertNoLegacyShortcut(installedShortcuts, installDir, 'Clean NSIS install');
    markers = await seedInstalledMarkers(runId, 'clean', profileRoot);
    const runtime = await runTargetRuntimeSmoke(installDir, profileRoot);
    await verifyMarkers(markers);
    const uninstaller = await runNsisUninstaller(installDir, env);
    await verifyMarkers(markers);
    assertNoScenarioShortcuts(
      await inspectProductShortcuts(),
      installDir,
      'Clean NSIS uninstall',
    );
    return {
      kind: 'installed-nsis-clean',
      sourceVersion: null,
      targetVersion: TARGET_VERSION,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      targetBuildId: identity.buildId,
      runtime,
      uninstaller,
      installedShortcutCount,
      uninstallShortcutsRemoved: true,
      uninstallMarkersPreserved: markers.markerPaths.length,
    };
  } finally {
    await stopExecutable(path.join(installDir, 'UClaw.exe'));
    await cleanupScenarioShortcuts(installDir);
    await cleanupInstallerRegistry(installDir);
    await cleanupMarkers(markers);
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function runInstalledScenario(source, targetInstaller, sandboxRoot, cacheDir, runId, keep) {
  const startedAt = Date.now();
  if (!source.url) {
    return {
      kind: installedScenarioKind(source.version),
      sourceVersion: source.version,
      status: 'not_available',
      requiredEnv: source.urlEnvName,
      requiredSha512Env: source.sha512EnvName,
    };
  }

  const prepared = await prepareInstallerSource(source, cacheDir);
  const scenarioRoot = path.join(sandboxRoot, `installed-${source.version}`);
  const profileRoot = path.join(scenarioRoot, 'profile');
  const installDir = path.join(scenarioRoot, 'app');
  const env = scenarioEnvironment(profileRoot);
  let markers = null;
  try {
    await ensureScenarioProfile(profileRoot);

    // Install the exact historical artifact, then seed customer-state markers.
    await runNsisInstaller(prepared.installerPath, installDir, env);
    await stopExecutable(path.join(installDir, 'ClawX.exe'));
    await stopExecutable(path.join(installDir, 'UClaw.exe'));
    const sourceShortcuts = await inspectProductShortcuts();
    const sourceShortcutCount = assertProductShortcut(
      sourceShortcuts,
      source.productName,
      path.join(installDir, `${source.productName}.exe`),
      `v${source.version} source install`,
    );
    markers = await seedInstalledMarkers(runId, source.version, profileRoot);

    // Exercise the real v0.7.1 updater transport; older epochs use same-directory NSIS overwrite.
    const updaterRuntime = source.version === '0.7.1'
      ? await runInstalledElectronUpdater(source, targetInstaller, installDir, profileRoot)
      : null;
    if (!updaterRuntime) {
      await runNsisInstaller(targetInstaller.installerPath, installDir, env);
    }
    await stopExecutable(path.join(installDir, 'ClawX.exe'));
    await stopExecutable(path.join(installDir, 'UClaw.exe'));
    await verifyMarkers(markers);
    const identity = await readBuildIdentity(installDir);
    assertTargetBuildIdentity(identity, `${source.version} NSIS overwrite`);
    const upgradedShortcuts = await inspectProductShortcuts();
    const targetShortcutCount = assertProductShortcut(
      upgradedShortcuts,
      'UClaw',
      path.join(installDir, 'UClaw.exe'),
      `v${source.version} upgrade`,
    );
    assertNoLegacyShortcut(upgradedShortcuts, installDir, `v${source.version} upgrade`);
    const runtime = updaterRuntime || await runTargetRuntimeSmoke(installDir, profileRoot);
    await verifyMarkers(markers);
    const uninstaller = await runNsisUninstaller(installDir, env);
    await verifyMarkers(markers);
    assertNoScenarioShortcuts(
      await inspectProductShortcuts(),
      installDir,
      `v${source.version} target uninstall`,
    );

    return {
      kind: installedScenarioKind(source.version),
      sourceVersion: source.version,
      targetVersion: TARGET_VERSION,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      sourceUrl: sanitizedUrl(source.url),
      sourceInstaller: {
        fileName: source.fileName,
        ...prepared.integrity,
      },
      targetBuildId: identity.buildId,
      upgradeTransport: updaterRuntime ? 'electron-updater' : 'nsis-overwrite',
      sourceShortcutCount,
      targetShortcutCount,
      legacyShortcutsRemoved: true,
      markersPreserved: markers.markerPaths.length,
      runtime,
      uninstaller,
      uninstallMarkersPreserved: markers.markerPaths.length,
    };
  } finally {
    await stopExecutable(path.join(installDir, 'ClawX.exe'));
    await stopExecutable(path.join(installDir, 'UClaw.exe'));
    await cleanupScenarioShortcuts(installDir);
    await cleanupInstallerRegistry(installDir);
    await cleanupMarkers(markers);
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function preparePortableSource(source, cacheDir) {
  const zipPath = await downloadFile(source.url, path.join(cacheDir, source.fileName));
  const metadataPath = await downloadFile(
    source.metadataUrl,
    path.join(cacheDir, source.fileName.replace(/\.zip$/u, '.json')),
  );
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.version !== source.version) {
    throw new Error(`Historical portable metadata version mismatch: ${source.version}`);
  }
  await assertPortableMetadata(zipPath, metadata);
  return { zipPath, metadataPath, metadata };
}

function portableHelperCandidates(appRoot) {
  return [
    path.join(appRoot, 'resources', 'resources', 'updater', 'win32-x64', 'uclaw-portable-updater.exe'),
    path.join(appRoot, 'resources', 'updater', 'win32-x64', 'uclaw-portable-updater.exe'),
  ];
}

function findPortableHelper(appRoot) {
  const helperPath = portableHelperCandidates(appRoot).find((candidate) => existsSync(candidate));
  if (!helperPath) throw new Error(`Portable updater helper missing under ${appRoot}`);
  return helperPath;
}

async function seedPortableMarkers(appRoot, runId, version) {
  const marker = `${runId}:${version}`;
  const markerPaths = [
    path.join(appRoot, 'UClawData', 'openclaw-home', '.openclaw', PROFILE_MARKER_DIR, 'state.txt'),
    path.join(appRoot, 'UClawData', 'clawx', PROFILE_MARKER_DIR, 'state.txt'),
  ];
  for (const markerPath of markerPaths) {
    await mkdir(path.dirname(markerPath), { recursive: true });
    await writeFile(markerPath, marker, { encoding: 'utf8', mode: 0o600 });
  }
  return { marker, markerPaths };
}

async function hasBackup(appRoot) {
  const backupRoot = path.join(appRoot, '.uclaw-update-backups');
  return existsSync(backupRoot) && (await readdir(backupRoot)).length > 0;
}

async function createHelperTask({
  appRoot,
  helperPath,
  targetZip,
  targetMetadata,
  launchPath,
  taskName,
  targetVersion = TARGET_VERSION,
}) {
  const taskRoot = path.join(appRoot, 'UClawData', PROFILE_MARKER_DIR, taskName);
  await mkdir(taskRoot, { recursive: true });
  const runtimeHelper = path.join(taskRoot, path.basename(helperPath));
  await copyFile(helperPath, runtimeHelper);
  const taskPath = path.join(taskRoot, 'task.json');
  const task = {
    zipPath: targetZip,
    rootDir: appRoot,
    dataDirName: 'UClawData',
    launchPath,
    targetVersion,
    sha512: targetMetadata.sha512,
    size: targetMetadata.size,
    parentPid: 0,
    logPath: path.join(taskRoot, 'helper.log'),
    stagingDir: path.join(taskRoot, 'staging'),
    ackPath: path.join(taskRoot, 'startup-ack.json'),
    pendingPath: path.join(taskRoot, 'pending-startup.json'),
  };
  await writeFile(taskPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return { runtimeHelper, taskPath, task };
}

async function preparePortableRoot(sourceZip, appRoot, runId, version) {
  await extractZip(sourceZip, appRoot);
  const portableFlag = path.join(appRoot, 'portable.flag');
  if (!existsSync(portableFlag)) throw new Error(`Historical portable.flag missing: ${version}`);
  const launchPath = path.join(appRoot, 'UClaw.exe');
  if (!existsSync(launchPath)) throw new Error(`Historical portable executable missing: ${version}`);
  const markers = await seedPortableMarkers(appRoot, runId, version);
  return { markers, launchPath };
}

async function runLegacyPortableScenario(
  source,
  prepared,
  target,
  sandboxRoot,
  runId,
  keep,
) {
  const startedAt = Date.now();
  const scenarioRoot = path.join(sandboxRoot, `portable-${source.version}`);
  const appRoot = path.join(scenarioRoot, 'app');
  try {
    const { markers, launchPath } = await preparePortableRoot(
      prepared.zipPath,
      appRoot,
      runId,
      source.version,
    );
    const runtimeProbe = await createPortableRuntimeProbe(
      path.join(scenarioRoot, 'profile'),
      appRoot,
    );
    const legacyHelper = findPortableHelper(appRoot);
    const legacyHelperSha512 = await sha512(legacyHelper);
    const legacyHelperPath = path.relative(appRoot, legacyHelper).split(path.sep).join('/');
    const helperTask = await createHelperTask({
      appRoot,
      helperPath: legacyHelper,
      targetZip: target.zipPath,
      targetMetadata: target.metadata,
      launchPath,
      taskName: 'legacy-helper-first-hop',
    });

    // Invoke the historical helper exactly as the historical app would after download.
    const helperResult = await runProcess(
      helperTask.runtimeHelper,
      ['--task', helperTask.taskPath],
      { cwd: appRoot, env: runtimeProbe.env },
    );
    if (helperResult.code !== 0) {
      throw new Error(`Legacy ${source.version} helper failed: ${helperResult.output}`);
    }
    await verifyMarkers(markers);
    const identity = await readBuildIdentity(appRoot);
    assertTargetBuildIdentity(identity, `legacy ${source.version} portable first hop`);
    if (!await hasBackup(appRoot)) {
      throw new Error(`Legacy ${source.version} helper did not retain a rollback backup`);
    }
    const runtime = await waitForExistingRuntime(runtimeProbe, startedAt);
    await verifyMarkers(markers);
    return {
      kind: 'portable-legacy-helper-first-hop',
      sourceVersion: source.version,
      targetVersion: TARGET_VERSION,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      sourceUrl: sanitizedUrl(source.url),
      sourcePackage: {
        fileName: source.fileName,
        size: prepared.metadata.size,
        sha512: prepared.metadata.sha512,
        sha512Encoding: 'hex',
      },
      legacyHelperPath,
      legacyHelperSha512,
      targetBuildId: identity.buildId,
      markersPreserved: markers.markerPaths.length,
      backupRetained: true,
      runtime,
    };
  } finally {
    await stopExecutable(path.join(appRoot, 'UClaw.exe'));
    await stopExecutable(path.join(appRoot, 'ClawX.exe'));
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function runCurrentHelperRollbackScenario(source, prepared, target, sandboxRoot, runId, keep) {
  const startedAt = Date.now();
  const scenarioRoot = path.join(sandboxRoot, `portable-rollback-${source.version}`);
  const appRoot = path.join(scenarioRoot, 'app');
  try {
    const { markers, launchPath } = await preparePortableRoot(
      prepared.zipPath,
      appRoot,
      runId,
      source.version,
    );
    const runtimeProbe = await createPortableRuntimeProbe(
      path.join(scenarioRoot, 'profile'),
      appRoot,
    );
    const sourceIdentity = await readBuildIdentity(appRoot);
    const currentHelper = findPortableHelper(target.extractedRoot);
    const currentHelperSha512 = await sha512(currentHelper);
    const helperTask = await createHelperTask({
      appRoot,
      helperPath: currentHelper,
      targetZip: target.zipPath,
      targetMetadata: target.metadata,
      launchPath,
      taskName: 'current-helper-startup-timeout',
      targetVersion: `${TARGET_VERSION}-ack-timeout`,
    });

    // A mismatched target version prevents the new app from acknowledging startup.
    const helperResult = await runProcess(
      helperTask.runtimeHelper,
      ['--task', helperTask.taskPath],
      { cwd: appRoot, env: runtimeProbe.env, timeoutMs: 4 * 60_000 },
    );
    if (helperResult.code === 0) {
      throw new Error('Current helper unexpectedly accepted a missing startup acknowledgement');
    }
    await verifyMarkers(markers);
    const restoredIdentity = await readBuildIdentity(appRoot);
    if (sourceIdentity?.appVersion
      && restoredIdentity?.appVersion !== sourceIdentity.appVersion) {
      throw new Error(`Current helper did not restore source version ${sourceIdentity.appVersion}`);
    }
    const resultPath = `${helperTask.taskPath}.result.json`;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (result.success !== false || !/acknowledge|startup/iu.test(result.error || '')) {
      throw new Error(`Unexpected current-helper rollback result: ${JSON.stringify(result)}`);
    }
    const restoredRuntime = await waitForExistingRuntime(runtimeProbe, startedAt);
    await verifyMarkers(markers);
    return {
      kind: 'portable-current-helper-startup-rollback',
      sourceVersion: source.version,
      targetVersion: TARGET_VERSION,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      sourceRestored: restoredIdentity?.appVersion || source.version,
      sourcePackage: {
        fileName: source.fileName,
        size: prepared.metadata.size,
        sha512: prepared.metadata.sha512,
        sha512Encoding: 'hex',
      },
      currentHelperSha512,
      markersPreserved: markers.markerPaths.length,
      helperError: result.error,
      restoredRuntime,
    };
  } finally {
    await stopExecutable(path.join(appRoot, 'UClaw.exe'));
    await stopExecutable(path.join(appRoot, 'ClawX.exe'));
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function runCurrentHelperSuccessScenario(source, prepared, target, sandboxRoot, runId, keep) {
  const startedAt = Date.now();
  const scenarioRoot = path.join(sandboxRoot, `portable-current-success-${source.version}`);
  const appRoot = path.join(scenarioRoot, 'app');
  try {
    const { markers, launchPath } = await preparePortableRoot(
      prepared.zipPath,
      appRoot,
      runId,
      source.version,
    );
    const runtimeProbe = await createPortableRuntimeProbe(
      path.join(scenarioRoot, 'profile'),
      appRoot,
    );
    const currentHelper = findPortableHelper(target.extractedRoot);
    const currentHelperSha512 = await sha512(currentHelper);
    const helperTask = await createHelperTask({
      appRoot,
      helperPath: currentHelper,
      targetZip: target.zipPath,
      targetMetadata: target.metadata,
      launchPath,
      taskName: 'current-helper-startup-confirmation',
    });

    const helperResult = await runProcess(
      helperTask.runtimeHelper,
      ['--task', helperTask.taskPath],
      { cwd: appRoot, env: runtimeProbe.env, timeoutMs: 4 * 60_000 },
    );
    if (helperResult.code !== 0) {
      throw new Error(`Current helper startup confirmation failed: ${helperResult.output}`);
    }
    const resultPath = `${helperTask.taskPath}.result.json`;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (result.success !== true) {
      throw new Error(`Unexpected current-helper success result: ${JSON.stringify(result)}`);
    }
    if (existsSync(helperTask.task.ackPath) || existsSync(helperTask.task.pendingPath)) {
      throw new Error('Current helper left startup acknowledgement state after success');
    }
    await verifyMarkers(markers);
    const identity = await readBuildIdentity(appRoot);
    assertTargetBuildIdentity(identity, 'current-helper portable startup confirmation');
    if (!await hasBackup(appRoot)) {
      throw new Error('Current helper did not retain a rollback backup after startup confirmation');
    }
    const runtime = await waitForExistingRuntime(runtimeProbe, startedAt);
    await verifyMarkers(markers);
    return {
      kind: 'portable-current-helper-startup-confirmation',
      sourceVersion: source.version,
      targetVersion: TARGET_VERSION,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      currentHelperSha512,
      targetBuildId: identity.buildId,
      markersPreserved: markers.markerPaths.length,
      backupRetained: true,
      runtime,
    };
  } finally {
    await stopExecutable(path.join(appRoot, 'UClaw.exe'));
    await stopExecutable(path.join(appRoot, 'ClawX.exe'));
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function runCurrentHelperIntegrityFailureScenario(
  source,
  prepared,
  target,
  sandboxRoot,
  runId,
  keep,
  failureMode,
) {
  const startedAt = Date.now();
  const scenarioRoot = path.join(sandboxRoot, `portable-integrity-${failureMode}-${source.version}`);
  const appRoot = path.join(scenarioRoot, 'app');
  try {
    const { markers, launchPath } = await preparePortableRoot(
      prepared.zipPath,
      appRoot,
      runId,
      source.version,
    );
    const runtimeProbe = await createPortableRuntimeProbe(
      path.join(scenarioRoot, 'profile'),
      appRoot,
    );
    const sourceIdentity = await readBuildIdentity(appRoot);
    const currentHelper = findPortableHelper(target.extractedRoot);
    const invalidMetadata = {
      ...target.metadata,
      ...(failureMode === 'size'
        ? { size: Number(target.metadata.size) + 1 }
        : { sha512: '0'.repeat(128) }),
    };
    const helperTask = await createHelperTask({
      appRoot,
      helperPath: currentHelper,
      targetZip: target.zipPath,
      targetMetadata: invalidMetadata,
      launchPath,
      taskName: `current-helper-integrity-${failureMode}`,
    });

    const helperResult = await runProcess(
      helperTask.runtimeHelper,
      ['--task', helperTask.taskPath],
      { cwd: appRoot, env: runtimeProbe.env },
    );
    if (helperResult.code === 0) {
      throw new Error(`Current helper unexpectedly accepted invalid ${failureMode} metadata`);
    }
    await verifyMarkers(markers);
    const unchangedIdentity = await readBuildIdentity(appRoot);
    if (sourceIdentity?.appVersion
      && unchangedIdentity?.appVersion !== sourceIdentity.appVersion) {
      throw new Error(`Integrity failure changed source version ${sourceIdentity.appVersion}`);
    }
    const resultPath = `${helperTask.taskPath}.result.json`;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    const expectedError = failureMode === 'size' ? /size mismatch/iu : /sha512 mismatch/iu;
    if (result.success !== false || !expectedError.test(result.error || '')) {
      throw new Error(`Unexpected ${failureMode} integrity result: ${JSON.stringify(result)}`);
    }
    const restoredRuntime = await waitForExistingRuntime(runtimeProbe, startedAt);
    await verifyMarkers(markers);
    return {
      kind: 'portable-current-helper-integrity-rejection',
      sourceVersion: source.version,
      targetVersion: TARGET_VERSION,
      failureMode,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      sourceUnchanged: unchangedIdentity?.appVersion || source.version,
      markersPreserved: markers.markerPaths.length,
      helperError: result.error,
      restoredRuntime,
    };
  } finally {
    await stopExecutable(path.join(appRoot, 'UClaw.exe'));
    await stopExecutable(path.join(appRoot, 'ClawX.exe'));
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function runCurrentHelperArchiveFailureScenario(
  source,
  prepared,
  target,
  sandboxRoot,
  runId,
  keep,
) {
  const startedAt = Date.now();
  const scenarioRoot = path.join(sandboxRoot, `portable-archive-failure-${source.version}`);
  const appRoot = path.join(scenarioRoot, 'app');
  try {
    const { markers, launchPath } = await preparePortableRoot(
      prepared.zipPath,
      appRoot,
      runId,
      source.version,
    );
    const runtimeProbe = await createPortableRuntimeProbe(
      path.join(scenarioRoot, 'profile'),
      appRoot,
    );
    const sourceIdentity = await readBuildIdentity(appRoot);
    const currentHelper = findPortableHelper(target.extractedRoot);
    const invalidZip = path.join(scenarioRoot, 'invalid-update.zip');
    await writeFile(invalidZip, 'not a zip archive', { encoding: 'utf8', mode: 0o600 });
    const invalidMetadata = {
      ...target.metadata,
      size: (await stat(invalidZip)).size,
      sha512: await sha512(invalidZip),
    };
    const helperTask = await createHelperTask({
      appRoot,
      helperPath: currentHelper,
      targetZip: invalidZip,
      targetMetadata: invalidMetadata,
      launchPath,
      taskName: 'current-helper-archive-rejection',
    });

    // Integrity metadata is valid for these bytes, so this reaches the real
    // archive extraction path instead of stopping at the hash/size guard.
    const helperResult = await runProcess(
      helperTask.runtimeHelper,
      ['--task', helperTask.taskPath],
      { cwd: appRoot, env: runtimeProbe.env },
    );
    if (helperResult.code === 0) {
      throw new Error('Current helper unexpectedly accepted an invalid ZIP archive');
    }
    await verifyMarkers(markers);
    const unchangedIdentity = await readBuildIdentity(appRoot);
    if (sourceIdentity?.appVersion
      && unchangedIdentity?.appVersion !== sourceIdentity.appVersion) {
      throw new Error(`Archive failure changed source version ${sourceIdentity.appVersion}`);
    }
    const resultPath = `${helperTask.taskPath}.result.json`;
    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    if (result.success !== false || !/zip|archive|central directory/iu.test(result.error || '')) {
      throw new Error(`Unexpected invalid archive result: ${JSON.stringify(result)}`);
    }
    const restoredRuntime = await waitForExistingRuntime(runtimeProbe, startedAt);
    await verifyMarkers(markers);
    return {
      kind: 'portable-current-helper-archive-rejection',
      sourceVersion: source.version,
      targetVersion: TARGET_VERSION,
      status: 'passed',
      durationMs: Date.now() - startedAt,
      sourceUnchanged: unchangedIdentity?.appVersion || source.version,
      markersPreserved: markers.markerPaths.length,
      helperError: result.error,
      restoredRuntime,
    };
  } finally {
    await stopExecutable(path.join(appRoot, 'UClaw.exe'));
    await stopExecutable(path.join(appRoot, 'ClawX.exe'));
    if (!keep) await rm(scenarioRoot, { recursive: true, force: true });
  }
}

async function prepareTargetPortable(targetZip, sandboxRoot) {
  const metadataPath = targetZip.replace(/\.zip$/iu, '.json');
  if (!existsSync(metadataPath)) throw new Error(`Target USB metadata missing: ${metadataPath}`);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  if (metadata.version !== TARGET_VERSION) {
    throw new Error(`Target USB metadata version mismatch: ${metadata.version}`);
  }
  await assertPortableMetadata(targetZip, metadata);
  const extractedRoot = path.join(sandboxRoot, 'target-portable');
  await extractZip(targetZip, extractedRoot);
  const identity = await readBuildIdentity(extractedRoot);
  assertTargetBuildIdentity(identity, 'target portable');
  findPortableHelper(extractedRoot);
  return { zipPath: targetZip, metadataPath, metadata, extractedRoot, identity };
}

async function writeSummary(reportDir, summary) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(
    path.join(reportDir, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function main() {
  const startedAt = Date.now();
  const runId = `${TARGET_VERSION}-${new Date().toISOString().replace(/[:.]/gu, '')}-${randomUUID().slice(0, 8)}`;
  const reportDir = path.join(RELEASE_DIR, 'regression', `windows-upgrade-matrix-${runId}`);
  const scenarios = [];
  const targetArtifacts = {};
  let options = null;
  let sandboxRoot = null;
  let failure = null;

  try {
    options = parseArgs(process.argv.slice(2));
    assertExecutionEnvironment();
    sandboxRoot = assertSafeTempChild(path.join(os.tmpdir(), `uclaw-upgrade-matrix-${runId}`));
    const cacheDir = path.join(sandboxRoot, 'downloads');
    await mkdir(cacheDir, { recursive: true });

    if (options.mode === 'all' || options.mode === 'installed') {
      const targetInstallerPath = await findNewestArtifact(
        new RegExp(`^UClaw-${TARGET_VERSION.replaceAll('.', '\\.')}-win-x64\\.exe$`, 'u'),
        options.targetInstaller,
      );
      const targetInstaller = await prepareTargetInstaller(targetInstallerPath);
      targetArtifacts.installer = targetInstaller.evidence;
      try {
        scenarios.push(await runCleanInstalledScenario(
          targetInstaller.installerPath,
          sandboxRoot,
          runId,
          options.keep,
        ));
      } catch (error) {
        scenarios.push({
          kind: 'installed-nsis-clean',
          sourceVersion: null,
          status: 'failed',
          error: redact(error instanceof Error ? error.stack || error.message : error),
        });
        throw error;
      }
      for (const source of [...PUBLIC_INSTALLERS, ...OPTIONAL_INSTALLERS]) {
        try {
          scenarios.push(await runInstalledScenario(
            source,
            targetInstaller,
            sandboxRoot,
            cacheDir,
            runId,
            options.keep,
          ));
        } catch (error) {
          scenarios.push({
            kind: installedScenarioKind(source.version),
            sourceVersion: source.version,
            status: 'failed',
            error: redact(error instanceof Error ? error.stack || error.message : error),
          });
          throw error;
        }
      }
    }

    if (options.mode === 'all' || options.mode === 'portable') {
      const targetZip = await findNewestArtifact(
        new RegExp(`^UClaw-${TARGET_VERSION.replaceAll('.', '\\.')}-win-x64-usb\\.zip$`, 'u'),
        options.targetZip,
      );
      const target = await prepareTargetPortable(targetZip, sandboxRoot);
      targetArtifacts.portable = {
        fileName: path.basename(target.zipPath),
        size: target.metadata.size,
        sha512: target.metadata.sha512,
        sha512Encoding: 'hex',
        buildId: target.identity.buildId,
      };
      const preparedPortables = new Map();
      for (const source of PUBLIC_PORTABLES) {
        try {
          const prepared = await preparePortableSource(source, cacheDir);
          preparedPortables.set(source.version, prepared);
          scenarios.push(await runLegacyPortableScenario(
            source,
            prepared,
            target,
            sandboxRoot,
            runId,
            options.keep,
          ));
        } catch (error) {
          scenarios.push({
            kind: 'portable-legacy-helper-first-hop',
            sourceVersion: source.version,
            status: 'failed',
            error: redact(error instanceof Error ? error.stack || error.message : error),
          });
          throw error;
        }
      }
      const rollbackSource = PUBLIC_PORTABLES.find((candidate) => candidate.version === '1.0.1');
      try {
        scenarios.push(await runCurrentHelperSuccessScenario(
          rollbackSource,
          preparedPortables.get(rollbackSource.version),
          target,
          sandboxRoot,
          runId,
          options.keep,
        ));
      } catch (error) {
        scenarios.push({
          kind: 'portable-current-helper-startup-confirmation',
          sourceVersion: rollbackSource.version,
          status: 'failed',
          error: redact(error instanceof Error ? error.stack || error.message : error),
        });
        throw error;
      }
      for (const failureMode of ['size', 'sha512']) {
        try {
          scenarios.push(await runCurrentHelperIntegrityFailureScenario(
            rollbackSource,
            preparedPortables.get(rollbackSource.version),
            target,
            sandboxRoot,
            runId,
            options.keep,
            failureMode,
          ));
        } catch (error) {
          scenarios.push({
            kind: 'portable-current-helper-integrity-rejection',
            sourceVersion: rollbackSource.version,
            failureMode,
            status: 'failed',
            error: redact(error instanceof Error ? error.stack || error.message : error),
          });
          throw error;
        }
      }
      try {
        scenarios.push(await runCurrentHelperArchiveFailureScenario(
          rollbackSource,
          preparedPortables.get(rollbackSource.version),
          target,
          sandboxRoot,
          runId,
          options.keep,
        ));
      } catch (error) {
        scenarios.push({
          kind: 'portable-current-helper-archive-rejection',
          sourceVersion: rollbackSource.version,
          status: 'failed',
          error: redact(error instanceof Error ? error.stack || error.message : error),
        });
        throw error;
      }
      if (!options.skipRollback) {
        try {
          scenarios.push(await runCurrentHelperRollbackScenario(
            rollbackSource,
            preparedPortables.get(rollbackSource.version),
            target,
            sandboxRoot,
            runId,
            options.keep,
          ));
        } catch (error) {
            scenarios.push({
              kind: 'portable-current-helper-startup-rollback',
              sourceVersion: rollbackSource.version,
            status: 'failed',
            error: redact(error instanceof Error ? error.stack || error.message : error),
          });
          throw error;
        }
      }
    }

    if (options.requireCompleteInstallers) {
      const missing = scenarios.filter((scenario) => (
        scenario.kind === 'installed-nsis-overwrite' && scenario.status === 'not_available'
      ));
      if (missing.length > 0) {
        throw new Error(`Required customer installers are unavailable: ${missing.map((item) => item.sourceVersion).join(', ')}`);
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  const summary = {
    schemaVersion: 1,
    runId,
    status: failure ? 'failed' : 'passed',
    targetVersion: TARGET_VERSION,
    mode: options?.mode ?? null,
    requireCompleteInstallers: options?.requireCompleteInstallers ?? null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    host: { platform: process.platform, arch: process.arch },
    targetArtifacts,
    scenarios,
    failure: failure ? redact(failure.stack || failure.message) : null,
    sandboxKept: Boolean(sandboxRoot && (options?.keep || failure)),
  };
  await writeSummary(reportDir, summary);
  console.log(`[upgrade-matrix] Report: ${reportDir}`);
  if (sandboxRoot) {
    if (!options?.keep && !failure) await rm(sandboxRoot, { recursive: true, force: true });
    else console.log(`[upgrade-matrix] Sandbox kept: ${sandboxRoot}`);
  }

  if (failure) throw failure;
  console.log('[upgrade-matrix] PASS');
}

main().catch((error) => {
  console.error(`[upgrade-matrix] FAIL: ${redact(error instanceof Error ? error.stack || error.message : error)}`);
  process.exit(1);
});
