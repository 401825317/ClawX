import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  patchOpenClawNativeImageDeliveryContent,
  patchOpenClawNativeImageDeliveryRuntime,
} from './openclaw-native-image-delivery-patch.mjs';
import { normalizeGeneratedImageForDelivery } from './openclaw-native-image-delivery-runtime.mjs';

const SAVE_ANCHOR = '\tconst mediaMaxBytes = resolveGeneratedMediaMaxBytes(params.effectiveCfg, "image");\n\tconst savedImages = await Promise.all(result.images.map((image) => saveMediaBuffer(image.buffer, image.mimeType, "tool-image-generation", mediaMaxBytes, params.filename || image.fileName)));';

test('patch injects generated-image delivery normalization before persistence', () => {
  const fixture = `async function executeImageGenerationJob(params) {\n${SAVE_ANCHOR}\n}`;
  const result = patchOpenClawNativeImageDeliveryContent(fixture);
  assert.equal(result.changed, true);
  assert.match(result.content, /UCLAW_NATIVE_IMAGE_DELIVERY/u);
  assert.match(result.content, /normalizeGeneratedImageForDeliveryUClaw/u);
  assert.match(result.content, /params\.providerOptions\?\.openai\?\.outputCompression/u);
  assert.equal(patchOpenClawNativeImageDeliveryContent(result.content).changed, false);
});

test('runtime patch copies the delivery helper beside the OpenClaw runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'uclaw-image-delivery-'));
  try {
    const runtimePath = join(dir, 'openclaw-tools-fixture.js');
    writeFileSync(runtimePath, `async function executeImageGenerationJob(params) {\n${SAVE_ANCHOR}\n}`, 'utf8');
    const result = patchOpenClawNativeImageDeliveryRuntime(dir, { logger: { log() {} } });
    assert.equal(result.patchedFiles, 1);
    assert.match(readFileSync(runtimePath, 'utf8'), /UCLAW_NATIVE_IMAGE_DELIVERY/u);
    assert.match(readFileSync(join(dir, 'uclaw-native-image-delivery-runtime.mjs'), 'utf8'), /normalizeGeneratedImageForDelivery/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('oversized PNG is converted to the requested JPEG below the delivery cap', async () => {
  const width = 1400;
  const height = 2400;
  const noise = Buffer.alloc(width * height * 3);
  for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 31 + index / 7) % 256;
  const png = await sharp(noise, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const maxBytes = 700_000;
  assert.ok(png.byteLength > maxBytes);

  const normalized = await normalizeGeneratedImageForDelivery({
    buffer: png,
    mimeType: 'image/png',
    fileName: 'poster.png',
  }, {
    maxBytes,
    outputFormat: 'jpeg',
    outputCompression: 82,
    background: 'opaque',
  });

  assert.equal(normalized.mimeType, 'image/jpeg');
  assert.equal(normalized.fileName, 'poster.jpg');
  assert.ok(normalized.buffer.byteLength <= maxBytes);
  assert.equal((await sharp(normalized.buffer).metadata()).format, 'jpeg');
  assert.equal(normalized.deliveryNormalization.sourceBytes, png.byteLength);
});

test('a small provider-format mismatch is still converted to the requested format', async () => {
  const png = await sharp({
    create: {
      width: 64,
      height: 96,
      channels: 4,
      background: { r: 220, g: 30, b: 40, alpha: 1 },
    },
  }).png().toBuffer();
  const normalized = await normalizeGeneratedImageForDelivery({
    buffer: png,
    mimeType: 'image/png',
    fileName: 'small-poster.png',
  }, {
    maxBytes: 6 * 1024 * 1024,
    outputFormat: 'jpeg',
    outputCompression: 80,
    background: 'opaque',
  });
  assert.equal(normalized.mimeType, 'image/jpeg');
  assert.equal(normalized.fileName, 'small-poster.jpg');
  assert.equal((await sharp(normalized.buffer).metadata()).format, 'jpeg');
});

test('delivery detects actual PNG bytes when provider metadata falsely says JPEG', async () => {
  const png = await sharp({
    create: {
      width: 64,
      height: 96,
      channels: 3,
      background: { r: 180, g: 20, b: 30 },
    },
  }).png().toBuffer();
  const normalized = await normalizeGeneratedImageForDelivery({
    buffer: png,
    mimeType: 'image/jpeg',
    fileName: 'lying-provider.jpg',
  }, {
    maxBytes: 6 * 1024 * 1024,
    outputFormat: 'jpeg',
    background: 'opaque',
  });
  assert.equal(normalized.mimeType, 'image/jpeg');
  assert.equal(normalized.fileName, 'lying-provider.jpg');
  assert.equal((await sharp(normalized.buffer).metadata()).format, 'jpeg');
});
