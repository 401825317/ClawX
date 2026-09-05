/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { portableModeInfo } from '../utils/portable-bootstrap';
import { app, BrowserWindow, dialog, nativeImage, protocol, session, shell, type Session } from 'electron';
import { join } from 'path';
import { GatewayManager } from '../gateway/manager';
import { hasManagedRuntimeMutationMarker } from '../gateway/managed-runtime-mutation-barrier';
import { registerIpcHandlers } from './ipc-handlers';
import { HostApiRegistry } from './ipc/host-invoke';
import { createTray } from './tray';
import { createMenu } from './menu';
import { registerZoomShortcuts } from './zoom-shortcuts';

import { appUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { captureFatalException, initTelemetry, shutdownTelemetry } from '../utils/telemetry';
import { HOST_EVENT_CHANNELS } from '@shared/host-events/contract';

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
import { writePortableUpdateReadyMarker } from './portable-update-ready';
import { longTermRuleService } from '../services/long-term-rule-service';
import { artifactTaskService } from '../services/artifact-task-service';
import {
  startManagedClientRuntimeConfigRefresh,
  subscribeManagedClientRuntimeConfig,
} from '../services/managed-client-config-service';
import { PortableRuntimeSnapshotService } from '../utils/portable-runtime-state';
import {
  PortableRuntimeHealthMonitor,
  setActivePortableRuntimeHealthMonitor,
} from '../utils/portable-runtime-health';
import { migratePortableDefaultWorkspaceConfig } from '../utils/portable-workspace-migration';
import { runPortableFirstLaunchRepair } from '../utils/portable-first-launch-repair';
import { resolvePackagedPortableRootDir } from '../utils/portable-mode';
import {
  isConfiguredPortableOpenClawRuntimePrepared,
  prepareConfiguredPortableOpenClawRuntime,
} from '../utils/portable-openclaw-runtime';
import { WebBrowserGuestRegistry, installWebBrowserGuestPolicy } from './web-browser-policy';
import { configureWebBrowserSession } from './web-browser-session';
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
  runAbortableQuitTask,
} from './quit-lifecycle';
import { createSignalQuitHandler } from './signal-quit';
import { acquireProcessInstanceFileLock } from './process-instance-lock';
import { ensureBuiltinSkillsInstalled, removeRetiredPreinstalledSkills } from '../utils/skill-config';
import { createFatalHandler } from './fatal-handler';
import { getUclawBackendOrigin } from '../utils/junfeiai-distribution';
import {
  getUclawDiagnosticHeaders,
  mergeUclawDiagnosticHeaders,
} from '../utils/uclaw-request-diagnostics';

import { deviceOAuthManager } from '../utils/device-oauth';
import { browserOAuthManager } from '../utils/browser-oauth';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { syncAllProviderAuthToRuntime } from '../services/providers/provider-runtime-sync';
import { getManagedAuthLocalStatus } from '../services/managed-auth-service';
import { ATTACHMENT_VIDEO_STREAM_SCHEME } from '../services/attachment-video-stream';
import {
  startBlenderBridgeServer,
  stopBlenderBridgeServer,
} from '../services/blender/bridge-server';
import { isManagedRuntimeReady } from '../../shared/managed-auth';

const WINDOWS_APP_USER_MODEL_ID = 'app.clawx.desktop';
const isE2EMode = process.env.CLAWX_E2E === '1';
const requestedUserDataDir = process.env.CLAWX_USER_DATA_DIR?.trim();
const requestedRemoteDebuggingPort = process.env.CLAWX_REMOTE_DEBUGGING_PORT?.trim();

// The Main-owned attachment handler enforces authorization before serving bytes.
protocol.registerSchemesAsPrivileged([{
  scheme: ATTACHMENT_VIDEO_STREAM_SCHEME,
  privileges: {
    standard: true,
    secure: true,
    stream: true,
  },
}]);

if (requestedRemoteDebuggingPort) {
  app.commandLine.appendSwitch('remote-debugging-port', requestedRemoteDebuggingPort);
}

if (portableModeInfo.enabled && portableModeInfo.runtimeElectronCacheDir) {
  app.commandLine.appendSwitch('disk-cache-dir', portableModeInfo.runtimeElectronCacheDir);
}

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
}

// Disable GPU hardware acceleration globally for maximum stability across
// all GPU configurations (no GPU, integrated, discrete).
//
// Rationale (following VS Code's philosophy):
// - Page/file loading is async data fetching — zero GPU dependency.
// - The original per-platform GPU branching was added to avoid CPU rendering
//   competing with sync I/O on Windows, but all file I/O is now async
//   (fs/promises), so that concern no longer applies.
// - Software rendering is deterministic across all hardware; GPU compositing
//   behaviour varies between vendors (Intel, AMD, NVIDIA, Apple Silicon) and
//   driver versions, making it the #1 source of rendering bugs in Electron.
//
// Users who want GPU acceleration can pass `--enable-gpu` on the CLI or
// set `"disable-hardware-acceleration": false` in the app config (future).
app.disableHardwareAcceleration();

// On Linux, set CHROME_DESKTOP so Chromium can find the correct .desktop file.
// On Wayland this maps the running window to clawx.desktop (→ icon + app grouping);
// on X11 it supplements the StartupWMClass matching.
// Must be called before app.whenReady() / before any window is created.
if (process.platform === 'linux') {
  const linuxApp = app as typeof app & { setDesktopName?: (desktopName: string) => void };
  linuxApp.setDesktopName?.('clawx.desktop');
}

// Prevent multiple instances of the app from running simultaneously.
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
    const fileLock = acquireProcessInstanceFileLock({
      userDataDir: app.getPath('userData'),
      lockName: 'clawx',
      force: true, // Electron lock already guarantees exclusivity; force-clean orphan/recycled-PID locks
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
    console.warn('[UClaw] Failed to acquire process instance file lock; continuing with Electron single-instance lock only', error);
  }
}
const gotTheLock = gotElectronLock && gotFileLock;

// Global references
let mainWindow: BrowserWindow | null = null;
let gatewayManager!: GatewayManager;
let clawHubService!: ClawHubService;
const hostApiRegistry = new HostApiRegistry();
const webBrowserGuestRegistry = new WebBrowserGuestRegistry();
let webBrowserSession!: Session;
let stopManagedRuntimeConfigRefresh: (() => void) | null = null;
let unsubscribeManagedRuntimeConfig: (() => void) | null = null;
let telemetryInitializationPromise: Promise<void> | null = null;
let managedRuntimeShutdownRequested = false;
let managedRuntimeShutdownPromise: Promise<void> | null = null;
let mainRendererRecoveryTimer: NodeJS.Timeout | null = null;
let mainRendererRecoveryInFlight: Promise<void> | null = null;
const mainWindowFocusState = createMainWindowFocusState();
const quitLifecycleState = createQuitLifecycleState();

function stopManagedRuntimeServices(): Promise<void> {
  if (managedRuntimeShutdownPromise) return managedRuntimeShutdownPromise;
  managedRuntimeShutdownRequested = true;

  const stopRefresh = stopManagedRuntimeConfigRefresh;
  stopManagedRuntimeConfigRefresh = null;
  const unsubscribe = unsubscribeManagedRuntimeConfig;
  unsubscribeManagedRuntimeConfig = null;
  const telemetryInitialization = telemetryInitializationPromise;

  managedRuntimeShutdownPromise = Promise.resolve().then(async () => {
    try {
      stopRefresh?.();
    } catch (error) {
      logger.warn('Failed to stop managed runtime config refresh during quit:', error);
    }
    try {
      unsubscribe?.();
    } catch (error) {
      logger.warn('Failed to unsubscribe managed runtime config during quit:', error);
    }
    if (!telemetryInitialization) return;
    try {
      await telemetryInitialization;
      await shutdownTelemetry();
    } catch (error) {
      logger.warn('Failed to stop telemetry during quit:', error);
    }
  });

  return managedRuntimeShutdownPromise;
}

function isPortableRuntimeWarning(details: unknown): boolean {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(details, 'severity');
    return Boolean(descriptor && 'value' in descriptor && descriptor.value === 'warning');
  } catch {
    return false;
  }
}

const portableRuntimeHealthMonitor = portableModeInfo.portableRuntimeLayout
  ? new PortableRuntimeHealthMonitor({
      markerPath: portableModeInfo.portableRuntimeLayout.markerPath,
      onChange: snapshot => sendMainWindowEvent(
        HOST_EVENT_CHANNELS.app.portableRuntimeHealthChanged,
        snapshot,
      ),
    })
  : null;
setActivePortableRuntimeHealthMonitor(portableRuntimeHealthMonitor);

const portableRuntimeSnapshotService = portableModeInfo.portableRuntimeLayout
  ? new PortableRuntimeSnapshotService(
      portableModeInfo.portableRuntimeLayout,
      (message, details) => {
        portableRuntimeHealthMonitor?.observeSnapshotEvent(details);
        if (isPortableRuntimeWarning(details)) {
          logger.warn(message, details);
          return;
        }
        logger.info(message, details);
      },
    )
  : null;

function registerUclawRequestDiagnostics(targetSession: Session): void {
  let urlPattern: string;
  try {
    urlPattern = `${new URL(getUclawBackendOrigin()).origin}/*`;
  } catch {
    return;
  }
  targetSession.webRequest.onBeforeSendHeaders(
    { urls: [urlPattern] },
    (details, callback) => {
      void getUclawDiagnosticHeaders().then((diagnostics) => {
        callback({
          requestHeaders: mergeUclawDiagnosticHeaders(details.requestHeaders, diagnostics),
        });
      }).catch(() => callback({ requestHeaders: details.requestHeaders }));
    },
  );
}

function sendMainWindowEvent(channel: string, payload: unknown): void {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

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

  installWebBrowserGuestPolicy(win.webContents, {
    browserSession: webBrowserSession,
    registry: webBrowserGuestRegistry,
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

  return win;
}

function loadMainWindow(win: BrowserWindow): void {
  const shouldSkipSetupForE2E = process.env.CLAWX_E2E_SKIP_SETUP === '1';

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
}

function loadPortableRuntimePreparationWindow(win: BrowserWindow): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;background:#f7f7f5;color:#20201e;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
    main{height:100vh;display:flex;align-items:center;justify-content:center;gap:18px;padding:32px;box-sizing:border-box}
    .spinner{width:24px;height:24px;border:3px solid #d8d8d3;border-top-color:#e34d2f;border-radius:50%;animation:spin .9s linear infinite;flex:none}
    h1{font-size:18px;margin:0 0 8px;font-weight:650}p{font-size:13px;line-height:1.55;color:#66645f;margin:0}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body><main><div class="spinner"></div><div><h1>正在准备运行环境</h1>
  <p>首次在这台电脑启动可能需要几分钟，请保持 U 盘连接。</p></div></main></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
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

    void writePortableUpdateReadyMarker().then((written) => {
      if (written) {
        logger.info('Portable update startup marker written after the main window became ready');
      }
    }).catch((error) => {
      logger.error('Failed to write portable update startup marker:', error);
    });

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
    if (mainRendererRecoveryTimer) {
      clearTimeout(mainRendererRecoveryTimer);
      mainRendererRecoveryTimer = null;
    }
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  const recoverRenderer = (reason: 'render-process-gone' | 'unresponsive'): void => {
    if (mainWindow !== win || win.isDestroyed() || isQuitting()) return;
    if (mainRendererRecoveryTimer) clearTimeout(mainRendererRecoveryTimer);
    mainRendererRecoveryTimer = setTimeout(() => {
      mainRendererRecoveryTimer = null;
      if (mainRendererRecoveryInFlight || mainWindow !== win || win.isDestroyed() || isQuitting()) return;
      mainRendererRecoveryInFlight = Promise.resolve().then(() => {
        if (!win.isDestroyed()) win.webContents.reload();
      }).catch(() => undefined).finally(() => {
        mainRendererRecoveryInFlight = null;
      });
    }, reason === 'unresponsive' ? 5_000 : 0);
  };

  win.webContents.on('render-process-gone', (_event, details) => {
    logger.warn('Main renderer process gone; recovering renderer in isolation', {
      reason: details.reason,
      exitCode: details.exitCode,
    });
    recoverRenderer('render-process-gone');
  });
  win.webContents.on('unresponsive', () => {
    logger.warn('Main renderer became unresponsive; scheduling isolated recovery');
    recoverRenderer('unresponsive');
  });
  win.webContents.on('responsive', () => {
    if (mainRendererRecoveryTimer) {
      clearTimeout(mainRendererRecoveryTimer);
      mainRendererRecoveryTimer = null;
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

  // The portable bootstrap has already published OPENCLAW_HOME,
  // OPENCLAW_STATE_DIR, and OPENCLAW_WORKSPACE_DIR by the time this function
  // runs.  Migrate the config before health/snapshot services, workspace
  // provisioning, or Gateway prelaunch consumers can read the old USB path.
  const workspaceMigration = await migratePortableDefaultWorkspaceConfig();
  if (workspaceMigration.changed) {
    logger.info('Migrated portable default workspace configuration', {
      migratedFields: workspaceMigration.migratedFields,
      backupCreated: Boolean(workspaceMigration.backupPath),
    });
  }

  // A manual ZIP extraction can leave a complete-looking app directory while
  // silently dropping a runtime binary, OpenClaw payload, or plugin dependency.
  // Validate the immutable package before any Gateway consumer starts. Mutable
  // state and runtime-cache recovery have already run in portable bootstrap;
  // this gate never overwrites user data or user-owned extensions.
  if (portableModeInfo.enabled && app.isPackaged && portableModeInfo.portableLayout.hasPortableFlag) {
    const packageRootDir = resolvePackagedPortableRootDir(process.platform);
    // Windows portable verification must use the payload beside UClaw.exe.
    // A bootstrap probe can intentionally isolate mutable state, while
    // process.resourcesPath may still reflect that transient launch context.
    const packageResourcesDir = process.platform === 'win32'
      ? join(packageRootDir, 'resources')
      : process.resourcesPath;
    const firstLaunchRepair = runPortableFirstLaunchRepair({
      enabled: portableModeInfo.enabled,
      packaged: app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      rootDir: portableModeInfo.rootDir,
      dataDir: portableModeInfo.dataDir,
      packageRootDir,
      resourcesDir: packageResourcesDir,
      runtimeProfileDir: portableModeInfo.runtimeProfileDir,
      expectedVersion: app.getVersion(),
    });
    if (firstLaunchRepair.actions.length > 0) {
      logger.info('Portable first-launch integrity check completed', {
        status: firstLaunchRepair.status,
        actions: firstLaunchRepair.actions,
        markerPath: firstLaunchRepair.markerPath,
      });
    }
    if (firstLaunchRepair.status === 'blocked') {
      const details = firstLaunchRepair.errors.slice(0, 12).join('\n');
      logger.error('Portable package integrity check blocked startup', {
        errors: firstLaunchRepair.errors,
      });
      dialog.showErrorBox(
        'UClaw 启动检查失败',
        [
          '当前便携包内容不完整，Gateway 未启动。',
          '请重新下载完整版本，并解压到新的目录后再启动。',
          '',
          details,
        ].join('\n'),
      );
      app.quit();
      throw new Error(`Portable package integrity check failed: ${firstLaunchRepair.errors.join('; ')}`);
    }
  }

  logger.info('=== UClaw Application Starting ===');
  portableRuntimeHealthMonitor?.start();
  portableRuntimeSnapshotService?.start();
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}, pid=${process.pid}, ppid=${process.ppid}`
  );

  if (!isE2EMode) {
    try {
      const environment = await startBlenderBridgeServer();
      logger.info(`Blender bridge listening on ${environment.CLAWX_HOST_API_ORIGIN}`);
    } catch (error) {
      // Blender is optional; a bridge failure must not block chat startup.
      logger.warn('Failed to start the Blender bridge:', error);
    }
  }

  webBrowserSession = configureWebBrowserSession({
    registry: webBrowserGuestRegistry,
    getMainWindow: () => mainWindow,
  });

  if (!isE2EMode) {
    // Apply persisted proxy settings before any managed network request.
    await applyProxySettings();
    registerUclawRequestDiagnostics(session.defaultSession);
    unsubscribeManagedRuntimeConfig = subscribeManagedClientRuntimeConfig((current, previous) => {
      const wasEnabled = previous.config.features.longTermRules?.enabled === true;
      const isEnabled = current.config.features.longTermRules?.enabled === true;
      if (!wasEnabled && isEnabled) {
        void longTermRuleService.repairKnownWorkspaces().catch((error) => {
          logger.warn('Failed to repair long-term rule projections:', error);
        });
      }
    });
    stopManagedRuntimeConfigRefresh = startManagedClientRuntimeConfigRefresh();
    // Warm up network optimization without blocking the window or Gateway.
    void warmupNetworkOptimization();
    // Initialize telemetry after proxy setup so remote observability policy is reachable.
    if (!managedRuntimeShutdownRequested) {
      telemetryInitializationPromise = initTelemetry();
      await telemetryInitializationPromise;
    }
    if (portableModeInfo.enabled) {
      logger.info('Portable mode enabled: launch-at-startup sync is skipped');
    } else {
      await syncLaunchAtStartupSettingFromStore();
    }
  } else {
    logger.info('Running in E2E mode: startup side effects minimized');
  }

  // Set application menu
  await createMenu();

  // Create the main window
  const window = createMainWindow();

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
  registerIpcHandlers(
    gatewayManager,
    clawHubService,
    window,
    hostApiRegistry,
    webBrowserSession,
    webBrowserGuestRegistry,
  );

  // The renderer is allowed to become visible while a first-launch USB copy is
  // in progress, but no OpenClaw consumer may run before the immutable local
  // runtime has been completely published.
  if (portableModeInfo.enabled && app.isPackaged) {
    if (!isConfiguredPortableOpenClawRuntimePrepared()) {
      loadPortableRuntimePreparationWindow(window);
    }
    try {
      const prepared = await prepareConfiguredPortableOpenClawRuntime();
      if (prepared) {
        logger.info(
          `Portable OpenClaw runtime ${prepared.cacheHit ? 'cache hit' : 'prepared'} (${prepared.cacheKey})`,
        );
      }
    } catch (error) {
      logger.error('Failed to prepare the portable OpenClaw runtime:', error);
      dialog.showErrorBox(
        'UClaw startup failed',
        'The local runtime could not be prepared. Keep the USB drive connected, make sure the system drive has enough free space, and start UClaw again.',
      );
      throw error;
    }
  }

  loadMainWindow(window);

  // Retire only UClaw-owned document skills before the first renderer load.
  // Unmarked same-name directories are user-managed and must remain untouched.
  if (!isE2EMode) {
    try {
      const { removed, removedConfigs } = await removeRetiredPreinstalledSkills();
      if (removed > 0 || removedConfigs > 0) {
        logger.info(
          `Removed retired UClaw preinstalled skills: removed ${removed}, pruned configs ${removedConfigs}`,
        );
      }
    } catch (error) {
      logger.warn('Failed to remove retired UClaw preinstalled skills:', error);
    }
  }

  // Create system tray
  if (!isE2EMode) {
    createTray(window);
  }

  // Initialize extension system
  await extensionRegistry.initialize({
    gatewayManager,
    getMainWindow: () => mainWindow,
    hostApi: {
      register: (extensionId, contributions) => (
        hostApiRegistry.registerExtensionContributions(extensionId, contributions)
      ),
    },
  });

  // Wire all marketplace providers after extension initialization.
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
      logger.warn('Failed to seed default UClaw identity:', error);
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

  // Plugin installation is now configuration-driven:
  // - When a channel is added via UI: ensureXxxPluginInstalled() in IPC handlers
  // - When Gateway starts: ensureConfiguredPluginsUpgraded() in config-sync.ts
  // No need to pre-install all bundled plugins at app startup.

  // Bridge gateway and host-side events before any auto-start logic runs, so
  // renderer subscribers observe the full startup lifecycle.
  gatewayManager.on('status', (status: { state: string }) => {
    sendMainWindowEvent('gateway:status-changed', status);
    if (status.state === 'running' && !isE2EMode) {
      void ensureClawXContext().catch((error) => {
        logger.warn('Failed to re-merge UClaw context after gateway reconnect:', error);
      });
    }
  });

  gatewayManager.on('error', (error) => {
    sendMainWindowEvent('gateway:error', { message: error.message });
  });

  gatewayManager.on('notification', (notification) => {
    sendMainWindowEvent('gateway:notification', notification);
  });

  gatewayManager.on('gateway:health', (data) => {
    sendMainWindowEvent('gateway:health-changed', data);
  });

  gatewayManager.on('gateway:presence', (data) => {
    sendMainWindowEvent('gateway:presence-changed', data);
  });

  gatewayManager.on('chat:message', (data) => {
    sendMainWindowEvent('gateway:chat-message', data);
  });

  gatewayManager.on('chat:runtime-event', (data) => {
    sendMainWindowEvent('chat:runtime-event', data);
  });

  gatewayManager.on('channel:status', (data) => {
    sendMainWindowEvent('gateway:channel-status', data);
  });

  gatewayManager.on('exit', (code) => {
    sendMainWindowEvent('gateway:exit', { code });
  });

  deviceOAuthManager.on('oauth:code', (payload) => {
    sendMainWindowEvent('oauth:code', payload);
  });

  deviceOAuthManager.on('oauth:success', (payload) => {
    sendMainWindowEvent('oauth:success', { ...payload, success: true });
  });

  deviceOAuthManager.on('oauth:error', (error) => {
    sendMainWindowEvent('oauth:error', error);
  });

  browserOAuthManager.on('oauth:code', (payload) => {
    sendMainWindowEvent('oauth:code', payload);
  });

  browserOAuthManager.on('oauth:success', (payload) => {
    sendMainWindowEvent('oauth:success', { ...payload, success: true });
  });

  browserOAuthManager.on('oauth:error', (error) => {
    sendMainWindowEvent('oauth:error', error);
  });

  whatsAppLoginManager.on('qr', (data) => {
    sendMainWindowEvent('channel:whatsapp-qr', data);
  });

  whatsAppLoginManager.on('success', (data) => {
    sendMainWindowEvent('channel:whatsapp-success', data);
  });

  whatsAppLoginManager.on('error', (error) => {
    sendMainWindowEvent('channel:whatsapp-error', error);
  });

  // Start Gateway automatically (this seeds missing bootstrap files with full templates)
  const gatewayAutoStart = await getSetting('gatewayAutoStart');
  if (!isE2EMode && gatewayAutoStart) {
    try {
      if (await hasManagedRuntimeMutationMarker()) {
        logger.warn('Gateway auto-start and Provider sync skipped until managed credentials are recovered');
      } else {
        const managedAuthStatus = await getManagedAuthLocalStatus();
        if (!isManagedRuntimeReady(managedAuthStatus)) {
          logger.info('Gateway auto-start deferred until managed authentication is ready', {
            event: 'managed_gateway_start_deferred',
            authValid: managedAuthStatus.authValid,
            hasRelayToken: managedAuthStatus.hasRelayToken,
            activationRequired: managedAuthStatus.activationRequired,
            deviceActivated: managedAuthStatus.deviceActivated,
          });
        } else {
          await syncAllProviderAuthToRuntime({
            refreshManagedPolicy: true,
            reconcileManagedRuntime: true,
          });
          logger.debug('Auto-starting Gateway...');
          await gatewayManager.start();
          logger.info('Gateway auto-start succeeded');
        }
      }
    } catch (error) {
      logger.error('Gateway auto-start failed:', error);
      mainWindow?.webContents.send('gateway:error', String(error));
    }
  } else if (isE2EMode) {
    logger.info('Gateway auto-start skipped in E2E mode');
  } else {
    logger.info('Gateway auto-start disabled in settings');
  }

  // Merge ClawX context snippets into the workspace bootstrap files.
  // The gateway seeds workspace files asynchronously after its HTTP server
  // is ready, so ensureClawXContext will retry until the target files appear.
  if (!isE2EMode) {
    void ensureClawXContext().catch((error) => {
      logger.warn('Failed to merge UClaw context into workspace:', error);
    });
  }

  // Auto-install openclaw CLI and shell completions (non-blocking).
  if (!isE2EMode) {
    void autoInstallCliIfNeeded((installedPath) => {
      mainWindow?.webContents.send('openclaw:cli-installed', installedPath);
    }).then(() => {
      generateCompletionCache();
      installCompletionToProfile();
    }).catch((error) => {
      logger.warn('CLI auto-install failed:', error);
    });
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

  // Register builtin extensions and load manifest
  registerAllBuiltinExtensions();
  loadExternalMainExtensions();
  void loadExtensionsFromManifest().catch((err) => {
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
  app.whenReady().then(async () => {
    try {
      await initialize();
    } catch (error) {
      logger.error('Application initialization failed:', error);
      return;
    }

    // Register only after initialization so activation cannot race the initial
    // window or claim the single browser guest before host handlers are ready.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        loadMainWindow(createMainWindow());
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

    void extensionRegistry.teardownAll();

    // Disable remote refreshes and telemetry transport as soon as shutdown
    // starts. The memoized promise makes repeated quit requests harmless.
    const managedRuntimeShutdown = stopManagedRuntimeServices();

    const stopPromise = Promise.all([
      gatewayManager.stop().catch((err) => {
        logger.warn('gatewayManager.stop() error during quit:', err);
      }),
      stopBlenderBridgeServer().catch((err) => {
        logger.warn('stopBlenderBridgeServer() error during quit:', err);
      }),
      artifactTaskService.dispose().catch((err) => {
        logger.warn('artifactTaskService.dispose() error during quit:', err);
      }),
    ]).then(() => undefined);
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 5000);
    });

    const finalizeShutdown = async (): Promise<void> => {
      await managedRuntimeShutdown;
      portableRuntimeSnapshotService?.stop();
      if (portableRuntimeSnapshotService) {
        const snapshotResult = await runAbortableQuitTask(
          async (signal) => {
            await portableRuntimeSnapshotService.sync('shutdown', signal);
          },
          10_000,
        );
        if (snapshotResult === 'timeout') {
          logger.warn('Portable Runtime final snapshot timed out during app quit');
        }
      }
      portableRuntimeHealthMonitor?.stop();
      markQuitCleanupCompleted(quitLifecycleState);
      app.quit();
    };

    void Promise.race([stopPromise.then(() => 'stopped' as const), timeoutPromise]).then((result) => {
      if (result === 'timeout') {
        logger.warn('Gateway shutdown timed out during app quit; proceeding with forced quit');
        void gatewayManager.forceTerminateOwnedProcessForQuit().then((terminated) => {
          if (terminated) {
            logger.warn('Forced gateway process termination completed after quit timeout');
          }
        }).catch((err) => {
          logger.warn('Forced gateway termination failed after quit timeout:', err);
        }).finally(() => {
          void finalizeShutdown();
        });
        return;
      }
      void finalizeShutdown();
    });
  });

  // Best-effort Gateway cleanup on unexpected crashes.
  // These handlers attempt to terminate the Gateway child process within a
  // short timeout before force-exiting, preventing orphaned processes.
  const emergencyGatewayCleanup = createFatalHandler({
    getEmergencyLogPath: () => logger.getLogFilePath(),
    stopBlender: () => stopBlenderBridgeServer(),
    stopGateway: () => gatewayManager.stop(),
    forceTerminateGateway: () => gatewayManager.forceTerminateOwnedProcessForQuit(),
    exit: code => process.exit(code),
    captureFatal: captureFatalException,
  });

  process.on('uncaughtException', (error) => {
    emergencyGatewayCleanup('Uncaught exception in main process', error);
  });

  process.on('unhandledRejection', (reason) => {
    emergencyGatewayCleanup('Unhandled promise rejection in main process', reason);
  });
}

// Export for testing
export { mainWindow, gatewayManager };
