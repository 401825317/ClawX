import { mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAttachmentVideoStreamService,
  type AttachmentVideoStreamService,
  type AttachmentVideoStreamSource,
} from '../../electron/services/attachment-video-stream';
import { AcpSessionAccessRegistry } from '../../electron/services/acp-session-access-registry';

const temporaryDirectories: string[] = [];
const services: AttachmentVideoStreamService[] = [];

type HarnessOptions = {
  bytes?: Buffer;
  maxEntries?: number;
  idleTtlMs?: number;
  now?: () => number;
  randomToken?: () => string;
};

async function createHarness(options: HarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'clawx-video-stream-'));
  temporaryDirectories.push(root);
  const workspaceRoot = join(root, 'workspace');
  await mkdir(workspaceRoot);
  const videoPath = join(workspaceRoot, 'clip.mp4');
  const bytes = options.bytes ?? Buffer.from('0123456789abcdef', 'utf8');
  await writeFile(videoPath, bytes);

  const accessRegistry = new AcpSessionAccessRegistry();
  const grant = await accessRegistry.prepareGrant({
    sessionKey: 'agent:main:stream-session',
    generation: 1,
    workspaceRoot,
    executionCwd: workspaceRoot,
  });
  accessRegistry.commitGrant(grant);
  const ref = {
    sessionKey: grant.sessionKey,
    generation: grant.generation,
    uri: videoPath,
  };
  const openSource = vi.fn(async (): Promise<AttachmentVideoStreamSource> => ({
    handle: await open(videoPath, 'r'),
    size: bytes.length,
    mimeType: 'video/mp4; charset=binary',
  }));
  const service = createAttachmentVideoStreamService({
    accessRegistry,
    openSource,
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.idleTtlMs === undefined ? {} : { idleTtlMs: options.idleTtlMs }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.randomToken ? { randomToken: options.randomToken } : {}),
  });
  services.push(service);
  return { accessRegistry, bytes, grant, openSource, ref, service, videoPath, workspaceRoot };
}

function requireCreated(result: Awaited<ReturnType<AttachmentVideoStreamService['create']>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Expected stream creation to succeed: ${result.error}`);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('attachment video stream service', () => {
  it('creates opaque random URLs and streams the full file without a binary IPC copy', async () => {
    const { bytes, openSource, ref, service, videoPath } = await createHarness();
    const first = requireCreated(await service.create(ref));
    const second = requireCreated(await service.create(ref));

    expect(first.streamId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.streamId).not.toBe(first.streamId);
    expect(first.url).toBe(`uclaw-media://attachment/${first.streamId}`);
    expect(first.url).not.toContain(videoPath);
    expect(first).toMatchObject({ mimeType: 'video/mp4', size: bytes.length });

    const response = await service.handle(new Request(first.url));
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    expect(openSource).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['bounded', 'bytes=2-5', '2345', 'bytes 2-5/16'],
    ['open ended', 'bytes=12-', 'cdef', 'bytes 12-15/16'],
    ['suffix', 'bytes=-3', 'def', 'bytes 13-15/16'],
    ['clamped end', 'bytes=14-999', 'ef', 'bytes 14-15/16'],
  ])('serves a single %s range with 206 metadata', async (_label, range, expected, contentRange) => {
    const { ref, service } = await createHarness();
    const created = requireCreated(await service.create(ref));

    const response = await service.handle(new Request(created.url, { headers: { Range: range } }));

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-length')).toBe(String(expected.length));
    expect(Buffer.from(await response.arrayBuffer()).toString('utf8')).toBe(expected);
  });

  it('supports HEAD with full and ranged response headers without a body', async () => {
    const { bytes, ref, service } = await createHarness();
    const created = requireCreated(await service.create(ref));

    const full = await service.handle(new Request(created.url, { method: 'HEAD' }));
    const ranged = await service.handle(new Request(created.url, {
      method: 'HEAD',
      headers: { Range: 'bytes=4-7' },
    }));

    expect(full.status).toBe(200);
    expect(full.headers.get('content-length')).toBe(String(bytes.length));
    expect((await full.arrayBuffer()).byteLength).toBe(0);
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe('bytes 4-7/16');
    expect(ranged.headers.get('content-length')).toBe('4');
    expect((await ranged.arrayBuffer()).byteLength).toBe(0);
  });

  it.each([
    'bytes=',
    'bytes=3-2',
    'bytes=0-1,3-4',
    'bytes=-0',
    'bytes=99-',
    'items=0-1',
    'bytes=999999999999999999999-',
  ])('returns 416 for unsupported or unsatisfiable range %s', async (range) => {
    const { bytes, ref, service } = await createHarness();
    const created = requireCreated(await service.create(ref));

    const response = await service.handle(new Request(created.url, { headers: { Range: range } }));

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe(`bytes */${bytes.length}`);
    expect(response.headers.get('content-length')).toBe('0');
  });

  it('rejects unknown tokens and non-GET/HEAD methods without opening a source', async () => {
    const { openSource, ref, service } = await createHarness();
    const created = requireCreated(await service.create(ref));
    openSource.mockClear();

    const unknown = await service.handle(new Request('uclaw-media://attachment/not-issued'));
    const malformed = await service.handle(new Request('uclaw-media://other/not-issued'));
    const method = await service.handle(new Request(created.url, { method: 'POST' }));

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(method.status).toBe(405);
    expect(method.headers.get('allow')).toBe('GET, HEAD');
    expect(openSource).not.toHaveBeenCalled();
  });

  it('rejects malformed protocol request objects before resolving a source', async () => {
    const { openSource, service } = await createHarness();

    const response = await service.handle({ method: 'GET', url: 'uclaw-media://attachment/x' });

    expect(response.status).toBe(404);
    expect(openSource).not.toHaveBeenCalled();
  });

  it('uses LRU capacity eviction and rejects idle-expired tokens', async () => {
    let currentTime = 1_000;
    let sequence = 0;
    const { ref, service } = await createHarness({
      maxEntries: 2,
      idleTtlMs: 50,
      now: () => currentTime,
      randomToken: () => `stream_${++sequence}`,
    });
    const first = requireCreated(await service.create(ref));
    const second = requireCreated(await service.create(ref));

    const touchFirst = await service.handle(new Request(first.url, { method: 'HEAD' }));
    expect(touchFirst.status).toBe(200);
    const third = requireCreated(await service.create(ref));

    expect((await service.handle(new Request(second.url))).status).toBe(404);
    expect((await service.handle(new Request(first.url, { method: 'HEAD' }))).status).toBe(200);
    expect((await service.handle(new Request(third.url, { method: 'HEAD' }))).status).toBe(200);

    currentTime += 51;
    expect((await service.handle(new Request(first.url))).status).toBe(404);
    expect((await service.handle(new Request(third.url))).status).toBe(404);
  });

  it('clears tokens and destroys active streams when the grant changes', async () => {
    const { accessRegistry, grant, ref } = await createHarness();
    const activeStream = new PassThrough();
    const validationHandle = {
      close: vi.fn().mockResolvedValue(undefined),
      createReadStream: vi.fn(),
    };
    const playbackHandle = {
      close: vi.fn().mockResolvedValue(undefined),
      createReadStream: vi.fn(() => activeStream),
    };
    const openSource = vi.fn()
      .mockResolvedValueOnce({ handle: validationHandle, size: 8, mimeType: 'video/mp4' })
      .mockResolvedValueOnce({ handle: playbackHandle, size: 8, mimeType: 'video/mp4' });
    const service = createAttachmentVideoStreamService({
      accessRegistry,
      openSource,
      randomToken: () => 'active_stream',
    });
    services.push(service);
    const created = requireCreated(await service.create(ref));
    const response = await service.handle(new Request(created.url));
    expect(response.status).toBe(200);
    expect(activeStream.destroyed).toBe(false);

    accessRegistry.commitGrant({ ...grant, generation: 2 });

    expect(activeStream.destroyed).toBe(true);
    expect((await service.handle(new Request(created.url))).status).toBe(404);
  });

  it('closes a source when generation changes while a request is opening it', async () => {
    const { accessRegistry, grant, ref, videoPath } = await createHarness();
    const opening = deferred<AttachmentVideoStreamSource>();
    const openSource = vi.fn()
      .mockImplementationOnce(async () => ({
        handle: await open(videoPath, 'r'),
        size: 16,
        mimeType: 'video/mp4',
      }))
      .mockImplementationOnce(() => opening.promise);
    const service = createAttachmentVideoStreamService({
      accessRegistry,
      openSource,
      randomToken: () => 'delayed_stream',
    });
    services.push(service);
    const created = requireCreated(await service.create(ref));
    const responsePromise = service.handle(new Request(created.url));
    const delayedClose = vi.fn().mockResolvedValue(undefined);

    accessRegistry.commitGrant({ ...grant, generation: 2 });
    opening.resolve({
      handle: { close: delayedClose, createReadStream: vi.fn() },
      size: 16,
      mimeType: 'video/mp4',
    });

    expect((await responsePromise).status).toBe(404);
    expect(delayedClose).toHaveBeenCalledTimes(1);
  });

  it('release revokes the URL and interrupts its active stream', async () => {
    const { accessRegistry, ref } = await createHarness();
    const activeStream = new PassThrough();
    const openSource = vi.fn()
      .mockResolvedValueOnce({
        handle: { close: vi.fn().mockResolvedValue(undefined), createReadStream: vi.fn() },
        size: 4,
        mimeType: 'video/mp4',
      })
      .mockResolvedValueOnce({
        handle: {
          close: vi.fn().mockResolvedValue(undefined),
          createReadStream: vi.fn(() => activeStream),
        },
        size: 4,
        mimeType: 'video/mp4',
      });
    const service = createAttachmentVideoStreamService({
      accessRegistry,
      openSource,
      randomToken: () => 'released_stream',
    });
    services.push(service);
    const created = requireCreated(await service.create(ref));
    await service.handle(new Request(created.url));

    expect(service.release(created.streamId)).toBe(true);
    expect(service.release(created.streamId)).toBe(false);
    expect(activeStream.destroyed).toBe(true);
    expect((await service.handle(new Request(created.url))).status).toBe(404);
  });

  it('dispose unsubscribes authorization cleanup and permanently revokes playback', async () => {
    const unsubscribe = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const accessRegistry = {
      get: vi.fn(() => ({
        sessionKey: 'agent:main:stream-session',
        generation: 1,
        workspaceRoot: '/workspace',
        executionCwd: '/workspace',
      })),
      subscribe: vi.fn(() => unsubscribe),
    };
    const service = createAttachmentVideoStreamService({
      accessRegistry,
      openSource: vi.fn().mockResolvedValue({
        handle: { close, createReadStream: vi.fn() },
        size: 4,
        mimeType: 'video/mp4',
      }),
      randomToken: () => 'disposed_stream',
    });
    services.push(service);
    const ref = {
      sessionKey: 'agent:main:stream-session',
      generation: 1,
      uri: '/workspace/clip.mp4',
    };
    const created = requireCreated(await service.create(ref));

    service.dispose();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(await service.create(ref)).toEqual({ ok: false, error: 'operationFailed' });
    expect((await service.handle(new Request(created.url))).status).toBe(404);
  });

  it('rejects unsupported media and preserves recognized attachment errors', async () => {
    const { accessRegistry, ref } = await createHarness();
    const unsupportedClose = vi.fn().mockResolvedValue(undefined);
    const unsupported = createAttachmentVideoStreamService({
      accessRegistry,
      openSource: vi.fn().mockResolvedValue({
        handle: { close: unsupportedClose, createReadStream: vi.fn() },
        size: 10,
        mimeType: 'text/plain',
      }),
    });
    const stale = createAttachmentVideoStreamService({
      accessRegistry,
      openSource: vi.fn().mockRejectedValue({ code: 'unavailable' }),
    });
    services.push(unsupported, stale);

    await expect(unsupported.create(ref)).resolves.toEqual({ ok: false, error: 'unsupportedMedia' });
    expect(unsupportedClose).toHaveBeenCalledTimes(1);
    await expect(stale.create(ref)).resolves.toEqual({ ok: false, error: 'unavailable' });
  });
});
