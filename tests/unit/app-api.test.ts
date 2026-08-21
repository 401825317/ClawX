import { app } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppApi } from '@electron/services/app-api';

describe('app Host API', () => {
  beforeEach(() => {
    vi.mocked(app.quit).mockClear();
  });

  it('requests the normal Electron quit lifecycle', () => {
    const api = createAppApi();

    expect(api.quit()).toBeUndefined();
    expect(app.quit).toHaveBeenCalledOnce();
  });

  it('resolves both HTTPS specifier forms to the Node builtin', async () => {
    const [bareHttps, prefixedHttps] = await Promise.all([
      import('https'),
      import('node:https'),
    ]);

    expect(bareHttps.request).toBe(prefixedHttps.request);
  });
});
