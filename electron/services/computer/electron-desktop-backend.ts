import { desktopCapturer, screen, systemPreferences } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getOpenClawMediaDir } from '../../utils/paths';
import type {
  ComputerBackendError,
  ComputerPermissionState,
  ComputerPlatform,
  ComputerUseBackend,
  ComputerUseCapabilities,
  DesktopAction,
  DesktopActionExecution,
  DesktopApp,
  DesktopAppState,
  DesktopObservationRequest,
  DesktopRectangle,
  DesktopScreenshot,
} from './types';

const DEFAULT_MAX_SCREENSHOT_SIDE = 1600;
const MIN_MAX_SCREENSHOT_SIDE = 640;
const MAX_MAX_SCREENSHOT_SIDE = 2560;

function currentPlatform(): ComputerPlatform {
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    return process.platform;
  }
  return 'unsupported';
}

function normalizePermission(value: string): ComputerPermissionState {
  if (value === 'granted' || value === 'denied' || value === 'restricted' || value === 'not-determined') return value;
  return 'unknown';
}

function error(code: ComputerBackendError['code'], message: string, retryable: boolean): ComputerBackendError {
  return { code, message, retryable };
}

function clampScreenshotSide(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SCREENSHOT_SIDE;
  return Math.max(MIN_MAX_SCREENSHOT_SIDE, Math.min(MAX_MAX_SCREENSHOT_SIDE, Math.floor(value!)));
}

function getManagedScreenshotDir(): string {
  return join(getOpenClawMediaDir(), 'computer-use', 'screenshots');
}

function buildScreenshotPath(): { fileName: string; filePath: string } {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const fileName = `desktop-${stamp}-${randomUUID().slice(0, 8)}.png`;
  return { fileName, filePath: join(getManagedScreenshotDir(), fileName) };
}

function toRectangle(input: Electron.Rectangle): DesktopRectangle {
  return { x: input.x, y: input.y, width: input.width, height: input.height };
}

function appFromSource(source: Electron.DesktopCapturerSource): DesktopApp {
  return {
    id: source.id,
    sourceId: source.id,
    displayName: source.name || 'Unnamed window',
    isRunning: true,
    platform: currentPlatform(),
  };
}

function unsupportedAction(action: DesktopAction, platform: ComputerPlatform): DesktopActionExecution {
  const driver = platform === 'darwin'
    ? 'macOS accessibility/action driver is not installed in this build'
    : platform === 'win32'
      ? 'Windows UI Automation driver is not installed in this build'
      : platform === 'linux'
        ? 'Linux AT-SPI/portal driver is not installed in this build'
        : 'This platform is not supported';
  return {
    status: 'unsupported',
    action,
    error: error('driver_unavailable', driver, false),
  };
}

/**
 * Electron owns screenshot capture and managed-media writes. Native input and
 * accessibility drivers remain separate adapters so Windows/Linux cannot
 * inherit macOS-only behavior accidentally.
 */
export class ElectronDesktopBackend implements ComputerUseBackend {
  async getCapabilities(): Promise<ComputerUseCapabilities> {
    const platform = currentPlatform();
    const capturePermission = this.capturePermission();
    const canObserve = platform === 'darwin' && capturePermission !== 'denied' && capturePermission !== 'restricted';
    return {
      platform,
      driver: platform === 'darwin' ? 'electron-desktop-capturer' : 'typed-placeholder',
      capturePermission,
      capabilities: [
        {
          name: 'desktop.capture',
          status: canObserve ? 'available' : platform === 'darwin' ? 'unavailable' : 'not-implemented',
          reason: canObserve ? undefined : this.captureUnavailableReason(platform, capturePermission),
        },
        {
          name: 'desktop.apps',
          status: canObserve ? 'available' : platform === 'darwin' ? 'unavailable' : 'not-implemented',
          reason: canObserve ? undefined : this.captureUnavailableReason(platform, capturePermission),
        },
        {
          name: 'desktop.accessibility',
          status: 'not-implemented',
          reason: 'A signed native accessibility driver is required for this platform.',
        },
        {
          name: 'desktop.actions',
          status: 'not-implemented',
          reason: 'Actions stay disabled until the native driver and approval UI are both wired.',
        },
      ],
    };
  }

  async listApps(): Promise<DesktopApp[]> {
    const platform = currentPlatform();
    if (platform !== 'darwin') return [];
    const permission = this.capturePermission();
    if (permission === 'denied' || permission === 'restricted') return [];
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window'],
        thumbnailSize: { width: 1, height: 1 },
        fetchWindowIcons: false,
      });
      const seen = new Set<string>();
      return sources
        .map(appFromSource)
        .filter((app) => {
          const key = `${app.id}:${app.displayName}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, 100);
    } catch {
      return [];
    }
  }

  async observe(request: DesktopObservationRequest): Promise<DesktopAppState> {
    const platform = currentPlatform();
    const permission = this.capturePermission();
    const app = await this.resolveTargetApp(request);
    if (platform !== 'darwin') {
      return this.failedState(app, permission, error('unsupported_platform', `${platform} computer driver is not implemented yet`, false));
    }
    if (permission === 'denied' || permission === 'restricted') {
      return this.failedState(app, permission, error('permission_denied', 'Screen Recording permission is required to observe the desktop.', false));
    }

    try {
      const screenshot = await this.captureScreenshot(request, app);
      const stateVersion = createHash('sha256')
        .update(`${screenshot.filePath}:${screenshot.fileSize}:${screenshot.capturedAt}`)
        .digest('hex');
      return {
        app,
        snapshotId: randomUUID(),
        stateVersion,
        capturedAt: screenshot.capturedAt,
        screenshot,
        accessibility: {
          supported: false,
          text: '',
          elements: [],
          reason: 'macOS accessibility driver is not installed in this build; use screenshot-only observation.',
        },
        permission,
      };
    } catch (captureError) {
      const message = captureError instanceof Error ? captureError.message : String(captureError);
      return this.failedState(app, permission, error('capture_unavailable', message, true));
    }
  }

  async execute(action: DesktopAction): Promise<DesktopActionExecution> {
    return unsupportedAction(action, currentPlatform());
  }

  private capturePermission(): ComputerPermissionState {
    if (process.platform !== 'darwin') return 'unavailable';
    try {
      return normalizePermission(systemPreferences.getMediaAccessStatus('screen'));
    } catch {
      return 'unknown';
    }
  }

  private captureUnavailableReason(platform: ComputerPlatform, permission: ComputerPermissionState): string {
    if (platform !== 'darwin') return `${platform} driver is a typed placeholder in this build.`;
    if (permission === 'denied' || permission === 'restricted') return 'Screen Recording permission is not granted.';
    return 'Electron screen capture is currently unavailable.';
  }

  private async resolveTargetApp(request: DesktopObservationRequest): Promise<DesktopApp> {
    const target = request.target;
    if (!target?.appId && !target?.sourceId && !target?.titleIncludes) {
      return {
        id: 'desktop:primary',
        displayName: 'Primary desktop',
        isRunning: true,
        platform: currentPlatform(),
      };
    }
    const apps = await this.listApps();
    const title = target.titleIncludes?.trim().toLowerCase();
    const app = apps.find((candidate) => candidate.id === target.appId || candidate.sourceId === target.sourceId)
      ?? apps.find((candidate) => title && candidate.displayName.toLowerCase().includes(title));
    return app ?? {
      id: target.appId || target.sourceId || `title:${title || 'unknown'}`,
      sourceId: target.sourceId || target.appId,
      displayName: target.titleIncludes || 'Unknown application',
      isRunning: false,
      platform: currentPlatform(),
    };
  }

  private async captureScreenshot(request: DesktopObservationRequest, app: DesktopApp): Promise<DesktopScreenshot> {
    const maxSide = clampScreenshotSide(request.maxScreenshotSide);
    const targetSourceId = app.sourceId;
    const captureWindow = Boolean(targetSourceId && app.id !== 'desktop:primary');
    const sources = await desktopCapturer.getSources({
      types: captureWindow ? ['window'] : ['screen'],
      thumbnailSize: { width: maxSide, height: maxSide },
      fetchWindowIcons: false,
    });
    const source = captureWindow
      ? sources.find((candidate) => candidate.id === targetSourceId)
      : sources[0];
    if (!source || source.thumbnail.isEmpty()) {
      throw new Error(captureWindow ? 'Target application window is unavailable for capture.' : 'No screen is available for capture.');
    }

    const png = source.thumbnail.toPNG();
    const size = source.thumbnail.getSize();
    const primary = screen.getPrimaryDisplay();
    const bounds = captureWindow ? null : toRectangle(primary.bounds);
    const { filePath } = buildScreenshotPath();
    await mkdir(getManagedScreenshotDir(), { recursive: true });
    await writeFile(filePath, png);
    const scaleX = bounds ? bounds.width / Math.max(1, size.width) : null;
    const scaleY = bounds ? bounds.height / Math.max(1, size.height) : null;
    return {
      fileName: basename(filePath),
      filePath,
      mimeType: 'image/png',
      fileSize: png.byteLength,
      width: size.width,
      height: size.height,
      capturedAt: new Date().toISOString(),
      sourceId: source.id,
      sourceName: source.name || app.displayName,
      coordinateMapping: {
        screenshotOrigin: { x: 0, y: 0 },
        screenOrigin: bounds ? { x: bounds.x, y: bounds.y } : null,
        screenshotSize: { width: size.width, height: size.height },
        screenBounds: bounds,
        scaleX,
        scaleY,
        formula: bounds && scaleX !== null && scaleY !== null
          ? `screenX = ${bounds.x} + screenshotX * ${scaleX}; screenY = ${bounds.y} + screenshotY * ${scaleY}`
          : 'Window bounds are unavailable; coordinates must not be used until a native accessibility driver is installed.',
      },
    };
  }

  private failedState(app: DesktopApp, permission: ComputerPermissionState, backendError: ComputerBackendError): DesktopAppState {
    return {
      app,
      snapshotId: randomUUID(),
      stateVersion: `error:${randomUUID()}`,
      capturedAt: new Date().toISOString(),
      screenshot: null,
      accessibility: {
        supported: false,
        text: '',
        elements: [],
        reason: backendError.message,
      },
      permission,
      error: backendError,
    };
  }
}
