// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  COMPACTION_RUNTIME_FILES,
  patchOpenClawCompactionRecoveryRuntime,
  rewriteCompactionBridge,
  rewriteCompactionMiddleware,
  rewriteNativeCompaction,
} from '../../scripts/openclaw-compaction-recovery-patch.mjs';
import { TERMINAL_HELPER_FILE, TERMINAL_HELPER_SOURCE } from '../../scripts/openclaw-provider-terminal-error-patch.mjs';

const roots = new Set<string>();
let runtime: string;
type Compact = (signal: AbortSignal) => Promise<unknown>;
type CompactionParams = Record<string, unknown>;
let middleware: {
  s(compact: Compact, timeoutMs: number, options?: { drainOnCancel?: boolean; abortSignal?: AbortSignal }): Promise<unknown>;
  o(engine: { info: { id: string }; compact: (params: CompactionParams) => Promise<unknown> }, params: CompactionParams, timeoutMs: number): Promise<unknown>;
  r(params: CompactionParams): Promise<string>;
};
beforeAll(async () => {
  runtime = await tempRuntime();
  const originalDelegate = await readFile(join(runtime, 'dist', COMPACTION_RUNTIME_FILES.bridge), 'utf8');
  expect(originalDelegate).not.toContain('abortSignal: params.abortSignal');
  await patchOpenClawCompactionRecoveryRuntime(runtime);
  middleware = await import(pathToFileURL(join(runtime, 'dist', COMPACTION_RUNTIME_FILES.middleware)).href);
}, 30000);

async function tempRuntime(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-compaction-recovery-'));
  roots.add(root);
  await mkdir(join(root, 'dist'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '2026.6.10', type: 'module' }));
  const installed = dirname(await realpath(resolve('node_modules/openclaw/package.json')));
  await symlink(dirname(installed), join(root, 'node_modules'), 'junction');
  for (const entry of await readdir(join(installed, 'dist'), { withFileTypes: true })) {
    if (entry.name === TERMINAL_HELPER_FILE) continue;
    const from = join(installed, 'dist', entry.name);
    const to = join(root, 'dist', entry.name);
    if (entry.isDirectory()) await symlink(from, to, 'junction');
    else if (entry.isFile()) await writeFile(to, await readFile(from));
  }
  await writeFile(join(root, 'dist', TERMINAL_HELPER_FILE), TERMINAL_HELPER_SOURCE);
  return root;
}

afterAll(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

describe('OpenClaw 2026.6.10 compaction recovery patch', () => {
  it('patches all five real runtime chunks and is idempotent', async () => {
    const root = await tempRuntime();

    await expect(patchOpenClawCompactionRecoveryRuntime(root)).resolves.toEqual({
      filesPatched: 5,
      filesScanned: 5,
    });
    const bridge = await readFile(join(root, 'dist', COMPACTION_RUNTIME_FILES.bridge), 'utf8');
    const middleware = await readFile(join(root, 'dist', COMPACTION_RUNTIME_FILES.middleware), 'utf8');
    const native = await readFile(join(root, 'dist', COMPACTION_RUNTIME_FILES.native), 'utf8');
    expect(bridge).toContain('abortSignal: params.abortSignal ?? runtimeContext.abortSignal');
    expect(bridge).toContain('throwUclawTerminalFailure(result.reason);');
    expect(middleware).toContain('drainOnCancel');
    expect(middleware).toContain('pendingCompaction');
    expect(native).toContain('abortSignal: params.abortSignal');
    expect(native).toContain('throwUclawTerminalFailure(result.reason);');
    await expect(patchOpenClawCompactionRecoveryRuntime(root)).resolves.toEqual({
      filesPatched: 0,
      filesScanned: 5,
    });
  });

  it('propagates cancellation and waits for a cooperative compaction to settle', async () => {
    const compactWithSafetyTimeout = middleware.s;
    let settled = false;
    const started = compactWithSafetyTimeout(
      (signal: AbortSignal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => {
          setTimeout(() => {
            settled = true;
            resolve({ ok: true });
          }, 20);
        }, { once: true });
      }),
      5,
      { drainOnCancel: true },
    );
    await expect(started).rejects.toThrow(/timed out|Compaction/u);
    expect(settled).toBe(true);
  }, 30000);

  it('fails closed for an unsupported runtime layout before writing', async () => {
    const root = await tempRuntime();
    const target = join(root, 'dist', COMPACTION_RUNTIME_FILES.bridge);
    const before = await readFile(target, 'utf8');
    await writeFile(target, before.replace('force: params.force,', 'force: unsupportedForce,'));
    await expect(patchOpenClawCompactionRecoveryRuntime(root)).rejects.toThrow(
      'Unsupported compaction recovery layout',
    );
    expect(await readFile(target, 'utf8')).toContain('force: unsupportedForce,');
  });

  it('passes cancellation across the real delegate and releases the actual session lock before recovery', async () => {
    const root = await tempRuntime();
    const lockModule = await import(pathToFileURL(join(root, 'dist', 'session-write-lock-81JXiIgr.js')).href);
    const sessionFile = join(root, 'session.jsonl');
    const original = '{"task":"customer-task","completed":"result.pptx"}\n';
    await writeFile(sessionFile, original);
    // Replace only the expensive model/session entrypoint. The complete delegate,
    // timeout wrapper and on-disk lock implementation remain the installed code.
    await writeFile(join(root, 'dist', 'compact.runtime.js'), `
      import { t as acquire } from './session-write-lock-81JXiIgr.js';
      export async function compactEmbeddedAgentSessionDirect(params) {
        const lock = await acquire({sessionFile: params.sessionFile, timeoutMs: 200});
        try {
          await new Promise(resolve => {
            const finish = () => setTimeout(resolve, 20);
            if (params.abortSignal?.aborted) finish();
            else params.abortSignal?.addEventListener('abort', finish, {once:true});
          });
          return {ok:false, compacted:false, reason:'cancelled'};
        } finally { await lock.release(); }
      }
    `);
    await patchOpenClawCompactionRecoveryRuntime(root);
    const delegate = await import(pathToFileURL(join(root, 'dist', COMPACTION_RUNTIME_FILES.bridge)).href);
    const wrapper = await import(pathToFileURL(join(root, 'dist', COMPACTION_RUNTIME_FILES.middleware)).href);
    await expect(wrapper.o({ info: {id:'legacy'}, compact: delegate.n }, {
      sessionId:'customer-session', sessionFile,
    }, 40)).rejects.toThrow(/timed out/);
    const next = await lockModule.t({sessionFile, timeoutMs:200});
    await next.release();
    expect(await readFile(sessionFile, 'utf8')).toBe(original);
    expect(existsSync(`${sessionFile}.lock`)).toBe(false);
  }, 30000);

  it('returns promptly for non-cooperating third-party engines', async () => {
    const compact = vi.fn(() => new Promise(() => {}));
    await expect(middleware.o({info:{id:'third-party'}, compact}, {}, 5)).rejects.toThrow(/timed out/);
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('stops recovery when native cleanup remains pending past its bounded grace period', async () => {
    vi.useFakeTimers();
    try {
      const pending = middleware.s(() => new Promise(() => {}), 5, {drainOnCancel:true});
      const result = expect(pending).rejects.toMatchObject({
        code:'COMPACTION_CLEANUP_PENDING',message:expect.stringContaining('session file locked'),
      });
      await vi.advanceTimersByTimeAsync(5005);
      await result;
    } finally { vi.useRealTimers(); }
  });

  it('aborts summarization instead of returning a size-only success', async () => {
    const controller = new AbortController();
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(middleware.r({
      messages:[{role:'user',content:'task customer-task completed result.pptx',timestamp:Date.now()}],
      model:{id:'test',api:'not-used',provider:'local',contextWindow:32000},
      reserveTokens:512, maxChunkTokens:20000, contextWindow:32000,
      signal:controller.signal,
    })).rejects.toThrow();
  });

  it.each(['insufficient_user_quota', 'SUBSCRIPTION_UNAVAILABLE'])(
    'does not retry or turn terminal summary error %s into a successful fallback', async (code) => {
      const registry = await import(pathToFileURL(join(runtime, 'dist', 'stream-iBy3TeLb.js')).href);
      const streams = await import(pathToFileURL(join(runtime, 'dist', 'event-stream-ReMmOTzX.js')).href);
      const api = 'uclaw-compaction-fixture';
      const stream = vi.fn(() => {
        const result = new streams.t();
        result.push({type:'error',reason:'error',error:{role:'assistant',content:[],stopReason:'error',errorMessage:code}});
        return result;
      });
      registry.c({api,stream,streamSimple:stream}, 'uclaw-compaction-fixture');
      try {
        await expect(middleware.r({
          messages:[{role:'user',content:'task customer-task completed result.pptx',timestamp:Date.now()}],
          model:{id:'test',api,provider:'local',contextWindow:32000},apiKey:'test-only',
          reserveTokens:512,maxChunkTokens:20000,contextWindow:32000,
        })).rejects.toMatchObject({code});
        expect(stream).toHaveBeenCalledTimes(1);
      } finally { registry.l('uclaw-compaction-fixture'); }
    },
  );

  it('retains the model-produced task and completed-file identifiers on successful compaction', async () => {
    const registry = await import(pathToFileURL(join(runtime, 'dist', 'stream-iBy3TeLb.js')).href);
    const streams = await import(pathToFileURL(join(runtime, 'dist', 'event-stream-ReMmOTzX.js')).href);
    const api = 'uclaw-compaction-success';
    const summary = 'customer-task: result.pptx completed; next inspect output';
    const stream = vi.fn(() => {
      const result = new streams.t();
      result.push({type:'done',reason:'stop',message:{
        role:'assistant',content:[{type:'text',text:summary}],stopReason:'stop',
      }});
      return result;
    });
    registry.c({api,stream,streamSimple:stream}, api);
    try {
      await expect(middleware.r({
        messages:[{role:'user',content:summary,timestamp:Date.now()}],
        model:{id:'test',api,provider:'local',contextWindow:32000},apiKey:'test-only',
        reserveTokens:512,maxChunkTokens:20000,contextWindow:32000,
      })).resolves.toBe(summary);
      expect(stream).toHaveBeenCalledTimes(1);
    } finally { registry.l(api); }
  });

  it('exports rewrite helpers for deterministic source-level checks', () => {
    expect(existsSync(resolve('scripts/openclaw-compaction-recovery-patch.mjs'))).toBe(true);
    expect(rewriteCompactionBridge).toBeTypeOf('function');
    expect(rewriteCompactionMiddleware).toBeTypeOf('function');
    expect(rewriteNativeCompaction).toBeTypeOf('function');
  });
});
