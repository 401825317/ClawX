// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMainProcessExternal } from '../../vite.config';

describe('Electron main process dependency bundling', () => {
  it('bundles json5 so the packaged app can parse OpenClaw config without node_modules', () => {
    expect(isMainProcessExternal('json5')).toBe(false);
    expect(isMainProcessExternal('electron')).toBe(true);
  });

  it('cleans both Electron output directories before each production build', () => {
    const source = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');
    for (const output of ['main', 'preload']) {
      expect(source).toMatch(new RegExp(
        `outDir:\\s*['"]dist-electron/${output}['"][\\s\\S]{0,240}?emptyOutDir:\\s*true`,
        'u',
      ));
    }
  });
});
