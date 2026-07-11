export type ComputerPlatform = 'darwin' | 'win32' | 'linux' | 'unsupported';

export type ComputerPermissionState =
  | 'granted'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'not-required'
  | 'unavailable'
  | 'unknown';

export type ComputerCapabilityStatus = 'available' | 'unavailable' | 'not-implemented';

export type DesktopActionKind =
  | 'click'
  | 'drag'
  | 'scroll'
  | 'press_key'
  | 'type_text'
  | 'set_value'
  | 'select_text'
  | 'perform_secondary_action';

export interface DesktopRectangle {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopCoordinateMapping {
  screenshotOrigin: { x: 0; y: 0 };
  screenOrigin: { x: number; y: number } | null;
  screenshotSize: { width: number; height: number };
  screenBounds: DesktopRectangle | null;
  scaleX: number | null;
  scaleY: number | null;
  formula: string;
}

export interface DesktopScreenshot {
  fileName: string;
  filePath: string;
  mimeType: 'image/png';
  fileSize: number;
  width: number;
  height: number;
  capturedAt: string;
  sourceId: string;
  sourceName: string;
  coordinateMapping: DesktopCoordinateMapping;
}

export interface DesktopApp {
  id: string;
  displayName: string;
  isRunning: boolean;
  sourceId?: string;
  platform: ComputerPlatform;
}

export interface DesktopAccessibilitySnapshot {
  supported: boolean;
  text: string;
  elements: Array<{
    index: number;
    role?: string;
    name?: string;
    value?: string;
    bounds?: DesktopRectangle;
    actions?: string[];
  }>;
  reason?: string;
}

export interface DesktopAppState {
  app: DesktopApp;
  snapshotId: string;
  stateVersion: string;
  capturedAt: string;
  screenshot: DesktopScreenshot | null;
  accessibility: DesktopAccessibilitySnapshot;
  permission: ComputerPermissionState;
  error?: ComputerBackendError;
}

export interface ComputerCapability {
  name: string;
  status: ComputerCapabilityStatus;
  reason?: string;
}

export interface ComputerUseCapabilities {
  platform: ComputerPlatform;
  driver: string;
  capturePermission: ComputerPermissionState;
  capabilities: ComputerCapability[];
}

export interface ComputerBackendError {
  code:
    | 'permission_denied'
    | 'capture_unavailable'
    | 'target_not_found'
    | 'driver_unavailable'
    | 'unsupported_platform'
    | 'invalid_request'
    | 'internal_error';
  message: string;
  retryable: boolean;
}

export interface DesktopAppTarget {
  appId?: string;
  sourceId?: string;
  titleIncludes?: string;
}

export interface DesktopObservationRequest {
  target?: DesktopAppTarget;
  maxScreenshotSide?: number;
}

export interface DesktopAction {
  kind: DesktopActionKind;
  appId: string;
  elementIndex?: number;
  x?: number;
  y?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  button?: 'left' | 'right' | 'middle';
  direction?: 'up' | 'down' | 'left' | 'right';
  pages?: number;
  key?: string;
  text?: string;
  value?: string;
  action?: string;
}

export interface DesktopActionExecution {
  status: 'completed' | 'unsupported' | 'failed';
  action: DesktopAction;
  error?: ComputerBackendError;
}

export interface ComputerUseBackend {
  getCapabilities(): Promise<ComputerUseCapabilities>;
  listApps(): Promise<DesktopApp[]>;
  observe(request: DesktopObservationRequest): Promise<DesktopAppState>;
  execute(action: DesktopAction): Promise<DesktopActionExecution>;
}

export interface DesktopRunContext {
  sessionKey: string;
  runId: string;
}

export interface DesktopActionRequest extends DesktopRunContext {
  action: DesktopAction;
  snapshotId: string;
}

export interface DesktopApprovalView extends DesktopRunContext {
  id: string;
  action: DesktopAction;
  actionFingerprint: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'consumed';
  reason: string;
}

export type DesktopActionRequestResult =
  | { status: 'completed'; execution: DesktopActionExecution; state: DesktopAppState }
  | { status: 'approval_required'; approval: DesktopApprovalView }
  | { status: 'blocked'; error: ComputerBackendError };
