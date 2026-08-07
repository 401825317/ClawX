// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { isMainProcessExternal } from '../../vite.config';

describe('Electron main process dependency bundling', () => {
  it('bundles json5 so the packaged app can parse OpenClaw config without node_modules', () => {
    expect(isMainProcessExternal('json5')).toBe(false);
    expect(isMainProcessExternal('electron')).toBe(true);
  });
});
