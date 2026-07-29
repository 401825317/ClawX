#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { generateRegressionReport } from './generate-regression-report.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PROFILE_NAMES = new Set(['core', 'full', 'live']);
const MAX_DIAGNOSTIC_FILES = 40;
const MAX_DIAGNOSTIC_BYTES_PER_FILE = 256 * 1024;

function parseArgs(argv) {
  const options = {
    zip: '',
    profile: 'full',
    keep: false,
    latest: false,
    liveProfile: '',
    liveLoginStdin: false,
    liveRegisterAdminStdin: false,
    allowDesktopCapture: false,
    allowExternalDelivery: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [name, inlineValue] = arg.split('=', 2);
    const readValue = () => inlineValue ?? argv[++index] ?? '';
    switch (name) {
      case '--zip':
        options.zip = readValue();
        break;
      case '--profile':
        options.profile = readValue();
        break;
      case '--live-profile':
        options.liveProfile = readValue();
        break;
      case '--live-login-stdin':
        options.liveLoginStdin = true;
        break;
      case '--live-register-admin-stdin':
        options.liveRegisterAdminStdin = true;
        break;
      case '--latest':
        options.latest = true;
        break;
      case '--keep':
        options.keep = true;
        break;
      case '--allow-desktop-capture':
        options.allowDesktopCapture = true;
        break;
      case '--allow-external-delivery':
        options.allowExternalDelivery = true;
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
  if (!PROFILE_NAMES.has(options.profile)) {
    throw new Error(`Unsupported profile "${options.profile}". Use core, full, or live.`);
  }
  if (options.profile === 'live' && !options.liveProfile && !options.liveLoginStdin && !options.liveRegisterAdminStdin) {
    throw new Error('The live profile requires --live-profile, --live-login-stdin, or --live-register-admin-stdin.');
  }
  if (options.liveLoginStdin && options.profile !== 'live') {
    throw new Error('--live-login-stdin is only valid with --profile live.');
  }
  if (options.liveRegisterAdminStdin && options.profile !== 'live') {
    throw new Error('--live-register-admin-stdin is only valid with --profile live.');
  }
  if ([options.liveProfile, options.liveLoginStdin, options.liveRegisterAdminStdin].filter(Boolean).length > 1) {
    throw new Error('Use exactly one live profile, existing-account login, or fresh-account registration input mode.');
  }
  if (options.allowExternalDelivery) {
    if (options.profile !== 'live') {
      throw new Error('--allow-external-delivery is only valid with --profile live.');
    }
    const requiredVariables = [
      'UCLAW_REGRESSION_DELIVERY_CHANNEL',
      'UCLAW_REGRESSION_DELIVERY_ACCOUNT_ID',
      'UCLAW_REGRESSION_DELIVERY_TARGET',
    ];
    const missing = requiredVariables.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`External delivery requires a dedicated test destination (${missing.join(', ')}).`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`UClaw packaged Windows regression

Usage:
  node scripts/windows-support/run-packaged-regression.mjs --latest [--profile full]
  node scripts/windows-support/run-packaged-regression.mjs --zip <usb.zip> [options]

Profiles:
  core  Package identity, static self-check, first launch, UI, and Gateway recovery.
  full  core plus deterministic local-provider chat, tools, browser, Agent, Cron, and media runtime.
  live  Managed Responses/image/video checks using an explicitly supplied isolated UClawData profile.

Options:
  --keep                       Keep the extracted sandbox after a successful run.
  --live-profile <dir>         Prepared test-only UClawData directory. Never read implicitly.
  --live-login-stdin           Read one {"username","password"} JSON line without echo and
                               authenticate only inside the isolated package sandbox.
  --live-register-admin-stdin  Read one root/admin {"username","password"} JSON line without
                               echo, create a one-time activation code, register a fresh
                               generated account through the packaged UI, relogin, then clean up.
  --allow-desktop-capture      Allow the desktop.observe scenario.
  --allow-external-delivery    Send to the dedicated live destination supplied through
                               UCLAW_REGRESSION_DELIVERY_CHANNEL,
                               UCLAW_REGRESSION_DELIVERY_ACCOUNT_ID, and
                               UCLAW_REGRESSION_DELIVERY_TARGET.
`);
}

async function sha512(filePath) {
  const hash = createHash('sha512');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function resolveLatestZip() {
  const entries = await readdir(RELEASE_DIR, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^UClaw-.+-win-x64-usb\.zip$/u.test(entry.name)) continue;
    const filePath = path.join(RELEASE_DIR, entry.name);
    candidates.push({ filePath, modifiedMs: (await stat(filePath)).mtimeMs });
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (!candidates[0]) {
    throw new Error(`No Windows USB ZIP was found under ${RELEASE_DIR}`);
  }
  return candidates[0].filePath;
}

async function resolveArtifacts(options) {
  const zipPath = path.resolve(options.zip || await resolveLatestZip());
  if (!existsSync(zipPath)) throw new Error(`ZIP not found: ${zipPath}`);
  const metadataPath = zipPath.replace(/\.zip$/iu, '.json');
  if (!existsSync(metadataPath)) throw new Error(`Companion metadata not found: ${metadataPath}`);
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const zipStat = await stat(zipPath);
  const digest = await sha512(zipPath);
  const mismatches = [];
  if (metadata.fileName !== path.basename(zipPath) && metadata.file_name !== path.basename(zipPath)) {
    mismatches.push('fileName');
  }
  if (metadata.size !== zipStat.size) mismatches.push('size');
  if (String(metadata.sha512 || '').toLowerCase() !== digest) mismatches.push('sha512');
  if (metadata.platform !== 'win' || metadata.arch !== 'x64') mismatches.push('platform/arch');
  if (metadata.packageType !== 'portable_zip' && metadata.package_type !== 'portable_zip') {
    mismatches.push('packageType');
  }
  if (mismatches.length > 0) {
    throw new Error(`USB metadata mismatch: ${mismatches.join(', ')}`);
  }
  return { zipPath, metadataPath, metadata, zipStat, digest };
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

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return result;
}

async function runInheritedCommand(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('close', (status, signal) => resolve({ status: status ?? 1, signal }));
  });
}

async function readSensitiveStdinLine() {
  const stdin = process.stdin;
  const previousRawMode = stdin.isTTY ? stdin.isRaw : false;
  return await new Promise((resolve, reject) => {
    let buffer = '';
    const cleanup = () => {
      stdin.off('data', onData);
      stdin.off('error', onError);
      if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(previousRawMode);
      stdin.pause();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      buffer += String(chunk);
      const lineEnd = buffer.search(/[\r\n]/u);
      if (lineEnd < 0) return;
      const line = buffer.slice(0, lineEnd);
      buffer = '';
      cleanup();
      resolve(line);
    };
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.once('error', onError);
    stdin.resume();
  });
}

async function createSensitiveInputBroker(line) {
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\uclaw-regression-${process.pid}-${randomUUID()}`
    : path.join(os.tmpdir(), `uclaw-regression-${process.pid}-${randomUUID()}.sock`);
  const payload = Buffer.from(`${line}\n`, 'utf8');
  let consumed = false;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (consumed) {
      socket.destroy();
      return;
    }
    consumed = true;
    socket.end(payload, () => {
      payload.fill(0);
      server.close();
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      resolve();
    });
  });
  return {
    endpoint,
    async close() {
      payload.fill(0);
      for (const socket of sockets) socket.destroy();
      if (server.listening) {
        await new Promise((resolve) => server.close(() => resolve()));
      }
      if (process.platform !== 'win32') await rm(endpoint, { force: true }).catch(() => undefined);
    },
  };
}

async function extractZip(zipPath, destination) {
  await mkdir(destination, { recursive: true });
  const tarResult = runCommand('tar.exe', ['-xf', zipPath, '-C', destination]);
  if (tarResult.status === 0) return;
  const escapedZip = zipPath.replaceAll("'", "''");
  const escapedDestination = destination.replaceAll("'", "''");
  const fallback = runCommand('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDestination}' -Force`,
  ]);
  if (fallback.status !== 0) {
    throw new Error(`ZIP extraction failed: ${tarResult.stderr || fallback.stderr || 'unknown error'}`);
  }
}

async function verifyEmptyPortableData(appRoot) {
  const dataDir = path.join(appRoot, 'UClawData');
  const topLevel = await readdir(dataDir);
  const unexpected = topLevel.filter((name) => !['.keep', 'updates'].includes(name));
  if (unexpected.length > 0) {
    throw new Error(`Packaged UClawData is not empty: ${unexpected.join(', ')}`);
  }
  const updatesDir = path.join(dataDir, 'updates');
  if (existsSync(updatesDir) && (await readdir(updatesDir)).length > 0) {
    throw new Error('Packaged UClawData/updates is not empty.');
  }
}

function verifyCriticalRuntimeFiles(appRoot) {
  const requiredFiles = [
    'UClaw.exe',
    'resources/app.asar',
    'resources/app.asar.unpacked/node_modules/sharp/package.json',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/package.json',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64.node',
    'resources/app.asar.unpacked/node_modules/@img/sharp-win32-x64/lib/libvips-42.dll',
  ];
  const missing = requiredFiles.filter((relativePath) => !existsSync(path.join(appRoot, relativePath)));
  if (missing.length > 0) {
    throw new Error(`Packaged Electron runtime is incomplete. Missing: ${missing.join(', ')}`);
  }
}

async function runStaticSelfCheck(appRoot, reportDir) {
  const selfCheckPath = path.join(appRoot, 'UClaw-SelfCheck.cmd');
  if (!existsSync(selfCheckPath)) throw new Error('UClaw-SelfCheck.cmd is missing from the package.');
  const escapedSelfCheckPath = selfCheckPath.replaceAll("'", "''");
  const command = `& '${escapedSelfCheckPath}' --static-only --no-desktop-copy`;
  const result = runCommand('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ], { cwd: appRoot });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  await writeFile(path.join(reportDir, 'static-self-check.log'), redact(output), 'utf8');
  if (result.status !== 0 || !/Summary:\s+PASS=\d+\s+WARN=0\s+FAIL=0/iu.test(output)) {
    throw new Error(`Static self-check failed with exit code ${result.status ?? 'unknown'}.`);
  }
  const summary = output.match(/Summary:\s+PASS=(\d+)\s+WARN=(\d+)\s+FAIL=(\d+)/iu);
  return summary ? { pass: Number(summary[1]), warn: Number(summary[2]), fail: Number(summary[3]) } : null;
}

function redact(value) {
  return String(value)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, 'sk-[REDACTED]')
    .replace(/("?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|relay[_-]?token|password|secret)"?\s*[:=]\s*")([^"]+)(")/giu, '$1[REDACTED]$3')
    .replace(/([?&](?:token|signature|sig|key)=)[^&\s]+/giu, '$1[REDACTED]');
}

async function walkDiagnosticFiles(rootDir, output, depth = 0) {
  if (!existsSync(rootDir) || output.length >= MAX_DIAGNOSTIC_FILES || depth > 8) return;
  for (const entry of await readdir(rootDir, { withFileTypes: true })) {
    if (output.length >= MAX_DIAGNOSTIC_FILES) break;
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      await walkDiagnosticFiles(entryPath, output, depth + 1);
      continue;
    }
    if (/\.(?:log|txt|jsonl)$/iu.test(entry.name)) output.push(entryPath);
  }
}

async function collectSanitizedDiagnostics(appRoot, sandboxRoot, runtimeRoot, reportDir) {
  const files = [];
  for (const rootDir of [
    path.join(runtimeRoot, 'logs'),
    path.join(runtimeRoot, 'profiles'),
    path.join(sandboxRoot, 'os-home', 'AppData', 'Local', 'UClawRuntime', 'logs'),
    path.join(sandboxRoot, 'os-home', 'AppData', 'Local', 'UClawRuntime', 'profiles'),
    path.join(sandboxRoot, 'live-os-home', 'AppData', 'Local', 'UClawRuntime', 'profiles'),
    path.join(appRoot, 'UClawData', 'clawx', 'logs'),
    path.join(appRoot, 'UClawData', 'openclaw-home', '.openclaw', 'logs'),
  ]) {
    await walkDiagnosticFiles(rootDir, files);
  }
  const sections = [];
  for (const filePath of files) {
    const fileStat = await stat(filePath);
    const content = await readFile(filePath);
    const tail = content.subarray(Math.max(0, content.length - MAX_DIAGNOSTIC_BYTES_PER_FILE));
    sections.push(`\n===== ${path.basename(filePath)} (${fileStat.size} bytes) =====\n${redact(tail.toString('utf8'))}`);
  }
  await writeFile(path.join(reportDir, 'sanitized-runtime.log'), sections.join('\n'), 'utf8');
  return files.length;
}

async function installLiveProfile(sourceDir, appRoot) {
  const source = path.resolve(sourceDir);
  if (!existsSync(source)) throw new Error(`Live profile not found: ${source}`);
  const sourceStat = await stat(source);
  if (!sourceStat.isDirectory()) throw new Error('The live profile must be a directory.');
  const destination = path.join(appRoot, 'UClawData');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true, force: true });
}

async function main() {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  const artifacts = await resolveArtifacts(options);
  const runId = `${String(artifacts.metadata.version || 'unknown').replace(/[^A-Za-z0-9._-]+/gu, '_')}-${new Date().toISOString().replace(/[:.]/gu, '')}`;
  const sandboxRoot = assertSafeTempChild(path.join(os.tmpdir(), `UClaw Packaged Regression ${runId}`));
  const runtimeRoot = assertSafeTempChild(path.join(
    os.tmpdir(),
    'ucr',
    createHash('sha256').update(runId).digest('hex').slice(0, 12),
  ));
  const appRoot = path.join(sandboxRoot, 'app');
  const reportDir = path.join(RELEASE_DIR, 'regression', runId);
  await mkdir(reportDir, { recursive: true });
  await rm(sandboxRoot, { recursive: true, force: true });
  await rm(runtimeRoot, { recursive: true, force: true });
  await mkdir(appRoot, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });

  let playwrightExitCode = null;
  let staticSummary = null;
  let failure = null;
  let sensitiveInputBroker = null;
  try {
    console.log(`[packaged-regression] ZIP: ${artifacts.zipPath}`);
    console.log(`[packaged-regression] Profile: ${options.profile}`);
    console.log(`[packaged-regression] Report: ${reportDir}`);
    await extractZip(artifacts.zipPath, appRoot);
    verifyCriticalRuntimeFiles(appRoot);
    await verifyEmptyPortableData(appRoot);
    staticSummary = await runStaticSelfCheck(appRoot, reportDir);
    if (options.profile === 'live' && options.liveProfile) await installLiveProfile(options.liveProfile, appRoot);

    const playwrightCli = path.join(ROOT, 'node_modules', '@playwright', 'test', 'cli.js');
    if (!existsSync(playwrightCli)) {
      throw new Error('Playwright is not installed. Run pnpm install first.');
    }
    if (options.liveLoginStdin || options.liveRegisterAdminStdin) {
      const sensitiveLine = await readSensitiveStdinLine();
      sensitiveInputBroker = await createSensitiveInputBroker(sensitiveLine);
    }

    const testResult = await runInheritedCommand(process.execPath, [
      playwrightCli,
      'test',
      '--config',
      path.join(ROOT, 'playwright.packaged.config.ts'),
    ], {
      cwd: ROOT,
      inherit: true,
      env: {
        ...process.env,
        UCLAW_PACKAGED_ROOT: appRoot,
        UCLAW_REGRESSION_SANDBOX: sandboxRoot,
        UCLAW_REGRESSION_RUNTIME_ROOT: runtimeRoot,
        UCLAW_REGRESSION_REPORT_DIR: reportDir,
        UCLAW_REGRESSION_PROFILE: options.profile,
        UCLAW_REGRESSION_RUN_ID: runId,
        UCLAW_REGRESSION_ALLOW_DESKTOP_CAPTURE: options.allowDesktopCapture ? '1' : '0',
        UCLAW_REGRESSION_ALLOW_EXTERNAL_DELIVERY: options.allowExternalDelivery ? '1' : '0',
        UCLAW_REGRESSION_LIVE_LOGIN_STDIN: options.liveLoginStdin ? '1' : '0',
        UCLAW_REGRESSION_LIVE_REGISTER_ADMIN_STDIN: options.liveRegisterAdminStdin ? '1' : '0',
        ...(sensitiveInputBroker ? { UCLAW_REGRESSION_SENSITIVE_PIPE: sensitiveInputBroker.endpoint } : {}),
      },
    });
    playwrightExitCode = testResult.status ?? 1;
    if (playwrightExitCode !== 0) {
      throw new Error(`Packaged Playwright regression failed with exit code ${playwrightExitCode}.`);
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await sensitiveInputBroker?.close().catch(() => undefined);
    let diagnosticFiles = 0;
    try {
      diagnosticFiles = await collectSanitizedDiagnostics(appRoot, sandboxRoot, runtimeRoot, reportDir);
    } catch (error) {
      await writeFile(path.join(reportDir, 'diagnostic-collection-error.txt'), redact(error), 'utf8');
    }
    const scenarioResultsPath = path.join(reportDir, 'scenario-results.json');
    const scenarioResults = existsSync(scenarioResultsPath)
      ? JSON.parse(await readFile(scenarioResultsPath, 'utf8'))
      : [];
    const summary = {
      schemaVersion: 1,
      runId,
      profile: options.profile,
      status: failure ? 'failed' : 'passed',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      package: {
        version: artifacts.metadata.version,
        buildId: artifacts.metadata.buildId,
        gitCommit: artifacts.metadata.gitCommit,
        zipFileName: path.basename(artifacts.zipPath),
        zipSize: artifacts.zipStat.size,
        sha512: artifacts.digest,
      },
      staticSelfCheck: staticSummary,
      playwrightExitCode,
      scenarios: scenarioResults,
      diagnosticFiles,
      liveProfileSupplied: Boolean(options.liveProfile),
      liveLoginViaStdin: options.liveLoginStdin,
      liveRegistrationViaAdminStdin: options.liveRegisterAdminStdin,
      failure: failure ? redact(failure.stack || failure.message) : null,
      sandboxKept: Boolean(options.keep || failure),
    };
    const summaryPath = path.join(reportDir, 'summary.json');
    await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    try {
      await generateRegressionReport({
        matrix: path.join(ROOT, 'tests', 'packaged-e2e', 'capability-matrix.json'),
        source: path.join(ROOT, 'test-results', 'results.json'),
        packaged: options.profile === 'live' ? '' : summaryPath,
        live: options.profile === 'live' ? summaryPath : '',
        output: path.join(reportDir, 'UClaw-complete-regression-report.zh-CN.md'),
        resultsOutput: path.join(reportDir, 'capability-results.json'),
      });
    } catch (error) {
      const reportFailure = error instanceof Error ? error : new Error(String(error));
      if (!failure) failure = reportFailure;
      summary.status = 'failed';
      summary.failure = redact(reportFailure.stack || reportFailure.message);
      await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    }
    if (!options.keep && !failure) {
      await rm(sandboxRoot, { recursive: true, force: true });
      await rm(runtimeRoot, { recursive: true, force: true });
    } else {
      console.log(`[packaged-regression] Sandbox kept: ${sandboxRoot}`);
      console.log(`[packaged-regression] Runtime sandbox kept: ${runtimeRoot}`);
    }
  }

  if (failure) throw failure;
  console.log('[packaged-regression] PASS');
}

main().catch((error) => {
  console.error(`[packaged-regression] FAIL: ${redact(error instanceof Error ? error.stack || error.message : error)}`);
  process.exit(1);
});
