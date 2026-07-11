import { ApprovalBroker } from './approval-broker';
import { ElectronDesktopBackend } from './electron-desktop-backend';
import type {
  ComputerBackendError,
  ComputerUseBackend,
  DesktopActionRequest,
  DesktopActionRequestResult,
  DesktopAppState,
  DesktopObservationRequest,
  DesktopRunContext,
} from './types';

const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const MAX_SNAPSHOTS = 128;

interface StoredSnapshot {
  context: DesktopRunContext;
  state: DesktopAppState;
  expiresAt: number;
}

function blocked(code: ComputerBackendError['code'], message: string, retryable: boolean): DesktopActionRequestResult {
  return { status: 'blocked', error: { code, message, retryable } };
}

function requireContext(context: DesktopRunContext): ComputerBackendError | null {
  if (!context.sessionKey.trim()) return { code: 'invalid_request', message: 'sessionKey is required for desktop actions.', retryable: false };
  if (!context.runId.trim()) return { code: 'invalid_request', message: 'runId is required for desktop actions.', retryable: false };
  return null;
}

function isFiniteCoordinate(value: number | undefined): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateAction(action: DesktopActionRequest['action']): ComputerBackendError | null {
  const validKinds = new Set([
    'click',
    'drag',
    'scroll',
    'press_key',
    'type_text',
    'set_value',
    'select_text',
    'perform_secondary_action',
  ]);
  if (!validKinds.has(action.kind)) return { code: 'invalid_request', message: 'Unsupported desktop action kind.', retryable: false };
  if (!action.appId?.trim() || action.appId.length > 256) {
    return { code: 'invalid_request', message: 'action.appId must be a non-empty value up to 256 characters.', retryable: false };
  }
  if (action.elementIndex !== undefined && (!Number.isInteger(action.elementIndex) || action.elementIndex < 0)) {
    return { code: 'invalid_request', message: 'elementIndex must be a non-negative integer.', retryable: false };
  }
  if (action.kind === 'click') {
    const hasCoordinates = isFiniteCoordinate(action.x) && isFiniteCoordinate(action.y);
    if (action.elementIndex === undefined && !hasCoordinates) {
      return { code: 'invalid_request', message: 'click requires elementIndex or both x and y.', retryable: false };
    }
  }
  if (action.kind === 'drag' && ![action.fromX, action.fromY, action.toX, action.toY].every(isFiniteCoordinate)) {
    return { code: 'invalid_request', message: 'drag requires finite fromX, fromY, toX, and toY.', retryable: false };
  }
  if (action.kind === 'scroll' && !['up', 'down', 'left', 'right'].includes(action.direction ?? '')) {
    return { code: 'invalid_request', message: 'scroll requires direction up, down, left, or right.', retryable: false };
  }
  if (action.kind === 'press_key' && (!action.key?.trim() || action.key.length > 128)) {
    return { code: 'invalid_request', message: 'press_key requires key up to 128 characters.', retryable: false };
  }
  if (action.kind === 'type_text' && (typeof action.text !== 'string' || action.text.length > 20_000)) {
    return { code: 'invalid_request', message: 'type_text requires text up to 20000 characters.', retryable: false };
  }
  if ((action.kind === 'set_value' || action.kind === 'select_text') && action.elementIndex === undefined) {
    return { code: 'invalid_request', message: `${action.kind} requires elementIndex.`, retryable: false };
  }
  if (action.kind === 'set_value' && (typeof action.value !== 'string' || action.value.length > 20_000)) {
    return { code: 'invalid_request', message: 'set_value requires value up to 20000 characters.', retryable: false };
  }
  if (action.kind === 'select_text' && (typeof action.text !== 'string' || action.text.length > 20_000)) {
    return { code: 'invalid_request', message: 'select_text requires text up to 20000 characters.', retryable: false };
  }
  if (action.kind === 'perform_secondary_action' && (action.elementIndex === undefined || !action.action?.trim() || action.action.length > 256)) {
    return { code: 'invalid_request', message: 'perform_secondary_action requires elementIndex and action up to 256 characters.', retryable: false };
  }
  return null;
}

/**
 * Serializes global desktop work. Observations are tied to one session/run and
 * expire quickly, which prevents a stale screenshot or element index from
 * being replayed after focus changes.
 */
export class DesktopRunCoordinator {
  readonly approvals = new ApprovalBroker();
  private readonly snapshots = new Map<string, StoredSnapshot>();
  private queueTail: Promise<void> = Promise.resolve();

  constructor(private readonly backend: ComputerUseBackend = new ElectronDesktopBackend()) {}

  getCapabilities() {
    return this.backend.getCapabilities();
  }

  listApps() {
    return this.backend.listApps();
  }

  async observe(context: DesktopRunContext, request: DesktopObservationRequest): Promise<DesktopAppState> {
    const contextError = requireContext(context);
    if (contextError) throw new Error(contextError.message);
    return this.exclusive(async () => {
      const state = await this.backend.observe(request);
      this.rememberSnapshot(context, state);
      return state;
    });
  }

  async requestAction(request: DesktopActionRequest): Promise<DesktopActionRequestResult> {
    const context: DesktopRunContext = { sessionKey: request.sessionKey, runId: request.runId };
    const contextError = requireContext(context);
    if (contextError) return { status: 'blocked', error: contextError };
    if (!request.snapshotId?.trim()) return blocked('invalid_request', 'snapshotId is required for desktop actions.', false);
    if (!request.action) return blocked('invalid_request', 'action is required for desktop actions.', false);
    const actionError = validateAction(request.action);
    if (actionError) return { status: 'blocked', error: actionError };
    this.pruneSnapshots();
    const snapshot = this.snapshots.get(request.snapshotId);
    if (!snapshot) return blocked('invalid_request', 'Desktop snapshot is missing or expired; observe the app again.', true);
    if (snapshot.context.sessionKey !== context.sessionKey || snapshot.context.runId !== context.runId) {
      return blocked('invalid_request', 'Desktop snapshot belongs to a different run.', false);
    }
    if (snapshot.state.app.id !== request.action.appId) {
      return blocked('invalid_request', 'Action appId does not match the observed application.', false);
    }
    const approval = this.approvals.request(
      context,
      request.action,
      'Desktop actions require explicit approval from the local UClaw UI immediately before execution.',
    );
    return { status: 'approval_required', approval };
  }

  /**
   * Trusted Main/IPC only. Do not expose the approval token to OpenClaw or
   * route this method through the gateway-authenticated Host API.
   */
  async approveAndExecuteFromUserInterface(approvalId: string): Promise<DesktopActionRequestResult> {
    const approved = this.approvals.approveFromUserInterface(approvalId);
    if (!approved) return blocked('invalid_request', 'Approval request is not pending or has expired.', false);
    const approval = approved.approval;
    const consumed = this.approvals.consumeApproved(
      approval.id,
      approved.approvalToken,
      { sessionKey: approval.sessionKey, runId: approval.runId },
      approval.action,
    );
    if (!consumed) return blocked('invalid_request', 'Approval token validation failed.', false);

    return this.exclusive(async () => {
      const execution = await this.backend.execute(approval.action);
      const state = await this.backend.observe({ target: { appId: approval.action.appId } });
      this.rememberSnapshot({ sessionKey: approval.sessionKey, runId: approval.runId }, state);
      if (execution.status !== 'completed') {
        return blocked(
          execution.error?.code ?? 'driver_unavailable',
          execution.error?.message ?? 'Desktop action did not complete.',
          execution.error?.retryable ?? false,
        );
      }
      if (state.error) return blocked(state.error.code, state.error.message, state.error.retryable);
      return { status: 'completed', execution, state };
    });
  }

  denyApproval(approvalId: string) {
    return this.approvals.deny(approvalId);
  }

  private rememberSnapshot(context: DesktopRunContext, state: DesktopAppState): void {
    this.pruneSnapshots();
    this.snapshots.set(state.snapshotId, {
      context: { ...context },
      state,
      expiresAt: Date.now() + SNAPSHOT_TTL_MS,
    });
    while (this.snapshots.size > MAX_SNAPSHOTS) {
      const oldest = this.snapshots.keys().next().value as string | undefined;
      if (!oldest) break;
      this.snapshots.delete(oldest);
    }
  }

  private pruneSnapshots(now = Date.now()): void {
    for (const [snapshotId, snapshot] of this.snapshots) {
      if (snapshot.expiresAt <= now) this.snapshots.delete(snapshotId);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queueTail;
    this.queueTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}

export const desktopRunCoordinator = new DesktopRunCoordinator();
