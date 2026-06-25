/**
 * System Tray Management
 * Creates and manages the system tray icon and menu
 */
import { Tray, Menu, BrowserWindow, app, nativeImage } from 'electron';
import { join } from 'path';
import { resolveSupportedLanguage, type LanguageCode } from '../../shared/language';
import { getSetting } from '../utils/store';

let tray: Tray | null = null;

type TrayCopy = {
  showWindow: string;
  gatewayStatus: string;
  gatewayRunning: string;
  quickActions: string;
  openChat: string;
  openSettings: string;
  checkUpdates: string;
  quit: string;
  tooltip: string;
};

const TRAY_COPY: Record<LanguageCode, TrayCopy> = {
  en: {
    showWindow: 'Show UClaw',
    gatewayStatus: 'Gateway Status',
    gatewayRunning: 'Running',
    quickActions: 'Quick Actions',
    openChat: 'Open Chat',
    openSettings: 'Open Settings',
    checkUpdates: 'Check for Updates...',
    quit: 'Quit UClaw',
    tooltip: 'UClaw - AI Assistant',
  },
  zh: {
    showWindow: '显示 UClaw',
    gatewayStatus: '网关状态',
    gatewayRunning: '运行中',
    quickActions: '快捷操作',
    openChat: '打开会话',
    openSettings: '打开设置',
    checkUpdates: '检查更新...',
    quit: '退出 UClaw',
    tooltip: 'UClaw - AI 助手',
  },
  ja: {
    showWindow: 'UClaw を表示',
    gatewayStatus: 'ゲートウェイ状態',
    gatewayRunning: '実行中',
    quickActions: 'クイック操作',
    openChat: 'チャットを開く',
    openSettings: '設定を開く',
    checkUpdates: '更新を確認...',
    quit: 'UClaw を終了',
    tooltip: 'UClaw - AI アシスタント',
  },
  ru: {
    showWindow: 'Показать UClaw',
    gatewayStatus: 'Состояние шлюза',
    gatewayRunning: 'Работает',
    quickActions: 'Быстрые действия',
    openChat: 'Открыть чат',
    openSettings: 'Открыть настройки',
    checkUpdates: 'Проверить обновления...',
    quit: 'Выйти из UClaw',
    tooltip: 'UClaw - AI ассистент',
  },
};

function getTrayCopy(language: string | null | undefined): TrayCopy {
  const resolved = resolveSupportedLanguage(language);
  return TRAY_COPY[resolved];
}

function buildTrayContextMenuTemplate(
  mainWindow: BrowserWindow,
  copy: TrayCopy,
): Electron.MenuItemConstructorOptions[] {
  const showWindow = () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  };

  return [
    {
      label: copy.showWindow,
      click: showWindow,
    },
    {
      type: 'separator',
    },
    {
      label: copy.gatewayStatus,
      enabled: false,
    },
    {
      label: copy.gatewayRunning,
      type: 'checkbox',
      checked: true,
      enabled: false,
    },
    {
      type: 'separator',
    },
    {
      label: copy.quickActions,
      submenu: [
        {
          label: copy.openChat,
          click: () => {
            if (mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.webContents.send('navigate', '/');
          },
        },
        {
          label: copy.openSettings,
          click: () => {
            if (mainWindow.isDestroyed()) return;
            mainWindow.show();
            mainWindow.webContents.send('navigate', '/settings');
          },
        },
      ],
    },
    {
      type: 'separator',
    },
    {
      label: copy.checkUpdates,
      click: () => {
        if (mainWindow.isDestroyed()) return;
        mainWindow.webContents.send('update:check');
      },
    },
    {
      type: 'separator',
    },
    {
      label: copy.quit,
      click: () => {
        app.quit();
      },
    },
  ];
}

async function resolveTrayLanguage(): Promise<LanguageCode> {
  try {
    return resolveSupportedLanguage(await getSetting('language'));
  } catch {
    return resolveSupportedLanguage(app.getLocale());
  }
}

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'resources', 'icons');
  }
  return join(__dirname, '../../resources/icons');
}

/**
 * Create system tray icon and menu
 */
export async function createTray(mainWindow: BrowserWindow): Promise<Tray> {
  // Use platform-appropriate icon for system tray
  const iconsDir = getIconsDir();
  let iconPath: string;

  if (process.platform === 'win32') {
    // Windows: use .ico for best quality in system tray
    iconPath = join(iconsDir, 'icon.ico');
  } else if (process.platform === 'darwin') {
    // macOS: use Template.png for proper status bar icon
    // The "Template" suffix tells macOS to treat it as a template image
    iconPath = join(iconsDir, 'tray-icon-Template.png');
  } else {
    // Linux: use 32x32 PNG
    iconPath = join(iconsDir, '32x32.png');
  }

  let icon = nativeImage.createFromPath(iconPath);

  // Fallback to icon.png if platform-specific icon not found
  if (icon.isEmpty()) {
    icon = nativeImage.createFromPath(join(iconsDir, 'icon.png'));
    // Still try to set as template for macOS
    if (process.platform === 'darwin') {
      icon.setTemplateImage(true);
    }
  }

  // Note: Using "Template" suffix in filename automatically marks it as template image
  // But we can also explicitly set it for safety
  if (process.platform === 'darwin') {
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon);
  const copy = getTrayCopy(await resolveTrayLanguage());

  // Set tooltip
  tray.setToolTip(copy.tooltip);

  // Create context menu
  const contextMenu = Menu.buildFromTemplate(buildTrayContextMenuTemplate(mainWindow, copy));

  tray.setContextMenu(contextMenu);
  
  // Click to show window (Windows/Linux)
  tray.on('click', () => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  
  // Double-click to show window (Windows)
  tray.on('double-click', () => {
    if (mainWindow.isDestroyed()) return;
    mainWindow.show();
    mainWindow.focus();
  });
  
  return tray;
}

/**
 * Update tray tooltip with Gateway status
 */
export function updateTrayStatus(status: string): void {
  if (tray) {
    tray.setToolTip(`UClaw - ${status}`);
  }
}

export { buildTrayContextMenuTemplate, getTrayCopy };

/**
 * Destroy tray icon
 */
export function destroyTray(): void {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
