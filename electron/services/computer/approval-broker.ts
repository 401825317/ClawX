import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  DesktopAction,
  DesktopApprovalView,
  DesktopRunContext,
} from './types';

const DEFAULT_APPROVAL_TTL_MS = 2 * 60 * 1000;
const MAX_APPROVALS = 100;

interface ApprovalRecord extends DesktopApprovalView {
  approvalToken: string;
}

export type DesktopApprovalListener = (approval: DesktopApprovalView) => void;

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`;
}

export function fingerprintDesktopAction(action: DesktopAction): string {
  return createHash('sha256').update(canonicalize(action)).digest('hex');
}

function publicView(record: ApprovalRecord): DesktopApprovalView {
  const { approvalToken: _approvalToken, ...view } = record;
  return { ...view };
}

/**
 * Approval authority is intentionally Main-owned. The OpenClaw plugin can
 * create/read a pending request, but only a trusted renderer IPC bridge may
 * call approveFromUserInterface and receive the opaque one-time token.
 */
export class ApprovalBroker {
  private readonly approvals = new Map<string, ApprovalRecord>();
  private readonly listeners = new Set<DesktopApprovalListener>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  subscribe(listener: DesktopApprovalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request(context: DesktopRunContext, action: DesktopAction, reason: string): DesktopApprovalView {
    this.prune();
    const now = Date.now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      sessionKey: context.sessionKey,
      runId: context.runId,
      toolCallId: context.toolCallId,
      action: structuredClone(action),
      actionFingerprint: fingerprintDesktopAction(action),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEFAULT_APPROVAL_TTL_MS).toISOString(),
      status: 'pending',
      reason,
      approvalToken: randomBytes(32).toString('base64url'),
    };
    this.approvals.set(record.id, record);
    this.scheduleExpiry(record);
    this.trimToLimit();
    this.publish(record);
    return publicView(record);
  }

  get(id: string): DesktopApprovalView | null {
    this.prune();
    const record = this.approvals.get(id);
    return record ? publicView(record) : null;
  }

  listPending(context?: Partial<DesktopRunContext>): DesktopApprovalView[] {
    this.prune();
    return [...this.approvals.values()]
      .filter((record) => record.status === 'pending')
      .filter((record) => !context?.sessionKey || record.sessionKey === context.sessionKey)
      .filter((record) => !context?.runId || record.runId === context.runId)
      .map(publicView);
  }

  listForReplay(context?: Partial<DesktopRunContext>): DesktopApprovalView[] {
    this.prune();
    return [...this.approvals.values()]
      .filter((record) => !context?.sessionKey || record.sessionKey === context.sessionKey)
      .filter((record) => !context?.runId || record.runId === context.runId)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
      .map(publicView);
  }

  deny(id: string): DesktopApprovalView | null {
    this.prune();
    const record = this.approvals.get(id);
    if (!record) return null;
    if (record.status === 'pending') {
      record.status = 'denied';
      this.cancelExpiry(record.id);
      this.publish(record);
    }
    return publicView(record);
  }

  approveFromUserInterface(id: string): { approval: DesktopApprovalView; approvalToken: string } | null {
    this.prune();
    const record = this.approvals.get(id);
    if (!record || record.status !== 'pending') return null;
    record.status = 'approved';
    this.publish(record);
    return {
      approval: publicView(record),
      approvalToken: record.approvalToken,
    };
  }

  consumeApproved(
    id: string,
    token: string,
    context: DesktopRunContext,
    action: DesktopAction,
  ): DesktopApprovalView | null {
    this.prune();
    const record = this.approvals.get(id);
    if (!record || record.status !== 'approved') return null;
    if (record.approvalToken !== token) return null;
    if (record.sessionKey !== context.sessionKey || record.runId !== context.runId) return null;
    if (record.actionFingerprint !== fingerprintDesktopAction(action)) return null;
    record.status = 'consumed';
    this.cancelExpiry(record.id);
    this.publish(record);
    return publicView(record);
  }

  private prune(now = Date.now()): void {
    for (const record of this.approvals.values()) {
      if (record.status === 'pending' || record.status === 'approved') {
        if (Date.parse(record.expiresAt) <= now) {
          record.status = 'expired';
          this.cancelExpiry(record.id);
          this.publish(record);
        }
      }
    }
  }

  private scheduleExpiry(record: ApprovalRecord): void {
    this.cancelExpiry(record.id);
    const timer = setTimeout(() => {
      const current = this.approvals.get(record.id);
      if (!current || (current.status !== 'pending' && current.status !== 'approved')) return;
      if (Date.parse(current.expiresAt) > Date.now()) {
        this.scheduleExpiry(current);
        return;
      }
      current.status = 'expired';
      this.cancelExpiry(current.id);
      this.publish(current);
    }, Math.max(0, Date.parse(record.expiresAt) - Date.now()));
    timer.unref();
    this.expiryTimers.set(record.id, timer);
  }

  private cancelExpiry(id: string): void {
    const timer = this.expiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(id);
  }

  private publish(record: ApprovalRecord): void {
    const view = publicView(record);
    for (const listener of this.listeners) {
      try {
        listener(view);
      } catch {
        // Approval state transitions must not depend on observer health.
      }
    }
  }

  private trimToLimit(): void {
    if (this.approvals.size <= MAX_APPROVALS) return;
    const records = [...this.approvals.values()].sort((left, right) => (
      Date.parse(left.createdAt) - Date.parse(right.createdAt)
    ));
    while (this.approvals.size > MAX_APPROVALS && records.length > 0) {
      const oldest = records.shift();
      if (oldest) {
        this.cancelExpiry(oldest.id);
        this.approvals.delete(oldest.id);
      }
    }
  }
}
