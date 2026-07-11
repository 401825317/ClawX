import { hostApiFetch } from './host-api';
import { invokeIpc } from './api-client';

export type DesktopApproval = {
  id: string;
  sessionKey: string;
  runId: string;
  action: {
    kind: string;
    appId: string;
  };
  createdAt: string;
  expiresAt: string;
  reason: string;
};

type DesktopApprovalsResponse = {
  approvals?: DesktopApproval[];
};

export async function listDesktopApprovals(sessionKey?: string): Promise<DesktopApproval[]> {
  const query = sessionKey ? `?sessionKey=${encodeURIComponent(sessionKey)}` : '';
  const response = await hostApiFetch<DesktopApprovalsResponse>(`/api/computer/approvals${query}`);
  return Array.isArray(response.approvals) ? response.approvals : [];
}

export async function approveDesktopAction(approvalId: string): Promise<{
  success: boolean;
  result?: unknown;
  error?: string;
}> {
  return await invokeIpc('desktop:approve', approvalId);
}

export async function denyDesktopAction(approvalId: string): Promise<void> {
  await hostApiFetch(`/api/computer/approvals/${encodeURIComponent(approvalId)}/deny`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}
