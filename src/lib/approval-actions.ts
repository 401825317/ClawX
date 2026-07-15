import type {
  ChatRuntimeApprovalDecision,
  ChatRuntimeApprovalKind,
} from '../../shared/chat-runtime-events';
import { invokeIpc } from './api-client';
import { approveDesktopAction, denyDesktopAction } from './desktop-control';

type ApprovalResolutionResponse = {
  success: boolean;
  result?: unknown;
  error?: string;
};

export async function resolveTimelineApproval(input: {
  approvalId: string;
  approvalKind: ChatRuntimeApprovalKind;
  decision: ChatRuntimeApprovalDecision;
}): Promise<void> {
  if (input.approvalKind === 'desktop') {
    if (input.decision === 'deny') {
      await denyDesktopAction(input.approvalId);
      return;
    }
    if (input.decision !== 'allow-once') throw new Error('Desktop approvals do not support this decision');
    const response = await approveDesktopAction(input.approvalId);
    if (!response.success) throw new Error(response.error || 'Desktop approval failed');
    return;
  }

  if (input.approvalKind !== 'exec' && input.approvalKind !== 'plugin') {
    throw new Error('This approval cannot be resolved from the timeline');
  }
  const response = await invokeIpc<ApprovalResolutionResponse>('approval:resolve', input);
  if (!response.success) throw new Error(response.error || 'Approval resolution failed');
}
