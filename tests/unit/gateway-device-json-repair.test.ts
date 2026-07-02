import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('OpenClaw device JSON repair', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'uclaw-device-json-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes UTF-8 BOM from Gateway device JSON files before launch', async () => {
    const devicesDir = join(root, 'devices');
    const pendingPath = join(devicesDir, 'pending.json');
    const pairedPath = join(devicesDir, 'paired.json');
    await mkdir(devicesDir, { recursive: true });
    await writeFile(pendingPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]));
    await writeFile(pairedPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"0":{}}')]));
    const { repairOpenClawDeviceJsonFiles } = await import('@electron/gateway/device-json-repair');

    const summary = repairOpenClawDeviceJsonFiles(root);

    expect(summary).toMatchObject({ checked: 2, repairedBom: 2, quarantined: 0, failed: 0 });
    expect(await readFile(pendingPath)).toEqual(Buffer.from('{}'));
    expect(await readFile(pairedPath)).toEqual(Buffer.from('{"0":{}}'));
  });

  it('quarantines invalid Gateway device JSON files instead of blocking startup', async () => {
    const devicesDir = join(root, 'devices');
    const pendingPath = join(devicesDir, 'pending.json');
    await mkdir(devicesDir, { recursive: true });
    await writeFile(pendingPath, Buffer.from('{broken'), 'utf-8');
    const { repairOpenClawDeviceJsonFiles } = await import('@electron/gateway/device-json-repair');

    const summary = repairOpenClawDeviceJsonFiles(root);
    const files = await readdir(devicesDir);

    expect(summary).toMatchObject({ checked: 1, repairedBom: 0, quarantined: 1, failed: 0 });
    expect(files.some((file) => file.startsWith('pending.json.corrupt.'))).toBe(true);
  });
});
