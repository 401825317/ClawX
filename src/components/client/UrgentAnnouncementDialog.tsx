import { useCallback } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { hostApi } from '@/lib/host-api';
import { useAnnouncementsStore } from '@/stores/announcements';

export function UrgentAnnouncementDialog() {
  const { t } = useTranslation('common');
  const announcement = useAnnouncementsStore((state) => state.urgentAnnouncement);
  const dismissUrgent = useAnnouncementsStore((state) => state.dismissUrgent);

  const openLink = useCallback(async () => {
    if (!announcement) return;
    if (announcement.link) await hostApi.shell.openExternal(announcement.link);
    dismissUrgent(announcement);
  }, [announcement, dismissUrgent]);

  if (!announcement) return null;

  return (
    <Dialog open>
      <DialogContent
        data-testid="urgent-announcement-dialog"
        className="max-w-md overflow-hidden rounded-xl border border-red-500/25 bg-surface-modal p-0 shadow-2xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <div className="border-b border-red-500/15 bg-red-500/5 px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10 text-red-700 dark:text-red-400">
              <AlertTriangle className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400">
                {t('announcements.urgent')}
              </p>
              <DialogTitle className="mt-1 break-words text-lg leading-6">{announcement.title}</DialogTitle>
            </div>
          </div>
        </div>
        <div className="px-5 py-4">
          <DialogDescription className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/80">
            {announcement.content}
          </DialogDescription>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-4">
          {announcement.link && (
            <Button type="button" variant="outline" onClick={() => void openLink()}>
              {t('announcements.openLink')}
              <ExternalLink className="ml-1.5 h-4 w-4" />
            </Button>
          )}
          <Button type="button" onClick={() => dismissUrgent(announcement)}>
            {t('actions.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
