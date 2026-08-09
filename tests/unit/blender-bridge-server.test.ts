import type { ChildProcess } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@electron/utils/portable-mode', () => ({
  getPortableModeInfo: () => ({ runtimeOpenClawStateDir: null }),
}));

import {
  getBlenderBridgeEnvironment,
  startBlenderBridgeServer,
  stopBlenderBridgeServer,
} from '@electron/services/blender/bridge-server';
import { BlenderJobService } from '@electron/services/blender/job-service';

function responseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function request(origin: string, token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
}

describe('Blender loopback bridge', () => {
  it('uses a random loopback endpoint and per-start secret without mutating process.env', async () => {
    const beforeOrigin = process.env.CLAWX_HOST_API_ORIGIN;
    const beforeToken = process.env.CLAWX_HOST_API_TOKEN;
    const first = await startBlenderBridgeServer();

    expect(new URL(first.CLAWX_HOST_API_ORIGIN).hostname).toBe('127.0.0.1');
    expect(Number(new URL(first.CLAWX_HOST_API_ORIGIN).port)).toBeGreaterThan(0);
    expect(first.CLAWX_HOST_API_TOKEN).toMatch(/^[a-f0-9]{64}$/u);
    expect(getBlenderBridgeEnvironment()).toEqual(first);
    expect(process.env.CLAWX_HOST_API_ORIGIN).toBe(beforeOrigin);
    expect(process.env.CLAWX_HOST_API_TOKEN).toBe(beforeToken);

    await stopBlenderBridgeServer();
    const second = await startBlenderBridgeServer();
    expect(second.CLAWX_HOST_API_TOKEN).not.toBe(first.CLAWX_HOST_API_TOKEN);
    await stopBlenderBridgeServer();
  });

  it('requires the bearer token and exposes only the four Blender routes', async () => {
    const environment = await startBlenderBridgeServer();
    const { CLAWX_HOST_API_ORIGIN: origin, CLAWX_HOST_API_TOKEN: token } = environment;

    const missingToken = await fetch(`${origin}/api/blender/capabilities`);
    expect(missingToken.status).toBe(401);

    const invalidToken = await request(origin, 'invalid', '/api/blender/capabilities');
    expect(invalidToken.status).toBe(401);

    const capabilities = await request(origin, token, '/api/blender/capabilities');
    expect(capabilities.status).toBe(200);
    expect(await responseJson(capabilities)).toMatchObject({ success: true });

    for (const [path, method] of [
      ['/api/blender/jobs', 'GET'],
      ['/api/blender/jobs/job-1/cancel', 'POST'],
      ['/api/runtime/capabilities', 'GET'],
      ['/api/blender/unknown', 'GET'],
    ] as const) {
      const response = await request(origin, token, path, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }

    await stopBlenderBridgeServer();
  });

  it('bounds waitMs, rejects oversized bodies and shuts down the injected job service', async () => {
    const job = { jobId: 'job-1', status: 'queued' };
    const jobService = {
      capabilities: vi.fn().mockResolvedValue({ available: false }),
      create: vi.fn().mockResolvedValue({ job, idempotent: false }),
      waitForTerminal: vi.fn().mockResolvedValue(job),
      get: vi.fn().mockResolvedValue(job),
      repair: vi.fn().mockResolvedValue({ job, idempotent: false }),
      shutdown: vi.fn(),
    };
    const environment = await startBlenderBridgeServer({ jobService });
    const { CLAWX_HOST_API_ORIGIN: origin, CLAWX_HOST_API_TOKEN: token } = environment;

    const created = await request(origin, token, '/api/blender/jobs', {
      method: 'POST',
      body: JSON.stringify({
        clientRequestId: 'request-1',
        sceneSpec: { schema: 'uclaw.blender.scene/v1', title: 'test', objects: [{ id: 'hero', primitive: 'cube' }] },
        waitMs: 999_999,
      }),
    });
    expect(created.status).toBe(202);
    expect(jobService.waitForTerminal).toHaveBeenCalledWith('job-1', 90_000);

    const oversized = await request(origin, token, '/api/blender/jobs', {
      method: 'POST',
      body: JSON.stringify({ clientRequestId: 'request-2', padding: 'x'.repeat(1_100_000) }),
    });
    expect(oversized.status).toBe(413);

    await stopBlenderBridgeServer();
    expect(jobService.shutdown).toHaveBeenCalledOnce();
  });
});

describe('Blender job lifecycle', () => {
  it('terminates the active Blender process and prevents queued work from starting during shutdown', async () => {
    const service = new BlenderJobService();
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
    } as unknown as ChildProcess;
    const execute = vi.fn();
    const internals = service as unknown as {
      activeChild?: ChildProcess;
      queue: string[];
      drain: () => Promise<void>;
      execute: typeof execute;
    };
    internals.activeChild = child;
    internals.queue.push('queued-job');
    internals.execute = execute;

    await service.shutdown();
    await internals.drain();

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(execute).not.toHaveBeenCalled();
  });
});
