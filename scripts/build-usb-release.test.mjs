import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createBootstrapEnvironment,
  redactBootstrapOutput,
  runPackagedBootstrapGate,
} from './build-usb-release.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function createFakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 47_001;
  return child;
}

async function createBootstrapExecutableFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'uclaw-bootstrap-unit-'));
  await writeFile(path.join(root, 'UClaw.exe'), 'fixture executable');
  return root;
}

test('USB packaging runs the real main-process Bootstrap gate before writing the final ZIP', async () => {
  const source = await readFile(path.join(SCRIPT_DIR, 'build-usb-release.mjs'), 'utf8');
  const gateCall = source.indexOf('const bootstrapGate = await runPackagedBootstrapGate({ portableRoot });');
  const zipCall = source.indexOf('const buffer = await writeZip(portableRoot, new Date(identity.finalizedAt));');
  assert.ok(gateCall >= 0, 'USB builder must invoke the Bootstrap gate');
  assert.ok(zipCall > gateCall, 'Bootstrap gate must run before the final ZIP is written');
  assert.match(source, /CLAWX_E2E:\s*'1'/u);
  assert.match(source, /--remote-debugging-port=/u);
  assert.match(source, /Captured startup output/u);
  assert.doesNotMatch(source, /run-packaged-regression|test:packaged:win|invoke-live-registration-gate/u);
});

test('USB archive timestamps use the candidate finalization time instead of a fixed calendar date', async () => {
  const source = await readFile(path.join(SCRIPT_DIR, 'build-usb-release.mjs'), 'utf8');
  assert.match(source, /writeZip\(portableRoot, new Date\(identity\.finalizedAt\)\)/u);
  assert.match(source, /zip\.file\(zipPath, fs\.readFileSync\(sourcePath\), \{ date: archiveDate \}\)/u);
  assert.doesNotMatch(source, /2026-01-01/u);
});

test('Bootstrap environment replaces real user state and strips inherited credentials', () => {
  const environment = createBootstrapEnvironment({
    baseEnvironment: {
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\real-user',
      APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\real-user\\AppData\\Local',
      OPENCLAW_CONFIG: 'C:\\Users\\real-user\\.openclaw\\openclaw.json',
      CLAWX_TOKEN: 'do-not-inherit',
      API_KEY: 'do-not-inherit',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--require real-user-hook.js',
    },
    sandboxRoot: 'C:\\isolated-bootstrap',
    portableRoot: 'C:\\release\\win-unpacked',
    cdpPort: 43_101,
    hostApiPort: 43_102,
    gatewayPort: 43_103,
  });

  assert.equal(environment.PATH, 'C:\\Windows\\System32');
  assert.equal(environment.CLAWX_E2E, '1');
  assert.equal(environment.CLAWX_REMOTE_DEBUGGING_PORT, '43101');
  assert.equal(environment.CLAWX_PORT_CLAWX_HOST_API, '43102');
  assert.equal(environment.CLAWX_PORT_OPENCLAW_GATEWAY, '43103');
  assert.equal(environment.API_KEY, undefined);
  assert.equal(environment.CLAWX_TOKEN, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.match(environment.OPENCLAW_CONFIG, /^C:\\isolated-bootstrap\\openclaw-state\\openclaw\.json$/u);
  assert.match(environment.CLAWX_USER_DATA_DIR, /^C:\\isolated-bootstrap\\portable\\UClawData\\clawx$/u);
  assert.equal(environment.CLAWX_PORTABLE_ROOT, 'C:\\release\\win-unpacked');
});

test('Bootstrap gate uses distinct loopback ports and cleans the isolated tree after success', async () => {
  const root = await createBootstrapExecutableFixture();
  const child = createFakeChild();
  const spawned = [];
  const ports = [43_101, 43_102, 43_103];
  try {
    const result = await runPackagedBootstrapGate({
      portableRoot: root,
      platform: 'win32',
      baseEnvironment: { PATH: 'C:\\Windows\\System32' },
      tempParent: root,
      allocatePort: async () => ports.shift(),
      spawnProcess: (executable, args, options) => {
        spawned.push({ executable, args, options });
        return child;
      },
      fetchImpl: async (url) => {
        assert.equal(url, 'http://127.0.0.1:43101/json/list');
        return {
          ok: true,
          status: 200,
          json: async () => [{ type: 'page', url: 'file:///bootstrap.html' }],
        };
      },
      stabilityMs: 0,
      pollIntervalMs: 1,
      terminateProcess: async (process) => {
        process.exitCode = 0;
        process.emit('exit', 0, null);
        process.emit('close', 0, null);
      },
    });

    assert.equal(result.cdpPort, 43_101);
    assert.equal(spawned.length, 1);
    const launch = spawned[0];
    assert.match(launch.args[0], /^--remote-debugging-port=43101$/u);
    assert.match(launch.args[1], /^--user-data-dir=/u);
    assert.equal(launch.options.env.CLAWX_E2E, '1');
    assert.equal(launch.options.env.CLAWX_PORTABLE, '1');
    assert.equal(launch.options.env.CLAWX_PORTABLE_ROOT, root);
    const sandboxRoot = path.dirname(launch.options.env.USERPROFILE);
    assert.equal(launch.options.env.OPENCLAW_CONFIG.startsWith(sandboxRoot), true);
    assert.equal(launch.options.env.USERPROFILE.startsWith(sandboxRoot), true);
    assert.equal(launch.options.env.CLAWX_USER_DATA_DIR.startsWith(sandboxRoot), true);
    assert.equal(launch.options.env.CLAWX_RUNTIME_CACHE_ROOT.startsWith(sandboxRoot), true);
    assert.equal(existsSync(sandboxRoot), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Bootstrap gate reports MODULE_NOT_FOUND without leaking credentials or user paths after an immediate exit', async () => {
  const root = await createBootstrapExecutableFixture();
  const child = createFakeChild();
  const spawned = [];
  const ports = [43_111, 43_112, 43_113];
  try {
    await assert.rejects(
      runPackagedBootstrapGate({
        portableRoot: root,
        platform: 'win32',
        baseEnvironment: {
          PATH: 'C:\\Windows\\System32',
          USERPROFILE: 'C:\\Users\\real-user',
          HOME: 'C:\\Users\\real-user',
          API_KEY: 'real-api-key',
        },
        tempParent: root,
        allocatePort: async () => ports.shift(),
        spawnProcess: (executable, args, options) => {
          spawned.push({ executable, args, options });
          queueMicrotask(() => {
            child.exitCode = 1;
            child.emit('exit', 1, null);
            setTimeout(() => {
              child.stderr.write([
                "Error [MODULE_NOT_FOUND]: Cannot find module 'ms'",
                'at C:\\Users\\Alice\\private\\app.asar\\main.js',
                'Authorization: Bearer super-secret-token',
              ].join(String.fromCharCode(10)));
              child.emit('close', 1, null);
            }, 5);
          });
          return child;
        },
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => [] }),
        timeoutMs: 300,
        stabilityMs: 0,
        pollIntervalMs: 1,
        terminateProcess: async () => undefined,
      }),
      (error) => {
        assert.match(error.message, /MODULE_NOT_FOUND/u);
        assert.match(error.message, /\[secret-redacted\]/u);
        assert.doesNotMatch(error.message, /super-secret-token|real-api-key|C:\\\\Users\\\\Alice|C:\\\\Users\\\\real-user/iu);
        assert.match(error.message, /Cannot find module 'ms'/u);
        return true;
      },
    );
    assert.equal(spawned.length, 1);
    assert.equal(existsSync(path.dirname(spawned[0].options.env.USERPROFILE)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Bootstrap gate rejects a process that exits after CDP appears during the stability window', async () => {
  const root = await createBootstrapExecutableFixture();
  const child = createFakeChild();
  const ports = [43_121, 43_122, 43_123];
  try {
    await assert.rejects(
      runPackagedBootstrapGate({
        portableRoot: root,
        platform: 'win32',
        baseEnvironment: { PATH: 'C:\\Windows\\System32' },
        tempParent: root,
        allocatePort: async () => ports.shift(),
        spawnProcess: () => child,
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => [{ type: 'page', url: 'file:///bootstrap.html' }],
        }),
        sleep: async () => {
          if (child.exitCode === null) {
            child.exitCode = 1;
            child.emit('exit', 1, null);
            child.emit('close', 1, null);
          }
        },
        timeoutMs: 300,
        stabilityMs: 30,
        pollIntervalMs: 2,
        terminateProcess: async () => undefined,
      }),
      /exited during Bootstrap stability check/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Bootstrap output redaction preserves the actionable error while masking sensitive values', () => {
  const redacted = redactBootstrapOutput(
    'MODULE_NOT_FOUND token=secret-value https://alice:password@example.test/x at C:\\Users\\Alice\\x.js',
    { sensitivePaths: [{ value: 'C:\\Users\\Alice', replacement: '[UserPath]' }] },
  );
  assert.match(redacted, /MODULE_NOT_FOUND/u);
  assert.doesNotMatch(redacted, /secret-value|alice:password|C:\\\\Users\\\\Alice/iu);
  assert.match(redacted, /\[secret-redacted\]|\[credentials-redacted\]/u);
});
