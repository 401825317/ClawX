// @vitest-environment node

import JSZip from 'jszip';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __extractSkillHubZipForTests,
  __setSkillHubFsForTests,
} from '@electron/extensions/builtin/skillhub-marketplace';

const tempRoots: string[] = [];

async function tempTarget(slug = 'demo-skill'): Promise<string> {
  const root = await fsp.mkdtemp(join(tmpdir(), 'uclaw-skillhub-test-'));
  tempRoots.push(root);
  return join(root, 'skills', slug);
}

async function archive(files: Record<string, string | Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

afterEach(async () => {
  __setSkillHubFsForTests(null);
  await Promise.all(tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe('SkillHub marketplace archive installation', () => {
  it('installs a valid archive with marketplace origin metadata', async () => {
    const target = await tempTarget();
    const zip = await archive({
      'SKILL.md': '---\nname: Demo\n---\n',
      'scripts/run.js': 'console.log("ok");\n',
    });

    await __extractSkillHubZipForTests(zip, target);

    await expect(fsp.readFile(join(target, 'SKILL.md'), 'utf-8')).resolves.toContain('name: Demo');
    const origin = JSON.parse(await fsp.readFile(join(target, '.clawhub', 'origin.json'), 'utf-8')) as {
      provider?: string;
      slug?: string;
    };
    expect(origin).toMatchObject({ provider: 'skillhub', slug: 'demo-skill' });
  });

  it.each(['../outside.txt', '..\\outside.txt', '/absolute.txt', 'C:\\absolute.txt'])(
    'rejects unsafe archive path %s',
    async (unsafePath) => {
      const target = await tempTarget();
      const zip = await archive({ 'SKILL.md': 'demo', [unsafePath]: 'blocked' });

      await expect(__extractSkillHubZipForTests(zip, target)).rejects.toThrow(/unsafe file path/);
    },
  );

  it('rejects archives without a root SKILL.md', async () => {
    const target = await tempTarget();
    const zip = await archive({ 'README.md': 'missing manifest' });

    await expect(__extractSkillHubZipForTests(zip, target)).rejects.toThrow('does not contain SKILL.md');
  });

  it('rejects an entry above the uncompressed size limit before installation', async () => {
    const target = await tempTarget();
    const oversized = Buffer.alloc(16 * 1024 * 1024 + 1);
    const zip = await archive({ 'SKILL.md': 'demo', 'assets/oversized.bin': oversized });

    await expect(__extractSkillHubZipForTests(zip, target)).rejects.toThrow('entry exceeds the size limit');
  });

  it('rejects archives with too many entries', async () => {
    const target = await tempTarget();
    const files: Record<string, string> = { 'SKILL.md': 'demo' };
    for (let index = 0; index < 512; index += 1) {
      files[`files/${index}.txt`] = '';
    }
    const zip = await archive(files);

    await expect(__extractSkillHubZipForTests(zip, target)).rejects.toThrow('contains too many files');
  });

  it('restores the previous skill when committing the replacement fails', async () => {
    const target = await tempTarget();
    await fsp.mkdir(target, { recursive: true });
    await fsp.writeFile(join(target, 'SKILL.md'), 'old version');
    const zip = await archive({ 'SKILL.md': 'new version' });

    __setSkillHubFsForTests({
      ...fsp,
      rename: async (from, to) => {
        if (String(from).includes('/.demo-skill-skillhub-') && to === target) {
          throw Object.assign(new Error('commit failed'), { code: 'EIO' });
        }
        await fsp.rename(from, to);
      },
    });

    await expect(__extractSkillHubZipForTests(zip, target)).rejects.toThrow('commit failed');
    await expect(fsp.readFile(join(target, 'SKILL.md'), 'utf-8')).resolves.toBe('old version');
  });
});
