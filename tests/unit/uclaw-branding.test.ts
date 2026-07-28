import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const readProjectFile = (relativePath: string): string => (
  readFileSync(join(repoRoot, relativePath), 'utf8')
);

describe('UClaw application branding', () => {
  it('uses UClaw branding in the browser shell and primary UI entry points', () => {
    const indexHtml = readProjectFile('index.html');
    const sidebar = readProjectFile('src/components/layout/Sidebar.tsx');
    const setup = readProjectFile('src/pages/Setup/index.tsx');

    expect(indexHtml).toContain('href="/src/assets/favicon.png"');
    expect(indexHtml).toContain('<title>UClaw</title>');
    expect(sidebar).toContain("from '@/assets/logo-uclaw.png'");
    expect(sidebar).toContain('alt="UClaw"');
    expect(sidebar).toContain('>UClaw</span>');
    expect(setup).toContain("from '@/assets/uclaw-welcome-robot.png'");
    expect(setup).toContain('alt="UClaw"');
  });

  it('ships the UClaw source assets and generates platform icons from them', () => {
    const iconScript = readProjectFile('scripts/generate-icons.mjs');
    const requiredAssets = [
      'resources/icons/icon-uclaw-source.png',
      'src/assets/favicon.png',
      'src/assets/logo-uclaw.png',
      'src/assets/uclaw-welcome-robot.png',
    ];

    expect(iconScript).toContain("const PNG_SOURCE = path.join(ICONS_DIR, 'icon-uclaw-source.png');");
    expect(iconScript).toContain('const ICON_SOURCE = fs.existsSync(PNG_SOURCE) ? PNG_SOURCE : SVG_SOURCE;');
    for (const relativePath of requiredAssets) {
      expect(existsSync(join(repoRoot, relativePath)), `${relativePath} should exist`).toBe(true);
    }
  });
});
