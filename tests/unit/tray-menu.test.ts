import { describe, expect, it, vi } from 'vitest';

const buildFromTemplateMock = vi.fn();
const setContextMenuMock = vi.fn();
const setToolTipMock = vi.fn();
const trayMock = {
  setContextMenu: setContextMenuMock,
  setToolTip: setToolTipMock,
  on: vi.fn(),
  destroy: vi.fn(),
};

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getLocale: () => 'zh-CN',
  },
  Tray: class {
    constructor() {
      return trayMock;
    }
  },
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
  },
  BrowserWindow: class {},
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      setTemplateImage: vi.fn(),
    })),
  },
}));

vi.mock('../../shared/language', () => ({
  resolveSupportedLanguage: (locale: string | null | undefined) => {
    const normalized = (locale ?? '').toLowerCase();
    if (normalized.startsWith('zh')) return 'zh';
    if (normalized.startsWith('ja')) return 'ja';
    if (normalized.startsWith('ru')) return 'ru';
    return 'en';
  },
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: async (key: string) => (key === 'language' ? 'zh' : undefined),
}));

describe('tray menu', () => {
  it('builds Chinese tray labels when the app language is zh', async () => {
    const { createTray, getTrayCopy, buildTrayContextMenuTemplate } = await import('@electron/main/tray');
    const mainWindow = {
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
      webContents: { send: vi.fn() },
    } as never;

    expect(getTrayCopy('zh').quit).toBe('退出 UClaw');
    const template = buildTrayContextMenuTemplate(mainWindow, getTrayCopy('zh'));
    expect(template[0]).toMatchObject({ label: '显示 UClaw' });
    expect(template[2]).toMatchObject({ label: '网关状态' });
    expect(template.find((item) => item && 'label' in item && item.label === '快捷操作')).toBeTruthy();
    expect(template.find((item) => item && 'label' in item && item.label === '检查更新...')).toBeTruthy();
    expect(template.find((item) => item && 'label' in item && item.label === '退出 UClaw')).toBeTruthy();

    await createTray(mainWindow);
    expect(buildFromTemplateMock).toHaveBeenCalled();
    expect(setToolTipMock).toHaveBeenCalledWith('UClaw - AI 助手');
  });
});
