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

  request(context: DesktopRunContext, action: DesktopAction, reason: string): DesktopApprovalView {
    this.prune();
    const now = Date.now();
    const record: ApprovalRecord = {
      id: randomUUID(),
      sessionKey: context.sessionKey,
      runId: context.runId,
      action: structuredClone(action),
      actionFingerprint: fingerprintDesktopAction(action),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + DEFAULT_APPROVAL_TTL_MS).toISOString(),
      status: 'pending',
      reason,
      approvalToken: randomBytes(32).toString('base64url'),
    };
    this.approvals.set(record.id, record);
    this.trimToLimit();
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

  deny(id: string): DesktopApprovalView | null {
    this.prune();
    const record = this.approvals.get(id);
    if (!record) return null;
    if (record.status === 'pending') record.status = 'denied';
    return publicView(record);
  }

  approveFromUserInterface(id: string): { approval: DesktopApprovalView; approvalToken: string } | null {
    this.prune();
    const record = this.approvals.get(id);
    if (!record || record.status !== 'pending') return null;
    record.status = 'approved';
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
    return publicView(record);
  }

  private prune(now = Date.now()): void {
    for (const record of this.approvals.values()) {
      if (record.status === 'pending' || record.status === 'approved') {
        if (Date.parse(record.expiresAt) <= now) record.status = 'expired';
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
      if (oldest) this.approvals.delete(oldest.id);
    }
  }
}
