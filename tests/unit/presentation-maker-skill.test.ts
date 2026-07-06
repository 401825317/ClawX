import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

describe('presentation-maker skill', () => {
  it('generates a valid pptx package without Python setup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uclaw-pptx-'));
    const input = join(root, 'deck.json');
    const output = join(root, 'deck.pptx');
    writeFileSync(input, JSON.stringify({
      title: 'UClaw PPT 快速生成',
      subtitle: '本地 Node 快路径',
      slides: [
        { title: '执行摘要', bullets: ['不使用 Python/uv', '生成真实 .pptx 文件', '输出可被 UClaw 文件卡识别'] },
        { title: '下一步', bullets: ['继续优化模板', '保持中文最终回复'] },
      ],
      footer: 'UClaw',
    }));

    const script = join(process.cwd(), 'resources', 'openclaw-skill-shims', 'presentation-maker', 'scripts', 'make-pptx.mjs');
    const result = spawnSync(process.execPath, [script, '--input', input, '--out', output], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(existsSync(output)).toBe(true);

    const zip = await JSZip.loadAsync(readFileSync(output));
    expect(zip.file('ppt/presentation.xml')).toBeTruthy();
    expect(zip.file('ppt/slides/slide1.xml')).toBeTruthy();
    expect(zip.file('ppt/slides/slide2.xml')).toBeTruthy();
    expect(zip.file('ppt/slides/slide3.xml')).toBeTruthy();
    const slideXml = await zip.file('ppt/slides/slide2.xml')?.async('string');
    expect(slideXml).toContain('执行摘要');
  });
});
