import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { download } from './download-bundled-ffmpeg.mjs';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server address is unavailable');
  return `http://127.0.0.1:${address.port}`;
}

test('FFmpeg download retries interrupted bodies and replaces the target only after completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-ffmpeg-download-'));
  const target = join(root, 'asset.bin');
  let attempts = 0;
  const server = createServer((request, response) => {
    attempts += 1;
    response.writeHead(200, { 'content-length': '13' });
    if (attempts === 1) {
      response.write('partial');
      response.socket?.destroy();
      return;
    }
    response.end('complete-body');
  });

  try {
    await writeFile(target, 'previous-body');
    const origin = await listen(server);
    await download(`${origin}/asset.bin`, target, 2);
    assert.equal(await readFile(target, 'utf8'), 'complete-body');
    assert.equal(attempts, 2);
    await assert.rejects(readFile(`${target}.partial`));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('FFmpeg download preserves the previous target when every response body fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'uclaw-ffmpeg-download-'));
  const target = join(root, 'asset.bin');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '13' });
    response.write('partial');
    response.socket?.destroy();
  });

  try {
    await writeFile(target, 'previous-body');
    const origin = await listen(server);
    await assert.rejects(download(`${origin}/asset.bin`, target, 2));
    assert.equal(await readFile(target, 'utf8'), 'previous-body');
    await assert.rejects(readFile(`${target}.partial`));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
