/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, nativeImage, session, shell } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import type { Server } from 'node:http';
import { join } from 'path';
import { GatewayManager } from '../gateway/manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';
import { registerZoomShortcuts } from './zoom-shortcuts';

import { appUpdater, registerUpdateHandlers } from './updater';
import { disableConsoleOutput, isProcessOutputError, logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { initTelemetry } from '../utils/telemetry';

import { ClawHubService } from '../gateway/clawhub';
import { extensionRegistry } from '../extensions/registry';
import { loadExtensionsFromManifest } from '../extensions/loader';
import { registerAllBuiltinExtensions } from '../extensions/builtin';
import { loadExternalMainExtensions } from '../extensions/_ext-bridge.generated';
import {
  ensureClawXContext,
  ensureClawXDefaultIdentity,
  repairClawXOnlyBootstrapFiles,
} from '../utils/openclaw-workspace';
import { autoInstallCliIfNeeded, generateCompletionCache, installCompletionToProfile } from '../utils/openclaw-cli';
import { isQuitting, setQuitting } from './app-state';
import { getMacTrafficLightPosition, syncMacTrafficLightPosition } from './traffic-light-layout';
import { getSetting } from '../utils/store';
import { applyProxySettings } from './proxy';
import { syncLaunchAtStartupSettingFromStore } from './launch-at-startup';
import { applyPortableEnvironment, isPortableMode } from '../utils/portable-mode';
import {
  clearPendingSecondInstanceFocus,
  consumeMainWindowReady,
  createMainWindowFocusState,
  requestSecondInstanceFocus,
} from './main-window-focus';
import {
  createQuitLifecycleState,
  markQuitCleanupCompleted,
  requestQuitLifecycleAction,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import {
  acquireProcessInstanceFileLock,
  resolveGlobalProcessInstanceLockDir,
} from './process-instance-lock';
import { shouldDisableHardwareAcceleration } from './hardware-acceleration';
import { ensureBuiltinSkillsInstalled, removeClawXPreinstalledSkillsAndConfigs, trimBundledOpenClawSkillsAndConfigs } from '../utils/skill-config';
import { ensureWeChatPluginInstalled } from '../utils/plugin-install';

import { startHostApiServer } from '../api/server';
import { HostEventBus } from '../api/event-bus';
import { deviceOAuthManager } from '../utils/device-oauth';
import { browserOAuthManager } from '../utils/browser-oauth';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { syncAllProviderAuthToRuntime } from '../services/providers/provider-runtime-sync';
import { ensureJunFeiAIProviderSeeded, getJunFeiAILocalStatus, isJunFeiAISeedReady } from '../services/junfeiai/junfeiai-service';
import { autoMigrateManagedChatToOpenAiOnStartup } from '../services/providers/openai-chat-migration';
import { ensureJunFeiAIManagedRuntimeBootstrap } from '../services/junfeiai/managed-runtime-bootstrap';
import { isJunFeiAIManagedDistribution } from '../utils/junfeiai-distribution';

const WINDOWS_APP_USER_MODEL_ID = 'app.clawx.desktop';
const DISPLAY_APP_NAME = 'UClaw';
const isE2EMode = process.env.CLAWX_E2E === '1';
const portableModeInfo = applyPortableEnvironment();
const requestedUserDataDir = process.env.CLAWX_USER_DATA_DIR?.trim();
const requestedRemoteDebuggingPort = process.env.CLAWX_REMOTE_DEBUGGING_PORT?.trim();
let extensionsLoadPromise: Promise<void> | null = null;

type JunFeiAILocalStatus = Awaited<ReturnType<typeof getJunFeiAILocalStatus>>;

function isJunFeiAILocalStatusReadyForGateway(status: JunFeiAILocalStatus): boolean {
  if (!status.managed) {
    return true;
  }
  return Boolean(status.account)
    && Boolean(status.hasAuthToken)
    && Boolean(status.hasRelayToken)
    && status.activationRequired !== true;
}

/** Applies the managed Responses migration and records a non-blocking startup result. */
async function runManagedOpenAiStartupMigration(): Promise<void> {
  const migration = await autoMigrateManagedChatToOpenAiOnStartup();
  if (migration.status === 'already-migrated') {
    logger.debug('[provider-migration] Managed OpenAI Responses startup migration already complete');
    return;
  }
  if (migration.status === 'migrated') {
    logger.info('[provider-migration] Managed OpenAI Responses startup migration complete', {
      filesUpdated: migration.result.filesUpdated,
      refsRewritten: migration.result.refsRewritten,
    });
    return;
  }
  logger.warn('[provider-migration] Managed OpenAI Responses startup migration failed; keeping the legacy provider active:', migration.error);
}

// Gateway startup is the last safe point to repair OpenClaw runtime config
// before the runtime process reads ~/.openclaw/openclaw.json.
async function syncProviderRuntimeBeforeGatewayStart(
  gatewayManager: GatewayManager,
  preparedSeed?: Awaited<ReturnType<typeof ensureJunFeiAIProviderSeeded>> | null,
): Promise<boolean> {
  if (!isJunFeiAIManagedDistribution()) {
    await syncAllProviderAuthToRuntime();
    return true;
  }

  // Reuse the completed preflight seed so Gateway startup does not rewrite the
  // same runtime config a second time immediately before the process reads it.
  const seed = preparedSeed ?? await ensureJunFeiAIProviderSeeded({
    gatewayManager,
    syncRuntime: true,
    syncRuntimeOnAuthChange: true,
  });
  if (!isJunFeiAISeedReady(seed)) {
    logger.info(
      `Gateway start deferred until JunFeiAI runtime config is ready; authToken=${seed.hasAuthToken ? 'present' : 'missing'} relayToken=${seed.hasRelayToken ? 'present' : 'missing'} activation=${seed.activationRequired ? 'required' : 'ready'}`,
    );
    return false;
  }
  await runManagedOpenAiStartupMigration();
  return true;
}

function resolveLegacyUserDataPath(): string {
  const appDataDir = app.getPath('appData');
  const legacyPaths = [
    join(appDataDir, 'ClawX'),
    join(appDataDir, 'clawx'),
  ];
  const userDataPath = legacyPaths.find((candidate) => existsSync(candidate)) ?? legacyPaths[0];
  mkdirSync(userDataPath, { recursive: true });
  return userDataPath;
}

if (requestedRemoteDebuggingPort) {
  app.commandLine.appendSwitch('remote-debugging-port', requestedRemoteDebuggingPort);
}

if (portableModeInfo.enabled && portableModeInfo.runtimeElectronCacheDir) {
  app.commandLine.appendSwitch('disk-cache-dir', portableModeInfo.runtimeElectronCacheDir);
}

app.setName(DISPLAY_APP_NAME);

if (portableModeInfo.enabled && portableModeInfo.clawxDataDir) {
  app.setPath('userData', portableModeInfo.clawxDataDir);
  if (portableModeInfo.sessionDataDir) {
    app.setPath('sessionData', portableModeInfo.sessionDataDir);
  }
  if (portableModeInfo.runtimeLogsDir) {
    app.setPath('logs', portableModeInfo.runtimeLogsDir);
  }
  if (portableModeInfo.runtimeCrashDumpsDir) {
    app.setPath('crashDumps', portableModeInfo.runtimeCrashDumpsDir);
  }
  if (portableModeInfo.runtimeTempDir) {
    app.setPath('temp', portableModeInfo.runtimeTempDir);
  }
} else if (isE2EMode && requestedUserDataDir) {
  app.setPath('userData', requestedUserDataDir);
} else if (!isE2EMode) {
  app.setPath('userData', resolveLegacyUserDataPath());
}

// Windows keeps GPU acceleration enabled by default so Chromium can composite
// large Markdown/history views without pushing all rendering work onto the CPU.
// Non-Windows keeps the previous software-rendering default. Users can override
// with CLAWX_DISABLE_GPU/UCLAW_DISABLE_GPU or --disable-gpu, and can opt in on
// other platforms with CLAWX_ENABLE_GPU/UCLAW_ENABLE_GPU or --enable-gpu.
if (shouldDisableHardwareAcceleration({
  platform: process.platform,
  env: process.env,
  hasSwitch: (name) => app.commandLine.hasSwitch(name),
})) {
  app.disableHardwareAcceleration();
}

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to clawx.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  app.setDesktopName('clawx.desktop');
}

// Prevent multiple instances of the app from running simultaneously.
// Electron's lock is scoped by userData, so portable copies also take a
// per-OS-user file lock below that is independent of their extraction folder.
// Without this, two instances each spawn their own gateway process on the
// same port, then each treats the other's gateway as "orphaned" and kills
// it — creating an infinite kill/restart loop on Windows.
// The losing process must exit immediately so it never reaches Gateway startup.
const gotElectronLock = isE2EMode ? true : app.requestSingleInstanceLock();
if (!gotElectronLock) {
  console.info('[UClaw] Another instance already holds the single-instance lock; exiting duplicate process');
  app.exit(0);
}
let releaseProcessInstanceFileLock: () => void = () => {};
let gotFileLock = true;
if (gotElectronLock && !isE2EMode) {
  try {
    const globalLockDir = resolveGlobalProcessInstanceLockDir(app.getPath('appData'));
    const fileLock = acquireProcessInstanceFileLock({
      lockDir: globalLockDir,
      lockName: WINDOWS_APP_USER_MODEL_ID,
    });
    gotFileLock = fileLock.acquired;
    releaseProcessInstanceFileLock = fileLock.release;
    if (!fileLock.acquired) {
      const ownerDescriptor = fileLock.ownerPid
        ? `${fileLock.ownerFormat ?? 'legacy'} pid=${fileLock.ownerPid}`
        : fileLock.ownerFormat === 'unknown'
          ? 'unknown lock format/content'
          : 'unknown owner';
      console.info(
        `[UClaw] Another instance already holds process lock (${fileLock.lockPath}, ${ownerDescriptor}); exiting duplicate process`,
      );
      app.exit(0);
    }
  } catch (error) {
    gotFileLock = false;
    console.error('[UClaw] Failed to acquire global process instance lock; exiting to avoid a Gateway ownership conflict', error);
    app.exit(1);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let clawHubService!: ClawHubService;
let hostEventBus!: HostEventBus;
let hostApiServer: Server | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined; // macOS uses the app bundle icon

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Create the main application window
 */
function createWindow(): BrowserWindow {
  const isMac = process.platform === 'darwin';
  const isWindows = process.platform === 'win32';
  const useCustomTitleBar = isWindows;
  const shouldSkipSetupForE2E = process.env.CLAWX_E2E_SKIP_SETUP === '1';

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
    },
    titleBarStyle: isMac ? 'hiddenInset' : useCustomTitleBar ? 'hidden' : 'default',
    trafficLightPosition: isMac
      ? getMacTrafficLightPosition(false)
      : undefined,
    frame: isMac || !useCustomTitleBar,
    show: false,
  });

  registerZoomShortcuts(win);

  // Handle external links — only allow safe protocols to prevent arbitrary
  // command execution via shell.openExternal() (e.g. file://, ms-msdt:, etc.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url);
      } else {
        logger.warn(`Blocked openExternal for disallowed protocol: ${parsed.protocol}`);
      }
    } catch {
      logger.warn(`Blocked openExternal for malformed URL: ${url}`);
    }
    return { action: 'deny' };
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    const rendererUrl = new URL(process.env.VITE_DEV_SERVER_URL);
    if (shouldSkipSetupForE2E) {
      rendererUrl.searchParams.set('e2eSkipSetup', '1');
    }
    win.loadURL(rendererUrl.toString());
    if (!isE2EMode) {
      win.webContents.openDevTools();
    }
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'), {
      query: shouldSkipSetupForE2E
        ? { e2eSkipSetup: '1' }
        : undefined,
    });
  }

  return win;
}

function focusWindow(win: BrowserWindow): void {
  if (win.isDestroyed()) {
    return;
  }

  if (win.isMinimized()) {
    win.restore();
  }

  win.show();
  win.focus();
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  clearPendingSecondInstanceFocus(mainWindowFocusState);
  focusWindow(mainWindow);
}

function createMainWindow(): BrowserWindow {
  const win = createWindow();

  win.once('ready-to-show', () => {
    if (mainWindow !== win) {
      return;
    }

    if (process.platform === 'darwin') {
      void getSetting('sidebarCollapsed').then((sidebarCollapsed) => {
        syncMacTrafficLightPosition(win, sidebarCollapsed);
      });
    }

    const action = consumeMainWindowReady(mainWindowFocusState);
    if (action === 'focus') {
      focusWindow(win);
      return;
    }

    win.show();
  });

  win.on('close', (event) => {
    if (!isQuitting() && !isE2EMode) {
      event.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  mainWindow = win;
  return win;
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  // Initialize logger first
  logger.init();
  logger.info('=== UClaw Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}, pid=${process.pid}, ppid=${process.ppid}`
  );

  if (!isE2EMode) {
    // Warm up network optimization (non-blocking)
    void warmupNetworkOptimization();

    // Initialize Telemetry early
    await initTelemetry();

    // Apply persisted proxy settings before creating windows or network requests.
    await applyProxySettings();
    if (isPortableMode()) {
      logger.info('Portable mode enabled: launch-at-startup sync is skipped');
    } else {
      await syncLaunchAtStartupSettingFromStore();
    }
  } else {
    logger.info('Running in E2E mode: startup side effects minimized');
  }

  // Set application menu
  createMenu();

  // Create the main window
  const window = createMainWindow();

  // Create system tray
  if (!isE2EMode) {
    await createTray(window);
  }

  // Override security headers ONLY for the OpenClaw Gateway Control UI.
  // The URL filter ensures this callback only fires for gateway requests,
  // avoiding unnecessary overhead on every other HTTP response.
  session.defaultSession.webRequest.onHeadersReceived(
    { urls: ['http://127.0.0.1:18789/*', 'http://localhost:18789/*'] },
    (details, callback) => {
      const headers = { ...details.responseHeaders };
      delete headers['X-Frame-Options'];
      delete headers['x-frame-options'];
      if (headers['Content-Security-Policy']) {
        headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      if (headers['content-security-policy']) {
        headers['content-security-policy'] = headers['content-security-policy'].map(
          (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
        );
      }
      callback({ responseHeaders: headers });
    },
  );

  // Register IPC handlers
  registerIpcHandlers(gatewayManager, clawHubService, window);

  hostApiServer = startHostApiServer({
    gatewayManager,
    clawHubService,
    eventBus: hostEventBus,
    mainWindow: window,
  });

  if (extensionsLoadPromise) {
    await extensionsLoadPromise;
  }

  // Initialize extension system
  await extensionRegistry.initialize({
    gatewayManager,
    eventBus: hostEventBus,
    getMainWindow: () => mainWindow,
  });

  // Wire marketplace providers to ClawHubService if extensions provide them
  const marketplaceProviders = extensionRegistry.getMarketplaceProviders();
  if (marketplaceProviders.length > 0) {
    clawHubService.setMarketplaceProviders(marketplaceProviders);
  }

  // Register update handlers
  registerUpdateHandlers(appUpdater, window);

  // Note: Auto-check for updates is driven by the renderer (update store init)
  // so it respects the user's "Auto-check for updates" setting.

  // Seed a stable default IDENTITY.md before the Gateway initializes the
  // workspace so ClawX desktop sessions skip OpenClaw's chat-first bootstrap.
  if (!isE2EMode) {
    void ensureClawXDefaultIdentity().catch((error) => {
      logger.warn('Failed to seed default ClawX identity:', error);
    });
  }

  // Repair any bootstrap files that only contain ClawX markers (no OpenClaw
  // template content). This fixes a race condition where ensureClawXContext()
  // previously created the file before the gateway could seed the full template.
  if (!isE2EMode) {
    void repairClawXOnlyBootstrapFiles().catch((error) => {
      logger.warn('Failed to repair bootstrap files:', error);
    });
  }

  // Pre-deploy built-in skills (feishu-doc, feishu-drive, feishu-perm, feishu-wiki)
  // to ~/.openclaw/skills/ so they are immediately available without manual install.
  if (!isE2EMode) {
    void ensureBuiltinSkillsInstalled().catch((error) => {
      logger.warn('Failed to install built-in skills:', error);
    });
  }

  // Community builds can physically trim bundled OpenClaw consumer skills on
  // startup. JunFeiAI managed builds preserve bundled OpenClaw skills so the
  // skills page can show the richer ClawBox-style catalog.
  if (!isE2EMode) {
    void trimBundledOpenClawSkillsAndConfigs().then(({ removed, removedConfigs, kept }) => {
      if (removed > 0 || removedConfigs > 0) {
        logger.info(
          `Trimmed bundled OpenClaw skills: removed ${removed}, pruned configs ${removedConfigs}, kept ${kept.join(', ')}`,
        );
      }
    });
  }

  // Remove legacy ClawX-owned preinstalled skills from the managed skills dir.
  // OpenClaw bundled skills are preserved; this only targets skills marked with
  // `.clawx-preinstalled.json` from older ClawX builds.
  if (!isE2EMode) {
    void removeClawXPreinstalledSkillsAndConfigs().then(({ removed, removedConfigs, removedSlugs }) => {
      if (removed > 0 || removedConfigs > 0) {
        logger.info(
          `Removed legacy ClawX preinstalled skills: removed ${removed}, pruned configs ${removedConfigs}, slugs ${removedSlugs.join(', ')}`,
        );
      }
    }).catch((error) => {
      logger.warn('Failed to remove legacy ClawX preinstalled skills:', error);
    });
  }

  // Plugin installation is now configuration-driven:
  // - When a channel is added via UI: ensureXxxPluginInstalled() in IPC handlers
  // - When Gateway starts: ensureConfiguredPluginsUpgraded() in config-sync.ts
  // No need to pre-install all bundled plugins at app startup.
  // JunFeiAI managed builds preinstall WeChat because it is part of the
  // activation/login success path expected by this distribution.
  if (!isE2EMode && isJunFeiAIManagedDistribution()) {
    void Promise.resolve().then(() => {
      const result = ensureWeChatPluginInstalled();
      if (result.warning) {
        logger.warn(`[plugin] WeChat preinstall warning: ${result.warning}`);
      }
    }).catch((error) => {
      logger.warn('[plugin] Failed to preinstall WeChat plugin:', error);
    });
  }

  let managedProviderReadyForGateway = true;
  let managedProviderStartupSeed: Awaited<ReturnType<typeof ensureJunFeiAIProviderSeeded>> | null = null;
  if (!isE2EMode) {
    try {
      const localStatus = await getJunFeiAILocalStatus();
      if (localStatus.managed) {
        managedProviderReadyForGateway = isJunFeiAILocalStatusReadyForGateway(localStatus);
        logger.info(
          `JunFeiAI local startup status; authToken=${localStatus.hasAuthToken ? 'present' : 'missing'} relayToken=${localStatus.hasRelayToken ? 'present' : 'missing'} activation=${localStatus.activationRequired ? 'required' : 'ready'} cachedAuth=${localStatus.authValid ? 'valid' : 'pending'}`,
        );
        if (managedProviderReadyForGateway) {
          try {
            managedProviderStartupSeed = await ensureJunFeiAIProviderSeeded({
              bootstrap: localStatus.bootstrap,
              syncRuntime: true,
              syncRuntimeOnAuthChange: true,
              markDeviceActivatedFromStoredAuth: false,
            });
            managedProviderReadyForGateway = isJunFeiAISeedReady(managedProviderStartupSeed);
            logger.info('Managed provider contract and media runtime synchronized before Gateway start');
          } catch (error) {
            logger.warn('Failed to synchronize the full managed provider contract before Gateway start:', error);
            try {
              const runtimeBootstrap = await ensureJunFeiAIManagedRuntimeBootstrap();
              logger.info(
                `Managed runtime bootstrap ready before Gateway start; migratedNow=${runtimeBootstrap.migratedNow}`,
              );
            } catch (bootstrapError) {
              logger.warn('Failed to bootstrap managed Responses and media providers before Gateway start:', bootstrapError);
            }
          }
        }
      }
    } catch (error) {
      managedProviderReadyForGateway = !isJunFeiAIManagedDistribution();
      logger.warn('Failed to read local JunFeiAI provider status:', error);
    }
  }

  // Bridge gateway and host-side events before any auto-start logic runs, so
  // renderer subscribers observe the full startup lifecycle.
  gatewayManager.on('status', (status: { state: string }) => {
    hostEventBus.emit('gateway:status', status);
    if (status.state === 'running' && !isE2EMode) {
      void ensureClawXContext().catch((error) => {
        logger.warn('Failed to re-merge ClawX context after gateway reconnect:', error);
      });
    }
  });

  gatewayManager.on('error', (error) => {
    hostEventBus.emit('gateway:error', { message: error.message });
  });

  gatewayManager.on('notification', (notification) => {
    hostEventBus.emit('gateway:notification', notification);
  });

  gatewayManager.on('gateway:health', (data) => {
    hostEventBus.emit('gateway:health', data);
  });

  gatewayManager.on('gateway:presence', (data) => {
    hostEventBus.emit('gateway:presence', data);
  });

  gatewayManager.on('chat:message', (data) => {
    hostEventBus.emit('gateway:chat-message', data);
  });

  gatewayManager.on('chat:runtime-event', (data) => {
    hostEventBus.emit('chat:runtime-event', data);
  });

  gatewayManager.on('channel:status', (data) => {
    hostEventBus.emit('gateway:channel-status', data);
  });

  gatewayManager.on('exit', (code) => {
    hostEventBus.emit('gateway:exit', { code });
  });

  deviceOAuthManager.on('oauth:code', (payload) => {
    hostEventBus.emit('oauth:code', payload);
  });

  deviceOAuthManager.on('oauth:start', (payload) => {
    hostEventBus.emit('oauth:start', payload);
  });

  deviceOAuthManager.on('oauth:success', (payload) => {
    hostEventBus.emit('oauth:success', { ...payload, success: true });
  });

  deviceOAuthManager.on('oauth:error', (error) => {
    hostEventBus.emit('oauth:error', error);
  });

  browserOAuthManager.on('oauth:start', (payload) => {
    hostEventBus.emit('oauth:start', payload);
  });

  browserOAuthManager.on('oauth:code', (payload) => {
    hostEventBus.emit('oauth:code', payload);
  });

  browserOAuthManager.on('oauth:success', (payload) => {
    hostEventBus.emit('oauth:success', { ...payload, success: true });
  });

  browserOAuthManager.on('oauth:error', (error) => {
    hostEventBus.emit('oauth:error', error);
  });

  whatsAppLoginManager.on('qr', (data) => {
    hostEventBus.emit('channel:whatsapp-qr', data);
  });

  whatsAppLoginManager.on('success', (data) => {
    hostEventBus.emit('channel:whatsapp-success', data);
  });

  whatsAppLoginManager.on('error', (error) => {
    hostEventBus.emit('channel:whatsapp-error', error);
  });

  // Start Gateway automatically (this seeds missing bootstrap files with full templates)
  const gatewayAutoStart = await getSetting('gatewayAutoStart');
  if (!isE2EMode && gatewayAutoStart && managedProviderReadyForGateway) {
    try {
      const runtimeReady = await syncProviderRuntimeBeforeGatewayStart(
        gatewayManager,
        managedProviderStartupSeed,
      );
      if (runtimeReady) {
        logger.debug('Auto-starting Gateway...');
        await gatewayManager.start({
          reason: 'app-auto-start',
          source: 'main-startup',
        });
        logger.info('Gateway auto-start succeeded');
      }
    } catch (error) {
      logger.error('Gateway auto-start failed:', error);
      mainWindow?.webContents.send('gateway:error', String(error));
    }
  } else if (isE2EMode) {
    logger.info('Gateway auto-start skipped in E2E mode');
  } else if (!managedProviderReadyForGateway) {
    logger.info('Gateway auto-start skipped until JunFeiAI account, device authorization, and relay token are ready');
  } else {
    logger.info('Gateway auto-start disabled in settings');
  }

  if (!isE2EMode) {
    const seedPromise = managedProviderStartupSeed
      ? Promise.resolve(managedProviderStartupSeed)
      : ensureJunFeiAIProviderSeeded({
        gatewayManager,
        syncRuntime: false,
        syncRuntimeOnAuthChange: true,
      });
    void seedPromise.then(async (seed) => {
      if (!seed.managed) {
        return;
      }
      logger.info(
        `JunFeiAI provider verified from ${seed.source}; auth=${seed.authValid ? 'valid' : 'missing'} relayToken=${seed.hasRelayToken ? 'present' : 'missing'} activation=${seed.activationRequired ? 'required' : 'ready'}`,
      );
      if (isJunFeiAISeedReady(seed)) {
        await runManagedOpenAiStartupMigration();
      }
      if (
        gatewayAutoStart
        && isJunFeiAISeedReady(seed)
        && gatewayManager.getStatus().state === 'stopped'
      ) {
        try {
          const runtimeReady = await syncProviderRuntimeBeforeGatewayStart(gatewayManager, seed);
          if (runtimeReady) {
            logger.debug('Auto-starting Gateway after JunFeiAI background verification...');
            await gatewayManager.start({
              reason: 'junfeiai-background-verification',
              source: 'main-startup',
            });
            logger.info('Gateway auto-start after JunFeiAI verification succeeded');
          }
        } catch (error) {
          logger.error('Gateway auto-start after JunFeiAI verification failed:', error);
          mainWindow?.webContents.send('gateway:error', String(error));
        }
      }
    }).catch((error) => {
      logger.warn('Failed to verify JunFeiAI provider in background:', error);
    });
  }

  // Merge ClawX context snippets into the workspace bootstrap files.
  // The gateway seeds workspace files asynchronously after its HTTP server
  // is ready, so ensureClawXContext will retry until the target files appear.
  if (!isE2EMode) {
    void ensureClawXContext().catch((error) => {
      logger.warn('Failed to merge ClawX context into workspace:', error);
    });
  }

  // Auto-install openclaw CLI and shell completions (non-blocking).
  if (!isE2EMode && !isPortableMode()) {
    void autoInstallCliIfNeeded((installedPath) => {
      mainWindow?.webContents.send('openclaw:cli-installed', installedPath);
    }).then(() => {
      generateCompletionCache();
      installCompletionToProfile();
    }).catch((error) => {
      logger.warn('CLI auto-install failed:', error);
    });
  } else if (isPortableMode()) {
    logger.info('Portable mode enabled: OpenClaw CLI shell integration is skipped');
  }
}

if (gotTheLock) {
  const requestQuitOnSignal = createSignalQuitHandler({
    logInfo: (message) => logger.info(message),
    requestQuit: () => app.quit(),
  });

  process.on('exit', () => {
    releaseProcessInstanceFileLock();
  });

  process.once('SIGINT', () => requestQuitOnSignal('SIGINT'));
  process.once('SIGTERM', () => requestQuitOnSignal('SIGTERM'));

  app.on('will-quit', () => {
    releaseProcessInstanceFileLock();
  });

  if (process.platform === 'win32') {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  gatewayManager = new GatewayManager();
  clawHubService = new ClawHubService();
  hostEventBus = new HostEventBus();

  // Register builtin extensions and load manifest
  registerAllBuiltinExtensions();
  loadExternalMainExtensions();
  extensionsLoadPromise = loadExtensionsFromManifest().catch((err) => {
    logger.warn('Failed to load extensions from manifest:', err);
  });

  // When a second instance is launched, focus the existing window instead.
  app.on('second-instance', () => {
    logger.info('Second UClaw instance detected; redirecting to the existing window');

    const focusRequest = requestSecondInstanceFocus(
      mainWindowFocusState,
      Boolean(mainWindow && !mainWindow.isDestroyed()),
    );

    if (focusRequest === 'focus-now') {
      focusMainWindow();
      return;
    }

    logger.debug('Main window is not ready yet; deferring second-instance focus until ready-to-show');
  });

  // Application lifecycle
  app.whenReady().then(() => {
    void initialize().catch((error) => {
      logger.error('Application initialization failed:', error);
    });

    // Register activate handler AFTER app is ready to prevent
    // "Cannot create BrowserWindow before app is ready" on macOS.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      } else {
        focusMainWindow();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' || isE2EMode) {
      app.quit();
    }
  });

  app.on('before-quit', (event) => {
    setQuitting();
    const action = requestQuitLifecycleAction(quitLifecycleState);

    if (action === 'allow-quit') {
      return;
    }

    event.preventDefault();

    if (action === 'cleanup-in-progress') {
      logger.debug('Quit requested while cleanup already in progress; waiting for shutdown task to finish');
      return;
    }

    hostEventBus.closeAll();
    hostApiServer?.close();
    void extensionRegistry.teardownAll();

    const stopPromise = gatewayManager.stop({
      reason: 'app-quit',
      source: 'main-before-quit',
    }).catch((err) => {
      logger.warn('gatewayManager.stop() error during quit:', err);
    });
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    void Promise.race([stopPromise.then(() => 'stopped' as const), timeoutPromise]).then((result) => {
      if (result === 'timeout') {
        logger.warn('Gateway shutdown timed out during app quit; proceeding with forced quit');
        void gatewayManager.forceTerminateOwnedProcessForQuit().then((terminated) => {
          if (terminated) {
            logger.warn('Forced gateway process termination completed after quit timeout');
          }
        }).catch((err) => {
          logger.warn('Forced gateway termination failed after quit timeout:', err);
        });
      }
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    });
  });

  // Best-effort Gateway cleanup on unexpected crashes.
  // These handlers attempt to terminate the Gateway child process within a
  // short timeout before force-exiting, preventing orphaned processes.
  let emergencyCleanupStarted = false;
  let processOutputFailureHandled = false;
  const emergencyGatewayCleanup = (reason: string, error: unknown): void => {
    if (isProcessOutputError(error)) {
      disableConsoleOutput();
      if (!processOutputFailureHandled) {
        processOutputFailureHandled = true;
        logger.warn('Process console output became unavailable; continuing with file-only logging');
      }
      return;
    }
    if (emergencyCleanupStarted) return;
    emergencyCleanupStarted = true;
    logger.error(`${reason}:`, error);
    try {
      void gatewayManager?.stop({
        reason: 'main-process-emergency',
        source: 'main-process-fatal-handler',
      }).catch(() => { /* ignore */ });
    } catch {
      // ignore — stop() may not be callable if state is corrupted
    }
    // Give Gateway stop a brief window, then force-exit.
    setTimeout(() => {
      process.exit(1);
    }, 3000).unref();
  };

  process.on('uncaughtException', (error) => {
    emergencyGatewayCleanup('Uncaught exception in main process', error);
  });

  process.on('unhandledRejection', (reason) => {
    emergencyGatewayCleanup('Unhandled promise rejection in main process', reason);
  });
}

// Export for testing
export { mainWindow, gatewayManager };
