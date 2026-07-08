import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dataRoot, mediaRoot } = vi.hoisted(() => ({
  dataRoot: `/tmp/clawx-generated-media-data-${Math.random().toString(36).slice(2)}`,
  mediaRoot: `/tmp/clawx-generated-media-${Math.random().toString(36).slice(2)}`,
}));

vi.mock('@electron/utils/paths', async () => {
  const actual = await vi.importActual<typeof import('@electron/utils/paths')>('@electron/utils/paths');
  return {
    ...actual,
    getDataDir: () => dataRoot,
    getOpenClawMediaDir: () => mediaRoot,
  };
});

describe('generated media store', () => {
  beforeEach(async () => {
    vi.resetModules();
    await rm(mediaRoot, { recursive: true, force: true });
    await rm(dataRoot, { recursive: true, force: true });
    await mkdir(mediaRoot, { recursive: true });
    await mkdir(dataRoot, { recursive: true });
  });

  it('saves generated buffers under the OpenClaw generated media directory', async () => {
    const { saveGeneratedMediaBuffer } = await import('@electron/utils/generated-media-store');
    const buffer = Buffer.from('generated-image');

    const saved = await saveGeneratedMediaBuffer(buffer, 'image/png', '../unsafe clawx image?.jpg');

    expect(saved.path.startsWith(join(mediaRoot, 'generated'))).toBe(true);
    expect(saved.path).toMatch(/unsafe_UClaw_image---[a-f0-9-]+\.png$/);
    expect(saved.contentType).toBe('image/png');
    expect(saved.size).toBe(buffer.byteLength);
    await expect(readFile(saved.path, 'utf8')).resolves.toBe('generated-image');
  });

  it('falls back to the ClawX data directory when OpenClaw media cannot be written', async () => {
    const { saveGeneratedMediaBuffer } = await import('@electron/utils/generated-media-store');
    await writeFile(join(mediaRoot, 'generated'), 'not-a-directory');
    const buffer = Buffer.from('generated-image-fallback');

    const saved = await saveGeneratedMediaBuffer(buffer, 'image/png', 'fallback.png');

    expect(saved.path.startsWith(join(dataRoot, 'generated-media'))).toBe(true);
    expect(saved.contentType).toBe('image/png');
    expect(saved.size).toBe(buffer.byteLength);
    await expect(readFile(saved.path, 'utf8')).resolves.toBe('generated-image-fallback');
  });
});
