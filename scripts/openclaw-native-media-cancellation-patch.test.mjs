import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

import {
  patchOpenClawNativeMediaCancellationContent,
  patchOpenClawNativeMediaCancellationRuntime,
} from './openclaw-native-media-cancellation-patch.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OPENCLAW_DIST = join(ROOT, 'node_modules', 'openclaw', 'dist');

function preparePatchedRuntimeFixture() {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'uclaw-native-media-cancel-'));
  const categoryFiles = new Map();
  for (const entry of readdirSync(OPENCLAW_DIST, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
    const sourcePath = join(OPENCLAW_DIST, entry.name);
    const content = readFileSync(sourcePath, 'utf8');
    const result = patchOpenClawNativeMediaCancellationContent(content, sourcePath);
    if (result.category) {
      cpSync(sourcePath, join(fixtureDir, entry.name));
      categoryFiles.set(result.category, entry.name);
    } else {
      symlinkSync(sourcePath, join(fixtureDir, entry.name));
    }
  }
  return { fixtureDir, categoryFiles };
}

async function listenDelayedServer() {
  let sawRequestResolve;
  let sawAbortResolve;
  const sawRequest = new Promise((resolvePromise) => {
    sawRequestResolve = resolvePromise;
  });
  const sawAbort = new Promise((resolvePromise) => {
    sawAbortResolve = resolvePromise;
  });
  const server = createServer((req) => {
    sawRequestResolve();
    req.once('aborted', () => sawAbortResolve());
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return {
    server,
    sawRequest,
    sawAbort,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function listenStreamingServer() {
  let sawHeadersResolve;
  let sawDisconnectResolve;
  const sawHeaders = new Promise((resolvePromise) => {
    sawHeadersResolve = resolvePromise;
  });
  const sawDisconnect = new Promise((resolvePromise) => {
    sawDisconnectResolve = resolvePromise;
  });
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'transfer-encoding': 'chunked',
    });
    res.flushHeaders();
    sawHeadersResolve();
    const interval = setInterval(() => {
      res.write(Buffer.alloc(64 * 1024, 1));
    }, 20);
    res.once('close', () => {
      clearInterval(interval);
      sawDisconnectResolve();
    });
  });
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  return {
    server,
    sawHeaders,
    sawDisconnect,
    url: `http://127.0.0.1:${address.port}/video`,
  };
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

test('patches the bundled OpenClaw media cancellation chain exactly once and remains idempotent', () => {
  const { fixtureDir, categoryFiles } = preparePatchedRuntimeFixture();
  try {
    const first = patchOpenClawNativeMediaCancellationRuntime(fixtureDir, { logger: { log() {} } });
    // postinstall patches the installed OpenClaw in normal dev/CI setups. The
    // fixture therefore supports both a pristine install and an already-patched one.
    assert.equal(first.patchedFiles + first.alreadyPatchedFiles, 7);
    assert.deepEqual(new Set(categoryFiles.keys()), new Set([
      'media-tool',
      'task-registry',
      'image-runtime',
      'video-runtime',
      'fetch-timeout',
      'provider-transport',
      'openai-video-provider',
    ]));

    const second = patchOpenClawNativeMediaCancellationRuntime(fixtureDir, { logger: { log() {} } });
    assert.equal(second.patchedFiles, 0);
    assert.equal(second.alreadyPatchedFiles, 7);

    const mediaTool = readFileSync(join(fixtureDir, categoryFiles.get('media-tool')), 'utf8');
    assert.match(mediaTool, /registerUClawNativeMediaTaskAbortController\(handle\)/);
    assert.match(mediaTool, /signal: params\.taskHandle\?\.abortController\?\.signal/);
    assert.match(mediaTool, /if \(!params\.handle \|\| isUClawNativeMediaTaskCancelled\(params\.handle\)\) return true/);
    assert.match(mediaTool, /if \(isUClawNativeMediaTaskCancelled\(params\.handle\)\) return false/);
    assert.equal((mediaTool.match(/if \(isUClawNativeMediaTaskCancelled\(params\.handle\)\) return false/g) ?? []).length, 2);
    assert.match(mediaTool, /throwIfUClawNativeMediaTaskCancelled\(params\.taskHandle\)/);
    assert.match(mediaTool, /Background task started for image generation \(\$\{taskHandle\.taskId\}\)/);
    assert.match(mediaTool, /Background task started for video generation \(\$\{taskHandle\.taskId\}\)/);

    const taskRegistry = readFileSync(join(fixtureDir, categoryFiles.get('task-registry')), 'utf8');
    assert.match(taskRegistry, /abortUClawNativeMediaTaskById\(task\.taskId, params\.reason\?\.trim\(\)\)/);

    const openAIVideo = readFileSync(join(fixtureDir, categoryFiles.get('openai-video-provider')), 'utf8');
    assert.equal((openAIVideo.match(/signal: req\.signal/g) ?? []).length, 5);

    const mediaHelperStart = mediaTool.indexOf('const UCLAW_NATIVE_MEDIA_TASK_CANCELLATION');
    const mediaHelperEnd = mediaTool.indexOf('const MEDIA_DIRECT_FALLBACK_DELIVERY_REASONS', mediaHelperStart);
    const taskHelperStart = taskRegistry.indexOf('const UCLAW_NATIVE_MEDIA_TASK_ABORT_REGISTRY');
    const taskHelperEnd = taskRegistry.indexOf('async function cancelTaskById(params)', taskHelperStart);
    const context = { AbortController, Map, Symbol, Error };
    vm.runInNewContext(`
      ${mediaTool.slice(mediaHelperStart, mediaHelperEnd)}
      ${taskRegistry.slice(taskHelperStart, taskHelperEnd)}
      const handle = { taskId: "task-1", runId: "run-1" };
      registerUClawNativeMediaTaskAbortController(handle);
      const found = abortUClawNativeMediaTaskById("task-1", "operator-stop");
      globalThis.__result = {
        found,
        aborted: handle.abortController.signal.aborted,
        reason: handle.abortController.signal.reason,
        cancelled: isUClawNativeMediaTaskCancelled(handle),
      };
    `, context);
    assert.deepEqual(
      JSON.parse(JSON.stringify(context.__result)),
      { found: true, aborted: true, reason: 'operator-stop', cancelled: true },
    );
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('patched OpenClaw provider transport aborts an in-flight POST with the task signal', async () => {
  const { fixtureDir, categoryFiles } = preparePatchedRuntimeFixture();
  const { server, sawRequest, sawAbort, baseUrl } = await listenDelayedServer();
  try {
    patchOpenClawNativeMediaCancellationRuntime(fixtureDir, { logger: { log() {} } });
    const sharedPath = join(fixtureDir, categoryFiles.get('provider-transport'));
    const shared = await import(`${pathToFileURL(sharedPath).href}?test=${Date.now()}`);
    const controller = new AbortController();
    const request = shared.c({
      url: `${baseUrl}/videos`,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { prompt: 'hold' },
      timeoutMs: 10_000,
      fetchFn: fetch,
      allowPrivateNetwork: true,
      signal: controller.signal,
    });
    await sawRequest;
    controller.abort(new Error('task-cancelled'));
    await assert.rejects(request, /task-cancelled|abort/i);
    await Promise.race([
      sawAbort,
      new Promise((_, reject) => setTimeout(() => reject(new Error('provider request was not aborted')), 1_000)),
    ]);
  } finally {
    await closeServer(server);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('patched OpenClaw download transport keeps task cancellation active after response headers', async () => {
  const { fixtureDir, categoryFiles } = preparePatchedRuntimeFixture();
  const {
    server,
    sawHeaders,
    sawDisconnect,
    url,
  } = await listenStreamingServer();
  try {
    patchOpenClawNativeMediaCancellationRuntime(fixtureDir, { logger: { log() {} } });
    const sharedPath = join(fixtureDir, categoryFiles.get('provider-transport'));
    const shared = await import(`${pathToFileURL(sharedPath).href}?download=${Date.now()}`);
    const controller = new AbortController();
    const response = await shared.i({
      url,
      init: {
        method: 'GET',
        signal: controller.signal,
      },
      timeoutMs: 10_000,
      fetchFn: fetch,
      provider: 'openai',
      requestFailedMessage: 'download failed',
    });
    await sawHeaders;
    const body = response.arrayBuffer();
    controller.abort(new Error('task-cancelled-after-headers'));
    await assert.rejects(body, /task-cancelled|abort/i);
    await Promise.race([
      sawDisconnect,
      new Promise((_, reject) => setTimeout(() => reject(new Error('download connection was not aborted')), 1_000)),
    ]);
  } finally {
    await closeServer(server);
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('clawx-openai-image aborts the upstream request when its task signal is cancelled', async () => {
  const { server, sawRequest, sawAbort, baseUrl } = await listenDelayedServer();
  try {
    const pluginPath = join(ROOT, 'resources', 'openclaw-plugins', 'clawx-openai-image', 'index.mjs');
    const plugin = (await import(`${pathToFileURL(pluginPath).href}?test=${Date.now()}`)).default;
    let provider;
    plugin.register({
      registerImageGenerationProvider(value) {
        provider = value;
      },
    });
    assert.ok(provider);

    const controller = new AbortController();
    const request = provider.generateImage({
      cfg: {
        models: {
          providers: {
            'clawx-openai-image': {
              apiKey: 'test-key',
              baseUrl,
            },
          },
        },
      },
      prompt: 'hold',
      model: 'gpt-image-2',
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    await sawRequest;
    controller.abort(new Error('task-cancelled'));
    await assert.rejects(request, /task-cancelled|abort/i);
    await Promise.race([
      sawAbort,
      new Promise((_, reject) => setTimeout(() => reject(new Error('image request was not aborted')), 1_000)),
    ]);
  } finally {
    await closeServer(server);
  }
});
