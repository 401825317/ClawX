import { useEffect, useState } from 'react';
import { MonitorCog, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/stores/chat';
import {
  approveDesktopAction,
  denyDesktopAction,
  listDesktopApprovals,
  type DesktopApproval,
} from '@/lib/desktop-control';
import { Button } from '@/components/ui/button';

const POLL_INTERVAL_MS = 1_000;

export function DesktopApprovalOverlay() {
  const { t } = useTranslation('chat');
  const sessionKey = useChatStore((state) => state.currentSessionKey);
  const [approval, setApproval] = useState<DesktopApproval | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let disposed = false;
    const refresh = async (): Promise<void> => {
      try {
        const approvals = await listDesktopApprovals(sessionKey);
        if (!disposed) setApproval(approvals[0] ?? null);
      } catch {
        if (!disposed) setApproval(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [sessionKey]);

  if (!approval) return null;
  const actionKey = `desktopApproval.actions.${approval.action.kind}`;

  const approve = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await approveDesktopAction(approval.id);
      setApproval(null);
    } finally {
      setSubmitting(false);
    }
  };
  const deny = async (): Promise<void> => {
    setSubmitting(true);
    try {
      await denyDesktopAction(approval.id);
      setApproval(null);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div data-testid="desktop-approval-overlay" className="fixed inset-0 z-[100000] flex items-end justify-center bg-black/45 p-4 sm:items-center" role="presentation">
      <section className="w-full max-w-md border border-amber-500/35 bg-surface-modal p-5 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby="desktop-approval-title">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center bg-amber-500/10 text-amber-700 dark:text-amber-400">
            <ShieldAlert className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 id="desktop-approval-title" className="font-serif text-lg font-normal tracking-tight text-foreground">
              {t('desktopApproval.title')}
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              {t('desktopApproval.description')}
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2 border-y border-border/70 py-3 text-sm text-foreground">
          <MonitorCog className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 break-all">{approval.action.appId}</span>
          <span className="text-muted-foreground">{t(actionKey, { defaultValue: approval.action.kind })}</span>
        </div>
        <p className="mt-3 text-xs leading-5 text-muted-foreground">{t('desktopApproval.privacy')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button data-testid="desktop-approval-deny" variant="outline" onClick={() => void deny()} disabled={submitting}>{t('desktopApproval.deny')}</Button>
          <Button data-testid="desktop-approval-approve" onClick={() => void approve()} disabled={submitting}>{t('desktopApproval.approve')}</Button>
        </div>
      </section>
    </div>
  );
}
